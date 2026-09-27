/**
 * UTC instants with microsecond precision, as PostgreSQL stores them (build outline 5.6).
 *
 * GMP times come from the database clock. JavaScript `Date` keeps only milliseconds and
 * `number` arithmetic is not exact enough for GMP durations, so instants are held as a bigint
 * count of microseconds since 1970-01-01T00:00:00Z and durations as bigint microseconds.
 * Read times from the database as text (`recorded_at::text`) or as epoch microseconds
 * (`platform.epoch_micros(recorded_at)::text`), never through `Date`, when precision matters.
 */

const MICROS_PER_MS = 1000n;
const MICROS_PER_SECOND = 1_000_000n;

// 2026-03-29 01:00:00.123456+00, 2026-03-29T01:00:00Z, 2026-03-29T06:30:00.5+05:30 ...
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?\s*(Z|[+-]\d{2}(?::?\d{2})?)$/;

export class Instant {
  private constructor(readonly epochMicros: bigint) {}

  static fromEpochMicros(value: bigint | string): Instant {
    const micros = typeof value === 'bigint' ? value : BigInt(value);
    return new Instant(micros);
  }

  /** Converts a `Date` (for example from node-postgres). Precision is limited to milliseconds. */
  static fromDate(date: Date): Instant {
    const ms = date.getTime();
    if (!Number.isFinite(ms)) throw new RangeError('invalid Date');
    return new Instant(BigInt(ms) * MICROS_PER_MS);
  }

  /** Parses ISO 8601 or PostgreSQL timestamptz text. An explicit offset or Z is required. */
  static parse(text: string): Instant {
    const m = TIMESTAMP.exec(text.trim());
    if (!m) throw new RangeError(`not a timestamp with offset: ${text}`);
    const group = (i: number): string => m[i] ?? '';
    const year = Number(group(1));
    const month = Number(group(2));
    const day = Number(group(3));
    const hour = Number(group(4));
    const minute = Number(group(5));
    const second = Number(group(6));
    const frac = group(7);
    const zone = group(8);
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
      throw new RangeError(`timestamp out of range: ${text}`);
    }
    const wholeMs = Date.UTC(year, month - 1, day, hour, minute, second);
    const check = new Date(wholeMs);
    if (check.getUTCDate() !== day || check.getUTCMonth() !== month - 1) throw new RangeError(`no such calendar date: ${text}`);
    const fraction = BigInt(frac.padEnd(6, '0').slice(0, 6));
    let offsetMicros = 0n;
    if (zone !== 'Z') {
      const digits = zone.replace(':', '');
      const sign = digits.startsWith('-') ? -1n : 1n;
      const oh = BigInt(digits.slice(1, 3));
      const om = BigInt(digits.length > 3 ? digits.slice(3, 5) : '0');
      offsetMicros = sign * (oh * 3600n + om * 60n) * MICROS_PER_SECOND;
    }
    return new Instant(BigInt(wholeMs) * MICROS_PER_MS + fraction - offsetMicros);
  }

  /** Milliseconds-precision `Date` (for Intl formatting only; drops sub-millisecond digits). */
  toDate(): Date {
    return new Date(Number(floorDiv(this.epochMicros, MICROS_PER_MS)));
  }

  /** ISO 8601 in UTC with six fractional digits, e.g. 2026-03-29T01:00:00.000000Z. */
  toIsoString(): string {
    const seconds = floorDiv(this.epochMicros, MICROS_PER_SECOND);
    const micros = this.epochMicros - seconds * MICROS_PER_SECOND;
    const base = new Date(Number(seconds) * 1000).toISOString().slice(0, 19);
    return `${base}.${micros.toString().padStart(6, '0')}Z`;
  }

  compare(other: Instant): -1 | 0 | 1 {
    return this.epochMicros < other.epochMicros ? -1 : this.epochMicros > other.epochMicros ? 1 : 0;
  }

  isBefore(other: Instant): boolean {
    return this.epochMicros < other.epochMicros;
  }

  isAfter(other: Instant): boolean {
    return this.epochMicros > other.epochMicros;
  }

  plusMicros(micros: bigint): Instant {
    return new Instant(this.epochMicros + micros);
  }
}

/** Duration from `from` to `to` in microseconds; UTC-based, so DST changes cannot distort it. */
export function durationMicros(from: Instant, to: Instant): bigint {
  return to.epochMicros - from.epochMicros;
}

/** Formats a duration as [-]H:MM:SS(.ffffff when not whole seconds). */
export function formatDuration(micros: bigint): string {
  const sign = micros < 0n ? '-' : '';
  const abs = micros < 0n ? -micros : micros;
  const totalSeconds = abs / MICROS_PER_SECOND;
  const fraction = abs % MICROS_PER_SECOND;
  const hours = totalSeconds / 3600n;
  const minutes = (totalSeconds % 3600n) / 60n;
  const seconds = totalSeconds % 60n;
  const base = `${sign}${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  return fraction === 0n ? base : `${base}.${fraction.toString().padStart(6, '0')}`;
}

/** Microseconds as a decimal string of seconds, e.g. -1500000n -> "-1.500000". */
export function microsToSeconds(micros: bigint): string {
  const sign = micros < 0n ? '-' : '';
  const abs = micros < 0n ? -micros : micros;
  return `${sign}${abs / MICROS_PER_SECOND}.${(abs % MICROS_PER_SECOND).toString().padStart(6, '0')}`;
}

function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}
