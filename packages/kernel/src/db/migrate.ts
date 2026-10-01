/**
 * Versioned SQL migrations (build outline 4.4). Each file runs once, in order, in its own
 * transaction. The runner stores a SHA-256 of every applied file and refuses to continue if an
 * applied file has since changed: a released migration is never edited, a new one is added.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';

export interface MigrationSource {
  /** Namespace so kernel, site-services and edition migrations never collide, e.g. "kernel". */
  namespace: string;
  directory: string;
  /** Optional filter on file names (used by tests that build only part of the schema). */
  include?: RegExp;
}

export interface AppliedMigration {
  namespace: string;
  name: string;
  checksum: string;
}

const checksum = (sql: string): string => createHash('sha256').update(sql).digest('hex');

export async function migrate(client: pg.Client, sources: MigrationSource[]): Promise<AppliedMigration[]> {
  await client.query(`
    create table if not exists public.schema_migration (
      namespace text not null,
      name text not null,
      checksum text not null,
      applied_at timestamptz not null default clock_timestamp(),
      primary key (namespace, name)
    )`);
  const applied: AppliedMigration[] = [];
  for (const source of sources) {
    const files = readdirSync(source.directory).filter((f) => f.endsWith('.sql') && (!source.include || source.include.test(f))).sort();
    const { rows } = await client.query<{ name: string; checksum: string }>(
      'select name, checksum from public.schema_migration where namespace = $1',
      [source.namespace],
    );
    const done = new Map(rows.map((r) => [r.name, r.checksum]));
    for (const file of files) {
      const sql = readFileSync(join(source.directory, file), 'utf8');
      const sum = checksum(sql);
      const previous = done.get(file);
      if (previous !== undefined) {
        if (previous !== sum) throw new Error(`migration ${source.namespace}/${file} changed after it was applied`);
        continue;
      }
      await client.query('begin');
      try {
        // Roles are shared by every database of the cluster: two databases migrated at once (the test projects' set-ups
        // on a fresh cluster, a GMP and a sandbox installation upgraded together) would both find a role missing, both
        // create it, and one would fail. This self-conflicting lock on the role catalogue, taken before anything else,
        // makes migration transactions across the cluster run one at a time; logins only read it and never wait.
        await client.query('lock table pg_catalog.pg_authid in share row exclusive mode');
        await client.query(sql);
        await client.query('insert into public.schema_migration (namespace, name, checksum) values ($1, $2, $3)', [source.namespace, file, sum]);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw new Error(`migration ${source.namespace}/${file} failed: ${(error as Error).message}`, { cause: error });
      }
      applied.push({ namespace: source.namespace, name: file, checksum: sum });
    }
  }
  return applied;
}

export const KERNEL_MIGRATIONS: MigrationSource = {
  namespace: 'kernel',
  directory: new URL('../../sql', import.meta.url).pathname,
};
