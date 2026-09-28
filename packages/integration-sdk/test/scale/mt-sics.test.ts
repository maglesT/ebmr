import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  LineFramer,
  MtSicsProtocolError,
  encodeCommand,
  formatError,
  formatSerial,
  formatStatus,
  formatWeight,
  fromCounts,
  interpretWeightLine,
  isMultipleOf,
  parseCommand,
  parseResponse,
  scaleOf,
  toCounts,
} from '../../src/scale/index.ts';

const decimalArb = fc
  .tuple(fc.bigInt({ min: -10_000_000_000n, max: 10_000_000_000n }), fc.integer({ min: 0, max: 6 }))
  .map(([counts, scale]) => fromCounts(counts, scale));
const unitArb = fc.constantFrom('kg', 'g', 'mg', 'lb', 'oz', 'ct');
const serialArb = fc.stringMatching(/^[A-Z0-9-]{1,20}$/).filter((s) => s.length > 0);

describe('MT-SICS codec', () => {
  it('[DI-32] weight lines round trip: parse(format(x)) keeps value, unit and stability exactly (fast-check)', () => {
    fc.assert(
      fc.property(fc.constantFrom('S' as const, 'T' as const), fc.constantFrom('S' as const, 'D' as const), decimalArb, unitArb, (command, stability, value, unit) => {
        const line = formatWeight(command, stability, value, unit);
        const parsed = parseResponse(line);
        expect(parsed).toEqual({ kind: 'WEIGHT', command, stability, value, unit, raw: line });
      }),
      { numRuns: 500 },
    );
  });

  it('status, serial and error lines round trip (fast-check)', () => {
    fc.assert(
      fc.property(fc.constantFrom('S' as const, 'T' as const, 'Z' as const), fc.constantFrom('A' as const, 'I' as const, '+' as const, '-' as const), (command, status) => {
        const line = formatStatus(command, status);
        expect(parseResponse(line)).toEqual({ kind: 'STATUS', command, status, raw: line });
      }),
    );
    fc.assert(
      fc.property(serialArb, (serial) => {
        const line = formatSerial(serial);
        expect(parseResponse(line)).toEqual({ kind: 'SERIAL', serial, raw: line });
      }),
    );
    for (const code of ['ES', 'ET', 'EL'] as const) expect(parseResponse(formatError(code))).toEqual({ kind: 'ERROR', code, raw: code });
  });

  it('writes the weight field right-aligned in 10 characters, as a balance does', () => {
    expect(formatWeight('S', 'S', '1.250', 'kg')).toBe('S S      1.250 kg');
    expect(formatWeight('S', 'D', '-0.005', 'kg')).toBe('S D     -0.005 kg');
    expect(parseResponse('S S       1.250 kg')).toMatchObject({ kind: 'WEIGHT', value: '1.250', unit: 'kg' });
  });

  it('[DI-31] a garbled line is refused, never read as a weight (fast-check over arbitrary bytes)', () => {
    const cases = ['S S 1.2.3 kg', 'S S 01.250 kg', 'S S 1.250', 'S X 1.250 kg', 'S S 1,250 kg', 'S S 1.250 k9', 'S\u0000S 1.250 kg', 'S S 1e3 kg', '', 'I4 A', 'garbage'];
    for (const c of cases) expect(() => parseResponse(c), c).toThrow(MtSicsProtocolError);
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 40 }), (s) => {
        try {
          const r = parseResponse(s);
          // Anything accepted must re-format to exactly the same line (no lenient interpretation).
          if (r.kind === 'WEIGHT') expect(r.raw).toBe(s);
          expect(/^[\x20-\x7E]+$/.test(s)).toBe(true);
        } catch (error) {
          expect(error).toBeInstanceOf(MtSicsProtocolError);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('interprets a raw S/SI line in reading terms: stable, dynamic, overload, underload', () => {
    expect(interpretWeightLine('S S     12.345 kg')).toEqual({ value: '12.345', unit: 'kg', stable: true, status: 'OK' });
    expect(interpretWeightLine('S D     12.345 kg')).toEqual({ value: '12.345', unit: 'kg', stable: false, status: 'UNSTABLE' });
    expect(interpretWeightLine('S +')).toEqual({ value: null, unit: null, stable: false, status: 'OVERLOAD' });
    expect(interpretWeightLine('S -')).toEqual({ value: null, unit: null, stable: false, status: 'UNDERLOAD' });
    expect(interpretWeightLine('S I')).toEqual({ value: null, unit: null, stable: false, status: 'ERROR' });
    expect(interpretWeightLine('T S      1.000 kg').status).toBe('ERROR');
  });

  it('parses and encodes host commands', () => {
    expect(encodeCommand('SI')).toBe('SI\r\n');
    expect(parseCommand('SI\r')).toBe('SI');
    expect(parseCommand('I4')).toBe('I4');
    expect(parseCommand('@')).toBe('@');
    expect(parseCommand('XYZ')).toBeNull();
  });

  it('frames lines across chunk boundaries, drops CR, and reports an over-long fragment as garbage', () => {
    const lines: string[] = [];
    const garbage: string[] = [];
    const f = new LineFramer((l) => lines.push(l), (g) => garbage.push(g));
    f.push('S S      1.2');
    f.push('50 kg\r\nS D');
    f.push('      1.251 kg\r\n');
    expect(lines).toEqual(['S S      1.250 kg', 'S D      1.251 kg']);
    f.push('x'.repeat(200));
    expect(garbage).toHaveLength(1);
  });
});

describe('decimal text as integer counts', () => {
  it('toCounts and fromCounts round trip without binary floating point (fast-check)', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }), fc.integer({ min: 0, max: 9 }), (counts, scale) => {
        const text = fromCounts(counts, scale);
        expect(scaleOf(text)).toBe(scale);
        expect(toCounts(text, scale)).toBe(counts);
      }),
    );
  });

  it('refuses silent rounding and checks multiples of the resolution', () => {
    expect(() => toCounts('1.2345', 3)).toThrow(RangeError);
    expect(fromCounts(-0n, 3)).toBe('0.000');
    expect(isMultipleOf('12.345', '0.001')).toBe(true);
    expect(isMultipleOf('12.345', '0.005')).toBe(true);
    expect(isMultipleOf('12.346', '0.005')).toBe(false);
    expect(isMultipleOf('12.3', '0.001')).toBe(true);
  });
});
