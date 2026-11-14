/**
 * Demo report r13 bug 3: calculations could be edited but their golden test cases could not, so a changed formula left
 * a case that could never pass (G-BLEND-YIELD: "inputs missing") and the version could never be verified. SET_GOLDEN_VALUE
 * changes, adds or removes a decimal value of a case in a DRAFT; each refusal leaves the content as it was; undo
 * restores it. The server saves it as a new revision with its change note, which voids the earlier evidence, and
 * verification runs every case again (DI-04).
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
const caseOf = (c: Content, id: string) => c.goldenCases.find((g) => g.id === id);

describe('golden test cases follow the calculations they test (demo report r13, bug 3)', () => {
  it('[DI-04] a decimal value is changed, an input added and an entry removed; only the case named changes, and the result parses', () => {
    let c = applyOp(base(), { kind: 'SET_GOLDEN_VALUE', caseId: 'G-GRAN-YIELD', side: 'expected', key: 'granYield', text: ' 98.10 % ' });
    expect(caseOf(c, 'G-GRAN-YIELD')?.expected).toEqual({ granYield: { value: '98.10', unit: '%' } });
    c = applyOp(c, { kind: 'SET_GOLDEN_VALUE', caseId: 'G-GRAN-YIELD', side: 'inputs', key: 'batchSizeTablets', text: '200000' });
    expect(caseOf(c, 'G-GRAN-YIELD')?.inputs['batchSizeTablets']).toEqual({ value: '200000' });
    c = applyOp(c, { kind: 'SET_GOLDEN_VALUE', caseId: 'G-GRAN-YIELD', side: 'inputs', key: 'kitCharged', text: null });
    expect(Object.keys(caseOf(c, 'G-GRAN-YIELD')?.inputs ?? {})).toEqual(['driedNet', 'batchSizeTablets']);
    // The other cases are unchanged.
    const before = base();
    expect(c.goldenCases.filter((g) => g.id !== 'G-GRAN-YIELD')).toEqual(before.goldenCases.filter((g) => g.id !== 'G-GRAN-YIELD'));
    expect(flow.parseMbr(JSON.parse(JSON.stringify(c))).ok).toBe(true);
  });

  it('[DI-04] refused: an unknown case or item, a value that is not a number, a series value, the last expected result; the content stays as it was', () => {
    const c = base();
    const same = JSON.stringify(c);
    expect(() => applyOp(c, { kind: 'SET_GOLDEN_VALUE', caseId: 'G-NONE', side: 'inputs', key: 'driedNet', text: '1 kg' })).toThrow(OpError);
    expect(() => applyOp(c, { kind: 'SET_GOLDEN_VALUE', caseId: 'G-GRAN-YIELD', side: 'inputs', key: 'nothing', text: '1 kg' })).toThrow(/not a calculation, parameter or input/);
    expect(() => applyOp(c, { kind: 'SET_GOLDEN_VALUE', caseId: 'G-GRAN-YIELD', side: 'inputs', key: 'driedNet', text: 'about 25 kg' })).toThrow(/as a number with its unit/);
    expect(() => applyOp(c, { kind: 'SET_GOLDEN_VALUE', caseId: 'G-GRAN-YIELD', side: 'inputs', key: 'driedNet', text: '  ' })).toThrow(/cannot be empty/);
    expect(() => applyOp(c, { kind: 'SET_GOLDEN_VALUE', caseId: 'G-BLEND', side: 'inputs', key: 'driedNet', text: '25 kg' })).toThrow(/not a decimal value/);
    expect(() => applyOp(c, { kind: 'SET_GOLDEN_VALUE', caseId: 'G-GRAN-YIELD', side: 'expected', key: 'granYield', text: null })).toThrow(/at least one expected result/);
    expect(() => applyOp(c, { kind: 'SET_GOLDEN_VALUE', caseId: 'G-GRAN-YIELD', side: 'inputs', key: 'mwBase', text: null })).toThrow(/has no input/);
    expect(JSON.stringify(c)).toBe(same);
  });

  it('[DI-04] undo restores the case', () => {
    const h = perform(initHistory(base()), { kind: 'SET_GOLDEN_VALUE', caseId: 'G-GRAN-YIELD', side: 'inputs', key: 'driedNet', text: '25.20 kg' });
    expect(caseOf(h.present, 'G-GRAN-YIELD')?.inputs['driedNet']).toEqual({ value: '25.20', unit: 'kg' });
    expect(caseOf(undo(h).present, 'G-GRAN-YIELD')).toEqual(caseOf(base(), 'G-GRAN-YIELD'));
  });
});
