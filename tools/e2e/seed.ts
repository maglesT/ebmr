/**
 * The end-to-end set-up built once per CI run (Stage C part 2, lead approval of 14 November 2026). `setupStack` with the
 * packaging option takes about 13 minutes of signed acts; 23 of the 25 groups need exactly the same set-up, so one job
 * builds it, dumps it and every group restores it in about a minute.
 *
 * A seed directory holds: globals.sql (the cluster's roles, pg_dumpall --globals-only: the kernel's login roles are
 * cluster objects a database dump leaves out), one custom-format dump per database (pg_dump -Fc, restored with --create
 * under the same name: each group's job has its own PostgreSQL, so the names need not differ), the keys and exchange
 * directories as files, and meta.json (the options it was built with, its databases, and its fingerprint).
 *
 * The fingerprint (row counts of every table, the value of every sequence, a SHA-256 of every key and exchange file) is
 * taken at build time and again after each restore; a restore that differs fails the group's set-up. A main full run
 * also compares the seed with a set-up built fresh in the same run (seed-cli.ts check; the lead's condition 3).
 *
 * Usage: seed-cli.ts build <dir> | restore <dir> | check <seed dir> <fresh dir>.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import pg from 'pg';
import { REPO_ROOT, setupStack } from '@ebmr/demo';

const ADMIN_URL = process.env['EBMR_PG_ADMIN_URL'] ?? 'postgres://ebmr_dev:ebmr_dev@localhost:5432/postgres';

/** The options of the set-up a seed stands for: the base set-up of every group but 'records' and 'p3-demo'. */
export const SEED_OPTIONS = { gmpReviewBatch: true, gmpPackaging: true, gmpSrProfile: false, gmpP3Demo: false } as const;

export interface Fingerprint {
  /** Per database (GMP, SANDBOX): `schema.table` -> row count, and `schema.sequence` -> last value (or null). */
  tables: Record<string, Record<string, string>>;
  sequences: Record<string, Record<string, string | null>>;
  /** Path (relative to the seed root) -> SHA-256 of every file under the keys and exchange directories. */
  files: Record<string, string>;
}

export interface SeedMeta {
  options: typeof SEED_OPTIONS;
  personaSets: number;
  databases: { GMP: string; SANDBOX: string };
  /** The keys and exchange directories, relative to the repository root (var/e2e/<hex>/...). */
  keysDir: string;
  exchangeDir: string;
  fingerprint: Fingerprint;
}

const urlOf = (database: string): string => {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${database}`;
  return u.toString();
};

function* filesUnder(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir).sort()) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* filesUnder(p);
    else yield p;
  }
}

const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Row counts, sequence values and file digests of a set-up (its databases, its keys and exchange directories). */
export async function fingerprint(databases: { GMP: string; SANDBOX: string }, root: string): Promise<Fingerprint> {
  const tables: Fingerprint['tables'] = {};
  const sequences: Fingerprint['sequences'] = {};
  for (const [kind, database] of Object.entries(databases)) {
    const c = new pg.Client({ connectionString: urlOf(database) });
    await c.connect();
    try {
      const t: Record<string, string> = {};
      const rels = await c.query<{ s: string; n: string }>(
        `select n.nspname as s, c.relname as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%'
          order by 1, 2`,
      );
      for (const r of rels.rows) {
        const q = `select count(*)::text as n from ${pg.escapeIdentifier(r.s)}.${pg.escapeIdentifier(r.n)}`;
        t[`${r.s}.${r.n}`] = (await c.query<{ n: string }>(q)).rows[0]?.n ?? '0';
      }
      tables[kind] = t;
      const seqs = await c.query<{ s: string; n: string; v: string | null }>(
        `select schemaname as s, sequencename as n, last_value::text as v from pg_sequences order by 1, 2`,
      );
      sequences[kind] = Object.fromEntries(seqs.rows.map((r) => [`${r.s}.${r.n}`, r.v]));
    } finally {
      await c.end();
    }
  }
  const files: Record<string, string> = {};
  for (const f of filesUnder(root)) files[relative(root, f)] = sha(f);
  return { tables, sequences, files };
}

/** The differences between two fingerprints, one line each (empty: equal). `files: false` leaves the digests out. */
export function differences(a: Fingerprint, b: Fingerprint, opts: { files?: boolean } = {}): string[] {
  const out: string[] = [];
  const compare = (what: string, x: Readonly<Record<string, string | null>>, y: Readonly<Record<string, string | null>>): void => {
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (x[k] !== y[k]) out.push(`${what} ${k}: ${x[k] ?? 'absent'} != ${y[k] ?? 'absent'}`);
    }
  };
  for (const kind of new Set([...Object.keys(a.tables), ...Object.keys(b.tables)])) {
    compare(`${kind} rows`, a.tables[kind] ?? {}, b.tables[kind] ?? {});
    compare(`${kind} sequence`, a.sequences[kind] ?? {}, b.sequences[kind] ?? {});
  }
  if (opts.files !== false) compare('file', a.files, b.files);
  return out;
}

const run = (cmd: string, args: string[], input?: string): string =>
  execFileSync(cmd, args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });

/** Builds the base set-up under fresh names and writes it, dumped, with its fingerprint, to `dir`. */
export async function buildSeed(dir: string, personaSets: number): Promise<SeedMeta> {
  const hex = randomBytes(5).toString('hex');
  const databases = { GMP: `ebmr_tablets_e2e_${hex}`, SANDBOX: `ebmr_sandbox_tablets_e2e_${hex}` };
  const root = join(REPO_ROOT, 'var', 'e2e', hex);
  const keysDir = join(root, 'keys');
  const exchangeDir = join(root, 'exchange');
  mkdirSync(keysDir, { recursive: true });
  await setupStack({ databases, keysDir, exchangeDir, personaSets, echo: false, ...SEED_OPTIONS });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'globals.sql'), run('pg_dumpall', ['--globals-only', `--dbname=${ADMIN_URL}`]));
  for (const [kind, database] of Object.entries(databases)) run('pg_dump', ['-Fc', '--create', `--file=${join(dir, `${kind}.dump`)}`, `--dbname=${urlOf(database)}`]);
  cpSync(root, join(dir, 'files'), { recursive: true });
  const meta: SeedMeta = {
    options: SEED_OPTIONS, personaSets, databases,
    keysDir: relative(REPO_ROOT, keysDir), exchangeDir: relative(REPO_ROOT, exchangeDir),
    fingerprint: await fingerprint(databases, root),
  };
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  return meta;
}

export function readSeedMeta(dir: string): SeedMeta {
  return JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as SeedMeta;
}

/**
 * Restores a seed into this job's cluster under its own names and paths and checks that its fingerprint is the one the
 * seed recorded. Returns the set-up's databases and directories (absolute), as setupStack's caller knows them.
 */
export async function restoreSeed(dir: string): Promise<{ databases: SeedMeta['databases']; keysDir: string; exchangeDir: string }> {
  const meta = readSeedMeta(dir);
  // The roles: a role that already exists (the cluster's own superuser) is reported and left as it is.
  run('psql', ['-q', '-v', 'ON_ERROR_STOP=0', `--dbname=${ADMIN_URL}`, '-f', join(dir, 'globals.sql')]);
  for (const kind of ['GMP', 'SANDBOX'] as const) {
    run('pg_restore', ['--create', '--exit-on-error', `--dbname=${ADMIN_URL}`, join(dir, `${kind}.dump`)]);
  }
  const keysDir = resolve(REPO_ROOT, meta.keysDir);
  const exchangeDir = resolve(REPO_ROOT, meta.exchangeDir);
  const root = resolve(keysDir, '..');
  cpSync(join(dir, 'files'), root, { recursive: true });
  const diff = differences(meta.fingerprint, await fingerprint(meta.databases, root));
  if (diff.length > 0) throw new Error(`the restored set-up differs from the seed (${diff.length}):\n${diff.slice(0, 40).join('\n')}`);
  return { databases: meta.databases, keysDir, exchangeDir };
}
