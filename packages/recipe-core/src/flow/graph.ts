/**
 * The execution graph an MBR compiles to (ADR 0004 decision 1; outline 6.2).
 *
 * Nodes fire when their join rule is satisfied and pass tokens along edges. Every construct becomes
 * a single-entry single-exit region between an opener and a closer node:
 *   stage/operation  SCOPE_START ... SCOPE_END
 *   parallel         AND_SPLIT ... AND_JOIN      (join waits for every branch)
 *   alternative      XOR_SPLIT ... XOR_JOIN      (exactly one branch runs; the others become NOT_APPLICABLE)
 *   loop             LOOP_ENTRY ... LOOP_TEST    (LOOP_BACK edge from the test to the entry; bounded)
 *   replicate        REP_SPLIT ... REP_JOIN      (the body is a template run once per sub-lot instance)
 * The graph is used by the validator (structure gates), the simulator and, later, the engine.
 */

export type GraphNodeKind =
  | 'START'
  | 'END'
  | 'TASK'
  | 'HOLD'
  | 'SCOPE_START'
  | 'SCOPE_END'
  | 'AND_SPLIT'
  | 'AND_JOIN'
  | 'XOR_SPLIT'
  | 'XOR_JOIN'
  | 'LOOP_ENTRY'
  | 'LOOP_TEST'
  | 'REP_SPLIT'
  | 'REP_JOIN';

/** How a node waits for its incoming tokens. */
export type JoinRule =
  /** One incoming edge (ordinary nodes). */
  | 'SINGLE'
  /** Every incoming edge carries a token of the same context (AND_JOIN). */
  | 'ALL'
  /** Any one incoming edge (XOR_JOIN). */
  | 'ANY'
  /** Entry edge on the first iteration, back edge afterwards (LOOP_ENTRY). */
  | 'ENTRY_OR_BACK'
  /** Every sub-lot instance of the body has arrived (REP_JOIN). */
  | 'ALL_INSTANCES';

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  /** MBR node id (phase, hold point, stage, operation or construct) the graph node was made from. */
  source: string;
  /** Opener <-> closer of the same construct. */
  partner?: string;
  /** Keys of the regions this node lies inside, outermost first (an opener/closer lies outside its own region). */
  regions: string[];
  join: JoinRule;
}

export type EdgeKind = 'FLOW' | 'BRANCH' | 'LOOP_BACK' | 'LOOP_EXIT';

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  /** Branch id for edges leaving a split. */
  branch?: string;
}

export type RegionKind = 'STAGE' | 'OPERATION' | 'PARALLEL_BRANCH' | 'ALTERNATIVE_BRANCH' | 'LOOP_BODY' | 'REPLICATE_BODY';

export interface GraphRegion {
  key: string;
  kind: RegionKind;
  /** MBR construct id (and branch id for branches). */
  construct: string;
  branch?: string;
  opener: string;
  closer: string;
}

export interface ExecutionGraph {
  start: string;
  end: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  regions: GraphRegion[];
}

export interface GraphIndex {
  node: ReadonlyMap<string, GraphNode>;
  edge: ReadonlyMap<string, GraphEdge>;
  out: ReadonlyMap<string, GraphEdge[]>;
  in: ReadonlyMap<string, GraphEdge[]>;
  region: ReadonlyMap<string, GraphRegion>;
  /** Graph node ids by MBR source id (a construct maps to its opener and closer). */
  bySource: ReadonlyMap<string, string[]>;
}

export function indexGraph(g: ExecutionGraph): GraphIndex {
  const node = new Map(g.nodes.map((n) => [n.id, n]));
  const out = new Map<string, GraphEdge[]>(g.nodes.map((n) => [n.id, []]));
  const inc = new Map<string, GraphEdge[]>(g.nodes.map((n) => [n.id, []]));
  for (const e of g.edges) {
    out.get(e.from)?.push(e);
    inc.get(e.to)?.push(e);
  }
  const bySource = new Map<string, string[]>();
  for (const n of g.nodes) {
    const list = bySource.get(n.source) ?? [];
    list.push(n.id);
    bySource.set(n.source, list);
  }
  return { node, edge: new Map(g.edges.map((e) => [e.id, e])), out, in: inc, region: new Map(g.regions.map((r) => [r.key, r])), bySource };
}

/**
 * Topological order of the graph without LOOP_BACK edges (Kahn, ties broken by node order), or
 * undefined when that graph still has a cycle (an undeclared cycle).
 */
export function forwardTopologicalOrder(g: ExecutionGraph): string[] | undefined {
  const indegree = new Map<string, number>(g.nodes.map((n) => [n.id, 0]));
  const out = new Map<string, string[]>(g.nodes.map((n) => [n.id, []]));
  for (const e of g.edges) {
    if (e.kind === 'LOOP_BACK') continue;
    if (!indegree.has(e.to) || !out.has(e.from)) continue;
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
    out.get(e.from)?.push(e.to);
  }
  const position = new Map(g.nodes.map((n, i) => [n.id, i]));
  const ready = g.nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];
  while (ready.length > 0) {
    ready.sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0));
    const id = ready.shift() as string;
    order.push(id);
    for (const next of out.get(id) ?? []) {
      const d = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, d);
      if (d === 0) ready.push(next);
    }
  }
  return order.length === g.nodes.length ? order : undefined;
}
