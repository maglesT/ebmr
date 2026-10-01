/**
 * Two databases of one cluster migrated at the same time: roles are shared by the whole cluster, so a migration that
 * creates a role when it is missing must not fail in one database because the other created it first. The vitest
 * projects' global set-ups do exactly this on a fresh cluster (a CI runner).
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.ts';
import { ADMIN_URL, urlFor } from '../support/db.ts';

const suffix = randomBytes(5).toString('hex');
const role = `ebmr_migrate_race_${suffix}`;
const databases = [`ebmr_migrate_race_${suffix}_a`, `ebmr_migrate_race_${suffix}_b`];
let directory: string;

async function onServer<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: ADMIN_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'ebmr-migrate-race-'));
  // As kernel 0001 does for its roles: create the role only when it is missing. The pause between the check and the
  // creation makes both databases find it missing when nothing serialises them.
  writeFileSync(
    join(directory, '0001_role.sql'),
    `do $$
begin
  if not exists (select from pg_catalog.pg_roles where rolname = '${role}') then
    perform pg_catalog.pg_sleep(0.5);
    create role ${role} nologin;
  end if;
end $$;
`,
  );
  await onServer(async (s) => {
    for (const d of databases) await s.query(`create database ${d} template template0 encoding 'UTF8'`);
  });
});

afterAll(async () => {
  await onServer(async (s) => {
    for (const d of databases) await s.query(`drop database if exists ${d} with (force)`);
    await s.query(`drop role if exists ${role}`);
  });
  rmSync(directory, { recursive: true, force: true });
});

describe('migrations of two databases of one cluster at once', () => {
  it('a role both create when missing is created once, and both databases apply the migration', async () => {
    const clients = databases.map((d) => new pg.Client({ connectionString: urlFor(d) }));
    await Promise.all(clients.map((c) => c.connect()));
    try {
      const results = await Promise.allSettled(clients.map((c) => migrate(c, [{ namespace: 'race', directory }])));
      expect(results.map((r) => (r.status === 'fulfilled' ? r.value.map((m) => m.name) : String(r.reason)))).toEqual([['0001_role.sql'], ['0001_role.sql']]);
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
    const { rows } = await onServer((s) => s.query<{ n: number }>('select count(*)::int as n from pg_catalog.pg_roles where rolname = $1', [role]));
    expect(rows[0]?.n).toBe(1);
  });
});
