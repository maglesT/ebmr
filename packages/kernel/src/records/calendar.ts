/**
 * Site-calendar date arithmetic for retention (outline 5.6: calendar rules use the site-local
 * calendar day). A calendar date is a string `YYYY-MM-DD`; it never carries a time or a zone, so no
 * time-zone shift can move it. Mirrors records.add_period in SQL exactly.
 */

export type CalendarDate = string;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface DateParts {
  year: number;
  month: number;
  day: number;
}

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeap(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function parseCalendarDate(value: string): DateParts {
  const m = DATE_RE.exec(value);
  if (!m) throw new Error(`EBMR-REC-020 ${value} is not a date written YYYY-MM-DD`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new Error(`EBMR-REC-020 ${value} is not a valid calendar date`);
  }
  return { year, month, day };
}

export function isCalendarDate(value: unknown): value is CalendarDate {
  if (typeof value !== 'string') return false;
  try {
    parseCalendarDate(value);
    return true;
  } catch {
    return false;
  }
}

export function formatCalendarDate(parts: DateParts): CalendarDate {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

/**
 * Adds whole years and months. When the day does not exist in the target month (29 February plus one
 * year), the result rolls forward to the first day of the next month, so a retention period is never
 * shortened by clamping to the month end.
 */
export function addPeriod(date: CalendarDate, years: number, months: number): CalendarDate {
  if (!Number.isInteger(years) || !Number.isInteger(months) || years < 0 || months < 0) {
    throw new Error('EBMR-REC-003 retention periods are whole, non-negative years and months');
  }
  const { year, month, day } = parseCalendarDate(date);
  const total = year * 12 + (month - 1) + years * 12 + months;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  if (day <= daysInMonth(y, m)) return formatCalendarDate({ year: y, month: m, day });
  return m === 12 ? formatCalendarDate({ year: y + 1, month: 1, day: 1 }) : formatCalendarDate({ year: y, month: m + 1, day: 1 });
}

/** Negative, zero or positive like a comparator; ISO dates order lexically. */
export function compareDates(a: CalendarDate, b: CalendarDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The site-local calendar date of an instant, e.g. siteDate(instant, 'Asia/Kolkata'). */
export function siteDate(instant: Date, zone: string): CalendarDate {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year').padStart(4, '0')}-${get('month')}-${get('day')}`;
}
