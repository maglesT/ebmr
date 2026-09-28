/**
 * Token semantics of the execution graph (ADR 0004 decision 5: only steps holding a token are
 * ENABLED). Pure and deterministic; used by the simulator now and by the engine later.
 *
 * A token sits on an edge with a context: the loop iteration and replicate instance it belongs to
 * (e.g. drying loop iteration 2 of sub-lot 3). Iterations and instances never share a context, so
 * every iteration's and instance's data is kept apart (INV-19). A loop test offers CONTINUE only
 * below the maximum; at the maximum an unmet exit condition is EXHAUSTED: an exception is raised and
 * the loop never runs again (INV-19). Instances of a SEQUENTIAL replicate section are released one at
 * a time, each after the previous one has finished; CONCURRENT instances start together.
 */
import { forwardTopologicalOrder, indexGraph, type ExecutionGraph, type GraphEdge, type GraphIndex, type GraphNode } from './graph.ts';
import { childrenOf, type FlowNode, type LoopNode, type ReplicateNode } from './model.ts';

export interface Frame {
  construct: string;
  index: number;
}

export interface Token {
  edge: string;
  frames: readonly Frame[];
}

export function contextKey(frames: readonly Frame[]): string {
  return frames.map((f) => `${f.construct}=${f.index}`).join('/');
}

/** A node ready to fire in a context. */
export interface Enabled {
  node: string;
  frames: readonly Frame[];
  /** Tokens consumed when it fires. */
  consumes: Token[];
  /** A sequential replicate join releasing the next instance (the previous one has finished). */
  release?: true;
}

export type Choice =
  | { kind: 'BRANCH'; node: string; frames: readonly Frame[]; options: string[] }
  | { kind: 'LOOP'; node: string; frames: readonly Frame[]; iteration: number; max: number; options: ('EXIT' | 'CONTINUE' | 'EXHAUSTED')[] }
  | { kind: 'COUNT'; node: string; frames: readonly Frame[]; options: number[] };

export interface Occurrence {
  /** MBR node id of the step (phase or hold point). */
  step: string;
  kind: 'TASK' | 'HOLD';
  frames: readonly Frame[];
}

export interface GameException {
  kind: 'LOOP_EXHAUSTED';
  loop: string;
  frames: readonly Frame[];
  iterations: number;
}

export interface Marking {
  tokens: ReadonlyMap<string, Token>;
  /**
   * Instance counts chosen at each replicate split, by `${context}|${construct}`, and for sequential
   * sections the number of instances released so far, by `${context}|${construct}|released`.
   */
  counts: ReadonlyMap<string, number>;
}

export interface Bounds {
  loops: ReadonlyMap<string, LoopNode>;
  replicates: ReadonlyMap<string, ReplicateNode>;
}

/** Loop and replicate bounds of a flow tree, by node id. */
export function boundsOf(root: FlowNode): Bounds {
  const loops = new Map<string, LoopNode>();
  const replicates = new Map<string, ReplicateNode>();
  const visit = (n: FlowNode): void => {
    if (n.kind === 'loop') loops.set(n.id, n);
    if (n.kind === 'replicate') replicates.set(n.id, n);
    childrenOf(n).forEach(visit);
  };
  visit(root);
  return { loops, replicates };
}

const tokenKey = (edge: string, frames: readonly Frame[]): string => `${edge}\u0000${contextKey(frames)}`;

export class TokenGame {
  readonly index: GraphIndex;
  private readonly order = new Map<string, number>();

  constructor(
    readonly graph: ExecutionGraph,
    readonly bounds: Bounds,
  ) {
    this.index = indexGraph(graph);
    (forwardTopologicalOrder(graph) ?? graph.nodes.map((n) => n.id)).forEach((id, i) => this.order.set(id, i));
  }

  initial(): Marking {
    const out = this.index.out.get(this.graph.start) ?? [];
    const tokens = new Map<string, Token>();
    for (const e of out) tokens.set(tokenKey(e.id, []), { edge: e.id, frames: [] });
    return { tokens, counts: new Map() };
  }

  /** True when the only token left has reached the end (proper completion). */
  completed(m: Marking): boolean {
    return m.tokens.size === 0;
  }

  private inEdges(node: string, kind?: GraphEdge['kind']): GraphEdge[] {
    return (this.index.in.get(node) ?? []).filter((e) => kind === undefined || e.kind === kind);
  }

  private tokensByEdge(m: Marking): Map<string, Token[]> {
    const byEdge = new Map<string, Token[]>();
    for (const t of m.tokens.values()) {
      const list = byEdge.get(t.edge) ?? [];
      list.push(t);
      byEdge.set(t.edge, list);
    }
    return byEdge;
  }

  /** The ways one node can fire in a marking (one per context). */
  private enabledFor(m: Marking, n: GraphNode, byEdge: ReadonlyMap<string, Token[]>): Enabled[] {
    const out: Enabled[] = [];
    const ins = this.inEdges(n.id);
    switch (n.join) {
      case 'SINGLE':
      case 'ANY':
      case 'ENTRY_OR_BACK':
        for (const e of ins) for (const t of byEdge.get(e.id) ?? []) out.push({ node: n.id, frames: t.frames, consumes: [t] });
        break;
      case 'ALL': {
        const first = ins[0];
        if (!first) break;
        for (const t of byEdge.get(first.id) ?? []) {
          const key = contextKey(t.frames);
          const all = ins.map((e) => (byEdge.get(e.id) ?? []).find((x) => contextKey(x.frames) === key));
          if (all.every((x) => x !== undefined)) out.push({ node: n.id, frames: t.frames, consumes: all });
        }
        break;
      }
      case 'ALL_INSTANCES': {
        const e = ins[0];
        const construct = n.source;
        if (!e) break;
        const groups = new Map<string, Token[]>();
        for (const t of byEdge.get(e.id) ?? []) {
          const key = contextKey(t.frames.slice(0, -1));
          const list = groups.get(key) ?? [];
          list.push(t);
          groups.set(key, list);
        }
        for (const [key, list] of groups) {
          const count = m.counts.get(`${key}|${construct}`);
          if (count === undefined) continue;
          const released = m.counts.get(`${key}|${construct}|released`) ?? count;
          const parent = (list[0] as Token).frames.slice(0, -1);
          if (list.length === count) out.push({ node: n.id, frames: parent, consumes: list });
          // Sequential instances: the next one starts only when every released instance has finished.
          else if (released < count && list.length === released) out.push({ node: n.id, frames: parent, consumes: [], release: true });
        }
        break;
      }
    }
    return out;
  }

  /** Every (node, context) that can fire, in deterministic order. */
  enabled(m: Marking): Enabled[] {
    const byEdge = this.tokensByEdge(m);
    const out = this.graph.nodes.flatMap((n) => this.enabledFor(m, n, byEdge));
    return out.sort((a, b) => (this.order.get(a.node) ?? 0) - (this.order.get(b.node) ?? 0) || (contextKey(a.frames) < contextKey(b.frames) ? -1 : contextKey(a.frames) > contextKey(b.frames) ? 1 : 0));
  }

  /** True when `e` is one of the ways its node can fire in `m` (same context, same tokens). */
  isEnabled(m: Marking, e: Enabled): boolean {
    const n = this.index.node.get(e.node);
    if (!n) return false;
    const keys = (x: Enabled): string => `${contextKey(x.frames)}#${x.release ? 'R' : ''}#${x.consumes.map((t) => tokenKey(t.edge, t.frames)).sort().join('|')}`;
    const wanted = keys(e);
    return this.enabledFor(m, n, this.tokensByEdge(m)).some((x) => keys(x) === wanted);
  }

  /** The decision a node needs before it can fire, if any. */
  choiceFor(e: Enabled): Choice | undefined {
    const n = this.index.node.get(e.node) as GraphNode;
    const outs = this.index.out.get(n.id) ?? [];
    if (n.kind === 'XOR_SPLIT') return { kind: 'BRANCH', node: n.id, frames: e.frames, options: outs.map((x) => x.branch ?? x.id) };
    if (n.kind === 'LOOP_TEST') {
      const loop = this.bounds.loops.get(n.source);
      const iteration = e.frames[e.frames.length - 1]?.index ?? 1;
      const max = loop?.maxIterations ?? 1;
      return { kind: 'LOOP', node: n.id, frames: e.frames, iteration, max, options: iteration < max ? ['EXIT', 'CONTINUE'] : ['EXIT', 'EXHAUSTED'] };
    }
    if (n.kind === 'REP_SPLIT') {
      const rep = this.bounds.replicates.get(n.source);
      const min = rep?.count.min ?? 1;
      const max = rep?.count.max ?? 1;
      const options: number[] = [];
      for (let k = min; k <= max; k++) options.push(k);
      return { kind: 'COUNT', node: n.id, frames: e.frames, options };
    }
    return undefined;
  }

  /**
   * Fires one enabled node. `option` answers `choiceFor` (branch id, loop outcome or instance count).
   * Returns the new marking, the step occurrence (for tasks and hold points) and any exception.
   */
  fire(m: Marking, e: Enabled, option?: string | number): { marking: Marking; occurrence?: Occurrence; exception?: GameException } {
    // Nothing runs out of sequence: only a node that holds its tokens in this marking can fire (DI-34).
    if (!this.isEnabled(m, e)) throw new Error(`${e.node} is not enabled in context "${contextKey(e.frames)}"`);
    const n = this.index.node.get(e.node) as GraphNode;
    const tokens = new Map(m.tokens);
    const counts = new Map(m.counts);
    for (const t of e.consumes) tokens.delete(tokenKey(t.edge, t.frames));
    const put = (edge: GraphEdge, frames: readonly Frame[]): void => {
      tokens.set(tokenKey(edge.id, frames), { edge: edge.id, frames });
    };
    const outs = this.index.out.get(n.id) ?? [];
    let occurrence: Occurrence | undefined;
    let exception: GameException | undefined;
    if (e.release) {
      const split = n.partner === undefined ? undefined : this.index.node.get(n.partner);
      const releasedKey = `${contextKey(e.frames)}|${n.source}|released`;
      const next = (counts.get(releasedKey) ?? 0) + 1;
      counts.set(releasedKey, next);
      for (const x of split ? (this.index.out.get(split.id) ?? []) : []) put(x, [...e.frames, { construct: n.source, index: next }]);
      return { marking: { tokens, counts } };
    }
    switch (n.kind) {
      case 'END':
        break;
      case 'AND_SPLIT':
        for (const x of outs) put(x, e.frames);
        break;
      case 'XOR_SPLIT': {
        const edge = outs.find((x) => (x.branch ?? x.id) === option);
        if (!edge) throw new Error(`branch ${String(option)} is not an option of ${n.id}`);
        put(edge, e.frames);
        break;
      }
      case 'LOOP_ENTRY': {
        const consumed = e.consumes[0] as Token;
        const back = this.index.edge.get(consumed.edge)?.kind === 'LOOP_BACK';
        const last = consumed.frames[consumed.frames.length - 1];
        const frames = back && last ? [...consumed.frames.slice(0, -1), { construct: n.source, index: last.index + 1 }] : [...consumed.frames, { construct: n.source, index: 1 }];
        for (const x of outs) put(x, frames);
        break;
      }
      case 'LOOP_TEST': {
        const choice = this.choiceFor(e);
        if (choice?.kind !== 'LOOP' || !choice.options.includes(option as 'EXIT')) throw new Error(`loop outcome ${String(option)} is not allowed at ${n.id}`);
        const exit = outs.find((x) => x.kind === 'LOOP_EXIT');
        const back = outs.find((x) => x.kind === 'LOOP_BACK');
        if (option === 'CONTINUE') {
          if (back) put(back, e.frames);
        } else {
          if (option === 'EXHAUSTED') exception = { kind: 'LOOP_EXHAUSTED', loop: n.source, frames: e.frames, iterations: choice.iteration };
          if (exit) put(exit, e.frames.slice(0, -1));
        }
        break;
      }
      case 'REP_SPLIT': {
        const choice = this.choiceFor(e);
        if (choice?.kind !== 'COUNT' || !choice.options.includes(option as number)) throw new Error(`instance count ${String(option)} is not allowed at ${n.id}`);
        const key = `${contextKey(e.frames)}|${n.source}`;
        counts.set(key, option as number);
        const sequential = this.bounds.replicates.get(n.source)?.instances === 'SEQUENTIAL';
        if (sequential) counts.set(`${key}|released`, 1);
        for (let k = 1; k <= (sequential ? 1 : (option as number)); k++) for (const x of outs) put(x, [...e.frames, { construct: n.source, index: k }]);
        break;
      }
      default:
        if (n.kind === 'TASK' || n.kind === 'HOLD') occurrence = { step: n.source, kind: n.kind, frames: e.frames };
        for (const x of outs) put(x, e.frames);
    }
    const result: { marking: Marking; occurrence?: Occurrence; exception?: GameException } = { marking: { tokens, counts } };
    if (occurrence) result.occurrence = occurrence;
    if (exception) result.exception = exception;
    return result;
  }
}
