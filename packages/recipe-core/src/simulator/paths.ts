/**
 * Path counting and enumeration (outline 6.5 "every path with loops and replicate sections unrolled
 * to their maximum"; ADR 0004 decision 7).
 *
 * A path is one complete run of the token game with every decision fixed: which branch each
 * alternative takes, after how many iterations each loop exits (or is exhausted at its maximum, an
 * exception), and how many instances each replicate section runs. Parallel interleavings are not
 * different paths: the scheduler is deterministic.
 *
 * `exactPathCount` gives the number of paths in closed form (bigint, from the tree):
 *   step 1; sequence and parallel: product; alternative: sum (an empty branch counts 1);
 *   loop with body P and maximum m: sum_{k=1..m} P^k (exit after k) + P^m (exhausted);
 *   replicate with body P and count n in min..max: sum_n P^n.
 * `enumeratePaths` runs them one by one in a fixed order up to a bound; the report says clearly when
 * the bound was hit, and targeted runs still cover every decision option.
 */
import type { FlowNode } from '../flow/model.ts';
import { contextKey, type Choice, type GameException, type Marking, type Occurrence, type TokenGame } from '../flow/tokens.ts';

export function exactPathCount(node: FlowNode): bigint {
  switch (node.kind) {
    case 'phase':
    case 'holdPoint':
    case 'libraryCall':
      return 1n;
    case 'stage':
    case 'operation':
      return exactPathCount(node.body);
    case 'sequence':
      return node.children.reduce((p, c) => p * exactPathCount(c), 1n);
    case 'parallel':
      return node.branches.reduce((p, b) => p * exactPathCount(b.body), 1n);
    case 'alternative':
      return node.branches.reduce((s, b) => s + (b.body ? exactPathCount(b.body) : 1n), 0n);
    case 'loop': {
      const body = exactPathCount(node.body);
      let sum = 0n;
      let power = 1n;
      for (let k = 1; k <= node.maxIterations; k++) {
        power *= body;
        sum += power;
      }
      return sum + power;
    }
    case 'replicate': {
      const body = exactPathCount(node.body);
      let sum = 0n;
      for (let n = node.count.min; n <= node.count.max; n++) sum += body ** BigInt(n);
      return sum;
    }
  }
}

export interface PathResult {
  /** Decisions in order, e.g. "xor-split:alt-extra@=b-none", "loop-test:dry@=2:EXIT". */
  decisions: string[];
  occurrences: Occurrence[];
  exceptions: GameException[];
  /** The run ended with no token left (proper completion). */
  completed: boolean;
}

interface Point {
  choice: Choice;
  chosen: number;
}

export class RunawayError extends Error {}

function describe(choice: Choice, option: string | number): string {
  const ctx = contextKey(choice.frames);
  if (choice.kind === 'LOOP') return `${choice.node}@${ctx}#${choice.iteration}=${String(option)}`;
  return `${choice.node}@${ctx}=${String(option)}`;
}

/**
 * Runs the game once. `pick` returns the option index for each decision (given the decision and how
 * many decisions came before).
 */
export function runOnce(game: TokenGame, pick: (choice: Choice, position: number) => number, maxFires: number): { result: PathResult; points: Point[] } {
  let m: Marking = game.initial();
  const points: Point[] = [];
  const result: PathResult = { decisions: [], occurrences: [], exceptions: [], completed: false };
  for (let fires = 0; ; fires++) {
    if (fires > maxFires) throw new RunawayError(`a run did not finish within ${maxFires} steps; the flow is not bounded`);
    const enabled = game.enabled(m);
    const e = enabled[0];
    if (!e) break;
    const choice = game.choiceFor(e);
    let option: string | number | undefined;
    if (choice) {
      const idx = Math.min(Math.max(pick(choice, points.length), 0), choice.options.length - 1);
      option = choice.options[idx];
      points.push({ choice, chosen: idx });
      result.decisions.push(describe(choice, option as string | number));
    }
    const fired = game.fire(m, e, option);
    m = fired.marking;
    if (fired.occurrence) result.occurrences.push(fired.occurrence);
    if (fired.exception) result.exceptions.push(fired.exception);
  }
  result.completed = game.completed(m);
  return { result, points };
}

/** Every path in a fixed order (depth-first over decisions), until exhausted or the caller stops. */
export function* enumeratePaths(game: TokenGame, maxFires: number): Generator<PathResult> {
  let script: number[] = [];
  for (;;) {
    const { result, points } = runOnce(game, (_c, i) => script[i] ?? 0, maxFires);
    yield result;
    let i = points.length - 1;
    while (i >= 0 && (points[i] as Point).chosen + 1 >= (points[i] as Point).choice.options.length) i--;
    if (i < 0) return;
    script = [...points.slice(0, i).map((p) => p.chosen), (points[i] as Point).chosen + 1];
  }
}

/** Every decision option of the graph: branches, loop outcomes and instance counts. */
export function decisionOptions(game: TokenGame): { node: string; option: string }[] {
  const out: { node: string; option: string }[] = [];
  for (const n of game.graph.nodes) {
    if (n.kind === 'XOR_SPLIT') for (const e of game.index.out.get(n.id) ?? []) out.push({ node: n.id, option: e.branch ?? e.id });
    if (n.kind === 'LOOP_TEST') {
      const max = game.bounds.loops.get(n.source)?.maxIterations ?? 1;
      out.push({ node: n.id, option: 'EXIT' });
      if (max > 1) out.push({ node: n.id, option: 'CONTINUE' });
      out.push({ node: n.id, option: 'EXHAUSTED' });
    }
    if (n.kind === 'REP_SPLIT') {
      const r = game.bounds.replicates.get(n.source);
      for (let k = r?.count.min ?? 1; k <= (r?.count.max ?? 1); k++) out.push({ node: n.id, option: String(k) });
    }
  }
  return out;
}

/** A run that takes `option` at `node` wherever it can (and drives loops to exhaustion when asked). */
export function targetedRun(game: TokenGame, node: string, option: string, maxFires: number): PathResult {
  return runOnce(
    game,
    (choice) => {
      if (choice.node !== node) return 0;
      if (choice.kind === 'LOOP') {
        if (option === 'EXHAUSTED' || option === 'CONTINUE') return choice.options.indexOf(choice.iteration < choice.max ? 'CONTINUE' : option === 'EXHAUSTED' ? 'EXHAUSTED' : 'EXIT');
        return choice.options.indexOf('EXIT');
      }
      const idx = choice.options.findIndex((o) => String(o) === option);
      return idx < 0 ? 0 : idx;
    },
    maxFires,
  ).result;
}

/** Decisions a set of paths covered, as "node=option". */
export function coveredOptions(paths: readonly PathResult[]): Set<string> {
  const out = new Set<string>();
  for (const p of paths) {
    for (const d of p.decisions) {
      const at = d.indexOf('@');
      const eq = d.lastIndexOf('=');
      out.add(`${d.slice(0, at)}=${d.slice(eq + 1)}`);
    }
  }
  return out;
}
