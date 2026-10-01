/**
 * Site time, value by value (build outline 5.6; control DI-27): the UTC offset in microseconds, the
 * offset texts that different ICU versions return through Intl, refusal of any other text, and the
 * zone-name rule. The daylight-saving scenarios and the comparison with SQL are in site-time.test.ts.
 *
 * Some tests make Intl answer as another runtime would (older ICU data, a runtime that knows more
 * zone names); the display must not depend on which ICU version the server or terminal runs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Instant } from '../../src/time/instant.ts';
import { isValidTimeZone, siteTime, utcOffsetMicros } from '../../src/time/site-time.ts';

const MINUTE = 60_000_000n;
const at = (text: string): Instant => Instant.parse(text);
const JANUARY = '2026-01-15T12:00:00Z';
const JULY = '2026-07-15T12:00:00Z';

/** The error a call throws, as name and message, or undefined when it returns. */
function refusal(call: () => unknown): { name: string; message: string } | undefined {
  try {
    call();
  } catch (error) {
    return { name: (error as Error).name, message: (error as Error).message };
  }
  return undefined;
}

/** Makes Intl answer as another ICU version might: `change` edits the parts the real formatter returns. */
function intlParts(change: (parts: Intl.DateTimeFormatPart[]) => Intl.DateTimeFormatPart[]): void {
  const formatToParts = Reflect.get(Intl.DateTimeFormat.prototype, 'formatToParts');
  vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts').mockImplementation(function (this: Intl.DateTimeFormat, date?: Date | number) {
    return change(formatToParts.call(this, date));
  });
}

/** Makes Intl return `text` as the zone's offset. */
function intlOffsetText(text: string): void {
  intlParts((parts) => parts.map((part) => (part.type === 'timeZoneName' ? { ...part, value: text } : part)));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('UTC offset in force', () => {
  it('[DI-27] the offset keeps its sign and its minutes, east and west of Greenwich', () => {
    expect(utcOffsetMicros(at(JULY), 'Asia/Kolkata')).toBe(330n * MINUTE);
    expect(utcOffsetMicros(at(JULY), 'Asia/Kathmandu')).toBe(345n * MINUTE);
    expect(utcOffsetMicros(at(JULY), 'America/New_York')).toBe(-240n * MINUTE);
    expect(utcOffsetMicros(at(JANUARY), 'America/St_Johns')).toBe(-210n * MINUTE);
    expect(utcOffsetMicros(at(JULY), 'America/St_Johns')).toBe(-150n * MINUTE);
    expect(utcOffsetMicros(at(JULY), 'UTC')).toBe(0n);
    expect(siteTime(at(JANUARY), 'America/St_Johns').display).toBe('2026-01-15 08:30:00 -03:30 (America/St_Johns)');
  });

  it('[DI-27] the year always has four digits, as SQL writes it', () => {
    expect(siteTime(at('0999-03-01T12:00:00Z'), 'UTC').display).toBe('0999-03-01 12:00:00 +00:00 (UTC)');
  });
});

describe('offset text from Intl', () => {
  it('[DI-27] the offset forms of older and newer ICU data give the same +HH:MM display and offset', () => {
    const cases: [text: string, zone: string, iso: string, display: string, offset: bigint][] = [
      ['GMT', 'Europe/London', JANUARY, '2026-01-15 12:00:00 +00:00 (Europe/London)', 0n],
      ['UTC', 'UTC', JANUARY, '2026-01-15 12:00:00 +00:00 (UTC)', 0n],
      ['GMT+5:30', 'Asia/Kolkata', JULY, '2026-07-15 17:30:00 +05:30 (Asia/Kolkata)', 330n * MINUTE],
      ['GMT+0530', 'Asia/Kolkata', JULY, '2026-07-15 17:30:00 +05:30 (Asia/Kolkata)', 330n * MINUTE],
      ['GMT-3', 'America/Sao_Paulo', JULY, '2026-07-15 09:00:00 -03:00 (America/Sao_Paulo)', -180n * MINUTE],
      ['UTC+05:45', 'Asia/Kathmandu', JULY, '2026-07-15 17:45:00 +05:45 (Asia/Kathmandu)', 345n * MINUTE],
    ];
    for (const [text, zone, iso, display, offset] of cases) {
      intlOffsetText(text);
      expect([text, siteTime(at(iso), zone).display, utcOffsetMicros(at(iso), zone)]).toEqual([text, display, offset]);
      vi.restoreAllMocks();
    }
  });

  it('[DI-27] any other offset text is refused, never read in part', () => {
    // Before standard time, Kolkata kept a local mean time with seconds in its offset; the display has none.
    expect(refusal(() => siteTime(at('1900-01-01T00:00:00Z'), 'Asia/Kolkata'))).toEqual({
      name: 'Error',
      message: 'unexpected time-zone offset text GMT+05:21:10',
    });
    for (const text of ['‎GMT+05:30', 'GMT+05:30 IST', 'IST', '+05:30']) {
      intlOffsetText(text);
      expect(refusal(() => siteTime(at(JULY), 'Asia/Kolkata'))).toEqual({ name: 'Error', message: `unexpected time-zone offset text ${text}` });
      vi.restoreAllMocks();
    }
  });

  it('[DI-27] if Intl leaves out a part, siteTime refuses rather than show an incomplete time', () => {
    intlParts((parts) => parts.filter((part) => part.type !== 'timeZoneName'));
    expect(refusal(() => siteTime(at(JULY), 'Asia/Kolkata'))).toEqual({ name: 'Error', message: 'Intl did not return timeZoneName for Asia/Kolkata' });
  });
});

describe('zone names', () => {
  it('[DI-27] the Area/Location rule covers the whole name, even on a runtime that would accept more names', () => {
    const DateTimeFormat = Intl.DateTimeFormat;
    // A stand-in for a more permissive runtime: a name Intl does not know is formatted as UTC.
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
      try {
        return new DateTimeFormat(locales, options);
      } catch {
        return new DateTimeFormat(locales, { ...options, timeZone: 'UTC' });
      }
    });
    expect(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata.' }).resolvedOptions().timeZone).toBe('UTC');
    for (const zone of ['9Asia/Kolkata', ' Asia/Kolkata', '/Asia/Kolkata', 'Asia/Kolkata ', 'Asia/Kolkata.', 'Asia/Kolkata/', 'IST', '+05:30']) {
      expect([zone, isValidTimeZone(zone)]).toEqual([zone, false]);
    }
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true);
  });
});
