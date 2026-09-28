/**
 * Dependencies across named calculations (brief A1 item 6; ADR 0005 decision 7; outline 6.3 "no
 * calculation cycles"; outline 5.2.3 dependents of a corrected input, L-09).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checkCalculationSet, evaluateCalculationSet } from '../src/deps/calculation-set.ts';
import { assessDecisionChange, assessTargetChange, buildDependencyGraph, classifyDependents, type DependencyNode } from '../src/deps/graph.ts';
import { compile, type CompiledExpression } from '../src/lang/compile.ts';
import type { InputDeclarations, OutputDeclaration } from '../src/lang/types.ts';

function calc(name: string, source: string, inputs: InputDeclarations, output?: OutputDeclaration): CompiledExpression {
  const r = compile(source, { name, inputs, ...(output === undefined ? {} : { output }) });
  if (!r.ok) throw new Error(r.diagnostics.map((d) => d.message).join('; '));
  return r.program;
}

const node = (id: string, reads: string[], kind: DependencyNode['kind'] = 'CALCULATION', acted?: boolean): DependencyNode => ({ id, kind, reads, ...(acted === undefined ? {} : { acted }) });

describe('dependency graph', () => {
  it('[DI-33] refuses calculation cycles and names them', () => {
    const r = buildDependencyGraph([node('a', ['b', 'x']), node('b', ['c']), node('c', ['a']), node('d', ['x'])]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.cycles).toEqual([['a', 'b', 'c']]);
    expect(r.diagnostics[0]).toMatchObject({ code: 'EXPR-DEP-001', severity: 'ERROR' });
    expect(r.diagnostics[0]?.message).toMatch(/depend on each other in a cycle/);
    const self = buildDependencyGraph([node('a', ['a'])]);
    expect(self.ok === false && self.cycles).toEqual([['a']]);
  });

  it('refuses two nodes with the same name', () => {
    const r = buildDependencyGraph([node('a', []), node('a', [])]);
    expect(r.ok === false && r.diagnostics[0]?.code).toBe('EXPR-DEP-002');
  });

  it('[DI-33] gives one deterministic evaluation order, whatever the order of declaration', () => {
    const nodes = [node('yield', ['actual', 'theoretical']), node('theoretical', ['charged', 'rework']), node('rework', ['x']), node('charged', ['x']), node('alpha', ['x'])];
    const r1 = buildDependencyGraph(nodes);
    const r2 = buildDependencyGraph([...nodes].reverse());
    expect(r1.ok && r1.graph.order).toEqual(['alpha', 'charged', 'rework', 'theoretical', 'yield']);
    expect(r2.ok && r2.graph.order).toEqual(r1.ok && r1.graph.order);
  });

  it('[DI-33] every topological order respects every dependency (random acyclic graphs)', () => {
    const dag = fc.integer({ min: 1, max: 12 }).chain((n) =>
      fc.tuple(
        fc.constant(n),
        fc.array(fc.tuple(fc.integer({ min: 0, max: n - 1 }), fc.integer({ min: 0, max: n - 1 })), { maxLength: 30 }),
      ),
    );
    fc.assert(
      fc.property(dag, ([n, edges]) => {
        // Only edges from a lower to a higher index: acyclic by construction.
        const reads = Array.from({ length: n }, () => [] as string[]);
        for (const [a, b] of edges) if (a < b) reads[b]?.push(`n${String(a)}`);
        const r = buildDependencyGraph(reads.map((rd, i) => node(`n${String(i)}`, rd)));
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const pos = new Map(r.graph.order.map((id, i) => [id, i]));
        for (let i = 0; i < n; i += 1) for (const d of reads[i] ?? []) expect(pos.get(d) ?? -1).toBeLessThan(pos.get(`n${String(i)}`) ?? -1);
      }),
      { numRuns: 200 },
    );
  });
});

describe('dependents of a corrected input (outline 5.2.3)', () => {
  const graph = buildDependencyGraph([
    node('theoretical', ['dispensed.api', 'dispensed.filler']),
    node('stage_yield', ['granules', 'theoretical']),
    node('yield_ok', ['stage_yield'], 'DECISION', true),
    node('loop_exit', ['lod'], 'DECISION', false),
    node('api_target', ['assay', 'water'], 'TARGET', true),
    node('filler_target', ['api_target'], 'TARGET', false),
  ]);
  if (!graph.ok) throw new Error('graph');

  it('[DI-33] classifies derived results, decision inputs and executed targets', () => {
    expect(classifyDependents(graph.graph, 'granules').map((d) => [d.id, d.classification, d.action])).toEqual([
      ['stage_yield', 'DERIVED_RESULT', 'RECALCULATE_KEEP_PREVIOUS'],
      ['yield_ok', 'DECISION_INPUT', 'REEVALUATE_RAISE_EXCEPTION_IF_CHANGED'],
    ]);
    expect(classifyDependents(graph.graph, 'assay').map((d) => [d.id, d.classification, d.action])).toEqual([
      ['api_target', 'EXECUTED_TARGET', 'COMPARE_WITH_EXECUTED'],
      ['filler_target', 'DERIVED_RESULT', 'RECALCULATE_KEEP_PREVIOUS'],
    ]);
    expect(classifyDependents(graph.graph, 'lod').map((d) => [d.id, d.action])).toEqual([['loop_exit', 'NONE_NOT_YET_TAKEN']]);
    expect(classifyDependents(graph.graph, 'unrelated')).toEqual([]);
  });

  it('[DI-33] explains each handling in plain language and shows the dependency chain', () => {
    const d = classifyDependents(graph.graph, 'dispensed.api');
    expect(d.map((x) => x.id)).toEqual(['theoretical', 'stage_yield', 'yield_ok']);
    expect(d[2]?.via).toEqual(['dispensed.api', 'theoretical', 'stage_yield', 'yield_ok']);
    expect(d[2]?.explanation).toMatch(/never re-routed.*only QA can disposition/);
  });

  it('[DI-33] a re-evaluated decision that would now differ raises a decision-affecting-correction exception', () => {
    expect(assessDecisionChange(true, true)).toEqual({ changed: false, action: 'NONE' });
    expect(assessDecisionChange(true, false)).toEqual({ changed: true, action: 'RAISE_DECISION_AFFECTING_CORRECTION' });
    expect(assessDecisionChange('PASS', 'FAIL').action).toBe('RAISE_DECISION_AFFECTING_CORRECTION');
  });

  it('[DI-33] a new target outside tolerance of what was executed raises an exception; inside it does not', () => {
    const executed = { value: '8.742', unit: 'kg' };
    expect(assessTargetChange(executed, { value: '8745', unit: 'g' }, { absolute: { value: '5', unit: 'g' } })).toEqual({ withinTolerance: true, difference: '0.003', unit: 'kg', action: 'NONE' });
    expect(assessTargetChange(executed, { value: '8.760', unit: 'kg' }, { absolute: { value: '5', unit: 'g' } })).toMatchObject({ withinTolerance: false, action: 'RAISE_TARGET_CHANGE_EXCEPTION' });
    expect(assessTargetChange(executed, { value: '8.7857', unit: 'kg' }, { percent: '0.5' })).toMatchObject({ withinTolerance: true });
    expect(assessTargetChange(executed, { value: '8.7858', unit: 'kg' }, { percent: '0.5' })).toMatchObject({ withinTolerance: false });
    expect(() => assessTargetChange(executed, { value: '1', unit: 'L' }, { percent: '1' })).toThrow();
  });
});

describe('calculation sets', () => {
  const theoretical = calc('theoretical', 'sum(charged) + rework', { charged: { kind: 'series', unit: 'kg', maxLength: 20 }, rework: { unit: 'kg' } }, { unit: 'kg' });
  const stageYield = calc('stage_yield', 'yield(granules, theoretical)', { granules: { unit: 'kg' }, theoretical: { unit: 'kg', source: 'DERIVED' } }, { unit: '%', tag: 'yield' });

  it('[INV-25] evaluates in dependency order and feeds computed results, never typed values', () => {
    const r = evaluateCalculationSet([stageYield, theoretical], {
      charged: { values: ['50.000'], source: 'dispensing' },
      rework: { value: '1.200', source: 'rework addition' },
      granules: { value: '50.300', source: 'weighing' },
    });
    expect(r.order).toEqual(['theoretical', 'stage_yield']);
    const y = r.results['stage_yield'];
    expect(y?.ok && y.record.output.value).toBe('98.2421875');
    const t = r.results['theoretical'];
    expect(y?.ok && t?.ok && y.record.inputs.find((i) => i.path === 'theoretical')?.derivedFrom).toBe(t?.ok && t.record.contentHash);
  });

  it('[INV-25] a calculation that reads another calculation as a typed input is refused', () => {
    const typed = calc('stage_yield', 'yield(granules, theoretical)', { granules: { unit: 'kg' }, theoretical: { unit: 'kg' } });
    const r = checkCalculationSet([theoretical, typed]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics[0]).toMatchObject({ code: 'EXPR-INV25-002', control: 'INV-25' });
    const orphan = calc('y2', 'yield(granules, missing_calc)', { granules: { unit: 'kg' }, missing_calc: { unit: 'kg', source: 'DERIVED' } });
    const r2 = checkCalculationSet([orphan]);
    expect(r2.ok === false && r2.diagnostics[0]?.code).toBe('EXPR-DEP-004');
  });

  it('[DI-33] a dependency that fails makes its dependents fail explicitly', () => {
    const r = evaluateCalculationSet([theoretical, stageYield], { rework: { value: '1.2', source: 'x' }, granules: { value: '50', source: 'x' } });
    expect(r.results['theoretical']).toMatchObject({ ok: false, error: { code: 'MISSING_INPUT', path: 'charged' } });
    const y = r.results['stage_yield'];
    expect(y?.ok).toBe(false);
    if (y?.ok === false) {
      expect(y.error.code).toBe('MISSING_INPUT');
      expect(y.error.message).toMatch(/calculation "theoretical" has no result/);
    }
  });

  it('[DI-33] a cycle among calculations is refused before anything is evaluated', () => {
    const a = calc('a', 'b * 2', { b: { unit: 'kg', source: 'DERIVED' } });
    const b = calc('b', 'a * 2', { a: { unit: 'kg', source: 'DERIVED' } });
    expect(checkCalculationSet([a, b])).toMatchObject({ ok: false, diagnostics: [{ code: 'EXPR-DEP-001' }] });
    expect(() => evaluateCalculationSet([a, b], {})).toThrow(/not valid/);
  });
});
