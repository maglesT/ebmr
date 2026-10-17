/**
 * REVIEW.PRIORITY v1: the review priority of a GMP batch record (slice 6A-5; decision 0016 item 9; D-6A-13, D-6A-14,
 * D-6A-5-*; draft control PR-61). A transparent weighted sum: each term is a count of something worth the reviewer's
 * attention, times its weight, a capped term counting at most its cap. The weights, caps and thresholds are the
 * version's parameters, so they change only with a new method version under a change record (DI-52).
 *
 *   EXCEPTION_CRITICAL, _MAJOR, _MINOR  the record's exceptions by severity (register CRITICAL, ACTION, ALERT; D-6A-5-1)
 *   NEAR_LIMIT       a critical value (the last attempt of its item; each reading of a series) inside its limits and
 *                    within nearLimitShare of the range from either limit, compared exactly on the decimal text; a value
 *                    without both limits has no range and is not counted (D-6A-5-5)
 *   CORRECTION       an accepted post-entry correction (CORRECT_ENTRY, VOID_ATTEMPT, INVALIDATE_RESULT)
 *   OPEN_AUDIT_FLAG  an ATA.RULES hit whose evidence names an entry of the record, found over the same snapshot's audit
 *                    facts with ATA.RULES version 1's thresholds (D-6A-5-4); counted, never named (DI-53)
 *   NEW_OPERATOR     a person new to the product worked on the record (once, however many)
 *   NEW_EQUIPMENT    a unit new to the site's GMP records or maintained in the 7 days before its use (once)
 *   STEP_DURATION    a step whose duration has |robust z| above durationZ against the same product, MBR family and step
 *                    of every GMP record in the input (median and MAD, as ATA.BASELINE scales them), when at least
 *                    durationMinBatches records ran it
 *   DEVIATION        a deviation linked to the record
 *
 * One REVIEW_PRIORITY output per record (subject BATCH): the score, every term's count and points, the review outcome so
 * far (kept for learned weights later; D-6A-20), and the top `topReasons` terms as its reasons (the larger points first,
 * then the order above). It raises no flag: it orders the queue and never skips, narrows or completes a review (PR-61).
 */
import type { Method, MethodResult, Parameters, Skipped } from '../../method.ts';
import type { DecimalText } from '../../numeric/from-decimal.ts';
import { defaultParameters } from '../../registry.ts';
import type { Evidence, OutputDraft, Reason } from '../../types.ts';
import { robustZ } from '../audit/baseline.ts';
import { byText, eventRef, instantMs } from '../audit/input.ts';
import { auditRuleHits, type AuditRulesParameters } from '../audit/rules.ts';
import type { ReviewInput, ReviewRecord, ReviewStep, ReviewValue } from './input.ts';

export type PriorityTerm =
  | 'EXCEPTION_CRITICAL'
  | 'EXCEPTION_MAJOR'
  | 'EXCEPTION_MINOR'
  | 'NEAR_LIMIT'
  | 'CORRECTION'
  | 'OPEN_AUDIT_FLAG'
  | 'NEW_OPERATOR'
  | 'NEW_EQUIPMENT'
  | 'STEP_DURATION'
  | 'DEVIATION';
export const PRIORITY_TERMS: readonly PriorityTerm[] = [
  'EXCEPTION_CRITICAL', 'EXCEPTION_MAJOR', 'EXCEPTION_MINOR', 'NEAR_LIMIT', 'CORRECTION', 'OPEN_AUDIT_FLAG', 'NEW_OPERATOR', 'NEW_EQUIPMENT', 'STEP_DURATION', 'DEVIATION',
];
export type CappedTerm = 'NEAR_LIMIT' | 'CORRECTION' | 'STEP_DURATION';

export type ReviewPriorityParameters = Parameters & {
  readonly weights: Readonly<Record<PriorityTerm, number>>;
  readonly caps: Readonly<Record<CappedTerm, number>>;
  readonly nearLimitShare: number;
  readonly durationZ: number;
  readonly durationMinBatches: number;
  readonly topReasons: number;
};

/** The audit-trail thresholds the OPEN_AUDIT_FLAG term uses: ATA.RULES version 1's (D-6A-5-4). */
const AUDIT_RULES_V1 = defaultParameters('ATA.RULES') as AuditRulesParameters;
/** Evidence named per reason, at most. */
const MAX_EVIDENCE = 5;
const MINUTE = 60_000;

/** One term of one record: how many, and the points they give (capped terms count at most their cap). */
export interface TermScore {
  readonly term: PriorityTerm;
  readonly count: number;
  readonly points: number;
  readonly evidence: readonly Evidence[];
}

// ---------------------------------------------------------------------------------------------
// Values near a limit (exact decimal comparison)
// ---------------------------------------------------------------------------------------------

const fraction = (t: string): number => {
  const i = t.indexOf('.');
  return i < 0 ? 0 : t.length - i - 1;
};
/** Decimal text as an integer at `scale` fraction digits (exact). */
function scaled(t: DecimalText, scale: number): bigint {
  const neg = t.startsWith('-');
  const [whole, frac = ''] = (neg ? t.slice(1) : t).split('.');
  const n = BigInt(`${whole ?? '0'}${frac.padEnd(scale, '0')}`);
  return neg ? -n : n;
}
const PPM = 1_000_000n;

/**
 * Whether `value` is inside [lower, upper] and within `share` of the range from either limit, exactly (the share is
 * taken to the millionth). Null when the value has no two-sided range (no limit, one limit, or upper not above lower).
 */
export function nearLimit(value: DecimalText, lower: DecimalText | null, upper: DecimalText | null, share: number): boolean | null {
  if (lower === null || upper === null) return null;
  const scale = Math.max(fraction(value), fraction(lower), fraction(upper));
  const [v, lo, hi] = [scaled(value, scale), scaled(lower, scale), scaled(upper, scale)];
  if (hi <= lo) return null;
  if (v < lo || v > hi) return false;
  const band = BigInt(Math.round(share * 1_000_000)) * (hi - lo);
  return (v - lo) * PPM <= band || (hi - v) * PPM <= band;
}

// ---------------------------------------------------------------------------------------------
// Step durations
// ---------------------------------------------------------------------------------------------

interface Duration {
  readonly batchId: string;
  readonly key: string;
  readonly step: string;
  readonly minutes: number;
}

/** Each record's step durations (first start to last end over its units), per product, family and step. */
function durations(steps: readonly ReviewStep[]): Duration[] {
  const spans = new Map<string, { s: ReviewStep; start: number; end: number }>();
  for (const s of steps) {
    const id = `${s.batchId}|${s.step}`;
    const [start, end] = [instantMs(s.startedAt), instantMs(s.endedAt)];
    const span = spans.get(id);
    if (!span) spans.set(id, { s, start, end });
    else spans.set(id, { s: span.s, start: Math.min(span.start, start), end: Math.max(span.end, end) });
  }
  const out: Duration[] = [];
  for (const { s, start, end } of spans.values()) {
    if (end < start) continue;
    out.push({ batchId: s.batchId, key: `${s.product}|${s.family}|${s.step}`, step: s.step, minutes: (end - start) / MINUTE });
  }
  return out.sort((a, b) => byText(a.key, b.key) || byText(a.batchId, b.batchId));
}

// ---------------------------------------------------------------------------------------------
// The score
// ---------------------------------------------------------------------------------------------

const plural = (n: number, one: string, many = `${one}s`): string => `${String(n)} ${n === 1 ? one : many}`;
const each = (w: number): string => `${String(w)} point${w === 1 ? '' : 's'} each`;
const cap = (c: number): string => `, counted up to ${String(c)}`;

function describe(t: TermScore, p: ReviewPriorityParameters): string {
  const w = p.weights[t.term];
  switch (t.term) {
    case 'EXCEPTION_CRITICAL': return `${plural(t.count, 'critical exception')} (${each(w)})`;
    case 'EXCEPTION_MAJOR': return `${plural(t.count, 'major exception')} (action level; ${each(w)})`;
    case 'EXCEPTION_MINOR': return `${plural(t.count, 'minor exception')} (alert level; ${each(w)})`;
    case 'NEAR_LIMIT':
      return `${plural(t.count, 'critical value')} within ${String(Math.round(p.nearLimitShare * 100))} % of the range from a limit (${each(w)}${cap(p.caps.NEAR_LIMIT)})`;
    case 'CORRECTION': return `${plural(t.count, 'correction')} after entry (${each(w)}${cap(p.caps.CORRECTION)})`;
    case 'OPEN_AUDIT_FLAG':
      return `${plural(t.count, 'audit-trail rule hit')} on this record's entries (${each(w)}; the details are for data-integrity review)`;
    case 'NEW_OPERATOR': return `${plural(t.count, 'person')} new to the product worked on this record (${String(w)} points once)`;
    case 'NEW_EQUIPMENT': return `${plural(t.count, 'unit')} new or recently maintained (${String(w)} points once)`;
    case 'STEP_DURATION':
      return `${plural(t.count, 'step')} of unusual duration (|z| above ${String(p.durationZ)} against the product's records; ${each(w)}${cap(p.caps.STEP_DURATION)})`;
    case 'DEVIATION': return `${plural(t.count, 'linked deviation')} (${each(w)})`;
  }
}

function termScore(term: PriorityTerm, count: number, p: ReviewPriorityParameters, evidence: readonly Evidence[] = []): TermScore {
  const w = p.weights[term];
  const counted = term === 'NEW_OPERATOR' || term === 'NEW_EQUIPMENT' ? Math.min(count, 1)
    : term === 'NEAR_LIMIT' || term === 'CORRECTION' || term === 'STEP_DURATION' ? Math.min(count, p.caps[term]) : count;
  return { term, count, points: counted * w, evidence: evidence.slice(0, MAX_EVIDENCE) };
}

/** The terms of one record, given what the shared inputs say about it. */
export function recordTerms(
  r: ReviewRecord,
  extra: { nearLimit: readonly string[]; auditHits: number; unusualSteps: readonly string[] },
  p: ReviewPriorityParameters,
): TermScore[] {
  return [
    termScore('EXCEPTION_CRITICAL', r.exceptionsCritical, p),
    termScore('EXCEPTION_MAJOR', r.exceptionsMajor, p),
    termScore('EXCEPTION_MINOR', r.exceptionsMinor, p),
    termScore('NEAR_LIMIT', extra.nearLimit.length, p, extra.nearLimit.map((ref) => ({ kind: 'ITEM', ref }))),
    termScore('CORRECTION', r.corrections, p),
    termScore('OPEN_AUDIT_FLAG', extra.auditHits, p),
    termScore('NEW_OPERATOR', r.newOperators, p),
    termScore('NEW_EQUIPMENT', r.newEquipment.length, p, r.newEquipment.map((ref) => ({ kind: 'EQUIPMENT', ref }))),
    termScore('STEP_DURATION', extra.unusualSteps.length, p, extra.unusualSteps.map((ref) => ({ kind: 'STEP', ref }))),
    termScore('DEVIATION', r.deviations, p),
  ];
}

/** The score and its top reasons: the larger points first, then the order of PRIORITY_TERMS. */
export function scoreOf(terms: readonly TermScore[], p: ReviewPriorityParameters): { score: number; reasons: Reason[] } {
  const score = terms.reduce((s, t) => s + t.points, 0);
  const order = (t: TermScore): number => PRIORITY_TERMS.indexOf(t.term);
  const reasons = terms.filter((t) => t.points > 0).sort((a, b) => b.points - a.points || order(a) - order(b)).slice(0, p.topReasons)
    .map((t): Reason => ({ code: t.term, text: describe(t, p), weight: t.points, ...(t.evidence.length > 0 ? { evidence: t.evidence } : {}) }));
  return { score, reasons };
}

export function runReviewPriority(input: ReviewInput, p: ReviewPriorityParameters): MethodResult {
  const skipped: Skipped[] = [];
  const records = [...input.records].sort((a, b) => byText(a.batchNumber, b.batchNumber) || byText(a.batchId, b.batchId));
  const scored = new Set(records.map((r) => r.batchId));

  // Values near a limit, per record.
  const near = new Map<string, string[]>();
  const oneSided = new Map<string, number>();
  for (const v of [...input.values].sort((a: ReviewValue, b: ReviewValue) => byText(a.batchId, b.batchId) || byText(a.ref, b.ref))) {
    if (!scored.has(v.batchId)) continue;
    const n = nearLimit(v.value, v.lower, v.upper, p.nearLimitShare);
    if (n === null) oneSided.set(v.batchId, (oneSided.get(v.batchId) ?? 0) + 1);
    else if (n) near.set(v.batchId, [...(near.get(v.batchId) ?? []), v.ref]);
  }

  // Audit-trail rule hits on each record's entries (the rules' evidence names entries as `<chain>#<id>`).
  const batchOfEntry = new Map(input.audit.filter((e) => e.batchId !== null).map((e) => [eventRef(e), e.batchId as string]));
  const auditHits = new Map<string, number>();
  for (const hit of auditRuleHits({ events: input.audit, auth: [], digits: [] }, AUDIT_RULES_V1)) {
    const batches = new Set((hit.reason.evidence ?? []).filter((x) => x.kind === 'AUDIT_EVENT').map((x) => batchOfEntry.get(x.ref)).filter((b): b is string => b !== undefined));
    for (const b of batches) auditHits.set(b, (auditHits.get(b) ?? 0) + 1);
  }

  // Unusual step durations, against every GMP record of the same product, family and step.
  const all = durations(input.steps);
  const byKey = new Map<string, number[]>();
  for (const d of all) byKey.set(d.key, [...(byKey.get(d.key) ?? []), d.minutes]);
  const unusual = new Map<string, string[]>();
  const numbers = new Map(records.map((r) => [r.batchId, r.batchNumber]));
  for (const d of all) {
    if (!scored.has(d.batchId)) continue;
    const group = byKey.get(d.key) ?? [];
    const subject = `${numbers.get(d.batchId) ?? d.batchId}|${d.step}`;
    if (group.length < p.durationMinBatches) {
      skipped.push({ subject, reason: `duration not assessed: ${plural(group.length, 'record')} ran this step, ${String(p.durationMinBatches)} are needed` });
      continue;
    }
    const z = robustZ(d.minutes, group);
    if (z === null) skipped.push({ subject, reason: 'duration not assessed: the records of this step show no variation' });
    else if (Math.abs(z.z) > p.durationZ) unusual.set(d.batchId, [...(unusual.get(d.batchId) ?? []), d.step]);
  }

  const outputs: OutputDraft[] = records.map((r) => {
    if ((oneSided.get(r.batchId) ?? 0) > 0) {
      skipped.push({ subject: `${r.batchNumber}|NEAR_LIMIT`, reason: `${plural(oneSided.get(r.batchId) ?? 0, 'critical value')} without two limits not assessed for nearness` });
    }
    const terms = recordTerms(r, { nearLimit: near.get(r.batchId) ?? [], auditHits: auditHits.get(r.batchId) ?? 0, unusualSteps: unusual.get(r.batchId) ?? [] }, p);
    const { score, reasons } = scoreOf(terms, p);
    const values: Record<string, number | string> = {
      score, batchNumber: r.batchNumber, reviewState: r.reviewState, findings: r.reviewFindings, reopenings: r.reviewReopenings,
    };
    for (const t of terms) {
      values[`${t.term}.count`] = t.count;
      values[`${t.term}.points`] = t.points;
    }
    return { subjectKind: 'BATCH', subjectRef: r.batchId, kind: 'REVIEW_PRIORITY', values, reasons };
  });
  return { outputs, flags: [], skipped };
}

export const REVIEW_PRIORITY: Method<ReviewInput, ReviewPriorityParameters> = {
  id: 'REVIEW.PRIORITY',
  versions: [1],
  run: (input, params) => runReviewPriority(input, params),
};
