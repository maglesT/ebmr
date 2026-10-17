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

const asText = (v: string): string => v;
function typeParser(oid: number, format?: 'text' | 'binary'): unknown {
  return AS_TEXT.has(oid) ? asText : (pg.types.getTypeParser(oid, format ?? 'text') as unknown);
}
const types = { getTypeParser: typeParser as typeof pg.types.getTypeParser };

export function createAnalyticsPool(url: string): pg.Pool {
  return new pg.Pool({ connectionString: url, max: 1, idleTimeoutMillis: 60_000, types, application_name: 'ebmr-analytics-runner' });
}

/** PostgreSQL's too_many_connections: the role's connection limit (4) is reached on the cluster. */
const TOO_MANY = '53300';

/**
 * A connection of the runner's pool, waiting while the analytics role's connection limit is reached (another
 * installation's runner, a reporting replica switch-over), up to `attempts` times `waitMs`; other errors at once.
 */
export async function connectRetrying(pool: pg.Pool, attempts = 20, waitMs = 500): Promise<pg.PoolClient> {
  for (let i = 1; ; i += 1) {
    try {
      return await pool.connect();
    } catch (error) {
      if ((error as { code?: unknown }).code !== TOO_MANY || i >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

/** One query on a connection of the runner's pool (connectRetrying). */
export async function queryRetrying<T extends pg.QueryResultRow>(pool: pg.Pool, text: string, values: unknown[] = []): Promise<pg.QueryResult<T>> {
  const client = await connectRetrying(pool);
  try {
    return await client.query<T>(text, values);
  } finally {
    client.release();
  }
}
