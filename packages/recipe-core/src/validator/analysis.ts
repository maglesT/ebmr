/**
 * Facts about one MBR computed once and shared by every rule: the expanded tree and compiled graph,
 * indexes of nodes and items, the typed identifier environment at each place an expression is read,
 * and the forward "established on every path" analysis that the written-before-read, equipment
 * status, clearance and BOM gates are built on.
 */
import type { BlockDescriptor, BlockRole } from '../flow/blocks.ts';
import { compileMbr } from '../flow/compile.ts';
import type { ExpandedFlow } from '../flow/expand.ts';
import type { ExpressionCheck, ExpressionOptions, ExprType } from '../flow/expression-port.ts';
import { forwardTopologicalOrder, indexGraph, type ExecutionGraph, type GraphIndex, type GraphNode } from '../flow/graph.ts';
import {
  childrenOf,
  type BomLine,
  type Calculation,
  type ExternalInput,
  type FlowNode,
  type Intermediate,
  type Level,
  type MbrContent,
  type Parameter,
  type PhaseNode,
  type Reference,
  type RiskReduction,
  type TimeConstraint,
  type ValueKind,
  type YieldCheckpoint,
} from '../flow/model.ts';
import type { AcceptanceScheme } from '../limits/model.ts';
import { DEFAULT_LIMITS, type AnalysisLimits, type ValidationContext } from './types.ts';

export interface NodeInfo {
  node: FlowNode;
  level: Level;
  parent: string | undefined;
  stage: string | undefined;
  operation: string | undefined;
  /** Ancestor node ids, outermost first. */
  ancestors: string[];
}

export type DataItem = { kind: 'input'; def: ExternalInput } | { kind: 'parameter'; def: Parameter } | { kind: 'calculation'; def: Calculation };

export interface CheckedExpression {
  check: ExpressionCheck;
  /** MBR data ids the expression reads (library-local names resolved). */
  reads: string[];
  /** Names read inside a library element that are not bound symbols. */
  unbound: string[];
}

export function valueType(kind: ValueKind, unit: string | undefined, tag: string | undefined, categories: readonly string[] | undefined): ExprType {
  switch (kind) {
    case 'DECIMAL': {
      const t: ExprType = { kind: 'DECIMAL', unit: unit ?? '1' };
      if (tag !== undefined) t.tag = tag;
      return t;
    }
    case 'COUNT':
      return { kind: 'COUNT' };
    case 'BOOLEAN':
      return { kind: 'BOOLEAN' };
    case 'CATEGORY':
      return { kind: 'CATEGORY', values: categories ?? [] };
    case 'TEXT':
      return { kind: 'TEXT' };
    case 'INSTANT':
      return { kind: 'INSTANT' };
  }
}

/** Tree id for MBR-level expressions (calculations): they read MBR ids, never library-local names. */
export const GLOBAL_SCOPE = '\u0000global';

/** How a calculation is checked and evaluated: a derived value with its declared output. */
export function calculationOptions(a: Analysis, id: string): ExpressionOptions {
  const out = a.declaredType(id);
  return out ? { role: 'CALCULATION', output: out } : { role: 'CALCULATION' };
}

export const CONDITION: ExpressionOptions = { role: 'CONDITION' };

export class Analysis {
  readonly limits: AnalysisLimits;
  readonly expanded: ExpandedFlow;
  readonly graph: ExecutionGraph;
  readonly gi: GraphIndex;
  /** Forward topological order (undefined when the graph has an undeclared cycle). */
  readonly topo: string[] | undefined;
  readonly nodes = new Map<string, NodeInfo>();
  readonly duplicateNodeIds: string[] = [];
  readonly phases: PhaseNode[] = [];
  readonly parameters: Map<string, Parameter>;
  readonly calculations: Map<string, Calculation>;
  readonly inputs: Map<string, ExternalInput>;
  readonly data = new Map<string, DataItem>();
  readonly bom: Map<string, BomLine>;
  readonly intermediates: Map<string, Intermediate>;
  readonly yields: Map<string, YieldCheckpoint>;
  readonly schemes: Map<string, AcceptanceScheme>;
  readonly references: Map<string, Reference>;
  readonly timeConstraints: Map<string, TimeConstraint>;
  readonly reductions: Map<string, RiskReduction>;
  /** Phases writing each data id (records and computes). */
  readonly writers = new Map<string, string[]>();
  private readonly exprCache = new Map<string, CheckedExpression>();
  private readonly envCache = new Map<string, Map<string, ExprType>>();

  constructor(
    readonly mbr: MbrContent,
    readonly ctx: ValidationContext,
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...ctx.limits };
    const compiled = compileMbr(mbr);
    this.expanded = compiled.expanded;
    this.graph = compiled.graph;
    this.gi = indexGraph(this.graph);
    this.topo = forwardTopologicalOrder(this.graph);
    this.parameters = new Map(mbr.parameters.map((p) => [p.id, p]));
    this.calculations = new Map(mbr.calculations.map((c) => [c.id, c]));
    this.inputs = new Map(mbr.inputs.map((i) => [i.id, i]));
    for (const i of mbr.inputs) if (!this.data.has(i.id)) this.data.set(i.id, { kind: 'input', def: i });
    for (const p of mbr.parameters) if (!this.data.has(p.id)) this.data.set(p.id, { kind: 'parameter', def: p });
    for (const c of mbr.calculations) if (!this.data.has(c.id)) this.data.set(c.id, { kind: 'calculation', def: c });
    this.bom = new Map(mbr.bom.map((b) => [b.id, b]));
    this.intermediates = new Map(mbr.intermediates.map((i) => [i.id, i]));
    this.yields = new Map(mbr.yieldCheckpoints.map((y) => [y.id, y]));
    this.schemes = new Map(mbr.acceptanceSchemes.map((s) => [s.id, s]));
    this.references = new Map(mbr.references.map((r) => [r.id, r]));
    this.timeConstraints = new Map(mbr.timeConstraints.map((t) => [t.id, t]));
    this.reductions = new Map(mbr.riskReductions.map((r) => [r.id, r]));
    this.indexTree(this.expanded.root, 'PROCEDURE', undefined, undefined, undefined, []);
    for (const p of this.phases) {
      for (const id of [...p.records, ...p.computes]) {
        const list = this.writers.get(id) ?? [];
        list.push(p.id);
        this.writers.set(id, list);
      }
    }
  }

  private indexTree(node: FlowNode, level: Level, parent: string | undefined, stage: string | undefined, operation: string | undefined, ancestors: string[]): void {
    if (this.nodes.has(node.id)) this.duplicateNodeIds.push(node.id);
    else this.nodes.set(node.id, { node, level, parent, stage, operation, ancestors: [...ancestors] });
    if (node.kind === 'phase') this.phases.push(node);
    const childLevel: Level = node.kind === 'stage' ? 'STAGE' : node.kind === 'operation' ? 'OPERATION' : level;
    const childStage = node.kind === 'stage' ? node.id : stage;
    const childOperation = node.kind === 'operation' ? node.id : operation;
    ancestors.push(node.id);
    for (const c of childrenOf(node)) this.indexTree(c, childLevel, node.id, childStage, childOperation, ancestors);
    ancestors.pop();
  }

  describe(phase: PhaseNode): BlockDescriptor | undefined {
    const d = this.ctx.blocks.describe(phase.block.type);
    return d && d.versions.includes(phase.block.version) ? d : undefined;
  }

  hasRole(phase: PhaseNode, role: BlockRole): boolean {
    return this.describe(phase)?.roles.includes(role) ?? false;
  }

  /** Graph node of a tree node: the task for a phase, the hold node, or a construct's opener/closer. */
  graphNodes(treeId: string): GraphNode[] {
    return (this.gi.bySource.get(treeId) ?? []).map((id) => this.gi.node.get(id)).filter((n): n is GraphNode => n !== undefined);
  }

  graphNodeOf(treeId: string, kind: GraphNode['kind']): GraphNode | undefined {
    return this.graphNodes(treeId).find((n) => n.kind === kind);
  }

  taskOf(phaseId: string): GraphNode | undefined {
    return this.graphNodeOf(phaseId, 'TASK');
  }

  declaredType(id: string): ExprType | undefined {
    const item = this.data.get(id);
    if (!item) return undefined;
    if (item.kind === 'calculation') {
      const o = item.def.output;
      return valueType(o.valueType, o.unit, o.semanticTag, undefined);
    }
    const t = valueType(item.def.valueType, item.def.unit, item.kind === 'parameter' ? item.def.semanticTag : undefined, item.def.categories);
    return item.kind === 'parameter' && (item.def.readings ?? 1) > 1 ? { kind: 'SERIES', of: t, maxLength: item.def.readings ?? 1 } : t;
  }

  /**
   * Type of `id` as seen from graph node `reader`: a value written inside a replicate section and
   * read outside it is the series of its per-instance values (one level of series per section left).
   * A value written inside a loop and read after it is the value of the last iteration.
   */
  typeAt(id: string, reader: GraphNode | undefined): ExprType | undefined {
    const base = this.declaredType(id);
    if (!base) return undefined;
    const writer = this.writers.get(id)?.[0];
    const writerNode = writer === undefined ? undefined : this.taskOf(writer);
    if (!writerNode || !reader) return base;
    let t = base;
    for (const key of writerNode.regions) {
      if (!key.startsWith('rep:') || reader.regions.includes(key)) continue;
      const rep = this.nodes.get(key.slice(4))?.node;
      const count = rep?.kind === 'replicate' ? rep.count.max : 1;
      const inner = t.kind === 'SERIES' ? (t.maxLength ?? 1) : 1;
      t = t.kind === 'SERIES' ? { kind: 'SERIES', of: t.of, maxLength: inner * count } : { kind: 'SERIES', of: t, maxLength: count };
    }
    return t;
  }

  /** Identifier environment for an expression written at tree node `treeId` and evaluated at graph node `reader`. */
  envAt(treeId: string, reader: GraphNode | undefined): Map<string, ExprType> {
    const scope = this.expanded.scopes.get(treeId);
    const key = `${scope?.callId ?? ''}|${scope?.element ?? ''}|${reader?.regions.join(',') ?? ''}`;
    const cached = this.envCache.get(key);
    if (cached) return cached;
    const env = new Map<string, ExprType>();
    if (scope) {
      for (const [local, bound] of scope.env) {
        const t = this.typeAt(bound, reader);
        if (t) env.set(local, t);
      }
    } else {
      for (const id of [...this.data.keys()].sort()) {
        const t = this.typeAt(id, reader);
        if (t) env.set(id, t);
      }
    }
    this.envCache.set(key, env);
    return env;
  }

  /** Checks an expression at a place in the flow (cached). */
  expression(source: string, treeId: string, reader: GraphNode | undefined, options: ExpressionOptions): CheckedExpression {
    const scope = this.expanded.scopes.get(treeId);
    const env = this.envAt(treeId, reader);
    const key = `${source}\u0000${scope?.callId ?? ''}|${scope?.element ?? ''}|${reader?.regions.join(',') ?? ''}\u0000${JSON.stringify(options)}`;
    const cached = this.exprCache.get(key);
    if (cached) return cached;
    const check = this.ctx.expressions.check(source, env, options);
    const reads: string[] = [];
    const unbound: string[] = [];
    for (const name of check.reads) {
      if (scope) {
        const bound = scope.env.get(name);
        if (bound === undefined) unbound.push(name);
        else reads.push(bound);
      } else reads.push(name);
    }
    const result = { check, reads: [...new Set(reads)].sort(), unbound };
    this.exprCache.set(key, result);
    return result;
  }

  /**
   * Forward must-analysis over the graph without back edges: for each graph node, the facts
   * established on EVERY path from the start before the node runs (the node's own facts excluded).
   * AND-joins unite their branches (all ran); XOR-joins intersect (only one ran); a loop body or
   * replicate body runs at least once, so its facts hold after it.
   * Returns undefined when the graph has an undeclared cycle (the structure gates report that).
   */
  mustBefore(initial: Iterable<string>, gen: (node: GraphNode) => Iterable<string>): Map<string, Set<string>> | undefined {
    if (!this.topo) return undefined;
    const IN = new Map<string, Set<string>>();
    const OUT = new Map<string, Set<string>>();
    for (const id of this.topo) {
      const n = this.gi.node.get(id) as GraphNode;
      const preds = (this.gi.in.get(id) ?? []).filter((e) => e.kind !== 'LOOP_BACK').map((e) => OUT.get(e.from) ?? new Set<string>());
      let facts: Set<string>;
      if (id === this.graph.start) facts = new Set(initial);
      else if (preds.length === 0) facts = new Set();
      else if (n.join === 'ALL') facts = new Set(preds.flatMap((s) => [...s]));
      else {
        const [first, ...rest] = preds as [Set<string>, ...Set<string>[]];
        facts = new Set([...first].filter((f) => rest.every((s) => s.has(f))));
      }
      IN.set(id, facts);
      const out = new Set(facts);
      for (const f of gen(n)) out.add(f);
      OUT.set(id, out);
    }
    return IN;
  }

  /** The phase a TASK graph node runs, if any. */
  phaseOf(n: GraphNode): PhaseNode | undefined {
    if (n.kind !== 'TASK') return undefined;
    const info = this.nodes.get(n.source);
    return info?.node.kind === 'phase' ? info.node : undefined;
  }

  /** True when two tree nodes lie in different branches of the same alternative (never on one path). */
  exclusive(a: string, b: string): boolean {
    const ga = this.graphNodes(a)[0];
    const gb = this.graphNodes(b)[0];
    if (!ga || !gb) return false;
    for (const ka of ga.regions) {
      if (!ka.startsWith('alt:')) continue;
      const construct = ka.slice(0, ka.indexOf('#'));
      for (const kb of gb.regions) if (kb.startsWith(`${construct}#`) && kb !== ka) return true;
    }
    return false;
  }
}
