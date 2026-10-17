/**
 * Phase 6A exit review (slice 6A-7; kernel 1280 to 1282; ADR 0020; draft controls DI-52, DI-53; review backlog
 * docs/build-plan/phase-6a/review-backlog.md):
 *   - P6A7-1 (kernel 1280): one flag-grouping design. A flag's group is 6A-4's key for the audit-trail methods (method,
 *     rule, subject, first evidence; kernel 1261) and 6A-3's signal for the others (method, version, subject, rule,
 *     severity, reasons; kernel 1271). The group is the unit QA's verdict applies to everywhere: a later raise of a
 *     dispositioned group is shown with that verdict in every list, it takes no fresh first disposition, and a new
 *     verdict supersedes the group's current one with a reason (DI-52); the monitor counts by the same group.
 *   - P6A7-2 (kernel 1281): the review priority's audit-trail term (OPEN_AUDIT_FLAG) is readable only by a person
 *     holding ANALYTICS.DI_REVIEW, in the database's own views, also through the application role directly (DI-53).
 *   - P6A5-2 (kernel 1282): the current verdict of each audit-trail flag key is an input of the analytics role (on its
 *     allow-list, outside the report catalogue), so a QA FALSE_ALARM can lower the review priority's audit-trail term.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { segregationProblems } from '../../src/sandbox/provision.ts';
import { ensureFixtureChangeRecord, underChange } from '../support/change-record.ts';
import { createTestDatabase, urlFor, type TestDatabase } from '../support/db.ts';
import { seedActor, seedAdministration, type SeededActor } from '../identity/seed.ts';

const ANALYTICS_LOGIN = { name: 'ebmr_analytics', password: 'ebmr_analytics' };
const REPORT_LOGIN = { name: 'ebmr_report', password: 'ebmr_report' };
const INPUT = 'report.batch_outcome_v1';
const SHA = 'a'.repeat(64);
const RUNTIME = { package: '@ebmr/analytics 0.1.0', commit: '0a1b2c3', node: '22.20.0', libraries: {} };
const RELEASE = `jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(), 'legal_name', 'Test fixture (analytics exit review)',
  'reason_code', 'SOFTWARE_RELEASE', 'reason_text', 'test fixture')`;

let gmp: TestDatabase;
let qa: SeededActor;
let diLead: SeededActor;
let sysAdmin: SeededActor;
let analytics: pg.Client;

const again = <T extends ActorContext>(ctx: T): T => ({ ...ctx, correlationId: randomUUID() });
const q = async <T extends pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> => (await analytics.query<T>(text, params)).rows;

interface FlagSpec { kind: 'PRODUCT_ITEM' | 'PERSON'; ref: string; rule: string; reasons: unknown[] }

/** One DONE run of `method` v1 raising the given flags (and outputs); returns the flag ids. */
async function run(method: string, flags: FlagSpec[], outputs: { ref: string; values: object; reasons: unknown[] }[] = []): Promise<string[]> {
  const input = [{ view: INPUT, version: 1, filter: null, data_as_of: '2026-10-12T04:40:00Z', rows: 3, sha256: SHA }];
  const [r] = await q<{ id: string }>("select analytics.begin_run($1, 1, null, 'SCHEDULED', $2::jsonb, $3::jsonb) as id", [method, JSON.stringify(input), JSON.stringify(RUNTIME)]);
  for (const o of outputs) {
    await q("select analytics.record_output($1, 'BATCH', $2, 'REVIEW_PRIORITY', $3::jsonb, $4::jsonb)", [r!.id, o.ref, JSON.stringify(o.values), JSON.stringify(o.reasons)]);
  }
  const ids: string[] = [];
  for (const f of flags) {
    const [row] = await q<{ id: string }>("select analytics.record_flag($1, null, $2, $3, $4, 'ATTENTION', $5::jsonb) as id", [r!.id, f.kind, f.ref, f.rule, JSON.stringify(f.reasons)]);
    ids.push(row!.id);
  }
  await q('select analytics.finish_run($1, $2, $3)', [r!.id, SHA, JSON.stringify({ flags: flags.length, outputs: outputs.length })]);
  return ids;
}

const dispose = (ctx: ActorContext, flag: string, verdict: string, supersedes: string | null = null, reason: string | null = null) =>
  withCommand(gmp.app, again(ctx), async (c) =>
    (await c.query<{ id: string }>('select analytics.record_disposition($1, $2, $3, null, $4, $5)::text as id', [flag, verdict, 'checked against the batch record', supersedes, reason])).rows[0]!.id);

beforeAll(async () => {
  gmp = await createTestDatabase();
  await ensureFixtureChangeRecord(gmp);
  sysAdmin = (await seedAdministration(gmp)).admin;
  const c = await gmp.admin.connect();
  try {
    await c.query('begin');
    await c.query(`select kernel.set_actor_context(${RELEASE})`);
    await c.query(`insert into iam.role_permission (role_code, permission_code) values
                     ('QA_REVIEWER', 'ANALYTICS.VIEW'), ('QA_REVIEWER', 'ANALYTICS.DISPOSITION'), ('QA_REVIEWER', 'ANALYTICS.METHOD'),
                     ('CSV_DI_LEAD', 'ANALYTICS.VIEW'), ('CSV_DI_LEAD', 'ANALYTICS.DISPOSITION'), ('CSV_DI_LEAD', 'ANALYTICS.DI_REVIEW')
                   on conflict do nothing`);
    await c.query(`select analytics.register_input('VIEW', '${INPUT}', 1, '6A-1', 'GMP batch', 'test input: the batch outcomes')
                    where not exists (select 1 from analytics.input_registry where name = '${INPUT}')`);
    await c.query('select kernel.set_actor_context(null)');
    await c.query('commit');
  } finally {
    c.release();
  }
  [qa, diLead] = await Promise.all([seedActor(gmp, { roleCode: 'QA_REVIEWER' }), seedActor(gmp, { roleCode: 'CSV_DI_LEAD' })]);
  for (const m of ['SPC.IMR', 'ATA.RULES', 'REVIEW.PRIORITY']) {
    await withCommand(gmp.admin, again(underChange(qa)), (cc) =>
      cc.query(`insert into analytics.method_version (method, version, status, title, intended_use, acceptance, parameters, parameters_sha256, code_identity, validation_ref)
                values ($1, 1, 'EFFECTIVE', 'Test method', 'advisory test', '{}', '{}', $2, '@ebmr/analytics 0.1.0', 'VAL-TEST-1')`, [m, SHA]));
  }
  analytics = new pg.Client({ connectionString: urlFor(gmp.name, ANALYTICS_LOGIN) });
  await analytics.connect();
}, 300_000);

afterAll(async () => {
  await analytics?.end();
  await gmp?.drop();
});

describe('one flag-grouping design (kernel 1280; P6A7-1)', () => {
  it('[DI-52] a later raise of a dispositioned signal is shown with its verdict, takes no fresh first disposition, and a new verdict supersedes the current one with a reason', async () => {
    const subject = `P|F|item-${randomUUID().slice(0, 8)}`;
    const hit: FlagSpec = { kind: 'PRODUCT_ITEM', ref: subject, rule: 'NELSON_2', reasons: [{ code: 'NELSON_2', text: 'nine in a row above the centre', evidence: [{ kind: 'BATCH', ref: randomUUID() }] }] };
    const [first] = await run('SPC.IMR', [hit]);
    const current = await dispose(qa, first!, 'FALSE_ALARM');
    const [later] = await run('SPC.IMR', [hit]);
    // The later raise is covered: it is not open, and the period list shows it with the signal's current verdict.
    expect((await gmp.app.query('select 1 from analytics.open_flag_v1 where subject_ref = $1', [subject])).rows).toEqual([]);
    const { rows: listed } = await gmp.app.query<{ flag_id: string; current_disposition: string | null }>(
      'select flag_id::text, current_disposition::text from analytics.flag_v1 where subject_ref = $1 order by raised_at, flag_id', [subject]);
    expect(listed).toEqual([{ flag_id: first, current_disposition: current }, { flag_id: later, current_disposition: current }]);
    // The dispositions covering a raise are its signal's.
    const { rows: covering } = await gmp.app.query<{ disposition_id: string; disposition_flag: string; current: boolean }>(
      'select disposition_id::text, disposition_flag::text, current from analytics.flag_group_disposition_v1 where flag_id = $1', [later]);
    expect(covering).toEqual([{ disposition_id: current, disposition_flag: first, current: true }]);
    // A fresh first verdict on the later raise would give the signal a second current verdict without a reason: refused.
    await expect(dispose(qa, later!, 'TRUE_SIGNAL')).rejects.toThrow(/EBMR-ANA-008/);
    // A new verdict supersedes the signal's current one, from any raise, with a reason.
    await expect(dispose(qa, later!, 'TRUE_SIGNAL', current, null)).rejects.toThrow(/EBMR-ANA-008/);
    const next = await dispose(qa, later!, 'TRUE_SIGNAL', current, 'the trend continued after the probe was replaced');
    const { rows: after } = await gmp.app.query<{ current_disposition: string }>('select current_disposition::text from analytics.flag_v1 where subject_ref = $1', [subject]);
    expect(after.map((r) => r.current_disposition)).toEqual([next, next]);
    // A hit that differs in anything is its own signal, open and dispositioned on its own.
    const [grown] = await run('SPC.IMR', [{ ...hit, reasons: [{ ...(hit.reasons[0] as object), text: 'ten in a row above the centre' }] }]);
    expect((await gmp.app.query<{ flag_id: string }>('select flag_id::text from analytics.open_flag_v1 where subject_ref = $1', [subject])).rows).toEqual([{ flag_id: grown }]);
    await expect(dispose(qa, grown!, 'FALSE_ALARM')).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });

  it('[DI-53][DI-52] a disposition on an audit-trail key closes its later raises in every reader, restricted to data-integrity review, and the monitor counts them dispositioned', async () => {
    const person = randomUUID();
    const entry = `kernel:x#${String(Math.floor(Math.random() * 1e9))}`;
    // The same key (rule, person, first evidence) raised with drifting reasons: the week's percentile moved.
    const raise = (text: string): FlagSpec => ({ kind: 'PERSON', ref: person, rule: 'CORRECTIONS_HIGH', reasons: [{ code: 'CORRECTIONS_HIGH', text, evidence: [{ kind: 'WEEK', ref: '2026-W40' }, { kind: 'AUDIT_EVENT', ref: entry }] }] });
    const [first] = await run('ATA.RULES', [raise('7 corrections, above the 95th percentile 4.1')]);
    const current = await dispose(diLead, first!, 'FALSE_ALARM');
    const [later] = await run('ATA.RULES', [raise('7 corrections, above the 95th percentile 4.3')]);
    // The key's verdict covers the later raise: person_flag_dispositions gives it, for data-integrity review only.
    const covering = (ctx: ActorContext, flag: string) => withCommand(gmp.app, again(ctx), async (c) =>
      (await c.query<{ id: string; flag: string }>('select id::text, flag::text from analytics.person_flag_dispositions($1)', [flag])).rows);
    expect(await covering(diLead, later!)).toEqual([{ id: current, flag: first }]);
    await expect(covering(qa, later!)).rejects.toThrow(/EBMR-ANA-007/);
    await expect(covering(sysAdmin, later!)).rejects.toThrow(/EBMR-IAM-042/);
    // The key is closed in the audit-trail list, and a fresh first verdict on the later raise is refused.
    const keys = await withCommand(gmp.app, again(diLead), async (c) =>
      (await c.query<{ flag_id: string; disposition_flag: string | null; raised_count: number }>(
        "select flag_id::text, disposition_flag::text, raised_count from analytics.audit_flags('-infinity', 'infinity') where subject_ref = $1", [person])).rows);
    expect(keys).toEqual([{ flag_id: later, disposition_flag: first, raised_count: 2 }]);
    await expect(dispose(diLead, later!, 'TRUE_SIGNAL')).rejects.toThrow(/EBMR-ANA-008/);
    // Restricted flags stay out of the unrestricted views.
    for (const view of ['analytics.open_flag_v1', 'analytics.flag_v1', 'analytics.flag_group_disposition_v1']) {
      const { rows } = await gmp.app.query(`select * from ${view} where ${view.endsWith('disposition_v1') ? 'flag_id = any($1::uuid[])' : 'subject_ref = $1'}`,
        [view.endsWith('disposition_v1') ? [first, later] : person]);
      expect(rows, view).toEqual([]);
    }
    // The monitor counts both raises of the key as dispositioned FALSE_ALARM.
    const { rows: m } = await gmp.app.query<{ flags: number; dispositioned_share: number; false_alarm_rate: number }>(
      "select sum(flags)::int as flags, max(dispositioned_share) as dispositioned_share, max(false_alarm_rate) as false_alarm_rate from analytics.method_monitor_v1 where method = 'ATA.RULES'");
    expect(m[0]).toEqual({ flags: 2, dispositioned_share: 1, false_alarm_rate: 1 });
  });

  it('[DI-52] the group of a flag is 6A-4\'s key for the audit-trail methods and 6A-3\'s signal for the others', async () => {
    const reasons = [{ code: 'X', text: 'a', evidence: [{ kind: 'WEEK', ref: '2026-W40' }] }];
    const { rows } = await gmp.admin.query<{ ata: string; key: string; spc: string; spc2: string; other: string }>(
      `select analytics.flag_group('ATA.RULES', 1, 'PERSON', 'p', 'R', 'INFO', $1::jsonb) as ata,
              analytics.flag_key('ATA.RULES', 'R', 'PERSON', 'p', $1::jsonb) as key,
              analytics.flag_group('SPC.IMR', 1, 'PRODUCT_ITEM', 'p', 'R', 'INFO', $1::jsonb) as spc,
              analytics.flag_group('SPC.IMR', 1, 'PRODUCT_ITEM', 'p', 'R', 'INFO', $2::jsonb) as spc2,
              analytics.flag_group('SPC.IMR', 2, 'PRODUCT_ITEM', 'p', 'R', 'INFO', $1::jsonb) as other`,
      [JSON.stringify(reasons), JSON.stringify([{ ...reasons[0], text: 'b' }])]);
    expect(rows[0]!.ata).toBe(rows[0]!.key);
    expect(new Set([rows[0]!.spc, rows[0]!.spc2, rows[0]!.other]).size).toBe(3);
  });
});

describe('the review priority\'s audit-trail term (kernel 1281; P6A7-2)', () => {
  it('[DI-53] the audit-trail term of a review priority is unreadable without ANALYTICS.DI_REVIEW, also through the app role directly', async () => {
    const batch = randomUUID();
    const values = { score: 9, batchNumber: 'B-1', 'OPEN_AUDIT_FLAG.count': 1, 'OPEN_AUDIT_FLAG.points': 4, 'EXCEPTION_MAJOR.count': 1, 'EXCEPTION_MAJOR.points': 5 };
    const reasons = [
      { code: 'EXCEPTION_MAJOR', text: '1 major exception', weight: 5 },
      { code: 'OPEN_AUDIT_FLAG', text: '1 audit-trail rule hit on this record\'s entries', weight: 4 },
    ];
    await run('REVIEW.PRIORITY', [], [{ ref: batch, values, reasons }]);
    interface Row { score: number; codes: string[]; points: unknown; count: unknown; vscore: unknown }
    const sql = `select p.score, array(select r ->> 'code' from jsonb_array_elements(p.reasons) r) as codes,
                        o."values" -> 'OPEN_AUDIT_FLAG.points' as points, o."values" -> 'OPEN_AUDIT_FLAG.count' as count, o."values" -> 'score' as vscore
                   from analytics.review_priority_v1 p join analytics.output_v1 o on o.output_id = p.output_id where p.batch_ref = $1`;
    const read = (ctx: ActorContext) => withCommand(gmp.app, again(ctx), async (c) => (await c.query<Row>(sql, [batch])).rows[0]);
    const hidden = { score: 5, codes: ['EXCEPTION_MAJOR'], points: null, count: null, vscore: 5 };
    // The application role without a person, QA without DI_REVIEW and an administrator see the score without the term.
    expect((await gmp.app.query<Row>(sql, [batch])).rows[0]).toEqual(hidden);
    expect(await read(qa)).toEqual(hidden);
    expect(await read(sysAdmin)).toEqual(hidden);
    // The data-integrity reviewer sees it whole.
    expect(await read(diLead)).toEqual({ score: 9, codes: ['EXCEPTION_MAJOR', 'OPEN_AUDIT_FLAG'], points: 4, count: 1, vscore: 9 });
    // The term's points count only as a positive number; anything else takes nothing off.
    const { rows: pts } = await gmp.admin.query<{ p: number[] }>(
      `select array[analytics.audit_term_points('{"OPEN_AUDIT_FLAG.points": 4}'), analytics.audit_term_points('{"OPEN_AUDIT_FLAG.points": "4"}'),
                    analytics.audit_term_points('{"OPEN_AUDIT_FLAG.points": -2}'), analytics.audit_term_points('{}')] as p`);
    expect(pts[0]!.p).toEqual([4, 0, 0, 0]);
  });
});

describe('the verdicts of the audit-trail keys as an analytics input (kernel 1282; P6A5-2)', () => {
  it('[DI-51][DI-53] the analytics role reads the current verdict of each audit-trail key from its allow-list; the application and reporting roles cannot, and the segregation check stays clean', async () => {
    const person = randomUUID();
    const reasons = [{ code: 'LATE_ENTRY', text: 'entered 40 minutes late', evidence: [{ kind: 'AUDIT_EVENT', ref: 'kernel:y#77' }] }];
    const [first] = await run('ATA.RULES', [{ kind: 'PERSON', ref: person, rule: 'LATE_ENTRY', reasons }]);
    const key = (await gmp.admin.query<{ k: string }>("select analytics.flag_key('ATA.RULES', 'LATE_ENTRY', 'PERSON', $1, $2::jsonb) as k", [person, JSON.stringify(reasons)])).rows[0]!.k;
    const verdict = async () => (await q<{ verdict: string }>('select verdict from analytics.audit_key_verdict_v1 where flag_key = $1', [key])).map((r) => r.verdict);
    expect(await verdict()).toEqual([]);
    const d = await dispose(diLead, first!, 'FALSE_ALARM');
    expect(await verdict()).toEqual(['FALSE_ALARM']);
    await dispose(diLead, first!, 'TRUE_SIGNAL', d, 'the entry was keyed from memory, not from the sheet');
    expect(await verdict()).toEqual(['TRUE_SIGNAL']);
    // It is catalogued for the analytics role, outside the report catalogue; no other role reads it.
    const { rows: cat } = await gmp.admin.query<{ kind: string; version: number }>("select kind, version from analytics.input_catalog_v1 where name = 'analytics.audit_key_verdict_v1'");
    expect(cat).toEqual([{ kind: 'VIEW', version: 1 }]);
    await expect(gmp.app.query('select * from analytics.audit_key_verdict_v1')).rejects.toThrow(/permission denied/);
    const report = new pg.Client({ connectionString: urlFor(gmp.name, REPORT_LOGIN) });
    await report.connect();
    try {
      await expect(report.query('select * from analytics.audit_key_verdict_v1')).rejects.toThrow(/permission denied/);
    } finally {
      await report.end();
    }
    const { rows: listed } = await gmp.admin.query("select 1 from report.view_registry where view_name = 'audit_key_verdict_v1'");
    expect(listed).toEqual([]);
    expect(await segregationProblems(gmp.admin)).toEqual([]);
  });
});
