/**
 * The runner's own connection (ADR 0020 point 3; D-6A-1-12): one connection as ebmr_analytics, which reads the
 * catalogued inputs and executes the analytics record functions and nothing else (the segregation check reports any
 * other grant). Times, dates and numbers come back as the database's text: a GMP value never becomes a JavaScript
 * number or Date on the way in (statOf, in @ebmr/analytics, is the only conversion), and the canonical row hash is
 * the same on every read.
 */
import pg from 'pg';

/** Type oids kept as text: int8, numeric, date, time, timestamp, timestamptz, timetz, interval and their arrays. */
const AS_TEXT = new Set([20, 1700, 1082, 1083, 1114, 1184, 1266, 1186, 1016, 1231, 1182, 1183, 1115, 1185, 1270, 1187]);

const types = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
    AS_TEXT.has(oid) ? (v: string) => v : pg.types.getTypeParser(oid, format ?? 'text')) as typeof pg.types.getTypeParser,
};

export function createAnalyticsPool(url: string): pg.Pool {
  return new pg.Pool({ connectionString: url, max: 1, idleTimeoutMillis: 60_000, types, application_name: 'ebmr-analytics-runner' });
}
