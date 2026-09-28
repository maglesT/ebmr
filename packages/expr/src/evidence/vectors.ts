/**
 * Boundary test vectors (ADR 0005 decision 8; outline 6.4 and 6.5; L-65).
 *
 * For a limit: the value ON the limit, JUST INSIDE and JUST OUTSIDE at the rounding boundary (the
 * raw value 94.95 rounds to 95.0 and passes a 95.0 lower limit; 94.94 fails), a TYPICAL value and a
 * MISSING value. For a calculation: the same outcomes reached through its inputs (a "driver" input
 * is solved by bisection so the result lands in each window), plus one ABSENT-INPUT vector per input
 * read. Every vector carries the expected outcome computed from the rule set, a plain-language
 * description, and the status PENDING_AUTHOR_CONFIRMATION: the author confirms each one.
 */
import { Dec } from '../decimal/dec.ts';
import type { CompiledExpression } from '../lang/compile.ts';
import type { InputValue, InputValues } from '../lang/evaluator.ts';
import { compareToBound, compareToLimit, type Limit, type LimitBound, type Precision, type RoundingRuleSet } from '../rounding/rounding.ts';
import { tryEvaluate, type EvaluateOptions } from './record.ts';

export type BoundaryLabel = 'ON_LIMIT' | 'JUST_INSIDE' | 'JUST_OUTSIDE';

export interface BoundaryValue {
  readonly label: BoundaryLabel;
  readonly side: 'LOW' | 'HIGH';
  readonly value: string;
  readonly expected: 'PASS' | 'FAIL';
  /** The rounded value the rule set compares. */
  readonly rounded: string;
  readonly description: string;
}

const RULE_WORDS: Readonly<Record<RoundingRuleSet, string>> = {
  USP_HALF_UP_AT_LIMIT_DECIMALS: 'USP rounding to the limit decimals',
  PH_EUR_SIG_FIGS: 'Ph. Eur. rounding to the limit significant figures',
};

function unitsAt(bound: string, precision: Precision): Dec[] {
  if ('decimals' in precision) return [Dec.parse(`1e-${String(precision.decimals)}`)];
  const b = Dec.parse(bound).abs();
  const e = b.isZero() ? 0 : b.exponent();
  const u = Dec.parse(`1e${String(e - precision.significantFigures + 1)}`);
  // Just below a power of ten the rounding unit is ten times finer (99.95 -> 100 at 3 figures).
  return [u, u.div(Dec.parse('10'))];
}

function describeOutcome(value: string, rounded: string, pass: boolean): string {
  return `${value} rounds to ${rounded} and ${pass ? 'passes' : 'fails'}`;
}

/**
 * ON_LIMIT, JUST_INSIDE and JUST_OUTSIDE values for one bound. JUST_INSIDE and JUST_OUTSIDE are
 * the two raw values one digit apart (one digit finer than the rounding) on either side of the
 * rounding threshold.
 */
export function boundaryValuesForBound(bound: LimitBound, side: 'LOW' | 'HIGH', ruleSet: RoundingRuleSet, otherBound?: LimitBound): BoundaryValue[] {
  const on = compareToBound(Dec.parse(bound.value), bound, side, ruleSet, otherBound);
  const b = Dec.parse(bound.value);
  const half = Dec.parse('0.5');
  const tenth = Dec.parse('0.1');
  const candidates = new Map<string, Dec>();
  for (const u of unitsAt(bound.value, on.precision)) {
    const step = u.times(tenth);
    for (const centre of [b.minus(u.times(half)), b.plus(u.times(half))]) {
      for (const c of [centre.minus(step), centre, centre.plus(step)]) candidates.set(c.toString(), c);
    }
  }
  const sorted = [...candidates.values()].sort((x, y) => x.cmp(y));
  const checks = sorted.map((v) => ({ v, check: compareToBound(v, bound, side, ruleSet, otherBound) }));
  // LOW: fail...fail pass...pass; HIGH: pass...pass fail...fail. Find the switch.
  let inside: (typeof checks)[number] | undefined;
  let outside: (typeof checks)[number] | undefined;
  for (let i = 0; i + 1 < checks.length; i += 1) {
    const a = checks[i];
    const c = checks[i + 1];
    if (a === undefined || c === undefined) continue;
    if (side === 'LOW' && !a.check.pass && c.check.pass) {
      outside = a;
      inside = c;
    }
    if (side === 'HIGH' && a.check.pass && !c.check.pass && inside === undefined) {
      inside = a;
      outside = c;
    }
  }
  const sideWord = side === 'LOW' ? 'lower' : 'upper';
  const rule = RULE_WORDS[ruleSet];
  const out: BoundaryValue[] = [
    {
      label: 'ON_LIMIT',
      side,
      value: b.toString(),
      expected: on.pass ? 'PASS' : 'FAIL',
      rounded: on.rounded,
      description: `On the ${sideWord} limit ${bound.value}${(bound.inclusive ?? true) ? '' : ' (strict)'}: ${describeOutcome(bound.value, on.rounded, on.pass)} (${rule})`,
    },
  ];
  if (inside !== undefined && outside !== undefined) {
    out.push({
      label: 'JUST_INSIDE',
      side,
      value: inside.v.toString(),
      expected: 'PASS',
      rounded: inside.check.rounded,
      description: `Just inside the ${sideWord} limit ${bound.value} at the rounding boundary: ${describeOutcome(inside.v.toString(), inside.check.rounded, true)} (${rule})`,
    });
    out.push({
      label: 'JUST_OUTSIDE',
      side,
      value: outside.v.toString(),
      expected: 'FAIL',
      rounded: outside.check.rounded,
      description: `Just outside the ${sideWord} limit ${bound.value} at the rounding boundary: ${describeOutcome(outside.v.toString(), outside.check.rounded, false)} (${rule})`,
    });
  }
  return out;
}

export interface LimitVector {
  readonly label: BoundaryLabel | 'TYPICAL' | 'MISSING';
  readonly side?: 'LOW' | 'HIGH';
  /** null for MISSING. */
  readonly value: string | null;
  /** MISSING_VALUE: the engine raises an exception; a missing value never passes. */
  readonly expected: 'PASS' | 'FAIL' | 'MISSING_VALUE';
  readonly rounded?: string;
  readonly description: string;
}

/** Boundary values for a whole limit, plus TYPICAL (two-sided limits) and MISSING. */
export function limitBoundaryValues(limit: Limit, ruleSet: RoundingRuleSet): LimitVector[] {
  const out: LimitVector[] = [];
  if (limit.low !== undefined && limit.high !== undefined) {
    const mid = Dec.parse(limit.low.value).plus(Dec.parse(limit.high.value)).div(Dec.parse('2'));
    const c = compareToLimit(mid, limit, ruleSet);
    out.push({ label: 'TYPICAL', value: mid.toString(), expected: c.outcome, rounded: c.rounded, description: `Typical value mid-range: ${c.explanation}` });
  }
  if (limit.low !== undefined) out.push(...boundaryValuesForBound(limit.low, 'LOW', ruleSet, limit.high));
  if (limit.high !== undefined) out.push(...boundaryValuesForBound(limit.high, 'HIGH', ruleSet, limit.low));
  out.push({ label: 'MISSING', value: null, expected: 'MISSING_VALUE', description: 'No value recorded: an exception is raised; a missing value never passes' });
  return out;
}

export type VectorCategory = 'TYPICAL' | 'ON_LIMIT' | 'JUST_INSIDE' | 'JUST_OUTSIDE' | 'ABSENT_INPUT';

export interface ExpectedOutcome {
  readonly outcome: 'PASS' | 'FAIL' | 'ERROR';
  /** Full-precision result of the calculation. */
  readonly rawOutput?: string;
  readonly roundedOutput?: string;
  readonly errorCode?: string;
  readonly errorPath?: string;
}

export interface CalculationVector {
  readonly id: string;
  readonly category: VectorCategory;
  readonly side?: 'LOW' | 'HIGH';
  readonly description: string;
  readonly inputs: InputValues;
  readonly expected: ExpectedOutcome;
  readonly confirmation: 'PENDING_AUTHOR_CONFIRMATION';
}

export interface VectorGenerationOptions extends EvaluateOptions {
  readonly limit: Limit;
  readonly ruleSet: RoundingRuleSet;
  /** Typical, complete inputs for the calculation. */
  readonly baseline: InputValues;
  /** A quantity input varied to reach each boundary (the result must be monotone in it over [min, max]). */
  readonly driver?: { readonly path: string; readonly min: string; readonly max: string };
  /** Bisection steps (default 200). */
  readonly maxSteps?: number;
}

export interface CalculationVectorSet {
  readonly vectors: readonly CalculationVector[];
  /** Vectors that could not be generated, with the reason in plain language. */
  readonly notGenerated: readonly { readonly category: VectorCategory; readonly side?: 'LOW' | 'HIGH'; readonly reason: string }[];
}

function outputOf(program: CompiledExpression, inputs: InputValues, options: EvaluateOptions): Dec | { error: string; path?: string } {
  const r = tryEvaluate(program, inputs, options);
  if (!r.ok) return { error: r.error.code, ...(r.error.path === undefined ? {} : { path: r.error.path }) };
  if (r.record.output.kind !== 'quantity') return { error: 'NOT_A_QUANTITY' };
  return Dec.parse(r.record.output.value);
}

function expectedFor(program: CompiledExpression, inputs: InputValues, options: VectorGenerationOptions): ExpectedOutcome {
  const r = tryEvaluate(program, inputs, options);
  if (!r.ok) return { outcome: 'ERROR', errorCode: r.error.code, ...(r.error.path === undefined ? {} : { errorPath: r.error.path }) };
  if (r.record.output.kind !== 'quantity') return { outcome: 'ERROR', errorCode: 'NOT_A_QUANTITY' };
  const value = r.record.output.unit === undefined || options.limit.unit === undefined ? r.record.output.value : { value: r.record.output.value, unit: r.record.output.unit };
  const c = compareToLimit(value, options.limit, options.ruleSet);
  return { outcome: c.outcome, rawOutput: r.record.output.value, roundedOutput: c.rounded };
}

function withDriver(baseline: InputValues, path: string, value: Dec): InputValues {
  const current = baseline[path];
  const base: InputValue = current !== undefined && 'value' in current ? current : { value: '0', source: 'boundary vector' };
  return { ...baseline, [path]: { ...base, value: value.toString(), source: 'boundary vector (generated)' } };
}

/** Finds a driver value whose output lies in [lo, hi] by bisection (the output must be monotone). */
function solve(program: CompiledExpression, options: VectorGenerationOptions, lo: Dec, hi: Dec): Dec | string {
  const d = options.driver;
  if (d === undefined) return 'no driver input was given';
  let a = Dec.parse(d.min);
  let b = Dec.parse(d.max);
  const fa = outputOf(program, withDriver(options.baseline, d.path, a), options);
  const fb = outputOf(program, withDriver(options.baseline, d.path, b), options);
  if (!(fa instanceof Dec) || !(fb instanceof Dec)) return 'the calculation fails at an end of the driver range';
  const increasing = fa.lte(fb);
  const fmin = increasing ? fa : fb;
  const fmax = increasing ? fb : fa;
  if (hi.lt(fmin) || lo.gt(fmax)) return `the result cannot reach ${lo.toString()}..${hi.toString()} with ${d.path} between ${d.min} and ${d.max}`;
  const two = Dec.parse('2');
  for (let i = 0; i < (options.maxSteps ?? 200); i += 1) {
    const mid = a.plus(b).div(two);
    const f = outputOf(program, withDriver(options.baseline, d.path, mid), options);
    if (!(f instanceof Dec)) return `the calculation fails at ${d.path} = ${mid.toString()}`;
    if (f.gte(lo) && f.lte(hi)) return mid;
    const below = f.lt(lo);
    // Move towards larger outputs when below the window.
    if (below === increasing) a = mid;
    else b = mid;
  }
  return 'bisection did not converge (is the result monotone in the driver?)';
}

/**
 * Generates boundary vectors for a calculation and its limit. The expected outcome of each vector
 * is computed from the rule set; the author confirms it (confirmation PENDING_AUTHOR_CONFIRMATION).
 */
export function generateCalculationVectors(program: CompiledExpression, options: VectorGenerationOptions): CalculationVectorSet {
  const vectors: CalculationVector[] = [];
  const notGenerated: { category: VectorCategory; side?: 'LOW' | 'HIGH'; reason: string }[] = [];
  const push = (category: VectorCategory, description: string, inputs: InputValues, side?: 'LOW' | 'HIGH'): void => {
    vectors.push({
      id: `${category}${side === undefined ? '' : `_${side}`}${category === 'ABSENT_INPUT' ? `_${String(vectors.filter((v) => v.category === 'ABSENT_INPUT').length + 1)}` : ''}`,
      category,
      ...(side === undefined ? {} : { side }),
      description,
      inputs,
      expected: expectedFor(program, inputs, options),
      confirmation: 'PENDING_AUTHOR_CONFIRMATION',
    });
  };
  const values = limitBoundaryValues(options.limit, options.ruleSet);
  const typical = values.find((v) => v.label === 'TYPICAL');
  if (typical?.value !== null && typical !== undefined && options.driver !== undefined) {
    const t = Dec.parse(typical.value);
    const tol = t.abs().times(Dec.parse('0.001'));
    const x = solve(program, options, t.minus(tol), t.plus(tol));
    if (x instanceof Dec) push('TYPICAL', `Typical inputs giving a result near the middle of the range (${typical.value})`, withDriver(options.baseline, options.driver.path, x));
    else notGenerated.push({ category: 'TYPICAL', reason: x });
  } else {
    push('TYPICAL', 'Typical (baseline) inputs', options.baseline);
  }
  const bySide = (side: 'LOW' | 'HIGH'): BoundaryValue[] => values.filter((v): v is LimitVector & BoundaryValue => v.side === side && v.label !== 'TYPICAL' && v.label !== 'MISSING');
  for (const side of ['LOW', 'HIGH'] as const) {
    const bv = bySide(side);
    const inside = bv.find((v) => v.label === 'JUST_INSIDE');
    const outside = bv.find((v) => v.label === 'JUST_OUTSIDE');
    for (const v of bv) {
      const value = Dec.parse(v.value);
      // A window that keeps the rounding outcome of v: away from the neighbour across the threshold.
      let lo = value;
      let hi = value;
      if (inside !== undefined && outside !== undefined) {
        const gap = Dec.parse(inside.value).minus(Dec.parse(outside.value)).abs();
        const tol = gap.div(Dec.parse('10'));
        if (v.label === 'ON_LIMIT') {
          lo = value.minus(tol);
          hi = value.plus(tol);
        } else {
          const neighbour = Dec.parse(v.label === 'JUST_INSIDE' ? outside.value : inside.value);
          if (neighbour.gt(value)) lo = value.minus(tol);
          else hi = value.plus(tol);
        }
      }
      const x = solve(program, options, lo, hi);
      if (!(x instanceof Dec) || options.driver === undefined) {
        notGenerated.push({ category: v.label, side, reason: typeof x === 'string' ? x : 'no driver input was given' });
        continue;
      }
      const inputs = withDriver(options.baseline, options.driver.path, x);
      const expected = expectedFor(program, inputs, options);
      if (expected.outcome !== v.expected) {
        notGenerated.push({ category: v.label, side, reason: `the solved inputs give ${expected.outcome}, not ${v.expected}` });
        continue;
      }
      push(v.label, `${v.description}; reached with ${options.driver.path} = ${x.toString()}`, inputs, side);
    }
  }
  for (const path of program.reads) {
    const rest: Record<string, InputValue | undefined> = { ...options.baseline };
    delete rest[path];
    push('ABSENT_INPUT', `Input "${path}" is absent: the calculation must stop with a missing-input error, never assume a value`, rest);
  }
  return { vectors, notGenerated };
}

/** Re-runs vectors (e.g. after a value-only change, outline 6.5 delta verification) and lists differences. */
export function runCalculationVectors(program: CompiledExpression, set: CalculationVectorSet, options: VectorGenerationOptions): { passed: boolean; failures: readonly { id: string; expected: ExpectedOutcome; actual: ExpectedOutcome }[] } {
  const failures = set.vectors
    .map((v) => ({ id: v.id, expected: v.expected, actual: expectedFor(program, v.inputs, options) }))
    .filter((f) => f.expected.outcome !== f.actual.outcome || f.expected.errorCode !== f.actual.errorCode);
  return { passed: failures.length === 0, failures };
}
