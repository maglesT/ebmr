/**
 * Slice 7u (R10 #14, #15; owner demo of 25 October 2026): "1000 {tbl}" on the planning card, printed lots shown as
 * "20000 1", and "EXECUTION_COMPLETE; 7 usable containers". Units and states as people read them; display only.
 */
import { describe, expect, it } from 'vitest';
import { quantityText, stateWords, unitText } from '../../src/floor/format.ts';
import { valueText } from '../../src/floor/AttemptList.tsx';

describe('units and states in plain words (R10 #14, #15)', () => {
  it('[IN-24][PR-57] a count annotation reads as tablets, labels or units; a unit of measure stays', () => {
    expect(quantityText('1000', '{tbl}')).toBe('1000 tablets');
    expect(quantityText('20000', '1')).toBe('20000 units');
    expect(quantityText('500', '{lbl}')).toBe('500 labels');
    expect(quantityText('12.500', 'kg')).toBe('12.500 kg');
    expect(unitText('{blister}')).toBe('blister');
    expect(unitText(null)).toBe('');
    expect(valueText({ kind: 'DECIMAL', value: '1000', unit: '{tbl}' }, '')).toBe('1000 tablets');
    expect(valueText({ kind: 'DECIMAL', value: '0.5', unit: '1' }, '')).toBe('0.5 1');
  });

  it('[PR-52] a state code reads as words', () => {
    expect(stateWords('EXECUTION_COMPLETE')).toBe('execution complete');
    expect(stateWords('QA_REVIEWED')).toBe('QA reviewed');
  });
});
