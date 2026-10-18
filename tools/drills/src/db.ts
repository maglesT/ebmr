/**
 * Database helpers of the drills: connections with the comparison session settings (UTC, ISO dates, fixed float and
 * bytea output, as the kernel's restore drill reads), the list of tables, and the audit-chain and anchor verification
 * the kernel's restore drill runs (kernel.verify_all_chains, records.verify_anchor).
 */
import pg from 'pg';
import { continuity } from '@ebmr/kernel';

export const SESSION_SETTINGS = [
  "set timezone = 'UTC'",
  "set datestyle = 'ISO, YMD'",
  "set intervalstyle = 'postgres'",
  'set extra_float_digits = 3',
  "set bytea_output = 'hex'",
];

export const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

export function databaseOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

/** A client in the comparison settings. */
export async function connect(url: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url });
  // A copy dropped while a client is still open (a failed drill's clean-up) ends the client; that is not an error here.
  c.on('error', () => undefined);
  await c.connect();
  for (const s of SESSION_SETTINGS) await c.query(s);
  return c;
}

export async function withClient<T>(url: string, work: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = await connect(url);
  try {
    return await work(c);
  } finally {
    await c.end();
  }
}

export interface TableRef {
  schema: string;
  name: string;
  qualified: string;
  category: continuity.TableCategory;
}

/** Every ordinary table outside the catalogs and outside `exclude` schemas, ordered by schema and name. */
export async function listTables(c: pg.Client, exclude: readonly string[] = []): Promise<TableRef[]> {
  const { rows } = await c.query<{ schema: string; name: string }>(
    `select n.nspname as schema, c.relname as name
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r' and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_(toast|temp)'
        and not (n.nspname = any($1::text[]))
      order by n.nspname, c.relname`,
    [exclude],
  );
  return rows.map((r) => ({ ...r, qualified: `${quoteIdent(r.schema)}.${quoteIdent(r.name)}`, category: continuity.tableCategory(r.schema, r.name) }));
}

/** The columns of a table in their order. */
export async function columnsOf(c: pg.Client, t: TableRef): Promise<string[]> {
  const { rows } = await c.query<{ name: string }>(
    `select a.attname as name from pg_attribute a
      where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped order by a.attnum`,
    [t.qualified],
  );
  return rows.map((r) => r.name);
}

export interface ChainCheck {
  chains: number;
  anchors: number;
  problems: string[];
}

/** Every audit chain and every external anchor verified, as the kernel's restore drill verifies them. */
export async function verifyChains(c: pg.Client): Promise<ChainCheck> {
  const chains = await c.query<{ n: string }>('select count(*)::text as n from kernel.chain_keys()');
  const anchors = await c.query<{ n: string }>('select count(*)::text as n from kernel.audit_anchor');
  const cp = await c.query<{ chain_key: string; seq: string | null; problem: string }>('select v.chain_key, v.seq::text, v.problem from kernel.verify_all_chains() v');
  const purgeAware = await c.query<{ ok: boolean }>("select to_regprocedure('records.verify_anchor(bigint)') is not null as ok");
  const fn = purgeAware.rows[0]?.ok ? 'records.verify_anchor' : 'kernel.verify_anchor';
  const ap = await c.query<{ id: string; problem: string }>(`select a.id::text, p.problem from kernel.audit_anchor a cross join lateral ${fn}(a.id) p order by a.id`);
  return {
    chains: Number(chains.rows[0]?.n ?? 0),
    anchors: Number(anchors.rows[0]?.n ?? 0),
    problems: [...cp.rows.map((r) => `${r.chain_key} seq ${r.seq ?? '-'}: ${r.problem}`), ...ap.rows.map((r) => `anchor ${r.id}: ${r.problem}`)],
  };
}

/**
 * Creates `name` as a copy of `template` (no connection may be open on the template), closed to PUBLIC and opened to
 * the installation's own roles by its connect policy (sandbox.apply_connect_policy, as a test environment is).
 */
export async function copyDatabase(adminUrl: string, template: string, name: string): Promise<void> {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    await c.query(`create database ${quoteIdent(name)} template ${quoteIdent(template)}`);
    await c.query(`revoke connect, temporary on database ${quoteIdent(name)} from public`);
  } finally {
    await c.end();
  }
  await withClient(withDatabase(adminUrl, name), async (x) => {
    const has = await x.query<{ ok: boolean }>("select to_regprocedure('sandbox.apply_connect_policy()') is not null as ok");
    if (has.rows[0]?.ok) await x.query('select sandbox.apply_connect_policy()');
  });
}

export async function dropDatabase(adminUrl: string, name: string): Promise<void> {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    await c.query(`drop database if exists ${quoteIdent(name)} with (force)`);
  } finally {
    await c.end();
  }
}

export async function databaseSize(c: pg.Client): Promise<number> {
  const { rows } = await c.query<{ n: string }>('select pg_database_size(current_database())::text as n');
  return Number(rows[0]?.n ?? 0);
}

/** Wall-clock milliseconds between two process.hrtime.bigint() readings (drill durations, not GMP values). */
export const elapsedMs = (start: bigint): number => Number((process.hrtime.bigint() - start) / 1_000_000n);
