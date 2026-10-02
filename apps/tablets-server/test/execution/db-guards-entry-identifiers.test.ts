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
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { engine, execution } from '@ebmr/recipe-core';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { actorOf, appendAs, messageOf } from './db-guards-support.ts';
import { dcMini, dcMiniVariant, importAndIssue, outcomeOf, personaIn, RunDriver, startExecServer, writePackage, type ExecServer } from './support.ts';

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
});
