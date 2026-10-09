/**
 * Unit conversion properties (brief A1 tests: "unit conversion round-trips exact").
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Dec } from '../src/decimal/dec.ts';
import { rAbs, rational, rCmp, rDiv, rMul, rSub, terminatingDecimal, toRational } from '../src/decimal/exact.ts';
import { compareValues, convertValue, toBaseRational } from '../src/units/quantity.ts';
import { UNIT_TABLE } from '../src/units/unit-table.generated.ts';
import { parseUnit } from '../src/units/unit.ts';
import { decimalText } from './support/arbitraries.ts';

const value = decimalText(15, 6).map((t) => Dec.parse(t));
const linearKinds = Object.entries(UNIT_TABLE.quantityKinds).filter(([, k]) => k.scale === 'LINEAR' && k.units.length > 1);
/** Unit pairs whose conversion factor terminates in both directions (e.g. kg/mg, bar/kPa, h/s). */
const exactPairs = linearKinds.flatMap(([, k]) =>
  k.units.flatMap((a) =>
    k.units
      .filter((b) => {
        const f = rDiv(parseUnit(a.code).factor, parseUnit(b.code).factor);
        return terminatingDecimal(f) !== undefined && terminatingDecimal(rDiv(rational(1n), f)) !== undefined;
      })
      .map((b) => [a.code, b.code] as const),
  ),
);
const pair = fc.constantFrom(...exactPairs);
const anyPair = fc.constantFrom(...linearKinds).chain(([, k]) => fc.tuple(fc.constantFrom(...k.units.map((u) => u.code)), fc.constantFrom(...k.units.map((u) => u.code))));

describe('unit conversion properties', () => {
  it('[DI-33] round trips between units whose factors terminate both ways return exactly the original value', () => {
    fc.assert(
      fc.property(value, pair, (v, [a, b]) => {
        const there = convertValue(v, parseUnit(a), parseUnit(b));
        const back = convertValue(there.value, parseUnit(b), parseUnit(a));
        expect(back.value.eq(v)).toBe(true);
        expect(there.conversion?.exact ?? true).toBe(true);
      }),
      { numRuns: 400 },
    );
  });

  it('[DI-33] every conversion is the exact value correctly rounded once, and preserves the quantity exactly when marked exact', () => {
    fc.assert(
      fc.property(value, anyPair, (v, [a, b]) => {
        const ua = parseUnit(a);
        const ub = parseUnit(b);
        const r = convertValue(v, ua, ub);
        const exactTarget = rDiv(toBaseRational(v, ua), ub.factor);
        const err = rAbs(rSub(toRational(r.value), exactTarget));
        if (r.conversion === null || r.conversion.exact) {
          expect(err.num).toBe(0n);
          expect(compareValues(v, ua, r.value, ub)).toBe(0);
        } else {
          // Rounded once: the error is below one unit in the 34th digit.
          const ulpExp = r.value.exponent() - 33;
          const ulp = ulpExp >= 0 ? rational(10n ** BigInt(ulpExp)) : rational(1n, 10n ** BigInt(-ulpExp));
          expect(rCmp(rMul(err, rational(2n)), ulp) <= 0).toBe(true);
        }
      }),
      { numRuns: 400 },
    );
  });

  it('[DI-33] absolute temperatures round-trip exactly between Cel and [degF] for values of up to 2 decimals', () => {
    const t = fc.integer({ min: -100_00, max: 400_00 }).map((n) => Dec.parse(`${String(n)}e-2`));
    fc.assert(
      fc.property(t, (c) => {
        const f = convertValue(c, parseUnit('Cel'), parseUnit('[degF]'));
        expect(f.conversion?.exact).toBe(true);
        expect(convertValue(f.value, parseUnit('[degF]'), parseUnit('Cel')).value.eq(c)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('conversion is monotone (never changes the order of two values)', () => {
    fc.assert(
      fc.property(value, value, anyPair, (x, y, [a, b]) => {
        const cx = convertValue(x, parseUnit(a), parseUnit(b)).value;
        const cy = convertValue(y, parseUnit(a), parseUnit(b)).value;
        if (x.lte(y)) expect(cx.lte(cy)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});
