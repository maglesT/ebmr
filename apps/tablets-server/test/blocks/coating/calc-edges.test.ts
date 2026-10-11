/**
 * The coating calculations and the AQL table at their edges: decimal reading, rounding with a negative divisor, an
 * empty sum, the mass units refused, and the AQL plan lookup at the table's first column and for an unknown letter.
 * Written for the Phase 3 exit mutation run (decision 0009).
 */
import { describe, expect, it } from 'vitest';
import { roundHalfAway, scaled, sumText, toMg } from '../../../src/blocks/coating/calc.ts';
import { planOf } from '../../../src/blocks/coating/aql.ts';

describe('coating calculations at their edges', () => {
  it('[PR-29][DI-29] decimal text reads exactly, signed or not; anything else is refused', () => {
    expect(scaled('-1.50')).toEqual({ n: -150n, s: 2 });
    expect(scaled('12')).toEqual({ n: 12n, s: 0 });
    for (const bad of ['1e3', 'abc', '1.', '.5', '']) expect(() => scaled(bad), bad).toThrow(`not a decimal: ${bad}`);
  });

  it('[IN-37][PR-29] rounding half away from zero takes the sign of the quotient, whichever side is negative; a zero divisor is refused', () => {
    expect(roundHalfAway(-3n, 2n)).toBe(-2n);
    expect(roundHalfAway(3n, -2n)).toBe(-2n);
    expect(roundHalfAway(-3n, -2n)).toBe(2n);
    expect(roundHalfAway(-5n, -4n)).toBe(1n);
    expect(roundHalfAway(1n, -4n)).toBe(0n);
    expect(() => roundHalfAway(1n, 0n)).toThrow('division by zero');
  });

  it('[PR-29][DI-29] an empty sum is zero; a tablet mass is in mg or g only', () => {
    expect(sumText([])).toBe('0');
    expect(toMg('1.5', 'g')).toBe('1500');
    expect(() => toMg('1', 'kg')).toThrow('not a tablet mass unit: kg');
    expect(() => toMg('1', 'mcg')).toThrow('not a tablet mass unit: mcg');
  });

  it('[PR-29][DI-10] an AQL plan exists only for a letter of the table; the first column (0.010) is a column of it', () => {
    expect(planOf('NORMAL', 'Z', '1.0')).toBeUndefined();
    expect(planOf('NORMAL', 'I', '1.0')).toBeUndefined();
    expect(planOf('NORMAL', 'A', '0.010')).toEqual({ letter: 'Q', n: 1250n, ac: 0n, re: 1n });
    expect(planOf('TIGHTENED', 'R', '0.010')).toEqual({ letter: 'R', n: 2000n, ac: 0n, re: 1n });
  });
});
