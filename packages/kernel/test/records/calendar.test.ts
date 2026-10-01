/**
 * Site-calendar date arithmetic for retention (calendar.ts, the TypeScript twin of records.add_period
 * in kernel 0400; outline 3.3.6 and 5.6), function by function: the Gregorian leap-year rule, the
 * exact YYYY-MM-DD form and each way a date is refused (EBMR-REC-020 naming the value), the period
 * guard (EBMR-REC-003), the roll-forward of a day the target month does not have, the comparator and
 * the site-local date of an instant. No database; retention-rules.test.ts checks the SQL twin agrees.
 */
import { describe, expect, it } from 'vitest';
import {
  addPeriod,
  compareDates,
  daysInMonth,
  formatCalendarDate,
  isCalendarDate,
  parseCalendarDate,
  siteDate,
} from '../../src/records/calendar.ts';
import { normalizeRetentionInputs } from '../../src/records/retention.ts';

const notWritten = (v: string) => `EBMR-REC-020 ${v} is not a date written YYYY-MM-DD`;
const notValid = (v: string) => `EBMR-REC-020 ${v} is not a valid calendar date`;
const PERIOD_REFUSED = 'EBMR-REC-003 retention periods are whole, non-negative years and months';

describe('calendar dates (calendar.ts)', () => {
  it('[DI-47] February has 29 days every fourth year, except in century years not divisible by 400', () => {
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2027, 2)).toBe(28);
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(daysInMonth(2400, 2)).toBe(29);
    expect(daysInMonth(1900, 2)).toBe(28);
    expect(daysInMonth(2100, 2)).toBe(28);
    expect(daysInMonth(2200, 2)).toBe(28);
    // The rule reaches the parser and the period arithmetic: 2100 has no 29 February.
    expect(() => parseCalendarDate('2100-02-29')).toThrow(notValid('2100-02-29'));
    expect(parseCalendarDate('2000-02-29')).toEqual({ year: 2000, month: 2, day: 29 });
    expect(addPeriod('2096-02-29', 4, 0)).toBe('2100-03-01');
    expect(addPeriod('2396-02-29', 4, 0)).toBe('2400-02-29');
  });

  it('[DI-47] April, June, September and November have 30 days, the other months 31 (February aside)', () => {
    const days = Array.from({ length: 12 }, (_, i) => daysInMonth(2026, i + 1));
    expect(days).toEqual([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);
  });

  it('[DI-47] a date is read only when written exactly YYYY-MM-DD; any other form is refused naming the value', () => {
    expect(parseCalendarDate('2026-01-15')).toEqual({ year: 2026, month: 1, day: 15 });
    for (const v of ['2026-1-15', '2026-01-5', '26-01-15', '02026-01-15', '2026/01/15', '2026-01-15T00:00:00Z', ' 2026-01-15', '2026-01-15 ', '', 'today']) {
      expect(() => parseCalendarDate(v)).toThrow(notWritten(v));
    }
  });

  it('[DI-47] a date that does not exist is refused naming the value: year 0, month 0 or 13, day 0, or past the month end', () => {
    for (const v of ['0000-06-15', '2026-00-10', '2026-13-01', '2026-01-00', '2026-01-32', '2026-04-31', '2026-02-29', '2026-11-31']) {
      expect(() => parseCalendarDate(v)).toThrow(notValid(v));
    }
    // The boundaries themselves are dates.
    expect(parseCalendarDate('0001-01-01')).toEqual({ year: 1, month: 1, day: 1 });
    expect(parseCalendarDate('9999-12-31')).toEqual({ year: 9999, month: 12, day: 31 });
    expect(parseCalendarDate('2026-04-30')).toEqual({ year: 2026, month: 4, day: 30 });
    expect(parseCalendarDate('2024-02-29')).toEqual({ year: 2024, month: 2, day: 29 });
  });

  it('[DI-47] isCalendarDate answers true or false and never throws; only a string can be a date', () => {
    expect(isCalendarDate('2024-02-29')).toBe(true);
    expect(isCalendarDate('0001-01-01')).toBe(true);
    expect(isCalendarDate('2025-02-29')).toBe(false);
    expect(isCalendarDate('2025-2-1')).toBe(false);
    expect(isCalendarDate(20260115)).toBe(false);
    expect(isCalendarDate(null)).toBe(false);
    expect(isCalendarDate(undefined)).toBe(false);
    expect(isCalendarDate(new Date('2026-01-15T00:00:00Z'))).toBe(false);
    // Values that read as a date when turned into text are still not dates.
    expect(isCalendarDate(['2026-01-15'])).toBe(false);
    expect(isCalendarDate({ toString: () => '2026-01-15' })).toBe(false);
  });

  it('[DI-47] a retention input given as an array or object holding a date is refused, not taken as that date', () => {
    expect(() => normalizeRetentionInputs({ markets: ['IN'], expiryDate: ['2028-01-31'] as unknown as string })).toThrow(
      'EBMR-REC-020 expiryDate is not a valid calendar date',
    );
    expect(() => normalizeRetentionInputs({ markets: ['IN'], manufactureDate: { toString: () => '2026-01-15' } as unknown as string })).toThrow(
      'EBMR-REC-020 manufactureDate is not a valid calendar date',
    );
  });

  it('[DI-47] a date is written with a four-digit year and two-digit month and day', () => {
    expect(formatCalendarDate({ year: 33, month: 2, day: 3 })).toBe('0033-02-03');
    expect(formatCalendarDate({ year: 999, month: 12, day: 31 })).toBe('0999-12-31');
    expect(formatCalendarDate({ year: 2026, month: 11, day: 30 })).toBe('2026-11-30');
    expect(addPeriod('0004-02-29', 1, 0)).toBe('0005-03-01');
    expect(addPeriod('0999-12-31', 1, 0)).toBe('1000-12-31');
  });

  it('[DI-47][INV-22] a retention period of fractional or negative years or months is refused (EBMR-REC-003)', () => {
    for (const [years, months] of [
      [1.5, 0],
      [0, 0.5],
      [-1, 0],
      [0, -1],
      [-1, 13],
      [Number.NaN, 0],
      [0, Number.POSITIVE_INFINITY],
    ] as const) {
      expect(() => addPeriod('2026-01-15', years, months)).toThrow(PERIOD_REFUSED);
    }
    // The period is checked before the date, and a refused date still names its own code.
    expect(() => addPeriod('2026-02-30', -1, 0)).toThrow(PERIOD_REFUSED);
    expect(() => addPeriod('2026-02-30', 1, 0)).toThrow(notValid('2026-02-30'));
    expect(() => addPeriod('2026-2-3', 1, 0)).toThrow(notWritten('2026-2-3'));
  });

  it('[DI-47] whole years and months are added on the calendar, carrying months into years', () => {
    expect(addPeriod('2026-01-15', 0, 0)).toBe('2026-01-15');
    expect(addPeriod('2026-01-15', 0, 1)).toBe('2026-02-15');
    expect(addPeriod('2026-01-15', 0, 11)).toBe('2026-12-15');
    expect(addPeriod('2026-01-15', 0, 12)).toBe('2027-01-15');
    expect(addPeriod('2026-12-15', 0, 1)).toBe('2027-01-15');
    expect(addPeriod('2026-11-30', 1, 1)).toBe('2027-12-30');
    expect(addPeriod('2026-06-30', 5, 18)).toBe('2032-12-30');
  });

  it('[DI-47] a day the target month does not have rolls forward to the first of the next month, never back to the month end', () => {
    expect(addPeriod('2026-01-31', 0, 1)).toBe('2026-03-01');
    expect(addPeriod('2024-01-31', 0, 1)).toBe('2024-03-01');
    expect(addPeriod('2024-01-30', 0, 1)).toBe('2024-03-01');
    expect(addPeriod('2024-01-29', 0, 1)).toBe('2024-02-29');
    expect(addPeriod('2026-03-31', 0, 1)).toBe('2026-05-01');
    expect(addPeriod('2026-08-31', 0, 3)).toBe('2026-12-01');
    expect(addPeriod('2026-10-31', 0, 1)).toBe('2026-12-01');
    expect(addPeriod('2026-05-31', 0, 7)).toBe('2026-12-31');
    expect(addPeriod('2025-12-31', 0, 2)).toBe('2026-03-01');
  });

  it('[DI-47] compareDates is -1, 0 or 1 by calendar order, and 0 only for the same date', () => {
    expect(compareDates('2026-01-01', '2026-01-02')).toBe(-1);
    expect(compareDates('2026-01-02', '2026-01-01')).toBe(1);
    expect(compareDates('2025-12-31', '2026-01-01')).toBe(-1);
    expect(compareDates('2026-10-01', '2026-09-30')).toBe(1);
    expect(compareDates('2026-01-01', '2026-01-01')).toBe(0);
    // An expiry on the day of manufacture is not "before" it.
    expect(normalizeRetentionInputs({ markets: ['IN'], manufactureDate: '2026-01-15', expiryDate: '2026-01-15' }).expiryDate).toBe('2026-01-15');
  });

  it('[DI-47] the site date of an instant is its calendar day in the site zone, written YYYY-MM-DD', () => {
    expect(siteDate(new Date('2026-03-31T18:29:59.999Z'), 'Asia/Kolkata')).toBe('2026-03-31');
    expect(siteDate(new Date('2026-03-31T18:30:00.000Z'), 'Asia/Kolkata')).toBe('2026-04-01');
    expect(siteDate(new Date('2026-01-01T03:00:00Z'), 'America/New_York')).toBe('2025-12-31');
    expect(siteDate(new Date('2026-12-31T23:59:59Z'), 'UTC')).toBe('2026-12-31');
    // A year of fewer than four digits is padded like every other calendar date.
    expect(siteDate(new Date('0099-06-15T12:00:00Z'), 'UTC')).toBe('0099-06-15');
    expect(isCalendarDate(siteDate(new Date('0999-01-05T12:00:00Z'), 'Asia/Kolkata'))).toBe(true);
  });
});
