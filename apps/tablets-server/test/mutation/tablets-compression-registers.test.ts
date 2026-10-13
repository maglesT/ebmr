/**
 * The tooling register and the detector challenges in the database alone (SQL mutation group "tablets-compression",
 * tablets 0871, 0872, 1040; Phase 4 slice 7c, the "not twins" of the Phase 3 exit run): the rules a set's issue and use
 * stand on (tab.tooling_cumulative, tab.tooling_fit_problem, tab.tooling_issue_problem, tab.tooling_use_problem), the
 * register's commands (define, look up, inspect, issue, return with the press counter or a keyed count) and the
 * detector challenge record with the hold a failed challenge raises. No engine check stands in front of these: the
 * register is written only through these functions.
 *
 * The register rows a rule reads (sets, inspections, issues, returns, counter readings) are written by the superuser with
 * session_replication_role = replica in a transaction that is always rolled back, with the times each case needs; the
 * commands run in the persona's own validated command (operator1, the master-data steward).
 *
 * Controls: INV-24 (tooling within its stroke limit), IN-36 (punches and dies inspected before and after use; detector
 * challenges), IN-35, PR-22, PR-23, PR-27 (tooling assigned to a product), DI-31 (the press counter over a keyed count).
 */
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type TestServer } from '../support/harness.ts';
import { holdFixtures } from './hold-fixtures.ts';
import { attempt, code, inCommand, replica, tag, value, type Json } from './kill-support.ts';

let gmp: TestServer;
beforeAll(async () => {
  gmp = await startServer('GMP');
}, 180_000);
afterAll(async () => {
  await gmp?.close();
});

const ITEMS = ['TIPS', 'EDGES', 'WEAR', 'EMBOSSING', 'CORROSION', 'CLEANLINESS'];
const findings = (bad: string | null = null): Json => Object.fromEntries(ITEMS.map((k) => [k, k !== bad]));

/** Register rows written directly (replica): times as instants (text) or intervals before now. */
function register(c: PoolClient) {
  const at = (t: string): string => (/^\d{4}-/.test(t) ? `'${t}'::timestamptz` : `clock_timestamp() - '${t}'::interval`);
  return {
    async set(code: string, limit = 1000, product = 'P1'): Promise<string> {
      return (
        await c.query<{ id: string }>(
          `insert into tab.tooling_set (code, product_code, tooling_type, shape, upper_embossing, lower_embossing, score, tips, upper_punches, lower_punches, dies,
                                        stroke_limit, person_id, account_id)
           values ($1, $2, 'B', 'ROUND', 'A', 'B', 'NONE', 1, 27, 26, 25, $3, gen_random_uuid(), gen_random_uuid()) returning id::text`,
          [code, product, limit],
        )
      ).rows[0]?.id as string;
    },
    async inspection(set: string, kind: 'PRE_USE' | 'POST_USE', when: string, result = 'PASS', disposition: string | null = null, issue: string | null = null): Promise<string> {
      return (
        await c.query<{ id: string }>(
          `insert into tab.tooling_inspection (set_id, kind, issue_id, findings, result, disposition, person_id, account_id, inspected_at)
           values ($1, $2, $3, '{}', $4, $5, gen_random_uuid(), gen_random_uuid(), ${at(when)}) returning id::text`,
          [set, kind, issue, result, disposition],
        )
      ).rows[0]?.id as string;
    },
    async issue(set: string, batch: string, press: string, pre: string, when: string, baseline: string | null = null): Promise<string> {
      return (
        await c.query<{ id: string }>(
          `insert into tab.tooling_issue (set_id, batch_id, press_equipment_id, pre_use_inspection_id, upper_issued, lower_issued, dies_issued, baseline_reading_id,
                                          person_id, account_id, issued_at)
           values ($1, $2, $3, $4, 27, 26, 25, $5, gen_random_uuid(), gen_random_uuid(), ${at(when)}) returning id::text`,
          [set, batch, press, pre, baseline],
        )
      ).rows[0]?.id as string;
    },
    async returned(issue: string, set: string, strokes: number, when: string): Promise<void> {
      await c.query(
        `insert into tab.tooling_return (issue_id, set_id, upper_returned, lower_returned, dies_returned, count_mismatch, strokes, stroke_source, counter_readings,
                                         cumulative_strokes, limit_exceeded, person_id, account_id, returned_at)
         values ($1, $2, 27, 26, 25, false, $3, 'MANUAL', 0, $3, false, gen_random_uuid(), gen_random_uuid(), ${at(when)})`,
        [issue, set, strokes],
      );
    },
    async now(ago: string): Promise<string> {
      return (await c.query<{ t: string }>(`select (${at(ago)})::text as t`)).rows[0]?.t as string;
    },
  };
}

/** A press of the plant with a process device linked to it; stroke.count readings of that device. */
async function counter(c: PoolClient, pressId: string): Promise<{ reading: (value: string, ago: string) => Promise<string> }> {
  const gk = randomUUID();
  const dev = randomUUID();
  const serial = `S-${tag()}`;
  await c.query(
    "insert into tab.process_device (id, gateway_key_id, instrument_device_id, device_code, serial, equipment_kind, bound_by_person) values ($1, $2, gen_random_uuid(), 'TEST-PRESS-DEV', $3, 'PRESS', gen_random_uuid())",
    [dev, gk, serial],
  );
  await c.query('insert into tab.process_device_unit (process_device_id, equipment_id, person_id, account_id) values ($1, $2, gen_random_uuid(), gen_random_uuid())', [dev, pressId]);
  let seq = 0;
  return {
    async reading(v, ago) {
      seq += 1;
      return (
        await c.query<{ id: string }>(
          `insert into tab.process_reading (process_device_id, gateway_key_id, device_code, serial, tag, kind, value, unit, quality, source_time_us, seq, gateway_run_id,
                                            received_at, received_us, ingest_session_id, correlation_id)
           values ($1, $2, 'TEST-PRESS-DEV', $3, 'stroke.count', 'ACTUAL', $4, 'count', 'GOOD', 0, $5, gen_random_uuid(), clock_timestamp() - $6::interval, 0,
                   gen_random_uuid(), gen_random_uuid()) returning id::text`,
          [dev, gk, serial, v, seq, ago],
        )
      ).rows[0]?.id as string;
    },
  };
}

async function pressOf(c: PoolClient, code: string): Promise<string> {
  await c.query("insert into plant.equipment (code, name, class_code, kind, recorded_by) values ($1, 'Press', 'X', 'PROCESS', gen_random_uuid())", [code]);
  return (await c.query<{ id: string }>('select id::text from plant.equipment where code = $1', [code])).rows[0]?.id as string;
}

describe('the tooling register rules (tablets 0871)', () => {
  it('[INV-24][IN-36][PR-27] cumulative strokes per set; fit (retired, latest inspection failed); issue (product, retired, open or uninspected last use, a fresh unused passing pre-use inspection after the return, strokes below the limit); use (returned, fit, its own passing pre-use inspection, strokes with the open use below the limit)', async () => {
    await inCommand(gmp, 'operator1', async (c) => {
      const t = tag();
      const g = register(c);
      const fx = holdFixtures(c, gmp.seed.siteCode);
      const s: Record<string, string> = {};
      let B = '';
      let press = '';
      await replica(c, async () => {
        B = await fx.batch();
        press = await pressOf(c, `PR-T-${t}`);
        // Fit: clean (no inspection), retired, latest failed (after an earlier pass), latest passed (after an earlier fail).
        s['clean'] = await g.set(`T-${t}-CLEAN`);
        s['retired'] = await g.set(`T-${t}-RETIRED`);
        await g.inspection(s['retired'], 'PRE_USE', '5 hours', 'FAIL', 'RETIRE');
        await g.inspection(s['retired'], 'PRE_USE', '4 hours', 'PASS');
        s['recovered'] = await g.set(`T-${t}-RECOVERED`);
        await g.inspection(s['recovered'], 'PRE_USE', '5 hours', 'FAIL', 'POLISH');
        await g.inspection(s['recovered'], 'PRE_USE', '4 hours', 'PASS');
        // Issue: never issued, ready; another product; issued and open; returned without the after-return inspection;
        // returned and inspected, no new pre-use inspection; a new one at the very instant of the return (ready); one
        // before the return; a failed pre-use one; a pre-use one an earlier issue used; ready but at its stroke limit.
        s['ready'] = await g.set(`T-${t}-READY`);
        await g.inspection(s['ready'], 'PRE_USE', '3 hours');
        s['other'] = await g.set(`T-${t}-OTHER`, 1000, 'P2');
        await g.inspection(s['other'], 'PRE_USE', '3 hours');
        s['open'] = await g.set(`T-${t}-OPEN`);
        s['openIssue'] = await g.issue(s['open'], B, press, await g.inspection(s['open'], 'PRE_USE', '3 hours'), '170 minutes');
        s['unchecked'] = await g.set(`T-${t}-UNCHECKED`);
        s['uncheckedIssue'] = await g.issue(s['unchecked'], B, press, await g.inspection(s['unchecked'], 'PRE_USE', '3 hours'), '170 minutes');
        await g.returned(s['uncheckedIssue'], s['unchecked'], 10, '2 hours');
        s['post'] = await g.set(`T-${t}-POST`);
        const postIssue = await g.issue(s['post'], B, press, await g.inspection(s['post'], 'PRE_USE', '3 hours'), '170 minutes');
        await g.returned(postIssue, s['post'], 10, '2 hours');
        await g.inspection(s['post'], 'POST_USE', '110 minutes', 'PASS', null, postIssue);
        const ret = await g.now('2 hours');
        s['again'] = await g.set(`T-${t}-AGAIN`, 100);
        const againIssue = await g.issue(s['again'], B, press, await g.inspection(s['again'], 'PRE_USE', '3 hours'), '170 minutes');
        await g.returned(againIssue, s['again'], 99, ret);
        await g.inspection(s['again'], 'POST_USE', '150 minutes', 'PASS', null, againIssue);
        await g.inspection(s['again'], 'PRE_USE', ret);
        s['early'] = await g.set(`T-${t}-EARLY`);
        const earlyIssue = await g.issue(s['early'], B, press, await g.inspection(s['early'], 'PRE_USE', '3 hours'), '170 minutes');
        await g.returned(earlyIssue, s['early'], 10, '2 hours');
        await g.inspection(s['early'], 'POST_USE', '160 minutes', 'PASS', null, earlyIssue);
        await g.inspection(s['early'], 'PRE_USE', '121 minutes');
        s['failedPre'] = await g.set(`T-${t}-FAILEDPRE`);
        await g.inspection(s['failedPre'], 'PRE_USE', '3 hours', 'FAIL', 'REPAIR');
        s['used'] = await g.set(`T-${t}-USED`);
        const usedPre = await g.inspection(s['used'], 'PRE_USE', '100 minutes');
        const usedIssue = await g.issue(s['used'], B, press, usedPre, '170 minutes');
        await g.returned(usedIssue, s['used'], 10, '2 hours');
        await g.inspection(s['used'], 'POST_USE', '150 minutes', 'PASS', null, usedIssue);
        s['limit'] = await g.set(`T-${t}-LIMIT`, 100);
        const limitIssue = await g.issue(s['limit'], B, press, await g.inspection(s['limit'], 'PRE_USE', '3 hours'), '170 minutes');
        await g.returned(limitIssue, s['limit'], 100, '2 hours');
        await g.inspection(s['limit'], 'POST_USE', '110 minutes', 'PASS', null, limitIssue);
        await g.inspection(s['limit'], 'PRE_USE', '100 minutes');
        // Use: open issues: fit and within the limit; at the limit with this use's own strokes counted (returns of
        // earlier uses at 60, the press counter 40 since the baseline); its pre-use inspection failed (a later pass);
        // a retired set; returned.
        s['live'] = await g.set(`T-${t}-LIVE`, 100);
        const liveEarlier = await g.issue(s['live'], B, press, await g.inspection(s['live'], 'PRE_USE', '5 hours'), '290 minutes');
        await g.returned(liveEarlier, s['live'], 60, '4 hours');
        const livePress = await pressOf(c, `PR-L-${t}`);
        const k = await counter(c, livePress);
        const base = await k.reading('1000', '20 minutes');
        await k.reading('1040', '10 minutes');
        s['liveIssue'] = await g.issue(s['live'], B, livePress, await g.inspection(s['live'], 'PRE_USE', '30 minutes'), '25 minutes', base);
        s['near'] = await g.set(`T-${t}-NEAR`, 100);
        const nearEarlier = await g.issue(s['near'], B, press, await g.inspection(s['near'], 'PRE_USE', '5 hours'), '290 minutes');
        await g.returned(nearEarlier, s['near'], 59, '4 hours');
        s['nearIssue'] = await g.issue(s['near'], B, livePress, await g.inspection(s['near'], 'PRE_USE', '30 minutes'), '25 minutes', base);
        s['badPre'] = await g.set(`T-${t}-BADPRE`);
        const badPre = await g.inspection(s['badPre'], 'PRE_USE', '40 minutes', 'FAIL', 'REPAIR');
        await g.inspection(s['badPre'], 'PRE_USE', '30 minutes');
        s['badPreIssue'] = await g.issue(s['badPre'], B, press, badPre, '25 minutes');
        s['retiredIssue'] = await g.issue(s['retired'], B, press, await g.inspection(s['retired'], 'PRE_USE', '3 hours'), '170 minutes');
      });

      const fit = (id: string) => value<string | null>(c, 'select tab.tooling_fit_problem($1) as r', [id]);
      const issue = (id: string, product = 'P1') => value<string | null>(c, 'select tab.tooling_issue_problem($1, $2) as r', [id, product]);
      const use = (id: string) => value<string | null>(c, 'select tab.tooling_use_problem($1) as r', [id]);
      const cumulative = (id: string) => value<string>(c, 'select tab.tooling_cumulative($1)::text as r', [id]);

      expect(await cumulative(s['live'] ?? '')).toBe('60');
      expect(await cumulative(s['again'] ?? '')).toBe('99');
      expect(await cumulative(s['clean'] ?? '')).toBe('0');

      expect(await fit(randomUUID())).toBe('the tooling set does not exist');
      expect(await fit(s['clean'] ?? '')).toBeNull();
      expect(await fit(s['retired'] ?? '')).toBe(`set T-${t}-RETIRED is retired`);
      expect(await fit(s['recovered'] ?? '')).toBeNull();
      expect(await fit(s['failedPre'] ?? '')).toBe(`the latest inspection of set T-${t}-FAILEDPRE failed (REPAIR)`);
      expect(await fit(s['ready'] ?? '')).toBeNull();

      expect(await issue(randomUUID())).toBe('the tooling set does not exist');
      expect(await issue(s['other'] ?? '')).toBe(`set T-${t}-OTHER is assigned to product P2, not to P1 (PR-27)`);
      expect(await issue(s['other'] ?? '', 'P2')).toBeNull();
      expect(await issue(s['retired'] ?? '')).toBe(`set T-${t}-RETIRED is retired`);
      expect(await issue(s['ready'] ?? '')).toBeNull();
      expect(await issue(s['recovered'] ?? '')).toBeNull();
      expect(await issue(s['clean'] ?? '')).toBe(`set T-${t}-CLEAN has no inspection before this use (IN-36 (b))`);
      expect(await issue(s['open'] ?? '')).toBe(`set T-${t}-OPEN is issued to another use and not returned`);
      expect(await issue(s['unchecked'] ?? '')).toBe(`set T-${t}-UNCHECKED has no inspection after its last return (IN-36 (b))`);
      expect(await issue(s['post'] ?? '')).toBe(`set T-${t}-POST has no inspection before this use (IN-36 (b))`);
      expect(await issue(s['again'] ?? '')).toBeNull();
      expect(await issue(s['early'] ?? '')).toBe(`set T-${t}-EARLY has no inspection before this use (IN-36 (b))`);
      expect(await issue(s['failedPre'] ?? '')).toBe(`the pre-use inspection of set T-${t}-FAILEDPRE failed`);
      expect(await issue(s['used'] ?? '')).toBe(`the pre-use inspection of set T-${t}-USED was used for an earlier issue`);
      expect(await issue(s['limit'] ?? '')).toBe(`set T-${t}-LIMIT has 100 strokes, at or past its limit of 100 (INV-24)`);

      expect(await use(randomUUID())).toBe('the tooling issue does not exist');
      expect(await use(s['uncheckedIssue'] ?? '')).toBe(`set T-${t}-UNCHECKED was returned`);
      expect(await use(s['openIssue'] ?? '')).toBeNull();
      expect(await use(s['liveIssue'] ?? '')).toBe(`set T-${t}-LIVE has 100 strokes with this use, at or past its limit of 100 (INV-24)`);
      expect(await use(s['nearIssue'] ?? '')).toBeNull();
      expect(await use(s['badPreIssue'] ?? '')).toBe(`set T-${t}-BADPRE has no passing inspection before this use`);
      expect(await use(s['retiredIssue'] ?? '')).toBe(`set T-${t}-RETIRED is retired`);
    });
  });
});

describe('the tooling register commands (tablets 0871)', () => {
  it('[INV-24][PR-27] a set is defined by the master-data steward with whole-number counts and limit; a set is looked up by its code, locked or not', async () => {
    await inCommand(gmp, 'steward', async (c) => {
      const t = tag();
      const def = { code: `D-${t}`, product: 'P1', type: 'B', shape: 'ROUND', upperEmbossing: 'A', lowerEmbossing: 'B', score: 'NONE', tips: '1', upperPunches: '27', lowerPunches: '27', dies: '27', strokeLimit: '1000' };
      await replica(c, async () => {
        await c.query("insert into plant.product (code, name, highly_potent, recorded_by) values ('P1', 'P1', false, gen_random_uuid()) on conflict do nothing");
      });
      expect(await code(c, 'select tab.define_tooling_set($1) as r', [JSON.stringify([def])])).toBe('EBMR-TOOL-001');
      expect(await code(c, 'select tab.define_tooling_set($1) as r', [JSON.stringify({ ...def, tips: 'x' })])).toBe('EBMR-TOOL-001');
      expect(await code(c, 'select tab.define_tooling_set($1) as r', [JSON.stringify({ ...def, strokeLimit: '-5' })])).toBe('EBMR-TOOL-001');
      const id = await value<string>(c, 'select tab.define_tooling_set($1)::text as r', [JSON.stringify(def)]);
      await value(c, 'select tab.define_tooling_set($1)::text as r', [JSON.stringify({ ...def, code: `D-${t}-2` })]);
      expect(await value(c, 'select (tab.tooling_set_by_code($1, true)).id::text as r', [`D-${t}`])).toBe(id);
      expect(await value(c, 'select (tab.tooling_set_by_code($1, false)).id::text as r', [`D-${t}`])).toBe(id);
      expect(await value(c, 'select (tab.tooling_set_by_code($1, false)).code as r', [`D-${t}-2`])).toBe(`D-${t}-2`);
      expect(await code(c, 'select (tab.tooling_set_by_code($1, true)).id::text as r', [`D-${t}-NONE`])).toBe('EBMR-TOOL-002');
      expect(await code(c, 'select (tab.tooling_set_by_code($1, false)).id::text as r', [`D-${t}-NONE`])).toBe('EBMR-TOOL-002');
    });
  });

  it('[IN-36][INV-24] an inspection: PRE_USE names no issue and only a set not issued; POST_USE names a returned issue of the set, once; every checklist item, a disposition exactly when it failed; a failed after-use inspection holds the press output', async () => {
    await inCommand(gmp, 'operator1', async (c) => {
      const t = tag();
      const g = register(c);
      const fx = holdFixtures(c, gmp.seed.siteCode);
      let B = '';
      let press = '';
      const s: Record<string, string> = {};
      await replica(c, async () => {
        B = await fx.batch();
        press = await pressOf(c, `PR-I-${t}`);
        s['fresh'] = await g.set(`I-${t}-FRESH`);
        s['open'] = await g.set(`I-${t}-OPEN`);
        s['openIssue'] = await g.issue(s['open'], B, press, await g.inspection(s['open'], 'PRE_USE', '3 hours'), '170 minutes');
        s['back'] = await g.set(`I-${t}-BACK`);
        s['backIssue'] = await g.issue(s['back'], B, press, await g.inspection(s['back'], 'PRE_USE', '3 hours'), '170 minutes');
        await g.returned(s['backIssue'], s['back'], 10, '2 hours');
        s['back2'] = await g.set(`I-${t}-BACK2`);
        s['back2Issue'] = await g.issue(s['back2'], B, press, await g.inspection(s['back2'], 'PRE_USE', '3 hours'), '170 minutes');
        await g.returned(s['back2Issue'], s['back2'], 10, '2 hours');
        s['done'] = await g.set(`I-${t}-DONE`);
        s['doneIssue'] = await g.issue(s['done'], B, press, await g.inspection(s['done'], 'PRE_USE', '3 hours'), '170 minutes');
        await g.returned(s['doneIssue'], s['done'], 10, '2 hours');
        await g.inspection(s['done'], 'POST_USE', '110 minutes', 'PASS', null, s['doneIssue']);
        await fx.check(B, `PR-I-${t}`, null, 'PASS', '1 second');
      });
      const inspect = (set: string, kind: string, issue: string | null, f: unknown, disposition: string | null) =>
        attempt<{ inspectionId: string; result: string; hold: Json | null }>(c, 'select tab.inspect_tooling($1, $2, $3, $4, $5) as r', [set, kind, issue, JSON.stringify(f), disposition]);
      const codeOf = (o: Awaited<ReturnType<typeof inspect>>) => (o.ok ? 'ok' : (/EBMR-[A-Z]+-\d{3}/.exec(o.message)?.[0] ?? o.message));

      expect(codeOf(await inspect(`I-${t}-FRESH`, 'LATER', null, findings(), null))).toBe('EBMR-TOOL-010');
      expect(codeOf(await inspect(`I-${t}-FRESH`, 'PRE_USE', s['backIssue'] ?? '', findings(), null))).toBe('EBMR-TOOL-010');
      expect(codeOf(await inspect(`I-${t}-OPEN`, 'PRE_USE', null, findings(), null))).toBe('EBMR-TOOL-011');
      expect(codeOf(await inspect(`I-${t}-FRESH`, 'POST_USE', s['backIssue'] ?? '', findings(), null))).toBe('EBMR-TOOL-010');
      expect(codeOf(await inspect(`I-${t}-FRESH`, 'POST_USE', null, findings(), null))).toBe('EBMR-TOOL-010');
      expect(codeOf(await inspect(`I-${t}-OPEN`, 'POST_USE', s['openIssue'] ?? '', findings(), null))).toBe('EBMR-TOOL-011');
      expect(codeOf(await inspect(`I-${t}-DONE`, 'POST_USE', s['doneIssue'] ?? '', findings(), null))).toBe('EBMR-TOOL-011');
      // The checklist: an object, every item and no other, each true or false.
      expect(codeOf(await inspect(`I-${t}-FRESH`, 'PRE_USE', null, [findings()], null))).toBe('EBMR-TOOL-012');
      expect(codeOf(await inspect(`I-${t}-FRESH`, 'PRE_USE', null, { ...findings(), EXTRA: true }, null))).toBe('EBMR-TOOL-012');
      expect(codeOf(await inspect(`I-${t}-FRESH`, 'PRE_USE', null, { ...findings(), WEAR: undefined }, null))).toBe('EBMR-TOOL-012');
      expect(codeOf(await inspect(`I-${t}-FRESH`, 'PRE_USE', null, { ...findings(), WEAR: 'yes' }, null))).toBe('EBMR-TOOL-012');
      expect(codeOf(await inspect(`I-${t}-FRESH`, 'PRE_USE', null, findings('WEAR'), null))).toBe('EBMR-TOOL-013');
      expect(codeOf(await inspect(`I-${t}-FRESH`, 'PRE_USE', null, findings(), 'POLISH'))).toBe('EBMR-TOOL-013');
      // A failed pre-use inspection holds nothing; a passing one is PASS.
      const pre = await inspect(`I-${t}-FRESH`, 'PRE_USE', null, findings('TIPS'), 'POLISH');
      expect(pre.ok && pre.r.result).toBe('FAIL');
      expect(pre.ok && pre.r.hold).toBeNull();
      const pass = await inspect(`I-${t}-FRESH`, 'PRE_USE', null, findings(), null);
      expect(pass.ok && pass.r.result).toBe('PASS');
      expect(codeOf(await inspect(`I-${t}-BACK`, 'PRE_USE', null, findings(), null))).toBe('ok');
      // After return: a passing inspection holds nothing; a failed one holds the press output since the issue.
      const post = await inspect(`I-${t}-BACK`, 'POST_USE', s['backIssue'] ?? '', findings(), null);
      expect(post.ok && post.r).toMatchObject({ result: 'PASS', hold: null });
      const failed = await inspect(`I-${t}-BACK2`, 'POST_USE', s['back2Issue'] ?? '', findings('EDGES'), 'RETIRE');
      expect(failed.ok && failed.r.result).toBe('FAIL');
      expect(failed.ok && failed.r.hold).toMatchObject({ ipcCheckId: expect.any(String) as unknown });
      const rows = (await c.query<{ k: string; r: string; d: string | null; i: string | null }>('select kind as k, result as r, disposition as d, issue_id::text as i from tab.tooling_inspection where set_id = $1 order by inspected_at', [s['back2']])).rows;
      expect(rows.at(-1)).toEqual({ k: 'POST_USE', r: 'FAIL', d: 'RETIRE', i: s['back2Issue'] });
    });
  });

  it('[INV-24][IN-36][PR-27][PR-22] an issue: a press of the plant, a set the rules let issue, counts of at least one and at most the set holds; it records the set\'s latest (passing pre-use) inspection', async () => {
    await inCommand(gmp, 'operator1', async (c) => {
      const t = tag();
      const g = register(c);
      const fx = holdFixtures(c, gmp.seed.siteCode);
      let B = '';
      const s: Record<string, string> = {};
      await replica(c, async () => {
        B = await fx.batch();
        await pressOf(c, `PR-S-${t}`);
        await c.query("insert into plant.equipment (code, name, class_code, kind, recorded_by) values ($1, 'Balance', 'X', 'INSTRUMENT', gen_random_uuid())", [`BAL-S-${t}`]);
        s['a'] = await g.set(`S-${t}-A`);
        s['aPre'] = await g.inspection(s['a'], 'PRE_USE', '3 hours');
        s['b'] = await g.set(`S-${t}-B`);
        s['bPre'] = await g.inspection(s['b'], 'PRE_USE', '2 hours');
        s['c'] = await g.set(`S-${t}-C`);
        // Another set's inspection, the latest of all.
        await g.inspection(s['c'], 'PRE_USE', '1 minute');
        s['n'] = await g.set(`S-${t}-NONE`);
      });
      const issue = (set: string, counts: unknown, press = `PR-S-${t}`) => attempt<Json>(c, 'select tab.issue_tooling($1, $2, $3, $4) as r', [set, B, press, JSON.stringify(counts)]);
      const codeOf = (o: Awaited<ReturnType<typeof issue>>) => (o.ok ? 'ok' : (/EBMR-[A-Z]+-\d{3}/.exec(o.message)?.[0] ?? o.message));
      const full = { upper: '27', lower: '26', dies: '25' };
      expect(codeOf(await issue(`S-${t}-A`, full, `PR-S-${t}-NONE`))).toBe('EBMR-TOOL-021');
      expect(codeOf(await issue(`S-${t}-A`, full, `BAL-S-${t}`))).toBe('EBMR-TOOL-021');
      expect(codeOf(await issue(`S-${t}-NONE`, full))).toBe('EBMR-TOOL-020');
      // A count that is no number is refused (by the integer cast: PostgreSQL does not short-circuit the OR).
      expect((await issue(`S-${t}-A`, { ...full, upper: 'x' })).ok).toBe(false);
      for (const bad of [[full], { ...full, lower: '0' }, { ...full, dies: undefined }, { ...full, upper: '28' }, { ...full, lower: '27' }, { ...full, dies: '26' }]) {
        expect(codeOf(await issue(`S-${t}-A`, bad)), JSON.stringify(bad)).toBe('EBMR-TOOL-022');
      }
      const a = await issue(`S-${t}-A`, full);
      expect(a.ok && a.r).toMatchObject({ set: `S-${t}-A`, press: `PR-S-${t}`, preUseInspectionId: s['aPre'] });
      const b = await issue(`S-${t}-B`, { upper: '1', lower: '1', dies: '1' });
      expect(b.ok && b.r).toMatchObject({ preUseInspectionId: s['bPre'] });
      const row = (await c.query<{ u: number; l: number; d: number }>('select upper_issued as u, lower_issued as l, dies_issued as d from tab.tooling_issue where set_id = $1', [s['b']])).rows;
      expect(row).toEqual([{ u: 1, l: 1, d: 1 }]);
    });
  });

  it('[INV-24][IN-36][DI-31] a return: once, counts as whole numbers; strokes from the press counter when it saw the whole use (a keyed count then refused), else keyed and never below what it saw; a count mismatch or strokes past the limit hold the output (since the crossing when the counter knows it); at the limit exactly nothing is exceeded', async () => {
    await inCommand(gmp, 'operator1', async (c) => {
      const t = tag();
      const g = register(c);
      const fx = holdFixtures(c, gmp.seed.siteCode);
      let B = '';
      const s: Record<string, string> = {};
      const presses: Record<string, string> = {};
      await replica(c, async () => {
        B = await fx.batch();
        // A press with a counter for each use, so each use's strokes are its own.
        const use = async (key: string, limit: number, prior: number, readings: [string, string][], baselined: boolean, issuedAgo = '50 minutes'): Promise<void> => {
          const code = `PR-R-${t}-${key}`.toUpperCase();
          const pressId = await pressOf(c, code);
          presses[key] = code;
          const k = await counter(c, pressId);
          s[key] = await g.set(`R-${t}-${key}`.toUpperCase(), limit);
          if (prior > 0) {
            const earlier = await g.issue(s[key], B, pressId, await g.inspection(s[key], 'PRE_USE', '5 hours'), '290 minutes');
            await g.returned(earlier, s[key], prior, '4 hours');
          }
          const base = baselined ? await k.reading('1000', '55 minutes') : null;
          const ids: string[] = [];
          for (const [v, ago] of readings) ids.push(await k.reading(v, ago));
          s[`${key}Issue`] = await g.issue(s[key], B, pressId, await g.inspection(s[key], 'PRE_USE', '58 minutes'), issuedAgo, base);
          await fx.check(B, code, null, 'PASS', '1 second');
        };
        await use('counted', 1000, 0, [['1100', '5 seconds']], true);
        await use('stale', 1000, 0, [['1100', '2 minutes']], true);
        await use('keyed', 1000, 0, [['500', '40 minutes'], ['530', '30 minutes']], false);
        await use('equal', 1000, 0, [['500', '40 minutes'], ['530', '30 minutes']], false);
        await use('upper', 1000, 0, [], false);
        await use('lower', 1000, 0, [], false);
        await use('dies', 1000, 0, [], false);
        await use('atLimit', 100, 60, [['1040', '5 seconds']], true);
        await use('past', 100, 60, [['1030', '40 minutes'], ['1050', '20 minutes'], ['1060', '5 seconds']], true);
        // No baseline: the counter saw 50 strokes after the issue (crossing the 40 left 20 minutes ago), keyed 50.
        await use('pastKeyed', 100, 60, [['1000', '45 minutes'], ['1050', '20 minutes']], false);
        // Output of the 'past' and 'pastKeyed' presses: a container closed before the crossing (35 minutes ago) and
        // one open since before the issue.
        for (const key of ['past', 'pastKeyed']) {
          await fx.container(B, presses[key] ?? '', '50 minutes', '30 minutes');
          await fx.container(B, presses[key] ?? '', '50 minutes', null);
        }
      });
      const ret = (key: string, counts: unknown, manual: string | null = null) =>
        attempt<Json & { hold: Json | null }>(c, 'select tab.return_tooling($1, $2, $3) as r', [s[`${key}Issue`] ?? key, JSON.stringify(counts), manual]);
      const codeOf = (o: Awaited<ReturnType<typeof ret>>) => (o.ok ? 'ok' : (/EBMR-[A-Z]+-\d{3}/.exec(o.message)?.[0] ?? o.message));
      const full = { upper: '27', lower: '26', dies: '25' };

      expect(codeOf(await ret(randomUUID(), full))).toBe('EBMR-TOOL-030');
      expect(codeOf(await ret('counted', [full]))).toBe('EBMR-TOOL-031');
      expect(codeOf(await ret('counted', { ...full, dies: '2.5' }))).toBe('EBMR-TOOL-031');
      expect(codeOf(await ret('counted', full, '100'))).toBe('EBMR-TOOL-032');
      const counted = await ret('counted', full);
      expect(counted.ok && counted.r).toMatchObject({ strokes: '100', strokeSource: 'PRESS_COUNTER', cumulative: '100', limitExceeded: false, countMismatch: false, hold: null });
      expect(codeOf(await ret('counted', full))).toBe('EBMR-TOOL-030');
      // The counter's last reading is older than 60 s: keyed.
      expect(codeOf(await ret('stale', full))).toBe('EBMR-TOOL-032');
      const stale = await ret('stale', full, '120');
      expect(stale.ok && stale.r).toMatchObject({ strokes: '120', strokeSource: 'MANUAL' });
      // No baseline: the counter saw 30 strokes at least (its first reading only a start); keyed never below them.
      expect(codeOf(await ret('keyed', full))).toBe('EBMR-TOOL-032');
      expect(codeOf(await ret('keyed', full, 'many'))).toBe('EBMR-TOOL-032');
      expect(codeOf(await ret('keyed', full, '29'))).toBe('EBMR-TOOL-033');
      const equal = await ret('equal', full, '30');
      expect(equal.ok && equal.r).toMatchObject({ strokes: '30', strokeSource: 'MANUAL', countMismatch: false, hold: null });
      expect((await c.query<{ n: number }>('select counter_readings as n from tab.tooling_return where issue_id = $1', [s['equalIssue']])).rows[0]?.n).toBe(2);
      // A difference in any count: recorded and held.
      for (const [key, counts] of [['upper', { ...full, upper: '26' }], ['lower', { ...full, lower: '25' }], ['dies', { ...full, dies: '24' }]] as const) {
        const r = await ret(key, counts, '0');
        expect(r.ok && r.r, key).toMatchObject({ countMismatch: true, limitExceeded: false, hold: { ipcCheckId: expect.any(String) as unknown } });
      }
      // At the limit exactly (60 + 40): not exceeded, nothing held.
      const at = await ret('atLimit', full);
      expect(at.ok && at.r).toMatchObject({ strokes: '40', cumulative: '100', limitExceeded: false, hold: null });
      expect((await c.query<{ x: boolean }>('select limit_exceeded as x from tab.tooling_return where issue_id = $1', [s['atLimitIssue']])).rows[0]?.x).toBe(false);
      // Past it (60 + 60, crossing at the reading 20 minutes ago): held since the crossing, so the container closed 30
      // minutes ago is not; keyed past it: held since the issue (a keyed count is not the counter's), so it is.
      const past = await ret('past', full);
      expect(past.ok && past.r).toMatchObject({ strokes: '60', cumulative: '120', limitExceeded: true, countMismatch: false });
      const pastHeld = past.ok ? ((past.r.hold as { held: string[]; pending: string[] }) ?? { held: [], pending: [] }) : { held: [], pending: [] };
      expect([...pastHeld.held, ...pastHeld.pending]).toHaveLength(1);
      expect((await c.query<{ x: boolean }>('select limit_exceeded as x from tab.tooling_return where issue_id = $1', [s['pastIssue']])).rows[0]?.x).toBe(true);
      const keyed = await ret('pastKeyed', full, '50');
      expect(keyed.ok && keyed.r).toMatchObject({ strokeSource: 'MANUAL', cumulative: '110', limitExceeded: true });
      const keyedHeld = keyed.ok ? ((keyed.r.hold as { held: string[]; pending: string[] }) ?? { held: [], pending: [] }) : { held: [], pending: [] };
      expect([...keyedHeld.held, ...keyedHeld.pending]).toHaveLength(2);
    });
  });
});

describe('the detector challenges (tablets 0872, 1040)', () => {
  it('[IN-36][IN-35][PR-22] a test piece and a detector are defined with their shape; a challenge: a press in use by the batch, the device and each piece once with detected and rejected, a registered certified piece of the device\'s kind; failed when any piece was missed, holding the output since the device\'s last pass', async () => {
    await inCommand(gmp, 'steward', async (c) => {
      const t = tag();
      expect(await code(c, 'select tab.define_test_piece($1)::text as r', [JSON.stringify([{}])])).toBe('EBMR-DET-001');
      expect(await code(c, 'select tab.define_test_piece($1)::text as r', [JSON.stringify({ code: `TP-${t}`, kind: 'FERROUS', size: '1.0', certificateRef: 'C', certifiedUntil: '2099-01-01T00:00:00Z' })])).toBe('EBMR-DET-001');
      const id = await value<string>(c, 'select tab.define_test_piece($1)::text as r', [JSON.stringify({ code: `TP-${t}`, kind: 'FERROUS', size: { value: '1.0', unit: 'mm' }, certificateRef: 'C', certifiedUntil: '2099-01-01T00:00:00Z' })]);
      expect(await value(c, 'select kind as r from tab.test_piece where id = $1', [id])).toBe('FERROUS');
      await replica(c, async () => {
        await c.query("insert into plant.equipment_class (code, kind, description, calibration_required, recorded_by) values ($1, 'UTILITY', 'Detectors', false, gen_random_uuid())", [`DC-${t}`]);
      });
      const detector = (device: string | undefined) => JSON.stringify({ code: `MD-${t}`, name: 'Detector', classCode: `DC-${t}`, device });
      expect(await code(c, 'select tab.define_detector($1)::text as r', [detector('X_RAY')])).toBe('EBMR-TAB-1040');
      expect(await code(c, 'select tab.define_detector($1)::text as r', [detector(undefined)])).toBe('EBMR-TAB-1040');
      const md = await value<string>(c, 'select tab.define_detector($1)::text as r', [detector('METAL_DETECTOR')]);
      expect(await value(c, 'select device as r from tab.detector_unit where equipment_id = $1', [md])).toBe('METAL_DETECTOR');
    });
    await inCommand(gmp, 'operator1', async (c) => {
      const t = tag();
      const fx = holdFixtures(c, gmp.seed.siteCode);
      let B = '';
      let B2 = '';
      const press = `PR-D-${t}`;
      const idle = `PR-D-${t}-IDLE`;
      await replica(c, async () => {
        B = await fx.batch();
        B2 = await fx.batch();
        for (const p of [press, idle]) await pressOf(c, p);
        await c.query(
          `insert into plant.equipment_use (equipment_id, batch_id, batch_ref, product_code, planned_end, cleaning_id, started_by)
           select id, $2, 'B', 'P1', clock_timestamp() + interval '1 day', gen_random_uuid(), gen_random_uuid() from plant.equipment where code = $1`,
          [press, B],
        );
        // A use of the idle press by the batch that ended; a use of the press by another batch.
        const ended = (await c.query<{ id: string }>(
          `insert into plant.equipment_use (equipment_id, batch_id, batch_ref, product_code, planned_end, cleaning_id, started_by)
           select id, $2, 'B', 'P1', clock_timestamp() + interval '1 day', gen_random_uuid(), gen_random_uuid() from plant.equipment where code = $1 returning id::text`,
          [idle, B],
        )).rows[0]?.id;
        await c.query(
          `insert into plant.equipment_use_end (use_id, equipment_id, started_at, ended_by, clean_hold_crossed, calibration_crossed, campaign_crossed, overran_plan)
           select id, equipment_id, started_at, gen_random_uuid(), false, false, false, false from plant.equipment_use where id = $1`,
          [ended],
        );
        for (const [code, kind, until] of [
          [`F-${t}`, 'FERROUS', '2099-01-01'],
          [`S-${t}`, 'STAINLESS', '2099-01-01'],
          [`R-${t}`, 'REJECT_SAMPLE', '2099-01-01'],
          [`X-${t}`, 'FERROUS', '2000-01-01'],
        ]) {
          await c.query(
            "insert into tab.test_piece (code, kind, size_value, size_unit, certificate_ref, certified_until, person_id, account_id) values ($1, $2, '1.0', 'mm', 'C', $3::timestamptz, gen_random_uuid(), gen_random_uuid())",
            [code, kind, until],
          );
        }
        // Earlier challenges of this press: a passing one 40 minutes ago, a later failed one, a passing one of the other
        // device and one of another batch (neither moves the window).
        const ch = async (batch: string, device: string, passed: boolean, ago: string) =>
          c.query(
            `insert into tab.detector_challenge (batch_id, press_equipment_id, device, device_code, timing, pieces, passed, person_id, account_id, recorded_at)
             select $1, id, $2, 'MD-1', 'START', '[{}]', $3, gen_random_uuid(), gen_random_uuid(), clock_timestamp() - $4::interval from plant.equipment where code = $5`,
            [batch, device, passed, ago, press],
          );
        await ch(B, 'METAL_DETECTOR', true, '40 minutes');
        await ch(B, 'METAL_DETECTOR', false, '30 minutes');
        await ch(B, 'REJECT_GATE', true, '20 minutes');
        await ch(B2, 'METAL_DETECTOR', true, '20 minutes');
        // Output: closed before the last pass (not held), closed after it (held), open (held).
        await fx.container(B, press, '2 hours', '50 minutes');
        await fx.container(B, press, '2 hours', '35 minutes');
        await fx.container(B, press, '2 hours', null);
        await fx.check(B, press, null, 'PASS', '1 second');
      });
      const challenge = (device: string, pieces: unknown, p = press, batch = B) =>
        attempt<{ challengeId: string; passed: boolean; hold: { held: string[]; pending: string[] } | null }>(c, 'select tab.record_detector_challenge($1, $2, $3, $4, $5, $6) as r', [batch, p, device, 'MD-1', 'INTERVAL', JSON.stringify(pieces)]);
      const codeOf = (o: Awaited<ReturnType<typeof challenge>>) => (o.ok ? 'ok' : (/EBMR-[A-Z]+-\d{3}/.exec(o.message)?.[0] ?? o.message));
      const piece = (p: string, detected = true, rejected = true) => ({ piece: p, detected, rejected });

      expect(codeOf(await challenge('METAL_DETECTOR', [piece(`F-${t}`)], `PR-D-${t}-NONE`))).toBe('EBMR-DET-011');
      expect(codeOf(await challenge('METAL_DETECTOR', [piece(`F-${t}`)], idle))).toBe('EBMR-DET-011');
      expect(codeOf(await challenge('METAL_DETECTOR', [piece(`F-${t}`)], press, B2))).toBe('EBMR-DET-011');
      for (const bad of [
        ['X_RAY', [piece(`F-${t}`)]],
        ['METAL_DETECTOR', piece(`F-${t}`)],
        ['METAL_DETECTOR', []],
        ['METAL_DETECTOR', ['F']],
        ['METAL_DETECTOR', [{ piece: 1, detected: true, rejected: true }]],
        ['METAL_DETECTOR', [{ piece: `F-${t}`, detected: 'yes', rejected: true }]],
        ['METAL_DETECTOR', [{ piece: `F-${t}`, detected: true }]],
        ['METAL_DETECTOR', [piece(`F-${t}`), piece(`F-${t}`)]],
        ['METAL_DETECTOR', [piece(`N-${t}`)]],
        ['METAL_DETECTOR', [piece(`X-${t}`)]],
        ['METAL_DETECTOR', [piece(`F-${t}`), piece(`R-${t}`)]],
        ['REJECT_GATE', [piece(`F-${t}`)]],
      ] as const) {
        expect(codeOf(await challenge(bad[0], bad[1])), JSON.stringify(bad)).toBe('EBMR-DET-010');
      }
      const gate = await challenge('REJECT_GATE', [piece(`R-${t}`)]);
      expect(gate.ok && gate.r).toMatchObject({ passed: true, hold: null });
      const ok = await challenge('METAL_DETECTOR', [piece(`F-${t}`), piece(`S-${t}`)]);
      expect(ok.ok && ok.r).toMatchObject({ passed: true, hold: null });
      const stored = (await c.query<{ p: Json[] }>('select pieces as p from tab.detector_challenge where id = $1', [ok.ok ? ok.r.challengeId : null])).rows[0]?.p;
      expect(stored?.map((x) => x['piece'])).toEqual([`F-${t}`, `S-${t}`]);
    });
  });

  it('[IN-36][IN-35] a failed challenge (a piece not detected, or detected and not rejected) holds the output of the batch and press since that device\'s last passing challenge', async () => {
    for (const [detected, rejected] of [[false, true], [true, false]] as const) {
      await inCommand(gmp, 'operator1', async (c) => {
        const t = tag();
        const fx = holdFixtures(c, gmp.seed.siteCode);
        const press = `PR-E-${t}`;
        let B = '';
        let B2 = '';
        const labels: Record<string, string> = {};
        await replica(c, async () => {
          B = await fx.batch();
          B2 = await fx.batch();
          await pressOf(c, press);
          await c.query(
            `insert into plant.equipment_use (equipment_id, batch_id, batch_ref, product_code, planned_end, cleaning_id, started_by)
             select id, $2, 'B', 'P1', clock_timestamp() + interval '1 day', gen_random_uuid(), gen_random_uuid() from plant.equipment where code = $1`,
            [press, B],
          );
          await c.query(
            "insert into tab.test_piece (code, kind, size_value, size_unit, certificate_ref, certified_until, person_id, account_id) values ($1, 'FERROUS', '1.0', 'mm', 'C', clock_timestamp() + interval '1 day', gen_random_uuid(), gen_random_uuid())",
            [`F-${t}`],
          );
          const ch = async (batch: string, device: string, passed: boolean, ago: string) =>
            c.query(
              `insert into tab.detector_challenge (batch_id, press_equipment_id, device, device_code, timing, pieces, passed, person_id, account_id, recorded_at)
               select $1, id, $2, 'MD-1', 'START', '[{}]', $3, gen_random_uuid(), gen_random_uuid(), clock_timestamp() - $4::interval from plant.equipment where code = $5`,
              [batch, device, passed, ago, press],
            );
          await ch(B, 'METAL_DETECTOR', true, '40 minutes');
          await ch(B, 'METAL_DETECTOR', false, '30 minutes');
          await ch(B, 'REJECT_GATE', true, '20 minutes');
          await ch(B2, 'METAL_DETECTOR', true, '20 minutes');
          const label = async (id: string) => (await c.query<{ l: string }>('select label_code as l from plant.output_container where id = $1', [id])).rows[0]?.l ?? '';
          labels['before'] = await label(await fx.container(B, press, '2 hours', '45 minutes'));
          labels['after'] = await label(await fx.container(B, press, '2 hours', '25 minutes'));
          labels['open'] = await label(await fx.container(B, press, '2 hours', null));
          await fx.check(B, press, null, 'PASS', '1 second');
        });
        const r = await attempt<{ passed: boolean; hold: { held: string[]; pending: string[] } | null }>(c, 'select tab.record_detector_challenge($1, $2, $3, $4, $5, $6) as r', [
          B, press, 'METAL_DETECTOR', 'MD-1', 'INTERVAL', JSON.stringify([{ piece: `F-${t}`, detected, rejected }]),
        ]);
        expect(r.ok && r.r.passed).toBe(false);
        const hold = r.ok ? r.r.hold : null;
        expect([...(hold?.held ?? []), ...(hold?.pending ?? [])].sort()).toEqual([labels['after'], labels['open']].sort());
        const stored = (await c.query<{ passed: boolean }>('select passed from tab.detector_challenge where batch_id = $1 order by recorded_at desc limit 1', [B])).rows[0]?.passed;
        expect(stored).toBe(false);
      });
    }
  });
});
