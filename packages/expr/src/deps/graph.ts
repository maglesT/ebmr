/**
 * Dependencies between calculations, decisions and targets (ADR 0005 decision 7; outline 6.3 "no
 * calculation cycles"; outline 5.2.3 corrections whose dependents were already acted on, L-09).
 *
 * Every node declares what it reads (input paths and the ids of other nodes). The graph rejects
 * cycles and fixes one deterministic evaluation order. When an input is corrected, its transitive
 * dependents are classified for the engine:
 * - DERIVED_RESULT (a calculation, or a target not yet executed): recalculate, keep the earlier
 *   result, flag signed dependents for re-verification.
 * - DECISION_INPUT (a branch condition, loop exit, IPC pass/fail or hold-back already decided):
 *   never re-route the executed path; re-evaluate and, if the outcome would differ, raise a
 *   decision-affecting-correction exception that only QA can disposition.
 * - EXECUTED_TARGET (e.g. a dispense quantity already weighed and charged): never recomputed
 *   silently; a new target outside tolerance of what was executed raises an exception.
 */
import { Dec } from '../decimal/dec.ts';
import { fromRational, rAbs, rCmp, rDiv, rMul, rSub, toRational } from '../decimal/exact.ts';
import { diagnostic, type Diagnostic } from '../diagnostics.ts';
import { compareCodePoints } from '../evidence/hash.ts';
import { toBaseRational } from '../units/quantity.ts';
import { parseUnit, sameDimension } from '../units/unit.ts';

export type DependencyKind = 'CALCULATION' | 'DECISION' | 'TARGET';

export interface DependencyNode {
  /** Calculation name, decision id or target id; other nodes read its value under this id. */
  readonly id: string;
  readonly kind: DependencyKind;
  /** Input paths and node ids it reads. */
  readonly reads: readonly string[];
  /** DECISION: already taken. TARGET: already executed (weighed, charged). */
  readonly acted?: boolean;
}

export interface DependencyGraph {
  readonly nodes: ReadonlyMap<string, DependencyNode>;
  /** Deterministic topological order (ties broken by id in code-point order). */
  readonly order: readonly string[];
  /** For each id or input path: the nodes that read it directly. */
  readonly readers: ReadonlyMap<string, readonly string[]>;
}

export type GraphResult = { ok: true; graph: DependencyGraph } | { ok: false; cycles: readonly (readonly string[])[]; diagnostics: readonly Diagnostic[] };

function tarjan(ids: readonly string[], edges: ReadonlyMap<string, readonly string[]>): string[][] {
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  const strong = (v: string): void => {
    idx.set(v, index);
    low.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!idx.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v) ?? 0, low.get(w) ?? 0));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v) ?? 0, idx.get(w) ?? 0));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const scc: string[] = [];
      for (;;) {
        const w = stack.pop();
        if (w === undefined) break;
        onStack.delete(w);
        scc.push(w);
        if (w === v) break;
      }
      const self = scc.length === 1 && (edges.get(v) ?? []).includes(v);
      if (scc.length > 1 || self) out.push(scc.sort(compareCodePoints));
    }
  };
  for (const id of ids) if (!idx.has(id)) strong(id);
  return out.sort((a, b) => compareCodePoints(a[0] ?? '', b[0] ?? ''));
}

/** Builds the graph; refuses duplicate ids and cycles with a plain-language diagnostic. */
export function buildDependencyGraph(nodes: readonly DependencyNode[]): GraphResult {
  const diagnostics: Diagnostic[] = [];
  const map = new Map<string, DependencyNode>();
  for (const n of nodes) {
    if (map.has(n.id)) diagnostics.push(diagnostic('EXPR-DEP-002', 'ERROR', `Two calculations, decisions or targets are named "${n.id}"`));
    map.set(n.id, n);
  }
  if (diagnostics.length > 0) return { ok: false, cycles: [], diagnostics };
  const ids = [...map.keys()].sort(compareCodePoints);
  // Edge dependency -> dependent restricted to nodes (inputs are sources).
  const dependsOn = new Map<string, string[]>();
  const readers = new Map<string, string[]>();
  for (const id of ids) {
    const n = map.get(id);
    if (n === undefined) continue;
    const deps = [...new Set(n.reads)].sort(compareCodePoints);
    dependsOn.set(id, deps.filter((d) => map.has(d)));
    for (const d of deps) readers.set(d, [...(readers.get(d) ?? []), id]);
  }
  const cycles = tarjan(ids, dependsOn);
  if (cycles.length > 0) {
    return {
      ok: false,
      cycles,
      diagnostics: cycles.map((c) =>
        diagnostic('EXPR-DEP-001', 'ERROR', `These calculations depend on each other in a cycle, so none can be computed first: ${[...c, c[0] ?? ''].join(' -> ')}`),
      ),
    };
  }
  // Kahn's algorithm with a sorted ready list: one deterministic order.
  const remaining = new Map(ids.map((id) => [id, (dependsOn.get(id) ?? []).length]));
  const ready = ids.filter((id) => remaining.get(id) === 0);
  const order: string[] = [];
  while (ready.length > 0) {
    ready.sort(compareCodePoints);
    const id = ready.shift();
    if (id === undefined) break;
    order.push(id);
    for (const r of readers.get(id) ?? []) {
      const left = (remaining.get(r) ?? 0) - 1;
      remaining.set(r, left);
      if (left === 0) ready.push(r);
    }
  }
  return { ok: true, graph: { nodes: map, order, readers } };
}

export type DependentClass = 'DERIVED_RESULT' | 'DECISION_INPUT' | 'EXECUTED_TARGET';
export type DependentAction =
  /** Recalculate, keep the earlier result, flag signed dependents for re-verification. */
  | 'RECALCULATE_KEEP_PREVIOUS'
  /** Re-evaluate without re-routing; raise a decision-affecting-correction exception if it would differ. */
  | 'REEVALUATE_RAISE_EXCEPTION_IF_CHANGED'
  /** The decision is not taken yet: it will use the corrected value. */
  | 'NONE_NOT_YET_TAKEN'
  /** Never recompute silently: compare with what was executed; outside tolerance raises an exception. */
  | 'COMPARE_WITH_EXECUTED';

export interface ClassifiedDependent {
  readonly id: string;
  readonly kind: DependencyKind;
  readonly classification: DependentClass;
  readonly action: DependentAction;
  /** One dependency chain from the corrected input to this node. */
  readonly via: readonly string[];
  readonly explanation: string;
}

/** Every node affected by a correction of `corrected` (an input path or node id), in evaluation order. */
export function classifyDependents(graph: DependencyGraph, corrected: string): ClassifiedDependent[] {
  const via = new Map<string, string[]>();
  const queue: string[] = [corrected];
  via.set(corrected, [corrected]);
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur === undefined) break;
    for (const r of graph.readers.get(cur) ?? []) {
      if (!via.has(r)) {
        via.set(r, [...(via.get(cur) ?? []), r]);
        queue.push(r);
      }
    }
  }
  const out: ClassifiedDependent[] = [];
  for (const id of graph.order) {
    const path = via.get(id);
    const n = graph.nodes.get(id);
    if (path === undefined || n === undefined || id === corrected) continue;
    const acted = n.acted === true;
    let classification: DependentClass;
    let action: DependentAction;
    let explanation: string;
    if (n.kind === 'DECISION') {
      classification = 'DECISION_INPUT';
      action = acted ? 'REEVALUATE_RAISE_EXCEPTION_IF_CHANGED' : 'NONE_NOT_YET_TAKEN';
      explanation = acted
        ? `"${id}" was already decided: it is re-evaluated but the executed path is never re-routed; if it would now decide differently, a decision-affecting-correction exception is raised that only QA can disposition`
        : `"${id}" has not been decided yet and will use the corrected value`;
    } else if (n.kind === 'TARGET' && acted) {
      classification = 'EXECUTED_TARGET';
      action = 'COMPARE_WITH_EXECUTED';
      explanation = `"${id}" was already executed: it is never recomputed silently; a new target outside tolerance of what was executed raises an exception`;
    } else {
      classification = 'DERIVED_RESULT';
      action = 'RECALCULATE_KEEP_PREVIOUS';
      explanation = `"${id}" is recalculated; the earlier result is kept and signed dependents are flagged for re-verification`;
    }
    out.push({ id, kind: n.kind, classification, action, via: path, explanation });
  }
  return out;
}

/** Decision re-evaluated after a correction (outline 5.2.3): never re-routes, only flags. */
export function assessDecisionChange(previous: boolean | string, recomputed: boolean | string): { changed: boolean; action: 'NONE' | 'RAISE_DECISION_AFFECTING_CORRECTION' } {
  const changed = previous !== recomputed;
  return { changed, action: changed ? 'RAISE_DECISION_AFFECTING_CORRECTION' : 'NONE' };
}

export interface QuantityText {
  readonly value: string;
  readonly unit: string;
}

/**
 * A recomputed target compared with what was executed (outline 5.2.3): within tolerance -> no
 * action; outside -> an exception. Tolerance is absolute (a quantity) or relative (percent of the
 * executed value). Exact comparison, no rounding.
 */
export function assessTargetChange(
  executed: QuantityText,
  recomputed: QuantityText,
  tolerance: { readonly absolute: QuantityText } | { readonly percent: string },
): { withinTolerance: boolean; difference: string; unit: string; action: 'NONE' | 'RAISE_TARGET_CHANGE_EXCEPTION' } {
  const eu = parseUnit(executed.unit);
  const ru = parseUnit(recomputed.unit);
  if (!sameDimension(eu, ru)) throw new Error(`the recomputed target (${recomputed.unit}) does not measure the same thing as the executed quantity (${executed.unit})`);
  const e = toBaseRational(Dec.parse(executed.value), eu);
  const r = toBaseRational(Dec.parse(recomputed.value), ru);
  const diff = rAbs(rSub(r, e));
  let limit;
  if ('absolute' in tolerance) {
    const tu = parseUnit(tolerance.absolute.unit);
    if (!sameDimension(tu, eu)) throw new Error('the tolerance does not measure the same thing as the target');
    limit = toBaseRational(Dec.parse(tolerance.absolute.value), tu);
  } else {
    limit = rAbs(rMul(e, rDiv(toRational(Dec.parse(tolerance.percent)), { num: 100n, den: 1n })));
  }
  const within = rCmp(diff, limit) <= 0;
  return {
    withinTolerance: within,
    difference: fromRational(rDiv(rSub(r, e), eu.factor)).value.toString(),
    unit: executed.unit,
    action: within ? 'NONE' : 'RAISE_TARGET_CHANGE_EXCEPTION',
  };
}
