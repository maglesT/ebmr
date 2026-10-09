import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compileMbr } from '../../src/flow/compile.ts';
import { childrenOf, type FlowNode, type MbrContent, type PhaseNode } from '../../src/flow/model.ts';
import { boundsOf, TokenGame } from '../../src/flow/tokens.ts';
import { enumeratePaths, exactPathCount } from '../../src/simulator/paths.ts';
import { checkGraph } from '../../src/validator/graph-checks.ts';
import { STRUCTURE_RULES } from '../../src/validator/rules-structure.ts';
import { validateGraph } from '../../src/validator/validate.ts';
import { clone, endpoint, errors, mbrWith, phase, registryOf, rulesOf, validate } from '../flow/support.ts';

/** Shapes of block-structured flows; ids are assigned when the shape is built. */
type Shape =
  | { t: 'phase' }
  | { t: 'hold' }
  | { t: 'seq'; c: Shape[] }
  | { t: 'par'; c: Shape[] }
  | { t: 'alt'; c: Shape[]; empty: boolean }
  | { t: 'loop'; b: Shape; max: number }
  | { t: 'rep'; b: Shape; min: number; extra: number; concurrent: boolean };

const shapes = fc.letrec<{ node: Shape; phase: Shape; hold: Shape; seq: Shape; par: Shape; alt: Shape; loop: Shape; rep: Shape }>((tie) => ({
  node: fc.oneof({ maxDepth: 3, depthIdentifier: 'flow' }, tie('phase'), tie('hold'), tie('seq'), tie('par'), tie('alt'), tie('loop'), tie('rep')),
  phase: fc.constant({ t: 'phase' as const }),
  hold: fc.constant({ t: 'hold' as const }),
  seq: fc.array(tie('node'), { minLength: 1, maxLength: 3 }).map((c) => ({ t: 'seq' as const, c })),
  par: fc.array(tie('node'), { minLength: 2, maxLength: 3 }).map((c) => ({ t: 'par' as const, c })),
  alt: fc.record({ c: fc.array(tie('node'), { minLength: 1, maxLength: 3 }), empty: fc.boolean() }).map(({ c, empty }) => ({ t: 'alt' as const, c: c.length === 1 && !empty ? [...c, { t: 'phase' as const }] : c, empty })),
  loop: fc.record({ b: tie('node'), max: fc.integer({ min: 1, max: 3 }) }).map(({ b, max }) => ({ t: 'loop' as const, b, max })),
  rep: fc.record({ b: tie('node'), min: fc.integer({ min: 1, max: 2 }), extra: fc.integer({ min: 0, max: 1 }), concurrent: fc.boolean() }).map((r) => ({ t: 'rep' as const, ...r })),
}));

function build(shape: Shape): MbrContent {
  let n = 0;
  const next = (p: string): string => `${p}${++n}`;
  const parameters: MbrContent['parameters'] = [];
  const make = (s: Shape): FlowNode => {
    switch (s.t) {
      case 'phase':
        return phase(next('p'));
      case 'hold':
        return { kind: 'holdPoint', id: next('h'), name: 'QA hold', role: 'QA', dispositions: ['APPROVED'] };
      case 'seq':
        return { kind: 'sequence', id: next('s'), children: s.c.map(make) };
      case 'par':
        return { kind: 'parallel', id: next('par'), branches: s.c.map((c) => ({ id: next('b'), name: 'Branch', body: make(c) })) };
      case 'alt':
        return {
          kind: 'alternative',
          id: next('alt'),
          decision: { mode: 'OPERATOR_CHOICE', roles: ['SUPERVISOR'], reasonRequired: true },
          branches: [...s.c.map((c) => ({ id: next('b'), name: 'Branch', body: make(c) })), ...(s.empty ? [{ id: next('b'), name: 'No action' }] : [])],
        };
      case 'loop': {
        const id = next('loop');
        const ep = `ep_${id}`;
        parameters.push(endpoint(ep));
        return { kind: 'loop', id, name: 'Loop', maxIterations: s.max, exit: { condition: `${ep} <= 1 [%]`, endpoint: ep }, body: { kind: 'sequence', id: next('s'), children: [make(s.b), phase(next('p'), { records: [ep] })] } };
      }
      case 'rep':
        return {
          kind: 'replicate',
          id: next('rep'),
          name: 'Sub-lots',
          count: { mode: 'RUNTIME', min: s.min, max: s.min + s.extra, reasonRequired: true },
          instances: s.concurrent ? 'CONCURRENT' : 'SEQUENTIAL',
          subLotPrefix: 'SL',
          body: make(s.b),
        };
    }
  };
  const body = make(shape);
  return mbrWith(body, { parameters });
}

const structureOnly = registryOf(STRUCTURE_RULES);

function all(mbr: MbrContent): FlowNode[] {
  const out: FlowNode[] = [];
  const visit = (x: FlowNode): void => {
    out.push(x);
    childrenOf(x).forEach(visit);
  };
  visit(mbr.procedure.body);
  return out;
}

interface Mutation {
  name: string;
  expected: string[];
  apply: (m: MbrContent) => void;
}

/** Single-construct mutations applicable to this MBR, each with the one gate it must break. */
function mutations(mbr: MbrContent): Mutation[] {
  const out: Mutation[] = [];
  const nodes = all(mbr);
  const find = (m: MbrContent, id: string): FlowNode => all(m).find((x) => x.id === id) as FlowNode;
  for (const n of nodes) {
    if (n.kind === 'loop') {
      out.push({
        name: `loop ${n.id} exits on an acceptance test`,
        expected: ['FLOW-LOOPS'],
        apply: (m) => {
          const loop = find(m, n.id);
          const p = m.parameters.find((x) => loop.kind === 'loop' && x.id === loop.exit.endpoint);
          if (p) p.role = 'ACCEPTANCE_TEST';
        },
      });
    }
    if (n.kind === 'replicate') {
      out.push({
        name: `replicate ${n.id} with min above max`,
        expected: ['FLOW-REPLICATES'],
        apply: (m) => {
          const r = find(m, n.id);
          if (r.kind === 'replicate') r.count = { ...r.count, min: r.count.max + 1 };
        },
      });
    }
    if (n.kind === 'parallel') {
      out.push({
        name: `parallel ${n.id} left with one branch`,
        // Caught twice on purpose: by the construct's own contract and by the split's degree in the graph.
        expected: ['FLOW-CONSTRUCTS', 'GRAPH-MATCHED'],
        apply: (m) => {
          const p = find(m, n.id);
          if (p.kind === 'parallel') p.branches = p.branches.slice(0, 1);
        },
      });
    }
    if (n.kind === 'alternative') {
      out.push({
        name: `alternative ${n.id} left with one branch`,
        expected: ['FLOW-CONSTRUCTS', 'GRAPH-MATCHED'],
        apply: (m) => {
          const a = find(m, n.id);
          if (a.kind === 'alternative') a.branches = a.branches.slice(0, 1);
        },
      });
    }
    if (n.kind === 'holdPoint') {
      out.push({
        name: `hold point ${n.id} without dispositions`,
        expected: ['FLOW-CONSTRUCTS'],
        apply: (m) => {
          const h = find(m, n.id);
          if (h.kind === 'holdPoint') h.dispositions = [];
        },
      });
    }
  }
  const plain = nodes.filter((x): x is PhaseNode => x.kind === 'phase' && x.records.length === 0);
  if (plain.length >= 2) {
    out.push({
      name: 'two steps share an id',
      expected: ['FLOW-ID-UNIQUE'],
      apply: (m) => {
        const [a, b] = all(m).filter((x): x is PhaseNode => x.kind === 'phase' && x.records.length === 0);
        if (a && b) b.id = a.id;
      },
    });
  }
  out.push({
    name: 'a step placed directly in the stage',
    expected: ['FLOW-LEVELS'],
    apply: (m) => {
      const stage = all(m).find((x) => x.kind === 'stage');
      if (stage?.kind === 'stage') stage.body = { kind: 'sequence', id: 'stage-seq', children: [stage.body, phase('stray')] };
    },
  });
  return out;
}

describe('property: block-structured flows are sound by construction', () => {
  it('[DI-34][INV-19] every generated block-structured flow passes every structure gate', () => {
    fc.assert(
      fc.property(shapes.node, (shape) => {
        const mbr = build(shape);
        const report = validate(mbr, {}, structureOnly);
        expect(errors(report)).toEqual([]);
        expect(checkGraph(compileMbr(mbr).graph)).toEqual([]);
      }),
      { numRuns: 150 },
    );
  });

  it('[DI-34][INV-19] every generated flow completes on every path, and enumeration finds exactly the closed-form number of paths', () => {
    fc.assert(
      fc.property(shapes.node, (shape) => {
        const mbr = build(shape);
        const { graph, expanded } = compileMbr(mbr);
        const exact = exactPathCount(expanded.root);
        fc.pre(exact <= 2000n);
        let count = 0n;
        for (const p of enumeratePaths(new TokenGame(graph, boundsOf(expanded.root)), 100_000)) {
          expect(p.completed).toBe(true);
          count++;
        }
        expect(count).toBe(exact);
      }),
      { numRuns: 100 },
    );
  });

  it('[DI-34][INV-19] mutating one construct breaks exactly the expected gate', () => {
    fc.assert(
      fc.property(shapes.node, fc.nat(), (shape, pick) => {
        const mbr = build(shape);
        const options = mutations(mbr);
        const m = options[pick % options.length] as Mutation;
        const mutated = clone(mbr);
        m.apply(mutated);
        const got = rulesOf(errors(validate(mutated, {}, structureOnly)));
        expect({ mutation: m.name, rules: got }).toEqual({ mutation: m.name, rules: m.expected });
      }),
      { numRuns: 200 },
    );
  });

  it('[DI-34] an edge added between two parallel branches of a generated flow is refused as a boundary crossing', () => {
    fc.assert(
      fc.property(shapes.node, (shape) => {
        const graph = compileMbr(build({ t: 'par', c: [shape, { t: 'phase' }] })).graph;
        const tasks = graph.nodes.filter((n) => n.kind === 'TASK');
        const a = tasks.find((n) => n.regions.some((r) => r.startsWith('branch:')));
        const b = tasks.find((n) => a !== undefined && n.regions.some((r) => r.startsWith('branch:')) && n.regions.join() !== a.regions.join() && !n.regions.includes(a.regions.find((r) => r.startsWith('branch:')) ?? ''));
        fc.pre(a !== undefined && b !== undefined);
        graph.edges.push({ id: 'stray', from: (a as { id: string }).id, to: (b as { id: string }).id, kind: 'FLOW' });
        expect(rulesOf(validateGraph(graph))).toContain('GRAPH-BOUNDARIES');
      }),
      { numRuns: 100 },
    );
  });
});
