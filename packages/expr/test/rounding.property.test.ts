/**
 * Rounding properties (brief A1 tests: "rounding monotonicity and the half-up boundary").
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Dec } from '../src/decimal/dec.ts';
import { boundaryValuesForBound } from '../src/evidence/vectors.ts';
import { compareToLimit, roundForComparison, ROUNDING_RULE_SETS, type LimitBound } from '../src/rounding/rounding.ts';
import { decimalText, plainPositive } from './support/arbitraries.ts';

const value = decimalText(12, 4).map((t) => Dec.parse(t));
const bound = fc.tuple(plainPositive(3, 3), fc.boolean(), fc.boolean()).map(([v, neg, inclusive]): LimitBound => ({ value: neg ? `-${v}` : v, inclusive }));
const ruleSet = fc.constantFrom(...ROUNDING_RULE_SETS);

describe('rounding properties', () => {
  it('[DI-33] rounding for comparison is monotone: x <= y implies rounded(x) <= rounded(y)', () => {
    fc.assert(
      fc.property(value, value, bound, ruleSet, (x, y, b, rs) => {
        const [lo, hi] = x.lte(y) ? [x, y] : [y, x];
        expect(roundForComparison(lo, b, rs).rounded.lte(roundForComparison(hi, b, rs).rounded)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('[DI-33] a lower limit passes an up-closed set and an upper limit a down-closed set', () => {
    fc.assert(
      fc.property(value, value, bound, ruleSet, (x, y, b, rs) => {
        const [lo, hi] = x.lte(y) ? [x, y] : [y, x];
        if (compareToLimit(lo, { low: b }, rs).outcome === 'PASS') expect(compareToLimit(hi, { low: b }, rs).outcome).toBe('PASS');
        if (compareToLimit(hi, { high: b }, rs).outcome === 'PASS') expect(compareToLimit(lo, { high: b }, rs).outcome).toBe('PASS');
      }),
      { numRuns: 500 },
    );
  });

  it('[DI-33] USP half-up boundary: L - 0.5 unit passes a lower limit L, anything below it fails', () => {
    fc.assert(
      fc.property(plainPositive(3, 3), fc.integer({ min: 1, max: 20 }), (l, k) => {
        const d = l.includes('.') ? l.length - l.indexOf('.') - 1 : 0;
        const half = Dec.parse(`5e-${String(d + 1)}`);
        const threshold = Dec.parse(l).minus(half);
        const below = threshold.minus(Dec.parse(`1e-${String(d + k)}`));
        expect(compareToLimit(threshold, { low: { value: l } }, 'USP_HALF_UP_AT_LIMIT_DECIMALS').outcome).toBe('PASS');
        expect(compareToLimit(below, { low: { value: l } }, 'USP_HALF_UP_AT_LIMIT_DECIMALS').outcome).toBe('FAIL');
        // and symmetrically for an upper limit
        const top = Dec.parse(l).plus(half);
        expect(compareToLimit(top, { high: { value: l } }, 'USP_HALF_UP_AT_LIMIT_DECIMALS').outcome).toBe('FAIL');
        expect(compareToLimit(top.minus(Dec.parse(`1e-${String(d + k)}`)), { high: { value: l } }, 'USP_HALF_UP_AT_LIMIT_DECIMALS').outcome).toBe('PASS');
      }),
      { numRuns: 500 },
    );
  });

  it('[DI-33] the full-precision value is always kept in the comparison result', () => {
    fc.assert(
      fc.property(value, bound, ruleSet, (x, b, rs) => {
        expect(compareToLimit(x, { low: b }, rs).value).toBe(x.toString());
      }),
      { numRuns: 300 },
    );
  });

  it('[DI-33] generated boundary values sit one digit apart across the rounding threshold with the expected outcomes', () => {
    fc.assert(
      fc.property(bound, fc.constantFrom('LOW' as const, 'HIGH' as const), ruleSet, (b, side, rs) => {
        const values = boundaryValuesForBound(b, side, rs);
        const inside = values.find((v) => v.label === 'JUST_INSIDE');
        const outside = values.find((v) => v.label === 'JUST_OUTSIDE');
        expect(inside).toBeDefined();
        expect(outside).toBeDefined();
        if (inside === undefined || outside === undefined) return;
        const limit = side === 'LOW' ? { low: b } : { high: b };
        expect(compareToLimit(inside.value, limit, rs).outcome).toBe('PASS');
        expect(compareToLimit(outside.value, limit, rs).outcome).toBe('FAIL');
        // They are adjacent: at most one tenth of the rounding unit apart.
        const gap = Dec.parse(inside.value).minus(Dec.parse(outside.value)).abs();
        expect(gap.isPositive()).toBe(true);
        const r = roundForComparison(Dec.parse(inside.value), b, rs);
        const unitExp = 'decimals' in r.precision ? -r.precision.decimals : r.rounded.exponent() - r.precision.significantFigures + 1;
        expect(gap.lte(Dec.parse(`1e${String(unitExp - 1)}`))).toBe(true);
      }),
      { numRuns: 400 },
    );
  });
});
