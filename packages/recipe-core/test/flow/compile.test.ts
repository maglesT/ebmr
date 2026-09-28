import { describe, expect, it } from 'vitest';
import { compileMbr } from '../../src/flow/compile.ts';
import type { ExecutionGraph } from '../../src/flow/graph.ts';
import type { FlowNode, MbrContent } from '../../src/flow/model.ts';
import { boundsOf, contextKey, TokenGame, type Enabled, type Marking } from '../../src/flow/tokens.ts';
import { checkGraph } from '../../src/validator/graph-checks.ts';
import { endpoint, loadFixture, mbrWith, phase } from './support.ts';

function game(mbr: MbrContent): TokenGame {
  const { graph, expanded } = compileMbr(mbr);
  return new TokenGame(graph, boundsOf(expanded.root));
}

/** Runs the game, answering decisions with `pick`, and returns the order in which steps ran. */
function run(g: TokenGame, pick: (e: Enabled) => string | number | undefined = () => undefined): { steps: string[]; exceptions: string[] } {
  let m: Marking = g.initial();
  const steps: string[] = [];
  const exceptions: string[] = [];
  for (let i = 0; i < 10_000; i++) {
    const e = g.enabled(m)[0];
    if (!e) break;
    const choice = g.choiceFor(e);
    const fired = g.fire(m, e, choice ? (pick(e) ?? choice.options[0]) : undefined);
    m = fired.marking;
    if (fired.occurrence) steps.push(`${fired.occurrence.step}${fired.occurrence.frames.length ? `@${contextKey(fired.occurrence.frames)}` : ''}`);
    if (fired.exception) exceptions.push(`${fired.exception.kind}:${fired.exception.loop}@${contextKey(fired.exception.frames)}`);
  }
  expect(g.completed(m)).toBe(true);
  return { steps, exceptions };
}

const seq = (id: string, children: FlowNode[]): FlowNode => ({ kind: 'sequence', id, children });

describe('compiler: MBR tree -> execution graph', () => {
  it('[DI-34] both fixtures compile to graphs that pass every structure gate', () => {
    for (const name of ['tablet-granulation-compression', 'tablet-blister-packaging'] as const) {
      const { graph } = compileMbr(loadFixture(name));
      expect(checkGraph(graph)).toEqual([]);
    }
  });

  it('is deterministic: the same content always compiles to the same graph', () => {
    const mbr = loadFixture('tablet-granulation-compression');
    expect(JSON.stringify(compileMbr(mbr).graph)).toBe(JSON.stringify(compileMbr(structuredClone(mbr)).graph));
  });

  it('every construct becomes a matched opener/closer pair around its region', () => {
    const { graph } = compileMbr(loadFixture('tablet-granulation-compression'));
    const kinds = (k: string): number => graph.nodes.filter((n) => n.kind === k).length;
    expect(kinds('START')).toBe(1);
    expect(kinds('END')).toBe(1);
    expect(kinds('AND_SPLIT')).toBe(kinds('AND_JOIN'));
    expect(kinds('XOR_SPLIT')).toBe(kinds('XOR_JOIN'));
    expect(kinds('LOOP_ENTRY')).toBe(1);
    expect(kinds('REP_SPLIT')).toBe(1);
    for (const n of graph.nodes) if (n.partner) expect(graph.nodes.find((m) => m.id === n.partner)?.partner).toBe(n.id);
    expect(graph.edges.filter((e) => e.kind === 'LOOP_BACK')).toHaveLength(1);
  });

  it('inlines library calls under the call id, binding the element symbols', () => {
    const { expanded, graph } = compileMbr(loadFixture('tablet-granulation-compression'));
    expect(expanded.problems).toEqual([]);
    expect(graph.nodes.some((n) => n.id === 'task:c-lod/lod-test')).toBe(true);
    expect(expanded.scopes.get('c-lod/lod-test')?.env.get('lodValue')).toBe('lod');
  });
});

describe('token semantics of the compiled graph', () => {
  it('[DI-34] step N+1 is not enabled before step N completes', () => {
    const mbr = mbrWith(seq('ops', [phase('n1'), phase('n2'), phase('n3')]));
    const g = game(mbr);
    let m = g.initial();
    const enabledSteps = (): string[] =>
      g
        .enabled(m)
        .map((e) => g.index.node.get(e.node))
        .filter((n) => n?.kind === 'TASK')
        .map((n) => n?.source ?? '');
    // Fire until the first task is enabled.
    while (!enabledSteps().includes('n1')) m = g.fire(m, g.enabled(m)[0] as Enabled).marking;
    expect(enabledSteps()).toEqual(['n1']);
    // Trying to run step N+1 before step N is refused: it holds no token yet.
    const intoN2 = g.index.in.get('task:n2')?.[0];
    if (!intoN2) throw new Error('graph changed');
    expect(() => g.fire(m, { node: 'task:n2', frames: [], consumes: [{ edge: intoN2.id, frames: [] }] })).toThrow(/task:n2 is not enabled/);
    const n1 = g.enabled(m).find((e) => g.index.node.get(e.node)?.source === 'n1') as Enabled;
    m = g.fire(m, n1).marking;
    expect(enabledSteps()).toEqual(['n2']);
  });

  it('[DI-34] parallel branches are enabled together and the join waits for every branch', () => {
    const mbr = mbrWith({
      kind: 'parallel',
      id: 'par',
      branches: [
        { id: 'a', name: 'A', body: seq('a-seq', [phase('a1'), phase('a2')]) },
        { id: 'b', name: 'B', body: phase('b1') },
      ],
    });
    const g = game(mbr);
    let m = g.initial();
    const sources = (): string[] => g.enabled(m).map((e) => g.index.node.get(e.node)?.source ?? '');
    while (!sources().includes('a1')) m = g.fire(m, g.enabled(m)[0] as Enabled).marking;
    expect(sources()).toEqual(expect.arrayContaining(['a1', 'b1']));
    // Finish branch B only: the join is not enabled while A is unfinished.
    m = g.fire(m, g.enabled(m).find((e) => g.index.node.get(e.node)?.source === 'b1') as Enabled).marking;
    expect(g.enabled(m).some((e) => g.index.node.get(e.node)?.kind === 'AND_JOIN')).toBe(false);
    const { steps } = run(g);
    expect(steps).toEqual(expect.arrayContaining(['a1', 'a2', 'b1']));
  });

  it('[DI-34] an alternative runs exactly one branch; the other branch never runs', () => {
    const mbr = mbrWith({
      kind: 'alternative',
      id: 'alt',
      decision: { mode: 'OPERATOR_CHOICE', roles: ['SUPERVISOR'], reasonRequired: true },
      branches: [
        { id: 'x', name: 'X', body: phase('x1') },
        { id: 'y', name: 'Y', body: phase('y1') },
      ],
    });
    const { steps } = run(game(mbr), () => 'y');
    expect(steps).toEqual(['y1']);
  });

  it('[INV-19] a loop offers CONTINUE only below its maximum; at the maximum an unmet exit is EXHAUSTED and raises an exception', () => {
    const mbr = mbrWith(
      { kind: 'loop', id: 'L', name: 'Loop', maxIterations: 3, exit: { condition: 'ep <= 1 [%]', endpoint: 'ep' }, body: phase('dry', { records: ['ep'] }) },
      { parameters: [endpoint('ep')] },
    );
    const g = game(mbr);
    const offered: string[][] = [];
    const { steps, exceptions } = run(g, (e) => {
      const c = g.choiceFor(e);
      if (c?.kind !== 'LOOP') return undefined;
      offered.push(c.options);
      return c.options.includes('CONTINUE') ? 'CONTINUE' : 'EXHAUSTED';
    });
    expect(offered).toEqual([
      ['EXIT', 'CONTINUE'],
      ['EXIT', 'CONTINUE'],
      ['EXIT', 'EXHAUSTED'],
    ]);
    // Every iteration keeps its own context: nothing overwrites an earlier iteration's data.
    expect(steps).toEqual(['dry@L=1', 'dry@L=2', 'dry@L=3']);
    expect(exceptions).toEqual(['LOOP_EXHAUSTED:L@L=3']);
    expect(() => {
      let m = g.initial();
      for (;;) {
        const e = g.enabled(m)[0] as Enabled;
        const c = g.choiceFor(e);
        if (c?.kind === 'LOOP' && c.iteration === 3) g.fire(m, e, 'CONTINUE');
        m = g.fire(m, e, c ? (c.kind === 'LOOP' ? 'CONTINUE' : c.options[0]) : undefined).marking;
      }
    }).toThrow(/not allowed/);
  });

  it('[INV-19] replicate instances run with their own sub-lot context and the join waits for all of them', () => {
    const mbr = mbrWith({
      kind: 'replicate',
      id: 'R',
      name: 'Loads',
      count: { mode: 'RUNTIME', min: 1, max: 3, reasonRequired: true },
      instances: 'CONCURRENT',
      subLotPrefix: 'LD',
      body: seq('r-seq', [phase('load'), phase('unload')]),
    });
    const g = game(mbr);
    const { steps } = run(g, (e) => (g.choiceFor(e)?.kind === 'COUNT' ? 3 : undefined));
    expect(steps.filter((s) => s.startsWith('unload'))).toEqual(['unload@R=1', 'unload@R=2', 'unload@R=3']);
    expect(steps).toHaveLength(6);
  });

  it('a graph that is not block-structured is refused by the checks the engine relies on', () => {
    const { graph } = compileMbr(mbrWith(seq('ops', [phase('n1'), phase('n2')])));
    const broken: ExecutionGraph = { ...graph, edges: graph.edges.filter((e) => e.to !== 'task:n2') };
    expect(checkGraph(broken).map((p) => p.code)).toEqual(expect.arrayContaining(['UNREACHABLE', 'DEGREE']));
  });
});
