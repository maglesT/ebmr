/**
 * Decision procedure for branch guards (outline 6.3 "branch conditions cover every case and never
 * overlap"; KB-14 "exhaustive, non-overlapping and reachable").
 *
 * Guards in the decidable fragment compare single variables with constants (and test categories and
 * booleans), combined with and/or/not. The truth of such a guard is constant on each interval between
 * consecutive constants, so evaluating every guard at one representative point per interval (and at
 * each constant) decides the question exactly. Decimal variables use exact midpoints; COUNT
 * variables use the integers next to each constant; categories use their declared domain; booleans
 * both values. Anything outside the fragment is OPAQUE: the result is then UNKNOWN, never a guess.
 */
import type { ExprType, GuardFormula } from '../flow/expression-port.ts';
import { addDecimal, compareDecimal, format, midpointDecimal, parseDecimal, subtractDecimal } from '../flow/decimal.ts';

export type Point = ReadonlyMap<string, string | boolean>;

export interface GuardBranch {
  id: string;
  /** undefined for the `otherwise` branch. */
  formula: GuardFormula | undefined;
}

export interface GuardAnalysis {
  decided: boolean;
  /** Why the analysis could not decide (opaque guard, unsupported variable, too many points). */
  reason?: string;
  /** A point no explicit guard covers (only when there is no `otherwise` branch). */
  uncovered?: Point;
  /** Pairs of branches whose guards are true together, with a witness point. */
  overlaps: { a: string; b: string; at: Point }[];
  /** Branches that can never be taken. */
  dead: string[];
}

function collect(f: GuardFormula, vars: Map<string, { constants: Set<string>; values: Set<string | boolean> }>): string | undefined {
  switch (f.op) {
    case 'const':
      return undefined;
    case 'not':
      return collect(f.arg, vars);
    case 'and':
    case 'or':
      for (const a of f.args) {
        const r = collect(a, vars);
        if (r) return r;
      }
      return undefined;
    case 'cmp': {
      const v = vars.get(f.variable) ?? { constants: new Set(), values: new Set() };
      v.constants.add(f.constant);
      vars.set(f.variable, v);
      return undefined;
    }
    case 'is': {
      const v = vars.get(f.variable) ?? { constants: new Set(), values: new Set() };
      v.values.add(f.value);
      vars.set(f.variable, v);
      return undefined;
    }
    case 'opaque':
      return f.reason;
  }
}

function floorDecimal(text: string): string {
  const d = parseDecimal(text);
  const q = d.digits / 10n ** BigInt(d.scale);
  const exact = q * 10n ** BigInt(d.scale) === d.digits;
  return format({ digits: d.digits < 0n && !exact ? q - 1n : q, scale: 0 });
}

function representatives(type: ExprType, constants: ReadonlySet<string>, values: ReadonlySet<string | boolean>): (string | boolean)[] | string {
  switch (type.kind) {
    case 'BOOLEAN':
      return [false, true];
    case 'CATEGORY': {
      const domain = [...type.values];
      for (const v of values) if (typeof v !== 'string' || !domain.includes(v)) return `value ${JSON.stringify(v)} is not in the category list`;
      if (constants.size > 0) return 'a category is compared with a number';
      return domain;
    }
    case 'DECIMAL': {
      if (values.size > 0) return 'a number is compared with a category or boolean';
      const sorted = [...constants].sort(compareDecimal);
      if (sorted.length === 0) return ['0'];
      const points: string[] = [subtractDecimal(sorted[0] as string, '1')];
      sorted.forEach((c, i) => {
        points.push(c);
        const next = sorted[i + 1];
        if (next !== undefined) points.push(midpointDecimal(c, next));
      });
      points.push(addDecimal(sorted[sorted.length - 1] as string, '1'));
      return points;
    }
    case 'COUNT': {
      if (values.size > 0) return 'a count is compared with a category or boolean';
      const set = new Map<string, string>();
      for (const c of constants) {
        const f = floorDecimal(c);
        for (const k of [subtractDecimal(f, '1'), f, addDecimal(f, '1'), addDecimal(f, '2')]) set.set(k, k);
      }
      if (set.size === 0) set.set('0', '0');
      return [...set.values()].sort(compareDecimal);
    }
    default:
      return `guards on ${type.kind.toLowerCase()} values cannot be analysed`;
  }
}

/** Evaluates a formula at a point (every variable of the formula is assigned). */
export function evaluateGuard(f: GuardFormula, at: Point): boolean {
  switch (f.op) {
    case 'const':
      return f.value;
    case 'not':
      return !evaluateGuard(f.arg, at);
    case 'and':
      return f.args.every((a) => evaluateGuard(a, at));
    case 'or':
      return f.args.some((a) => evaluateGuard(a, at));
    case 'cmp': {
      const v = at.get(f.variable);
      if (typeof v !== 'string') throw new Error(`internal: ${f.variable} is not numeric at this point`);
      const c = compareDecimal(v, f.constant);
      switch (f.cmp) {
        case '<':
          return c < 0;
        case '<=':
          return c <= 0;
        case '>':
          return c > 0;
        case '>=':
          return c >= 0;
        case '==':
          return c === 0;
        case '!=':
          return c !== 0;
      }
      return false;
    }
    case 'is':
      return at.get(f.variable) === f.value;
    case 'opaque':
      throw new Error('internal: an opaque guard cannot be evaluated');
  }
}

export function analyseGuards(branches: readonly GuardBranch[], types: ReadonlyMap<string, ExprType>, maxPoints: number): GuardAnalysis {
  const vars = new Map<string, { constants: Set<string>; values: Set<string | boolean> }>();
  for (const b of branches) {
    if (!b.formula) continue;
    const opaque = collect(b.formula, vars);
    if (opaque !== undefined) return { decided: false, reason: `the condition of branch ${b.id} is outside the decidable form (${opaque})`, overlaps: [], dead: [] };
  }
  const axes: [string, (string | boolean)[]][] = [];
  let size = 1;
  for (const [name, v] of [...vars.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const type = types.get(name);
    if (!type) return { decided: false, reason: `${name} is not a declared value`, overlaps: [], dead: [] };
    const reps = representatives(type, v.constants, v.values);
    if (typeof reps === 'string') return { decided: false, reason: `${name}: ${reps}`, overlaps: [], dead: [] };
    axes.push([name, reps]);
    size *= reps.length;
    if (size > maxPoints) return { decided: false, reason: `more than ${maxPoints} cases to check`, overlaps: [], dead: [] };
  }
  const explicit = branches.filter((b) => b.formula !== undefined);
  const otherwise = branches.find((b) => b.formula === undefined);
  const taken = new Set<string>();
  const overlaps = new Map<string, { a: string; b: string; at: Point }>();
  let uncovered: Point | undefined;
  const point = new Map<string, string | boolean>();
  const visit = (axis: number): void => {
    if (axis === axes.length) {
      const hits = explicit.filter((b) => evaluateGuard(b.formula as GuardFormula, point)).map((b) => b.id);
      for (const h of hits) taken.add(h);
      if (hits.length === 0) {
        if (otherwise) taken.add(otherwise.id);
        else uncovered ??= new Map(point);
      }
      for (let i = 0; i < hits.length; i++) {
        for (let j = i + 1; j < hits.length; j++) {
          const key = `${hits[i]}|${hits[j]}`;
          if (!overlaps.has(key)) overlaps.set(key, { a: hits[i] as string, b: hits[j] as string, at: new Map(point) });
        }
      }
      return;
    }
    const [name, reps] = axes[axis] as [string, (string | boolean)[]];
    for (const r of reps) {
      point.set(name, r);
      visit(axis + 1);
    }
    point.delete(name);
  };
  visit(0);
  const result: GuardAnalysis = { decided: true, overlaps: [...overlaps.values()], dead: branches.filter((b) => !taken.has(b.id)).map((b) => b.id) };
  if (uncovered) result.uncovered = uncovered;
  return result;
}

export function describePoint(p: Point): string {
  return [...p.entries()].map(([k, v]) => `${k} = ${String(v)}`).join(', ') || 'any value';
}
