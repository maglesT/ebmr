/** Shared fast-check arbitraries for the expr tests. */
import fc from 'fast-check';

/** Decimal text with up to `digits` significant digits and an exponent within +-maxExp. */
export function decimalText(digits = 20, maxExp = 12): fc.Arbitrary<string> {
  return fc
    .tuple(fc.boolean(), fc.bigInt({ min: 0n, max: 10n ** BigInt(digits) - 1n }), fc.integer({ min: -maxExp, max: maxExp }))
    .map(([neg, c, e]) => {
      const s = `${c.toString()}e${String(e)}`;
      return neg && c !== 0n ? `-${s}` : s;
    });
}

/** Plain positive decimal text (no exponent), e.g. "12.345". */
export function plainPositive(intDigits = 4, fracDigits = 4): fc.Arbitrary<string> {
  return fc
    .tuple(fc.integer({ min: 1, max: 10 ** intDigits - 1 }), fc.integer({ min: 0, max: fracDigits }), fc.integer({ min: 0, max: 10 ** fracDigits - 1 }))
    .map(([i, d, f]) => (d === 0 ? String(i) : `${String(i)}.${String(f).padStart(fracDigits, '0').slice(0, d)}`));
}
