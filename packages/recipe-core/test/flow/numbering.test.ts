/**
 * Document numbering (Phase 2 apps plan sections 4 and 8): stage 2, operation 2.1, step 2.1.3, with loop
 * and sub-lot suffixes on step instances. Checked on both fixture MBRs and on generated trees.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { instanceNumber, numberFlow, numberMbr, NumberingError } from '../../src/flow/numbering.ts';
import { walk, type FlowNode, type PhaseNode } from '../../src/flow/model.ts';
import { loadFixture } from './support.ts';

const phase = (id: string): PhaseNode => ({
  kind: 'phase', id, name: id, block: { type: 'G-04', version: '1' }, config: {}, records: [], computes: [], reads: [], consumes: [], produces: [], uses: [],
  equipment: [], signatures: {}, significant: false, riskClass: 'LOW',
});

describe('MBR numbering', () => {
  it('numbers the granulation fixture: stages, operations and steps in document order, constructs transparent', () => {
    const mbr = loadFixture('tablet-granulation-compression');
    const n = numberMbr(mbr);
    const num = (id: string): string | undefined => n.byId.get(id)?.number;
    expect(n.stages.map((s) => [s.id, s.number])).toEqual([
      ['S-DISP', '1'],
      ['S-GRAN', '2'],
      ['S-BLEND', '3'],
      ['S-COMP', '4'],
    ]);
    expect(num('O-DISP-PREP')).toBe('1.1');
    expect(num('p-disp-clear')).toBe('1.1.1');
    expect(num('p-disp-bal')).toBe('1.1.2');
    expect(num('O-DISP-WEIGH')).toBe('1.3');
    expect(num('p-disp-api')).toBe('1.3.1');
    expect(num('p-disp-kits')).toBe('1.3.3');
    // Parallel branches and alternatives are numbered in document order inside their operation.
    expect(['p-charge', 'p-drymix', 'p-vessel-status', 'p-binder-prep'].map(num)).toEqual(['2.2.1', '2.2.2', '2.2.3', '2.2.4']);
    expect(['p-binder-add', 'p-extra-ipa', 'p-wetmass', 'p-wet-out'].map(num)).toEqual(['2.3.1', '2.3.2', '2.3.3', '2.3.4']);
    // Library content keeps its expanded id; the loop is transparent.
    expect(['p-fbd-load', 'p-drycycle', 'c-lod/lod-test', 'H-OVERDRY'].map(num)).toEqual(['2.4.1', '2.4.2', '2.4.3', '2.4.4']);
    // A hold point outside every stage takes the next top-level number.
    expect(n.byId.get('H-CORES')).toMatchObject({ kind: 'HOLD', number: '5' });
    expect(n.byId.get('p-disp-api')).toMatchObject({ stage: 'S-DISP', operation: 'O-DISP-WEIGH', block: 'G-07@1', ordinal: 4 });
    expect(n.constructs.get('R-SUBLOT')).toBe('REPLICATE');
    expect(n.constructs.get('L-DRY')).toBe('LOOP');
    expect(n.totalSteps).toBe(n.steps.length);
    expect(n.steps.map((s) => s.ordinal)).toEqual(n.steps.map((_, i) => i + 1));
  });

  it('numbers every phase and hold point of both fixtures exactly once, with unique numbers', () => {
    for (const name of ['tablet-granulation-compression', 'tablet-blister-packaging'] as const) {
      const mbr = loadFixture(name);
      const n = numberMbr(mbr);
      const numbers = [...n.byId.values()].map((x) => x.number);
      expect(new Set(numbers).size, name).toBe(numbers.length);
      const direct: string[] = [];
      walk(mbr.procedure.body, (node) => {
        if (node.kind === 'phase' || node.kind === 'holdPoint') direct.push(node.id);
      });
      const libraryCalls = n.steps.filter((s) => s.id.includes('/')).length;
      expect(n.steps.length, name).toBe(direct.length + libraryCalls);
      for (const id of direct) expect(n.byId.get(id)?.number, id).toMatch(/^\d+(\.\d+)*$/);
    }
  });

  it('adds loop-iteration and sub-lot suffixes to step instances', () => {
    const n = numberMbr(loadFixture('tablet-granulation-compression'));
    expect(instanceNumber(n, 'p-disp-api')).toEqual({ number: '1.3.1', suffix: '', text: '1.3.1' });
    expect(instanceNumber(n, 'p-drycycle', [{ construct: 'R-SUBLOT', index: 2 }, { construct: 'L-DRY', index: 3 }])).toEqual({
      number: '2.4.2',
      suffix: 'sub-lot 2, iteration 3',
      text: '2.4.2 (sub-lot 2, iteration 3)',
    });
    expect(() => instanceNumber(n, 'O-DISP-PREP')).toThrow(NumberingError);
    expect(() => instanceNumber(n, 'nope')).toThrow(NumberingError);
  });

  it('refuses duplicate ids and unknown library elements', () => {
    expect(() => numberFlow({ kind: 'sequence', id: 'q', children: [phase('a'), phase('a')] })).toThrow(/occurs twice/);
    expect(() => numberFlow({ kind: 'libraryCall', id: 'c', element: 'LIB-X', bind: {} })).toThrow(/does not embed/);
  });

  it('numbers are hierarchical and dense for any tree of stages, operations and phases', () => {
    const tree = fc.array(fc.array(fc.integer({ min: 0, max: 4 }), { minLength: 0, maxLength: 4 }), { minLength: 1, maxLength: 4 });
    fc.assert(
      fc.property(tree, (shape) => {
        let k = 0;
        const body: FlowNode = {
          kind: 'sequence',
          id: 'root',
          children: shape.map((ops, s) => ({
            kind: 'stage', id: `S${s}`, name: `Stage ${s}`, binding: { rooms: [], equipment: [] }, purpose: 'MATERIAL', responsibleRole: 'PRODUCTION_SUPERVISOR',
            body: { kind: 'sequence', id: `S${s}-q`, children: ops.map((count, o) => ({ kind: 'operation', id: `S${s}O${o}`, name: 'op', body: { kind: 'sequence', id: `S${s}O${o}-q`, children: Array.from({ length: count }, () => phase(`p${(k += 1)}`)) } })) },
          })),
        };
        const n = numberFlow(body);
        shape.forEach((ops, s) => {
          expect(n.byId.get(`S${s}`)?.number).toBe(String(s + 1));
          ops.forEach((_, o) => expect(n.byId.get(`S${s}O${o}`)?.number).toBe(`${s + 1}.${o + 1}`));
        });
        expect(n.totalSteps).toBe(k);
        for (const st of n.steps) expect(st.number.split('.')).toHaveLength(3);
      }),
      { numRuns: 200 },
    );
  });
});
