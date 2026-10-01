/**
 * Site time (build outline 5.6; control DI-27). Times are stored as UTC instants with the site's
 * IANA time zone; every display shows site-local time with its UTC offset and zone, whatever the
 * browser's own zone. Durations are computed from UTC instants (see instant.ts), so a
 * daylight-saving change can neither shorten nor lengthen them. "Daily" rules, manufacturing
 * dates and shift boundaries use the site-local calendar day.
 *
 * Only Intl is used for zone rules; the display text equals platform.site_time_text in SQL.
 */
import type { Instant } from './instant.ts';

export interface SiteTime {
  /** IANA zone, e.g. Asia/Kolkata. */
  zone: string;
  /** Site-local calendar date, YYYY-MM-DD. */
  date: string;
  /** Site-local wall-clock time, HH:MM:SS (24 h). */
  time: string;
  /** UTC offset in force at that instant, e.g. +05:30 or -03:00. */
  offset: string;
  /** "YYYY-MM-DD HH:MM:SS +HH:MM (Zone)" */
  display: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'longOffset',
    });
    // Stryker disable next-line CallExpression: equivalent; the map only caches formatters, and without it each call builds an identical formatter for the same zone, so every result is the same, only slower.
    formatters.set(zone, f);
  }
  return f;
}

/**
 * True when `zone` is an IANA Area/Location name (or UTC) the runtime knows. Abbreviations such
 * as IST or EST and bare offsets are refused: they are ambiguous or carry no daylight-saving
 * rules. Same rule as platform.is_valid_time_zone.
 */
export function isValidTimeZone(zone: string): boolean {
  if (zone !== 'UTC' && !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)+$/.test(zone)) return false;
  try {
    formatterFor(zone);
    return true;
  } catch {
    return false;
  }
}

export function assertTimeZone(zone: string): void {
  if (!isValidTimeZone(zone)) throw new RangeError(`EBMR-PLAT-017 ${zone} is not an IANA time zone name`);
}

/** Site-local representation of a UTC instant (to the second; sub-second digits are truncated). */
export function siteTime(at: Instant, zone: string): SiteTime {
  assertTimeZone(zone);
  const parts = formatterFor(zone).formatToParts(at.toDate());
  const part = (type: Intl.DateTimeFormatPartTypes): string => {
    const p = parts.find((x) => x.type === type);
    if (!p) throw new Error(`Intl did not return ${type} for ${zone}`);
    return p.value;
  };
  const date = `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
  const time = `${part('hour')}:${part('minute')}:${part('second')}`;
  const offset = normaliseOffset(part('timeZoneName'));
  return { zone, date, time, offset, display: `${date} ${time} ${offset} (${zone})` };
}

/** Site-local calendar day (YYYY-MM-DD) that contains the instant. */
export function siteCalendarDay(at: Instant, zone: string): string {
  return siteTime(at, zone).date;
}

/** UTC offset in force in `zone` at `at`, in microseconds (positive east of Greenwich). */
export function utcOffsetMicros(at: Instant, zone: string): bigint {
  const offset = siteTime(at, zone).offset;
  const sign = offset.startsWith('-') ? -1n : 1n;
  const hours = BigInt(offset.slice(1, 3));
  const minutes = BigInt(offset.slice(4, 6));
  return sign * (hours * 3600n + minutes * 60n) * 1_000_000n;
}

// Intl longOffset gives "GMT", "GMT+05:30", "GMT-03:00" (or "GMT+5:30" on older ICU data).
function normaliseOffset(name: string): string {
  if (name === 'GMT' || name === 'UTC') return '+00:00';
  const m = /^(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(name);
  if (!m) throw new Error(`unexpected time-zone offset text ${name}`);
  return `${m[1] ?? '+'}${(m[2] ?? '0').padStart(2, '0')}:${m[3] ?? '00'}`;
}
