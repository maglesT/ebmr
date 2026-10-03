/**
 * Phase 2 exit review F58 (floor robustness; DI-32, DI-34, PR-19): a weighing refused only because the run moved on
 * (ENG-STALE) no longer uses up its scale readings; and its follow-up F58.1: that refusal is part of the record.
 *
 * F58: the run command claimed the tare and gross readings (tab.claim_readings) while resolving the intent, before the
 * engine's first check (ENG-STALE) ran; the refusal was then committed with the claims, so both readings were spent and
 * the operator had to empty the filled container to tare again (a retry with the same readings: EBMR-DEV-105). The
 * first fix checked the version before resolving the intent and wrote nothing, so the stale attempt was no longer a
 * row of the run, although DI-34 records every refused engine call with its refusal.
 *
 * F58.1: the server resolves a stale request as any other, except that it names the scale readings without using them
 * (tab.peek_readings: every check of a claim, then undone); the engine refuses it (ENG-STALE) and the refusal is
 * recorded with what was entered and the version the screen showed. The readings stay unused, so the resend from the
 * reloaded screen records the weighing with them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execution } from '@ebmr/recipe-core';
import { runContext } from '../../src/features/execution/runs.ts';
import { outcomeOf, violations } from '../execution/support.ts';
import { newRun, PCM, reachPcm, report, startRig, stopRig, type Rig } from './room-scales-support.ts';

let rig: Rig;
beforeAll(async () => {
  rig = await startRig();
}, 180_000);
afterAll(async () => {
  await stopRig(rig);
});

const weighing = (tare: string, gross: string) => ({ type: 'RECORD_ENTRY' as const, stepKey: PCM, entry: { kind: 'CONTAINER_WEIGHING' as const, item: 'pcmDispensed', bomLine: 'BOM-PCM', lotCode: 'TEST-L26-0101', tareReadingId: tare, grossReadingId: gross } });

interface StoredRow {
  seq: string;
  kind: string;
  command_type: string;
  accepted: boolean;
  refusal: { code: string } | null;
  state_version: number;
  command: Record<string, unknown>;
  evidence: Record<string, unknown>;
}

async function storedRows(runId: string): Promise<StoredRow[]> {
  const { rows } = await rig.server.db.admin.query<StoredRow>(
    'select c.seq::text as seq, c.kind, c.command_type, c.accepted, c.refusal, c.state_version, c.command, c.evidence from recipe.execution_command c where c.batch_id = $1 order by c.seq',
    [runId],
  );
  return rows;
}

async function usesOf(ids: string[]): Promise<number> {
  return (await rig.server.db.admin.query('select 1 from tab.reading_use where reading_id = any($1::uuid[])', [ids])).rows.length;
}

describe('F58: a stale weighing keeps its scale readings (DI-32, DI-34)', () => {
  it('[DI-32][DI-34][PR-19] another person moves the run on; the weighing from the older screen is refused as stale and recorded (what was entered, the version the screen showed, ENG-STALE) without using its scale readings or changing anything else; the resend with the same readings is recorded', async () => {
    const d = await newRun(rig);
    await reachPcm(d);
    await report(rig, { 'TEST-BAL-01': 'ONLINE' });
    const seen = await d.version('operator1');
    // Another person acts on the run after the operator's screen was read.
    expect(outcomeOf(await d.command('verifier1', { type: 'RAISE_EXCEPTION', stepKey: PCM, description: 'Spill wiped next to the booth', severity: 'ALERT' }))).toBe('ok');
    const tare = rig.gw.next({ value: '1.250', purpose: 'TARE' });
    const gross = rig.gw.next({ value: '26.250', purpose: 'GROSS' });
    expect((await rig.gw.uplink([{ reading: tare }, { reading: gross }])).body.refused).toBeNull();
    const rowsBefore = await storedRows(d.runId);
    const before = await execution.loadState(rig.server.db.admin, d.runId);

    const first = await d.command('operator1', weighing(tare.readingId, gross.readingId), { expectedVersion: seen });
    expect(outcomeOf(first)).toBe('409:ENG-STALE');

    // The refusal is one row: what was entered (the weighing as the readings give it, the readings named), the version
    // the screen showed and the engine's code.
    const rows = await storedRows(d.runId);
    expect(rows.slice(0, rowsBefore.length)).toEqual(rowsBefore);
    expect(rows.slice(rowsBefore.length)).toHaveLength(1);
    const stale = rows.at(-1);
    expect(stale).toMatchObject({ kind: 'COMMAND', command_type: 'RECORD_ENTRY', accepted: false, refusal: { code: 'ENG-STALE' }, state_version: before?.version });
    expect(stale?.command).toMatchObject({
      type: 'RECORD_ENTRY',
      step: 'p-disp-pcm',
      expectedVersion: seen,
      entry: { kind: 'CONTAINER_WEIGHING', item: 'pcmDispensed', bomLine: 'BOM-PCM', lot: { id: 'TEST-L26-0101' }, tare: '1.250', gross: '26.250', unit: 'kg', balance: 'TEST-BAL-01', source: 'DEVICE' },
    });
    expect(seen).not.toBe(before?.version);
    // The readings are named, not used: no use row, and the row lists none as used (evidence.readings).
    expect(stale?.evidence['readings']).toBeUndefined();
    expect(stale?.evidence['namedReadings']).toMatchObject([
      { purpose: 'TARE', readingId: tare.readingId, deviceCode: 'TEST-BAL-01', value: '1.250', unit: 'kg' },
      { purpose: 'GROSS', readingId: gross.readingId, deviceCode: 'TEST-BAL-01', value: '26.250', unit: 'kg' },
    ]);
    expect(await usesOf([tare.readingId, gross.readingId])).toBe(0);
    // The answer says so, and names no reading as used (the form keeps its captures).
    const said = first.ok || first.error.kind !== 'REFUSAL' ? null : first.error.envelope.refusal;
    expect(said?.whatHappened).toBe('The test run changed since this screen was loaded. The refusal is recorded; no scale reading was used, and nothing else changed.');
    expect(said?.details?.['readingsUsed']).toBeUndefined();
    // Nothing else of the run changed: its version, steps, entries, values and containers are as before.
    const after = await execution.loadState(rig.server.db.admin, d.runId);
    expect({ version: after?.version, steps: after?.state.steps, entries: after?.state.entries, points: after?.state.points, containers: after?.state.containers }).toEqual({
      version: before?.version,
      steps: before?.state.steps,
      entries: before?.state.entries,
      points: before?.state.points,
      containers: before?.state.containers,
    });

    // The reloaded screen sends the same readings again: recorded, and only now are they used.
    expect(outcomeOf(await d.command('operator1', weighing(tare.readingId, gross.readingId)))).toBe('ok');
    expect(await usesOf([tare.readingId, gross.readingId])).toBe(2);
    expect((await storedRows(d.runId)).at(-1)).toMatchObject({ accepted: true, evidence: { readings: [{ readingId: tare.readingId }, { readingId: gross.readingId }] } });
    const run = await runContext(rig.server.db.admin, d.runId);
    expect(await execution.replayExecution(rig.server.db.admin, run.def, d.runId)).toMatchObject({ identical: true, firstDifference: null });
    expect(await violations(rig.server)).toEqual([]);
  }, 300_000);
});
