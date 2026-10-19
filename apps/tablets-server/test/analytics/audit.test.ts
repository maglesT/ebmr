/**
 * The audit-trail anomaly flags end to end (Phase 6A slice 6A-4; decision 0016 item 8; D-6A-12; draft controls DI-53,
 * DI-25, DI-51): the runner reads the audit and authentication facts as ebmr_analytics and raises ATA.RULES flags about
 * persons, restricted and with their reasons and evidence; only a holder of ANALYTICS.DI_REVIEW reads them, through the
 * server and through the application role alike; a flag sends no notification, the same hit raised again by a later
 * run is one key, and a key closes only with QA's disposition; the entries route names the flagged entries of a
 * batch's audit-trail review scope.
 *
 * Real logins make the two-terminal case. TEST FIXTURE: a night-time configuration change of the data-integrity lead
 * (an audit event written as the database owner with triggers off, as kernel.append_audit_event writes it), and for
 * the entries route a batch record row and a flag written as the analytics role through its functions.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { review } from '@ebmr/analytics';
import { routes } from '@ebmr/api-contract';
import { ATA_BASELINE_IMPLEMENTATION, ATA_RULES_IMPLEMENTATION, AUDIT_FACTS, AUTH_FACTS, MANUAL_DIGITS, auditInput } from '../../src/analytics/audit.ts';
import type { AnalyticsRunnerApi } from '../../src/analytics/threaded.ts';
import { refusalOf, startSigningServer, valueOf } from '../esig/support.ts';
import { grantedPerson, loginOf, type GrantedPerson } from '../support/granted-person.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { asAnalytics, fixtureBatch, releaseMethodVersion } from './support.ts';

let gmp: TestServer;
let qa: TestBrowser;
let diLead: TestBrowser;
let lead: GrantedPerson;
let target: GrantedPerson;
let configEvent = '';

const codeIn = (r: Parameters<typeof refusalOf>[0]): string => {
  const f = refusalOf(r);
  return `${f.code} ${f.why ?? ''}`.match(/EBMR-[A-Z]+-\d{3}/)?.[0] ?? f.code;
};

const runner = (): AnalyticsRunnerApi => {
  const r = gmp.built.analytics;
  if (!r) throw new Error('the GMP server started without its analytics runner');
  return r;
};

async function runAudit(): Promise<{ rules: string; baseline: string }> {
  const reports = await runner().runAll('ON_DEMAND');
  const rules = reports.find((r) => r.method === 'ATA.RULES');
  const baseline = reports.find((r) => r.method === 'ATA.BASELINE');
  expect(rules, JSON.stringify(reports)).toMatchObject({ status: 'DONE', version: 1 });
  expect(baseline, JSON.stringify(reports)).toMatchObject({ status: 'DONE', version: 1 });
  return { rules: rules!.runId!, baseline: baseline!.runId! };
}

async function counts(): Promise<{ notifications: number; outbox: number }> {
  const { rows } = await gmp.db.admin.query<{ notifications: number; outbox: number }>(
    'select (select count(*)::int from recipe.notification) as notifications, (select count(*)::int from platform.outbox) as outbox');
  return rows[0]!;
}

beforeAll(async () => {
  gmp = await startSigningServer('GMP', { env: { EBMR_ANALYTICS: 'on' }, analytics: { pollMs: 3_600_000 } });
  qa = await gmp.asPersona('qaInvestigator');
  lead = await grantedPerson(gmp, 'CSV_DI_LEAD', 'Lata Krishnan (DI lead)');
  diLead = await loginOf(gmp, lead);
  target = await grantedPerson(gmp, 'QA_REVIEWER', 'Ravi Nair (two terminals)');
  // One account on two terminals within seconds (real logins).
  const first = gmp.browser('PC-QA-02');
  const second = gmp.browser('PC-QA-03');
  for (const b of [first, second]) {
    const body = { method: 'PASSWORD' as const, identifier: target.loginName, secret: target.password };
    valueOf(await b.call(routes.session.login, { body: { ...body, proof: await b.proof('POST', '/api/session/login', body) } }));
  }
  // TEST FIXTURE: a configuration change by the DI lead at 23:30 site time yesterday.
  const c = await gmp.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    const { rows } = await c.query<{ id: string }>(
      `with z as (select coalesce(kernel.site_zone(), 'UTC') as zone),
            t as (select (date_trunc('day', statement_timestamp() at time zone (select zone from z)) - interval '1 day' + interval '23 hours 30 minutes') at time zone (select zone from z) as at),
            a as (select table_name::text as tbl from platform.config_area order by code limit 1)
       insert into kernel.audit_event (chain_key, seq, prev_hash, hash, recorded_at, correlation_id, action, table_name, record_id, payload)
       select 'config_area:FIXTURE-6A4', 1, '\\x00', '\\x01', t.at, gen_random_uuid(), 'UPDATE', a.tbl, 'FIXTURE',
              jsonb_build_object('actor', jsonb_build_object('person_id', $1::text, 'account_id', $2::text, 'role_code', 'CSV_DI_LEAD'), 'source', 'UI',
                                 'reason_code', 'CONFIG_CHANGE', 'reason_text', 'fixture', 'body', jsonb_build_object('new', jsonb_build_object('value', 'NIGHT-VALUE')))
         from t, a
       returning id::text`,
      [lead.personId, lead.accountId],
    );
    await c.query('commit');
    configEvent = rows[0]!.id;
  } finally {
    c.release();
  }
  await releaseMethodVersion(gmp, 'ATA.RULES', 1);
  await releaseMethodVersion(gmp, 'ATA.BASELINE', 1);
}, 900_000);
afterAll(async () => {
  await gmp?.close();
});

describe('the audit-trail flags (GMP; ATA.RULES, ATA.BASELINE)', () => {
  it('[DI-53] the runner raises the audit-trail flags from the audit and authentication facts: about the person, restricted, with their reasons and the entries behind them', async () => {
    const before = await counts();
    const run = await runAudit();
    const { rows: inputs } = await gmp.db.admin.query<{ views: string[] }>("select array_agg(x ->> 'view' order by x ->> 'view') as views from analytics.run r, jsonb_array_elements(r.inputs) x where r.id = $1", [run.rules]);
    expect(inputs[0]!.views).toEqual(['report.audit_fact_v1', 'report.auth_fact_v1', 'report.manual_digit_v1']);
    const { rows } = await gmp.db.admin.query<{ rule: string; subject_kind: string; subject_ref: string; restricted: boolean; reasons: { code: string; text: string; evidence: { kind: string; ref: string }[] }[] }>(
      'select rule, subject_kind, subject_ref, restricted, reasons from analytics.flag where run = $1 order by rule', [run.rules]);
    const two = rows.find((r) => r.rule === 'TWO_TERMINALS' && r.subject_ref === target.personId);
    expect(two).toMatchObject({ subject_kind: 'PERSON', restricted: true });
    expect(two!.reasons[0]!.text).toMatch(/^The account logged in on PC-QA-02 and then on PC-QA-03 within \d+ seconds \(threshold 2 minutes\)$/);
    expect(two!.reasons[0]!.evidence.map((e) => e.kind)).toEqual(['AUTH_EVENT', 'AUTH_EVENT']);
    const night = rows.find((r) => r.rule === 'OFF_HOURS_CONFIG' && r.subject_ref === lead.personId);
    expect(night!.reasons[0]!.text).toMatch(/at 23:30 site time, outside the working hours 06:00 to 22:00$/);
    expect(night!.reasons[0]!.evidence).toEqual([{ kind: 'AUDIT_EVENT', ref: `config_area:FIXTURE-6A4#${configEvent}` }]);
    for (const r of rows) {
      expect(r.subject_kind).toBe('PERSON');
      expect(r.restricted).toBe(true);
      expect(r.reasons.length).toBeGreaterThan(0);
    }
    // Every output is about a person, so none is shown in the unrestricted read view.
    expect((await gmp.db.app.query('select 1 from analytics.output_v1 where run_id = any($1::uuid[])', [[run.rules, run.baseline]])).rowCount).toBe(0);
    // No value of the audit entry travels: not in the flag, not in the run's inputs.
    const { rows: all } = await gmp.db.admin.query<{ t: string }>('select (select string_agg(reasons::text, \' \') from analytics.flag where run = $1) || (select inputs::text from analytics.run where id = $1) as t', [run.rules]);
    expect(all[0]!.t).not.toContain('NIGHT-VALUE');
    expect(await counts()).toEqual(before);
  });

  it('[DI-53] a person flag is unreadable without ANALYTICS.DI_REVIEW, also through the app role directly', async () => {
    await runAudit();
    // The QA reviewer holds ANALYTICS.VIEW but not ANALYTICS.DI_REVIEW: refused alike for every route and flag.
    const listed = valueOf(await diLead.call(routes.analyticsAudit.flags));
    const flag = listed.flags.find((f) => f.rule === 'TWO_TERMINALS' && f.subjectRef === target.personId)!;
    expect(flag).toMatchObject({ restricted: true, subjectKind: 'PERSON', subjectLabel: 'Ravi Nair (two terminals)', method: { id: 'ATA.RULES', version: 1 }, disposition: null });
    expect(codeIn(await qa.call(routes.analyticsAudit.flags))).toBe('EBMR-ANA-007');
    expect(codeIn(await qa.call(routes.analyticsAudit.flag, { params: { flagId: flag.flagId } }))).toBe('EBMR-ANA-007');
    expect(codeIn(await qa.call(routes.analyticsAudit.flag, { params: { flagId: randomUUID() } }))).toBe('EBMR-ANA-007');
    expect(codeIn(await qa.call(routes.analyticsAudit.entries, { params: { batchId: randomUUID() } }))).toBe('EBMR-ANA-007');
    // The application role directly: no table, no fact, and the definers refuse without a validated actor.
    for (const sql of ['select * from analytics.flag', 'select * from report.audit_fact_v1', 'select * from report.auth_fact_v1', 'select * from report.manual_digit_v1']) {
      await expect(gmp.db.app.query(sql), sql).rejects.toThrow(/permission denied/);
    }
    for (const sql of ["select * from analytics.audit_flags('-infinity', 'infinity')", `select * from analytics.audit_flag_entries('${flag.flagId}')`, `select * from analytics.audit_flagged_entries('${randomUUID()}')`]) {
      await expect(gmp.db.app.query(sql), sql).rejects.toThrow(/EBMR-/);
    }
    // The data-integrity lead reads the flag with its reasons and the entries behind it (no values).
    const d = valueOf(await diLead.call(routes.analyticsAudit.flag, { params: { flagId: flag.flagId } }));
    expect(d).toMatchObject({ advisory: true, notForGmpDecisions: true, method: { id: 'ATA.RULES', version: 1 }, flag: { flagId: flag.flagId } });
    expect(d.repeat?.raisedCount).toBeGreaterThanOrEqual(2);
    const night = valueOf(await diLead.call(routes.analyticsAudit.flags)).flags.find((f) => f.rule === 'OFF_HOURS_CONFIG' && f.subjectRef === lead.personId)!;
    const nd = valueOf(await diLead.call(routes.analyticsAudit.flag, { params: { flagId: night.flagId } }));
    expect(nd.entries).toEqual([expect.objectContaining({ eventId: configEvent, chainKey: 'config_area:FIXTURE-6A4', action: 'UPDATE', field: 'value', isCorrection: true, reasonCode: 'CONFIG_CHANGE',
                                                          drill: '/audit?chain=config_area%3AFIXTURE-6A4' })]);
    expect(JSON.stringify(nd)).not.toContain('NIGHT-VALUE');
  });

  it('[DI-53] a flag sends no notification and closes only with a disposition', async () => {
    const before = await counts();
    await runAudit();
    const key = (fl: { rule: string; subjectRef: string }) => fl.rule === 'TWO_TERMINALS' && fl.subjectRef === target.personId;
    const open = valueOf(await diLead.call(routes.analyticsAudit.flags));
    const flags = open.flags.filter(key);
    // The same hit raised by every run is one key, its latest flag, with how often it was raised.
    expect(flags).toHaveLength(1);
    const flag = flags[0]!;
    expect(open.repeats?.find((r) => r.flagId === flag.flagId)?.raisedCount).toBeGreaterThanOrEqual(3);
    // Only the audit trail's and the database clock's own triggers sit on the flag table: no notification, no outbox.
    const { rows: triggers } = await gmp.db.admin.query<{ fn: string }>("select tgfoid::regproc::text as fn from pg_trigger where tgrelid = 'analytics.flag'::regclass and not tgisinternal");
    expect(triggers.length).toBeGreaterThan(0);
    for (const t of triggers) expect(t.fn).toMatch(/^(kernel\.|platform\.force_db_time$)/);
    expect(await counts()).toEqual(before);
    // Nothing but a disposition closes it: the application role cannot change the flag or write a disposition.
    await expect(gmp.db.app.query("update analytics.flag set severity = 'INFO' where id = $1", [flag.flagId])).rejects.toThrow(/permission denied/);
    await expect(gmp.db.app.query('insert into analytics.flag_disposition (flag, verdict, cause, person_id, account_id) values ($1, $2, $3, $4, $5)',
      [flag.flagId, 'FALSE_ALARM', 'closing it behind QA\'s back', lead.personId, lead.accountId])).rejects.toThrow(/permission denied/);
    // The QA reviewer cannot dispose of a person flag; the data-integrity lead can.
    expect(codeIn(await qa.call(routes.analytics.dispose, { params: { flagId: flag.flagId }, body: { verdict: 'FALSE_ALARM', cause: 'Two office PCs side by side' } }))).toBe('EBMR-ANA-007');
    const d = valueOf(await diLead.call(routes.analytics.dispose, { params: { flagId: flag.flagId }, body: { verdict: 'FALSE_ALARM', cause: 'Two office PCs side by side in the QA office' } }));
    expect(d.disposition).toMatchObject({ verdict: 'FALSE_ALARM', current: true, person: { personId: lead.personId } });
    expect(valueOf(await diLead.call(routes.analyticsAudit.flags)).flags.some(key)).toBe(false);
    // A later run raises the hit again; its key stays closed by that disposition, and the period list shows it with it.
    await runAudit();
    expect(valueOf(await diLead.call(routes.analyticsAudit.flags)).flags.some(key)).toBe(false);
    const day = (await gmp.db.admin.query<{ d: string }>("select to_char(statement_timestamp() at time zone coalesce(kernel.site_zone(), 'UTC'), 'YYYY-MM-DD') as d")).rows[0]!.d;
    const period = valueOf(await diLead.call(routes.analyticsAudit.flags, { query: { from: day, to: day } }));
    const again = period.flags.find(key)!;
    expect(again.flagId).not.toBe(flag.flagId);
    expect(again.disposition).toMatchObject({ verdict: 'FALSE_ALARM', dispositionId: d.disposition.dispositionId });
    // Superseding the key's disposition goes to the flag that holds it, with a reason.
    const s = valueOf(await diLead.call(routes.analytics.dispose, { params: { flagId: flag.flagId },
      body: { verdict: 'TRUE_SIGNAL', cause: 'The account was shared; raised as a deviation', deviationRef: 'DEV-QA-2026-00042', supersedes: d.disposition.dispositionId, reason: 'second look at the badge log' } }));
    expect(s.disposition).toMatchObject({ verdict: 'TRUE_SIGNAL', supersedes: d.disposition.dispositionId, current: true });
    const detail = valueOf(await diLead.call(routes.analyticsAudit.flag, { params: { flagId: again.flagId } }));
    expect(detail.flag.disposition).toMatchObject({ verdict: 'TRUE_SIGNAL' });
    expect(detail.dispositions.map((x) => [x.verdict, x.current])).toEqual([['FALSE_ALARM', false], ['TRUE_SIGNAL', true]]);
    expect(await counts()).toEqual(before);
  });

  it('[DI-25][DI-53] the entries route names the flagged entries of a batch\'s audit-trail review scope, and only those', async () => {
    const batch = await fixtureBatch(gmp, `AU-${randomUUID().slice(0, 6).toUpperCase()}`);
    const other = await fixtureBatch(gmp, `AU-${randomUUID().slice(0, 6).toUpperCase()}`);
    const inputs = [{ view: 'report.audit_fact_v1', version: 1, filter: null, data_as_of: '2026-10-12T04:40:00Z', rows: 1, sha256: 'a'.repeat(64) }];
    const runtime = { package: '@ebmr/analytics 0.1.0', commit: 'test', node: process.version, libraries: {} };
    const [r] = await asAnalytics<{ id: string }>(gmp, "select analytics.begin_run('ATA.RULES', 1, null, 'ON_DEMAND', $1::jsonb, $2::jsonb)::text as id", [JSON.stringify(inputs), JSON.stringify(runtime)]);
    const reasons = (b: string, id: string) => JSON.stringify([{ code: 'LATE_ENTRY', text: 'hardness was recorded 47 minutes after the time it claims (threshold 15 minutes)', evidence: [{ kind: 'AUDIT_EVENT', ref: `batch:${b}#${id}` }, { kind: 'BATCH', ref: b }] }]);
    const [f] = await asAnalytics<{ id: string }>(gmp, "select analytics.record_flag($1, null, 'PERSON', $2, 'LATE_ENTRY', 'INFO', $3::jsonb)::text as id", [r!.id, target.personId, reasons(batch, '424242')]);
    await asAnalytics(gmp, "select analytics.record_flag($1, null, 'PERSON', $2, 'LATE_ENTRY', 'INFO', $3::jsonb)", [r!.id, target.personId, reasons(other, '434343')]);
    await asAnalytics(gmp, "select analytics.finish_run($1, $2, '{}')", [r!.id, 'b'.repeat(64)]);
    const e = valueOf(await diLead.call(routes.analyticsAudit.entries, { params: { batchId: batch } }));
    expect(e).toMatchObject({ advisory: true, notForGmpDecisions: true, batchId: batch });
    expect(e.entries).toEqual([{ eventId: '424242', chainKey: `batch:${batch}`, flags: [{ flagId: f!.id, rule: 'LATE_ENTRY', severity: 'INFO', verdict: null }] }]);
  });

  it('[DI-52][DI-53] a later raise of a dispositioned key is shown with its verdict in the flags about persons and takes no fresh first verdict; the review priority keys a hit as the kernel does (P6A7-1, P6A5-2)', async () => {
    const b = randomUUID();
    const runtime = { package: '@ebmr/analytics 0.1.0', commit: 'test', node: process.version, libraries: {} };
    // Two runs raise the same LATE_ENTRY hit about the target, its reason drifting (written as the analytics role).
    const raise = async (minutes: number): Promise<string> => {
      const inputs = [{ view: 'report.audit_fact_v1', version: 1, filter: null, data_as_of: '2026-10-12T04:40:00Z', rows: 1, sha256: 'a'.repeat(64) }];
      const [r] = await asAnalytics<{ id: string }>(gmp, "select analytics.begin_run('ATA.RULES', 1, null, 'ON_DEMAND', $1::jsonb, $2::jsonb)::text as id", [JSON.stringify(inputs), JSON.stringify(runtime)]);
      const reasons = [{ code: 'LATE_ENTRY', text: `hardness was recorded ${String(minutes)} minutes after the time it claims`, evidence: [{ kind: 'AUDIT_EVENT', ref: `batch:${b}#515151` }, { kind: 'BATCH', ref: b }] }];
      const [f] = await asAnalytics<{ id: string }>(gmp, "select analytics.record_flag($1, null, 'PERSON', $2, 'LATE_ENTRY', 'INFO', $3::jsonb)::text as id", [r!.id, target.personId, JSON.stringify(reasons)]);
      await asAnalytics(gmp, "select analytics.finish_run($1, $2, '{}')", [r!.id, 'b'.repeat(64)]);
      return f!.id;
    };
    const first = await raise(47);
    const d = valueOf(await diLead.call(routes.analytics.dispose, { params: { flagId: first }, body: { verdict: 'FALSE_ALARM', cause: 'The sheet was keyed at the end of the shift, as allowed' } }));
    const later = await raise(48);
    // The open flags about persons leave the later raise out; its detail shows the key's verdict.
    const open = valueOf(await diLead.call(routes.analytics.flags, { query: { kind: 'PERSON' } }));
    expect(open.flags.map((f) => f.flagId)).not.toContain(later);
    expect(open.flags.map((f) => f.flagId)).not.toContain(first);
    const detail = valueOf(await diLead.call(routes.analytics.flag, { params: { flagId: later } }));
    expect(detail.flag.disposition).toMatchObject({ verdict: 'FALSE_ALARM', dispositionId: d.disposition.dispositionId });
    // A fresh first verdict on the later raise is refused; a new one supersedes the key's current verdict with a reason.
    expect(codeIn(await diLead.call(routes.analytics.dispose, { params: { flagId: later }, body: { verdict: 'TRUE_SIGNAL', cause: 'Looked again at the sheet and the log' } }))).toBe('EBMR-ANA-008');
    const s2 = valueOf(await diLead.call(routes.analytics.dispose, { params: { flagId: later },
      body: { verdict: 'TRUE_SIGNAL', cause: 'Looked again at the sheet and the log', supersedes: d.disposition.dispositionId, reason: 'the shift log shows no late keying' } }));
    expect(s2.disposition).toMatchObject({ verdict: 'TRUE_SIGNAL', supersedes: d.disposition.dispositionId, current: true });
    // The review priority's key of a hit is the kernel's (analytics.flag_key) for every flag the runner raised, and the
    // verdict input gives the key's current verdict to the analytics role.
    await runAudit();
    const { rows } = await gmp.db.admin.query<{ rule: string; subject_ref: string; reasons: { code: string; text: string; evidence?: { kind: string; ref: string }[] }[]; k: string }>(
      "select f.rule, f.subject_ref, f.reasons, analytics.flag_key(r.method, f.rule, f.subject_kind, f.subject_ref, f.reasons) as k from analytics.flag f join analytics.run r on r.id = f.run where r.method = 'ATA.RULES'");
    expect(rows.length).toBeGreaterThan(2);
    for (const r of rows) expect(review.auditFlagKey({ rule: r.rule, personId: r.subject_ref, reason: r.reasons[0]! })).toBe(r.k);
    const key = review.auditFlagKey({ rule: 'LATE_ENTRY', personId: target.personId, reason: { code: 'LATE_ENTRY', text: '', evidence: [{ kind: 'AUDIT_EVENT', ref: `batch:${b}#515151` }] } });
    expect(await asAnalytics<{ verdict: string }>(gmp, 'select verdict from analytics.audit_key_verdict_v1 where flag_key = $1', [key])).toEqual([{ verdict: 'TRUE_SIGNAL' }]);
  });
});

// Mutation campaign at the Phase 7 exit (D-P7-1 item 4): the runner usually works in its worker thread, which Stryker's
// coverage does not see, so the assembly of the methods' input from the view rows is checked here directly.
describe('the audit-trail methods\' input in the runner (analytics/audit.ts)', () => {
  const event = {
    event_id: 'E1', chain_key: 'batch:B1', recorded_at: '2026-06-01 10:00:00+00', recorded_local: '2026-06-01 15:30:00', claimed_at: '2026-06-01 09:00:00+00',
    person_id: 'P1', account_id: 'A1', role: 'OPERATOR', terminal: 'T1', action: 'UPDATE', table_name: 'tab.step', field: 'weight', is_correction: true,
    reason_code: 'TYPO', batch_id: 'B1', step: 'S1', attempt: 2, failed: false, deviation_linked: true, config_area: 'RECIPE',
  };
  const auth = { event_ref: 'L1', account_id: 'A1', person_id: 'P1', terminal: 'T2', kind: 'FAILED', at: '2026-06-01 10:01:00+00', at_local: '2026-06-01 15:31:00' };
  const digit = { person_id: 'P1', event_id: 'E1', chain_key: 'batch:B1', recorded_local: '2026-06-01 15:30:00', terminal_digit: 7 };
  const refusal = (rows: Record<string, readonly Record<string, unknown>[]>): string => {
    try {
      auditInput(rows);
    } catch (e) {
      return (e as Error).message;
    }
    return 'accepted';
  };

  it('[DI-53] each audit, authentication and manual-digit row becomes the methods\' input field by field', () => {
    expect(auditInput({ [AUDIT_FACTS.view]: [event], [AUTH_FACTS.view]: [auth], [MANUAL_DIGITS.view]: [digit] })).toEqual({
      events: [{ eventId: 'E1', chainKey: 'batch:B1', recordedAt: '2026-06-01 10:00:00+00', recordedLocal: '2026-06-01 15:30:00', claimedAt: '2026-06-01 09:00:00+00', personId: 'P1',
        accountId: 'A1', role: 'OPERATOR', terminal: 'T1', action: 'UPDATE', tableName: 'tab.step', field: 'weight', isCorrection: true, reasonCode: 'TYPO', batchId: 'B1', step: 'S1',
        attempt: 2, failed: false, deviationLinked: true, configArea: 'RECIPE' }],
      auth: [{ ref: 'L1', accountId: 'A1', personId: 'P1', terminal: 'T2', kind: 'FAILED', at: '2026-06-01 10:01:00+00', atLocal: '2026-06-01 15:31:00' }],
      digits: [{ personId: 'P1', eventId: 'E1', chainKey: 'batch:B1', recordedLocal: '2026-06-01 15:30:00', digit: 7 }],
    });
    // Optional columns null or absent: null, an account of '' and no correction or deviation link.
    const bare = { event_id: 'E2', chain_key: 'k', recorded_at: 'a', recorded_local: 'l', person_id: 'P2', action: 'INSERT', claimed_at: null, account_id: null, is_correction: null, failed: true };
    expect(auditInput({ [AUDIT_FACTS.view]: [bare] }).events).toEqual([{ eventId: 'E2', chainKey: 'k', recordedAt: 'a', recordedLocal: 'l', claimedAt: null, personId: 'P2', accountId: '',
      role: null, terminal: null, action: 'INSERT', tableName: null, field: null, isCorrection: false, reasonCode: null, batchId: null, step: null, attempt: null, failed: true,
      deviationLinked: false, configArea: null }]);
    expect(auditInput({ [AUDIT_FACTS.view]: [{ ...event, is_correction: false, deviation_linked: false, failed: null }] }).events[0]).toMatchObject({ isCorrection: false, deviationLinked: false, failed: null });
    expect(auditInput({})).toEqual({ events: [], auth: [], digits: [] });
    for (const kind of ['LOGIN', 'FAILED', 'LOCKOUT']) expect(auditInput({ [AUTH_FACTS.view]: [{ ...auth, kind }] }).auth[0]?.kind).toBe(kind);
    for (const d of [0, 9]) expect(auditInput({ [MANUAL_DIGITS.view]: [{ ...digit, terminal_digit: d }] }).digits[0]?.digit).toBe(d);
  });

  it('[DI-53] a row outside its column types, an unknown authentication kind or a terminal digit outside 0 to 9 fails the run\'s input', () => {
    expect(refusal({ [AUDIT_FACTS.view]: [{ ...event, event_id: '' }] })).toBe('column event_id is not text in an audit-trail input row');
    expect(refusal({ [AUDIT_FACTS.view]: [{ ...event, chain_key: 5 }] })).toBe('column chain_key is not text in an audit-trail input row');
    expect(refusal({ [AUDIT_FACTS.view]: [{ ...event, role: 5 }] })).toBe('column role is not text in an audit-trail input row');
    expect(refusal({ [AUDIT_FACTS.view]: [{ ...event, failed: 'true' }] })).toBe('column failed is not a boolean in an audit-trail input row');
    expect(refusal({ [AUDIT_FACTS.view]: [{ ...event, attempt: 2.5 }] })).toBe('column attempt is not an integer in an audit-trail input row');
    expect(refusal({ [AUDIT_FACTS.view]: [{ ...event, attempt: '2' }] })).toBe('column attempt is not an integer in an audit-trail input row');
    expect(refusal({ [AUTH_FACTS.view]: [{ ...auth, kind: 'LOGOUT' }] })).toBe('unknown authentication fact kind LOGOUT');
    expect(refusal({ [AUTH_FACTS.view]: [{ ...auth, kind: undefined }] })).toBe('column kind is not text in an audit-trail input row');
    for (const d of [-1, 10, null]) expect(refusal({ [MANUAL_DIGITS.view]: [{ ...digit, terminal_digit: d }] }), String(d)).toBe('a manual entry\'s terminal digit is not 0 to 9');
    expect(refusal({ [MANUAL_DIGITS.view]: [{ ...digit, person_id: null }] })).toBe('column person_id is not text in an audit-trail input row');
  });

  it('[DI-53] ATA.RULES reads the audit, authentication and manual-digit views; ATA.BASELINE the first two; both only nightly', () => {
    expect(ATA_RULES_IMPLEMENTATION.inputs.map((i) => i.view)).toEqual(['report.audit_fact_v1', 'report.auth_fact_v1', 'report.manual_digit_v1']);
    expect(ATA_BASELINE_IMPLEMENTATION.inputs.map((i) => i.view)).toEqual(['report.audit_fact_v1', 'report.auth_fact_v1']);
    for (const m of [ATA_RULES_IMPLEMENTATION, ATA_BASELINE_IMPLEMENTATION]) {
      expect(m.onBatchComplete).toBe(false);
      expect(m.assemble({ [MANUAL_DIGITS.view]: [digit] }).digits).toHaveLength(1);
    }
  });
});

