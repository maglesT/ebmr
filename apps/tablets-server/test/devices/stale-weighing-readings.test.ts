/**
 * Phase 2 exit review F58 (floor robustness; DI-32, DI-34, PR-19): a weighing refused only because the run moved on
 * (ENG-STALE) no longer uses up its scale readings.
 *
 * The run command claimed the tare and gross readings (tab.claim_readings) while resolving the intent, before the
 * engine's first check (ENG-STALE) ran; the refusal was then committed with the claims, so both readings were spent and
 * the operator had to empty the filled container to tare again (a retry with the same readings: EBMR-DEV-105). The
 * server now checks the version the screen showed before it resolves the intent: a stale request claims nothing and
 * writes nothing, and the resend from the reloaded screen records the weighing with the same readings.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outcomeOf, rowsOf } from '../execution/support.ts';
import { newRun, PCM, reachPcm, report, startRig, stopRig, type Rig } from './room-scales-support.ts';

let rig: Rig;
beforeAll(async () => {
  rig = await startRig();
}, 180_000);
afterAll(async () => {
  await stopRig(rig);
});

const weighing = (tare: string, gross: string) => ({ type: 'RECORD_ENTRY' as const, stepKey: PCM, entry: { kind: 'CONTAINER_WEIGHING' as const, item: 'pcmDispensed', bomLine: 'BOM-PCM', lotCode: 'TEST-L26-0101', tareReadingId: tare, grossReadingId: gross } });

describe('F58: a stale weighing keeps its scale readings (DI-32, DI-34)', () => {
  it('[DI-32][DI-34][PR-19] another person moves the run on; the weighing from the older screen is refused as stale, claims nothing and writes nothing; the resend with the same readings is recorded', async () => {
    const d = await newRun(rig);
    await reachPcm(d);
    await report(rig, { 'TEST-BAL-01': 'ONLINE' });
    const seen = await d.version('operator1');
    // Another person acts on the run after the operator's screen was read.
    expect(outcomeOf(await d.command('verifier1', { type: 'RAISE_EXCEPTION', stepKey: PCM, description: 'Spill wiped next to the booth', severity: 'ALERT' }))).toBe('ok');
    const tare = rig.gw.next({ value: '1.250', purpose: 'TARE' });
    const gross = rig.gw.next({ value: '26.250', purpose: 'GROSS' });
    expect((await rig.gw.uplink([{ reading: tare }, { reading: gross }])).body.refused).toBeNull();
    const rowsBefore = (await rowsOf(rig.server, d.runId)).length;

    const first = await d.command('operator1', weighing(tare.readingId, gross.readingId), { expectedVersion: seen });
    expect(outcomeOf(first)).toBe('409:ENG-STALE');
    expect(first.ok ? null : first.error.kind === 'REFUSAL' ? first.error.envelope.refusal.whatHappened : null).toBe('The test run changed since this screen was loaded. Nothing was saved, and no scale reading was used.');
    const uses = await rig.server.db.admin.query<{ n: string }>('select count(*)::text as n from tab.reading_use where reading_id = any($1::uuid[])', [[tare.readingId, gross.readingId]]);
    expect(uses.rows[0]?.n).toBe('0');
    expect((await rowsOf(rig.server, d.runId)).length).toBe(rowsBefore);

    // The reloaded screen sends the same readings again: recorded.
    expect(outcomeOf(await d.command('operator1', weighing(tare.readingId, gross.readingId)))).toBe('ok');
    const used = await rig.server.db.admin.query<{ n: string }>('select count(*)::text as n from tab.reading_use where reading_id = any($1::uuid[])', [[tare.readingId, gross.readingId]]);
    expect(used.rows[0]?.n).toBe('2');
  }, 300_000);
});
