/**
 * D-8 (owner's items 13 and 21): the author's own names, formulas, yield calculation and limit sources. Each op changes
 * only what it names; each refusal leaves the content as it was; undo restores it. 21 CFR 211.160(b) (scientifically
 * sound specifications) is why each range records its source.
 */
import { describe, expect, it } from 'vitest';
import { flow } from '@ebmr/recipe-core/pure';
import granulation from '../../../../packages/recipe-core/test/fixtures/tablet-granulation-compression.mbr.json' with { type: 'json' };
import { applyOp, initHistory, OpError, perform, undo, type Content } from '../../src/features/designer/model/ops.ts';

function base(): Content {
  const r = flow.parseMbr(granulation);
  if (!r.ok) throw new Error('fixture does not parse');
  return r.mbr;
}
const canonical = (c: Content): string => JSON.stringify(c);
const VR: flow.Reference = { id: 'VR-BLEND-2', kind: 'VALIDATION_REPORT', code: 'VR-BLEND-2', version: '1', hash: 'b'.repeat(64), title: 'Blend validation, second campaign' };

describe('D-8: the author edits calculations, names, the yield and limit sources', () => {
  it('[PR-03] a calculation takes a new name and formula; a parameter a new name; ids never change', () => {
    const c = applyOp(base(), { kind: 'UPDATE_CALCULATION', id: 'blendYield', name: ' Blend yield of the bilayer core ', expression: 'blendNet / blendTheoretical * 100 [%]' });
    const x = c.calculations.find((k) => k.id === 'blendYield');
    expect([x?.name, x?.expression]).toEqual(['Blend yield of the bilayer core', 'blendNet / blendTheoretical * 100 [%]']);
    const p = applyOp(c, { kind: 'UPDATE_PARAMETER_NAME', id: 'blendNet', name: 'Lubricated blend discharged' });
    expect(p.parameters.find((k) => k.id === 'blendNet')?.name).toBe('Lubricated blend discharged');
    const before = canonical(base());
    expect(() => applyOp(base(), { kind: 'UPDATE_CALCULATION', id: 'nope', name: 'x' })).toThrow(OpError);
    expect(() => applyOp(base(), { kind: 'UPDATE_CALCULATION', id: 'blendYield', expression: '  ' })).toThrow(/cannot be empty/);
    expect(() => applyOp(base(), { kind: 'UPDATE_PARAMETER_NAME', id: 'blendNet', name: '' })).toThrow(/cannot be empty/);
    expect(canonical(base())).toBe(before);
  });

  it('[PR-03][PR-31] the yield takes another decimal calculation; the step that evaluates it computes the new result in place of the old', () => {
    const c = applyOp(base(), { kind: 'UPDATE_YIELD', id: 'Y-GRAN', name: 'Granule yield (dried)', result: 'blendYield', theoretical: 'blendTheoretical' });
    const y = c.yieldCheckpoints.find((k) => k.id === 'Y-GRAN');
    expect([y?.name, y?.result, y?.theoretical]).toEqual(['Granule yield (dried)', 'blendYield', 'blendTheoretical']);
    let computes: string[] = [];
    flow.walk(c.procedure.body, (n) => {
      if (n.kind === 'phase' && n.id === 'p-gran-yield') computes = n.computes;
    });
    expect(computes).toEqual(['blendYield']);
    expect(() => applyOp(base(), { kind: 'UPDATE_YIELD', id: 'Y-GRAN', result: 'blendNet' })).toThrow(/decimal calculation of the master/);
    expect(() => applyOp(base(), { kind: 'UPDATE_YIELD', id: 'Y-GRAN', theoretical: 'nothing' })).toThrow(/calculation, parameter or input/);
  });

  it('[PR-08][PR-31] a limit range records its source, the document pinned; a range is added only where the item has none of that tier; undo restores', () => {
    const c = applyOp(base(), { kind: 'SET_LIMIT_SOURCE', owner: 'yield', id: 'Y-BLEND', tier: 'VALIDATED', kindOfSource: 'VALIDATION_REPORT', reference: VR });
    expect(c.yieldCheckpoints.find((k) => k.id === 'Y-BLEND')?.limits?.ranges.find((r) => r.tier === 'VALIDATED')?.source).toEqual({ kind: 'VALIDATION_REPORT', ref: 'VR-BLEND-2' });
    expect(c.references.filter((r) => r.id === 'VR-BLEND-2')).toEqual([VR]);
    expect(() => applyOp(base(), { kind: 'SET_LIMIT_SOURCE', owner: 'yield', id: 'Y-BLEND', tier: 'ALERT', kindOfSource: 'VALIDATION_REPORT', reference: VR })).toThrow(/has no alert range/);
    const added = applyOp(base(), { kind: 'ADD_LIMIT_RANGE', owner: 'calculation', id: 'meanWeight', tier: 'VALIDATED', unit: 'mg', kindOfSource: 'VALIDATION_REPORT', reference: VR });
    expect(added.calculations.find((k) => k.id === 'meanWeight')?.limits).toEqual({ unit: 'mg', ranges: [{ tier: 'VALIDATED', rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'VALIDATION_REPORT', ref: 'VR-BLEND-2' } }] });
    expect(() => applyOp(base(), { kind: 'ADD_LIMIT_RANGE', owner: 'yield', id: 'Y-BLEND', tier: 'VALIDATED', unit: '%', kindOfSource: 'VALIDATION_REPORT', reference: VR })).toThrow(/already has a validated range/);
    const h = perform(initHistory(base()), { kind: 'UPDATE_CALCULATION', id: 'blendYield', name: 'Renamed' });
    expect(canonical(undo(h).present)).toBe(canonical(base()));
  });
});
