/**
 * Instants from ISO 8601 text with an explicit zone ("2026-09-28T10:15:30.123456Z" or
 * "+05:30"), exact to the microsecond (PostgreSQL timestamptz precision). No Date object, no
 * locale and no time-zone database: the offset in the text is applied arithmetically.
 */
import { DecError } from '../decimal/dec.ts';

const ISO = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,6}))?(Z|[+-][0-9]{2}:[0-9]{2})$/;

function daysFromCivil(y: number, m: number, d: number): number {
  // Howard Hinnant's algorithm (proleptic Gregorian calendar), integers only.
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = (m + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function daysInMonth(y: number, m: number): number {
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] ?? 0;
}

/** Microseconds since the Unix epoch. Throws DecError('DEC_SYNTAX') for anything malformed. */
export function parseInstant(text: string): bigint {
  const m = typeof text === 'string' ? ISO.exec(text) : null;
  if (m === null) {
    throw new DecError('DEC_SYNTAX', `"${String(text).slice(0, 40)}" is not an instant: use ISO 8601 with a zone, e.g. 2026-09-28T10:15:30Z or 2026-09-28T15:45:30+05:30`);
  }
  const [year, month, day, hour, minute, second] = [m[1], m[2], m[3], m[4], m[5], m[6]].map((s) => Number(s));
  if (year === undefined || month === undefined || day === undefined || hour === undefined || minute === undefined || second === undefined) {
    throw new DecError('DEC_SYNTAX', 'malformed instant');
  }
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59) {
    throw new DecError('DEC_SYNTAX', `"${text}" is not a real date and time`);
  }
  const fraction = (m[7] ?? '').padEnd(6, '0');
  const zone = m[8] ?? 'Z';
  let offsetMinutes = 0;
  if (zone !== 'Z') {
    const oh = Number(zone.slice(1, 3));
    const om = Number(zone.slice(4, 6));
    if (oh > 23 || om > 59) throw new DecError('DEC_SYNTAX', `"${text}" has an impossible zone offset`);
    offsetMinutes = (zone.startsWith('-') ? -1 : 1) * (oh * 60 + om);
  }
  const days = BigInt(daysFromCivil(year, month, day));
  const seconds = days * 86400n + BigInt(hour * 3600 + minute * 60 + second) - BigInt(offsetMinutes * 60);
  return seconds * 1_000_000n + BigInt(fraction);
}
