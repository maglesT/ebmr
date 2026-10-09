import { Dec } from '@ebmr/expr';
import { market } from '@ebmr/kernel';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addDecimal,
  canonicalDecimal,
  compareDecimal,
  decimalsOf,
  durationToMicros,
  formatMicros,
  isDecimalLiteral,
  midpointDecimal,
  subtractDecimal,
} from '../../src/flow/decimal.ts';

/** Decimal literals as authors write them: optional sign, up to 12 integer digits, up to 8 decimals (trailing zeros allowed). */
const literal = fc
  .tuple(fc.boolean(), fc.bigInt({ min: 0n, max: 999_999_999_999n }), fc.option(fc.stringMatching(/^[0-9]{1,8}$/), { nil: undefined }))
  .map(([neg, whole, frac]) => `${neg ? '-' : ''}${whole.toString()}${frac === undefined ? '' : `.${frac}`}`)
  .filter(isDecimalLiteral);

describe('exact decimal literals for the static analyses', () => {
  it('orders decimals exactly as the expression language does (never through a JavaScript number)', () => {
    fc.assert(
      fc.property(literal, literal, (a, b) => {
        const c = Dec.parse(a).cmp(Dec.parse(b));
        return compareDecimal(a, b) === (c < 0 ? -1 : c > 0 ? 1 : 0);
      }),
      { numRuns: 500 },
    );
  });

  it('agrees with the kernel market engine on canonical decimals', () => {
    fc.assert(
      fc.property(literal, literal, (a, b) => compareDecimal(a, b) === market.compareDecimal(canonicalDecimal(a), canonicalDecimal(b))),
      { numRuns: 300 },
    );
  });

  it('adds and subtracts exactly (checked against the expression language)', () => {
    fc.assert(
      fc.property(literal, literal, (a, b) => {
        const sum = Dec.parse(a).plus(Dec.parse(b));
        const diff = Dec.parse(a).minus(Dec.parse(b));
        return Dec.parse(addDecimal(a, b)).cmp(sum) === 0 && Dec.parse(subtractDecimal(a, b)).cmp(diff) === 0;
      }),
      { numRuns: 300 },
    );
  });

  it('the midpoint lies strictly between two different decimals', () => {
    fc.assert(
      fc.property(literal, literal, (a, b) => {
        fc.pre(compareDecimal(a, b) !== 0);
        const [lo, hi] = compareDecimal(a, b) < 0 ? [a, b] : [b, a];
        const m = midpointDecimal(lo, hi);
        return compareDecimal(lo, m) < 0 && compareDecimal(m, hi) < 0;
      }),
      { numRuns: 300 },
    );
  });

  it('keeps the decimals an author wrote: "95.0" has one decimal, "105" none', () => {
    expect(decimalsOf('95.0')).toBe(1);
    expect(decimalsOf('105')).toBe(0);
    expect(canonicalDecimal('95.0')).toBe('95');
    expect(isDecimalLiteral('-0')).toBe(false);
    expect(isDecimalLiteral('1e3')).toBe(false);
    expect(isDecimalLiteral('01')).toBe(false);
  });

  it('[INV-20] converts durations to exact microseconds and refuses what cannot be enforced', () => {
    expect(durationToMicros('2.5', 'min')).toBe(150_000_000n);
    expect(durationToMicros('72', 'h')).toBe(259_200_000_000n);
    expect(durationToMicros('0.0000001', 's')).toBeUndefined();
    expect(durationToMicros('5', 'kg')).toBeUndefined();
    expect(formatMicros(259_200_000_000n)).toBe('3 d');
    expect(formatMicros(150_000_000n)).toBe('150 s');
  });
});
