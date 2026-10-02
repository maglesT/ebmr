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
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { engine, execution } from '@ebmr/recipe-core';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { actorOf, appendAs, messageOf } from './db-guards-support.ts';
import { dcMini, importAndIssue, outcomeOf, personaIn, RunDriver, startExecServer, writePackage, type ExecServer } from './support.ts';

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
});
