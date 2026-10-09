/**
 * Calculations against the author's golden inputs (outline 6.4 test vectors, 6.5 "calculations
 * against golden inputs"; DI-04). Each golden case supplies inputs and the expected results the
 * author confirmed; every calculation whose inputs are available is evaluated in dependency order,
 * and each expected result must match to the decimals the author wrote (compared through the
 * expression language's rounding, the same rounding a limit comparison uses).
 */
import type { ExprType, ExprValue } from '../flow/expression-port.ts';
import type { GoldenCase, GoldenValue } from '../flow/model.ts';
import { calculationOptions, GLOBAL_SCOPE, type Analysis } from '../validator/analysis.ts';

export interface GoldenResult {
  case: string;
  calculation: string;
  status: 'PASS' | 'FAIL' | 'ERROR' | 'NOT_EVALUATED';
  expected: string | null;
  actual: string | null;
  message: string;
}

function toValue(a: Analysis, g: GoldenValue, t: ExprType | undefined): ExprValue | undefined {
  if ('bool' in g) return { kind: 'BOOLEAN', value: g.bool };
  if ('category' in g) return { kind: 'CATEGORY', value: g.category };
  if ('series' in g) {
    const element = t?.kind === 'SERIES' ? t.of : undefined;
    const target = element?.kind === 'DECIMAL' ? element.unit : (g.unit ?? '1');
    const from = g.unit ?? target;
    const values = g.series.map((x) => (from === target ? x : a.ctx.expressions.convert(x, from, target)));
    return values.every((x): x is string => x !== undefined) ? { kind: 'SERIES', values, unit: target } : undefined;
  }
  if (t?.kind === 'COUNT') return { kind: 'COUNT', value: g.value };
  const unit = g.unit ?? (t?.kind === 'DECIMAL' ? t.unit : '1');
  if (t?.kind === 'DECIMAL' && t.unit !== unit) {
    const v = a.ctx.expressions.convert(g.value, unit, t.unit);
    return v === undefined ? undefined : { kind: 'DECIMAL', value: v, unit: t.unit };
  }
  return { kind: 'DECIMAL', value: g.value, unit };
}

function show(v: ExprValue): string {
  if (v.kind === 'SERIES') return `[${v.values.join(', ')}] ${v.unit}`;
  return v.kind === 'DECIMAL' ? `${v.value} ${v.unit}` : String(v.value);
}

function matches(a: Analysis, expected: GoldenValue, actual: ExprValue): boolean {
  if ('bool' in expected) return actual.kind === 'BOOLEAN' && actual.value === expected.bool;
  if ('category' in expected) return actual.kind === 'CATEGORY' && actual.value === expected.category;
  if ('series' in expected) return false;
  if (actual.kind !== 'DECIMAL' && actual.kind !== 'COUNT') return false;
  const unit = actual.kind === 'DECIMAL' ? actual.unit : '1';
  const value = expected.unit !== undefined && expected.unit !== unit ? a.ctx.expressions.convert(actual.value, unit, expected.unit) : actual.value;
  if (value === undefined) return false;
  const bound = { value: expected.value, inclusive: true };
  const expr = a.ctx.expressions;
  return expr.compareToBound(value, bound, 'LOW', 'USP_HALF_UP_AT_LIMIT_DECIMALS').pass && expr.compareToBound(value, bound, 'HIGH', 'USP_HALF_UP_AT_LIMIT_DECIMALS').pass;
}

/** Calculations in dependency order (cycles are left out; the validator reports them). */
export function calculationOrder(a: Analysis): string[] {
  const deps = new Map(a.mbr.calculations.map((c) => [c.id, a.expression(c.expression, GLOBAL_SCOPE, a.taskOf(a.writers.get(c.id)?.[0] ?? ''), calculationOptions(a, c.id)).reads.filter((r) => a.calculations.has(r))]));
  const order: string[] = [];
  const state = new Map<string, 1 | 2>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 2) return true;
    if (state.get(id) === 1) return false;
    state.set(id, 1);
    const ok = (deps.get(id) ?? []).every(visit);
    state.set(id, 2);
    if (ok) order.push(id);
    return ok;
  };
  for (const c of [...deps.keys()].sort()) visit(c);
  return order;
}

export function runGoldenCase(a: Analysis, g: GoldenCase): GoldenResult[] {
  const out: GoldenResult[] = [];
  const values = new Map<string, ExprValue>();
  for (const [id, gv] of Object.entries(g.inputs)) {
    const v = toValue(a, gv, a.declaredType(id));
    if (v) values.set(id, v);
  }
  const computed = new Map<string, ExprValue>();
  for (const id of calculationOrder(a)) {
    if (values.has(id)) continue;
    const calc = a.calculations.get(id);
    if (!calc) continue;
    const reader = a.taskOf(a.writers.get(id)?.[0] ?? '');
    const checked = a.expression(calc.expression, GLOBAL_SCOPE, reader, calculationOptions(a, id));
    const expected = g.expected[id];
    if (!checked.check.ok || !checked.reads.every((r) => values.has(r))) {
      if (expected) {
        const lacking = checked.reads.filter((r) => !values.has(r));
        out.push({ case: g.id, calculation: id, status: 'NOT_EVALUATED', expected: 'value' in expected ? expected.value : null, actual: null, message: `inputs missing: ${lacking.join(', ') || 'expression does not check'}` });
      }
      continue;
    }
    const env = a.envAt(GLOBAL_SCOPE, reader);
    const result = a.ctx.expressions.evaluate(calc.expression, env, values, calculationOptions(a, id));
    if (!result.ok) {
      if (expected) out.push({ case: g.id, calculation: id, status: 'ERROR', expected: 'value' in expected ? expected.value : null, actual: null, message: `${result.code}: ${result.message}` });
      continue;
    }
    values.set(id, result.value);
    computed.set(id, result.value);
    if (expected) {
      const ok = matches(a, expected, result.value);
      out.push({
        case: g.id,
        calculation: id,
        status: ok ? 'PASS' : 'FAIL',
        expected: 'value' in expected ? `${expected.value}${expected.unit ? ` ${expected.unit}` : ''}` : 'bool' in expected ? String(expected.bool) : 'category' in expected ? expected.category : `[${expected.series.join(', ')}]`,
        actual: show(result.value),
        message: ok ? 'matches the confirmed result' : 'differs from the confirmed result',
      });
    }
  }
  for (const id of Object.keys(g.expected)) {
    if (!a.calculations.has(id)) out.push({ case: g.id, calculation: id, status: 'FAIL', expected: null, actual: null, message: `${id} is not a calculation` });
  }
  return out.sort((x, y) => (x.calculation < y.calculation ? -1 : x.calculation > y.calculation ? 1 : 0));
}
