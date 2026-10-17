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
import { defaultParameters, outputHash, parameterProblems } from '../src/index.ts';
import {
  instantMs,
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

  it('the robust z uses the MAD, falls back to the mean absolute deviation, and gives none without variation (D-6A-4-6)', () => {
    expect(robustZ(14, [10, 11, 12, 10, 11, 12])).toMatchObject({ median: 11, mad: 1, z: 3 / 1.4826 });
    // MAD zero (most weeks equal): the mean absolute deviation from the median is the scale.
    const r = robustZ(5, [1, 1, 1, 1, 1, 3]);
    expect(r).toMatchObject({ median: 1, mad: 0 });
    expect(r!.z).toBeCloseTo(4 / (1.2533 * (2 / 6)), 12);
    expect(robustZ(9, [2, 2, 2, 2, 2, 2])).toBeNull();
  });
});
