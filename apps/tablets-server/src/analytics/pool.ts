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

/** The runner's own login (kernel 1240): LOGIN, NOINHERIT, member of nothing, no elevated attribute. */
export const ANALYTICS_ROLE = 'ebmr_analytics';

/** What the database says the runner's connection is (analyticsRoleProblem). */
export interface AnalyticsRoleFacts {
  current_user: string;
  session_user: string;
  rolsuper: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
  member_of: string[];
}

/**
 * Phase 7 slice 7b-1 (Phase 6A residual P6A7-8; draft control DI-51): what is wrong with the role the runner's
 * connection runs as, or null. The runner reads GMP inputs with no GMP privilege only when it is ebmr_analytics itself
 * (current and session user), with no elevated attribute (superuser, create role, create database, replication, bypass
 * row-level security) and a member of no other role: a misconfigured EBMR_DB_ANALYTICS_URL naming another login would
 * otherwise run it with that login's rights.
 */
export function analyticsRoleProblems(f: AnalyticsRoleFacts | undefined): string[] {
  if (f === undefined) return ['the database did not describe the connection\'s role'];
  const problems: string[] = [];
  if (f.current_user !== ANALYTICS_ROLE || f.session_user !== ANALYTICS_ROLE) {
    problems.push(`it connects as ${f.session_user} acting as ${f.current_user}, not as ${ANALYTICS_ROLE}`);
  }
  const elevated = ([['rolsuper', 'superuser'], ['rolcreaterole', 'create role'], ['rolcreatedb', 'create database'], ['rolreplication', 'replication'],
    ['rolbypassrls', 'bypass row-level security']] as const).filter(([k]) => f[k]).map(([, name]) => name);
  if (elevated.length > 0) problems.push(`the role has the elevated attribute(s) ${elevated.join(', ')}`);
  if (f.member_of.length > 0) problems.push(`the role is a member of ${f.member_of.join(', ')}`);
  return problems;
}

/** Asks the database what the runner's connection runs as; the problem (analyticsRoleProblems), or null when none. */
export async function analyticsRoleProblem(pool: pg.Pool): Promise<string | null> {
  const { rows } = await queryRetrying<AnalyticsRoleFacts>(pool, `
    select current_user::text as current_user, session_user::text as session_user, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls,
           array(select b.rolname::text from pg_catalog.pg_auth_members m join pg_catalog.pg_roles b on b.oid = m.roleid where m.member = r.oid order by 1) as member_of
      from pg_catalog.pg_roles r where r.rolname = current_user`);
  const problems = analyticsRoleProblems(rows[0]);
  return problems.length === 0 ? null : problems.join('; ');
}
