/**
 * A set of named calculations evaluated together in dependency order (the simulator and, later, the
 * engine). A calculation reads another's result through an input declared with source DERIVED whose
 * path is the other calculation's name; the value passed is that calculation's evaluation record,
 * never a typed number (INV-25).
 */
import { diagnostic, type Diagnostic } from '../diagnostics.ts';
import { evaluate, type EvaluateOptions } from '../evidence/record.ts';
import type { EvaluationRecord } from '../evidence/record-types.ts';
import type { CompiledExpression } from '../lang/compile.ts';
import { ExprEvaluationError } from '../lang/errors.ts';
import type { InputValue, InputValues } from '../lang/evaluator.ts';
import { buildDependencyGraph, type DependencyGraph } from './graph.ts';

export type CalculationSetCheck = { ok: true; graph: DependencyGraph; order: readonly string[] } | { ok: false; diagnostics: readonly Diagnostic[] };

/** Checks names, DERIVED links (both ways) and cycles; returns the evaluation order. */
export function checkCalculationSet(programs: readonly CompiledExpression[]): CalculationSetCheck {
  const diagnostics: Diagnostic[] = [];
  const names = new Set<string>();
  for (const p of programs) {
    if (p.name === undefined) diagnostics.push(diagnostic('EXPR-DEP-003', 'ERROR', `Every calculation in a set needs a name (expression "${p.source.slice(0, 40)}")`));
    else names.add(p.name);
  }
  for (const p of programs) {
    for (const [path, d] of Object.entries(p.inputs)) {
      const derived = (d.source ?? 'CAPTURED') === 'DERIVED';
      if (names.has(path) && !derived) {
        diagnostics.push(
          diagnostic('EXPR-INV25-002', 'ERROR', `"${p.name ?? ''}" reads the result of calculation "${path}" as a typed input; declare it with source DERIVED so the computed value is used`, undefined, 'INV-25'),
        );
      }
      if (derived && !names.has(path)) {
        diagnostics.push(diagnostic('EXPR-DEP-004', 'ERROR', `"${p.name ?? ''}" reads "${path}" as a derived value, but no calculation of that name is in the set`, undefined, 'INV-25'));
      }
    }
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  const g = buildDependencyGraph(programs.map((p) => ({ id: p.name ?? '', kind: 'CALCULATION' as const, reads: Object.keys(p.inputs) })));
  if (!g.ok) return { ok: false, diagnostics: g.diagnostics };
  return { ok: true, graph: g.graph, order: g.graph.order };
}

export type CalculationOutcome = { ok: true; record: EvaluationRecord } | { ok: false; error: ExprEvaluationError };

/**
 * Evaluates every calculation in dependency order. `inputs` holds the recorded (non-derived) inputs
 * by path; each calculation receives the ones it declares. A calculation whose derived input failed
 * fails with MISSING_INPUT naming it.
 */
export function evaluateCalculationSet(
  programs: readonly CompiledExpression[],
  inputs: InputValues,
  options: EvaluateOptions = {},
): { order: readonly string[]; results: Readonly<Record<string, CalculationOutcome>> } {
  const check = checkCalculationSet(programs);
  if (!check.ok) throw new Error(`the calculation set is not valid: ${check.diagnostics.map((d) => d.message).join('; ')}`);
  const byName = new Map(programs.map((p) => [p.name ?? '', p]));
  const results: Record<string, CalculationOutcome> = {};
  for (const name of check.order) {
    const program = byName.get(name);
    if (program === undefined) continue;
    const own: Record<string, InputValue> = {};
    for (const [path, d] of Object.entries(program.inputs)) {
      if ((d.source ?? 'CAPTURED') === 'DERIVED') {
        const r = results[path];
        if (r?.ok === true) own[path] = { derived: r.record };
      } else {
        const v = inputs[path];
        if (v !== undefined) own[path] = v;
      }
    }
    try {
      results[name] = { ok: true, record: evaluate(program, own, options) };
    } catch (e) {
      if (!(e instanceof ExprEvaluationError)) throw e;
      const upstream = e.code === 'MISSING_INPUT' && e.path !== undefined && results[e.path]?.ok === false;
      results[name] = {
        ok: false,
        error: upstream ? new ExprEvaluationError('MISSING_INPUT', `"${name}" cannot be computed because calculation "${e.path ?? ''}" has no result`, { paths: e.paths }) : e,
      };
    }
  }
  return { order: check.order, results };
}
