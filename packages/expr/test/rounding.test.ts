/**
 * Rounding only at comparison and display (brief A1 item 5; ADR 0005 decision 4; outline 6.4;
 * L-37 ALL_APPLY). Full precision is always kept.
 */
import { describe, expect, it } from 'vitest';
import { Dec } from '../src/decimal/dec.ts';
import { compareAllApply, compareToBound, compareToLimit, formatForDisplay, LimitError, roundToIncrement, writtenSignificantFigures, type Limit } from '../src/rounding/rounding.ts';

const ASSAY: Limit = { low: { value: '95.0' }, high: { value: '105.0' } };
const USP = 'USP_HALF_UP_AT_LIMIT_DECIMALS' as const;
const EP = 'PH_EUR_SIG_FIGS' as const;

describe('USP: half up at the decimals of the limit', () => {
  it('[DI-33] raw 94.95 against 95.0-105.0 rounds to 95.0 and passes; 94.94 fails; full precision is kept', () => {
    const pass = compareToLimit('94.95', ASSAY, USP);
    expect(pass).toMatchObject({ outcome: 'PASS', value: '94.95', rounded: '95.0', breached: null });
    expect(pass.explanation).toBe('94.95 rounded to 1 decimal place (USP) is 95.0; limit 95.0-105.0: pass');
    const fail = compareToLimit('94.94', ASSAY, USP);
    expect(fail).toMatchObject({ outcome: 'FAIL', value: '94.94', rounded: '94.9', breached: 'LOW' });
    expect(fail.explanation).toMatch(/fail \(below the lower limit\)/);
    expect(compareToLimit('105.04', ASSAY, USP)).toMatchObject({ outcome: 'PASS', rounded: '105.0' });
    expect(compareToLimit('105.05', ASSAY, USP)).toMatchObject({ outcome: 'FAIL', rounded: '105.1', breached: 'HIGH' });
  });

  it('[DI-33] the decimals come from the limit as written ("95" is not "95.0"); the finer bound wins', () => {
    expect(compareToLimit('94.5', { low: { value: '95' } }, USP)).toMatchObject({ outcome: 'PASS', rounded: '95' });
    expect(compareToLimit('94.49', { low: { value: '95' } }, USP)).toMatchObject({ outcome: 'FAIL', rounded: '94' });
    expect(compareToLimit('94.5', { low: { value: '95' }, high: { value: '105.0' } }, USP)).toMatchObject({ outcome: 'FAIL', rounded: '94.5' });
  });

  it('[DI-33] strict bounds compare the rounded value strictly', () => {
    const lt: Limit = { high: { value: '0.5', inclusive: false } };
    expect(compareToLimit('0.44', lt, USP)).toMatchObject({ outcome: 'PASS', rounded: '0.4' });
    expect(compareToLimit('0.45', lt, USP)).toMatchObject({ outcome: 'FAIL', rounded: '0.5' });
    expect(compareToLimit('0.5', { high: { value: '0.5' } }, USP).outcome).toBe('PASS');
    expect(compareToLimit('0.5', { low: { value: '0.5', inclusive: false } }, USP).outcome).toBe('FAIL');
  });

  it('rounds a half away from zero for negative values', () => {
    const l: Limit = { low: { value: '-2.0' } };
    expect(compareToLimit('-2.05', l, USP)).toMatchObject({ outcome: 'FAIL', rounded: '-2.1' });
    expect(compareToLimit('-2.04', l, USP)).toMatchObject({ outcome: 'PASS', rounded: '-2.0' });
  });
});

describe('Ph. Eur.: half up at the significant figures of the limit', () => {
  it('[DI-33] 94.95 against 95.0 (3 figures) rounds to 95.0 and passes; 94.94 fails', () => {
    expect(compareToLimit('94.95', ASSAY, EP)).toMatchObject({ outcome: 'PASS', rounded: '95.0' });
    expect(compareToLimit('94.94', ASSAY, EP)).toMatchObject({ outcome: 'FAIL', rounded: '94.9' });
  });

  it('[DI-33] every digit shown counts ("140" has three figures) and each bound uses its own figures', () => {
    expect(writtenSignificantFigures('140')).toBe(3);
    expect(writtenSignificantFigures('0.10')).toBe(2);
    expect(compareToLimit('140.4', { high: { value: '140' } }, EP)).toMatchObject({ outcome: 'PASS', rounded: '140' });
    expect(compareToLimit('140.5', { high: { value: '140' } }, EP)).toMatchObject({ outcome: 'FAIL', rounded: '141' });
    // 105.0 has four figures: 105.04 rounds to 105.0 against the upper bound.
    const c = compareToLimit('105.04', ASSAY, EP);
    expect(c.outcome).toBe('PASS');
    expect(c.checks.map((k) => [k.side, k.rounded])).toEqual([
      ['LOW', '105'],
      ['HIGH', '105.0'],
    ]);
    expect(c.rounded).toBe('105.0');
  });

  it('[DI-33] across a power of ten: 99.95 against NLT 100 rounds to 100 and passes, 99.94 to 99.9 and fails', () => {
    expect(compareToLimit('99.95', { low: { value: '100' } }, EP)).toMatchObject({ outcome: 'PASS', rounded: '100' });
    expect(compareToLimit('99.94', { low: { value: '100' } }, EP)).toMatchObject({ outcome: 'FAIL', rounded: '99.9' });
  });

  it('[DI-33] the two rule sets differ at a decade: 0.96 against NLT 1.0 passes under USP and fails under Ph. Eur.', () => {
    const l: Limit = { low: { value: '1.0' } };
    expect(compareToLimit('0.96', l, USP)).toMatchObject({ outcome: 'PASS', rounded: '1.0' });
    expect(compareToLimit('0.96', l, EP)).toMatchObject({ outcome: 'FAIL', rounded: '0.96' });
  });

  it('a zero limit has no significant figures: its decimal places are used', () => {
    expect(compareToLimit('0.04', { high: { value: '0.0' } }, EP)).toMatchObject({ outcome: 'PASS', rounded: '0.0' });
    expect(compareToLimit('0.05', { high: { value: '0.0' } }, EP)).toMatchObject({ outcome: 'FAIL', rounded: '0.1' });
  });
});

describe('ALL_APPLY and units', () => {
  it('[DI-33] ALL_APPLY: each criterion uses its own rounding; all must pass (L-37)', () => {
    const r = compareAllApply('0.96', [
      { id: 'USP', limit: { low: { value: '1.0' } }, ruleSet: USP },
      { id: 'EP', limit: { low: { value: '1.0' } }, ruleSet: EP },
    ]);
    expect(r.outcome).toBe('FAIL');
    expect(r.results.map((x) => [x.id, x.comparison.outcome, x.comparison.rounded])).toEqual([
      ['USP', 'PASS', '1.0'],
      ['EP', 'FAIL', '0.96'],
    ]);
    expect(compareAllApply('1.0', [{ id: 'a', limit: { low: { value: '1.0' } }, ruleSet: USP }]).outcome).toBe('PASS');
    expect(() => compareAllApply('1', [])).toThrow(LimitError);
  });

  it('[DI-33] a value with a unit is converted exactly into the limit unit before rounding', () => {
    const r = compareToLimit({ value: '94950', unit: 'ug' }, { low: { value: '95.0' }, unit: 'mg' }, USP);
    expect(r).toMatchObject({ outcome: 'PASS', value: '94.95', rounded: '95.0', unit: 'mg' });
    expect(r.conversion).toMatchObject({ from: 'ug', to: 'mg', factor: '0.001', exact: true });
    expect(() => compareToLimit({ value: '1', unit: 'mg' }, { low: { value: '1' } }, USP)).toThrow(LimitError);
  });

  it('refuses malformed limits', () => {
    expect(() => compareToLimit('1', { low: { value: '1e2' } }, USP)).toThrow(LimitError);
    expect(() => compareToLimit('1', { low: { value: '5' }, high: { value: '4' } }, USP)).toThrow(/above the upper/);
    expect(() => compareToLimit('1', {}, USP)).toThrow(LimitError);
    expect(() => compareToLimit('1', { low: { value: '1' } }, 'ROUND_ANYHOW' as typeof USP)).toThrow(/Unknown rounding rule set/);
  });

  it('compares one bound on its own (used by the limit-tier model)', () => {
    expect(compareToBound(Dec.parse('94.94'), { value: '95' }, 'LOW', USP, { value: '105.0' })).toMatchObject({ pass: false, rounded: '94.9', precision: { decimals: 1 } });
    expect(compareToBound(Dec.parse('94.94'), { value: '95' }, 'LOW', USP)).toMatchObject({ pass: true, rounded: '95', precision: { decimals: 0 } });
  });
});

describe('display and target rounding', () => {
  it('[DI-33] formats for display without locale or grouping; the stored value is unchanged', () => {
    expect(formatForDisplay('1234567.891', { decimals: 1 })).toBe('1234567.9');
    expect(formatForDisplay('98.2421875', { decimals: 2 })).toBe('98.24');
    expect(formatForDisplay('0.644963144963144963144963144963145', { decimals: 1 })).toBe('0.6');
    expect(formatForDisplay('99.95', { significantFigures: 3 })).toBe('100');
    expect(formatForDisplay('0.001234', { significantFigures: 2 })).toBe('0.0012');
  });

  it('[DI-33] rounds a dispensing target to the balance readability: UP for an active so it never falls below the calculation', () => {
    expect(roundToIncrement('8.741485531610301190262750678712619', '0.001', 'CEILING').toString()).toBe('8.742');
    expect(roundToIncrement('8.741485531610301190262750678712619', '0.001', 'FLOOR').toString()).toBe('8.741');
    expect(roundToIncrement('0.4688233520313236734361718444007150', '0.001', 'HALF_UP').toString()).toBe('0.469');
    expect(roundToIncrement('2.5', '1', 'HALF_UP').toString()).toBe('3');
    expect(roundToIncrement('-2.5', '1', 'HALF_UP').toString()).toBe('-3');
    expect(roundToIncrement('1.0125', '0.005', 'HALF_UP').toString()).toBe('1.015');
    expect(roundToIncrement('8.742', '0.001', 'CEILING').toString()).toBe('8.742');
    expect(() => roundToIncrement('1', '0', 'CEILING')).toThrow();
  });
});
