/**
 * Phase 6A slice 6A-3's lead items in the kernel (kernel 1270, 1271; ADR 0020; draft control DI-52; D-6A-3-8, D-6A-3-9):
 *   - a flag raised again by later runs is listed once in analytics.open_flag_v1 while it is open; a hit that differs
 *     in anything is listed on its own; a disposition on any raise covers its repeats; every raise stays recorded
 *     (analytics.flag_v1, the audit trail); the monitor counts repeats with their signal's disposition;
 *   - a reference set carries its model candidate's own model and batches, not only its hash (EBMR-ANA-030).
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { ensureFixtureChangeRecord, underChange } from '../support/change-record.ts';
import { createTestDatabase, urlFor, type TestDatabase } from '../support/db.ts';
import { seedActor, type SeededActor } from '../identity/seed.ts';

const ANALYTICS_LOGIN = { name: 'ebmr_analytics', password: 'ebmr_analytics' };
const INPUT = 'report.batch_outcome_v1';
const SHA = 'a'.repeat(64);
const RUNTIME = { package: '@ebmr/analytics 0.1.0', commit: '0a1b2c3', node: '22.20.0', libraries: {} };
const RELEASE = `jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(), 'legal_name', 'Test fixture (analytics repeats)',
  'reason_code', 'SOFTWARE_RELEASE', 'reason_text', 'test fixture')`;

let gmp: TestDatabase;
let qa: SeededActor;
let analytics: pg.Client;

const again = <T extends ActorContext>(ctx: T): T => ({ ...ctx, correlationId: randomUUID() });
const q = async <T extends pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> => (await analytics.query<T>(text, params)).rows;

/** One DONE run of SPC.IMR raising the given flags (subject, reasons) about PRODUCT_ITEM subjects; returns the flag ids. */
async function run(flags: { ref: string; text: string; batches: string[] }[], method = 'SPC.IMR'): Promise<string[]> {
  const input = [{ view: INPUT, version: 1, filter: null, data_as_of: '2026-10-12T04:40:00Z', rows: 3, sha256: SHA }];
  const [r] = await q<{ id: string }>("select analytics.begin_run($1, 1, null, 'SCHEDULED', $2::jsonb, $3::jsonb) as id", [method, JSON.stringify(input), JSON.stringify(RUNTIME)]);
  const ids: string[] = [];
  for (const f of flags) {
    const reasons = [{ code: 'NELSON_2', text: f.text, evidence: f.batches.map((b) => ({ kind: 'BATCH', ref: b })) }];
    const [row] = await q<{ id: string }>("select analytics.record_flag($1, null, 'PRODUCT_ITEM', $2, 'NELSON_2', 'ATTENTION', $3::jsonb) as id", [r!.id, f.ref, JSON.stringify(reasons)]);
    ids.push(row!.id);
  }
  await q('select analytics.finish_run($1, $2, $3)', [r!.id, SHA, JSON.stringify({ flags: flags.length })]);
  return ids;
}

const open = async (ref: string) =>
  (await gmp.app.query<{ flag_id: string; raised_count: number; first_raised_at: Date; raised_at: Date; reasons: { text: string }[] }>(
    'select flag_id::text, raised_count, first_raised_at, raised_at, reasons from analytics.open_flag_v1 where subject_ref = $1 order by raised_at, flag_id', [ref])).rows;

beforeAll(async () => {
  gmp = await createTestDatabase();
  await ensureFixtureChangeRecord(gmp);
  const c = await gmp.admin.connect();
  try {
    await c.query('begin');
    await c.query(`select kernel.set_actor_context(${RELEASE})`);
    await c.query(`insert into iam.role_permission (role_code, permission_code) values ('QA_REVIEWER', 'ANALYTICS.VIEW'), ('QA_REVIEWER', 'ANALYTICS.DISPOSITION'), ('QA_REVIEWER', 'ANALYTICS.METHOD')
                    on conflict do nothing`);
    await c.query(`select analytics.register_input('VIEW', '${INPUT}', 1, '6A-1', 'GMP batch', 'test input: the batch outcomes')
                    where not exists (select 1 from analytics.input_registry where name = '${INPUT}')`);
    await c.query('select kernel.set_actor_context(null)');
    await c.query('commit');
  } finally {
    c.release();
  }
  qa = await seedActor(gmp, { roleCode: 'QA_REVIEWER' });
  await withCommand(gmp.admin, again(underChange(qa)), (cc) =>
    cc.query(`insert into analytics.method_version (method, version, status, title, intended_use, acceptance, parameters, parameters_sha256, code_identity, validation_ref)
              values ('SPC.IMR', 1, 'EFFECTIVE', 'Test method', 'advisory test', '{}', '{}', $1, '@ebmr/analytics 0.1.0', 'VAL-TEST-1')`, [SHA]));
  analytics = new pg.Client({ connectionString: urlFor(gmp.name, ANALYTICS_LOGIN) });
  await analytics.connect();
}, 300_000);

afterAll(async () => {
  await analytics?.end();
  await gmp?.drop();
});

describe('repeated flags (kernel 1271)', () => {
  it('[DI-52] a flag raised again by later runs is listed once while open, a hit that differs is listed on its own, and a disposition covers its repeats; every raise stays recorded', async () => {
    const subject = `P|F|item-${randomUUID().slice(0, 8)}`;
    const [b1, b2, b3] = [randomUUID(), randomUUID(), randomUUID()];
    const hit = { ref: subject, text: 'nine in a row above the centre: batches 1 to 9', batches: [b1, b2] };
    // Three nightly runs raise the same hit: one open row, the latest raise, raised three times since the first.
    const raised = [...(await run([hit])), ...(await run([hit])), ...(await run([hit]))];
    let rows = await open(subject);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ flag_id: raised[2], raised_count: 3 });
    expect(rows[0]!.first_raised_at.getTime()).toBeLessThan(rows[0]!.raised_at.getTime());
    // A hit that differs in anything (one more batch in the run) is another signal, listed on its own; so is the same
    // hit of another method version's run (not in force here) or another subject.
    const grown = { ...hit, text: 'nine in a row above the centre: batches 1 to 10', batches: [b1, b2, b3] };
    const [g1] = await run([grown]);
    rows = await open(subject);
    expect(rows.map((r) => [r.flag_id, r.raised_count])).toEqual([[raised[2], 3], [g1, 1]]);
    // Every raise stays recorded and readable one by one.
    const { rows: all } = await gmp.app.query<{ n: number }>('select count(*)::int as n from analytics.flag_v1 where subject_ref = $1', [subject]);
    expect(all[0]!.n).toBe(4);
    const { rows: audited } = await gmp.admin.query<{ n: number }>(
      "select count(*)::int as n from kernel.audit_event where table_name = 'analytics.flag' and record_id = any($1::text[])", [[...raised, g1]]);
    expect(audited[0]!.n).toBe(4);
    // QA dispositions the first raise of the first signal (an older id, from a link): the signal closes, and the same
    // hit raised again tonight stays covered by that disposition; the differing signal stays open.
    await withCommand(gmp.app, again(qa), (c) => c.query("select analytics.record_disposition($1, 'FALSE_ALARM', 'probe drift corrected on the granulator', null, null, null)", [raised[0]]));
    await run([hit, grown]);
    rows = await open(subject);
    expect(rows.map((r) => r.reasons[0]!.text)).toEqual([grown.text]);
    expect(rows[0]!.raised_count).toBe(2);
    // The monitor counts each raise with its signal's disposition: the four raises of the first signal are dispositioned.
    const { rows: m } = await gmp.app.query<{ flags: number; dispositioned_share: number; false_alarm_rate: number }>(
      "select sum(flags)::int as flags, max(dispositioned_share) as dispositioned_share, max(false_alarm_rate) as false_alarm_rate from analytics.method_monitor_v1 where method = 'SPC.IMR'");
    expect(m[0]).toEqual({ flags: 6, dispositioned_share: 4 / 6, false_alarm_rate: 1 });
  });
});

describe('a reference set and its candidate (kernel 1270)', () => {
  it('[DI-52] a reference set must carry its model candidate\'s own model and batches, not only its hash (EBMR-ANA-030)', async () => {
    const batches = [randomUUID(), randomUUID()];
    const model = { subjectRef: 'P|F|x', chart: 'IMR', centre: 7.5, sigma: 0.1, batchIds: [...batches].sort() };
    const input = [{ view: INPUT, version: 1, filter: null, data_as_of: '2026-10-12T04:40:00Z', rows: 3, sha256: SHA }];
    const [r] = await q<{ id: string }>("select analytics.begin_run('SPC.IMR', 1, null, 'ON_DEMAND', $1::jsonb, $2::jsonb) as id", [JSON.stringify(input), JSON.stringify(RUNTIME)]);
    const [cand] = await q<{ id: string }>("select analytics.record_output($1, 'PRODUCT_ITEM', 'P|F|x', 'MODEL_CANDIDATE', $2::jsonb, '[]') as id", [
      r!.id, JSON.stringify({ model, modelSha256: SHA, batchIds: batches }),
    ]);
    await q('select analytics.finish_run($1, $2, $3)', [r!.id, SHA, '{}']);
    const set = (over: { model?: unknown; batchIds?: string[] }) => withCommand(gmp.app, again(underChange(qa)), (c) =>
      c.query('select analytics.set_reference_set($1::jsonb)', [JSON.stringify({
        method: 'SPC.IMR', scope: { product: 'P', family: 'F', item: 'x' }, batchIds: over.batchIds ?? batches, candidateOutput: cand!.id,
        model: over.model ?? model, modelSha256: SHA, status: 'EFFECTIVE',
      })]));
    // The candidate's hash with another model, or with other batches, is refused for every writer.
    await expect(set({ model: { ...model, sigma: 0.05 } })).rejects.toThrow(/EBMR-ANA-030/);
    await expect(set({ batchIds: [batches[0]!] })).rejects.toThrow(/EBMR-ANA-030/);
    await expect(set({ batchIds: [batches[0]!, randomUUID()] })).rejects.toThrow(/EBMR-ANA-030/);
    // Its own model and batches (in any order) are accepted, under the approved change record.
    await expect(set({ batchIds: [...batches].reverse() })).resolves.toBeDefined();
    // A candidate whose batch list holds something other than batch ids makes no reference set.
    const [r2] = await q<{ id: string }>("select analytics.begin_run('SPC.IMR', 1, null, 'ON_DEMAND', $1::jsonb, $2::jsonb) as id", [JSON.stringify(input), JSON.stringify(RUNTIME)]);
    const [odd] = await q<{ id: string }>("select analytics.record_output($1, 'PRODUCT_ITEM', 'P|F|x', 'MODEL_CANDIDATE', $2::jsonb, '[]') as id", [
      r2!.id, JSON.stringify({ model, modelSha256: SHA, batchIds: [batches[0], 'B-0002'] }),
    ]);
    await q('select analytics.finish_run($1, $2, $3)', [r2!.id, SHA, '{}']);
    await expect(withCommand(gmp.app, again(underChange(qa)), (c) =>
      c.query('select analytics.set_reference_set($1::jsonb)', [JSON.stringify({
        method: 'SPC.IMR', scope: { product: 'P', family: 'F', item: 'x' }, batchIds: [batches[0]], candidateOutput: odd!.id, model, modelSha256: SHA, status: 'EFFECTIVE',
      })]))).rejects.toThrow(/EBMR-ANA-030/);
  });
});
