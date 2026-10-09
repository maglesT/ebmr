/**
 * Phase 2 exit review F12 (controls vs tests; DI-05, INV-18, PR-18; ADR 0012): a test run records only test
 * identifiers and registered test lots, in the server and in the database.
 *
 * Before tablets 0370 the sandbox recorded a real (non TEST-) batch number typed as the previous batch of a line
 * clearance: the server passed it to the engine unchecked, and no database guard looked inside an entry (the identifier
 * rule was attached only to the batch number of a test batch and the code of a sandbox lot). The lot of a weighing was
 * checked only by the server's lookup. Now the server refuses such an entry before anything is written (EBMR-SBX-022),
 * and the database refuses the row whatever the application sends (EBMR-EXE-078): a batch number or container that is
 * not a test identifier, and a lot that is not a registered test lot or is stated with other facts than the register.
 *
 * Round 2 (recipe-core 0313, tablets 0380): 0370 checked the command's entry only, and the stored state's entry was
 * bound to it only for the weighing facts. A row whose command named a test batch stored the real batch and product in
 * the state. Now every member a block takes over from the command holds the command's value (EBMR-EXE-126), and what a
 * stored entry holds is itself read as an entry of its kind (EBMR-EXE-078).
 *
 * Round 3 (recipe-core 0317, tablets 0390): a container the state registers was read by neither check. A PREVIOUS_BATCH
 * row stored a real-format container L2409-0017 registered beside its entry. Now every container a row registers is the
 * one its entry names, in a block that registers containers (EBMR-EXE-126), and its id is a test lot number or the id
 * the output weighing builds from the test batch's own number (EBMR-EXE-078).
 *
 * Round 4 (recipe-core 0328): what a container holds was copied from its entry (an output's intermediate, a weighing's
 * BOM line) and never compared with the MBR. An output container holding L2409-0017, which the step does not produce,
 * was stored. Now an entry names only what its step's MBR node names: a weighing or a lot charge a BOM line the step
 * dispenses or charges, an output an intermediate the step produces, a container charge a container of the batch the
 * step charges (holding what the container holds, of its sub-lot, scanned with the batch's own label, and the one the
 * row consumes), an equipment status a piece of equipment the step checks (EBMR-EXE-126).
 *
 * Round 5 (recipe-core 0330; the round-4 verification): the members a block builds rather than takes from the command
 * were compared by nothing. The G-03 acknowledgement of p-disp-sop@, its data naming sop B24-0001 and sopVersion
 * L2409-0017 where the MBR pins SOP-DISP-001 version 1, was stored. Now an entry holds exactly what its block builds
 * (the SOP reference, the person, the passed flags, ...), answers exactly its step's checklist, and leaves its step
 * needing the check the block asks for (EBMR-EXE-126).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { engine, execution } from '@ebmr/recipe-core';
import { resolveClientIntent } from '../../src/features/execution/intents.ts';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { actorOf, appendAs, messageOf, unmatched } from './db-guards-support.ts';
import { dcMini, dcMiniVariant, importAndIssue, outcomeOf, personaIn, rowsOf, RunDriver, startExecServer, writePackage, type ExecServer } from './support.ts';

let sbx: ExecServer;
beforeAll(async () => {
  sbx = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
}, 180_000);
afterAll(async () => {
  vi.useRealTimers();
  await sbx?.close();
});

const CLEAR = 'p-disp-clear@';

async function startedRun(): Promise<RunDriver> {
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, dcMini()));
  const d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1') });
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
  return d;
}

async function rowsHolding(runId: string, text: string): Promise<number> {
  const { rows } = await sbx.db.admin.query<{ n: string }>('select count(*)::text as n from recipe.execution_command where batch_id = $1 and command::text like $2', [runId, `%${text}%`]);
  return Number(rows[0]?.n ?? '0');
}

async function stateHolding(runId: string, text: string): Promise<number> {
  const { rows } = await sbx.db.admin.query<{ n: string }>('select count(*)::text as n from recipe.execution_state where batch_id = $1 and state::text like $2', [runId, `%${text}%`]);
  return Number(rows[0]?.n ?? '0');
}

/** The database's objection to entry `entry` (tab.entry_identifier_problem), null when none. */
async function entryProblem(entry: Record<string, unknown>): Promise<string | null> {
  const { rows } = await sbx.db.admin.query<{ p: string | null }>('select tab.entry_identifier_problem($1::jsonb) as p', [JSON.stringify(entry)]);
  return rows[0]?.p ?? null;
}

describe('F12: a test run records only test identifiers and registered test lots (DI-05, PR-18)', () => {
  it('[DI-05][INV-18] a real (non TEST-) previous batch number typed into a sandbox line clearance is refused before anything is written; a TEST- number and NONE are recorded', async () => {
    const d = await startedRun();
    const r = await d.command('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH', product: 'Paracetamol 500 mg tablets', batchNumber: 'B24-0001' } });
    expect(outcomeOf(r)).toMatch(/EBMR-SBX-022/);
    expect(await rowsHolding(d.runId, 'B24-0001')).toBe(0);
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH', product: 'NONE', batchNumber: 'NONE' } });
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH', product: 'TEST-PRODUCT-X', batchNumber: 'TEST-B26-0007' } });
  }, 300_000);

  it('[DI-05][INV-18] the same entry written through the store with the application role is refused by the database (EBMR-EXE-078)', async () => {
    const d = await startedRun();
    const run = await runContext(sbx.db.admin, d.runId);
    const who = personaIn(sbx, 'operator1');
    const outcome = await messageOf(
      withCommand(sbx.db.app, await actorOf(sbx, d.browser('operator1'), 'operator1'), async (c) => {
        const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
        const roles = await engineRoles(c);
        const command = { type: 'RECORD_ENTRY', commandId: randomUUID(), actor: engineActor(who.personId, roles), step: 'p-disp-clear', context: [], entry: { kind: 'PREVIOUS_BATCH', product: 'Paracetamol 500 mg tablets', batchNumber: 'B24-0001' } } as engine.Command;
        const res = engine.step(tx.def, tx.state, command, { nowUs: tx.nowUs });
        if (!res.accepted) throw new Error(`SETUP: the engine refused the entry: ${JSON.stringify(res.refusal)}`);
        return appendAs(tx, command, res, roles);
      }),
    );
    expect(outcome).toMatch(/^The PREVIOUS_BATCH entry of this RECORD_ENTRY row is refused: batchNumber "B24-0001" is not a test batch number: .*\(DI-05, PR-18\)\. \[EBMR-EXE-078\]$/);
    expect(await rowsHolding(d.runId, 'B24-0001')).toBe(0);
  }, 300_000);

  it('[DI-05][PR-18] each identifier an entry carries is a test identifier, and its lot a registered test lot stated as the register holds it', async () => {
    const { rows } = await sbx.db.admin.query<{ l: Record<string, unknown> }>("select tab.resolve_lot('TEST-L26-0101') as l");
    const reg = rows[0]?.l;
    if (!reg) throw new Error('SETUP: the sandbox seed has no lot TEST-L26-0101');
    const lot = {
      id: reg['lotCode'], material: reg['materialCode'], status: reg['status'],
      ...(reg['expiresAtUs'] !== null ? { expiresAtUs: reg['expiresAtUs'] } : {}),
      ...(reg['retestAtUs'] !== null ? { retestAtUs: reg['retestAtUs'] } : {}),
      identityTested: reg['identityTested'],
    };
    const weighing = { kind: 'CONTAINER_WEIGHING', item: 'pcmDispensed', bomLine: 'BOM-PCM', container: 'TEST-B26-0001/C1', lot, gross: '51.250', tare: '1.250', unit: 'kg', balance: 'TEST-BAL-01', source: 'MANUAL' };
    // The server's own entries pass.
    expect(await entryProblem(weighing)).toBeNull();
    expect(await entryProblem({ kind: 'PREVIOUS_BATCH', product: 'NONE', batchNumber: 'NONE' })).toBeNull();
    expect(await entryProblem({ kind: 'CHARGE_CONTAINER', container: 'TEST-B26-0001/C1', scannedBatch: 'TEST-B26-0001' })).toBeNull();
    expect(await entryProblem({ kind: 'OUTPUT_CONTAINER', intermediate: 'I', container: 'TEST-B26-0001/C2', gross: '2', tare: '1', unit: 'kg', balance: 'B', source: 'MANUAL' })).toBeNull();
    expect(await entryProblem({ kind: 'CLEARANCE_CHECK', answers: [] })).toBeNull();
    // Real identifiers, in each place an entry carries one.
    const real = (what: string, value: string, label: string) => `${what} "${value}" is not a test ${label}: in the sandbox every ${label} starts with TEST- (for example TEST-${label === 'batch number' ? 'B' : 'L'}24-0001), so a real GMP identifier is never reused (DI-05).`;
    expect(await entryProblem({ kind: 'PREVIOUS_BATCH', product: 'P', batchNumber: 'B24-0001' })).toBe(real('batchNumber', 'B24-0001', 'batch number'));
    expect(await entryProblem({ kind: 'PREVIOUS_BATCH', product: 'P', batchNumber: 'none' })).toBe(real('batchNumber', 'none', 'batch number'));
    expect(await entryProblem({ kind: 'CHARGE_CONTAINER', container: 'B24-0001/C1', scannedBatch: 'TEST-B26-0001' })).toBe(real('container', 'B24-0001/C1', 'lot number'));
    expect(await entryProblem({ kind: 'CHARGE_CONTAINER', container: 'TEST-B26-0001/C1', scannedBatch: 'B24-0001' })).toBe(real('scannedBatch', 'B24-0001', 'batch number'));
    expect(await entryProblem({ ...weighing, container: 'C-001' })).toBe(real('container', 'C-001', 'lot number'));
    expect(await entryProblem({ kind: 'OUTPUT_CONTAINER', container: 'OUT-7' })).toBe(real('container', 'OUT-7', 'lot number'));
    expect(await entryProblem({ kind: 'SOURCE_ADDITION', sourceBatch: 'B23-0912', productCode: 'P', quantity: { value: '1', unit: 'kg' }, manufacturedAtUs: '1' })).toBe(real('sourceBatch', 'B23-0912', 'batch number'));
    expect(await entryProblem({ kind: 'SAMPLE', point: 'top', purpose: 'assay', units: 1, container: 'DRUM-3' })).toBe(real('container', 'DRUM-3', 'lot number'));
    expect(await entryProblem({ kind: 'DISPOSAL', category: 'WASTE', material: 'M', quantity: { value: '1', unit: 'kg' }, container: 'BIN-1' })).toBe(real('container', 'BIN-1', 'lot number'));
    expect(await entryProblem({ kind: 'CHARGE_LOT', bomLine: 'BOM-PCM', container: 'TEST-B26-0001/C1', lot: { ...lot, id: 'L2409-0017' } })).toBe(real('lot', 'L2409-0017', 'lot number'));
    // A test-format lot that is not registered, and a registered lot stated with other facts.
    expect(await entryProblem({ ...weighing, lot: { ...lot, id: 'TEST-L26-9999' } })).toBe('lot TEST-L26-9999 is not a registered test lot of this installation');
    expect(await entryProblem({ ...weighing, lot: { ...lot, status: lot.status === 'RELEASED' ? 'QUARANTINE' : 'RELEASED' } })).toMatch(/^lot TEST-L26-0101 states other facts than the lot register holds \(/);
    expect(await entryProblem({ ...weighing, lot: { ...lot, material: 'MAT-OTHER' } })).toMatch(/^lot TEST-L26-0101 states other facts than the lot register holds \(/);
    expect(await entryProblem({ ...weighing, lot: { ...lot, identityTested: !lot.identityTested } })).toMatch(/^lot TEST-L26-0101 states other facts than the lot register holds \(/);
    expect(await entryProblem({ ...weighing, lot: { ...lot, expiresAtUs: '1' } })).toMatch(/^lot TEST-L26-0101 states other facts than the lot register holds \(/);
  }, 300_000);

  it('[DI-05][INV-18][DI-30] an entry whose command names a test batch but whose stored state holds the real batch and product is refused (round 2): the record holds what was entered', async () => {
    const d = await startedRun();
    const run = await runContext(sbx.db.admin, d.runId);
    const who = personaIn(sbx, 'operator1');
    // The round-2 verification's row: the command's entry passes 0370, the state's entry holds the real identifier.
    const outcome = await messageOf(
      withCommand(sbx.db.app, await actorOf(sbx, d.browser('operator1'), 'operator1'), async (c) => {
        const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
        const roles = await engineRoles(c);
        const command: engine.Command = {
          type: 'RECORD_ENTRY', commandId: randomUUID(), actor: engineActor(who.personId, roles), step: 'p-disp-clear', context: [],
          entry: { kind: 'PREVIOUS_BATCH', product: 'TEST-PRODUCT-X', batchNumber: 'TEST-B26-0007' },
        };
        const res = engine.step(tx.def, tx.state, command, { nowUs: tx.nowUs });
        if (!res.accepted) throw new Error(`SETUP: the engine refused the entry: ${JSON.stringify(res.refusal)}`);
        const entry = Object.values(res.state.entries).find((e) => !(e.id in tx.state.entries));
        if (!entry) throw new Error('SETUP: no new entry');
        entry.data = { ...entry.data, product: 'Paracetamol 500 mg tablets', batchNumber: 'B24-0001' };
        return appendAs(tx, command, res, roles);
      }),
    );
    expect(outcome).toMatch(/^This accepted RECORD_ENTRY row stores another batchNumber in entry EN-\d+ \(PREVIOUS_BATCH\) than its command sent: an entry records what was entered \(DI-30, DI-05\)\. \[EBMR-EXE-126\]$/);
    expect(await stateHolding(d.runId, 'B24-0001')).toBe(0);
    expect(await rowsHolding(d.runId, 'TEST-B26-0007')).toBe(0);
  }, 300_000);

  it('[DI-05][INV-18][PR-18] an identifier the stored entry holds and its command did not send is checked too (round 2): a sample\'s source container that is no test lot is refused (EBMR-EXE-078)', async () => {
    // dc-mini with a sampling step (G-12, no plan) first in the dispensing preparation.
    const content = dcMiniVariant((prep) => {
      const sop = prep.find((x) => x['id'] === 'p-disp-sop');
      if (!sop) throw new Error('SETUP: no SOP step');
      return [{ ...sop, id: 'p-early-sample', name: 'Take an early sample', block: { type: 'G-12', version: '1' }, config: {} }, ...prep];
    });
    const issuer = await sbx.asPersona('issuer');
    const runId = await importAndIssue(sbx, issuer, writePackage(sbx, content));
    const d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1') });
    d.beforeTap = () => vi.advanceTimersByTime(7_000);
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-early-sample@' });
    const run = await runContext(sbx.db.admin, runId);
    const who = personaIn(sbx, 'operator1');
    const sample = async (container: string | undefined) =>
      messageOf(
        withCommand(sbx.db.app, await actorOf(sbx, d.browser('operator1'), 'operator1'), async (c) => {
          const tx = await execution.ExecutionTx.open(c, run.def, runId);
          const roles = await engineRoles(c);
          const command: engine.Command = {
            type: 'RECORD_ENTRY', commandId: randomUUID(), actor: engineActor(who.personId, roles), step: 'p-early-sample', context: [],
            entry: { kind: 'SAMPLE', point: 'TOP', purpose: 'ASSAY', units: 1 },
          };
          const res = engine.step(tx.def, tx.state, command, { nowUs: tx.nowUs });
          if (!res.accepted) throw new Error(`SETUP: the engine refused the sample: ${JSON.stringify(res.refusal)}`);
          const entry = Object.values(res.state.entries).find((e) => !(e.id in tx.state.entries));
          if (!entry) throw new Error('SETUP: no new entry');
          if (container !== undefined) entry.data = { ...entry.data, container };
          return appendAs(tx, command, res, roles);
        }),
      );
    expect(await sample('DRUM-3')).toMatch(/^Entry EN-\d+ \(SAMPLE\) that this RECORD_ENTRY row stores is refused: container "DRUM-3" is not a test lot number: .*\(DI-05, PR-18\)\. \[EBMR-EXE-078\]$/);
    expect(await stateHolding(runId, 'DRUM-3')).toBe(0);
    // The honest sample is recorded.
    expect(await sample(undefined)).toBe('ok');
  }, 300_000);

  it('[DI-05][PR-18] what a stored entry holds is read as an entry of its kind: an output container the system names after the test batch passes, any other container it did not get from its command does not', async () => {
    const problem = async (entry: unknown, command: unknown, batch: string | null): Promise<string | null> => {
      const { rows } = await sbx.db.admin.query<{ p: string | null }>('select tab.state_entry_identifier_problem($1::jsonb, $2::jsonb, $3) as p', [JSON.stringify(entry), JSON.stringify(command), batch]);
      return rows[0]?.p ?? null;
    };
    const out = (container: string) => ({ id: 'EN-1', kind: 'OUTPUT_CONTAINER', data: { intermediate: 'INT-BLEND', container, gross: '2', tare: '1', unit: 'kg' } });
    const unnamed = { type: 'RECORD_ENTRY', entry: { kind: 'OUTPUT_CONTAINER', intermediate: 'INT-BLEND', gross: '2', tare: '1', unit: 'kg' } };
    // The id the block builds from the batch number (with a sub-lot context it is not a lot-number pattern, and passes).
    expect(await problem(out('TEST-B26-0001/INT-BLEND/R-SUBLOT=1/1'), unnamed, 'TEST-B26-0001')).toBeNull();
    expect(await problem(out('OUT-7'), unnamed, 'TEST-B26-0001')).toBe('container OUT-7 is neither one the command named nor the id the system builds from the batch number TEST-B26-0001');
    expect(await problem(out('TEST-B26-0002/INT-BLEND/0/1'), unnamed, 'TEST-B26-0001')).toMatch(/^container TEST-B26-0002\/INT-BLEND\/0\/1 is neither one/);
    expect(await problem(out('TEST-B26-0001/INT-BLEND/0/1'), unnamed, null)).toMatch(/is neither one the command named nor the id the system builds from the batch number \(none\)$/);
    // A container the command named is the command's (0370 checked it), read as an entry.
    const named = { type: 'RECORD_ENTRY', entry: { ...unnamed.entry, container: 'OUT-7' } };
    expect(await problem(out('OUT-7'), named, 'TEST-B26-0001')).toMatch(/^container "OUT-7" is not a test lot number/);
    expect(await problem(out('TEST-B26-0001/C2'), named, 'TEST-B26-0001')).toBeNull();
    // Other kinds: every identifier read from the data.
    expect(await problem({ id: 'EN-2', kind: 'PREVIOUS_BATCH', data: { product: 'P', batchNumber: 'B24-0001' } }, { type: 'RECORD_ENTRY', entry: { kind: 'PREVIOUS_BATCH' } }, 'TEST-B26-0001')).toMatch(/^batchNumber "B24-0001" is not a test batch number/);
    expect(await problem({ id: 'EN-3', kind: 'START_DATA', data: { investigationRef: 'INV-7' } }, { type: 'START_STEP' }, 'TEST-B26-0001')).toBeNull();
  }, 300_000);
  /**
   * operator1's PREVIOUS_BATCH entry on the started clearance (a test batch number), recorded through the application role
   * with the engine's real result plus container `id` registered beside it, holding the API, with its CONTAINER_REGISTERED
   * event (the round-3 verification's row).
   */
  async function containerBesidePreviousBatch(d: RunDriver, id: string): Promise<string> {
    const run = await runContext(sbx.db.admin, d.runId);
    const who = personaIn(sbx, 'operator1');
    return messageOf(
      withCommand(sbx.db.app, await actorOf(sbx, d.browser('operator1'), 'operator1'), async (c) => {
        const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
        const roles = await engineRoles(c);
        const command: engine.Command = {
          type: 'RECORD_ENTRY', commandId: randomUUID(), actor: engineActor(who.personId, roles), step: 'p-disp-clear', context: [],
          entry: { kind: 'PREVIOUS_BATCH', product: 'TEST-PRODUCT-X', batchNumber: 'TEST-B26-0003' },
        };
        const res = engine.step(tx.def, tx.state, command, { nowUs: tx.nowUs });
        if (!res.accepted) throw new Error(`SETUP: the engine refused the entry: ${JSON.stringify(res.refusal)}`);
        const state = structuredClone(res.state);
        state.containers[id] = { id, holds: 'BOM-PCM', holdsKind: 'BOM_LINE', producedBy: CLEAR, producedIn: [], status: 'QUARANTINE' };
        const last = res.events[res.events.length - 1];
        if (!last) throw new Error('SETUP: no events');
        state.seq += 1;
        const events = [...res.events, { type: 'CONTAINER_REGISTERED', container: id, holds: 'BOM-PCM', stepKey: CLEAR, seq: last.seq + 1, at: last.at } as engine.EngineEvent];
        return appendAs(tx, command, { state, events }, roles);
      }),
    );
  }

  it('[DI-05][INV-18][PR-18] round 3: a real-format container registered beside a previous batch entry is refused (EBMR-EXE-078), and nothing holds it', async () => {
    const d = await startedRun();
    expect(await containerBesidePreviousBatch(d, 'L2409-0017')).toMatch(/^Container L2409-0017 that this RECORD_ENTRY row registers is refused: container "L2409-0017" is not a test lot number: .*\(DI-05, PR-18\)\. \[EBMR-EXE-078\]$/);
    expect(await stateHolding(d.runId, 'L2409-0017')).toBe(0);
    expect(await rowsHolding(d.runId, 'TEST-B26-0003')).toBe(0);
  }, 300_000);

  it('[DI-30][DI-05][PR-18] round 3: a container registered beside an entry that registers none is refused even under a test identifier (EBMR-EXE-126): a container is the one its entry names', async () => {
    const d = await startedRun();
    expect(await containerBesidePreviousBatch(d, 'TEST-L26-0101/C9')).toMatch(/^This accepted RECORD_ENTRY row adds container TEST-L26-0101\/C9 beside entry EN-\d+ \(PREVIOUS_BATCH\) of step p-disp-clear@, whose block \(G-10\) registers no container with such an entry: .*\[EBMR-EXE-126\]$/);
    expect(await stateHolding(d.runId, 'TEST-L26-0101/C9')).toBe(0);
    // The honest entry is recorded, with no container.
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH', product: 'TEST-PRODUCT-X', batchNumber: 'TEST-B26-0003' } });
    expect(Object.keys((await execution.loadState(sbx.db.admin, d.runId))?.state.containers ?? {})).toEqual([]);
  }, 300_000);

  it('[DI-05][PR-18] round 3: a container a row registers is read as a test lot number, apart from the id the output weighing builds from the test batch\'s own number', async () => {
    const problem = async (key: string, container: unknown, command: unknown, batch: string | null): Promise<string | null> => {
      const { rows } = await sbx.db.admin.query<{ p: string | null }>('select tab.state_container_identifier_problem($1, $2::jsonb, $3::jsonb, $4) as p', [key, JSON.stringify(container), JSON.stringify(command), batch]);
      return rows[0]?.p ?? null;
    };
    const record = (id: string) => ({ id, holds: 'INT-BLEND', holdsKind: 'INTERMEDIATE', producedBy: 'p-blend-out@', producedIn: [], status: 'QUARANTINE' });
    const unnamed = { type: 'RECORD_ENTRY', entry: { kind: 'OUTPUT_CONTAINER', intermediate: 'INT-BLEND', gross: '2', tare: '1', unit: 'kg' } };
    const named = { type: 'RECORD_ENTRY', entry: { ...unnamed.entry, container: 'TEST-B26-0001/C2' } };
    const weighing = { type: 'RECORD_ENTRY', entry: { kind: 'CONTAINER_WEIGHING', container: 'TEST-B26-0001/C1' } };
    const real = (value: string) => `container "${value}" is not a test lot number: in the sandbox every lot number starts with TEST- (for example TEST-L24-0001), so a real GMP identifier is never reused (DI-05).`;
    // Test identifiers pass, and the id the block builds from the batch's own number when the command names none.
    expect(await problem('TEST-B26-0001/C1', record('TEST-B26-0001/C1'), weighing, 'TEST-B26-0001')).toBeNull();
    expect(await problem('TEST-B26-0001/C2', record('TEST-B26-0001/C2'), named, 'TEST-B26-0001')).toBeNull();
    expect(await problem('TEST-B26-0001/INT-BLEND/0/1', record('TEST-B26-0001/INT-BLEND/0/1'), unnamed, 'TEST-B26-0001')).toBeNull();
    // Real identifiers are refused, under the key or the id.
    expect(await problem('L2409-0017', record('L2409-0017'), { type: 'RECORD_ENTRY', entry: { kind: 'PREVIOUS_BATCH' } }, 'TEST-B26-0001')).toBe(real('L2409-0017'));
    expect(await problem('TEST-B26-0001/C1', record('L2409-0017'), weighing, 'TEST-B26-0001')).toBe(real('L2409-0017'));
    // The built id counts only for an output weighing whose command names no container, built from this batch's number.
    expect(await problem('B24-0001/INT-BLEND/0/1', record('B24-0001/INT-BLEND/0/1'), unnamed, 'TEST-B26-0001')).toBe(real('B24-0001/INT-BLEND/0/1'));
    expect(await problem('B24-0001/INT-BLEND/0/1', record('B24-0001/INT-BLEND/0/1'), unnamed, null)).toBe(real('B24-0001/INT-BLEND/0/1'));
    expect(await problem('B24-0001/X', record('B24-0001/X'), { type: 'RECORD_ENTRY', entry: { ...unnamed.entry, container: 'B24-0001/X' } }, 'B24-0001')).toBe(real('B24-0001/X'));
    expect(await problem('B24-0001/X', record('B24-0001/X'), weighing, 'B24-0001')).toBe(real('B24-0001/X'));
  }, 300_000);

  type Json = Record<string, unknown>;

  /**
   * operator1's entry `entry` at step `stepKey`, resolved and run through the engine as the server does, then stored
   * through the application role after every occurrence of `from` in the new entry's data, the containers the row
   * registers, the events and the recorded command was replaced by `to` (and `forge` made any other change): what a
   * writer that relabels a container's contents stores. 'ok' or the refusal.
   */
  async function relabelledEntry(d: RunDriver, stepKey: string, entry: Json, from: string, to: string, forge: (data: Json) => void = () => undefined): Promise<string> {
    const run = await runContext(sbx.db.admin, d.runId);
    const who = personaIn(sbx, 'operator1');
    // Every string equal to `from` (and the built container id that contains it), at any depth; numbers and bigints kept.
    const swap = <T,>(v: T): T => {
      if (typeof v === 'string') return (v === from ? to : v.split(`/${from}/`).join(`/${to}/`)) as T;
      if (Array.isArray(v)) return v.map((x: unknown) => swap(x)) as T;
      if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [swap(k), swap(x)])) as T;
      return v;
    };
    return messageOf(
      withCommand(sbx.db.app, await actorOf(sbx, d.browser('operator1'), 'operator1'), async (c) => {
        const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
        const roles = await engineRoles(c);
        const resolved = await resolveClientIntent(
          { client: c, app: sbx.built.ctx, def: run.def, state: tx.state, room: 'DISP-1', actor: engineActor(who.personId, roles), commandId: randomUUID(), expectedVersion: tx.state.version, useReadings: true },
          { type: 'RECORD_ENTRY', stepKey, entry } as Parameters<typeof resolveClientIntent>[1],
        );
        const r = engine.step(tx.def, tx.state, resolved.command, { nowUs: tx.nowUs });
        if (!r.accepted) throw new Error(`SETUP: the engine refused the entry: ${JSON.stringify(r.refusal)}`);
        const state = structuredClone(r.state);
        const added = Object.values(state.entries).find((e) => !(e.id in tx.state.entries));
        if (!added) throw new Error('SETUP: no new entry');
        added.data = swap(added.data);
        forge(added.data);
        for (const k of Object.keys(state.containers)) if (!(k in tx.state.containers)) state.containers[k] = swap(state.containers[k] as engine.ContainerRecord);
        const recorded = swap(engine.encodeCommand(resolved.command));
        return appendAs(tx, resolved.command, { state, events: swap(r.events) }, roles, recorded, engine.changedContents(tx.def, tx.state, state), resolved.evidence as engine.JsonValue);
      }),
    );
  }

  /** dc-mini with an output step first in the dispensing booth (records earlyNet in kg, produces I-EARLY), started. */
  async function earlyOutputRun(): Promise<RunDriver> {
    const content = dcMiniVariant((prep, c) => {
      (c['intermediates'] as Json[]).push({ id: 'I-EARLY', name: 'Early output', holdTime: { max: { value: '30', unit: 'd' }, source: { kind: 'HOLD_STUDY', ref: 'HS-PCM-01' }, storage: 'Closed, labelled containers' } });
      (c['parameters'] as Json[]).push({ id: 'earlyNet', name: 'Early output (net)', valueType: 'DECIMAL', unit: 'kg', precision: { kind: 'DECIMALS', digits: 3 }, role: 'QUANTITY', criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'DEVICE' });
      const out = { kind: 'phase', id: 'p-early-out', name: 'Discharge the early output', block: { type: 'G-22', version: '1' }, config: {}, records: ['earlyNet'], computes: [], reads: [], consumes: [], produces: ['I-EARLY'], uses: [], equipment: [], signatures: { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } }, significant: true, riskClass: 'HIGH' };
      return [out, ...prep];
    });
    const issuer = await sbx.asPersona('issuer');
    const runId = await importAndIssue(sbx, issuer, writePackage(sbx, content));
    const d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1') });
    d.beforeTap = () => vi.advanceTimersByTime(7_000);
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-early-out@' });
    return d;
  }

  /** dc-mini run to the start of the paracetamol dispensing. */
  async function atDispensing(): Promise<RunDriver> {
    const issuer = await sbx.asPersona('issuer');
    const runId = await importAndIssue(sbx, issuer, writePackage(sbx, dcMini()));
    const d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1'), verifier1: await sbx.asPersona('verifier1') });
    d.beforeTap = () => vi.advanceTimersByTime(7_000);
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'CLEARANCE_CHECK', answers: ['NO_PREVIOUS_MATERIAL', 'NO_PREVIOUS_DOCUMENTS', 'EQUIPMENT_CLEAN_LABEL'].map((id) => ({ id, answer: 'CONFIRMED' as const })) } });
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH', product: 'TEST-PRODUCT-X', batchNumber: 'TEST-B26-9999' } });
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: CLEAR });
    await d.signed('verifier1', { type: 'VERIFY', stepKey: CLEAR, meaning: 'VERIFIED' });
    for (const [key, entries] of [
      ['p-disp-bal@', [{ kind: 'EQUIPMENT_STATUS', equipmentRef: 'BAL', labelId: 'LBL-BAL', answers: ['CALIBRATED', 'DAILY_CHECK', 'CLEAN'].map((id) => ({ id, answer: 'YES' as const })) }]],
      ['p-disp-sop@', [{ kind: 'ACKNOWLEDGE', mode: 'READ' }]],
      ['p-disp-calc@', []],
    ] as const) {
      await d.ok('operator1', { type: 'START_STEP', stepKey: key });
      for (const entry of entries) await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: key, entry });
      await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: key });
    }
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-disp-pcm@' });
    return d;
  }

  it('[DI-05][DI-30][PR-18] round 4: an output container holding L2409-0017, an intermediate its step does not produce, and a weighing of a BOM line L2409-0017 the step does not dispense are refused (EBMR-EXE-126), and nothing holds them', async () => {
    const output = { kind: 'OUTPUT_CONTAINER', intermediate: 'I-EARLY', manual: { gross: '26.100', tare: '1.050', unit: 'kg' } };
    const weighing = { kind: 'CONTAINER_WEIGHING', item: 'pcmDispensed', bomLine: 'BOM-PCM', lotCode: 'TEST-L26-0101', manual: { gross: '51.250', tare: '1.250', unit: 'kg' } };
    // The verifier's probe: the output's intermediate, the container it registers (and the id built from it) relabelled.
    const out = await earlyOutputRun();
    const outputIntermediate = await relabelledEntry(out, 'p-early-out@', output, 'I-EARLY', 'L2409-0017');
    const outputHeld = await stateHolding(out.runId, 'L2409-0017');
    // The honest entry is recorded; its container holds the intermediate the step produces.
    const outputHonest = await relabelledEntry(out, 'p-early-out@', output, 'I-EARLY', 'I-EARLY');
    const outputHolds = Object.values((await execution.loadState(sbx.db.admin, out.runId))?.state.containers ?? {}).map((c) => c.holds);
    const disp = await atDispensing();
    const outcomes = {
      outputIntermediate,
      // The weighed line, the container it registers and the label's component (the line itself, for a line the BOM does not hold).
      weighingUnknownLine: await relabelledEntry(disp, 'p-disp-pcm@', weighing, 'BOM-PCM', 'L2409-0017', (data) => void ((data['label'] as Json)['component'] = 'L2409-0017')),
      // A line of the BOM that another step dispenses.
      weighingOtherLine: await relabelledEntry(disp, 'p-disp-pcm@', weighing, 'BOM-PCM', 'BOM-MCC', (data) => void ((data['label'] as Json)['component'] = 'MAT-MCC')),
    };
    expect(unmatched(outcomes, {
      outputIntermediate: /^This accepted RECORD_ENTRY row stores entry EN-\d+ \(OUTPUT_CONTAINER\) of step p-early-out@ holding intermediate L2409-0017, which step p-early-out does not produce: .*\(DI-05, DI-30, PR-18, PR-21, PR-23\)\. \[EBMR-EXE-126\]$/,
      weighingUnknownLine: /^This accepted RECORD_ENTRY row stores entry EN-\d+ \(CONTAINER_WEIGHING\) of step p-disp-pcm@ with BOM line L2409-0017, which is not a line of the MBR's bill of materials that step p-disp-pcm dispenses: .*\[EBMR-EXE-126\]$/,
      weighingOtherLine: /stores entry EN-\d+ \(CONTAINER_WEIGHING\) of step p-disp-pcm@ with BOM line BOM-MCC, which is not a line of the MBR's bill of materials that step p-disp-pcm dispenses: .*\[EBMR-EXE-126\]$/,
    })).toEqual({});
    expect(outputHeld).toBe(0);
    expect(await stateHolding(disp.runId, 'L2409-0017')).toBe(0);
    expect(Object.keys((await execution.loadState(sbx.db.admin, disp.runId))?.state.containers ?? {})).toEqual([]);
    expect({ outputHonest, outputHolds }).toEqual({ outputHonest: 'ok', outputHolds: ['I-EARLY'] });
    expect(await relabelledEntry(disp, 'p-disp-pcm@', weighing, 'BOM-PCM', 'BOM-PCM')).toBe('ok');
    expect(Object.values((await execution.loadState(sbx.db.admin, disp.runId))?.state.containers ?? {}).map((c) => c.holds)).toEqual(['BOM-PCM']);
  }, 300_000);

  /**
   * operator1's entry `entry` at step `stepKey`, resolved and run through the engine as the server does, then stored
   * through the application role after `forge` changed the new entry's data, the state, the recorded command or the events: what a
   * writer that stores another entry than the block builds stores. 'ok' or the refusal.
   */
  async function forgedEntry(d: RunDriver, stepKey: string, entry: Json, forge: (x: { data: Json; state: engine.BatchState; command: Json; events: engine.EngineEvent[] }) => void = () => undefined): Promise<string> {
    const run = await runContext(sbx.db.admin, d.runId);
    const who = personaIn(sbx, 'operator1');
    return messageOf(
      withCommand(sbx.db.app, await actorOf(sbx, d.browser('operator1'), 'operator1'), async (c) => {
        const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
        const roles = await engineRoles(c);
        const resolved = await resolveClientIntent(
          { client: c, app: sbx.built.ctx, def: run.def, state: tx.state, room: 'DISP-1', actor: engineActor(who.personId, roles), commandId: randomUUID(), expectedVersion: tx.state.version, useReadings: true },
          { type: 'RECORD_ENTRY', stepKey, entry } as Parameters<typeof resolveClientIntent>[1],
        );
        const r = engine.step(tx.def, tx.state, resolved.command, { nowUs: tx.nowUs });
        if (!r.accepted) throw new Error(`SETUP: the engine refused the entry: ${JSON.stringify(r.refusal)}`);
        const state = structuredClone(r.state);
        const added = Object.values(state.entries).find((e) => !(e.id in tx.state.entries));
        if (!added) throw new Error('SETUP: no new entry');
        const recorded = engine.encodeCommand(resolved.command) as Json;
        const events = structuredClone(r.events);
        forge({ data: added.data, state, command: recorded, events });
        return appendAs(tx, resolved.command, { state, events }, roles, recorded as engine.JsonValue, engine.changedContents(tx.def, tx.state, state), resolved.evidence as engine.JsonValue);
      }),
    );
  }

  /** dc-mini run to the start of `until` (p-disp-bal@ or p-disp-sop@), the booth cleared and verified before it. */
  async function atPreparation(until: 'p-disp-bal@' | 'p-disp-sop@'): Promise<RunDriver> {
    const issuer = await sbx.asPersona('issuer');
    const runId = await importAndIssue(sbx, issuer, writePackage(sbx, dcMini()));
    const d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1'), verifier1: await sbx.asPersona('verifier1') });
    d.beforeTap = () => vi.advanceTimersByTime(7_000);
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'CLEARANCE_CHECK', answers: ['NO_PREVIOUS_MATERIAL', 'NO_PREVIOUS_DOCUMENTS', 'EQUIPMENT_CLEAN_LABEL'].map((id) => ({ id, answer: 'CONFIRMED' as const })) } });
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH', product: 'TEST-PRODUCT-X', batchNumber: 'TEST-B26-9999' } });
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: CLEAR });
    await d.signed('verifier1', { type: 'VERIFY', stepKey: CLEAR, meaning: 'VERIFIED' });
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-disp-bal@' });
    if (until === 'p-disp-sop@') {
      await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: 'p-disp-bal@', entry: { kind: 'EQUIPMENT_STATUS', equipmentRef: 'BAL', labelId: 'LBL-BAL', answers: ['CALIBRATED', 'DAILY_CHECK', 'CLEAN'].map((id) => ({ id, answer: 'YES' as const })) } });
      await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-disp-bal@' });
      await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-disp-sop@' });
    }
    return d;
  }

  async function entriesOf(runId: string, kind: string): Promise<Json[]> {
    return Object.values((await execution.loadState(sbx.db.admin, runId))?.state.entries ?? {}).filter((e) => e.kind === kind).map((e) => e.data);
  }

  it('[DI-05][DI-30][DI-10] round 5: the round-4 verification\'s acknowledgement naming sop B24-0001 and sopVersion L2409-0017, and one naming another SOP of the MBR, are refused (EBMR-EXE-126) and nothing holds them; the acknowledgement of the SOP the MBR pins is recorded', async () => {
    const d = await atPreparation('p-disp-sop@');
    const ack = { kind: 'ACKNOWLEDGE', mode: 'READ' };
    const outcomes = {
      // The round-4 verification's probe: the engine's own result, its data naming the real-format batch and lot numbers.
      verifierProbe: await forgedEntry(d, 'p-disp-sop@', ack, ({ data }) => Object.assign(data, { sop: 'B24-0001', sopVersion: 'L2409-0017' })),
      // Another SOP of the same MBR, in a version the MBR does not pin.
      otherSop: await forgedEntry(d, 'p-disp-sop@', ack, ({ data }) => Object.assign(data, { sop: 'SOP-CLEAN-003', sopVersion: '7' })),
    };
    expect(unmatched(outcomes, {
      verifierProbe: /^This accepted RECORD_ENTRY row stores entry EN-\d+ \(ACKNOWLEDGE\) of step p-disp-sop@ with sop "B24-0001", where its block writes "SOP-DISP-001": an entry holds exactly what its block builds .*\(DI-05, DI-10, DI-30, PR-14, PR-18, PR-23, PR-29, PR-34, PR-40, PR-47\)\. \[EBMR-EXE-126\]$/,
      otherSop: /^This accepted RECORD_ENTRY row stores entry EN-\d+ \(ACKNOWLEDGE\) of step p-disp-sop@ with sop "SOP-CLEAN-003", where its block writes "SOP-DISP-001": .*\[EBMR-EXE-126\]$/,
    })).toEqual({});
    expect(await stateHolding(d.runId, 'B24-0001')).toBe(0);
    expect(await stateHolding(d.runId, 'L2409-0017')).toBe(0);
    expect(await rowsHolding(d.runId, 'B24-0001')).toBe(0);
    expect(await entriesOf(d.runId, 'ACKNOWLEDGE')).toEqual([]);
    // The honest acknowledgement is recorded, with the SOP the MBR pins.
    expect(await forgedEntry(d, 'p-disp-sop@', ack)).toBe('ok');
    expect(await entriesOf(d.runId, 'ACKNOWLEDGE')).toEqual([
      { mode: 'READ', acknowledgedBy: personaIn(sbx, 'operator1').personId, sop: 'SOP-DISP-001', sopVersion: '1', sopHash: 'a10392006925d1f24c34701fcb7c0b1c5ce2793bd979c2fcececb826d4b41f8a' },
    ]);
  }, 300_000);

  it('[DI-30][PR-23][PR-14] round 5: an equipment status attested in another person\'s name or leaving out a check, and a weighing keyed by hand whose step is not left needing its second person, are refused (EBMR-EXE-126); the honest entries are recorded', async () => {
    const bal = await atPreparation('p-disp-bal@');
    const status = { kind: 'EQUIPMENT_STATUS', equipmentRef: 'BAL', labelId: 'LBL-BAL', answers: ['CALIBRATED', 'DAILY_CHECK', 'CLEAN'].map((id) => ({ id, answer: 'YES' })) };
    const withoutClean = (answers: unknown): unknown => (answers as Json[]).filter((a) => a['id'] !== 'CLEAN');
    const weighing = { kind: 'CONTAINER_WEIGHING', item: 'pcmDispensed', bomLine: 'BOM-PCM', lotCode: 'TEST-L26-0101', manual: { gross: '51.250', tare: '1.250', unit: 'kg' } };
    const outcomes: Record<string, string> = {
      otherPerson: await forgedEntry(bal, 'p-disp-bal@', status, ({ data }) => void (data['attestedBy'] = personaIn(sbx, 'operator2').personId)),
      checkLeftOut: await forgedEntry(bal, 'p-disp-bal@', status, ({ data, command }) => {
        data['answers'] = withoutClean(data['answers']);
        (command['entry'] as Json)['answers'] = withoutClean((command['entry'] as Json)['answers']);
      }),
    };
    expect(await entriesOf(bal.runId, 'EQUIPMENT_STATUS')).toEqual([]);
    expect(await forgedEntry(bal, 'p-disp-bal@', status)).toBe('ok');
    // operator1's next run (a new session of theirs ends the one above).
    const disp = await atDispensing();
    outcomes['manualUnchecked'] = await forgedEntry(disp, 'p-disp-pcm@', weighing, ({ state }) => {
      const inst = state.steps['p-disp-pcm@'];
      if (inst) inst.verificationRequired = false;
    });
    expect(unmatched(outcomes, {
      otherPerson: /^This accepted RECORD_ENTRY row stores entry EN-\d+ \(EQUIPMENT_STATUS\) of step p-disp-bal@ with attestedBy "[0-9a-f-]{36}", where its block writes "[0-9a-f-]{36}": .*\[EBMR-EXE-126\]$/,
      checkLeftOut: /^This accepted RECORD_ENTRY row stores entry EN-\d+ \(EQUIPMENT_STATUS\) of step p-disp-bal@ that does not answer CLEAN; every item of its step's list is answered \(G09-ANSWERS\): .*\[EBMR-EXE-126\]$/,
      manualUnchecked: /^This accepted RECORD_ENTRY row stores entry EN-\d+ \(CONTAINER_WEIGHING\) of step p-disp-pcm@, which needs a second person's check of its step, and the step does not require it \(PR-14\): .*\[EBMR-EXE-126\]$/,
    })).toEqual({});
    expect(await entriesOf(disp.runId, 'CONTAINER_WEIGHING')).toEqual([]);
    expect(await forgedEntry(disp, 'p-disp-pcm@', weighing)).toBe('ok');
    expect((await execution.loadState(sbx.db.admin, disp.runId))?.state.steps['p-disp-pcm@']?.verificationRequired).toBe(true);
  }, 300_000);
  const SCHEMA_REFUSAL = String.raw`: an entry and a step's start data meet the data schema of the step's block version and are of a kind it records, as the engine checks them before the block accepts them \(DI-05, DI-30, PR-18, PR-23, PR-29, PR-34, PR-40, PR-47\)\. \[EBMR-EXE-126\]$`;

  it('[DI-05][DI-30][PR-19] round 6: the round-5 verification\'s weighing whose command and data both carry lotNumber L2409-0017, and a dispensed container stored under a kind its block does not record (CONTAINER_WEIGHING_2, its container and event left out), are refused (EBMR-EXE-126) and nothing holds them; the honest weighing is recorded', async () => {
    const disp = await atDispensing();
    const weighing = { kind: 'CONTAINER_WEIGHING', item: 'pcmDispensed', bomLine: 'BOM-PCM', lotCode: 'TEST-L26-0101', manual: { gross: '51.250', tare: '1.250', unit: 'kg' } };
    const outcomes = {
      // The round-5 verification's probe: the member in the command and in the data alike.
      lotNumber: await forgedEntry(disp, 'p-disp-pcm@', weighing, ({ data, command }) => {
        data['lotNumber'] = 'L2409-0017';
        (command['entry'] as Json)['lotNumber'] = 'L2409-0017';
      }),
      // The T2 verification's probe: the same weighing under another kind, which the net, label and total checks do not read.
      renamed: await forgedEntry(disp, 'p-disp-pcm@', weighing, ({ data, state, command, events }) => {
        const e = Object.values(state.entries).find((x) => x.data === data);
        if (!e) throw new Error('SETUP: no entry');
        e.kind = 'CONTAINER_WEIGHING_2';
        (command['entry'] as Json)['kind'] = 'CONTAINER_WEIGHING_2';
        delete state.containers[String(data['container'])];
        for (let i = events.length - 1; i >= 0; i -= 1) {
          const ev = events[i] as unknown as Json;
          if (ev['type'] === 'CONTAINER_REGISTERED') events.splice(i, 1);
          else if (ev['type'] === 'ENTRY_RECORDED') ev['kind'] = 'CONTAINER_WEIGHING_2';
        }
      }),
    };
    expect(unmatched(outcomes, {
      lotNumber: new RegExp(String.raw`^This accepted RECORD_ENTRY row records at step p-disp-pcm an entry that does not meet the data schema of block G-07@1: CONTAINER_WEIGHING\.lotNumber is not a field of this block \(unknown fields are refused\) \(ENG-ENTRY-SCHEMA\)` + SCHEMA_REFUSAL),
      renamed: new RegExp(String.raw`^This accepted RECORD_ENTRY row records an entry of kind CONTAINER_WEIGHING_2 at step p-disp-pcm, whose block G-07@1 does not record that kind \(ENG-ENTRY-KIND\)` + SCHEMA_REFUSAL),
    })).toEqual({});
    expect(await stateHolding(disp.runId, 'L2409-0017')).toBe(0);
    expect(await rowsHolding(disp.runId, 'L2409-0017')).toBe(0);
    expect(await rowsHolding(disp.runId, 'CONTAINER_WEIGHING_2')).toBe(0);
    expect(await entriesOf(disp.runId, 'CONTAINER_WEIGHING')).toEqual([]);
    expect(await forgedEntry(disp, 'p-disp-pcm@', weighing)).toBe('ok');
    expect((await entriesOf(disp.runId, 'CONTAINER_WEIGHING')).map((e) => e['lot'] && (e['lot'] as Json)['id'])).toEqual(['TEST-L26-0101']);
  }, 300_000);

  it('[PR-34][PR-23][DI-30] round 6: a line clearance answered NO and an equipment status answered no, which the earlier checks stored as passed, are refused (EBMR-EXE-126) and nothing records them; the honest checks are recorded', async () => {
    const answered = (i: number, v: string) => ({ data, command }: { data: Json; command: Json }): void => {
      for (const list of [data['answers'], (command['entry'] as Json)['answers']] as Json[][]) (list[i] as Json)['answer'] = v;
    };
    const d = await startedRun();
    const clearance = { kind: 'CLEARANCE_CHECK', answers: ['NO_PREVIOUS_MATERIAL', 'NO_PREVIOUS_DOCUMENTS', 'EQUIPMENT_CLEAN_LABEL'].map((id) => ({ id, answer: 'CONFIRMED' })) };
    const outcomes: Record<string, string> = { clearanceNo: await forgedEntry(d, CLEAR, clearance, answered(0, 'NO')) };
    expect(await entriesOf(d.runId, 'CLEARANCE_CHECK')).toEqual([]);
    // Sent over the API, the answer NO never reaches the engine: the contract refuses it and nothing is written.
    const before = (await rowsOf(sbx, d.runId)).length;
    const sent = await d.command('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'CLEARANCE_CHECK', answers: clearance.answers.map((a, i) => (i === 0 ? { ...a, answer: 'NO' } : a)) } } as Parameters<RunDriver['command']>[1]);
    expect({ outcome: outcomeOf(sent), rows: (await rowsOf(sbx, d.runId)).length - before }).toEqual({ outcome: '400:SCHEMA', rows: 0 });
    expect(await forgedEntry(d, CLEAR, clearance)).toBe('ok');
    expect((await entriesOf(d.runId, 'CLEARANCE_CHECK')).map((e) => e['passed'])).toEqual([true]);
    // operator1's next run (a new session of theirs ends the one above).
    const bal = await atPreparation('p-disp-bal@');
    const status = { kind: 'EQUIPMENT_STATUS', equipmentRef: 'BAL', labelId: 'LBL-BAL', answers: ['CALIBRATED', 'DAILY_CHECK', 'CLEAN'].map((id) => ({ id, answer: 'YES' })) };
    outcomes['statusNo'] = await forgedEntry(bal, 'p-disp-bal@', status, answered(1, 'no'));
    expect(await entriesOf(bal.runId, 'EQUIPMENT_STATUS')).toEqual([]);
    expect(unmatched(outcomes, {
      clearanceNo: new RegExp(String.raw`^This accepted RECORD_ENTRY row records at step p-disp-clear an entry that does not meet the data schema of block G-10@1: CLEARANCE_CHECK\.answers\[0\]\.answer must be one of CONFIRMED, NOT_CONFIRMED, NOT_APPLICABLE \(ENG-ENTRY-SCHEMA\)` + SCHEMA_REFUSAL),
      statusNo: new RegExp(String.raw`^This accepted RECORD_ENTRY row records at step p-disp-bal an entry that does not meet the data schema of block G-09@1: EQUIPMENT_STATUS\.answers\[1\]\.answer must be one of YES, NO \(ENG-ENTRY-SCHEMA\)` + SCHEMA_REFUSAL),
    })).toEqual({});
    expect(await forgedEntry(bal, 'p-disp-bal@', status)).toBe('ok');
    expect((await entriesOf(bal.runId, 'EQUIPMENT_STATUS')).map((e) => e['passed'])).toEqual([true]);
  }, 300_000);
  /**
   * operator1's entry `entry` at step `stepKey`, resolved as the server does and refused by the engine, stored through the
   * application role as the refused row the server writes, its recorded command changed by `forge`. 'ok' or the refusal.
   */
  async function refusedEntry(d: RunDriver, stepKey: string, entry: Json, forge: (command: Json) => void = () => undefined): Promise<string> {
    const run = await runContext(sbx.db.admin, d.runId);
    const who = personaIn(sbx, 'operator1');
    return messageOf(
      withCommand(sbx.db.app, await actorOf(sbx, d.browser('operator1'), 'operator1'), async (c) => {
        const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
        const roles = await engineRoles(c);
        const resolved = await resolveClientIntent(
          { client: c, app: sbx.built.ctx, def: run.def, state: tx.state, room: 'DISP-1', actor: engineActor(who.personId, roles), commandId: randomUUID(), expectedVersion: tx.state.version, useReadings: true },
          { type: 'RECORD_ENTRY', stepKey, entry } as Parameters<typeof resolveClientIntent>[1],
        );
        const r = engine.step(tx.def, tx.state, resolved.command, { nowUs: tx.nowUs });
        if (r.accepted) throw new Error('SETUP: the engine accepted the entry');
        const recorded = engine.encodeCommand(resolved.command) as Json;
        forge(recorded);
        return execution.appendExecution(tx.client, {
          batchId: tx.locked.batch.id, expectedSeq: tx.lastSeq, kind: 'COMMAND', command: recorded as engine.JsonValue, commandId: resolved.command.commandId, nowUs: tx.nowUs,
          accepted: false, refusal: r.refusal, state: r.state, events: r.events, roles, contents: engine.changedContents(tx.def, tx.state, r.state), evidence: resolved.evidence as engine.JsonValue,
        });
      }),
    );
  }

  it('[DI-05][DI-30] round 6: a refused entry is recorded as it was sent, schema breaches included, but a refused row whose command carries lotNumber L2409-0017, a member no block version declares, is refused (EBMR-EXE-126) and nothing holds it', async () => {
    const d = await startedRun();
    const answeredNo = { kind: 'CLEARANCE_CHECK', answers: ['NO_PREVIOUS_MATERIAL', 'NO_PREVIOUS_DOCUMENTS', 'EQUIPMENT_CLEAN_LABEL'].map((id, i) => ({ id, answer: i === 0 ? 'NO' : 'CONFIRMED' })) };
    const outcomes = {
      lotNumber: await refusedEntry(d, CLEAR, answeredNo, (command) => void ((command['entry'] as Json)['lotNumber'] = 'L2409-0017')),
      answerMember: await refusedEntry(d, CLEAR, answeredNo, (command) => void ((((command['entry'] as Json)['answers'] as Json[])[2] as Json)['lot'] = 'L2409-0017')),
    };
    expect(unmatched(outcomes, {
      lotNumber: new RegExp(String.raw`^This refused RECORD_ENTRY row records at step p-disp-clear a refused entry holding a member no block version declares for it: CLEARANCE_CHECK\.lotNumber is not a field of this block \(unknown fields are refused\) \(ENG-ENTRY-SCHEMA\)` + SCHEMA_REFUSAL),
      answerMember: new RegExp(String.raw`^This refused RECORD_ENTRY row records at step p-disp-clear a refused entry holding a member no block version declares for it: CLEARANCE_CHECK\.answers\[2\]\.lot is not a field of this block \(unknown fields are refused\) \(ENG-ENTRY-SCHEMA\)` + SCHEMA_REFUSAL),
    })).toEqual({});
    expect(await rowsHolding(d.runId, 'L2409-0017')).toBe(0);
    // The engine's refusal of the answer NO itself is part of the record.
    const before = (await rowsOf(sbx, d.runId)).length;
    expect(await refusedEntry(d, CLEAR, answeredNo)).toBe('ok');
    expect((await rowsOf(sbx, d.runId)).slice(before).map((r) => ({ type: r.command_type, accepted: r.accepted, code: r.refusal?.code }))).toEqual([{ type: 'RECORD_ENTRY', accepted: false, code: 'ENG-ENTRY-SCHEMA' }]);
    expect(await entriesOf(d.runId, 'CLEARANCE_CHECK')).toEqual([]);
  }, 300_000);
});
