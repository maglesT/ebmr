/**
 * The audit-trail methods of slice 6A-4 (ATA.RULES and ATA.BASELINE; decision 0016 item 8; D-6A-12; draft control
 * DI-53), on known answers: each seeded anomaly of the synthetic history (packages/test-kit/src/analytics-history.ts)
 * raises its rule's flag with its reasons and the clean persons raise none; the rules the history does not seed
 * (corrections above the site's percentile, configuration changes outside working hours) fire on seeded cases of their
 * own and stay silent on clean ones; the baseline flags a week far from the person's own trailing weeks and gives no
 * flag below 6 weeks of history. Every flag is about a person and shows at least one reason with evidence.
 */
import { describe, expect, it } from 'vitest';
import { analyticsHistory, type AnalyticsHistory } from '../../test-kit/src/analytics-history.ts';
import { AnalyticsInputError, defaultParameters, outputHash, parameterProblems } from '../src/index.ts';
import {
  ATA_BASELINE,
  ATA_RULES,
  AUDIT_RULES,
  BASELINE_METRICS,
  compareIds,
  instantMs,
  median,
  localHour,
  quantileOfSorted,
  robustZ,
  runAuditBaseline,
  runAuditRules,
  siteWeek,
  type AuditBaselineParameters,
  type AuditEvent,
  type AuditInput,
  type AuditRulesParameters,
  type AuthEvent,
} from '../src/methods/audit/index.ts';
import { byText } from '../src/methods/audit/input.ts';

const RULES = defaultParameters('ATA.RULES') as AuditRulesParameters;
const BASELINE = defaultParameters('ATA.BASELINE') as AuditBaselineParameters;

/** The synthetic history as the runner assembles it from the audit views (the site zone of the history is UTC). */
function fromHistory(h: AnalyticsHistory): AuditInput {
  const cpp = new Map(h.cppValues.map((v) => [`${v.batch_id}|${v.item}|${v.recorded_at}`, v]));
  const deviated = new Set(h.deviations.map((d) => d.batch_id));
  const events: AuditEvent[] = h.auditEvents.map((e) => {
    const v = e.claimed_at === null ? undefined : cpp.get(`${e.batch_id ?? ''}|${e.field ?? ''}|${e.claimed_at}`);
    return {
      eventId: e.event_id, chainKey: `batch:${e.batch_id ?? 'none'}`, recordedAt: e.recorded_at, recordedLocal: e.recorded_at.slice(0, 19), claimedAt: e.claimed_at,
      personId: e.person_id, accountId: e.account_id, role: e.role, terminal: e.terminal, action: e.action, tableName: e.table_name, field: e.field,
      isCorrection: e.is_correction, reasonCode: e.reason_code, batchId: e.batch_id, step: e.step, attempt: v?.attempt ?? null, failed: v ? v.failed : null,
      deviationLinked: e.batch_id !== null && deviated.has(e.batch_id), configArea: null,
    };
  });
  const auth: AuthEvent[] = h.authEvents.map((a, i) => ({ ref: `auth_event:${String(i + 1)}`, accountId: a.account_id, personId: a.person_id, terminal: a.terminal, kind: a.kind, at: a.at, atLocal: a.at.slice(0, 19) }));
  const digits = h.manualEntries.map((m, i) => ({
    personId: m.person_id, eventId: String(100_000 + i), chainKey: `batch:${m.batch_id}`, recordedLocal: m.recorded_at.slice(0, 19), digit: m.value_text.charCodeAt(m.value_text.length - 1) - 48,
  }));
  return { events, auth, digits };
}

const person = (n: number): string => `6a060001-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

/** A plain data entry of `who` at day `day`, minute `min` of June 2026 (UTC site), on a batch step. */
function entry(who: number, day: number, min: number, over: Partial<AuditEvent> = {}, id = `${String(who)}${String(day).padStart(3, '0')}${String(min).padStart(4, '0')}`): AuditEvent {
  const t = new Date(Date.UTC(2026, 5, 1 + day, 4, 30) + min * 60_000).toISOString();
  return {
    eventId: id, chainKey: 'batch:b1', recordedAt: t, recordedLocal: t.slice(0, 19), claimedAt: null, personId: person(who), accountId: `acc-${String(who)}`, role: 'OPERATOR',
    terminal: 'T-1', action: 'INSERT', tableName: 'recipe.execution_command', field: 'item.a', isCorrection: false, reasonCode: null, batchId: 'b1', step: 's1', attempt: 1,
    failed: false, deviationLinked: false, configArea: null, ...over,
  };
}

describe('the audit-trail rules (ATA.RULES v1)', () => {
  it('[DI-53] each seeded anomaly of the synthetic history raises its rule\'s flag with its reasons, and the clean persons raise none', () => {
    const h = analyticsHistory();
    const r = runAuditRules(fromHistory(h), RULES);
    const raised = [...new Set(r.flags.map((f) => `${f.rule} ${f.subjectRef}`))].sort();
    const expected = h.expected.filter((e) => e.method === 'ATA.RULES').map((e) => `${e.rule} ${e.subjectRef}`).sort();
    expect(raised).toEqual(expected);
    const clean = new Set(h.persons.filter((p) => p.anomaly === null).map((p) => p.person_id));
    expect(r.flags.filter((f) => clean.has(f.subjectRef))).toEqual([]);
    for (const f of r.flags) {
      expect(f.subjectKind).toBe('PERSON');
      expect(['INFO', 'ATTENTION']).toContain(f.severity);
      expect(f.reasons.length).toBeGreaterThan(0);
      for (const reason of f.reasons) {
        expect(reason.code).toBe(f.rule);
        expect(reason.text.length).toBeGreaterThan(20);
        expect(reason.evidence?.length ?? 0).toBeGreaterThan(0);
      }
    }
    // Each seeded hit once; its reasons say why, with the entries behind them.
    const late = r.flags.find((f) => f.rule === 'LATE_ENTRY')!;
    expect(late.reasons[0].text).toMatch(/recorded 47 minutes after the time it claims \(threshold 15 minutes\)/);
    expect(late.reasons[0].evidence?.[0]?.kind).toBe('AUDIT_EVENT');
    expect(r.flags.find((f) => f.rule === 'BACK_DATED')!.reasons[0].text).toMatch(/claims a time 3 minutes before the step's previous entry \(compression\.weight\)/);
    expect(r.flags.find((f) => f.rule === 'TWO_TERMINALS')!.reasons[0].text).toMatch(/TAB-PRESS-01 and then on TAB-GRAN-01 within 50 seconds/);
    expect(r.flags.find((f) => f.rule === 'TOO_REGULAR')!.reasons[0].text).toMatch(/^60 manual entries; the most frequent last digits are (0|5) \(\d+\), (0|5) \(\d+\)\./);
    const repeat = r.flags.find((f) => f.rule === 'REPEAT_UNTIL_PASS')!;
    expect(repeat.reasons[0].text).toMatch(/compression\.hardness in compression: 2 failed attempts \(1, 2\) before a pass at attempt 3, with no deviation/);
    expect(repeat.reasons[0].evidence?.filter((e) => e.kind === 'AUDIT_EVENT')).toHaveLength(3);
    expect(r.flags).toHaveLength(expected.length);
    // One output per person with a hit, counting its hits; nothing about the clean persons.
    expect(r.outputs.map((o) => o.subjectRef).sort()).toEqual([...new Set(r.flags.map((f) => f.subjectRef))].sort());
    for (const o of r.outputs) expect(o).toMatchObject({ kind: 'AUDIT_RULE_HIT', subjectKind: 'PERSON' });
    // The clean persons' manual entries were tested and passed; nobody fewer than 50 entries was tested.
    expect(r.skipped.filter((s) => s.subject.endsWith('TOO_REGULAR'))).toEqual([]);
  });

  it('[DI-53] a re-run on the same input reproduces the flags and their keys exactly, whatever order the rows come in', () => {
    const input = fromHistory(analyticsHistory());
    const a = runAuditRules(input, RULES);
    const b = runAuditRules({ events: [...input.events].reverse(), auth: [...input.auth].reverse(), digits: [...input.digits].reverse() }, RULES);
    expect(outputHash(b.outputs, b.flags)).toBe(outputHash(a.outputs, a.flags));
    // The key of a flag is the first evidence of its first reason: the entry, login, week or test it is about.
    const keys = a.flags.map((f) => `${f.rule}|${f.subjectRef}|${f.reasons[0].evidence?.[0]?.kind ?? ''}:${f.reasons[0].evidence?.[0]?.ref ?? ''}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('[DI-53] corrections above the site\'s 95th percentile in a completed week raise CORRECTIONS_HIGH; the same count in the week in progress, or below the percentile, does not', () => {
    const events: AuditEvent[] = [];
    // 30 persons, five weeks each with one correction a week; person 1 has nine corrections in week 2.
    for (let w = 0; w < 5; w += 1) {
      for (let p = 1; p <= 30; p += 1) {
        events.push(entry(p, w * 7 + 1, 10, {}), entry(p, w * 7 + 1, 20, { isCorrection: true, action: 'UPDATE', reasonCode: 'TYPO' }));
      }
    }
    for (let k = 0; k < 8; k += 1) events.push(entry(1, 8, 30 + k, { isCorrection: true, action: 'UPDATE', reasonCode: 'TYPO' }));
    // The week in progress (the latest of the input) is not assessed: person 2 has nine there.
    for (let k = 0; k < 9; k += 1) events.push(entry(2, 36, 30 + k, { isCorrection: true, action: 'UPDATE', reasonCode: 'TYPO' }));
    const r = runAuditRules({ events, auth: [], digits: [] }, RULES);
    const hits = r.flags.filter((f) => f.rule === 'CORRECTIONS_HIGH');
    expect(hits.map((f) => f.subjectRef)).toEqual([person(1)]);
    expect(hits[0]!.reasons[0].text).toMatch(/^9 corrections in the site week of 2026-06-08, above the site's 95th percentile of 1\.0 over 150 active person-weeks$/);
    expect(hits[0]!.reasons[0].evidence?.[0]).toEqual({ kind: 'WEEK', ref: '2026-06-08' });
    expect(hits[0]!.reasons[0].evidence?.filter((e) => e.kind === 'AUDIT_EVENT')).toHaveLength(9);
    // Too few person-weeks: no percentile, so no flag, and the method says so.
    const few = runAuditRules({ events: events.filter((e) => e.personId === person(1) || e.personId === person(2)), auth: [], digits: [] }, RULES);
    expect(few.flags.filter((f) => f.rule === 'CORRECTIONS_HIGH')).toEqual([]);
    expect(few.skipped).toContainEqual({ subject: 'CORRECTIONS_HIGH', reason: "10 active person-weeks; the site's percentile needs 20" });
  });

  it('[DI-53] a configuration change outside the site\'s working hours raises OFF_HOURS_CONFIG; one inside them, or a data entry at night, does not', () => {
    // 04:30 UTC is the base; minute 1100 is 22:50 site time, minute 60 is 05:30, minute 300 is 09:30.
    const night = entry(1, 0, 1100, { configArea: 'ANALYTICS_METHOD', tableName: 'analytics.method_version', field: null, batchId: null, step: null, chainKey: 'config_area:ANALYTICS_METHOD' });
    const early = entry(2, 0, 60, { configArea: 'MARKET_RULES', tableName: 'market.rule', field: null, batchId: null, step: null, chainKey: 'config_area:MARKET_RULES' });
    const day = entry(3, 0, 300, { configArea: 'MARKET_RULES', tableName: 'market.rule', field: null, batchId: null, step: null, chainKey: 'config_area:MARKET_RULES' });
    const nightEntry = entry(4, 0, 1100);
    const r = runAuditRules({ events: [night, early, day, nightEntry], auth: [], digits: [] }, RULES);
    const off = r.flags.filter((f) => f.rule === 'OFF_HOURS_CONFIG');
    expect(off.map((f) => f.subjectRef)).toEqual([person(2), person(1)]);
    expect(off[1]!.reasons[0].text).toBe('A configuration change of ANALYTICS_METHOD (analytics.method_version) at 22:50 site time, outside the working hours 06:00 to 22:00');
    expect(off[1]!.reasons[0].evidence).toEqual([{ kind: 'AUDIT_EVENT', ref: `config_area:ANALYTICS_METHOD#${night.eventId}` }]);
    // Working hours that wrap midnight (22:00 to 06:00 is a night shift's site): the day change is then the odd one.
    const wrapped = runAuditRules({ events: [night, early, day], auth: [], digits: [] }, { ...RULES, workingHoursStart: 22, workingHoursEnd: 6 });
    expect(wrapped.flags.map((f) => f.subjectRef)).toEqual([person(3)]);
  });

  it('[DI-53] each rule stays silent on its clean case: a timely entry, an in-order step, one terminal, varied digits, a pass at the first attempt or after a deviation', () => {
    const late = entry(1, 0, 30, { claimedAt: new Date(Date.UTC(2026, 5, 1, 4, 30) + 15 * 60_000).toISOString() }); // exactly 15 minutes: not more
    const inOrder = [entry(2, 0, 10, { claimedAt: new Date(Date.UTC(2026, 5, 1, 4, 39)).toISOString() }), entry(2, 0, 12, { field: 'item.b', claimedAt: new Date(Date.UTC(2026, 5, 1, 4, 38)).toISOString() })];
    const deviated = [1, 2, 3].map((a) => entry(3, 0, 50 + a, { field: 'ipc.x', attempt: a, failed: a < 3, deviationLinked: true, batchId: 'b3', chainKey: 'batch:b3' }));
    const firstPass = [entry(4, 0, 60, { field: 'ipc.y', attempt: 1, failed: false, batchId: 'b4' }), entry(4, 0, 61, { field: 'ipc.y', attempt: 2, failed: true, batchId: 'b4' })];
    const oneFailure = [1, 2].map((a) => entry(5, 0, 70 + a, { field: 'ipc.z', attempt: a, failed: a < 2, batchId: 'b5' }));
    const sameTerminal: AuthEvent[] = [0, 30].map((s, i) => ({ ref: `auth_event:${String(i)}`, accountId: 'acc-6', personId: person(6), terminal: 'T-1', kind: 'LOGIN', at: new Date(Date.UTC(2026, 5, 1, 4, 30, s)).toISOString(), atLocal: '2026-06-01T04:30:00' }));
    const slowSwitch: AuthEvent[] = [0, 121].map((s, i) => ({ ref: `auth_event:${String(10 + i)}`, accountId: 'acc-7', personId: person(7), terminal: `T-${String(i)}`, kind: 'LOGIN', at: new Date(Date.UTC(2026, 5, 1, 4, 30, s)).toISOString(), atLocal: '2026-06-01T04:30:00' }));
    const varied = Array.from({ length: 60 }, (_, i) => ({ personId: person(8), eventId: String(i), chainKey: 'batch:b8', recordedLocal: '2026-06-01T05:00:00', digit: i % 10 }));
    const fewDigits = Array.from({ length: 49 }, (_, i) => ({ personId: person(9), eventId: String(i), chainKey: 'batch:b9', recordedLocal: '2026-06-01T05:00:00', digit: 0 }));
    const r = runAuditRules({ events: [late, ...inOrder, ...deviated, ...firstPass, ...oneFailure], auth: [...sameTerminal, ...slowSwitch], digits: [...varied, ...fewDigits] }, RULES);
    expect(r.flags).toEqual([]);
    expect(r.outputs).toEqual([]);
    expect(r.skipped).toContainEqual({ subject: `PERSON ${person(9)} TOO_REGULAR`, reason: '49 manual entries; the terminal-digit test needs 50' });
    // One minute more and each fires.
    const fired = runAuditRules({
      events: [{ ...late, recordedAt: new Date(Date.parse(late.recordedAt) + 60_000).toISOString() }, ...oneFailure.map((e) => (e.attempt === 1 ? e : { ...e, attempt: 3 })), entry(5, 0, 72, { field: 'ipc.z', attempt: 2, failed: true, batchId: 'b5' })],
      auth: slowSwitch.map((a, i) => (i === 1 ? { ...a, at: new Date(Date.UTC(2026, 5, 1, 4, 32)).toISOString() } : a)),
      digits: [],
    }, RULES);
    expect(fired.flags.map((f) => f.rule).sort()).toEqual(['LATE_ENTRY', 'REPEAT_UNTIL_PASS', 'TWO_TERMINALS']);
  });

  it('reads PostgreSQL and ISO instants to the millisecond, the site hour and the site week (Monday)', () => {
    expect(instantMs('2026-06-01 10:00:00+05:30')).toBe(Date.UTC(2026, 5, 1, 4, 30));
    expect(instantMs('2026-06-01 04:30:00.123456+00')).toBe(Date.UTC(2026, 5, 1, 4, 30, 0, 123));
    expect(instantMs('2026-06-01T04:30:00.5Z')).toBe(Date.UTC(2026, 5, 1, 4, 30, 0, 500));
    expect(instantMs('2026-06-01 01:00:00-03:30')).toBe(Date.UTC(2026, 5, 1, 4, 30));
    expect(() => instantMs('yesterday')).toThrow(/not an instant/);
    expect(localHour('2026-06-01T23:59:59')).toBe(23);
    expect(siteWeek('2026-06-01T00:00:00')).toBe('2026-06-01'); // a Monday
    expect(siteWeek('2026-06-07T23:59:59')).toBe('2026-06-01'); // its Sunday
    expect(siteWeek('2026-06-08T00:00:00')).toBe('2026-06-08');
    expect(quantileOfSorted([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBeCloseTo(9.5, 12);
    expect(quantileOfSorted([1, 1, 1, 9], 0.5)).toBe(1);
    // Mutation campaign at the Phase 7 exit (D-P7-1 item 4): an offset without its colon, text around an instant or a
    // wall-clock time, and the id and text orders.
    expect(instantMs('2026-06-01 10:00:00+0530')).toBe(Date.UTC(2026, 5, 1, 4, 30));
    for (const t of ['x2026-06-01 04:30:00Z', '2026-06-01 04:30:00Zx', '2026-06-01 04:30:00+05:30 ']) expect(() => instantMs(t), t).toThrow(AnalyticsInputError);
    for (const t of ['x2026-06-01T04:30:00', '2026-06-01T04:30:00x', '2026-06-01 04:30:00']) {
      expect(() => localHour(t), t).toThrow(AnalyticsInputError);
      expect(() => siteWeek(t), t).toThrow(AnalyticsInputError);
    }
    expect(() => localHour('later')).toThrow('not a site wall-clock time: "later"');
    expect(() => siteWeek('later')).toThrow('not a site wall-clock time: "later"');
    expect(['10', '9', '100', '11', '9'].sort(compareIds)).toEqual(['9', '9', '10', '11', '100']);
    expect([compareIds('12', '12'), compareIds('12', '13'), compareIds('13', '12'), compareIds('9', '10')]).toEqual([0, -1, 1, -1]);
    expect([byText('a', 'a'), byText('a', 'b'), byText('b', 'a')]).toEqual([0, -1, 1]);
  });

  it('the parameters of version 1 are the plan defaults and fit the schema (D-6A-12)', () => {
    expect(RULES).toEqual({
      lateEntryMinutes: 15, backDatedMinutes: 2, correctionsPercentile: 0.95, correctionsMinPersonWeeks: 20, twoTerminalsMinutes: 2, digitTestMinEntries: 50, digitTestAlpha: 0.01,
      repeatFailures: 2, workingHoursStart: 6, workingHoursEnd: 22,
    });
    expect(BASELINE).toEqual({ minHistoryWeeks: 6, trailingWeeks: 13, robustZ: 3.5, lateEntryMinutes: 15 });
    expect(parameterProblems('ATA.RULES', RULES)).toEqual([]);
    expect(parameterProblems('ATA.BASELINE', BASELINE)).toEqual([]);
  });
});

// Mutation campaign at the Phase 7 exit (D-P7-1 item 4): every rule on one crafted input, with its boundaries, the
// rows given newest first, and the rows each rule must leave alone; the whole result is checked.
describe('the audit-trail rules on one crafted input (ATA.RULES v1)', () => {
  const A = person(11);
  const B = person(12);
  const C = person(13);
  const P: AuditRulesParameters = { ...RULES, correctionsMinPersonWeeks: 7, digitTestMinEntries: 20 };
  /** An event at `local` (UTC site, YYYY-MM-DDTHH:MM:SS), with what the case needs. */
  const ev = (id: string, who: string, local: string, over: Partial<AuditEvent> = {}): AuditEvent => ({
    eventId: id, chainKey: 'batch:x', recordedAt: `${local}Z`, recordedLocal: local, claimedAt: null, personId: who, accountId: 'acc', role: 'OPERATOR', terminal: 'T-1',
    action: 'INSERT', tableName: null, field: null, isCorrection: false, reasonCode: null, batchId: null, step: null, attempt: null, failed: null, deviationLinked: false,
    configArea: null, ...over,
  });
  const at = (local: string, minutes: number): string => new Date(Date.parse(`${local}Z`) + minutes * 60_000).toISOString();
  const logIn = (ref: string, account: string, who: string, local: string, terminal: string | null, kind: AuthEvent['kind'] = 'LOGIN'): AuthEvent => ({
    ref, accountId: account, personId: who, terminal, kind, at: `${local}Z`, atLocal: local,
  });
  // Week 3 (from 2026-06-22) is in progress: the rule cases live there, so only weeks 0 to 2 are person-weeks.
  const W3 = '2026-06-23';
  function crafted(): AuditInput {
    const events: AuditEvent[] = [];
    // CORRECTIONS_HIGH: seven person-weeks (exactly the minimum) with 0, 1, 1, 0, 0, 4 and 1 corrections; the limit is their
    // 95th percentile, 3.1.
    events.push(ev('101', A, '2026-06-02T10:00:00'), ev('102', A, '2026-06-09T10:00:00', { isCorrection: true }), ev('103', B, '2026-06-03T10:00:00', { isCorrection: true }));
    events.push(ev('104', B, '2026-06-10T10:00:00'), ev('105', C, '2026-06-04T10:00:00'));
    for (let k = 0; k < 5; k += 1) events.push(ev(String(110 + k), C, `2026-06-1${String(k)}T11:00:00`.replace('2026-06-10', '2026-06-15'), { isCorrection: true }));
    // ... and ten in the week in progress, which is not assessed.
    for (let k = 0; k < 10; k += 1) events.push(ev(String(120 + k), C, `${W3}T12:0${String(k)}:00`, { isCorrection: true }));
    // LATE_ENTRY: 20.5 minutes late on a batch step; 16 minutes late with no field, step or batch; exactly 15 minutes is not late.
    events.push(ev('201', A, `${W3}T08:30:30`, { claimedAt: `${W3}T08:10:00Z`, batchId: 'B-1', step: 'S-2', field: 'item.x' }));
    events.push(ev('202', A, `${W3}T08:40:00`, { claimedAt: `${W3}T08:24:00Z` }));
    events.push(ev('203', A, `${W3}T08:50:00`, { claimedAt: `${W3}T08:35:00Z` }));
    // BACK_DATED in B-2/S-3: the second entry claims 5 minutes before the first; the third exactly 2 minutes before the second.
    events.push(ev('301', B, `${W3}T09:00:00`, { claimedAt: `${W3}T09:00:00Z`, batchId: 'B-2', step: 'S-3', field: 'f1' }));
    events.push(ev('302', B, `${W3}T09:01:00`, { claimedAt: `${W3}T08:55:00Z`, batchId: 'B-2', step: 'S-3', field: 'f2' }));
    events.push(ev('303', B, `${W3}T09:02:00`, { claimedAt: `${W3}T08:53:00Z`, batchId: 'B-2', step: 'S-3', field: 'f3' }));
    // ... and in B-Z/S-0 (recorded first, named last) by recording order: the later-recorded entry claims 10 minutes before
    // the earlier one's claim.
    events.push(ev('311', B, `${W3}T07:00:00`, { claimedAt: at(`${W3}T07:10:00`, 0), batchId: 'B-Z', step: 'S-0', field: 'g1' }));
    events.push(ev('312', B, `${W3}T07:01:00`, { claimedAt: at(`${W3}T07:00:00`, 0), batchId: 'B-Z', step: 'S-0', field: 'g2' }));
    // Entries of two steps are never compared with each other.
    events.push(ev('313', B, `${W3}T09:30:00`, { claimedAt: at(`${W3}T09:30:00`, 0), batchId: 'B-11', step: 'S', field: 'k1' }));
    events.push(ev('314', B, `${W3}T09:31:00`, { claimedAt: at(`${W3}T09:25:00`, 0), batchId: 'B-12', step: 'S', field: 'k2' }));
    // The same pattern without a batch, a step or a field is not compared.
    for (const [n, over] of [[0, { batchId: null, step: 'S', field: 'h' }], [1, { batchId: 'B-9', step: null, field: 'h' }], [2, { batchId: 'B-9', step: 'S', field: null }]] as const) {
      events.push(ev(`32${String(n)}1`, B, `${W3}T1${String(n)}:00:00`, { ...over, claimedAt: at(`${W3}T1${String(n)}:10:00`, 0) }));
      events.push(ev(`32${String(n)}2`, B, `${W3}T1${String(n)}:01:00`, { ...over, claimedAt: at(`${W3}T1${String(n)}:00:00`, 0) }));
    }
    // REPEAT_UNTIL_PASS in B-3/S-5 item w: attempt 1 failed twice, 2 failed, 3 passed; 21 failed attempts then a pass in
    // B-0R (recorded later, named first).
    const rep = { batchId: 'B-3', step: 'S-5', field: 'w' };
    events.push(ev('401', C, `${W3}T13:00:00`, { ...rep, attempt: 1, failed: true }), ev('402', C, `${W3}T13:01:00`, { ...rep, attempt: 1, failed: true }));
    events.push(ev('403', C, `${W3}T13:02:00`, { ...rep, attempt: 2, failed: true }), ev('404', C, `${W3}T13:03:00`, { ...rep, attempt: 3, failed: false }));
    for (let k = 1; k <= 21; k += 1) events.push(ev(String(500 + k), C, `${W3}T14:${String(k).padStart(2, '0')}:00`, { batchId: 'B-0R', step: 'S-1', field: 'm', attempt: k, failed: true }));
    events.push(ev('530', C, `${W3}T14:30:00`, { batchId: 'B-0R', step: 'S-1', field: 'm', attempt: 22, failed: false }));
    // Not counted: a deviation on one entry of the item; no batch, step, field or failure state; a correction.
    const noRepeat: Partial<AuditEvent>[] = [
      { batchId: 'B-5', step: 'S', field: 'v', deviationLinked: false }, { batchId: null, step: 'S', field: 'v' }, { batchId: 'B-6', step: null, field: 'v' },
      { batchId: 'B-6', step: 'S', field: null }, { batchId: 'B-7', step: 'S', field: 'v', isCorrection: true },
    ];
    noRepeat.forEach((over, n) => {
      for (const [k, failed] of [[1, true], [2, true], [3, false]] as const) {
        events.push(ev(`6${String(n)}${String(k)}`, C, `${W3}T15:${String(n)}${String(k)}:00`, { ...over, attempt: k, failed, deviationLinked: n === 0 && k === 2 }));
      }
    });
    events.push(ev('651', C, `${W3}T16:00:00`, { batchId: 'B-8', step: 'S', field: 'v', attempt: 1, failed: true }), ev('652', C, `${W3}T16:01:00`, { batchId: 'B-8', step: 'S', field: 'v', attempt: 2, failed: true }));
    events.push(ev('653', C, `${W3}T16:02:00`, { batchId: 'B-8', step: 'S', field: 'v', attempt: 3, failed: null }));
    events.push(ev('661', C, `${W3}T16:10:00`, { batchId: 'B-10', step: 'S', field: 'v', attempt: null, failed: true }), ev('662', C, `${W3}T16:11:00`, { batchId: 'B-10', step: 'S', field: 'v', attempt: 1, failed: true }));
    events.push(ev('663', C, `${W3}T16:12:00`, { batchId: 'B-10', step: 'S', field: 'v', attempt: 2, failed: false }));
    // OFF_HOURS_CONFIG: 05:59 and 22:00 are outside 06:00 to 22:00; 06:00 and 21:59 are inside.
    events.push(ev('701', A, `${W3}T05:59:00`, { configArea: 'RECIPE', tableName: 'recipe.master' }), ev('702', A, `${W3}T06:00:00`, { configArea: 'RECIPE' }));
    events.push(ev('703', A, `${W3}T21:59:00`, { configArea: 'RECIPE' }), ev('704', A, `${W3}T22:00:00`, { configArea: 'ACCESS' }));
    const auth: AuthEvent[] = [
      // TWO_TERMINALS: T1 then T2 after 90 s; T2 again, a failed login on T3 and a login without terminal do not count.
      logIn('a1', 'acc-a', A, `${W3}T07:00:00`, 'T1'), logIn('a2', 'acc-a', A, `${W3}T07:01:30`, 'T2'), logIn('a3', 'acc-a', A, `${W3}T07:01:40`, 'T2'),
      logIn('a4', 'acc-a', A, `${W3}T07:01:35`, 'T3', 'FAILED'), logIn('a5', 'acc-a', A, `${W3}T07:01:31`, null),
      // Two terminals at the same instant: ordered by reference. Three minutes apart is outside the window.
      logIn('b2', 'acc-b', B, `${W3}T08:00:00`, 'T5'), logIn('b1', 'acc-b', B, `${W3}T08:00:00`, 'T6'), logIn('b3', 'acc-b', B, `${W3}T08:03:01`, 'T7'),
    ];
    // TOO_REGULAR: C has 22 manual entries (14 fives, 4 threes, 4 sevens; the last two at one time); B has 19, too few.
    const digits: AuditInput['digits'][number][] = [];
    // A has 3 manual entries (too few) and D exactly 20, evenly spread (tested, no hit); both listed first.
    for (let k = 0; k < 3; k += 1) digits.push({ personId: A, eventId: String(950 + k), chainKey: 'batch:d', recordedLocal: `${W3}T19:0${String(k)}:00`, digit: 1 });
    for (let k = 0; k < 20; k += 1) digits.push({ personId: person(14), eventId: String(960 + k), chainKey: 'batch:d', recordedLocal: `${W3}T19:${String(10 + k)}:00`, digit: k % 10 });
    const cDigits = [...Array<number>(14).fill(5), 3, 3, 3, 3, 7, 7, 7, 7];
    cDigits.forEach((digit, k) => digits.push({ personId: C, eventId: String(k === 20 ? 9 : 800 + k), chainKey: 'batch:d', recordedLocal: `${W3}T17:${String(k === 21 ? 20 : k).padStart(2, '0')}:00`, digit }));
    for (let k = 0; k < 19; k += 1) digits.push({ personId: B, eventId: String(900 + k), chainKey: 'batch:d', recordedLocal: `${W3}T18:${String(k).padStart(2, '0')}:00`, digit: 5 });
    return { events: events.reverse(), auth: auth.reverse(), digits: digits.reverse() };
  }

  it('[DI-53] each rule raises exactly its hits on the crafted input, with their texts, weights and evidence', () => {
    const input = crafted();
    const r = ATA_RULES.run(input, P, null);
    expect(ATA_RULES).toMatchObject({ id: 'ATA.RULES', versions: [1] });
    expect(AUDIT_RULES).toEqual(['LATE_ENTRY', 'BACK_DATED', 'CORRECTIONS_HIGH', 'TWO_TERMINALS', 'TOO_REGULAR', 'REPEAT_UNTIL_PASS', 'OFF_HOURS_CONFIG']);
    expect(r.flags).toEqual([
      { subjectKind: 'PERSON', subjectRef: A, rule: 'LATE_ENTRY', severity: 'INFO', reasons: [{ code: 'LATE_ENTRY', text: 'item.x in S-2 was recorded 20.5 minutes after the time it claims (threshold 15 minutes)', weight: 20.5, evidence: [{ kind: 'AUDIT_EVENT', ref: 'batch:x#201' }, { kind: 'BATCH', ref: 'B-1' }] }] },
      { subjectKind: 'PERSON', subjectRef: A, rule: 'LATE_ENTRY', severity: 'INFO', reasons: [{ code: 'LATE_ENTRY', text: 'An entry was recorded 16 minutes after the time it claims (threshold 15 minutes)', weight: 16, evidence: [{ kind: 'AUDIT_EVENT', ref: 'batch:x#202' }] }] },
      { subjectKind: 'PERSON', subjectRef: B, rule: 'BACK_DATED', severity: 'INFO', reasons: [{ code: 'BACK_DATED', text: 'f2 in S-3 claims a time 5 minutes before the step\'s previous entry (f1), which was recorded first (tolerance 2 minutes)', weight: 5, evidence: [{ kind: 'AUDIT_EVENT', ref: 'batch:x#302' }, { kind: 'BATCH', ref: 'B-2' }, { kind: 'AUDIT_EVENT', ref: 'batch:x#301' }] }] },
      { subjectKind: 'PERSON', subjectRef: B, rule: 'BACK_DATED', severity: 'INFO', reasons: [{ code: 'BACK_DATED', text: 'g2 in S-0 claims a time 10 minutes before the step\'s previous entry (g1), which was recorded first (tolerance 2 minutes)', weight: 10, evidence: [{ kind: 'AUDIT_EVENT', ref: 'batch:x#312' }, { kind: 'BATCH', ref: 'B-Z' }, { kind: 'AUDIT_EVENT', ref: 'batch:x#311' }] }] },
      { subjectKind: 'PERSON', subjectRef: C, rule: 'CORRECTIONS_HIGH', severity: 'ATTENTION', reasons: [{ code: 'CORRECTIONS_HIGH', text: '4 corrections in the site week of 2026-06-08, above the site\'s 95th percentile of 3.1 over 7 active person-weeks', weight: 4, evidence: [{ kind: 'WEEK', ref: '2026-06-08' }, { kind: 'AUDIT_EVENT', ref: 'batch:x#111' }, { kind: 'AUDIT_EVENT', ref: 'batch:x#112' }, { kind: 'AUDIT_EVENT', ref: 'batch:x#113' }, { kind: 'AUDIT_EVENT', ref: 'batch:x#114' }] }] },
      { subjectKind: 'PERSON', subjectRef: A, rule: 'TWO_TERMINALS', severity: 'ATTENTION', reasons: [{ code: 'TWO_TERMINALS', text: 'The account logged in on T1 and then on T2 within 90 seconds (threshold 2 minutes)', weight: 90, evidence: [{ kind: 'AUTH_EVENT', ref: 'a2' }, { kind: 'AUTH_EVENT', ref: 'a1' }] }] },
      { subjectKind: 'PERSON', subjectRef: B, rule: 'TWO_TERMINALS', severity: 'ATTENTION', reasons: [{ code: 'TWO_TERMINALS', text: 'The account logged in on T6 and then on T5 within 0 seconds (threshold 2 minutes)', weight: 0, evidence: [{ kind: 'AUTH_EVENT', ref: 'b2' }, { kind: 'AUTH_EVENT', ref: 'b1' }] }] },
      { subjectKind: 'PERSON', subjectRef: C, rule: 'TOO_REGULAR', severity: 'ATTENTION', reasons: [{ code: 'TOO_REGULAR', text: '22 manual entries; the most frequent last digits are 5 (14), 3 (4), 7 (4). Terminal-digit chi-square 81.6 on 9 degrees of freedom, above 21.67 (significance 0.01)', weight: 81.63636363636364, evidence: [{ kind: 'DIGIT_TEST', ref: `${C}@2026-06-22` }, { kind: 'AUDIT_EVENT', ref: 'batch:d#802' }, { kind: 'AUDIT_EVENT', ref: 'batch:d#803' }, { kind: 'AUDIT_EVENT', ref: 'batch:d#804' }, { kind: 'AUDIT_EVENT', ref: 'batch:d#805' }, { kind: 'AUDIT_EVENT', ref: 'batch:d#806' }, { kind: 'AUDIT_EVENT', ref: 'batch:d#807' }, { kind: 'AUDIT_EVENT', ref: 'batch:d#808' }, { kind: 'AUDIT_EVENT', ref: 'batch:d#809' }, { kind: 'AUDIT_EVENT', ref: 'batch:d#810' }, { kind: 'AUDIT_EVENT', ref: 'batch:d#811' }, { kind: 'AUDIT_EVENT', ref: 'batch:d#812' }, { kind: 'AUDIT_EVENT', ref: 'batch:d#813' }, { kind: 'AUDIT_EVENT', ref: 'batch:d#814' }, { kind: 'AUDIT_EVENT', ref: 'batch:d#815' }, { kind: 'AUDIT_EVENT', ref: 'batch:d#816' }, { kind: 'AUDIT_EVENT', ref: 'batch:d#817' }, { kind: 'AUDIT_EVENT', ref: 'batch:d#818' }, { kind: 'AUDIT_EVENT', ref: 'batch:d#819' }, { kind: 'AUDIT_EVENT', ref: 'batch:d#9' }, { kind: 'AUDIT_EVENT', ref: 'batch:d#821' }] }] },
      { subjectKind: 'PERSON', subjectRef: C, rule: 'REPEAT_UNTIL_PASS', severity: 'ATTENTION', reasons: [{ code: 'REPEAT_UNTIL_PASS', text: 'm in S-1: 21 failed attempts (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21) before a pass at attempt 22, with no deviation linked to the batch', weight: 21, evidence: [{ kind: 'AUDIT_EVENT', ref: 'batch:x#530' }, { kind: 'BATCH', ref: 'B-0R' }, { kind: 'AUDIT_EVENT', ref: 'batch:x#501' }, { kind: 'AUDIT_EVENT', ref: 'batch:x#502' }, { kind: 'AUDIT_EVENT', ref: 'batch:x#503' }, { kind: 'AUDIT_EVENT', ref: 'batch:x#504' }, { kind: 'AUDIT_EVENT', ref: 'batch:x#505' }, { kind: 'AUDIT_EVENT', ref: 'batch:x#506' }, { kind: 'AUDIT_EVENT', ref: 'batch:x#507' }, { kind: 'AUDIT_EVENT', ref: 'batch:x#508' }, { kind: 'AUDIT_EVENT', ref: 'batch:x#509' }, { kind: 'AUDIT_EVENT', ref: 'batch:x#510' }, { kind: 'AUDIT_EVENT', ref: 'batch:x#511' }, { kind: 'AUDIT_EVENT', ref: 'batch:x#512' }, { kind: 'AUDIT_EVENT', ref: 'batch:x#513' }, { kind: 'AUDIT_EVENT', ref: 'batch:x#514' }, { kind: 'AUDIT_EVENT', ref: 'batch:x#515' }, { kind: 'AUDIT_EVENT', ref: 'batch:x#516' }, { kind: 'AUDIT_EVENT', ref: 'batch:x#517' }, { kind: 'AUDIT_EVENT', ref: 'batch:x#518' }, { kind: 'AUDIT_EVENT', ref: 'batch:x#519' }, { kind: 'AUDIT_EVENT', ref: 'batch:x#520' }] }] },
      { subjectKind: 'PERSON', subjectRef: C, rule: 'REPEAT_UNTIL_PASS', severity: 'ATTENTION', reasons: [{ code: 'REPEAT_UNTIL_PASS', text: 'w in S-5: 2 failed attempts (1, 2) before a pass at attempt 3, with no deviation linked to the batch', weight: 2, evidence: [{ kind: 'AUDIT_EVENT', ref: 'batch:x#404' }, { kind: 'BATCH', ref: 'B-3' }, { kind: 'AUDIT_EVENT', ref: 'batch:x#401' }, { kind: 'AUDIT_EVENT', ref: 'batch:x#403' }] }] },
      { subjectKind: 'PERSON', subjectRef: A, rule: 'OFF_HOURS_CONFIG', severity: 'INFO', reasons: [{ code: 'OFF_HOURS_CONFIG', text: 'A configuration change of RECIPE (recipe.master) at 05:59 site time, outside the working hours 06:00 to 22:00', evidence: [{ kind: 'AUDIT_EVENT', ref: 'batch:x#701' }] }] },
      { subjectKind: 'PERSON', subjectRef: A, rule: 'OFF_HOURS_CONFIG', severity: 'INFO', reasons: [{ code: 'OFF_HOURS_CONFIG', text: 'A configuration change of ACCESS at 22:00 site time, outside the working hours 06:00 to 22:00', evidence: [{ kind: 'AUDIT_EVENT', ref: 'batch:x#704' }] }] },
    ]);
    expect(r.outputs).toEqual([
      { subjectKind: 'PERSON', subjectRef: A, kind: 'AUDIT_RULE_HIT', values: { events: 9, LATE_ENTRY: 2, BACK_DATED: 0, CORRECTIONS_HIGH: 0, TWO_TERMINALS: 1, TOO_REGULAR: 0, REPEAT_UNTIL_PASS: 0, OFF_HOURS_CONFIG: 2 }, reasons: [{ code: 'RULE_HITS', text: '5 audit-trail rule hit(s) for data-integrity review: LATE_ENTRY 2, TWO_TERMINALS 1, OFF_HOURS_CONFIG 2' }] },
      { subjectKind: 'PERSON', subjectRef: B, kind: 'AUDIT_RULE_HIT', values: { events: 15, LATE_ENTRY: 0, BACK_DATED: 2, CORRECTIONS_HIGH: 0, TWO_TERMINALS: 1, TOO_REGULAR: 0, REPEAT_UNTIL_PASS: 0, OFF_HOURS_CONFIG: 0 }, reasons: [{ code: 'RULE_HITS', text: '3 audit-trail rule hit(s) for data-integrity review: BACK_DATED 2, TWO_TERMINALS 1' }] },
      { subjectKind: 'PERSON', subjectRef: C, kind: 'AUDIT_RULE_HIT', values: { events: 63, LATE_ENTRY: 0, BACK_DATED: 0, CORRECTIONS_HIGH: 1, TWO_TERMINALS: 0, TOO_REGULAR: 1, REPEAT_UNTIL_PASS: 2, OFF_HOURS_CONFIG: 0 }, reasons: [{ code: 'RULE_HITS', text: '4 audit-trail rule hit(s) for data-integrity review: CORRECTIONS_HIGH 1, TOO_REGULAR 1, REPEAT_UNTIL_PASS 2' }] },
    ]);
    expect(r.skipped).toEqual([{ subject: `PERSON ${A} TOO_REGULAR`, reason: '3 manual entries; the terminal-digit test needs 20' }, { subject: `PERSON ${B} TOO_REGULAR`, reason: '19 manual entries; the terminal-digit test needs 20' }]);
    // The same rows in recording order give the same result.
    expect(runAuditRules({ events: [...input.events].reverse(), auth: [...input.auth].reverse(), digits: [...input.digits].reverse() }, P)).toEqual(r);
  });

  it('[DI-53] the week in progress is the latest of entries and logins; too few person-weeks are named only when there are some; equal working-hour bounds leave no working hour', () => {
    // Six persons with one entry each in week 0 and a login in week 1: week 0 is complete, and the one with 3 corrections is
    // above the percentile (2.25).
    const events = [1, 2, 3, 4, 5, 6].flatMap((n) => Array.from({ length: n === 6 ? 3 : 1 }, (_, k) => ev(`9${String(n)}${String(k)}`, person(n), `2026-06-0${String(n)}T10:00:00`, { isCorrection: n === 6 })));
    const login = logIn('z1', 'acc-z', person(1), '2026-06-09T10:00:00', 'T1');
    const six = { ...P, correctionsMinPersonWeeks: 6 };
    expect(runAuditRules({ events, auth: [login], digits: [] }, six).flags.map((f) => [f.rule, f.subjectRef, f.reasons[0].text])).toEqual([
      ['CORRECTIONS_HIGH', person(6), '3 corrections in the site week of 2026-06-01, above the site\'s 95th percentile of 2.3 over 6 active person-weeks'],
    ]);
    // Without the login, week 0 is the one in progress: nothing is assessed and nothing is skipped.
    expect(runAuditRules({ events, auth: [], digits: [] }, six)).toEqual({ outputs: [], flags: [], skipped: [] });
    // With one person-week too few, the method says so.
    expect(runAuditRules({ events, auth: [login], digits: [] }, { ...P, correctionsMinPersonWeeks: 7 }).skipped).toEqual([{ subject: 'CORRECTIONS_HIGH', reason: '6 active person-weeks; the site\'s percentile needs 7' }]);
    // Equal bounds: no hour is a working hour.
    const cfg = [ev('991', person(1), '2026-06-02T12:00:00', { configArea: 'RECIPE' })];
    expect(runAuditRules({ events: cfg, auth: [], digits: [] }, { ...P, workingHoursStart: 8, workingHoursEnd: 8 }).flags.map((f) => f.reasons[0].text)).toEqual([
      'A configuration change of RECIPE at 12:00 site time, outside the working hours 08:00 to 08:00',
    ]);
    // Working hours across midnight (22:00 to 06:00): noon is outside them, 23:00 inside.
    const night = { ...P, workingHoursStart: 22, workingHoursEnd: 6 };
    expect(runAuditRules({ events: [...cfg, ev('992', person(1), '2026-06-02T23:00:00', { configArea: 'RECIPE' })], auth: [], digits: [] }, night).flags.map((f) => f.reasons[0].evidence?.[0]?.ref)).toEqual(['batch:x#991']);
    expect(quantileOfSorted([], 0.5)).toBeNaN();
    // The latest week is the latest of all rows, whatever order they come in: an entry of week 1 listed first, or two logins
    // listed newest first.
    const later = ev('999', person(1), '2026-06-09T10:00:00');
    expect(runAuditRules({ events: [later, ...events], auth: [], digits: [] }, six).flags.map((f) => f.subjectRef)).toEqual([person(6)]);
    expect(runAuditRules({ events, auth: [login, logIn('z0', 'acc-z', person(1), '2026-06-03T10:00:00', 'T1')], digits: [] }, six).flags.map((f) => f.subjectRef)).toEqual([person(6)]);
    // Hits of several person-weeks come in person order, and at most 20 corrections are named.
    const many = [1, 2, 3, 4, 5, 6].flatMap((n) => Array.from({ length: [0, 1, 1, 1, 2, 22][n - 1]! + 1 }, (_, k) => ev(`8${String(n)}${String(k).padStart(2, '0')}`, person(n), `2026-06-0${String(n)}T10:${String(k).padStart(2, '0')}:00`, { isCorrection: k > 0 })));
    const half = runAuditRules({ events: [...many].reverse(), auth: [login], digits: [] }, { ...six, correctionsPercentile: 0.5 });
    expect(half.flags.map((f) => [f.subjectRef, f.reasons[0].evidence?.length])).toEqual([[person(5), 3], [person(6), 21]]);
    expect(half.flags[1]?.reasons[0].evidence?.at(-1)).toEqual({ kind: 'AUDIT_EVENT', ref: 'batch:x#8620' });
    // Only the digits that occur are named among the most frequent.
    const fives = Array.from({ length: 20 }, (_, k) => ({ personId: person(1), eventId: String(k + 1), chainKey: 'batch:d', recordedLocal: `2026-06-02T10:${String(k).padStart(2, '0')}:00`, digit: 5 }));
    expect(runAuditRules({ events: [], auth: [], digits: fives }, P).flags[0]?.reasons[0].text).toMatch(/^20 manual entries; the most frequent last digits are 5 \(20\)\. /);
    // Across midnight, 06:00 is already outside the working hours.
    expect(runAuditRules({ events: [ev('993', person(1), '2026-06-02T06:00:00', { configArea: 'RECIPE' })], auth: [], digits: [] }, night).flags).toHaveLength(1);
    // The outputs come in person order, whatever order the rules found them in.
    const order = runAuditRules({ events: [ev('994', person(3), '2026-06-02T10:30:00', { claimedAt: '2026-06-02T10:00:00Z' }), ev('995', person(2), '2026-06-02T23:00:00', { configArea: 'RECIPE' })], auth: [], digits: [] }, P);
    expect(order.flags.map((f) => [f.rule, f.subjectRef])).toEqual([['LATE_ENTRY', person(3)], ['OFF_HOURS_CONFIG', person(2)]]);
    expect(order.outputs.map((o) => o.subjectRef)).toEqual([person(2), person(3)]);
  });
});

describe('the per-person baseline (ATA.BASELINE v1)', () => {
  /** Person 1 makes `perWeek(w)` entries in week w (w = 0 .. weeks - 1), plus one entry in a final week in progress. */
  function weekly(weeks: number, perWeek: (w: number) => number, over: Partial<AuditEvent> = {}): AuditEvent[] {
    const out: AuditEvent[] = [];
    for (let w = 0; w < weeks; w += 1) for (let k = 0; k < perWeek(w); k += 1) out.push(entry(1, w * 7 + 1, k, over));
    out.push(entry(1, weeks * 7 + 1, 0));
    return out;
  }

  it('[DI-53] the baseline flags a week far from the person\'s own trailing weeks, with the week, the metric, the median and the robust z', () => {
    // Weeks 0 to 7: 10, 12, 11, 9, 10, 11, 12, 10 entries; week 8: 40.
    const counts = [10, 12, 11, 9, 10, 11, 12, 10, 40];
    const r = runAuditBaseline({ events: weekly(counts.length, (w) => counts[w]!), auth: [], digits: [] }, BASELINE);
    expect(r.flags).toHaveLength(1);
    const f = r.flags[0]!;
    expect(f).toMatchObject({ subjectKind: 'PERSON', subjectRef: person(1), rule: 'BASELINE_Z', severity: 'ATTENTION' });
    // History of week 8: weeks 0 to 7 (eight weeks); median 10.5, absolute deviations 0.5 (five) and 1.5 (three), so the
    // MAD is 0.5 and z = (40 - 10.5) / (1.4826 x 0.5).
    expect(f.reasons[0].text).toBe(`Audit entries in the site week of 2026-07-27: 40, against a median of 10.5 (MAD 0.5) over the person's 8 trailing weeks; robust z ${((40 - 10.5) / (1.4826 * 0.5)).toFixed(1)} (threshold 3.5)`);
    expect(f.reasons[0].evidence?.[0]).toEqual({ kind: 'BASELINE_WEEK', ref: '2026-07-27|ENTRIES' });
    expect(f.reasons[0].evidence?.length).toBe(21);
    expect(r.outputs).toEqual([expect.objectContaining({ kind: 'AUDIT_BASELINE', subjectKind: 'PERSON', subjectRef: person(1), values: expect.objectContaining({ assessedWeeks: 3, flags: 1, latestWeek: '2026-07-27' }) as unknown })]);
    // A failed-login burst counts too (from the authentication facts).
    const auth: AuthEvent[] = Array.from({ length: 12 }, (_, i) => ({ ref: `authn_attempt:${String(i)}`, accountId: 'acc-1', personId: person(1), terminal: 'T-1', kind: i < 6 ? 'FAILED' : 'FAILED', at: `2026-07-${i < 1 ? '01' : '28'}T05:00:${String(i).padStart(2, '0')}Z`, atLocal: `2026-07-${i < 1 ? '01' : '28'}T05:00:00` }));
    const withLogins = runAuditBaseline({ events: weekly(counts.length, (w) => (w === 8 ? 10 : counts[w]!)), auth, digits: [] }, BASELINE);
    expect(withLogins.flags.map((x) => x.reasons[0].evidence?.[0]?.ref)).toEqual(['2026-07-27|FAILED_LOGINS']);
  });

  it('[DI-53] the baseline gives no flag below 6 weeks of history', () => {
    // Five complete weeks of history before the spike: not assessed, and the method says why.
    const r = runAuditBaseline({ events: weekly(6, (w) => (w === 5 ? 200 : 10)), auth: [], digits: [] }, BASELINE);
    expect(r.flags).toEqual([]);
    expect(r.outputs).toEqual([]);
    expect(r.skipped).toEqual([{ subject: `PERSON ${person(1)}`, reason: '6 complete week(s) of history; the baseline needs 6 before a week it assesses' }]);
    // The synthetic history spans about four weeks: nobody is assessed, nobody is flagged.
    const h = runAuditBaseline(fromHistory(analyticsHistory()), BASELINE);
    expect(h.flags).toEqual([]);
    expect(h.skipped.length).toBe(analyticsHistory().persons.length);
    // Six weeks of history, then the spike: assessed and flagged.
    expect(runAuditBaseline({ events: weekly(7, (w) => (w === 6 ? 200 : 10 + (w % 2))), auth: [], digits: [] }, BASELINE).flags).toHaveLength(1);
  });

  // Mutation campaign at the Phase 7 exit (D-P7-1 item 4): every metric, both directions, the late-entry limit, the
  // order of the input rows and the threshold itself, checked on one history.
  const claimedBefore = (e: AuditEvent, ms: number): AuditEvent => ({ ...e, claimedAt: new Date(Date.parse(e.recordedAt) - ms).toISOString() });
  const login = (who: number, day: number, i: number, kind: AuthEvent['kind']): AuthEvent => {
    const t = new Date(Date.UTC(2026, 5, 1 + day, 6, 0) + i * 1000).toISOString();
    return { ref: `authn_attempt:${String(who)}-${String(day)}-${String(i)}`, accountId: `acc-${String(who)}`, personId: person(who), terminal: 'T-1', kind, at: t, atLocal: t.slice(0, 19) };
  };
  /** Weeks 0 to 7 of June-July 2026 and an entry in week 8 (in progress). Person 1: 5 or 6 entries a week, 1 or 2 of them
   * corrections (6 in week 7), 0 or 1 late (4 in week 7; one more each week exactly at the limit), 0 or 1 failed logins
   * (5 in week 7) and logins and lockouts that are not counted. Person 2: 3 or 4 entries a week, none in week 7. */
  function history(): { events: AuditEvent[]; auth: AuthEvent[] } {
    const events: AuditEvent[] = [];
    const auth: AuthEvent[] = [];
    for (let w = 0; w < 8; w += 1) {
      const day = w * 7 + 1;
      if (w < 7) for (let k = 0; k < 3 + (w % 2); k += 1) events.push(entry(2, day, k));
      const n = 5 + (w % 2);
      const corrections = w === 7 ? 6 : 1 + (w % 2);
      const late = w === 7 ? 4 : w % 2;
      for (let k = 0; k < n; k += 1) {
        let e = entry(1, day, k, { isCorrection: k < corrections });
        if (k < late) e = claimedBefore(e, 15 * 60_000 + 1);
        else if (k === n - 1) e = claimedBefore(e, 15 * 60_000);
        events.push(e);
      }
      for (let i = 0; i < (w === 7 ? 5 : w % 2); i += 1) auth.push(login(1, day, i, 'FAILED'));
      for (let i = 0; i < (w === 7 ? 30 : 2); i += 1) auth.push(login(1, day, 100 + i, i % 3 === 0 ? 'LOCKOUT' : 'LOGIN'));
    }
    events.push(entry(1, 8 * 7 + 1, 0));
    return { events, auth };
  }

  it('[DI-53] the baseline assesses each metric of each person in both directions, from rows in any order, and flags only above the threshold', () => {
    const { events, auth } = history();
    // The rows come newest first and person 2 first: the method orders them itself.
    const input: AuditInput = { events: [...events].reverse(), auth: [...auth].reverse(), digits: [] };
    const r = ATA_BASELINE.run(input, BASELINE, null);
    expect(ATA_BASELINE).toMatchObject({ id: 'ATA.BASELINE', versions: [1] });
    expect(r).toEqual(runAuditBaseline({ events, auth, digits: [] }, BASELINE));
    expect(r.skipped).toEqual([]);
    expect(r.outputs).toEqual([
      { subjectKind: 'PERSON', subjectRef: person(1), kind: 'AUDIT_BASELINE',
        values: { assessedWeeks: 2, flags: 3, notAssessable: 0, latestWeek: '2026-07-20', 'z.ENTRIES': 1.861751642330913, 'z.CORRECTIONS': 9.308758211654565, 'z.LATE_ENTRIES': 7.447006569323652, 'z.FAILED_LOGINS': 9.308758211654565 },
        reasons: [{ code: 'BASELINE', text: '2 week(s) assessed against the person\'s own trailing weeks; 3 above the threshold' }] },
      { subjectKind: 'PERSON', subjectRef: person(2), kind: 'AUDIT_BASELINE',
        values: { assessedWeeks: 2, flags: 1, notAssessable: 6, latestWeek: '2026-07-20', 'z.ENTRIES': -5.585254926992739 },
        reasons: [{ code: 'BASELINE', text: '2 week(s) assessed against the person\'s own trailing weeks; 1 above the threshold' }] },
    ]);
    const ids = (from: number, n: number) => Array.from({ length: n }, (_, k) => `batch:b1#1050000${String(from + k)}`);
    expect(r.flags.map((f) => [f.subjectRef, f.rule, f.severity, f.reasons[0].code, f.reasons[0].text, f.reasons[0].weight, f.reasons[0].evidence])).toEqual([
      [person(1), 'BASELINE_Z', 'ATTENTION', 'BASELINE_Z', 'Corrections in the site week of 2026-07-20: 6, against a median of 1 (MAD 0) over the person\'s 7 trailing weeks; robust z 9.3 (threshold 3.5)', 9.308758211654565,
        [{ kind: 'BASELINE_WEEK', ref: '2026-07-20|CORRECTIONS' }, ...ids(0, 6).map((ref) => ({ kind: 'AUDIT_EVENT', ref }))]],
      [person(1), 'BASELINE_Z', 'ATTENTION', 'BASELINE_Z', 'Late entries in the site week of 2026-07-20: 4, against a median of 0 (MAD 0) over the person\'s 7 trailing weeks; robust z 7.4 (threshold 3.5)', 7.447006569323652,
        [{ kind: 'BASELINE_WEEK', ref: '2026-07-20|LATE_ENTRIES' }, ...ids(0, 4).map((ref) => ({ kind: 'AUDIT_EVENT', ref }))]],
      [person(1), 'BASELINE_Z', 'ATTENTION', 'BASELINE_Z', 'Failed logins in the site week of 2026-07-20: 5, against a median of 0 (MAD 0) over the person\'s 7 trailing weeks; robust z 9.3 (threshold 3.5)', 9.308758211654565,
        [{ kind: 'BASELINE_WEEK', ref: '2026-07-20|FAILED_LOGINS' }, ...[0, 1, 2, 3, 4].map((i) => ({ kind: 'AUTH_EVENT', ref: `authn_attempt:1-50-${String(i)}` }))]],
      // A week without activity is a count of zero, and a drop is assessed as a rise is.
      [person(2), 'BASELINE_Z', 'ATTENTION', 'BASELINE_Z', 'Audit entries in the site week of 2026-07-20: 0, against a median of 3 (MAD 0) over the person\'s 7 trailing weeks; robust z -5.6 (threshold 3.5)', -5.585254926992739,
        [{ kind: 'BASELINE_WEEK', ref: '2026-07-20|ENTRIES' }]],
    ]);
    // A |z| equal to the threshold is not above it: the two at 9.3 then stay unflagged, and nothing else is above it.
    expect(runAuditBaseline(input, { ...BASELINE, robustZ: 9.308758211654565 }).flags).toEqual([]);
    expect(runAuditBaseline(input, { ...BASELINE, robustZ: 9.3 }).flags.map((f) => f.reasons[0].evidence?.[0]?.ref)).toEqual(['2026-07-20|CORRECTIONS', '2026-07-20|FAILED_LOGINS']);
    // A person's history starts at their first activity of any kind: a login a week before their first entry.
    const early = runAuditBaseline({ events: events.filter((e) => e.personId === person(1)), auth: [login(1, -6, 0, 'LOGIN')], digits: [] }, BASELINE);
    expect(early.outputs[0]?.values).toMatchObject({ assessedWeeks: 3, latestWeek: '2026-07-20' });
    // Entries in time order whatever their ids, and logins at one instant by their reference.
    const relabelled = events.map((e) => (e.personId === person(1) && e.recordedLocal.startsWith('2026-07-21') ? { ...e, eventId: String(900 - Number(e.eventId.slice(-1))) } : e));
    const sameInstant = auth.map((a) => (a.kind === 'FAILED' && a.atLocal.startsWith('2026-07-21') ? { ...a, at: '2026-07-21T06:00:00Z', atLocal: '2026-07-21T06:00:00' } : a));
    const reordered = runAuditBaseline({ events: [...relabelled].reverse(), auth: [...sameInstant].reverse(), digits: [] }, BASELINE);
    expect(reordered.flags.map((f) => f.reasons[0].evidence?.slice(1).map((e) => e.ref))).toEqual([
      ['batch:b1#900', 'batch:b1#899', 'batch:b1#898', 'batch:b1#897', 'batch:b1#896', 'batch:b1#895'],
      ['batch:b1#900', 'batch:b1#899', 'batch:b1#898', 'batch:b1#897'],
      [0, 1, 2, 3, 4].map((i) => `authn_attempt:1-50-${String(i)}`),
      [],
    ]);
    // The outputs come in person order even when person 2 is active first.
    const p2first = events.map((e) => (e.personId === person(2) ? { ...e, recordedAt: new Date(Date.parse(e.recordedAt) - 3_600_000).toISOString() } : e));
    expect(runAuditBaseline({ events: p2first, auth, digits: [] }, BASELINE).outputs.map((o) => o.subjectRef)).toEqual([person(1), person(2)]);
    // The latest week's z of a metric is given only when that week is assessable for it: a single failed login in week 2
    // varies the 4 trailing weeks of week 6, not those of week 7.
    const steady = runAuditBaseline({ events: weekly(8, () => 5), auth: [login(1, 15, 0, 'FAILED')], digits: [] }, { ...BASELINE, trailingWeeks: 4 });
    expect(steady.outputs[0]?.values).toEqual({ assessedWeeks: 2, flags: 0, notAssessable: 7, latestWeek: '2026-07-20' });
    expect(BASELINE_METRICS).toEqual(['ENTRIES', 'CORRECTIONS', 'LATE_ENTRIES', 'FAILED_LOGINS']);
    expect(median([])).toBeNaN();
    expect(median([3, 1, 2])).toBe(2);
  });

  it('the robust z uses the MAD, falls back to the mean absolute deviation, and gives none without variation (D-6A-4-6)', () => {
    expect(robustZ(14, [10, 11, 12, 10, 11, 12])).toMatchObject({ median: 11, mad: 1, z: 3 / 1.4826 });
    // MAD zero (most weeks equal): the mean absolute deviation from the median is the scale.
    const r = robustZ(5, [1, 1, 1, 1, 1, 3]);
    expect(r).toMatchObject({ median: 1, mad: 0 });
    expect(r!.z).toBeCloseTo(4 / (1.2533 * (2 / 6)), 12);
    expect(robustZ(9, [2, 2, 2, 2, 2, 2])).toBeNull();
  });
});
