/**
 * The package's numeric doors (ADR 0020 point 5; D-6A-22): statOf, the only conversion from decimal text to a number,
 * the canonical text at 12 significant digits and the package's own SHA-256 (compared with node:crypto).
 */
import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { AnalyticsInputError, canonicalNumber, canonicalText, decimalText, outputHash, sha256Hex, sha256HexOfBytes, statOf, type DecimalText } from '../src/index.ts';

const nodeSha = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');

describe('statOf (numeric/from-decimal.ts)', () => {
  it('statOf refuses text that is not a decimal and converts exact decimals', () => {
    expect(statOf(decimalText('12.500'))).toBe(12.5);
    expect(statOf(decimalText('-0.0003'))).toBe(-0.0003);
    expect(statOf(decimalText('0'))).toBe(0);
    expect(Object.is(statOf(decimalText('-0.000')), 0)).toBe(true);
    expect(statOf(decimalText('007'))).toBe(7);
    for (const bad of ['', ' 1', '1 ', '+1', '1e3', '1E3', '.5', '5.', '1,000', '0x10', 'NaN', 'Infinity', '-', '1.2.3', '١٢', '1_000', '−1']) {
      expect(() => statOf(bad as DecimalText), JSON.stringify(bad)).toThrow(AnalyticsInputError);
      expect(() => decimalText(bad), JSON.stringify(bad)).toThrow(AnalyticsInputError);
    }
    // A number or another type cast to the brand is refused at run time too.
    expect(() => statOf(12 as unknown as DecimalText)).toThrow(AnalyticsInputError);
    // Text beyond the double range is no statistic.
    expect(() => statOf(decimalText(`1${'0'.repeat(400)}`))).toThrow(/beyond the range/);
    fc.assert(
      fc.property(fc.integer({ min: -1_000_000, max: 1_000_000 }), fc.integer({ min: 0, max: 6 }), (n, scale) => {
        const text = (n / 10 ** scale).toFixed(scale);
        expect(statOf(decimalText(text))).toBe(Number(text));
      }),
    );
  });
});

describe('canonical text and the output hash (numeric/canonical.ts)', () => {
  it('writes sorted keys, numbers at 12 significant digits, -0 as 0 and a non-finite number as null', () => {
    expect(canonicalText({ b: 1, a: [true, null, 'x'], c: { z: 0.1 + 0.2, y: -0 } })).toBe('{"a":[true,null,"x"],"b":1,"c":{"y":0,"z":0.3}}');
    expect(canonicalText([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])).toBe('[null,null,null]');
    expect(canonicalNumber(123456789012345)).toBe('123456789012000');
    expect(canonicalNumber(1.23456789012345e-7)).toBe('1.23456789012e-7');
    expect(canonicalNumber(2 / 3)).toBe('0.666666666667');
    expect(canonicalText({ u: undefined, k: 'é"\n' })).toBe('{"k":"é\\"\\n"}');
    expect(() => canonicalText({ when: new Date(0) })).toThrow(AnalyticsInputError);
    expect(() => canonicalText(10n)).toThrow(AnalyticsInputError);
    expect(() => canonicalText(undefined)).toThrow(AnalyticsInputError);
  });

  it('values that agree to 12 significant digits hash alike; the hash is the SHA-256 of the canonical text', () => {
    const a = { outputs: [{ mean: 10.000000000001 }], flags: [] };
    const b = { outputs: [{ mean: 10.0000000000012 }], flags: [] };
    expect(outputHash(a.outputs, a.flags)).toBe(outputHash(b.outputs, b.flags));
    expect(outputHash([{ mean: 10.0000000001 }], [])).not.toBe(outputHash(a.outputs, a.flags));
    expect(outputHash(a.outputs, a.flags)).toBe(nodeSha(canonicalText({ outputs: a.outputs, flags: a.flags })));
    // Key order and white space never change the hash.
    expect(outputHash([{ b: 2, a: 1 }], [{ r: 'X' }])).toBe(outputHash([{ a: 1, b: 2 }], [{ r: 'X' }]));
  });

  it('the package SHA-256 equals node:crypto over empty, block-boundary, multi-byte and random inputs', () => {
    for (const s of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(63), 'a'.repeat(64), 'a'.repeat(65), 'a'.repeat(1000), 'प्रक्रिया ✓ 𝔼']) {
      expect(sha256Hex(s), s.slice(0, 10)).toBe(nodeSha(s));
    }
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), (bytes) => {
        expect(sha256HexOfBytes(bytes)).toBe(nodeSha(bytes));
      }),
    );
  });
});
