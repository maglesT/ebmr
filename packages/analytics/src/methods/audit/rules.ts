/**
 * ATA.RULES v1: audit-trail anomaly rules (slice 6A-4; decision 0016 item 8; D-6A-12; draft control DI-53). Each rule
 * points QA data-integrity review at audit-trail entries worth a look and shows why, with the entries behind it. A flag
 * is never an accusation or a finding: it is about a PERSON, readable only with ANALYTICS.DI_REVIEW, and it closes only
 * with QA's disposition; a real problem goes into the deviation process as usual.
 *
 * The rules (thresholds are the version's parameters; a site changes them only with a new method version):
 *   LATE_ENTRY         an entry recorded more than lateEntryMinutes after the time it claims (or its source time);
 *   BACK_DATED         an entry that claims a time more than backDatedMinutes before the step's previous entry (by
 *                      recording order); a late entry is reported by LATE_ENTRY only (D-6A-4-3);
 *   CORRECTIONS_HIGH   a person's corrections in a completed site week above the site's correctionsPercentile of all
 *                      active person-weeks (at least correctionsMinPersonWeeks of them; D-6A-4-4);
 *   TWO_TERMINALS      one account logged in on two terminals within twoTerminalsMinutes;
 *   TOO_REGULAR        a terminal-digit chi-square test over a person's manual entries (at least digitTestMinEntries)
 *                      significant at digitTestAlpha;
 *   REPEAT_UNTIL_PASS  repeatFailures or more failed attempts of the same item in a step before a passing attempt, with
 *                      no deviation linked to the batch;
 *   OFF_HOURS_CONFIG   a configuration change outside the site's working hours (site wall clock).
 *
 * One flag per hit. The first evidence of a flag's first reason is its key: the entry, the login, the week or the
 * test it is about, so a later run that finds the same hit raises a flag with the same key (D-6A-4-5). The output is
 * one AUDIT_RULE_HIT per person with a hit, counting the hits per rule.
 */
import { chiSquareQuantile } from '../../numeric/quantiles.ts';
import type { Method, MethodResult, Parameters, Skipped } from '../../method.ts';
import type { Evidence, FlagDraft, OutputDraft, Reason, Severity } from '../../types.ts';
import { type AuditEvent, type AuditInput, byText, compareIds, eventRef, instantMs, localHour, siteWeek } from './input.ts';

export type AuditRule = 'LATE_ENTRY' | 'BACK_DATED' | 'CORRECTIONS_HIGH' | 'TWO_TERMINALS' | 'TOO_REGULAR' | 'REPEAT_UNTIL_PASS' | 'OFF_HOURS_CONFIG';
export const AUDIT_RULES: readonly AuditRule[] = ['LATE_ENTRY', 'BACK_DATED', 'CORRECTIONS_HIGH', 'TWO_TERMINALS', 'TOO_REGULAR', 'REPEAT_UNTIL_PASS', 'OFF_HOURS_CONFIG'];

export type AuditRulesParameters = Parameters & {
  readonly lateEntryMinutes: number;
  readonly backDatedMinutes: number;
  readonly correctionsPercentile: number;
  readonly correctionsMinPersonWeeks: number;
  readonly twoTerminalsMinutes: number;
  readonly digitTestMinEntries: number;
  readonly digitTestAlpha: number;
  readonly repeatFailures: number;
  readonly workingHoursStart: number;
  readonly workingHoursEnd: number;
};

/** At most this many entries are named as evidence of one flag (the reason text gives the full count). */
export const MAX_EVIDENCE = 20;

interface Hit {
  readonly rule: AuditRule;
  readonly personId: string;
  readonly severity: Severity;
  readonly reason: Reason;
}

const MINUTE = 60_000;

const minutes = (ms: number): string => {
  const m = ms / MINUTE;
  return Number.isInteger(m) ? String(m) : m.toFixed(1);
};

function eventEvidence(e: AuditEvent): Evidence[] {
  return [{ kind: 'AUDIT_EVENT', ref: eventRef(e) }, ...(e.batchId ? [{ kind: 'BATCH', ref: e.batchId }] : [])];
}

/** Recording order: instant, then audit id. */
function byRecorded(a: AuditEvent, b: AuditEvent): number {
  return instantMs(a.recordedAt) - instantMs(b.recordedAt) || compareIds(a.eventId, b.eventId);
}

/** The value at quantile p of sorted xs (linear interpolation between order statistics, R's type 7). */
export function quantileOfSorted(xs: readonly number[], p: number): number {
  if (xs.length === 0) return Number.NaN;
  const h = (xs.length - 1) * p;
  const lo = Math.floor(h);
  const a = xs[lo] as number;
  const b = xs[Math.min(lo + 1, xs.length - 1)] as number;
  return a + (h - lo) * (b - a);
}

function isLate(e: AuditEvent, p: AuditRulesParameters): boolean {
  return e.claimedAt !== null && instantMs(e.recordedAt) - instantMs(e.claimedAt) > p.lateEntryMinutes * MINUTE;
}

function lateEntries(events: readonly AuditEvent[], p: AuditRulesParameters): Hit[] {
  return events.filter((e) => isLate(e, p)).map((e) => {
    const lag = instantMs(e.recordedAt) - instantMs(e.claimedAt as string);
    return {
      rule: 'LATE_ENTRY', personId: e.personId, severity: 'INFO',
      reason: {
        code: 'LATE_ENTRY',
        text: `${e.field ?? 'An entry'}${e.step ? ` in ${e.step}` : ''} was recorded ${minutes(lag)} minutes after the time it claims (threshold ${String(p.lateEntryMinutes)} minutes)`,
        weight: lag / MINUTE,
        evidence: eventEvidence(e),
      },
    };
  });
}

function backDated(events: readonly AuditEvent[], p: AuditRulesParameters): Hit[] {
  const steps = new Map<string, AuditEvent[]>();
  for (const e of events) {
    if (e.batchId === null || e.step === null || e.field === null) continue;
    const k = `${e.batchId}|${e.step}`;
    steps.set(k, [...(steps.get(k) ?? []), e]);
  }
  const hits: Hit[] = [];
  for (const k of [...steps.keys()].sort(byText)) {
    const list = [...(steps.get(k) as AuditEvent[])].sort(byRecorded);
    for (let i = 1; i < list.length; i += 1) {
      const e = list[i] as AuditEvent;
      const prev = list[i - 1] as AuditEvent;
      if (e.claimedAt === null || isLate(e, p)) continue;
      const before = instantMs(prev.claimedAt ?? prev.recordedAt) - instantMs(e.claimedAt);
      if (before <= p.backDatedMinutes * MINUTE) continue;
      hits.push({
        rule: 'BACK_DATED', personId: e.personId, severity: 'INFO',
        reason: {
          code: 'BACK_DATED',
          text: `${e.field ?? 'An entry'} in ${e.step ?? ''} claims a time ${minutes(before)} minutes before the step's previous entry (${prev.field ?? 'an entry'}), which was recorded first (tolerance ${String(p.backDatedMinutes)} minutes)`,
          weight: before / MINUTE,
          evidence: [...eventEvidence(e), { kind: 'AUDIT_EVENT', ref: eventRef(prev) }],
        },
      });
    }
  }
  return hits;
}

/** The site weeks in the input and the latest one (in progress, so not assessed). */
function weeksOf(input: AuditInput): { latest: string | null } {
  let latest: string | null = null;
  for (const e of input.events) {
    const w = siteWeek(e.recordedLocal);
    if (latest === null || w > latest) latest = w;
  }
  for (const a of input.auth) {
    const w = siteWeek(a.atLocal);
    if (latest === null || w > latest) latest = w;
  }
  return { latest };
}

function correctionsHigh(input: AuditInput, p: AuditRulesParameters, skipped: Skipped[]): Hit[] {
  const { latest } = weeksOf(input);
  const weeks = new Map<string, { personId: string; week: string; corrections: AuditEvent[] }>();
  for (const e of input.events) {
    const week = siteWeek(e.recordedLocal);
    if (latest !== null && week >= latest) continue;
    const k = `${e.personId}|${week}`;
    const pw = weeks.get(k) ?? { personId: e.personId, week, corrections: [] };
    if (e.isCorrection) pw.corrections.push(e);
    weeks.set(k, pw);
  }
  if (weeks.size < p.correctionsMinPersonWeeks) {
    if (weeks.size > 0) skipped.push({ subject: 'CORRECTIONS_HIGH', reason: `${String(weeks.size)} active person-weeks; the site's percentile needs ${String(p.correctionsMinPersonWeeks)}` });
    return [];
  }
  const counts = [...weeks.values()].map((w) => w.corrections.length).sort((a, b) => a - b);
  const limit = quantileOfSorted(counts, p.correctionsPercentile);
  const hits: Hit[] = [];
  for (const k of [...weeks.keys()].sort(byText)) {
    const w = weeks.get(k) as { personId: string; week: string; corrections: AuditEvent[] };
    const n = w.corrections.length;
    if (n === 0 || n <= limit) continue;
    const listed = [...w.corrections].sort(byRecorded).slice(0, MAX_EVIDENCE);
    hits.push({
      rule: 'CORRECTIONS_HIGH', personId: w.personId, severity: 'ATTENTION',
      reason: {
        code: 'CORRECTIONS_HIGH',
        text: `${String(n)} corrections in the site week of ${w.week}, above the site's ${String(Math.round(p.correctionsPercentile * 1000) / 10)}th percentile of ${limit.toFixed(1)} over ${String(counts.length)} active person-weeks`,
        weight: n,
        evidence: [{ kind: 'WEEK', ref: w.week }, ...listed.map((e) => ({ kind: 'AUDIT_EVENT', ref: eventRef(e) }))],
      },
    });
  }
  return hits;
}

function twoTerminals(input: AuditInput, p: AuditRulesParameters): Hit[] {
  const byAccount = new Map<string, { at: number; terminal: string; ref: string; personId: string }[]>();
  for (const a of input.auth) {
    if (a.kind !== 'LOGIN' || a.terminal === null) continue;
    byAccount.set(a.accountId, [...(byAccount.get(a.accountId) ?? []), { at: instantMs(a.at), terminal: a.terminal, ref: a.ref, personId: a.personId }]);
  }
  const hits: Hit[] = [];
  for (const account of [...byAccount.keys()].sort(byText)) {
    const list = [...(byAccount.get(account) ?? [])].sort((x, y) => x.at - y.at || byText(x.ref, y.ref));
    for (let i = 1; i < list.length; i += 1) {
      const a = list[i - 1] as (typeof list)[number];
      const b = list[i] as (typeof list)[number];
      const gap = b.at - a.at;
      if (a.terminal === b.terminal || gap > p.twoTerminalsMinutes * MINUTE) continue;
      hits.push({
        rule: 'TWO_TERMINALS', personId: b.personId, severity: 'ATTENTION',
        reason: {
          code: 'TWO_TERMINALS',
          text: `The account logged in on ${a.terminal} and then on ${b.terminal} within ${String(Math.round(gap / 1000))} seconds (threshold ${String(p.twoTerminalsMinutes)} minutes)`,
          weight: gap / 1000,
          evidence: [{ kind: 'AUTH_EVENT', ref: b.ref }, { kind: 'AUTH_EVENT', ref: a.ref }],
        },
      });
    }
  }
  return hits;
}

function tooRegular(input: AuditInput, p: AuditRulesParameters, skipped: Skipped[]): Hit[] {
  const byPerson = new Map<string, AuditInput['digits'][number][]>();
  for (const d of input.digits) byPerson.set(d.personId, [...(byPerson.get(d.personId) ?? []), d]);
  const critical = chiSquareQuantile(1 - p.digitTestAlpha, 9);
  const hits: Hit[] = [];
  for (const personId of [...byPerson.keys()].sort(byText)) {
    const list = [...(byPerson.get(personId) ?? [])].sort((a, b) => byText(a.recordedLocal, b.recordedLocal) || compareIds(a.eventId, b.eventId));
    const n = list.length;
    if (n < p.digitTestMinEntries) {
      skipped.push({ subject: `PERSON ${personId} TOO_REGULAR`, reason: `${String(n)} manual entries; the terminal-digit test needs ${String(p.digitTestMinEntries)}` });
      continue;
    }
    const observed = Array.from({ length: 10 }, () => 0);
    for (const d of list) observed[d.digit] = (observed[d.digit] ?? 0) + 1;
    const expected = n / 10;
    const chi2 = observed.reduce((s, o) => s + ((o - expected) * (o - expected)) / expected, 0);
    if (!(chi2 > critical)) continue;
    const common = observed.map((o, digit) => ({ digit, o })).filter((x) => x.o > 0).sort((a, b) => b.o - a.o || a.digit - b.digit).slice(0, 3);
    const last = list[list.length - 1] as AuditInput['digits'][number];
    hits.push({
      rule: 'TOO_REGULAR', personId, severity: 'ATTENTION',
      reason: {
        code: 'TOO_REGULAR',
        text: `${String(n)} manual entries; the most frequent last digits are ${common.map((c) => `${String(c.digit)} (${String(c.o)})`).join(', ')}. Terminal-digit chi-square ${chi2.toFixed(1)} on 9 degrees of freedom, above ${critical.toFixed(2)} (significance ${String(p.digitTestAlpha)})`,
        weight: chi2,
        evidence: [
          { kind: 'DIGIT_TEST', ref: `${personId}@${siteWeek(last.recordedLocal)}` },
          ...list.slice(-MAX_EVIDENCE).map((d) => ({ kind: 'AUDIT_EVENT', ref: eventRef(d) })),
        ],
      },
    });
  }
  return hits;
}

function repeatUntilPass(events: readonly AuditEvent[], p: AuditRulesParameters): Hit[] {
  const items = new Map<string, AuditEvent[]>();
  for (const e of events) {
    if (e.batchId === null || e.step === null || e.field === null || e.attempt === null || e.failed === null || e.isCorrection) continue;
    const k = `${e.batchId}|${e.step}|${e.field}`;
    items.set(k, [...(items.get(k) ?? []), e]);
  }
  const hits: Hit[] = [];
  for (const k of [...items.keys()].sort(byText)) {
    const list = [...(items.get(k) as AuditEvent[])].sort((a, b) => (a.attempt as number) - (b.attempt as number) || byRecorded(a, b));
    if (list.some((e) => e.deviationLinked)) continue;
    const failed: AuditEvent[] = [];
    for (const e of list) {
      if (e.failed === true) {
        if (!failed.some((f) => f.attempt === e.attempt)) failed.push(e);
        continue;
      }
      if (failed.length >= p.repeatFailures) {
        hits.push({
          rule: 'REPEAT_UNTIL_PASS', personId: e.personId, severity: 'ATTENTION',
          reason: {
            code: 'REPEAT_UNTIL_PASS',
            text: `${e.field ?? ''} in ${e.step ?? ''}: ${String(failed.length)} failed attempts (${failed.map((f) => String(f.attempt)).join(', ')}) before a pass at attempt ${String(e.attempt)}, with no deviation linked to the batch`,
            weight: failed.length,
            evidence: [...eventEvidence(e), ...failed.slice(0, MAX_EVIDENCE).map((f) => ({ kind: 'AUDIT_EVENT', ref: eventRef(f) }))],
          },
        });
      }
      break;
    }
  }
  return hits;
}

function offHoursConfig(events: readonly AuditEvent[], p: AuditRulesParameters): Hit[] {
  const working = (h: number): boolean => (p.workingHoursStart <= p.workingHoursEnd ? h >= p.workingHoursStart && h < p.workingHoursEnd : h >= p.workingHoursStart || h < p.workingHoursEnd);
  const hh = (h: number): string => `${String(h).padStart(2, '0')}:00`;
  return events.filter((e) => e.configArea !== null && !working(localHour(e.recordedLocal))).map((e) => ({
    rule: 'OFF_HOURS_CONFIG', personId: e.personId, severity: 'INFO',
    reason: {
      code: 'OFF_HOURS_CONFIG',
      text: `A configuration change of ${e.configArea ?? ''}${e.tableName ? ` (${e.tableName})` : ''} at ${e.recordedLocal.slice(11, 16)} site time, outside the working hours ${hh(p.workingHoursStart)} to ${hh(p.workingHoursEnd)}`,
      evidence: [{ kind: 'AUDIT_EVENT', ref: eventRef(e) }],
    },
  }));
}

/** Every hit of every rule (deterministic order: rule, then each rule's own order). */
export function auditRuleHits(input: AuditInput, p: AuditRulesParameters, skipped: Skipped[] = []): Hit[] {
  const events = [...input.events].sort(byRecorded);
  return [
    ...lateEntries(events, p),
    ...backDated(events, p),
    ...correctionsHigh(input, p, skipped),
    ...twoTerminals(input, p),
    ...tooRegular(input, p, skipped),
    ...repeatUntilPass(events, p),
    ...offHoursConfig(events, p),
  ];
}

export function runAuditRules(input: AuditInput, p: AuditRulesParameters): MethodResult {
  const skipped: Skipped[] = [];
  const hits = auditRuleHits(input, p, skipped);
  const flags: FlagDraft[] = hits.map((h) => ({ subjectKind: 'PERSON', subjectRef: h.personId, rule: h.rule, severity: h.severity, reasons: [h.reason] }));
  const persons = [...new Set(hits.map((h) => h.personId))].sort(byText);
  const outputs: OutputDraft[] = persons.map((personId) => {
    const mine = hits.filter((h) => h.personId === personId);
    const values: Record<string, number> = { events: input.events.filter((e) => e.personId === personId).length };
    for (const r of AUDIT_RULES) values[r] = mine.filter((h) => h.rule === r).length;
    return {
      subjectKind: 'PERSON', subjectRef: personId, kind: 'AUDIT_RULE_HIT', values,
      reasons: [{ code: 'RULE_HITS', text: `${String(mine.length)} audit-trail rule hit(s) for data-integrity review: ${AUDIT_RULES.filter((r) => (values[r] ?? 0) > 0).map((r) => `${r} ${String(values[r])}`).join(', ')}` }],
    };
  });
  return { outputs, flags, skipped };
}

export const ATA_RULES: Method<AuditInput, AuditRulesParameters> = { id: 'ATA.RULES', versions: [1], run: (input, params) => runAuditRules(input, params) };
