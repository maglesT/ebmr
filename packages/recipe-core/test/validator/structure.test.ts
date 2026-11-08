import { describe, expect, it } from 'vitest';
import { compileMbr } from '../../src/flow/compile.ts';
import type { ExecutionGraph, GraphNode } from '../../src/flow/graph.ts';
import type { FlowNode, MbrContent } from '../../src/flow/model.ts';
import type { Frame } from '../../src/flow/tokens.ts';
import { STRUCTURE_RULES } from '../../src/validator/rules-structure.ts';
import { validateGraph } from '../../src/validator/validate.ts';
import { define, OP1, Run } from '../engine/support.ts';
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

  it('[DI-34] FLOW-LEVELS: a phase outside every stage, an operation outside a stage and a stage inside a stage are refused', () => {
    const m = mbrWith(phase('ok'));
    m.procedure.body = seq('proc', [...(m.procedure.body.kind === 'sequence' ? m.procedure.body.children : []), phase('stray')]);
    expect(messages(m, 'FLOW-LEVELS').join(' ')).toMatch(/stray.*is a phase placed directly in the procedure; a phase belongs in a stage or an operation of a stage/);
    const nested = mbrWith(phase('ok'));
    const stage = nested.procedure.body.kind === 'sequence' ? nested.procedure.body.children[0] : undefined;
    if (stage?.kind !== 'stage') throw new Error('builder changed');
    stage.body = seq('st', [stage.body, { ...stage, id: 'S2', body: { kind: 'operation', id: 'O2', name: 'Op', body: phase('x') } }]);
    expect(messages(nested, 'FLOW-LEVELS').join(' ')).toMatch(/S2.*is a stage placed directly in a stage/);
    const opInOp = mbrWith(seq('ops', [phase('a'), { kind: 'operation', id: 'O3', name: 'Op', body: phase('b') }]));
    expect(messages(opInOp, 'FLOW-LEVELS').join(' ')).toMatch(/O3.*is a operation placed inside an operation; a operation belongs in a stage/);
  });

  it('[DI-34] FLOW-LEVELS: the operation level is optional, so a phase, a hold point or both sit directly in a stage (ADR 0004 decision 1, amended)', () => {
    const m = mbrWith(phase('ok'));
    const stage = m.procedure.body.kind === 'sequence' ? m.procedure.body.children[0] : undefined;
    if (stage?.kind !== 'stage') throw new Error('builder changed');
    stage.body = seq('st', [phase('direct'), { kind: 'holdPoint', id: 'H', name: 'Hold', role: 'QA', dispositions: ['OK'] }, stage.body]);
    expect(validate(m, {}, structureOnly).findings).toEqual([]);
    stage.body = seq('st2', [phase('only')]);
    expect(validate(m, {}, structureOnly).findings).toEqual([]);
  });

  it('[DI-34] FLOW-LEVELS: an empty stage is refused; an empty operation only warns', () => {
    const m = mbrWith(phase('ok'));
    const stage = m.procedure.body.kind === 'sequence' ? m.procedure.body.children[0] : undefined;
    if (stage?.kind !== 'stage') throw new Error('builder changed');
    stage.body = seq('st', [phase('direct'), { kind: 'operation', id: 'O-EMPTY', name: 'Empty', body: seq('none', []) }]);
    const levels = validate(m, {}, structureOnly).findings.filter((f) => f.rule === 'FLOW-LEVELS');
    expect(levels.map((f) => [f.severity, f.subject])).toEqual([['WARNING', 'O-EMPTY']]);
    stage.body = seq('none', []);
    const empty = validate(m, {}, structureOnly).findings.filter((f) => f.rule === 'FLOW-LEVELS');
    expect(empty.map((f) => [f.severity, f.subject])).toEqual([['ERROR', 'S']]);
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
    expect(refused[0]).toMatch(/acceptance or release test.*only repeat on a process endpoint.*reprocessing procedure \[IN-20 OOS investigation, PR-47 reprocessing\]/);
    expect(refused[0]).toMatch(/\(FLOW-LOOPS; DI-34, INV-19\)$/);
  });

  it('[INV-19][DI-34] FLOW-LOOPS: an exit condition that also depends on a test result, directly or through a calculation, is refused', () => {
    const withExit = (condition: string): MbrContent =>
      mbrWith(
        {
          kind: 'loop',
          id: 'L',
          name: 'Blend',
          maxIterations: 3,
          exit: { condition, endpoint: 'ep' },
          body: phase('blend', { records: ['ep', 'bu'], computes: ['buTwice'] }),
        },
        {
          parameters: [endpoint('ep'), endpoint('bu', 'ACCEPTANCE_TEST')],
          calculations: [{ id: 'buTwice', name: 'BU doubled', expression: 'bu * 2', output: { valueType: 'DECIMAL', unit: '%' }, criticality: 'CRITICAL', riskClass: 'HIGH' }],
        },
      );
    expect(messages(withExit('ep <= 1 [%]'), 'FLOW-LOOPS')).toEqual([]);
    expect(messages(withExit('ep <= 1 [%] && bu <= 5.0 [%]'), 'FLOW-LOOPS')).toEqual([expect.stringMatching(/depends on Endpoint bu, an acceptance or release test/)]);
    expect(messages(withExit('ep <= 1 [%] && buTwice <= 10 [%]'), 'FLOW-LOOPS')).toEqual([expect.stringMatching(/depends on Endpoint bu, an acceptance or release test/)]);
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

/**
 * SQL mutation defect D12 (Phase 2 exit, limit exceptions; decision D12.1): two loops, one inside the other, that exit
 * on the same endpoint. The inner loop's exit judges the last reading of the endpoint against its limits; the outer
 * loop's exit judges that same reading again (engine data.ts raiseForEvaluationAtExit), raising a second limit breach
 * for it when it is outside them, and the database refuses that outer exit row whether the reading passes or not
 * (recipe-core 0303 lets only a waiting endpoint take a verdict; 0305 finds no verdict behind the second breach), so the
 * batch stops there. The validator passed such an MBR. It now refuses it (FLOW-LOOPS); the database's refusal stays.
 */
describe('D12: nested loops never exit on the same endpoint (FLOW-LOOPS; INV-19, DI-34, PR-08)', () => {
  const pinned = mbrWith(seq('none', [])).references;
  const references: MbrContent['references'] = [
    ...pinned,
    { id: 'VR', kind: 'VALIDATION_REPORT', code: 'VR-1', version: '1', hash: 'b'.repeat(64) },
    { id: 'SYS-LOD', kind: 'COMPUTERISED_SYSTEM', code: 'CS-LOD', version: '1', hash: 'c'.repeat(64) },
  ];
  const loop = (id: string, name: string, endpointId: string, body: FlowNode): FlowNode => ({
    kind: 'loop',
    id,
    name,
    maxIterations: 1,
    exit: { condition: `${endpointId} <= 1 [%]`, endpoint: endpointId },
    body,
  });
  const test = (records: string[]): FlowNode => phase('test', { records, system: { kind: 'OTHER', ref: 'SYS-LOD' } });
  const nested = (outerEndpoint: string, inner: FlowNode): MbrContent =>
    mbrWith(seq('ops', [loop('OL', 'Outer', outerEndpoint, inner), phase('after')]), { parameters: [endpoint('ep'), endpoint('ep2')], references });
  const sameEndpoint = nested('ep', loop('IL', 'Inner', 'ep', test(['ep'])));
  const refusal = (inner: string, outer: string): string =>
    `Loop ${inner} lies inside loop ${outer}, and both exit on "Endpoint ep" (ep). The inner loop's exit judges the last reading of "Endpoint ep" (ep) against its limits; the outer loop's exit would judge that same reading again, and raise a second limit breach for it when it is outside them, which the database refuses, so the batch would stop at the outer loop's exit. Give the outer loop an endpoint of its own, recorded inside it, or keep only one of the two loops (FLOW-LOOPS; DI-34, INV-19)`;

  it('[INV-19][DI-34][PR-08] a loop inside a loop that exits on the same endpoint is refused, in plain words; the engine would judge the one reading twice and raise two limit breaches for it', () => {
    const refused = errors(validate(sameEndpoint));
    expect(refused.map((f) => f.key)).toEqual(['FLOW-LOOPS@IL']);
    expect(refused[0]?.message).toBe(refusal('"Inner" (IL)', '"Outer" (OL)'));
    // Why: one reading outside its limits, two LIMIT_BREACH exceptions (the second at the outer exit).
    const run = Run.issue(define(sameEndpoint));
    const f: Frame[] = [{ construct: 'OL', index: 1 }, { construct: 'IL', index: 1 }];
    run.start('test', f);
    run.record('test', 'ep', { kind: 'DECIMAL', value: '7.0', unit: '%' }, { frames: f });
    run.perform('test', f);
    run.verify('test', f);
    run.ok({ type: 'COMPLETE_LOOP_ITERATION', actor: OP1, construct: 'IL', context: f });
    run.ok({ type: 'COMPLETE_LOOP_ITERATION', actor: OP1, construct: 'OL', context: [{ construct: 'OL', index: 1 }] });
    expect(Object.values(run.state.points).filter((p) => p.item === 'ep')).toHaveLength(1);
    expect(run.exceptions('LIMIT_BREACH').map((e) => e.title)).toEqual([
      expect.stringMatching(/^Endpoint ep \(ep\) at the exit of Inner 7\.0 % is outside/),
      expect.stringMatching(/^Endpoint ep \(ep\) at the exit of Outer 7\.0 % is outside/),
    ]);
  });

  it('[INV-19][DI-34][PR-08] at any depth: the innermost of three loops on one endpoint is refused against each loop around it, the middle one against the outer one', () => {
    const m = nested('ep', loop('ML', 'Middle', 'ep', loop('IL', 'Inner', 'ep', test(['ep']))));
    const refused = errors(validate(m));
    expect(refused.map((f) => f.message)).toEqual([refusal('"Inner" (IL)', '"Middle" (ML)'), refusal('"Inner" (IL)', '"Outer" (OL)'), refusal('"Middle" (ML)', '"Outer" (OL)')]);
  });

  it('[INV-19][DI-34][PR-08] nested loops with endpoints of their own pass, the outer endpoint recorded inside the inner loop too; so do two loops on one endpoint in two branches of an alternative, which never both run', () => {
    expect(errors(validate(nested('ep2', loop('IL', 'Inner', 'ep', test(['ep', 'ep2'])))))).toEqual([]);
    expect(errors(validate(nested('ep2', seq('ob', [loop('IL', 'Inner', 'ep', test(['ep'])), phase('measure', { records: ['ep2'], system: { kind: 'OTHER', ref: 'SYS-LOD' } })]))))).toEqual([]);
    const branches = mbrWith(
      seq('ops', [
        {
          kind: 'alternative',
          id: 'ROUTE',
          decision: { mode: 'OPERATOR_CHOICE', roles: ['PRODUCTION_SUPERVISOR'], reasonRequired: true },
          branches: [
            { id: 'A', name: 'Tray dryer', body: loop('LA', 'Tray drying', 'ep', phase('tray', { records: ['ep'], system: { kind: 'OTHER', ref: 'SYS-LOD' } })) },
            { id: 'B', name: 'Fluid bed', body: loop('LB', 'Fluid-bed drying', 'ep', phase('bed', { records: ['ep'], system: { kind: 'OTHER', ref: 'SYS-LOD' } })) },
          ],
        },
        phase('after'),
      ]),
      { parameters: [endpoint('ep')], references },
    );
    expect(errors(validate(branches))).toEqual([]);
  });

  it('[INV-19][DI-34] the shipped and seeded MBRs hold no such loops', () => {
    for (const name of ['tablet-granulation-compression', 'tablet-blister-packaging'] as const) {
      expect(validate(loadFixture(name)).findings.filter((f) => f.rule === 'FLOW-LOOPS')).toEqual([]);
    }
  });
});
