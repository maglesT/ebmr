/**
 * The coating inspection's sampling and verdict (SQL mutation group "tablets-coating", tablets 0911): the code letter
 * of a lot size (both ends of a range included), the acceptance of each defect class at its acceptance number and its
 * rejection at the next, a critical defect always rejecting, the sample size, and the switching between normal and
 * tightened inspection; and the weighing of a coating sample. Called directly on the GMP template; the lot results
 * the switching reads are written by the superuser in a transaction that is always rolled back.
 *
 * Controls: PR-29, PR-33, IN-34; invariant INV-25.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type TestServer } from '../support/harness.ts';

let gmp: TestServer;
beforeAll(async () => {
  gmp = await startServer('GMP');
}, 180_000);
afterAll(async () => {
  await gmp?.close();
});

type Json = Record<string, unknown>;
const one = async <T>(sql: string, params: unknown[] = []): Promise<T> => (await gmp.db.admin.query<{ r: T }>(sql, params)).rows[0]?.r as T;

describe('AQL single sampling (tablets 0911)', () => {
  it('[PR-33][IN-34] the code letter of a lot size: both ends of its range, and the next range after it', async () => {
    const rows = (await gmp.db.admin.query<{ lot_from: string; lot_to: string | null; level_ii: string }>(
      "select lot_from::text, lot_to::text, level_ii from tab.aql_sample_code where code = 'AQL-SINGLE-SAMPLING' and version = '1' order by lot_from",
    )).rows;
    expect(rows.length).toBeGreaterThan(3);
    for (let i = 0; i + 1 < rows.length && i < 6; i++) {
      const r = rows[i];
      const next = rows[i + 1];
      if (!r || !next || r.lot_to === null) continue;
      const letter = (lot: string) => one<string | null>("select tab.aql_letter_for($1::numeric, 'II') as r", [lot]);
      expect(await letter(r.lot_from)).toBe(r.level_ii);
      expect(await letter(r.lot_to)).toBe(r.level_ii);
      const after = String(Number(r.lot_to) + 1);
      const owner = rows.find((x) => Number(x.lot_from) <= Number(after) && (x.lot_to === null || Number(after) <= Number(x.lot_to)));
      expect(await letter(after)).toBe(owner?.level_ii ?? null);
      expect(owner).not.toBe(r);
    }
    expect(await one<string | null>("select tab.aql_letter_for(0, 'II') as r")).toBeNull();
  });

  it('[PR-33][PR-29] each class is accepted at its acceptance number and rejected at the next; one critical defect rejects; the sample never exceeds the lot', async () => {
    const lot = '1000';
    const cfg = { aql: { level: 'II', major: '0.65', minor: '2.5' } };
    const plan = async (aql: string) =>
      (await gmp.db.admin.query<{ ac: string; n: string }>(
        `select p.ac::text as ac, p.sample_size::text as n from tab.aql_plan p
          where p.code = 'AQL-SINGLE-SAMPLING' and p.version = '1' and p.severity = 'NORMAL' and p.aql = $1 and p.letter = tab.aql_letter_for($2::numeric, 'II')`,
        [aql, lot],
      )).rows[0];
    const major = await plan('0.65');
    const minor = await plan('2.5');
    expect(major && minor).toBeTruthy();
    const ev = (found: Json, severity = 'NORMAL', size = lot, c: Json = cfg) =>
      one<{ result: string; sampleSize: string; classes: Record<string, { accepted: boolean }> } | null>('select tab.aql_evaluate($1::jsonb, $2, $3::numeric, $4::jsonb) as r', [
        JSON.stringify(c), severity, size, JSON.stringify(found),
      ]);
    const ac = { MAJOR: Number(major?.ac), MINOR: Number(minor?.ac) };
    expect((await ev({ MAJOR: String(ac.MAJOR), MINOR: String(ac.MINOR) }))?.result).toBe('ACCEPTED');
    expect((await ev({ MAJOR: String(ac.MAJOR + 1), MINOR: String(ac.MINOR) }))).toMatchObject({ result: 'REJECTED', classes: { MAJOR: { accepted: false }, MINOR: { accepted: true } } });
    expect((await ev({ MAJOR: String(ac.MAJOR), MINOR: String(ac.MINOR + 1) }))).toMatchObject({ result: 'REJECTED', classes: { MAJOR: { accepted: true }, MINOR: { accepted: false } } });
    expect((await ev({ CRITICAL: '1' }))).toMatchObject({ result: 'REJECTED', classes: { CRITICAL: { accepted: false } } });
    expect((await ev({}))).toMatchObject({ result: 'ACCEPTED', classes: { CRITICAL: { accepted: true } } });
    expect((await ev({}))?.sampleSize).toBe(String(Math.min(Math.max(Number(major?.n), Number(minor?.n)), Number(lot))));
    // A configuration without its level or one of its AQLs evaluates nothing.
    expect(await ev({}, 'NORMAL', lot, { aql: { level: 'II', major: '0.65' } })).toBeNull();
    expect(await ev({}, 'NORMAL', lot, { aql: { major: '0.65', minor: '2.5' } })).toBeNull();
  });

  it('[PR-33] switching: two rejections among four lots tighten the inspection; five accepted lots in a row return it to normal', async () => {
    const c = await gmp.db.admin.connect();
    try {
      await c.query('begin');
      await c.query("set local session_replication_role = 'replica'");
      const product = `P-${randomUUID().slice(0, 6)}`;
      let n = 0;
      const lotResult = async (accepted: boolean) =>
        c.query(
          "insert into tab.aql_lot_result (batch_id, installation, product_code, step_key, entry_id, severity, accepted, recorded_at) values (gen_random_uuid(), 'GMP', $1, 'K', $2, 'NORMAL', $3, clock_timestamp() + make_interval(secs => $4))",
          [product, `EN-${++n}`, accepted, n],
        );
      const severity = async () => (await c.query<{ r: string }>("select tab.aql_severity($1, 'GMP') as r", [product])).rows[0]?.r;
      // Another product's rejections and another installation's do not count.
      await c.query(
        "insert into tab.aql_lot_result (batch_id, installation, product_code, step_key, entry_id, severity, accepted) values (gen_random_uuid(), 'GMP', 'OTHER', 'K', 'EN-1', 'NORMAL', false), (gen_random_uuid(), 'GMP', 'OTHER', 'K', 'EN-2', 'NORMAL', false), (gen_random_uuid(), 'SANDBOX', $1, 'K', 'EN-1', 'NORMAL', false), (gen_random_uuid(), 'SANDBOX', $1, 'K', 'EN-2', 'NORMAL', false)",
        [product],
      );
      expect(await severity()).toBe('NORMAL');
      // One rejection, then four accepted lots: the first rejection has left the window of four.
      for (const a of [false, true, true, true, true, false]) await lotResult(a);
      expect(await severity()).toBe('NORMAL');
      await lotResult(true);
      await lotResult(false);
      expect(await severity()).toBe('TIGHTENED');
      for (let i = 0; i < 4; i++) await lotResult(true);
      expect(await severity()).toBe('TIGHTENED');
      await lotResult(true);
      expect(await severity()).toBe('NORMAL');
    } finally {
      await c.query('rollback');
      c.release();
    }
  });
});

describe('a coating sample (tablets 0911)', () => {
  it('[PR-29][INV-25] the sample count the MBR sets; a group weighing records one total, one-by-one weighing each weight; mg or g', async () => {
    const sample = (c: Json, count = '20') => one<{ problem?: string; data?: Json }>('select tab.coat_sample($1::jsonb, $2) as r', [JSON.stringify(c), count]);
    const g = { count: '20', weighing: 'GROUP', total: '5.000', unit: 'g', instrument: 'BAL-1' };
    expect((await sample(g)).data).toMatchObject({ totalMg: '5000', meanMg: '250.000000' });
    expect((await sample({ ...g, count: '10' })).problem).toMatch(/TB18-SAMPLE/);
    expect((await sample({ ...g, weights: ['250'] })).problem).toMatch(/one total and no single weights/);
    expect((await sample({ ...g, total: 5 })).problem).toMatch(/one total and no single weights/);
    expect((await sample({ ...g, unit: 'kg' })).problem).toMatch(/in mg or g/);
    expect((await sample({ ...g, weighing: 'BULK' })).problem).toMatch(/as a group or one by one/);
    const ind = { count: '2', weighing: 'INDIVIDUAL', weights: ['250', '251'], unit: 'mg', instrument: 'BAL-1' };
    expect((await sample(ind, '2')).data).toMatchObject({ totalMg: '501', meanMg: '250.500000' });
    expect((await sample({ ...ind, weights: ['250'] }, '2')).problem).toMatch(/each of the 2 tablet weights/);
    expect((await sample({ ...ind, total: '501' }, '2')).problem).toMatch(/each of the 2 tablet weights/);
    expect((await sample({ ...ind, weights: '250' }, '2')).problem).toMatch(/each of the 2 tablet weights/);
  });
});
