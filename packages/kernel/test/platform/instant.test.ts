/**
 * Instants and durations, value by value (build outline 5.6; control DI-27): parsing of ISO 8601 and
 * PostgreSQL timestamptz text and every refusal it makes, conversion from Date, the ISO text, the
 * order of instants and the duration texts. The scenario tests around daylight-saving changes and
 * the round trip through the database are in site-time.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { Instant, durationMicros, formatDuration, microsToSeconds } from '../../src/time/instant.ts';

const iso = (text: string): string => Instant.parse(text).toIsoString();

/** The error a call throws, as name and message, or undefined when it returns. */
function refusal(call: () => unknown): { name: string; message: string } | undefined {
  try {
    call();
  } catch (error) {
    return { name: (error as Error).name, message: (error as Error).message };
  }
  return undefined;
}

describe('parsing timestamp text', () => {
  it('[DI-27] whitespace around the text is ignored', () => {
    expect(iso('  2026-03-29T01:00:00Z\n')).toBe('2026-03-29T01:00:00.000000Z');
    expect(iso('\t2026-03-29 06:30:00+05:30 ')).toBe('2026-03-29T01:00:00.000000Z');
  });

  it('[DI-27] text without a date, a time and an explicit offset is refused, and the error quotes it', () => {
    for (const text of ['2026-03-29 03:30:00', '2026-03-29', 'yesterday', '2026-03-29T01:00:00 IST']) {
      expect(refusal(() => Instant.parse(text))).toEqual({ name: 'RangeError', message: `not a timestamp with offset: ${text}` });
    }
  });

  it('[DI-27] a field outside its range is refused as out of range, not carried into the next field', () => {
    for (const text of [
      '2026-00-10T00:00:00Z',
      '2026-13-10T00:00:00Z',
      '2026-01-00T00:00:00Z',
      '2026-01-32T00:00:00Z',
      '2026-01-10T24:00:00Z',
      // Date.UTC would read 10:60 as 11:00 and 10:00:60 as 10:01 on the same day.
      '2026-01-10T10:60:00Z',
      '2026-01-10T10:00:60Z',
      '2026-12-31T23:59:60Z',
    ]) {
      expect(refusal(() => Instant.parse(text))).toEqual({ name: 'RangeError', message: `timestamp out of range: ${text}` });
    }
  });

  it('[DI-27] the first and the last value of every field are accepted', () => {
    expect(iso('2026-01-01T00:00:00Z')).toBe('2026-01-01T00:00:00.000000Z');
    expect(iso('2026-12-31T23:59:59Z')).toBe('2026-12-31T23:59:59.000000Z');
  });

  it('[DI-27] a date the calendar does not have is refused; 29 February exists only in a leap year', () => {
    for (const text of ['2026-02-29T00:00:00Z', '2026-04-31T00:00:00Z', '2100-02-29T12:00:00Z']) {
      expect(refusal(() => Instant.parse(text))).toEqual({ name: 'RangeError', message: `no such calendar date: ${text}` });
    }
    expect(iso('2028-02-29T23:59:59Z')).toBe('2028-02-29T23:59:59.000000Z');
    expect(iso('2000-02-29T00:00:00Z')).toBe('2000-02-29T00:00:00.000000Z');
  });

  it('[DI-27] the year is read as written, also below 100', () => {
    // Date.UTC reads the years 0 to 99 as 1900 to 1999; the text names year 26, not 1926.
    expect(iso('0026-03-29T01:00:00Z')).toBe('0026-03-29T01:00:00.000000Z');
    expect(Instant.parse('0026-03-29T01:00:00Z').epochMicros).toBe(BigInt(Date.parse('0026-03-29T01:00:00Z')) * 1000n);
    expect(iso('0099-12-31T23:59:59+01:00')).toBe('0099-12-31T22:59:59.000000Z');
    expect(iso('0004-02-29T00:00:00Z')).toBe('0004-02-29T00:00:00.000000Z');
    expect(refusal(() => Instant.parse('0026-02-29T00:00:00Z'))).toEqual({ name: 'RangeError', message: 'no such calendar date: 0026-02-29T00:00:00Z' });
    expect(iso('9999-12-31T23:59:59.999999Z')).toBe('9999-12-31T23:59:59.999999Z');
  });

  it('[DI-27] fractional seconds are scaled to microseconds, and digits below a microsecond round as PostgreSQL rounds them', () => {
    expect(iso('2026-03-29T01:00:00.5Z')).toBe('2026-03-29T01:00:00.500000Z');
    expect(iso('2026-03-29T01:00:00.000001Z')).toBe('2026-03-29T01:00:00.000001Z');
    expect(iso('2026-03-29T01:00:00.123456000Z')).toBe('2026-03-29T01:00:00.123456Z');
    expect(iso('2026-03-29T01:00:00.000000001Z')).toBe('2026-03-29T01:00:00.000000Z');
    // As '…'::timestamptz gives them (PostgreSQL 16): the fraction as a double times a million, rounded to the
    // nearest whole number with ties to even. A decimal tie such as .1234565 is not a tie as a double.
    for (const [fraction, micros] of [
      ['1234566', '123457'],
      ['123456499', '123456'],
      ['1234565', '123456'],
      ['1234575', '123458'],
      ['12345650', '123456'],
      ['0000005', '000000'],
      ['0000015', '000002'],
      ['0000025', '000002'],
      ['5000005', '500000'],
      ['2500005', '250000'],
    ]) {
      expect(iso(`2026-03-29T01:00:00.${fraction}Z`), fraction).toBe(`2026-03-29T01:00:00.${micros}Z`);
    }
    // From .9999995 on the fraction carries into the next second, here into the next year.
    expect(iso('2026-12-31 23:59:59.9999995+00')).toBe('2027-01-01T00:00:00.000000Z');
    expect(iso('2026-12-31 23:59:59.999999999+00')).toBe('2027-01-01T00:00:00.000000Z');
    expect(iso('2026-12-31 23:59:59.9999994+00')).toBe('2026-12-31T23:59:59.999999Z');
  });

  it('[DI-27] an offset west of Greenwich is applied with its sign, in every written form', () => {
    for (const text of [
      '2026-03-28T22:00:00-03:00',
      '2026-03-28T22:00:00-0300',
      '2026-03-28T22:00:00-03',
      '2026-03-28T21:30:00-03:30',
      '2026-03-28T21:30:00-0330',
      '2026-03-29T06:45:00+0545',
      '2026-03-29T01:00:00+00',
      '2026-03-29 01:00:00 Z',
    ]) {
      expect([text, iso(text)]).toEqual([text, '2026-03-29T01:00:00.000000Z']);
    }
  });
});

describe('instants from Date', () => {
  it('[DI-27] a Date converts to the same instant, to the millisecond', () => {
    expect(Instant.fromDate(new Date('2026-03-29T01:00:00.123Z')).epochMicros).toBe(Instant.parse('2026-03-29T01:00:00.123Z').epochMicros);
    expect(Instant.fromDate(new Date(-1)).toIsoString()).toBe('1969-12-31T23:59:59.999000Z');
  });

  it('[DI-27] an invalid Date is refused', () => {
    expect(refusal(() => Instant.fromDate(new Date(Number.NaN)))).toEqual({ name: 'RangeError', message: 'invalid Date' });
    expect(refusal(() => Instant.fromDate(new Date('not a date')))).toEqual({ name: 'RangeError', message: 'invalid Date' });
  });
});

describe('ISO text and Date of an instant', () => {
  it('[DI-27] the ISO text always has six fractional digits', () => {
    expect(Instant.fromEpochMicros(12n).toIsoString()).toBe('1970-01-01T00:00:00.000012Z');
    expect(Instant.fromEpochMicros(0n).toIsoString()).toBe('1970-01-01T00:00:00.000000Z');
  });

  it('[DI-27] an instant before 1970 falls in the earlier second and millisecond', () => {
    expect(Instant.fromEpochMicros(-1_000_000n).toIsoString()).toBe('1969-12-31T23:59:59.000000Z');
    expect(Instant.fromEpochMicros(-1_500_000n).toIsoString()).toBe('1969-12-31T23:59:58.500000Z');
    expect(Instant.fromEpochMicros(-1_000n).toDate().getTime()).toBe(-1);
    expect(Instant.fromEpochMicros(-1_500n).toDate().getTime()).toBe(-2);
    expect(Instant.fromEpochMicros(1_500n).toDate().getTime()).toBe(1);
  });
});

describe('order of instants', () => {
  it('[DI-27] compare, isBefore and isAfter order instants by the microsecond, whatever offset the text had', () => {
    const a = Instant.fromEpochMicros(1_000_000n);
    const b = Instant.fromEpochMicros(1_000_001n);
    const sameAsA = Instant.parse('1970-01-01T05:30:01+05:30');
    expect([a.compare(b), b.compare(a), a.compare(sameAsA)]).toEqual([-1, 1, 0]);
    expect([a.isBefore(b), b.isBefore(a), a.isBefore(sameAsA)]).toEqual([true, false, false]);
    expect([a.isAfter(b), b.isAfter(a), a.isAfter(sameAsA)]).toEqual([false, true, false]);
    expect(durationMicros(b, a)).toBe(-1n);
  });
});

describe('duration texts', () => {
  it('[DI-27] a zero duration has no sign', () => {
    expect(formatDuration(0n)).toBe('0:00:00');
    expect(microsToSeconds(0n)).toBe('0.000000');
  });

  it('[DI-27] whole and fractional durations on either side of zero', () => {
    expect(formatDuration(-3_600_000_000n)).toBe('-1:00:00');
    expect(formatDuration(59_999_999n)).toBe('0:00:59.999999');
    expect(microsToSeconds(1_500_000n)).toBe('1.500000');
    expect(microsToSeconds(-1n)).toBe('-0.000001');
  });
});
