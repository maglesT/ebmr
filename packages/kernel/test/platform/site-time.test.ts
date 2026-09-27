/**
 * Site time, durations and daylight-saving transitions (outline 5.6; control DI-27 catalog test
 * "Run a DST-transition test").
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Instant, durationMicros, formatDuration, microsToSeconds } from '../../src/time/instant.ts';
import { isValidTimeZone, siteCalendarDay, siteTime, utcOffsetMicros } from '../../src/time/site-time.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});

const at = (iso: string) => Instant.parse(iso);
const HOUR = 3_600_000_000n;

describe('daylight-saving transitions', () => {
  it('[DI-27] spring forward (Europe/Berlin): the wall clock jumps an hour, the duration from UTC instants stays exact', () => {
    const before = at('2026-03-29T00:30:00Z');
    const after = at('2026-03-29T01:30:00Z');
    expect(siteTime(before, 'Europe/Berlin').display).toBe('2026-03-29 01:30:00 +01:00 (Europe/Berlin)');
    expect(siteTime(after, 'Europe/Berlin').display).toBe('2026-03-29 03:30:00 +02:00 (Europe/Berlin)');
    expect(durationMicros(before, after)).toBe(HOUR);
    expect(formatDuration(durationMicros(before, after))).toBe('1:00:00');
    // India has no daylight saving: the same instants are 06:00 and 07:00 IST.
    expect(siteTime(before, 'Asia/Kolkata').display).toBe('2026-03-29 06:00:00 +05:30 (Asia/Kolkata)');
    expect(siteTime(after, 'Asia/Kolkata').display).toBe('2026-03-29 07:00:00 +05:30 (Asia/Kolkata)');
  });

  it('[DI-27] fall back (Europe/Berlin): the same wall-clock time occurs twice and is told apart by its offset; order follows UTC', () => {
    const first = at('2026-10-25T00:30:00Z');
    const second = at('2026-10-25T01:30:00Z');
    expect(siteTime(first, 'Europe/Berlin').display).toBe('2026-10-25 02:30:00 +02:00 (Europe/Berlin)');
    expect(siteTime(second, 'Europe/Berlin').display).toBe('2026-10-25 02:30:00 +01:00 (Europe/Berlin)');
    expect(first.isBefore(second)).toBe(true);
    expect(durationMicros(first, second)).toBe(HOUR);
    expect(utcOffsetMicros(first, 'Europe/Berlin') - utcOffsetMicros(second, 'Europe/Berlin')).toBe(HOUR);
  });

  it('[DI-27] a step spanning the change keeps its true duration and order in the database too', async () => {
    const { rows } = await db.app.query<{ local: string; seconds: string }>(
      `select platform.site_time_text(t, 'Europe/Berlin') as local,
              extract(epoch from t - lag(t) over (order by t))::text as seconds
         from (values ('2026-10-25T00:45:00Z'::timestamptz), ('2026-10-25T01:15:00Z'::timestamptz), ('2026-10-25T01:50:00Z'::timestamptz)) v(t)
        order by t`,
    );
    expect(rows.map((r) => r.local)).toEqual([
      '2026-10-25 02:45:00 +02:00 (Europe/Berlin)',
      '2026-10-25 02:15:00 +01:00 (Europe/Berlin)',
      '2026-10-25 02:50:00 +01:00 (Europe/Berlin)',
    ]);
    // Wall-clock order would put 02:15 first; the stored instants keep the real order and gaps.
    expect(rows.map((r) => r.seconds)).toEqual([null, '1800.000000', '2100.000000']);
  });

  it('[DI-27] SQL and TypeScript render the same site time, offset and calendar day around transitions', async () => {
    const instants = [
      '2026-03-29T00:59:59Z', '2026-03-29T01:00:00Z', '2026-10-25T00:59:59Z', '2026-10-25T01:00:00Z',
      '2026-03-08T06:59:59Z', '2026-03-08T07:00:00Z', '2026-11-01T05:59:59Z', '2026-11-01T06:00:00Z',
      '2026-09-27T18:29:59Z', '2026-09-27T18:30:00Z', '2026-12-31T23:59:59.999999Z',
    ];
    const zones = ['Europe/Berlin', 'Asia/Kolkata', 'America/New_York', 'UTC'];
    for (const iso of instants) {
      for (const zone of zones) {
        const { rows } = await db.app.query<{ text: string; day: string; offset: string }>(
          "select platform.site_time_text($1, $2) as text, platform.site_calendar_day($1, $2)::text as day, platform.offset_text(platform.utc_offset($1, $2)) as offset",
          [iso, zone],
        );
        const ts = siteTime(at(iso), zone);
        expect({ iso, zone, text: ts.display, day: ts.date, offset: ts.offset }).toEqual({ iso, zone, text: rows[0]?.text, day: rows[0]?.day, offset: rows[0]?.offset });
      }
    }
  });
});

describe('site calendar day and display', () => {
  it('[DI-27] daily rules use the site-local calendar day', () => {
    const lateEvening = at('2026-03-28T23:30:00Z');
    expect(siteCalendarDay(lateEvening, 'UTC')).toBe('2026-03-28');
    expect(siteCalendarDay(lateEvening, 'Europe/Berlin')).toBe('2026-03-29');
    expect(siteCalendarDay(lateEvening, 'Asia/Kolkata')).toBe('2026-03-29');
    expect(siteCalendarDay(at('2026-09-27T18:29:59Z'), 'Asia/Kolkata')).toBe('2026-09-27');
    expect(siteCalendarDay(at('2026-09-27T18:30:00Z'), 'Asia/Kolkata')).toBe('2026-09-28');
  });

  it('[DI-27] the display depends on the site zone only, not on the process time zone or the local clock', () => {
    const instant = at('2026-09-27T12:00:00Z');
    const expected = '2026-09-27 17:30:00 +05:30 (Asia/Kolkata)';
    const originalTz = process.env['TZ'];
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('1999-12-31T23:59:59Z') });
    try {
      process.env['TZ'] = 'America/Los_Angeles';
      expect(siteTime(instant, 'Asia/Kolkata').display).toBe(expected);
      process.env['TZ'] = 'Pacific/Kiritimati';
      expect(siteTime(instant, 'Asia/Kolkata').display).toBe(expected);
    } finally {
      vi.useRealTimers();
      if (originalTz === undefined) delete process.env['TZ'];
      else process.env['TZ'] = originalTz;
    }
    expect(siteTime(instant, 'America/New_York').offset).toBe('-04:00');
  });

  it('[DI-27] only IANA Area/Location zones are accepted, in TypeScript and in SQL alike', async () => {
    for (const [zone, ok] of [
      ['Asia/Kolkata', true],
      ['Europe/Berlin', true],
      ['America/Argentina/Buenos_Aires', true],
      ['UTC', true],
      ['IST', false],
      ['EST', false],
      ['+05:30', false],
      ['Mars/Olympus', false],
      ['', false],
    ] as const) {
      expect([zone, isValidTimeZone(zone)]).toEqual([zone, ok]);
      const { rows } = await db.app.query<{ v: boolean }>('select platform.is_valid_time_zone($1) as v', [zone]);
      expect([zone, rows[0]?.v]).toEqual([zone, ok]);
    }
    expect(() => siteTime(at('2026-01-01T00:00:00Z'), 'IST')).toThrow('EBMR-PLAT-017');
  });
});

describe('instants and durations', () => {
  it('[DI-27] instants keep the database precision of microseconds and parse any offset', () => {
    const a = at('2026-03-29 03:30:00.123456+02');
    expect(a.toIsoString()).toBe('2026-03-29T01:30:00.123456Z');
    expect(at('2026-03-29T07:00:00.123456+05:30').compare(a)).toBe(0);
    expect(Instant.fromEpochMicros(a.epochMicros.toString()).toIsoString()).toBe(a.toIsoString());
    expect(at('1969-12-31T23:59:59.999999Z').epochMicros).toBe(-1n);
    expect(at('1969-12-31T23:59:59.999999Z').toIsoString()).toBe('1969-12-31T23:59:59.999999Z');
    expect(() => at('2026-02-30T00:00:00Z')).toThrow(RangeError);
    expect(() => at('2026-03-29 03:30:00')).toThrow(RangeError);
  });

  it('[DI-27] durations are exact bigint microseconds', () => {
    expect(durationMicros(at('2026-01-01T00:00:00Z'), at('2026-01-01T00:00:00.000001Z'))).toBe(1n);
    expect(formatDuration(90_061_000_001n)).toBe('25:01:01.000001');
    expect(formatDuration(-1_500_000n)).toBe('-0:00:01.500000');
    expect(microsToSeconds(-1_500_000n)).toBe('-1.500000');
    expect(microsToSeconds(12n)).toBe('0.000012');
  });

  it('[DI-27] database instants read as epoch microseconds round-trip exactly', async () => {
    const { rows } = await db.app.query<{ us: string; t: string }>(
      "select platform.epoch_micros(t)::text as us, t::text as t from (select '2026-10-25 01:30:00.654321+00'::timestamptz as t) x",
    );
    const fromMicros = Instant.fromEpochMicros(rows[0]?.us ?? '0');
    expect(fromMicros.compare(at(rows[0]?.t ?? ''))).toBe(0);
    expect(fromMicros.toIsoString()).toBe('2026-10-25T01:30:00.654321Z');
  });
});
