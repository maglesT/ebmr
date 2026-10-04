/**
 * Phase 2 exit review F12, round 7 (the round-6 verification; DI-05, DI-31, DI-32; tablets 0590, recipe-core 0335; ADR
 * 0012: the application role is the attacker, with the same database rights as the server): the scale readings a weighing
 * captured from a device uses are recorded exactly as the server lists them, the tare then the gross, each as stored.
 *
 * Tablets 0300 bound a device weighing to the readings its evidence names by reading id and purpose (and the entry's
 * balance, weights and unit to the stored readings), and tablets 0520 bound the readings a stale row names whole; nothing
 * read the rest of a used reading. Written past the server, an accepted device weighing whose evidence gave its tare the
 * raw line 'L2409-0017' was recorded, a real-format lot number in a test run's record, and so was one stating another
 * capture time, trust or value than the stored reading's, or listing the gross first. Each probe below was recorded
 * before tablets 0590.
 *
 * Own file and server: the kiosk's device nonces are rate-limited per terminal and minute (as the stale-row files).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startRig, stopRig, type Rig } from '../devices/room-scales-support.ts';
import { staleRowHelpers, type Json } from './db-guards-stale-support.ts';

let rig: Rig;
beforeAll(async () => {
  rig = await startRig();
}, 180_000);
afterAll(async () => {
  await stopRig(rig);
});

const { readings, usesOf, weighingPast, preparedRun } = staleRowHelpers(() => rig);

/** The readings a resolved weighing uses (its evidence.readings). */
const used = (evidence: Json): Json[] => evidence['readings'] as Json[];

describe('F12 round 7: the readings a device weighing uses are recorded as stored (DI-05, DI-31, DI-32)', () => {
  it('[DI-05][DI-31][DI-32] F12 round 7: written past the server, a device weighing whose used readings carry a raw line L2409-0017, another device, capture time, trust or value than the stored reading, a member of its own, or the gross first is refused (EBMR-EXE-124), and nothing holds L2409-0017 or uses the readings; the honest weighing is recorded with them', async () => {
    const d = await preparedRun();
    // Each probe on readings of its own, so each shows what it alone records.
    const probe = async (edit: (evidence: Json) => void): Promise<{ outcome: string; uses: number }> => {
      const ids = await readings();
      const outcome = await weighingPast(d, ids, { useReadings: true, seen: (v) => v, edit: (_command, evidence) => edit(evidence) });
      return { outcome, uses: await usesOf([ids.tare, ids.gross]) };
    };
    const first = (evidence: Json): Json => used(evidence)[0] as Json;
    const outcomes = {
      raw: await probe((e) => void (first(e)['raw'] = 'L2409-0017')),
      device: await probe((e) => void (first(e)['deviceCode'] = 'TEST-BAL-00')),
      time: await probe((e) => void (first(e)['sourceTimeUs'] = '1')),
      trust: await probe((e) => void (first(e)['trust'] = 'USER_CLAIMED')),
      value: await probe((e) => void (first(e)['value'] = '9.999')),
      member: await probe((e) => void (first(e)['lot'] = 'L2409-0017')),
      grossFirst: await probe((e) => void used(e).reverse()),
    };
    const refused = { outcome: 'EBMR-EXE-124', uses: 0 };
    expect(outcomes).toEqual({ raw: refused, device: refused, time: refused, trust: refused, value: refused, member: refused, grossFirst: refused });
    const { rows } = await rig.server.db.admin.query<{ n: string }>("select count(*)::text as n from recipe.execution_command where batch_id = $1 and evidence::text like '%L2409-0017%'", [d.runId]);
    expect(rows[0]?.n).toBe('0');
    // The weighing as the server resolves it is recorded, and uses its readings.
    expect(await probe(() => undefined)).toEqual({ outcome: 'ok', uses: 2 });
  }, 300_000);
});
