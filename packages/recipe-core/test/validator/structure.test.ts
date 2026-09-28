import { describe, expect, it } from 'vitest';
import { compileMbr } from '../../src/flow/compile.ts';
import type { ExecutionGraph, GraphNode } from '../../src/flow/graph.ts';
import type { FlowNode, MbrContent } from '../../src/flow/model.ts';
import { STRUCTURE_RULES } from '../../src/validator/rules-structure.ts';
import { validateGraph } from '../../src/validator/validate.ts';
import { clone, endpoint, errors, loadFixture, mbrWith, phase, registryOf, rulesOf, validate } from '../flow/support.ts';

const structureOnly = registryOf(STRUCTURE_RULES);
const seq = (id: string, children: FlowNode[]): FlowNode => ({ kind: 'sequence', id, children });

function structureRules(mbr: MbrContent): string[] {
  return rulesOf(errors(validate(mbr, {}, structureOnly)));
}

function messages(mbr: MbrContent, rule: string): string[] {
  return validate(mbr, {}, structureOnly)
    .findings.filter((f) => f.rule === rule)
    .map((f) => f.message);
}

describe('structure gates on the tree', () => {
  it('[DI-34] a well-formed minimal flow passes every structure gate', () => {
    expect(structureRules(mbrWith(seq('ops', [phase('a'), phase('b')])))).toEqual([]);
  });

  it('[DI-34] FLOW-LEVELS: a phase outside an operation, an operation outside a stage and a stage inside a stage are refused', () => {
    const m = mbrWith(phase('ok'));
    m.procedure.body = seq('proc', [...(m.procedure.body.kind === 'sequence' ? m.procedure.body.children : []), phase('stray')]);
    expect(messages(m, 'FLOW-LEVELS').join(' ')).toMatch(/stray.*is a phase placed directly in the procedure/);
    const nested = mbrWith(phase('ok'));
    const stage = nested.procedure.body.kind === 'sequence' ? nested.procedure.body.children[0] : undefined;
    if (stage?.kind !== 'stage') throw new Error('builder changed');
    stage.body = seq('st', [stage.body, { ...stage, id: 'S2', body: { kind: 'operation', id: 'O2', name: 'Op', body: phase('x') } }]);
    expect(messages(nested, 'FLOW-LEVELS').join(' ')).toMatch(/S2.*is a stage placed directly in a stage/);
  });

  it('[DI-34] FLOW-LEVELS: a procedure without any stage is refused', () => {
    const m = mbrWith(phase('a'));
    m.procedure.body = { kind: 'holdPoint', id: 'H', name: 'Hold', role: 'QA', dispositions: ['OK'] };
    expect(messages(m, 'FLOW-LEVELS').join(' ')).toMatch(/has no stage/);
  });

  it('[DI-34] FLOW-CONSTRUCTS: a parallel needs two non-empty branches, an alternative at most one empty branch', () => {
    const par = mbrWith({ kind: 'parallel', id: 'P', branches: [{ id: 'a', name: 'A', body: phase('a1') }] });
    expect(messages(par, 'FLOW-CONSTRUCTS')).toEqual([expect.stringMatching(/Parallel P needs at least two branches/)]);
    const alt = mbrWith(
      seq('ops', [
        phase('before'),
        {
          kind: 'alternative',
          id: 'A',
          decision: { mode: 'OPERATOR_CHOICE', roles: ['SUP'], reasonRequired: true },
          branches: [
            { id: 'x', name: 'X' },
            { id: 'y', name: 'Y' },
          ],
        },
      ]),
    );
    expect(messages(alt, 'FLOW-CONSTRUCTS')).toEqual([expect.stringMatching(/2 empty branches/)]);
  });

  it('[DI-34] FLOW-DECISIONS: data-decided branches need conditions; variant branches must cover the variant exactly once', () => {
    const data = mbrWith({
      kind: 'alternative',
      id: 'A',
      decision: { mode: 'DATA' },
      branches: [
        { id: 'x', name: 'X', guard: 'true', body: phase('x1') },
        { id: 'y', name: 'Y', body: phase('y1') },
      ],
    });
    expect(messages(data, 'FLOW-DECISIONS').join(' ')).toMatch(/Branch y of alternative A has no condition/);
    const variant = mbrWith(
      {
        kind: 'alternative',
        id: 'V',
        decision: { mode: 'ISSUE_VARIANT', variant: 'dest' },
        branches: [
          { id: 'x', name: 'X', variantValues: ['US', 'EU'], body: phase('x1') },
          { id: 'y', name: 'Y', variantValues: ['EU'], body: phase('y1') },
        ],
      },
      {},
    );
    variant.header.variants = [{ id: 'dest', values: ['US', 'EU', 'IN'] }];
    const text = messages(variant, 'FLOW-DECISIONS').join(' ');
    expect(text).toMatch(/"EU" selects both branch x and branch y/);
    expect(text).toMatch(/No branch of alternative V applies when variant dest is "IN"/);
  });

  it('[INV-19][DI-34] FLOW-LOOPS: a loop may only repeat on a process endpoint, never until a test passes', () => {
    const loop = (role: 'PROCESS_ENDPOINT' | 'ACCEPTANCE_TEST'): MbrContent =>
      mbrWith({ kind: 'loop', id: 'L', name: 'Re-blend until uniformity passes', maxIterations: 3, exit: { condition: 'bu <= 5.0 [%]', endpoint: 'bu' }, body: phase('blend', { records: ['bu'] }) }, { parameters: [endpoint('bu', role)] });
    expect(messages(loop('PROCESS_ENDPOINT'), 'FLOW-LOOPS')).toEqual([]);
    const refused = messages(loop('ACCEPTANCE_TEST'), 'FLOW-LOOPS');
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatch(/acceptance or release test.*only repeat on a process endpoint.*reprocessing/);
    expect(refused[0]).toMatch(/\(FLOW-LOOPS; DI-34, INV-19\)$/);
  });

  it('[INV-19] FLOW-LOOPS: the exit condition must read a value written inside the loop', () => {
    const m = mbrWith(
      seq('ops', [phase('measure', { records: ['ep'] }), { kind: 'loop', id: 'L', name: 'Dry', maxIterations: 3, exit: { condition: 'ep <= 1 [%]', endpoint: 'ep' }, body: phase('dry') }]),
      { parameters: [endpoint('ep')] },
    );
    expect(messages(m, 'FLOW-LOOPS').join(' ')).toMatch(/no step inside the loop records it/);
  });

  it('[INV-19] FLOW-REPLICATES: the minimum instance count cannot exceed the maximum', () => {
    const m = mbrWith({ kind: 'replicate', id: 'R', name: 'Loads', count: { mode: 'RUNTIME', min: 3, max: 2, reasonRequired: true }, instances: 'SEQUENTIAL', subLotPrefix: 'L', body: phase('load') });
    expect(messages(m, 'FLOW-REPLICATES').join(' ')).toMatch(/minimum count \(3\) above its maximum \(2\)/);
  });

  it('[DI-04] FLOW-BLOCKS: unregistered block types, retired versions and construct blocks used as steps are refused', () => {
    const m = mbrWith(seq('ops', [phase('a', { block: { type: 'G-99', version: '1' } }), phase('b', { block: { type: 'G-04', version: '7' } }), phase('c', { block: { type: 'G-19', version: '1' } })]));
    const text = messages(m, 'FLOW-BLOCKS').join(' ');
    expect(text).toMatch(/G-99, which is not registered/);
    expect(text).toMatch(/G-04 version 7, which is not a registered/);
    expect(text).toMatch(/use the flow constructs/);
  });

  it('[DI-34] FLOW-ID-UNIQUE: two steps with the same id are refused', () => {
    const m = mbrWith(seq('ops', [phase('a'), phase('a')]));
    expect(messages(m, 'FLOW-ID-UNIQUE').join(' ')).toMatch(/share the id a/);
  });
});

describe('structure gates on the compiled graph', () => {
  const fixture = compileMbr(loadFixture('tablet-granulation-compression')).graph;
  const node = (g: ExecutionGraph, id: string): GraphNode => g.nodes.find((n) => n.id === id) as GraphNode;

  it('[DI-34] the unmodified fixture graph passes every graph gate', () => {
    expect(validateGraph(fixture)).toEqual([]);
  });

  it('[DI-34] GRAPH-BOUNDARIES: an edge from one parallel branch into the other is refused', () => {
    const g = clone(fixture);
    g.edges.push({ id: 'stray', from: 'task:p-charge', to: 'task:p-binder-prep', kind: 'FLOW' });
    expect(rulesOf(validateGraph(g))).toContain('GRAPH-BOUNDARIES');
  });

  it('[DI-34][INV-19] GRAPH-DECLARED-CYCLES: a jump back that is not a declared loop is refused', () => {
    const g = clone(fixture);
    g.edges.push({ id: 'goto', from: 'task:p-blend-yield', to: 'task:p-blend-charge', kind: 'FLOW' });
    const f = validateGraph(g);
    expect(rulesOf(f)).toContain('GRAPH-DECLARED-CYCLES');
    expect(f.find((x) => x.rule === 'GRAPH-DECLARED-CYCLES')?.message).toMatch(/repeats outside a declared loop/);
    const back = clone(fixture);
    back.edges.push({ id: 'fake-back', from: 'task:p-comp-yield', to: 'task:p-comp-charge', kind: 'LOOP_BACK' });
    expect(rulesOf(validateGraph(back))).toContain('GRAPH-DECLARED-CYCLES');
  });

  it('[DI-34] GRAPH-REACHABLE and GRAPH-TERMINATES: a step cut off from the start, or from the end, is refused', () => {
    const g = clone(fixture);
    g.edges = g.edges.filter((e) => e.to !== 'task:p-lube');
    expect(rulesOf(validateGraph(g))).toEqual(expect.arrayContaining(['GRAPH-REACHABLE']));
    const h = clone(fixture);
    h.edges = h.edges.filter((e) => e.from !== 'task:p-lube');
    expect(rulesOf(validateGraph(h))).toEqual(expect.arrayContaining(['GRAPH-TERMINATES']));
  });

  it('[DI-34] GRAPH-START-END: a second end is refused', () => {
    const g = clone(fixture);
    g.nodes.push({ ...node(g, 'end'), id: 'end2' });
    expect(rulesOf(validateGraph(g))).toContain('GRAPH-START-END');
  });

  it('[DI-34] GRAPH-MATCHED: a split whose partner is a join of another kind is refused', () => {
    const g = clone(fixture);
    const split = node(g, 'and-split:P-MIX');
    split.partner = 'xor-join:ALT-IPA';
    expect(rulesOf(validateGraph(g))).toContain('GRAPH-MATCHED');
    const h = clone(fixture);
    node(h, 'and-join:P-MIX').join = 'ANY';
    expect(validateGraph(h).map((f) => f.message).join(' ')).toMatch(/join rule ANY; it must be ALL/);
  });
});
