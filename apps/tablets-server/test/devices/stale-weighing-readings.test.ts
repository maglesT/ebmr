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
 * (tab.peek_weighing_readings, tablets 0510: every check of the command's claims, tare then gross, made together, then
 * undone); the engine refuses it (ENG-STALE) and the refusal is recorded with what was entered and the version the
 * screen showed. The readings stay unused, so the resend from the reloaded screen records the weighing with them. A
 * pair the claims refuse (one reading named as both) gets the claims' answer before anything is written, as from the
 * current screen. Round 3 (tablets 0520): the database refuses, at commit, any claim under the correlation id of a stale
 * row, and binds the readings such a row names to the stored ones; through the server the stale request claims nothing
 * under its correlation id, names exactly the stored readings, and the resend's claims carry its own correlation id.
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
  correlation_id: string;
}

async function storedRows(runId: string): Promise<StoredRow[]> {
  const { rows } = await rig.server.db.admin.query<StoredRow>(
    'select c.seq::text as seq, c.kind, c.command_type, c.accepted, c.refusal, c.state_version, c.command, c.evidence, c.correlation_id from recipe.execution_command c where c.batch_id = $1 order by c.seq',
    [runId],
  );
  return rows;
}

async function usesOf(ids: string[]): Promise<number> {
  return (await rig.server.db.admin.query('select 1 from tab.reading_use where reading_id = any($1::uuid[])', [ids])).rows.length;
}

/** The correlation ids the uses of `ids` carry, in the order of `ids`. */
async function useCorrelations(ids: string[]): Promise<(string | null)[]> {
  const { rows } = await rig.server.db.admin.query<{ c: string | null }>(
    'select u.correlation_id::text as c from unnest($1::uuid[]) with ordinality as x(id, n) left join tab.reading_use u on u.reading_id = x.id order by x.n',
    [ids],
  );
  return rows.map((r) => r.c);
}

/** The marks the database keeps of a correlation id (tablets 0520), or null. */
async function markOf(correlationId: string | undefined): Promise<{ claimed: boolean; stale_refusal: boolean } | null> {
  const { rows } = await rig.server.db.admin.query<{ claimed: boolean; stale_refusal: boolean }>('select claimed, stale_refusal from tab.reading_claim_mark where correlation_id = $1', [correlationId]);
  return rows[0] ?? null;
}

/** The readings `ids` as a claim gives them, each named for its purpose (TARE, then GROSS). */
async function storedReadings(ids: [string, string]): Promise<Record<string, unknown>[]> {
  const { rows } = await rig.server.db.admin.query<{ list: Record<string, unknown>[] }>(
    `select jsonb_agg(jsonb_build_object('purpose', x.purpose, 'readingId', r.id, 'deviceCode', r.device_code, 'value', r.value, 'unit', r.unit, 'raw', r.raw,
                                         'sourceTimeUs', r.source_time_us::text, 'trust', r.trust) order by x.n) as list
       from unnest($1::uuid[], array['TARE', 'GROSS']) with ordinality as x(id, purpose, n) join tab.device_reading r on r.id = x.id`,
    [ids],
  );
  return rows[0]?.list ?? [];
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
    // Exactly the stored readings, as a claim gives them, and nothing else (tablets 0520 holds a stale row to that).
    expect(stale?.evidence['namedReadings']).toEqual(await storedReadings([tare.readingId, gross.readingId]));
    expect(await usesOf([tare.readingId, gross.readingId])).toBe(0);
    // No reading is claimed under the stale request's correlation id, and the database marks it as a stale refusal's:
    // a claim under it would be refused at commit (tablets 0520).
    expect((await rig.server.db.admin.query('select 1 from tab.reading_use where correlation_id = $1', [stale?.correlation_id])).rows).toHaveLength(0);
    expect(await markOf(stale?.correlation_id)).toEqual({ claimed: false, stale_refusal: true });
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
    const resend = (await storedRows(d.runId)).at(-1);
    expect(resend).toMatchObject({ accepted: true, evidence: { readings: [{ readingId: tare.readingId }, { readingId: gross.readingId }] } });
    // The uses are the resend's, a request of its own: they carry its correlation id, never the stale row's.
    expect(resend?.correlation_id).not.toBe(stale?.correlation_id);
    expect(await useCorrelations([tare.readingId, gross.readingId])).toEqual([resend?.correlation_id, resend?.correlation_id]);
    expect([await markOf(stale?.correlation_id), await markOf(resend?.correlation_id)]).toEqual([
      { claimed: false, stale_refusal: true },
      { claimed: true, stale_refusal: false },
    ]);
    const run = await runContext(rig.server.db.admin, d.runId);
    expect(await execution.replayExecution(rig.server.db.admin, run.def, d.runId)).toMatchObject({ identical: true, firstDifference: null });
    expect(await violations(rig.server)).toEqual([]);
  }, 300_000);

  it('[DI-32][DI-34][PR-19] a weighing from an older screen that names one reading taken for no stated purpose as both its tare and its gross gets the answer the current screen gets (EBMR-DEV-105) before anything is written: no row, and the reading stays unused (F58.1)', async () => {
    const d = await newRun(rig);
    await reachPcm(d);
    await report(rig, { 'TEST-BAL-01': 'ONLINE' });
    const seen = await d.version('operator1');
    expect(outcomeOf(await d.command('verifier1', { type: 'RAISE_EXCEPTION', stepKey: PCM, description: 'Spill wiped next to the booth', severity: 'ALERT' }))).toBe('ok');
    // A stable reading the gateway took for no stated purpose (a reading may carry none): either claim accepts it alone.
    const one = rig.gw.next({ value: '5.000', purpose: null });
    expect((await rig.gw.uplink([{ reading: one }])).body.refused).toBeNull();
    const rowsBefore = await storedRows(d.runId);

    // From the older screen: refused as the claims of the command refuse it (the gross claim finds the reading used by
    // the tare's), before the engine runs, so no stale row is recorded with that reading named twice.
    expect(outcomeOf(await d.command('operator1', weighing(one.readingId, one.readingId), { expectedVersion: seen }))).toBe('409:EBMR-DEV-105');
    expect(await storedRows(d.runId)).toEqual(rowsBefore);
    expect(await usesOf([one.readingId])).toBe(0);
    // From the current screen: the same answer, and nothing written either.
    expect(outcomeOf(await d.command('operator1', weighing(one.readingId, one.readingId)))).toBe('409:EBMR-DEV-105');
    expect(await storedRows(d.runId)).toEqual(rowsBefore);
    expect(await usesOf([one.readingId])).toBe(0);

    // The reading is still there to be used once, as the tare of a weighing with a gross of its own.
    const gross = rig.gw.next({ value: '26.250', purpose: 'GROSS' });
    expect((await rig.gw.uplink([{ reading: gross }])).body.refused).toBeNull();
    expect(outcomeOf(await d.command('operator1', weighing(one.readingId, gross.readingId)))).toBe('ok');
    expect(await usesOf([one.readingId, gross.readingId])).toBe(2);
    expect(await violations(rig.server)).toEqual([]);
  }, 300_000);
});
