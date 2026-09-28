/**
 * `ExpressionService` implemented with the expression language (@ebmr/expr; ADR 0005).
 *
 * Every expression is compiled against declarations of exactly the inputs it references (so a bad
 * declaration elsewhere in the MBR is never blamed on it), with its role (a derived CALCULATION or a
 * true/false CONDITION) and, for calculations, the declared output that the result is converted to.
 * Compiled programs are cached per source, declarations and options.
 */
import {
  boundaryValuesForBound,
  compareToBound as exprCompareToBound,
  compile,
  convertValue,
  Dec,
  EXPR_LANGUAGE_VERSION,
  isTag,
  MAX_SERIES_LENGTH,
  parse,
  parseUnit,
  referencedPaths,
  sameDimension,
  toGuardFormula,
  tryEvaluate,
  UnitError,
  type CompiledExpression,
  type Diagnostic,
  type InputDeclaration,
  type InputValue,
  type OutputDeclaration,
  type Tag,
  type TypeDescription,
} from '@ebmr/expr';
import type { LimitBound, RoundingRule } from '../limits/model.ts';
import type {
  BoundaryVector,
  BoundComparison,
  EvaluationOutcome,
  ExpressionCheck,
  ExpressionOptions,
  ExpressionProblem,
  ExpressionService,
  ExprType,
  ExprValue,
  GuardFormula,
} from './expression-port.ts';

type Compiled = { ok: true; program: CompiledExpression; diagnostics: readonly Diagnostic[]; reads: string[] } | { ok: false; diagnostics: readonly Diagnostic[]; reads: string[] };

function tagOf(tag: string | undefined): Tag | undefined {
  return tag !== undefined && isTag(tag) ? tag : undefined;
}

/** Declaration of one input for the expression language. */
export function declarationOf(t: ExprType): InputDeclaration | { problem: string } {
  switch (t.kind) {
    case 'DECIMAL': {
      const tag = t.tag === undefined ? undefined : tagOf(t.tag);
      if (t.tag !== undefined && tag === undefined) return { problem: `unknown semantic tag ${JSON.stringify(t.tag)}` };
      return tag === undefined ? { kind: 'quantity', unit: t.unit } : { kind: 'quantity', unit: t.unit, tag };
    }
    case 'COUNT':
      return { kind: 'quantity', unit: '1', tag: 'count' };
    case 'BOOLEAN':
      return { kind: 'boolean' };
    case 'CATEGORY':
      return { kind: 'category', values: [...t.values] };
    case 'TEXT':
      return { kind: 'text' };
    case 'INSTANT':
      return { kind: 'instant' };
    case 'SERIES': {
      const element = t.of;
      const maxLength = Math.min(t.maxLength ?? MAX_SERIES_LENGTH, MAX_SERIES_LENGTH);
      if (element.kind === 'COUNT') return { kind: 'series', unit: '1', tag: 'count', maxLength };
      if (element.kind !== 'DECIMAL') return { problem: `a series of ${element.kind.toLowerCase()} values cannot be read by an expression` };
      const tag = element.tag === undefined ? undefined : tagOf(element.tag);
      if (element.tag !== undefined && tag === undefined) return { problem: `unknown semantic tag ${JSON.stringify(element.tag)}` };
      return tag === undefined ? { kind: 'series', unit: element.unit, maxLength } : { kind: 'series', unit: element.unit, tag, maxLength };
    }
  }
}

function outputOf(t: ExprType | undefined): OutputDeclaration | undefined {
  if (!t) return undefined;
  if (t.kind === 'BOOLEAN') return { kind: 'boolean' };
  if (t.kind === 'COUNT') return { kind: 'quantity', unit: '1', tag: 'count' };
  if (t.kind === 'DECIMAL') {
    const tag = tagOf(t.tag);
    return tag === undefined ? { kind: 'quantity', unit: t.unit } : { kind: 'quantity', unit: t.unit, tag };
  }
  return undefined;
}

function typeOf(d: TypeDescription): ExprType {
  switch (d.kind) {
    case 'quantity':
      if (d.tag === 'count' && d.unit === '1') return { kind: 'COUNT' };
      return d.tag === 'none' ? { kind: 'DECIMAL', unit: d.unit } : { kind: 'DECIMAL', unit: d.unit, tag: d.tag };
    case 'series': {
      const of: ExprType = d.tag === 'count' && d.unit === '1' ? { kind: 'COUNT' } : d.tag === 'none' ? { kind: 'DECIMAL', unit: d.unit } : { kind: 'DECIMAL', unit: d.unit, tag: d.tag };
      return { kind: 'SERIES', of, maxLength: d.maxLength };
    }
    case 'boolean':
      return { kind: 'BOOLEAN' };
    case 'category':
      return { kind: 'CATEGORY', values: d.values };
    case 'instant':
      return { kind: 'INSTANT' };
    default:
      return { kind: 'TEXT' };
  }
}

function problemOf(d: Diagnostic): ExpressionProblem {
  const p: ExpressionProblem = { code: d.code, message: d.message, severity: d.severity === 'ERROR' ? 'ERROR' : 'WARNING' };
  if (d.start !== undefined) p.start = d.start;
  if (d.end !== undefined) p.end = d.end;
  return p;
}

function inputValue(v: ExprValue, t: ExprType | undefined): InputValue {
  const source = 'SIMULATION';
  switch (v.kind) {
    case 'DECIMAL': {
      const tag = t?.kind === 'DECIMAL' ? tagOf(t.tag) : undefined;
      return tag === undefined ? { value: v.value, unit: v.unit, source } : { value: v.value, unit: v.unit, tag, source };
    }
    case 'COUNT':
      return { value: v.value, unit: '1', tag: 'count', source };
    case 'BOOLEAN':
      return { boolean: v.value, source };
    case 'CATEGORY':
      return { category: v.value, source };
    case 'TEXT':
      return { text: v.value, source };
    case 'SERIES': {
      const element = t?.kind === 'SERIES' ? t.of : undefined;
      const tag = element?.kind === 'COUNT' ? 'count' : element?.kind === 'DECIMAL' ? tagOf(element.tag) : undefined;
      return tag === undefined ? { values: [...v.values], unit: v.unit, source } : { values: [...v.values], unit: v.unit, tag, source };
    }
  }
}

export interface ExprAdapterOptions {
  /** Compiled programs kept in memory (default 5,000). */
  cacheSize?: number;
}

export function createExprService(options: ExprAdapterOptions = {}): ExpressionService {
  const cacheSize = options.cacheSize ?? 5_000;
  const cache = new Map<string, Compiled>();

  const compiled = (source: string, inputs: ReadonlyMap<string, ExprType>, opts: ExpressionOptions): Compiled => {
    const parsed = parse(source);
    const referenced = parsed.ok ? [...new Set(referencedPaths(parsed.ast))].sort() : [];
    const declarations: Record<string, InputDeclaration> = {};
    const problems: Diagnostic[] = [];
    for (const name of referenced) {
      const t = inputs.get(name);
      if (!t) continue;
      const d = declarationOf(t);
      if ('problem' in d) problems.push({ code: 'RC-EXPR-001', severity: 'ERROR', message: `${name}: ${d.problem}`, control: 'DI-33', requiresJustification: false });
      else declarations[name] = d;
    }
    const output = opts.role === 'CALCULATION' ? outputOf(opts.output) : undefined;
    const key = JSON.stringify([source, declarations, opts.role, output ?? null]);
    const hit = cache.get(key);
    if (hit) return hit;
    const reads = referenced.filter((r) => inputs.has(r));
    let result: Compiled;
    if (problems.length > 0) result = { ok: false, diagnostics: problems, reads };
    else {
      const c = compile(source, {
        inputs: declarations,
        role: opts.role === 'CONDITION' ? 'condition' : 'calculation',
        ...(output === undefined ? {} : { output }),
      });
      result = c.ok ? { ok: true, program: c.program, diagnostics: c.diagnostics, reads: [...c.program.reads] } : { ok: false, diagnostics: c.diagnostics, reads };
    }
    if (cache.size >= cacheSize) cache.delete(cache.keys().next().value as string);
    cache.set(key, result);
    return result;
  };

  const unitOrUndefined = (code: string): ReturnType<typeof parseUnit> | undefined => {
    try {
      return parseUnit(code);
    } catch (e) {
      if (e instanceof UnitError) return undefined;
      throw e;
    }
  };

  const bound = (b: LimitBound): { value: string; inclusive: boolean } => ({ value: b.value, inclusive: b.inclusive });

  return {
    languageVersion: EXPR_LANGUAGE_VERSION,

    check(source, inputs, opts): ExpressionCheck {
      const c = compiled(source, inputs, opts);
      const problems = c.diagnostics.filter((d) => d.severity !== 'INFO').map(problemOf);
      const out: ExpressionCheck = { ok: c.ok, problems, reads: c.reads };
      if (c.ok) out.type = typeOf(c.program.resultType);
      return out;
    },

    evaluate(source, inputs, values, opts): EvaluationOutcome {
      const c = compiled(source, inputs, opts);
      if (!c.ok) return { ok: false, code: 'NOT_COMPILED', message: c.diagnostics.map((d) => d.message).join('; ') || 'the expression does not check' };
      const given: Record<string, InputValue> = {};
      for (const name of c.program.reads) {
        const v = values.get(name);
        if (v !== undefined) given[name] = inputValue(v, inputs.get(name));
      }
      const r = tryEvaluate(c.program, given);
      if (!r.ok) {
        const out: EvaluationOutcome = { ok: false, code: r.error.code, message: r.error.message };
        if (r.error.path !== undefined) out.input = r.error.path;
        return out;
      }
      const o = r.record.output;
      if (o.kind === 'boolean') return { ok: true, value: { kind: 'BOOLEAN', value: o.value === 'true' } };
      if (opts.output?.kind === 'COUNT' || (o.tag === 'count' && o.unit === '1')) return { ok: true, value: { kind: 'COUNT', value: o.value } };
      return { ok: true, value: { kind: 'DECIMAL', value: o.value, unit: o.unit ?? '1' } };
    },

    guard(source, inputs): GuardFormula {
      const c = compiled(source, inputs, { role: 'CONDITION' });
      if (!c.ok) return { op: 'opaque', reason: 'the condition does not check' };
      return toGuardFormula(c.program);
    },

    compareToBound(value: string, b: LimitBound, side: 'LOW' | 'HIGH', rounding: RoundingRule, other?: LimitBound): BoundComparison {
      const r = exprCompareToBound(Dec.parse(value), bound(b), side, rounding, other === undefined ? undefined : bound(other));
      return { pass: r.pass, rounded: r.rounded };
    },

    boundaryVectors(b: LimitBound, side: 'LOW' | 'HIGH', rounding: RoundingRule, other?: LimitBound): BoundaryVector[] {
      return boundaryValuesForBound(bound(b), side, rounding, other === undefined ? undefined : bound(other)).map((v) => ({ value: v.value, expected: v.expected, label: v.label, description: v.description }));
    },

    unit(code) {
      try {
        const u = parseUnit(code);
        return { ok: true, dimension: u.dimensionKey };
      } catch (e) {
        if (e instanceof UnitError) return { ok: false, message: e.message };
        throw e;
      }
    },

    convert(value, from, to) {
      const f = unitOrUndefined(from);
      const t = unitOrUndefined(to);
      if (!f || !t || !sameDimension(f, t)) return undefined;
      const r = convertValue(Dec.parse(value), f, t);
      if (r.conversion !== null && !r.conversion.exact) return undefined;
      return r.value.toString();
    },

    compare(a, b) {
      const c = Dec.parse(a).cmp(Dec.parse(b));
      return c < 0 ? -1 : c > 0 ? 1 : 0;
    },
  };
}
