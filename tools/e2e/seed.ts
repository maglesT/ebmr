/**
 * The end-to-end set-up built once per CI run (Stage C part 2, lead approval of 14 November 2026). `setupStack` with the
 * packaging option takes about 13 minutes of signed acts; 23 of the 25 groups need exactly the same set-up, so one job
 * builds it and every group starts from it.
 *
 * The seed is a physical snapshot of the cluster (lead ruling on #268, 14 November 2026). The seed job builds the set-up
 * (`build`), then tools/ci/start-postgres.sh `snapshot` stops PostgreSQL cleanly and tars its data directory into the
 * seed directory as cluster.tar; each group starts its cluster with `start --from-seed`, the snapshot in place of its
 * data directory, and `attachSeed` checks that the cluster is the seed. A logical dump and restore (pg_dump/pg_restore,
 * the first version of this file) gave every database a new oid and so a new incarnation (kernel 0600:
 * continuity.current_incarnation(), the system identifier, timeline, database oid and continuity.counter's oid): the
 * numbering ceilings the set-up had reserved were then refused, rightly, with EBMR-CONT-012 until the restore procedure
 * ran (DI-45, INV-27; seen as [IN-53] controlled.spec.ts in group rest). The groups never run that procedure, and the
 * incarnation is never faked: the physical copy simply is the same incarnation.
 *
 * A seed directory holds cluster.tar and cluster.tar.env (the snapshot, written by start-postgres.sh), the keys and
 * exchange directories as files (files/), and meta.json: the options it was built with, its databases, each database's
 * incarnation and the set-up's fingerprint.
 *
 * The fingerprint (row counts of every table, the value of every sequence, a SHA-256 of every key and exchange file) is
 * taken at build time and again when a group attaches the seed; a cluster that differs fails the group's set-up. A
 * main full run also compares the seed with a set-up built fresh in the same run (seed-cli.ts check; the lead's
 * condition 3).
 *
 * Usage: seed-cli.ts build <dir> | check <dir>.
 */
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
  /** continuity.current_incarnation() of each database when the seed was built; a group's must be the same. */
  incarnations: { GMP: string; SANDBOX: string };
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

/** The kernel's incarnation of each database (kernel 0600), as the numbering ceilings were reserved under it. */
export async function incarnations(databases: { GMP: string; SANDBOX: string }): Promise<{ GMP: string; SANDBOX: string }> {
  const out = { GMP: '', SANDBOX: '' };
  for (const kind of ['GMP', 'SANDBOX'] as const) {
    const c = new pg.Client({ connectionString: urlOf(databases[kind]) });
    await c.connect();
    try {
      out[kind] = (await c.query<{ i: string }>('select continuity.current_incarnation() as i')).rows[0]?.i ?? '';
    } finally {
      await c.end();
    }
  }
  return out;
}

/**
 * Builds the base set-up under fresh names and writes its files, incarnations and fingerprint to `dir`. The cluster
 * itself goes into the seed next, as its snapshot (start-postgres.sh snapshot <dir>/cluster.tar, the seed job's next
 * step), so nothing may write to it in between.
 */
export async function buildSeed(dir: string, personaSets: number): Promise<SeedMeta> {
  const hex = randomBytes(5).toString('hex');
  const databases = { GMP: `ebmr_tablets_e2e_${hex}`, SANDBOX: `ebmr_sandbox_tablets_e2e_${hex}` };
  const root = join(REPO_ROOT, 'var', 'e2e', hex);
  const keysDir = join(root, 'keys');
  const exchangeDir = join(root, 'exchange');
  mkdirSync(keysDir, { recursive: true });
  await setupStack({ databases, keysDir, exchangeDir, personaSets, echo: false, ...SEED_OPTIONS });
  mkdirSync(dir, { recursive: true });
  cpSync(root, join(dir, 'files'), { recursive: true });
  const meta: SeedMeta = {
    options: SEED_OPTIONS, personaSets, databases, incarnations: await incarnations(databases),
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
 * Attaches the seed in this job's cluster, which start-postgres.sh started from the seed's snapshot: checks that the
 * cluster holds the seed's databases under the seed's incarnations and the seed's fingerprint, then puts the keys and
 * exchange files back where the set-up keeps them. Returns the set-up's databases and directories (absolute), as
 * setupStack's caller knows them. A cluster that is not the seed fails here, loudly: it is never patched to look like it.
 */
export async function attachSeed(dir: string): Promise<{ databases: SeedMeta['databases']; keysDir: string; exchangeDir: string }> {
  const meta = readSeedMeta(dir);
  const c = new pg.Client({ connectionString: ADMIN_URL });
  await c.connect();
  let present: string[];
  try {
    present = (await c.query<{ d: string }>('select datname as d from pg_database where datname = any($1::text[])', [Object.values(meta.databases)])).rows.map((r) => r.d);
  } finally {
    await c.end();
  }
  const missing = Object.values(meta.databases).filter((d) => !present.includes(d));
  if (missing.length > 0) throw new Error(`this cluster was not started from the seed in ${dir} (start-postgres.sh start --from-seed): no ${missing.join(', ')}`);
  const now = await incarnations(meta.databases);
  for (const kind of ['GMP', 'SANDBOX'] as const) {
    if (now[kind] !== meta.incarnations[kind]) throw new Error(`the ${kind} database's incarnation is ${now[kind]}, the seed's was ${meta.incarnations[kind]}: not the seed's cluster`);
  }
  const keysDir = resolve(REPO_ROOT, meta.keysDir);
  const exchangeDir = resolve(REPO_ROOT, meta.exchangeDir);
  const root = resolve(keysDir, '..');
  cpSync(join(dir, 'files'), root, { recursive: true });
  const diff = differences(meta.fingerprint, await fingerprint(meta.databases, root));
  if (diff.length > 0) throw new Error(`the seed's cluster differs from the seed (${diff.length}):\n${diff.slice(0, 40).join('\n')}`);
  return { databases: meta.databases, keysDir, exchangeDir };
}
