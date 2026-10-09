/**
 * Decimal core (brief A1 item 1; ADR 0005 decision 1): 34 significant digits on a private
 * decimal.js clone, exact parsing from strings only, canonical text, explicit errors.
 */
import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { Dec, DecError } from '../src/decimal/dec.ts';
import { fromRational, parseRational, rational, sqrtRational, terminatingDecimal, toRational } from '../src/decimal/exact.ts';

function code(f: () => unknown): string | undefined {
  try {
    f();
    return undefined;
  } catch (e) {
    return e instanceof DecError ? e.code : `other: ${String(e)}`;
  }
}

describe('Dec parsing', () => {
  it('[DI-33] parses decimal strings exactly and prints canonical text', () => {
    expect(Dec.parse('94.95').toString()).toBe('94.95');
    expect(Dec.parse('95.0').toString()).toBe('95');
    expect(Dec.parse('-0.500').toString()).toBe('-0.5');
    expect(Dec.parse('007.10').toString()).toBe('7.1');
    expect(Dec.parse('1e-6').toString()).toBe('0.000001');
    expect(Dec.parse('2.5E3').toString()).toBe('2500');
    expect(Dec.parse('-0').toString()).toBe('0');
    expect(Dec.parse('0.1').plus(Dec.parse('0.2')).toString()).toBe('0.3');
  });

  it('[DI-33] refuses JavaScript numbers at the boundary (binary floating point is not exact)', () => {
    expect(code(() => Dec.parse(0.1 as unknown as string))).toBe('DEC_NOT_A_STRING');
    expect(code(() => Dec.parse(NaN as unknown as string))).toBe('DEC_NOT_A_STRING');
    expect(code(() => Dec.parse(undefined as unknown as string))).toBe('DEC_NOT_A_STRING');
  });

  it('refuses malformed text, NaN, infinities, signs, blanks and hex', () => {
    for (const bad of ['', ' 1', '1 ', '+1', '.5', '1.', 'NaN', 'Infinity', '-Infinity', '0x10', '1e', '1,5', '1_000', '١٢']) {
      expect(code(() => Dec.parse(bad)), bad).toBe('DEC_SYNTAX');
    }
  });

  it('refuses a value with more than 34 significant digits instead of rounding it silently', () => {
    expect(Dec.parse('1234567890123456789012345678901234').toString()).toBe('1234567890123456789012345678901234');
    expect(code(() => Dec.parse('12345678901234567890123456789012345'))).toBe('DEC_TOO_PRECISE');
    // Trailing zeros do not count: the value is exactly 1.
    expect(Dec.parse('1.000000000000000000000000000000000000000').toString()).toBe('1');
  });

  it('refuses exponents outside 1e-1000 .. 1e1000', () => {
    expect(code(() => Dec.parse('1e1001'))).toBe('DEC_EXPONENT_RANGE');
    expect(code(() => Dec.parse('1e-1001'))).toBe('DEC_EXPONENT_RANGE');
    expect(Dec.parse('0e5000').toString()).toBe('0');
  });

  it('accepts only safe integers as counts', () => {
    expect(Dec.fromInteger(20).toString()).toBe('20');
    expect(Dec.fromInteger(12345678901234567890n).toString()).toBe('12345678901234567890');
    expect(code(() => Dec.fromInteger(1.5))).toBe('DEC_NOT_A_SAFE_INTEGER');
    expect(code(() => Dec.fromInteger(2 ** 60))).toBe('DEC_NOT_A_SAFE_INTEGER');
  });
});

describe('Dec arithmetic', () => {
  it('[DI-33] rounds results to 34 significant digits, half-even', () => {
    expect(Dec.parse('1').div(Dec.parse('3')).toString()).toBe('0.3333333333333333333333333333333333');
    expect(Dec.parse('2').div(Dec.parse('3')).toString()).toBe('0.6666666666666666666666666666666667');
    // 35 nines plus one: exact result 1e34 fits; one more digit rounds half-even.
    expect(Dec.parse('9999999999999999999999999999999999').plus(Dec.ONE).toString()).toBe('10000000000000000000000000000000000');
    expect(Dec.parse('1234567890123456789012345678901234').plus(Dec.parse('0.5')).toString()).toBe('1234567890123456789012345678901234');
    expect(Dec.parse('1234567890123456789012345678901235').plus(Dec.parse('0.5')).toString()).toBe('1234567890123456789012345678901236');
  });

  it('[DI-33] a division by zero is an explicit error, never Infinity, NaN or zero', () => {
    expect(code(() => Dec.ONE.div(Dec.ZERO))).toBe('DEC_DIVISION_BY_ZERO');
    expect(code(() => Dec.ZERO.div(Dec.ZERO))).toBe('DEC_DIVISION_BY_ZERO');
    expect(code(() => Dec.parse('-4').sqrt())).toBe('DEC_DOMAIN');
  });

  it('never produces a negative zero', () => {
    expect(Dec.parse('0.5').minus(Dec.parse('0.5')).toString()).toBe('0');
    expect(Dec.ZERO.neg().toString()).toBe('0');
    expect(Dec.parse('-0.04').toFixed(1, 'HALF_UP')).toBe('0.0');
    expect(Dec.parse('-0.05').toFixed(1, 'HALF_UP')).toBe('-0.1');
  });

  it('cannot be turned into a JavaScript number by accident', () => {
    const d = Dec.parse('1.5');
    expect(() => +(d as unknown as number)).toThrow(TypeError);
    expect(() => (d as unknown as number) * 2).toThrow(TypeError);
    expect(() => `${String(d)}`).not.toThrow();
    expect(`${d as unknown as string}`).toBe('1.5');
    expect(JSON.stringify({ d })).toBe('{"d":"1.5"}');
  });

  it('uses its own decimal.js clone: the global configuration cannot change a result', () => {
    const before = Decimal.precision;
    try {
      Decimal.set({ precision: 5, rounding: Decimal.ROUND_DOWN });
      expect(Dec.parse('1').div(Dec.parse('3')).toString()).toBe('0.3333333333333333333333333333333333');
    } finally {
      Decimal.set({ precision: before, rounding: Decimal.ROUND_HALF_UP });
    }
  });

  it('rounds explicitly only when asked (half-up, half-even, up, down, ceiling, floor)', () => {
    const v = Dec.parse('2.345');
    expect(v.roundToDecimals(2, 'HALF_UP').toString()).toBe('2.35');
    expect(v.roundToDecimals(2, 'HALF_EVEN').toString()).toBe('2.34');
    expect(Dec.parse('-2.345').roundToDecimals(2, 'HALF_UP').toString()).toBe('-2.35');
    expect(v.roundToDecimals(1, 'UP').toString()).toBe('2.4');
    expect(v.roundToDecimals(1, 'DOWN').toString()).toBe('2.3');
    expect(Dec.parse('-2.31').roundToDecimals(1, 'CEILING').toString()).toBe('-2.3');
    expect(Dec.parse('-2.31').roundToDecimals(1, 'FLOOR').toString()).toBe('-2.4');
    expect(Dec.parse('99.95').roundToSignificant(3, 'HALF_UP').toString()).toBe('100');
    expect(Dec.parse('94.95').toFixed(1, 'HALF_UP')).toBe('95.0');
  });

  it('exposes exact scaled integers and back', () => {
    expect(Dec.parse('-12.3400').toScaled()).toEqual({ coefficient: -1234n, exponent: -2 });
    expect(Dec.parse('1200').toScaled()).toEqual({ coefficient: 12n, exponent: 2 });
    expect(Dec.fromScaled(-1234n, -2).toString()).toBe('-12.34');
    expect(code(() => Dec.fromScaled(10n ** 35n + 1n, 0))).toBe('DEC_TOO_PRECISE');
  });
});

describe('exact rationals', () => {
  it('rounds a rational once, correctly, and says whether it was exact', () => {
    expect(fromRational(rational(1n, 3n))).toEqual({ value: Dec.parse('0.3333333333333333333333333333333333'), exact: false });
    expect(fromRational(rational(1n, 8n))).toEqual({ value: Dec.parse('0.125'), exact: true });
    expect(fromRational(rational(-2n, 3n)).value.toString()).toBe('-0.6666666666666666666666666666666667');
    expect(fromRational(rational(5n, 2n), 'HALF_UP', 1).value.toString()).toBe('3');
    expect(fromRational(rational(5n, 2n), 'HALF_EVEN', 1).value.toString()).toBe('2');
    expect(fromRational(rational(-5n, 2n), 'HALF_UP', 1).value.toString()).toBe('-3');
    expect(fromRational(rational(999999n, 1n), 'HALF_EVEN', 3).value.toString()).toBe('1000000');
  });

  it('computes correctly rounded square roots of rationals', () => {
    expect(sqrtRational(rational(4n)).value.toString()).toBe('2');
    expect(sqrtRational(rational(2n))).toEqual({ value: Dec.parse('1.414213562373095048801688724209698'), exact: false });
    expect(sqrtRational(rational(32n, 7n)).value.toString()).toBe('2.138089935299395077476427847038028');
    expect(sqrtRational(rational(1n, 10000n)).value.toString()).toBe('0.01');
  });

  it('knows which rationals have a terminating decimal expansion', () => {
    expect(terminatingDecimal(rational(1n, 100n))).toBe('0.01');
    expect(terminatingDecimal(rational(196133n, 20000n))).toBe('9.80665');
    expect(terminatingDecimal(rational(5n, 9n))).toBeUndefined();
    expect(terminatingDecimal(parseRational('-3/8'))).toBe('-0.375');
    expect(toRational(Dec.parse('-0.125'))).toEqual({ num: -1n, den: 8n });
  });
});
