/**
 * Boundary values for every limit, guard and time constraint (outline 6.5 "boundary values for every
 * guard and limit (on, just inside, just outside, missing)"; 6.4 test vectors; INV-20).
 *
 * Limits: the expression language generates on-limit, just-inside and just-outside vectors at the
 * rounding boundary of each bound; each vector is evaluated through the full tier model and must
 * give the outcome the vector expects. Guards: every variable takes each constant it is compared
 * with and one step either side at its capture precision; every point must select exactly one
 * branch, and the decision procedure's reading of each guard must agree with the expression
 * language's evaluation of the real expression. Time constraints: elapsed times at and one
 * microsecond beyond each minimum and maximum.
 */
import { addDecimal, compareDecimal, decimalsOf, format, subtractDecimal } from '../flow/decimal.ts';
import type { ExprType, ExprValue, GuardFormula } from '../flow/expression-port.ts';
import { durationToMicros } from '../flow/decimal.ts';
import type { AlternativeNode, TimeConstraint } from '../flow/model.ts';
import { evaluateTimeConstraint, type TimeConstraintStatus } from '../flow/time.ts';
import { evaluateLimits } from '../limits/evaluate.ts';
import type { LimitSpec, LimitTier } from '../limits/model.ts';
import { CONDITION, type Analysis } from '../validator/analysis.ts';
import { evaluateGuard } from '../validator/guards.ts';

export interface LimitVectorResult {
  subject: string;
  tier: LimitTier;
  side: 'LOW' | 'HIGH';
  label: 'ON_LIMIT' | 'JUST_INSIDE' | 'JUST_OUTSIDE' | 'MISSING';
  value: string | null;
  expected: 'PASS' | 'FAIL' | 'EXCEPTION';
  actual: 'PASS' | 'FAIL' | 'EXCEPTION';
  /** Requirement of the whole tier model at this value. */
  requirement: string;
  description: string;
  ok: boolean;
}

export function limitVectors(a: Analysis, subject: string, spec: LimitSpec): LimitVectorResult[] {
  const out: LimitVectorResult[] = [];
  const expr = a.ctx.expressions;
  for (const r of spec.ranges) {
    for (const [side, bound, other] of [
      ['LOW', r.low, r.high],
      ['HIGH', r.high, r.low],
    ] as const) {
      if (!bound) continue;
      for (const v of expr.boundaryVectors(bound, side, r.rounding, other)) {
        const ev = evaluateLimits(spec, { value: v.value, unit: spec.unit }, expr);
        const tier = ev.tiers.find((t) => t.tier === r.tier);
        const sideResult = side === 'LOW' ? tier?.low : tier?.high;
        const actual = sideResult?.pass ? 'PASS' : 'FAIL';
        out.push({ subject, tier: r.tier, side, label: v.label, value: v.value, expected: v.expected, actual, requirement: ev.requirement, description: v.description, ok: actual === v.expected });
      }
    }
  }
  const missing = evaluateLimits(spec, undefined, expr);
  const tier = spec.ranges[0]?.tier ?? 'REGISTERED';
  out.push({
    subject,
    tier,
    side: 'LOW',
    label: 'MISSING',
    value: null,
    expected: 'EXCEPTION',
    actual: missing.requirement === 'MISSING_VALUE_EXCEPTION' ? 'EXCEPTION' : 'PASS',
    requirement: missing.requirement,
    description: 'The value is missing: an exception, never a pass',
    ok: missing.requirement === 'MISSING_VALUE_EXCEPTION',
  });
  return out;
}

export interface GuardVectorResult {
  alternative: string;
  point: Record<string, string | boolean | null>;
  /** Branch selected (exactly one expected), or the evaluation error for a missing value. */
  selected: string[];
  error?: string;
  ok: boolean;
  description: string;
}

function collect(f: GuardFormula, into: Map<string, Set<string | boolean>>): boolean {
  switch (f.op) {
    case 'const':
      return true;
    case 'not':
      return collect(f.arg, into);
    case 'and':
    case 'or':
      return f.args.every((x) => collect(x, into));
    case 'cmp':
    case 'is': {
      const s = into.get(f.variable) ?? new Set();
      s.add(f.op === 'cmp' ? f.constant : f.value);
      into.set(f.variable, s);
      return true;
    }
    case 'opaque':
      return false;
  }
}

function valueFor(t: ExprType, v: string | boolean): ExprValue | undefined {
  if (t.kind === 'DECIMAL' && typeof v === 'string') return { kind: 'DECIMAL', value: v, unit: t.unit };
  if (t.kind === 'COUNT' && typeof v === 'string') return { kind: 'COUNT', value: v };
  if (t.kind === 'BOOLEAN' && typeof v === 'boolean') return { kind: 'BOOLEAN', value: v };
  if (t.kind === 'CATEGORY' && typeof v === 'string') return { kind: 'CATEGORY', value: v };
  return undefined;
}

/** The step used for "just inside/outside" a constant: the capture precision, else one decimal finer than the constant. */
function stepFor(a: Analysis, variable: string, constant: string, treeId: string): string {
  const id = a.expanded.scopes.get(treeId)?.env.get(variable) ?? variable;
  const p = a.parameters.get(id);
  const t = a.declaredType(id);
  if (t?.kind === 'COUNT') return '1';
  const digits = p?.precision?.kind === 'DECIMALS' ? p.precision.digits : decimalsOf(constant) + 1;
  return format({ digits: 1n, scale: digits });
}

export function guardVectors(a: Analysis, alt: AlternativeNode, maxPoints: number): { results: GuardVectorResult[]; exercised: boolean } {
  const split = a.graphNodeOf(alt.id, 'XOR_SPLIT');
  const env = a.envAt(alt.id, split);
  const branches = alt.branches.map((b) => ({ id: b.id, guard: b.guard, otherwise: b.otherwise === true, formula: b.guard ? a.ctx.expressions.guard(b.guard, env) : undefined }));
  const constants = new Map<string, Set<string | boolean>>();
  for (const b of branches) if (b.formula && !collect(b.formula, constants)) return { results: [], exercised: false };
  const axes: [string, (string | boolean)[]][] = [];
  let size = 1;
  for (const [variable, values] of [...constants.entries()].sort(([x], [y]) => (x < y ? -1 : 1))) {
    const t = env.get(variable);
    if (!t || t.kind === 'SERIES') return { results: [], exercised: false };
    let points: (string | boolean)[];
    if (t.kind === 'BOOLEAN') points = [true, false];
    else if (t.kind === 'CATEGORY') points = [...t.values];
    else {
      const set = new Map<string, string>();
      for (const c of values) {
        if (typeof c !== 'string') continue;
        const step = stepFor(a, variable, c, alt.id);
        for (const p of [subtractDecimal(c, step), c, addDecimal(c, step)]) set.set(p, p);
      }
      points = [...set.values()].sort(compareDecimal);
    }
    axes.push([variable, points]);
    size *= points.length;
    if (size > maxPoints) return { results: [], exercised: false };
  }
  const results: GuardVectorResult[] = [];
  const point = new Map<string, string | boolean>();
  const evaluateAt = (): void => {
    const values = new Map<string, ExprValue>();
    for (const [k, v] of point) {
      const x = valueFor(env.get(k) as ExprType, v);
      if (x) values.set(k, x);
    }
    const selected: string[] = [];
    let disagreement: string | undefined;
    for (const b of branches) {
      if (!b.guard || !b.formula) continue;
      const exact = evaluateGuard(b.formula, point);
      const ev = a.ctx.expressions.evaluate(b.guard, env, values, CONDITION);
      const byExpr = ev.ok && ev.value.kind === 'BOOLEAN' ? ev.value.value : undefined;
      if (byExpr !== exact) disagreement = `branch ${b.id}: the expression gives ${String(byExpr)} but its analysed form gives ${String(exact)}`;
      if (exact) selected.push(b.id);
    }
    if (selected.length === 0) {
      const other = branches.find((b) => b.otherwise);
      if (other) selected.push(other.id);
    }
    const snapshot = Object.fromEntries(point);
    const r: GuardVectorResult = {
      alternative: alt.id,
      point: snapshot,
      selected,
      ok: selected.length === 1 && disagreement === undefined,
      description: `At ${Object.entries(snapshot).map(([k, v]) => `${k} = ${String(v)}`).join(', ') || 'any value'} exactly one branch applies`,
    };
    if (disagreement) r.error = disagreement;
    results.push(r);
  };
  const visit = (i: number): void => {
    if (i === axes.length) {
      evaluateAt();
      return;
    }
    const [variable, points] = axes[i] as [string, (string | boolean)[]];
    for (const p of points) {
      point.set(variable, p);
      visit(i + 1);
    }
    point.delete(variable);
  };
  visit(0);
  // Missing values: every guard reading the variable must fail with an explicit error, never pick a branch.
  for (const [variable] of axes) {
    const values = new Map<string, ExprValue>();
    for (const [k, points] of axes) {
      if (k === variable) continue;
      const x = valueFor(env.get(k) as ExprType, points[0] as string | boolean);
      if (x) values.set(k, x);
    }
    const errors = branches
      .filter((b) => b.guard && b.formula && JSON.stringify(b.formula).includes(`"variable":${JSON.stringify(variable)}`))
      .map((b) => a.ctx.expressions.evaluate(b.guard as string, env, values, CONDITION));
    const ok = errors.length > 0 && errors.every((e) => !e.ok);
    const r: GuardVectorResult = {
      alternative: alt.id,
      point: { [variable]: null },
      selected: [],
      ok,
      description: `With ${variable} missing, the decision raises an exception instead of taking a branch`,
    };
    const firstError = errors.find((e) => !e.ok);
    if (firstError && !firstError.ok) r.error = firstError.code;
    results.push(r);
  }
  return { results, exercised: true };
}

export interface TimeVectorResult {
  constraint: string;
  label: 'NOT_STARTED' | 'BELOW_MIN' | 'AT_MIN' | 'AT_MAX' | 'ABOVE_MAX';
  elapsedUs: string | null;
  expected: TimeConstraintStatus | 'ALLOWED';
  actual: string;
  ok: boolean;
}

/** INV-20 vectors: the end event is refused below the minimum, allowed at it; the maximum is within, one microsecond more is a breach. */
export function timeVectors(tc: TimeConstraint): TimeVectorResult[] {
  const out: TimeVectorResult[] = [];
  const min = tc.min ? durationToMicros(tc.min.value, tc.min.unit) : undefined;
  const max = tc.max ? durationToMicros(tc.max.value, tc.max.unit) : undefined;
  const from = 0n;
  const ns = evaluateTimeConstraint(tc, { nowUs: 0n });
  out.push({ constraint: tc.id, label: 'NOT_STARTED', elapsedUs: null, expected: 'NOT_STARTED', actual: ns.status, ok: ns.status === 'NOT_STARTED' && ns.exception === undefined });
  if (min !== undefined) {
    const below = evaluateTimeConstraint(tc, { fromUs: from, nowUs: min - 1n });
    out.push({ constraint: tc.id, label: 'BELOW_MIN', elapsedUs: (min - 1n).toString(), expected: 'MIN_NOT_REACHED', actual: below.status, ok: below.status === 'MIN_NOT_REACHED' && !below.toEventAllowed });
    const at = evaluateTimeConstraint(tc, { fromUs: from, toUs: min, nowUs: min });
    out.push({ constraint: tc.id, label: 'AT_MIN', elapsedUs: min.toString(), expected: 'ALLOWED', actual: at.status, ok: at.toEventAllowed && at.exception === undefined });
  }
  if (max !== undefined) {
    const at = evaluateTimeConstraint(tc, { fromUs: from, toUs: max, nowUs: max });
    out.push({ constraint: tc.id, label: 'AT_MAX', elapsedUs: max.toString(), expected: 'WITHIN', actual: at.status, ok: at.exception === undefined && at.status === 'WITHIN' });
    const above = evaluateTimeConstraint(tc, { fromUs: from, nowUs: max + 1n });
    out.push({ constraint: tc.id, label: 'ABOVE_MAX', elapsedUs: (max + 1n).toString(), expected: 'MAX_BREACHED', actual: above.status, ok: above.status === 'MAX_BREACHED' && above.exception === 'MAX_BREACH' });
  }
  return out;
}
