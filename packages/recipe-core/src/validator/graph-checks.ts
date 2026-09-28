/**
 * Structure gates on the compiled execution graph (outline 6.3 "Structure"; ADR 0004 decision 6;
 * DI-34). They check the graph itself, not the tree it came from, so a defect in the compiler or a
 * tampered graph is caught too:
 *   one start and one end; every node reachable and able to finish; only declared cycles (loop back
 *   edges); node degrees per kind; matched splits and joins forming single-entry single-exit regions
 *   (opener dominates closer, closer post-dominates opener, and every node in between is enclosed);
 *   no edge crossing a stage, operation, parallel-branch, alternative-branch, loop or replicate boundary.
 * A graph passing these gates is a block-structured AND/XOR/loop net and therefore sound: from every
 * reachable state the batch can complete, completion leaves no token behind, and every step can run.
 */
import { forwardTopologicalOrder, type ExecutionGraph, type GraphEdge, type GraphNode, type GraphNodeKind, type JoinRule } from '../flow/graph.ts';

export type GraphProblemCode =
  | 'DUPLICATE_ID'
  | 'DANGLING_EDGE'
  | 'START_END'
  | 'DEGREE'
  | 'JOIN_RULE'
  | 'BAD_BACK_EDGE'
  | 'UNDECLARED_CYCLE'
  | 'UNREACHABLE'
  | 'NO_COMPLETION'
  | 'UNMATCHED'
  | 'NOT_ENCLOSED'
  | 'CROSSING';

export interface GraphProblem {
  code: GraphProblemCode;
  node?: string;
  edge?: string;
  message: string;
}

const OPENER_TO_CLOSER: Partial<Record<GraphNodeKind, GraphNodeKind>> = {
  SCOPE_START: 'SCOPE_END',
  AND_SPLIT: 'AND_JOIN',
  XOR_SPLIT: 'XOR_JOIN',
  REP_SPLIT: 'REP_JOIN',
  LOOP_ENTRY: 'LOOP_TEST',
};

const EXPECTED_JOIN: Record<GraphNodeKind, JoinRule> = {
  START: 'SINGLE',
  END: 'SINGLE',
  TASK: 'SINGLE',
  HOLD: 'SINGLE',
  SCOPE_START: 'SINGLE',
  SCOPE_END: 'SINGLE',
  AND_SPLIT: 'SINGLE',
  AND_JOIN: 'ALL',
  XOR_SPLIT: 'SINGLE',
  XOR_JOIN: 'ANY',
  LOOP_ENTRY: 'ENTRY_OR_BACK',
  LOOP_TEST: 'SINGLE',
  REP_SPLIT: 'SINGLE',
  REP_JOIN: 'ALL_INSTANCES',
};

/** [min, max] forward in-degree and out-degree per kind (LOOP_BACK edges counted separately). */
const DEGREE: Record<GraphNodeKind, { in: [number, number]; out: [number, number] }> = {
  START: { in: [0, 0], out: [1, 1] },
  END: { in: [1, 1], out: [0, 0] },
  TASK: { in: [1, 1], out: [1, 1] },
  HOLD: { in: [1, 1], out: [1, 1] },
  SCOPE_START: { in: [1, 1], out: [1, 1] },
  SCOPE_END: { in: [1, 1], out: [1, 1] },
  AND_SPLIT: { in: [1, 1], out: [2, Number.MAX_SAFE_INTEGER] },
  AND_JOIN: { in: [2, Number.MAX_SAFE_INTEGER], out: [1, 1] },
  XOR_SPLIT: { in: [1, 1], out: [2, Number.MAX_SAFE_INTEGER] },
  XOR_JOIN: { in: [2, Number.MAX_SAFE_INTEGER], out: [1, 1] },
  LOOP_ENTRY: { in: [1, 1], out: [1, 1] },
  LOOP_TEST: { in: [1, 1], out: [1, 1] },
  REP_SPLIT: { in: [1, 1], out: [1, 1] },
  REP_JOIN: { in: [1, 1], out: [1, 1] },
};

/** Immediate dominators over a DAG given in topological order (LCA of the predecessors). */
function immediateDominators(order: readonly string[], preds: ReadonlyMap<string, readonly string[]>, root: string): Map<string, string> {
  const idom = new Map<string, string>([[root, root]]);
  const depth = new Map<string, number>([[root, 0]]);
  const lca = (a: string, b: string): string => {
    let x = a;
    let y = b;
    while (x !== y) {
      const dx = depth.get(x) ?? 0;
      const dy = depth.get(y) ?? 0;
      if (dx >= dy) x = idom.get(x) ?? root;
      if (dy >= dx) y = idom.get(y) ?? root;
    }
    return x;
  };
  for (const n of order) {
    if (n === root) continue;
    const ps = (preds.get(n) ?? []).filter((p) => idom.has(p));
    if (ps.length === 0) continue;
    let d = ps[0] as string;
    for (const p of ps.slice(1)) d = lca(d, p);
    idom.set(n, d);
    depth.set(n, (depth.get(d) ?? 0) + 1);
  }
  return idom;
}

function dominates(idom: ReadonlyMap<string, string>, a: string, b: string): boolean {
  // Walks up the dominator tree from b; each step strictly decreases the depth, so this ends at the root.
  let x = b;
  for (;;) {
    if (x === a) return true;
    const next = idom.get(x);
    if (next === undefined || next === x) return false;
    x = next;
  }
}

function findCycle(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): string[] {
  const out = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) if (e.kind !== 'LOOP_BACK') out.get(e.from)?.push(e.to);
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  let found: string[] = [];
  const visit = (n: string): boolean => {
    state.set(n, 1);
    stack.push(n);
    for (const m of out.get(n) ?? []) {
      const s = state.get(m) ?? 0;
      if (s === 1) {
        found = [...stack.slice(stack.indexOf(m)), m];
        return true;
      }
      if (s === 0 && visit(m)) return true;
    }
    stack.pop();
    state.set(n, 2);
    return false;
  };
  for (const n of nodes) if ((state.get(n.id) ?? 0) === 0 && visit(n.id)) break;
  return found;
}

export function checkGraph(g: ExecutionGraph): GraphProblem[] {
  const problems: GraphProblem[] = [];
  const node = new Map<string, GraphNode>();
  for (const n of g.nodes) {
    if (node.has(n.id)) problems.push({ code: 'DUPLICATE_ID', node: n.id, message: `Graph node id ${n.id} is used twice` });
    node.set(n.id, n);
  }
  const edgeIds = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const e of g.edges) {
    if (edgeIds.has(e.id)) problems.push({ code: 'DUPLICATE_ID', edge: e.id, message: `Graph edge id ${e.id} is used twice` });
    edgeIds.add(e.id);
    if (!node.has(e.from) || !node.has(e.to)) problems.push({ code: 'DANGLING_EDGE', edge: e.id, message: `Edge ${e.id} connects a node that does not exist (${e.from} -> ${e.to})` });
    else edges.push(e);
  }
  const fwdIn = new Map<string, GraphEdge[]>(g.nodes.map((n) => [n.id, []]));
  const fwdOut = new Map<string, GraphEdge[]>(g.nodes.map((n) => [n.id, []]));
  const backIn = new Map<string, GraphEdge[]>(g.nodes.map((n) => [n.id, []]));
  const backOut = new Map<string, GraphEdge[]>(g.nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (e.kind === 'LOOP_BACK') {
      backOut.get(e.from)?.push(e);
      backIn.get(e.to)?.push(e);
    } else {
      fwdOut.get(e.from)?.push(e);
      fwdIn.get(e.to)?.push(e);
    }
  }

  // One start and one end.
  const starts = g.nodes.filter((n) => n.kind === 'START');
  const ends = g.nodes.filter((n) => n.kind === 'END');
  if (starts.length !== 1 || starts[0]?.id !== g.start) problems.push({ code: 'START_END', message: `The flow must have exactly one start (found ${starts.length})` });
  if (ends.length !== 1 || ends[0]?.id !== g.end) problems.push({ code: 'START_END', message: `The flow must have exactly one end (found ${ends.length})` });

  // Degrees, join rules and back edges.
  for (const n of g.nodes) {
    const d = DEGREE[n.kind];
    const i = fwdIn.get(n.id)?.length ?? 0;
    const o = fwdOut.get(n.id)?.length ?? 0;
    if (i < d.in[0] || i > d.in[1] || o < d.out[0] || o > d.out[1]) {
      problems.push({ code: 'DEGREE', node: n.id, message: `${n.kind} node ${n.id} has ${i} incoming and ${o} outgoing edges, which its kind does not allow` });
    }
    if (n.join !== EXPECTED_JOIN[n.kind]) problems.push({ code: 'JOIN_RULE', node: n.id, message: `${n.kind} node ${n.id} has join rule ${n.join}; it must be ${EXPECTED_JOIN[n.kind]}` });
    const bi = backIn.get(n.id)?.length ?? 0;
    const bo = backOut.get(n.id)?.length ?? 0;
    if (n.kind === 'LOOP_ENTRY' && bi !== 1) problems.push({ code: 'BAD_BACK_EDGE', node: n.id, message: `Loop entry ${n.id} must have exactly one back edge (has ${bi})` });
    if (n.kind === 'LOOP_TEST' && bo !== 1) problems.push({ code: 'BAD_BACK_EDGE', node: n.id, message: `Loop test ${n.id} must have exactly one back edge (has ${bo})` });
    if (n.kind !== 'LOOP_ENTRY' && bi > 0) problems.push({ code: 'BAD_BACK_EDGE', node: n.id, message: `${n.id} receives a back edge but is not a loop entry` });
    if (n.kind !== 'LOOP_TEST' && bo > 0) problems.push({ code: 'BAD_BACK_EDGE', node: n.id, message: `${n.id} sends a back edge but is not a loop test` });
  }
  for (const e of edges) {
    if (e.kind !== 'LOOP_BACK') {
      if (node.get(e.from)?.kind === 'LOOP_TEST' && e.kind !== 'LOOP_EXIT') problems.push({ code: 'BAD_BACK_EDGE', edge: e.id, message: `Edge ${e.id} leaves a loop test but is not its exit edge` });
      continue;
    }
    const from = node.get(e.from);
    const to = node.get(e.to);
    if (from?.kind !== 'LOOP_TEST' || to?.kind !== 'LOOP_ENTRY' || from.partner !== to.id || to.partner !== from.id) {
      problems.push({ code: 'BAD_BACK_EDGE', edge: e.id, message: `Back edge ${e.id} (${e.from} -> ${e.to}) does not return from a loop's test to its own entry: only declared loops may repeat` });
    }
  }

  // Only declared cycles.
  const order = forwardTopologicalOrder({ ...g, edges });
  if (!order) {
    const cycle = findCycle(g.nodes, edges);
    problems.push({ code: 'UNDECLARED_CYCLE', node: cycle[0], message: `The flow repeats outside a declared loop: ${cycle.join(' -> ')}` });
  }

  // Reachability and completion (all edges, back edges included).
  const reach = (from: string, next: (id: string) => string[]): Set<string> => {
    const seen = new Set<string>([from]);
    const queue = [from];
    while (queue.length > 0) {
      const id = queue.shift() as string;
      for (const m of next(id)) {
        if (!seen.has(m)) {
          seen.add(m);
          queue.push(m);
        }
      }
    }
    return seen;
  };
  const allOut = (id: string): string[] => [...(fwdOut.get(id) ?? []), ...(backOut.get(id) ?? [])].map((e) => e.to);
  const allIn = (id: string): string[] => [...(fwdIn.get(id) ?? []), ...(backIn.get(id) ?? [])].map((e) => e.from);
  const reachable = node.has(g.start) ? reach(g.start, allOut) : new Set<string>();
  const finishing = node.has(g.end) ? reach(g.end, allIn) : new Set<string>();
  for (const n of g.nodes) {
    if (!reachable.has(n.id)) problems.push({ code: 'UNREACHABLE', node: n.id, message: `Step ${n.source} (${n.id}) can never be reached from the start` });
    if (!finishing.has(n.id)) problems.push({ code: 'NO_COMPLETION', node: n.id, message: `From ${n.source} (${n.id}) the batch can never reach the end` });
  }

  // Matched splits and joins as single-entry single-exit regions.
  for (const n of g.nodes) {
    const closerKind = OPENER_TO_CLOSER[n.kind];
    if (closerKind) {
      const partner = n.partner === undefined ? undefined : node.get(n.partner);
      if (!partner || partner.kind !== closerKind || partner.partner !== n.id || partner.source !== n.source) {
        problems.push({ code: 'UNMATCHED', node: n.id, message: `${n.kind} ${n.id} has no matching ${closerKind}` });
      }
    } else if (Object.values(OPENER_TO_CLOSER).includes(n.kind)) {
      const partner = n.partner === undefined ? undefined : node.get(n.partner);
      if (!partner || OPENER_TO_CLOSER[partner.kind] !== n.kind || partner.partner !== n.id) {
        problems.push({ code: 'UNMATCHED', node: n.id, message: `${n.kind} ${n.id} has no matching opener` });
      }
    }
  }
  if (order && problems.every((p) => p.code !== 'UNREACHABLE' && p.code !== 'NO_COMPLETION')) {
    const preds = new Map<string, string[]>(g.nodes.map((n) => [n.id, (fwdIn.get(n.id) ?? []).map((e) => e.from)]));
    const succs = new Map<string, string[]>(g.nodes.map((n) => [n.id, (fwdOut.get(n.id) ?? []).map((e) => e.to)]));
    const idom = immediateDominators(order, preds, g.start);
    const ipdom = immediateDominators([...order].reverse(), succs, g.end);
    for (const n of g.nodes) {
      if (!OPENER_TO_CLOSER[n.kind] || n.partner === undefined || !node.has(n.partner)) continue;
      const closer = n.partner;
      if (!dominates(idom, n.id, closer) || !dominates(ipdom, closer, n.id)) {
        problems.push({ code: 'UNMATCHED', node: n.id, message: `${n.kind} ${n.id} and ${closer} do not enclose a single-entry single-exit region` });
        continue;
      }
      // Every node between opener and closer must be entered through the opener and left through the closer.
      const seen = new Set<string>([n.id]);
      const queue = [n.id];
      while (queue.length > 0) {
        const id = queue.shift() as string;
        for (const m of succs.get(id) ?? []) {
          if (m === closer || seen.has(m)) continue;
          seen.add(m);
          queue.push(m);
          if (!dominates(idom, n.id, m) || !dominates(ipdom, closer, m)) {
            problems.push({ code: 'NOT_ENCLOSED', node: m, message: `${m} lies between ${n.id} and ${closer} but can be entered or left another way` });
          }
        }
      }
    }
  }

  // No edge crosses a region boundary (checked against the declared regions).
  const regions = new Map(g.regions.map((r) => [r.key, r]));
  for (const r of g.regions) {
    const opener = node.get(r.opener);
    const closer = node.get(r.closer);
    if (!opener || !closer || opener.partner !== closer.id || opener.regions.join('|') !== closer.regions.join('|')) {
      problems.push({ code: 'UNMATCHED', message: `Region ${r.key} is not delimited by a matched opener and closer` });
    }
  }
  const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
  for (const e of edges) {
    const u = node.get(e.from) as GraphNode;
    const v = node.get(e.to) as GraphNode;
    if (e.kind === 'LOOP_BACK') {
      if (!sameList(u.regions, v.regions)) problems.push({ code: 'CROSSING', edge: e.id, message: `Back edge ${e.id} crosses a boundary` });
      continue;
    }
    if (sameList(u.regions, v.regions)) {
      // Staying in the same region; an opener may also go straight to its closer (empty alternative branch).
      continue;
    }
    const entering = v.regions.length === u.regions.length + 1 && sameList(u.regions, v.regions.slice(0, -1)) && regions.get(v.regions[v.regions.length - 1] as string)?.opener === u.id;
    const leaving = u.regions.length === v.regions.length + 1 && sameList(v.regions, u.regions.slice(0, -1)) && regions.get(u.regions[u.regions.length - 1] as string)?.closer === v.id;
    if (!entering && !leaving) {
      problems.push({
        code: 'CROSSING',
        edge: e.id,
        message: `The path from ${u.source} to ${v.source} crosses a stage, operation, branch, loop or replicate boundary`,
      });
    }
  }
  return problems;
}
