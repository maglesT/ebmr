import { describe, expect, it } from 'vitest';
import { diffMbr, structureHash } from '../../src/flow/diff.ts';
import { clone, findNode, findPhase, loadFixture } from './support.ts';

const base = loadFixture('tablet-granulation-compression');

describe('structured difference and delta classification (outline 6.5)', () => {
  it('[DI-04] identical content is IDENTICAL', () => {
    expect(diffMbr(base, clone(base)).classification).toBe('IDENTICAL');
  });

  it('[DI-04] changing only limit, target and duration values is VALUE_ONLY and names the changed items', () => {
    const next = clone(base);
    const lod = next.parameters.find((p) => p.id === 'lod');
    const high = lod?.limits?.ranges[0]?.high;
    if (!high) throw new Error('fixture changed');
    high.value = '3.4';
    const tc = next.timeConstraints.find((t) => t.id === 'TC-LUBE');
    if (!tc?.max) throw new Error('fixture changed');
    tc.max.value = '6';
    const d = diffMbr(base, next);
    expect(d.classification).toBe('VALUE_ONLY');
    expect(d.changedSubjects).toEqual(['TC-LUBE', 'lod']);
    expect(d.changes.map((c) => c.path)).toEqual(expect.arrayContaining(['/parameters[lod]/limits/ranges[VALIDATED]/high/value', '/timeConstraints[TC-LUBE]/max/value']));
    expect(d.structureHash.before).toBe(d.structureHash.after);
  });

  it('[DI-04] a loop maximum duration and a BOM quantity are values; the loop maximum count is structure', () => {
    const next = clone(base);
    const loop = findNode(next, 'L-DRY');
    if (loop.kind !== 'loop' || !loop.maxDuration) throw new Error('fixture changed');
    loop.maxDuration.value = '4';
    (next.bom[1] as { quantity: { value: string } }).quantity.value = '21.000';
    expect(diffMbr(base, next).classification).toBe('VALUE_ONLY');
    loop.maxIterations = 6;
    expect(diffMbr(base, next).classification).toBe('STRUCTURAL');
  });

  it('[DI-04][IN-02] structural changes: a step, an expression, a unit, criticality or inclusivity', () => {
    const cases: ((m: typeof base) => void)[] = [
      (m) => {
        findPhase(m, 'p-blend').name = 'Renamed';
      },
      (m) => {
        const c = m.calculations[0];
        if (c) c.expression = `${c.expression} * 1`;
      },
      (m) => {
        const p = m.parameters.find((x) => x.id === 'inletTemp');
        if (p) p.unit = 'K';
      },
      (m) => {
        const p = m.parameters.find((x) => x.id === 'inletTemp');
        if (p) p.criticality = 'NON_CRITICAL';
      },
      (m) => {
        const r = m.parameters.find((x) => x.id === 'lod')?.limits?.ranges[0];
        if (r?.high) r.high.inclusive = false;
      },
      (m) => {
        findPhase(m, 'p-disp-api').signatures = { perform: { role: 'OPERATOR' } };
      },
    ];
    for (const mutate of cases) {
      const next = clone(base);
      mutate(next);
      const d = diffMbr(base, next);
      expect(d.classification).toBe('STRUCTURAL');
      expect(d.structureHash.before).not.toBe(d.structureHash.after);
    }
  });

  it('reordering an order-free list is not a change; reordering steps in a sequence is', () => {
    const next = clone(base);
    next.parameters.reverse();
    expect(diffMbr(base, next).classification).toBe('IDENTICAL');
    expect(structureHash(next)).toBe(structureHash(base));
    const seq = findNode(next, 'O-BLEND-RUN-seq');
    if (seq.kind !== 'sequence') throw new Error('fixture changed');
    seq.children.reverse();
    const d = diffMbr(base, next);
    expect(d.classification).toBe('STRUCTURAL');
    expect(d.changes.some((c) => c.kind === 'REORDERED')).toBe(true);
  });
});
