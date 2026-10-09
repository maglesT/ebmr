/**
 * Consistency of time constraints as a simple temporal network (ADR 0004 decision 3; outline 6.2;
 * INV-20 model part).
 *
 * Time points are the START and END events of every node. The flow contributes precedence (a node's
 * start is not before its predecessor's end; a node ends no earlier than it starts); each constraint
 * min <= t(to) - t(from) <= max contributes two edges. The constraints can all be met by some
 * schedule exactly when the distance graph has no negative cycle (checked with Bellman-Ford on exact
 * bigint microseconds, so no rounding can hide a contradiction).
 *
 * Loops and replicate sections are unrolled to their maximum (a network consistent at the maximum is
 * consistent at every smaller count: drop the extra iterations and keep every other time). Constraints
 * inside a loop body or replicate body apply per iteration / per instance; a constraint between an
 * event inside and one outside applies to every iteration or instance. A constraint with an end in an
 * untaken alternative branch is void. Alternatives are first checked all together (the "union"
 * network: if it is consistent, every choice of branches is); only when it is not are the branch
 * choices that carry constrained events enumerated, so a reported contradiction is always real.
 */
import type { FlowNode, NodeEvent } from '../flow/model.ts';
import { formatMicros } from '../flow/decimal.ts';

export interface NetConstraint {
  id: string;
  /** Plain-language name for messages. */
  label: string;
  from: NodeEvent;
  to: NodeEvent;
  minUs?: bigint;
  maxUs?: bigint;
}

export interface NetworkResult {
  status: 'CONSISTENT' | 'INCONSISTENT' | 'POSSIBLY_INCONSISTENT';
  /** Constraint labels along a contradictory cycle ("flow order" for precedence). */
  cycle: string[];
  /** Branch choices of the contradictory scenario, when alternatives were enumerated. */
  scenario: string[];
  /** False when the network was too large to unroll and loops/replicates were checked once. */
  unrolled: boolean;
  /** Time points in the checked network. */
  points: number;
}

interface Edge {
  from: number;
  to: number;
  w: bigint;
  label: string;
}

interface Frame {
  construct: string;
  index: number;
}

class TooLarge extends Error {}

class Net {
  readonly keys: string[] = [];
  readonly index = new Map<string, number>();
  readonly edges: Edge[] = [];
  /** Point copies of each node event: `${node}:${event}` -> [{point, frames}]. */
  readonly copies = new Map<string, { point: number; frames: Frame[] }[]>();
  /** Alternative copies and the point indexes inside each branch. */
  readonly alternatives = new Map<string, Map<string, Set<number>>>();

  constructor(private readonly maxPoints: number) {}

  point(node: string, event: 'START' | 'END', frames: Frame[]): number {
    const ctx = frames.map((f) => `${f.construct}=${f.index}`).join('/');
    const key = `${node}@${ctx}:${event}`;
    const existing = this.index.get(key);
    if (existing !== undefined) return existing;
    if (this.keys.length >= this.maxPoints) throw new TooLarge();
    const i = this.keys.length;
    this.keys.push(key);
    this.index.set(key, i);
    const list = this.copies.get(`${node}:${event}`) ?? [];
    list.push({ point: i, frames: [...frames] });
    this.copies.set(`${node}:${event}`, list);
    return i;
  }

  /** a happens no later than b. */
  before(a: number, b: number): void {
    this.edges.push({ from: b, to: a, w: 0n, label: 'flow order' });
  }
}

type Choice = ReadonlyMap<string, string>;

function build(net: Net, node: FlowNode, frames: Frame[], prev: number | undefined, unroll: boolean, choice: Choice | undefined, trace: string[]): number {
  const s = net.point(node.id, 'START', frames);
  if (prev !== undefined) net.before(prev, s);
  // Branch membership of every point created below an alternative branch.
  const mark = (p: number): void => {
    for (const t of trace) {
      const [alt, branch] = t.split('\u0001') as [string, string];
      net.alternatives.get(alt)?.get(branch)?.add(p);
    }
  };
  mark(s);
  let last = s;
  const end = (after: number[]): number => {
    const e = net.point(node.id, 'END', frames);
    mark(e);
    for (const a of after) net.before(a, e);
    net.before(s, e);
    return e;
  };
  switch (node.kind) {
    case 'phase':
    case 'holdPoint':
    case 'libraryCall':
      return end([s]);
    case 'stage':
    case 'operation':
      return end([build(net, node.body, frames, s, unroll, choice, trace)]);
    case 'sequence':
      for (const c of node.children) last = build(net, c, frames, last, unroll, choice, trace);
      return end([last]);
    case 'parallel':
      return end(node.branches.map((b) => build(net, b.body, frames, s, unroll, choice, trace)));
    case 'alternative': {
      const ctx = frames.map((f) => `${f.construct}=${f.index}`).join('/');
      const altKey = `${node.id}@${ctx}`;
      if (!net.alternatives.has(altKey)) net.alternatives.set(altKey, new Map(node.branches.map((b) => [b.id, new Set<number>()])));
      const chosen = choice?.get(altKey);
      const ends: number[] = [];
      for (const b of node.branches) {
        if (chosen !== undefined && chosen !== b.id) continue;
        ends.push(b.body ? build(net, b.body, frames, s, unroll, choice, [...trace, `${altKey}\u0001${b.id}`]) : s);
      }
      return end(ends);
    }
    case 'loop': {
      const n = unroll ? node.maxIterations : 1;
      for (let i = 1; i <= n; i++) last = build(net, node.body, [...frames, { construct: node.id, index: i }], last, unroll, choice, trace);
      return end([last]);
    }
    case 'replicate': {
      const n = unroll ? node.count.max : 1;
      const ends: number[] = [];
      for (let i = 1; i <= n; i++) {
        const from = node.instances === 'SEQUENTIAL' ? last : s;
        last = build(net, node.body, [...frames, { construct: node.id, index: i }], from, unroll, choice, trace);
        ends.push(last);
      }
      return end(ends);
    }
  }
}

function compatible(a: readonly Frame[], b: readonly Frame[]): boolean {
  for (const fa of a) for (const fb of b) if (fa.construct === fb.construct && fa.index !== fb.index) return false;
  return true;
}

/** Adds constraint edges; returns the points each constraint touches. */
function addConstraints(net: Net, constraints: readonly NetConstraint[]): Map<string, Set<number>> {
  const touched = new Map<string, Set<number>>();
  for (const c of constraints) {
    const froms = net.copies.get(`${c.from.node}:${c.from.event}`) ?? [];
    const tos = net.copies.get(`${c.to.node}:${c.to.event}`) ?? [];
    const set = new Set<number>();
    for (const f of froms) {
      for (const t of tos) {
        if (!compatible(f.frames, t.frames)) continue;
        if (c.maxUs !== undefined) net.edges.push({ from: f.point, to: t.point, w: c.maxUs, label: c.label });
        if (c.minUs !== undefined) net.edges.push({ from: t.point, to: f.point, w: -c.minUs, label: c.label });
        set.add(f.point);
        set.add(t.point);
      }
    }
    touched.set(c.id, set);
  }
  return touched;
}

/** A cycle in the predecessor graph (which, during Bellman-Ford, always has negative weight). */
function predecessorCycle(pred: readonly (Edge | undefined)[]): string[] | undefined {
  const n = pred.length;
  const stamp = new Array<number>(n).fill(-1);
  for (let v = 0; v < n; v++) {
    let u: number | undefined = v;
    while (u !== undefined && stamp[u] === -1) {
      stamp[u] = v;
      u = pred[u]?.from;
    }
    if (u !== undefined && stamp[u] === v) {
      const labels: string[] = [];
      let y = u;
      do {
        const e = pred[y] as Edge;
        labels.push(e.label);
        y = e.from;
      } while (y !== u && labels.length <= n);
      return labels.reverse();
    }
  }
  return undefined;
}

/**
 * Bellman-Ford from a virtual source (every distance starts at 0). A cycle in the predecessor graph
 * proves a negative cycle, so it is looked for after every pass: contradictions are found in a few
 * passes, and a consistent network converges in a few passes because edges leaving later points are
 * relaxed first.
 */
function negativeCycle(net: Net): string[] | undefined {
  const n = net.keys.length;
  const dist: bigint[] = new Array<bigint>(n).fill(0n);
  const pred: (Edge | undefined)[] = new Array<Edge | undefined>(n).fill(undefined);
  const edges = [...net.edges].sort((a, b) => b.from - a.from);
  for (let pass = 0; pass <= n; pass++) {
    let changed = false;
    for (const e of edges) {
      const candidate = (dist[e.from] as bigint) + e.w;
      if (candidate < (dist[e.to] as bigint)) {
        dist[e.to] = candidate;
        pred[e.to] = e;
        changed = true;
      }
    }
    if (!changed) return undefined;
    const cycle = predecessorCycle(pred);
    if (cycle) return cycle;
  }
  // Still relaxing after n + 1 passes: a negative cycle exists even if the last pass broke the predecessor loop.
  return predecessorCycle(pred) ?? ['(contradictory constraints)'];
}

export function checkTemporalNetwork(root: FlowNode, constraints: readonly NetConstraint[], limits: { timePoints: number; timeScenarios: number }): NetworkResult {
  let unrolled = true;
  let net = new Net(limits.timePoints);
  try {
    build(net, root, [], undefined, true, undefined, []);
  } catch (e) {
    if (!(e instanceof TooLarge)) throw e;
    unrolled = false;
    net = new Net(Number.MAX_SAFE_INTEGER);
    build(net, root, [], undefined, false, undefined, []);
  }
  const touched = addConstraints(net, constraints);
  const unionCycle = negativeCycle(net);
  if (!unionCycle) return { status: 'CONSISTENT', cycle: [], scenario: [], unrolled, points: net.keys.length };

  // Enumerate the branch choices of alternatives that contain constrained points.
  const constrained = new Set<number>([...touched.values()].flatMap((s) => [...s]));
  const relevant: [string, string[]][] = [];
  for (const [alt, branches] of net.alternatives) {
    const ids = [...branches.keys()];
    if ([...branches.values()].some((pts) => [...pts].some((p) => constrained.has(p)))) relevant.push([alt, ids]);
  }
  let total = 1;
  for (const [, ids] of relevant) total *= ids.length;
  if (relevant.length === 0) return { status: 'INCONSISTENT', cycle: unionCycle, scenario: [], unrolled, points: net.keys.length };
  if (total > limits.timeScenarios) return { status: 'POSSIBLY_INCONSISTENT', cycle: unionCycle, scenario: [], unrolled, points: net.keys.length };
  const choice = new Map<string, string>();
  let found: NetworkResult | undefined;
  const visit = (i: number): void => {
    if (found) return;
    if (i === relevant.length) {
      const scenarioNet = new Net(Number.MAX_SAFE_INTEGER);
      build(scenarioNet, root, [], undefined, unrolled, choice, []);
      addConstraints(scenarioNet, constraints);
      const cycle = negativeCycle(scenarioNet);
      if (cycle) {
        found = {
          status: 'INCONSISTENT',
          cycle,
          scenario: [...choice.entries()].map(([alt, b]) => `${alt.replace(/@$/, '')} takes branch ${b}`),
          unrolled,
          points: scenarioNet.keys.length,
        };
      }
      return;
    }
    const [alt, ids] = relevant[i] as [string, string[]];
    for (const id of ids) {
      choice.set(alt, id);
      visit(i + 1);
    }
    choice.delete(alt);
  };
  visit(0);
  return found ?? { status: 'CONSISTENT', cycle: [], scenario: [], unrolled, points: net.keys.length };
}

export { formatMicros };
