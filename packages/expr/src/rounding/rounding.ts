/**
 * Rounding happens only when a value is compared with a limit and when it is displayed (ADR 0005
 * decision 4; outline 6.4). The full-precision value is always what is stored.
 *
 * Rule sets (paraphrased; the pharmacopoeial texts are the authority and are verified by QA before a
 * rule set is made effective, tablets spec E.1):
 * - USP_HALF_UP_AT_LIMIT_DECIMALS: the observed or calculated value is rounded to the number of
 *   decimal places of the limit as written, looking at the next digit only, and a 5 rounds up
 *   (away from zero). 94.95 against 95.0-105.0 rounds to 95.0 and passes; 94.94 rounds to 94.9 and
 *   fails. When the two bounds are written with different decimals the finer one is used.
 * - PH_EUR_SIG_FIGS: the result is rounded to the number of significant figures of the limit, every
 *   digit shown counting as significant (140 has three), a half or more rounding the last figure up.
 *   Each bound is compared with the value rounded to that bound's significant figures. A limit of
 *   zero has no significant figures; its decimal places are used instead.
 * Under ALL_APPLY (outline 3.3.1, L-37) every criterion is rounded by its own rule set.
 */
import { Dec, DecError, type RoundingMode } from '../decimal/dec.ts';
import { fromRational, rational, rCeil, rDiv, rFloor, rMul, toRational, type Rational } from '../decimal/exact.ts';
import { convertValue, type ConversionRecord } from '../units/quantity.ts';
import { parseUnit } from '../units/unit.ts';

export const ROUNDING_RULE_SETS = ['USP_HALF_UP_AT_LIMIT_DECIMALS', 'PH_EUR_SIG_FIGS'] as const;
export type RoundingRuleSet = (typeof ROUNDING_RULE_SETS)[number];

export interface LimitBound {
  /** Decimal as written in the specification, e.g. "95.0" (the decimals matter). No exponent. */
  readonly value: string;
  /** true (default): the bound itself passes (NLT / NMT); false: strict. */
  readonly inclusive?: boolean;
}

export interface Limit {
  readonly low?: LimitBound;
  readonly high?: LimitBound;
  /** UCUM unit of the bounds; the value is converted into it (exactly) before rounding. */
  readonly unit?: string;
}

export type Precision = { readonly decimals: number } | { readonly significantFigures: number };

export interface BoundCheck {
  readonly side: 'LOW' | 'HIGH';
  readonly limit: string;
  readonly inclusive: boolean;
  /** The rounded value compared, written to the precision used (e.g. "95.0"). */
  readonly rounded: string;
  readonly precision: Precision;
  readonly pass: boolean;
}

export interface LimitComparison {
  readonly outcome: 'PASS' | 'FAIL';
  readonly ruleSet: RoundingRuleSet;
  /** Full-precision value (in the limit's unit), never replaced by the rounded one. */
  readonly value: string;
  readonly unit?: string;
  /** The rounded value used for the deciding comparison. */
  readonly rounded: string;
  readonly checks: readonly BoundCheck[];
  readonly breached: 'LOW' | 'HIGH' | null;
  readonly conversion?: ConversionRecord;
  /** Plain-language account of the comparison. */
  readonly explanation: string;
}

export class LimitError extends Error {
  readonly code = 'EXPR-LIMIT-001';
}

const PLAIN = /^-?[0-9]+(\.[0-9]+)?$/;

function boundText(b: LimitBound): string {
  if (typeof b.value !== 'string' || !PLAIN.test(b.value)) {
    throw new LimitError(`The limit "${String(b.value)}" must be a plain decimal as written in the specification (e.g. "95.0"), without an exponent`);
  }
  return b.value;
}

/** Decimal places as written ("95.0" -> 1, "105" -> 0). */
export function writtenDecimals(text: string): number {
  const i = text.indexOf('.');
  return i < 0 ? 0 : text.length - i - 1;
}

/** Significant figures as written: every digit shown after the leading zeros ("140" -> 3, "0.10" -> 2). */
export function writtenSignificantFigures(text: string): number | undefined {
  const digits = text.replace('-', '').replace('.', '').replace(/^0+/, '');
  return digits.length === 0 ? undefined : digits.length;
}

function displayAt(value: Dec, precision: Precision): string {
  if ('decimals' in precision) return value.toFixed(precision.decimals, 'HALF_UP');
  const decimals = Math.max(0, precision.significantFigures - 1 - value.exponent());
  return value.toFixed(decimals, 'HALF_UP');
}

function roundAt(value: Dec, precision: Precision): Dec {
  return 'decimals' in precision ? value.roundToDecimals(precision.decimals, 'HALF_UP') : value.roundToSignificant(precision.significantFigures, 'HALF_UP');
}

function precisionFor(ruleSet: RoundingRuleSet, bound: string, other: string | undefined): Precision {
  if (ruleSet === 'USP_HALF_UP_AT_LIMIT_DECIMALS') return { decimals: Math.max(writtenDecimals(bound), other === undefined ? 0 : writtenDecimals(other)) };
  const sf = writtenSignificantFigures(bound);
  return sf === undefined ? { decimals: writtenDecimals(bound) } : { significantFigures: sf };
}

function checkRuleSet(ruleSet: string): asserts ruleSet is RoundingRuleSet {
  if (!(ROUNDING_RULE_SETS as readonly string[]).includes(ruleSet)) throw new LimitError(`Unknown rounding rule set "${ruleSet}"`);
}

/** The value rounded as `ruleSet` rounds it for comparison with `bound`. */
export function roundForComparison(value: Dec, bound: LimitBound, ruleSet: RoundingRuleSet, otherBound?: LimitBound): { rounded: Dec; text: string; precision: Precision } {
  checkRuleSet(ruleSet);
  const precision = precisionFor(ruleSet, boundText(bound), otherBound === undefined ? undefined : boundText(otherBound));
  const rounded = roundAt(value, precision);
  return { rounded, text: displayAt(rounded, precision), precision };
}

/** Compares a full-precision value with one bound under a rule set. */
export function compareToBound(value: Dec, bound: LimitBound, side: 'LOW' | 'HIGH', ruleSet: RoundingRuleSet, otherBound?: LimitBound): BoundCheck {
  const { rounded, text, precision } = roundForComparison(value, bound, ruleSet, otherBound);
  const limit = Dec.parse(bound.value);
  const inclusive = bound.inclusive ?? true;
  const c = rounded.cmp(limit);
  const pass = side === 'LOW' ? (inclusive ? c >= 0 : c > 0) : inclusive ? c <= 0 : c < 0;
  return { side, limit: bound.value, inclusive, rounded: text, precision, pass };
}

function toDec(value: Dec | string): Dec {
  return typeof value === 'string' ? Dec.parse(value) : value;
}

function describePrecision(p: Precision, ruleSet: RoundingRuleSet): string {
  const src = ruleSet === 'USP_HALF_UP_AT_LIMIT_DECIMALS' ? 'USP' : 'Ph. Eur.';
  return 'decimals' in p
    ? `${String(p.decimals)} decimal place${p.decimals === 1 ? '' : 's'} (${src})`
    : `${String(p.significantFigures)} significant figure${p.significantFigures === 1 ? '' : 's'} (${src})`;
}

/**
 * Compares a value with a limit (low, high or both) under a rounding rule set. Returns pass/fail,
 * the rounded value used, each bound's check and a plain-language explanation. The value may be
 * given with a unit; it is then converted exactly into the limit's unit before rounding.
 */
export function compareToLimit(value: Dec | string | { readonly value: Dec | string; readonly unit: string }, limit: Limit, ruleSet: RoundingRuleSet): LimitComparison {
  checkRuleSet(ruleSet);
  if (limit.low === undefined && limit.high === undefined) throw new LimitError('A limit needs a lower bound, an upper bound or both');
  let v: Dec;
  let conversion: ConversionRecord | undefined;
  if (typeof value === 'object' && !(value instanceof Dec)) {
    if (limit.unit === undefined) throw new LimitError('The value has a unit, so the limit must state its unit');
    const r = convertValue(toDec(value.value), parseUnit(value.unit), parseUnit(limit.unit));
    v = r.value;
    if (r.conversion !== null) conversion = r.conversion;
  } else {
    v = toDec(value);
  }
  if (limit.low !== undefined && limit.high !== undefined && Dec.parse(boundText(limit.low)).gt(Dec.parse(boundText(limit.high)))) {
    throw new LimitError(`The lower limit ${limit.low.value} is above the upper limit ${limit.high.value}`);
  }
  const checks: BoundCheck[] = [];
  if (limit.low !== undefined) checks.push(compareToBound(v, limit.low, 'LOW', ruleSet, limit.high));
  if (limit.high !== undefined) checks.push(compareToBound(v, limit.high, 'HIGH', ruleSet, limit.low));
  const failed = checks.find((c) => !c.pass);
  let decisive: BoundCheck | undefined = failed;
  if (decisive === undefined) {
    decisive = checks.reduce((best, c) => {
      const d = v.minus(Dec.parse(c.limit)).abs();
      return best === undefined || d.lt(v.minus(Dec.parse(best.limit)).abs()) ? c : best;
    }, undefined as BoundCheck | undefined);
  }
  const rounded = decisive?.rounded ?? v.toString();
  const range =
    limit.low !== undefined && limit.high !== undefined
      ? `${limit.low.value}-${limit.high.value}`
      : limit.low !== undefined
        ? `${(limit.low.inclusive ?? true) ? 'not less than' : 'more than'} ${limit.low.value}`
        : `${(limit.high?.inclusive ?? true) ? 'not more than' : 'less than'} ${limit.high?.value ?? ''}`;
  const unitText = limit.unit === undefined ? '' : ` ${limit.unit}`;
  const explanation =
    `${v.toString()}${unitText} rounded to ${decisive === undefined ? 'full precision' : describePrecision(decisive.precision, ruleSet)} is ${rounded}; ` +
    `limit ${range}${unitText}: ${failed === undefined ? 'pass' : `fail (${failed.side === 'LOW' ? 'below the lower' : 'above the upper'} limit)`}`;
  return {
    outcome: failed === undefined ? 'PASS' : 'FAIL',
    ruleSet,
    value: v.toString(),
    ...(limit.unit === undefined ? {} : { unit: limit.unit }),
    rounded,
    checks,
    breached: failed?.side ?? null,
    ...(conversion === undefined ? {} : { conversion }),
    explanation,
  };
}

export interface AllApplyCriterion {
  readonly id: string;
  readonly limit: Limit;
  readonly ruleSet: RoundingRuleSet;
}

/** ALL_APPLY: every criterion must pass, each rounded by its own rule set (L-37). */
export function compareAllApply(
  value: Dec | string | { readonly value: Dec | string; readonly unit: string },
  criteria: readonly AllApplyCriterion[],
): { outcome: 'PASS' | 'FAIL'; results: readonly { id: string; comparison: LimitComparison }[] } {
  if (criteria.length === 0) throw new LimitError('ALL_APPLY needs at least one criterion');
  const results = criteria.map((c) => ({ id: c.id, comparison: compareToLimit(value, c.limit, c.ruleSet) }));
  return { outcome: results.every((r) => r.comparison.outcome === 'PASS') ? 'PASS' : 'FAIL', results };
}

/** Display text at a precision (half-up; no locale, no grouping). The stored value is unchanged. */
export function formatForDisplay(value: Dec | string, precision: Precision): string {
  const v = toDec(value);
  if ('decimals' in precision) return v.toFixed(precision.decimals, 'HALF_UP');
  return displayAt(v.roundToSignificant(precision.significantFigures, 'HALF_UP'), precision);
}

/**
 * Rounds to a multiple of `increment` (e.g. a balance readability of 0.001 kg). CEILING is used for
 * an active's dispensing target so rounding never reduces the active below the calculated quantity
 * (tablets spec C.0, TB-01); HALF_UP for other targets. For targets and display only.
 */
export function roundToIncrement(value: Dec | string, increment: Dec | string, mode: Extract<RoundingMode, 'CEILING' | 'FLOOR' | 'HALF_UP'>): Dec {
  const v = toRational(toDec(value));
  const inc = toRational(toDec(increment));
  if (inc.num <= 0n) throw new DecError('DEC_DOMAIN', 'the increment must be positive');
  const q: Rational = rDiv(v, inc);
  let n: bigint;
  if (mode === 'CEILING') n = rCeil(q);
  else if (mode === 'FLOOR') n = rFloor(q);
  else {
    // half away from zero
    const twice = rMul(q, rational(2n));
    const neg = q.num < 0n;
    const t = neg ? rational(-twice.num, twice.den) : twice;
    const m = (rFloor(t) + 1n) / 2n;
    n = neg ? -m : m;
  }
  return fromRational(rMul(rational(n), inc)).value;
}
