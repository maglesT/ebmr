/**
 * Properties of the decimal core (outline 9.1; ADR 0005: "property-based tests can compare the
 * evaluator with an exact-rational reference").
 *
 * The reference is a characterisation, not a second implementation: a 34-digit result r of an exact
 * rational x is correct when |r - x| <= half a unit in the last place, ties going to the even digit.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Dec } from '../src/decimal/dec.ts';
import { exactSum, fromRational, rAbs, rAdd, rational, rCmp, rDiv, rMul, rSub, sqrtRational, toRational, type Rational } from '../src/decimal/exact.ts';
import { decimalText } from './support/arbitraries.ts';

function ulp(r: Dec): Rational {
  // One unit in the 34th significant digit of r.
  const e = r.exponent() - 33;
  return e >= 0 ? rational(10n ** BigInt(e)) : rational(1n, 10n ** BigInt(-e));
}

function correctlyRounded(r: Dec, x: Rational): boolean {
  const err = rAbs(rSub(toRational(r), x));
  const half = rDiv(ulp(r), rational(2n));
  const c = rCmp(err, half);
  if (c < 0) return true;
  if (c > 0) return false;
  const { coefficient } = r.toScaled();
  // A tie must end in an even 34th digit.
  const digits = (coefficient < 0n ? -coefficient : coefficient).toString().padEnd(34, '0');
  return Number(digits[33]) % 2 === 0;
}

const dec = decimalText().map((t) => Dec.parse(t));
const nonZero = dec.filter((d) => !d.isZero());

describe('decimal core properties', () => {
  it('[DI-33] parse and print round-trip exactly', () => {
    fc.assert(
      fc.property(dec, (d) => {
        expect(Dec.parse(d.toString()).eq(d)).toBe(true);
        expect(Dec.parse(d.toString()).toString()).toBe(d.toString());
      }),
      { numRuns: 300 },
    );
  });

  it('[DI-33] + - * / are the exact result correctly rounded to 34 significant digits', () => {
    fc.assert(
      fc.property(dec, nonZero, (a, b) => {
        const ra = toRational(a);
        const rb = toRational(b);
        expect(correctlyRounded(a.plus(b), rAdd(ra, rb))).toBe(true);
        expect(correctlyRounded(a.minus(b), rSub(ra, rb))).toBe(true);
        expect(correctlyRounded(a.times(b), rMul(ra, rb))).toBe(true);
        expect(correctlyRounded(a.div(b), rDiv(ra, rb))).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('fromRational is correctly rounded and exact exactly when the rational terminates within 34 digits', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 40n), max: 10n ** 40n }), fc.bigInt({ min: 1n, max: 10n ** 20n }), (n, d) => {
        const x = rational(n, d);
        const r = fromRational(x);
        expect(correctlyRounded(r.value, x)).toBe(true);
        expect(r.exact).toBe(rCmp(toRational(r.value), x) === 0);
      }),
      { numRuns: 300 },
    );
  });

  it('square roots of exact rationals are correctly rounded', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 30n }), fc.bigInt({ min: 1n, max: 10n ** 12n }), (n, d) => {
        const x = rational(n, d);
        const { value: q } = sqrtRational(x);
        if (n === 0n) {
          expect(q.isZero()).toBe(true);
          return;
        }
        // (q - ulp/2)^2 <= x <= (q + ulp/2)^2
        const h = rDiv(ulp(q), rational(2n));
        const lo = rSub(toRational(q), h);
        const hi = rAdd(toRational(q), h);
        expect(rCmp(rMul(lo, lo), x) <= 0).toBe(true);
        expect(rCmp(x, rMul(hi, hi)) <= 0).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('[DI-33] addition is commutative always, and associative whenever the sums are exact', () => {
    const short = decimalText(12, 6).map((t) => Dec.parse(t));
    fc.assert(
      fc.property(short, short, short, (a, b, c) => {
        expect(a.plus(b).eq(b.plus(a))).toBe(true);
        expect(a.times(b).eq(b.times(a))).toBe(true);
        // 12-digit values within 1e-6..1e18 add exactly within 34 digits.
        expect(a.plus(b).plus(c).eq(a.plus(b.plus(c)))).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('[DI-33] exact sums do not depend on the order of the values', () => {
    fc.assert(
      fc.property(fc.array(dec, { minLength: 1, maxLength: 30 }), fc.integer(), (values, seed) => {
        const shuffled = [...values].sort((x, y) => ((x.toString().length * 31 + seed) % 7) - ((y.toString().length * 17 + seed) % 5));
        expect(rCmp(exactSum(values), exactSum(shuffled))).toBe(0);
        expect(fromRational(exactSum(values)).value.eq(fromRational(exactSum(shuffled)).value)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('ordering agrees with the exact rationals', () => {
    fc.assert(
      fc.property(dec, dec, (a, b) => {
        expect(a.cmp(b)).toBe(rCmp(toRational(a), toRational(b)));
      }),
      { numRuns: 300 },
    );
  });
});
