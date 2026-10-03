/**
 * Phase 2 exit review F59 (floor robustness; DI-32, PR-19): which refusals of a container weighing spend its scale
 * readings, and how the answer says so.
 *
 * A reading stays used only when the command that names it commits (tab.reading_use is written in the command's
 * transaction). A refusal given before the command runs (a badge not accepted) or thrown while the intent is resolved
 * (an unknown lot) rolls back and spends nothing: the same tare and gross are accepted afterwards, so the web form keeps
 * them. An engine refusal is committed together with the claims: its answer names the readings it used
 * (details.readingsUsed), so the form drops exactly those.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { outcomeOf } from '../execution/support.ts';
import { newRun, PCM, reachPcm, report, startRig, stopRig, type Rig } from './room-scales-support.ts';

let rig: Rig;
beforeAll(async () => {
  rig = await startRig();
}, 180_000);
afterAll(async () => {
  await stopRig(rig);
});

const weighing = (tare: string, gross: string, lotCode = 'TEST-L26-0101') => ({
  type: 'RECORD_ENTRY' as const,
  stepKey: PCM,
  entry: { kind: 'CONTAINER_WEIGHING' as const, item: 'pcmDispensed', bomLine: 'BOM-PCM', lotCode, tareReadingId: tare, grossReadingId: gross },
});

async function usesOf(ids: string[]): Promise<number> {
  const r = await rig.server.db.admin.query('select 1 from tab.reading_use where reading_id = any($1::uuid[])', [ids]);
  return r.rows.length;
}

const detailsOf = (r: Awaited<ReturnType<Awaited<ReturnType<typeof newRun>>['command']>>) => (r.ok || r.error.kind !== 'REFUSAL' ? null : (r.error.envelope.refusal.details ?? {}));

async function twoReadings() {
  const tare = rig.gw.next({ value: '1.250', purpose: 'TARE' });
  const gross = rig.gw.next({ value: '26.250', purpose: 'GROSS' });
  expect((await rig.gw.uplink([{ reading: tare }, { reading: gross }])).body.refused).toBeNull();
  return [tare.readingId, gross.readingId] as const;
}

describe('F59: the readings of a refused weighing (DI-32, PR-19)', () => {
  it('[DI-32][PR-19] a badge not accepted (401 EBMR-IAM-140) and an unknown lot (EBMR-EXE-072) leave both readings unused and name none; the same readings are then accepted', async () => {
    const d = await newRun(rig);
    await reachPcm(d);
    await report(rig, { 'TEST-BAL-01': 'ONLINE' });
    const [tare, gross] = await twoReadings();

    // A tap the server does not know: refused before the command runs.
    const b = d.browser('operator1');
    const path = `/api/test-runs/${d.runId}/commands`;
    const body = { expectedVersion: await d.version('operator1'), intent: weighing(tare, gross) };
    d.beforeTap();
    const badTap = await b.call(routes.execution.command, { params: { runId: d.runId }, body, attribution: { method: 'BADGE_TAP', badgeUid: 'FFFFFFFFFFFFFFFF', proof: await b.proof('POST', path, body) } });
    const usesAfterBadTap = await usesOf([tare, gross]);

    // A wrong lot scanned: thrown by the intent resolution, rolled back.
    const unknownLot = await d.command('operator1', weighing(tare, gross, 'TEST-L26-9999'));
    const usesAfterUnknownLot = await usesOf([tare, gross]);

    // The same two readings, sent again with the right lot and a good tap.
    const retry = await d.command('operator1', weighing(tare, gross));
    expect({
      badTap: outcomeOf(badTap),
      badTapNames: detailsOf(badTap)?.['readingsUsed'] ?? null,
      usesAfterBadTap,
      unknownLot: outcomeOf(unknownLot),
      unknownLotNames: detailsOf(unknownLot)?.['readingsUsed'] ?? null,
      usesAfterUnknownLot,
      retry: outcomeOf(retry),
      usesAfterRetry: await usesOf([tare, gross]),
    }).toEqual({ badTap: '401:EBMR-IAM-140', badTapNames: null, usesAfterBadTap: 0, unknownLot: '422:EBMR-EXE-072', unknownLotNames: null, usesAfterUnknownLot: 0, retry: 'ok', usesAfterRetry: 2 });
  }, 300_000);

  it('[DI-32][PR-19] an engine refusal (a quarantined lot, G07-LOT-STATUS) is committed with the claims: its answer names both readings it used, and a resend of them is refused as used', async () => {
    const d = await newRun(rig);
    await reachPcm(d);
    await report(rig, { 'TEST-BAL-01': 'ONLINE' });
    const [tare, gross] = await twoReadings();

    const refused = await d.command('operator1', weighing(tare, gross, 'TEST-L26-0199'));
    expect(outcomeOf(refused)).toBe('422:G07-LOT-STATUS');
    expect(detailsOf(refused)?.['readingsUsed']).toBe(`${tare},${gross}`);
    expect(await usesOf([tare, gross])).toBe(2);
    // A claim refusal names the reading it could not use: the form drops that one (web readingsAfterRefusal).
    const again = await d.command('operator1', weighing(tare, gross));
    expect(outcomeOf(again)).toBe('409:EBMR-DEV-105');
    expect(again.ok || again.error.kind !== 'REFUSAL' ? null : again.error.envelope.refusal.why).toContain(tare);
  }, 300_000);
});
