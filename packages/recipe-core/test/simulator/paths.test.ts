import { describe, expect, it } from 'vitest';
import { compileMbr } from '../../src/flow/compile.ts';
import type { FlowNode, MbrContent } from '../../src/flow/model.ts';
import { boundsOf, TokenGame } from '../../src/flow/tokens.ts';
import { decisionOptions, enumeratePaths, exactPathCount, targetedRun } from '../../src/simulator/paths.ts';
import { pathSteps, simulate } from '../../src/simulator/simulate.ts';
import { context, endpoint, mbrWith, phase } from '../flow/support.ts';

const seq = (id: string, children: FlowNode[]): FlowNode => ({ kind: 'sequence', id, children });
const choice = (id: string, branches: (FlowNode | undefined)[]): FlowNode => ({
  kind: 'alternative',
  id,
  decision: { mode: 'OPERATOR_CHOICE', roles: ['SUP'], reasonRequired: true },
  branches: branches.map((b, i) => (b ? { id: `${id}-${i}`, name: 'B', body: b } : { id: `${id}-${i}`, name: 'None' })),
});
const loop = (id: string, max: number, body: FlowNode): FlowNode => ({ kind: 'loop', id, name: 'Loop', maxIterations: max, exit: { condition: `ep_${id} <= 1 [%]`, endpoint: `ep_${id}` }, body: seq(`${id}-s`, [body, phase(`${id}-m`, { records: [`ep_${id}`] })]) });
const rep = (id: string, min: number, max: number, body: FlowNode): FlowNode => ({ kind: 'replicate', id, name: 'Rep', count: { mode: 'RUNTIME', min, max, reasonRequired: true }, instances: 'SEQUENTIAL', subLotPrefix: 'R', body });

function shape(body: FlowNode, loops: string[] = []): MbrContent {
  return mbrWith(body, { parameters: loops.map((l) => endpoint(`ep_${l}`)) });
}

function count(m: MbrContent): { exact: bigint; enumerated: number } {
  const { graph, expanded } = compileMbr(m);
  let n = 0;
  for (const p of enumeratePaths(new TokenGame(graph, boundsOf(expanded.root)), 100_000)) {
    expect(p.completed).toBe(true);
    n++;
  }
  return { exact: exactPathCount(expanded.root), enumerated: n };
}

describe('path counts on known shapes (ADR 0004 decision 7)', () => {
  it.each<[string, MbrContent, bigint]>([
    ['a sequence has one path', shape(seq('s', [phase('a'), phase('b'), phase('c')])), 1n],
    ['an alternative with three branches has three', shape(choice('A', [phase('x'), phase('y'), undefined])), 3n],
    ['a parallel multiplies its branches (2 x 3)', shape({ kind: 'parallel', id: 'P', branches: [{ id: 'p1', name: 'P1', body: choice('A', [phase('x'), phase('y')]) }, { id: 'p2', name: 'P2', body: choice('B', [phase('u'), phase('v'), phase('w')]) }] }), 6n],
    ['a loop of at most 3 exits after 1, 2 or 3 iterations or is exhausted: 4', shape(loop('L', 3, phase('d')), ['L']), 4n],
    ['a loop of at most 2 around a 2-way choice: 2 + 4 + 4 = 10', shape(loop('L', 2, choice('A', [phase('x'), phase('y')])), ['L']), 10n],
    ['a replicate of 1..3 instances of a 2-way choice: 2 + 4 + 8 = 14', shape(rep('R', 1, 3, choice('A', [phase('x'), phase('y')]))), 14n],
    ['a replicate of 2 instances containing a loop of at most 2 (3 paths each): 9', shape(rep('R', 2, 2, loop('L', 2, phase('d'))), ['L']), 9n],
  ])('[INV-19] %s', (_name, m, expected) => {
    const r = count(m);
    expect(r.exact).toBe(expected);
    expect(BigInt(r.enumerated)).toBe(expected);
  });

  it('[INV-19] loops and replicates are unrolled to their maximum: the longest path runs every iteration and instance', () => {
    const m = shape(rep('R', 1, 2, loop('L', 3, phase('d'))), ['L']);
    const { graph, expanded } = compileMbr(m);
    const game = new TokenGame(graph, boundsOf(expanded.root));
    const paths = [...enumeratePaths(game, 100_000)];
    const most = Math.max(...paths.map((p) => p.occurrences.length));
    const longest = paths.filter((p) => p.occurrences.length === most);
    // Sub-lot 2 starts only after sub-lot 1 has finished (sequential instances).
    for (const p of longest) expect(pathSteps(p).filter((s) => s.startsWith('d@'))).toEqual(['d@R=1/L=1', 'd@R=1/L=2', 'd@R=1/L=3', 'd@R=2/L=1', 'd@R=2/L=2', 'd@R=2/L=3']);
    // Exit at the third iteration or exhausted there, per sub-lot: 4 longest paths, one exhausted in both.
    expect(longest).toHaveLength(4);
    expect(longest.map((p) => p.exceptions.length).sort()).toEqual([0, 1, 1, 2]);
  });

  it('[DI-04] when the bound is hit the report says so clearly, and targeted runs still reach every decision option', () => {
    const m = shape(seq('s', [loop('L1', 5, choice('A', [phase('x'), phase('y')])), loop('L2', 5, choice('B', [phase('u'), phase('v')]))]), ['L1', 'L2']);
    const report = simulate(m, context(), { maxPaths: 50 });
    expect(report.paths.boundHit).toBe(true);
    expect(report.paths.exact).toBe(((2n + 4n + 8n + 16n + 32n + 32n) ** 2n).toString());
    expect(report.paths.message).toMatch(/^Path bound reached: 50 of 8836 paths enumerated; \d+ targeted runs cover every remaining decision option$/);
    expect(report.coverage.decisions.missing).toEqual([]);
    expect(report.coverage.steps.missing).toEqual([]);
  });

  it('[INV-19] a targeted run can drive a loop to exhaustion', () => {
    const m = shape(loop('L', 4, phase('d')), ['L']);
    const { graph, expanded } = compileMbr(m);
    const game = new TokenGame(graph, boundsOf(expanded.root));
    expect(decisionOptions(game).map((o) => o.option)).toEqual(['EXIT', 'CONTINUE', 'EXHAUSTED']);
    const p = targetedRun(game, 'loop-test:L', 'EXHAUSTED', 10_000);
    expect(p.occurrences.filter((o) => o.step === 'd')).toHaveLength(4);
    expect(p.exceptions).toHaveLength(1);
  });
});
