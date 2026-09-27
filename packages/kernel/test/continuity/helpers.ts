/**
 * Test helpers for the continuity module (and the site-services batch-number tests, which reuse them).
 * testActor is the ONLY place actor contexts are created (coordination rule); the lead will switch its
 * body to seed a real identity once the identity module lands.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { dumpDatabase, dropDatabase, restoreDatabase, type BackupArtefact } from '../../src/continuity/backup-drill.ts';
import { FileLedger } from '../../src/continuity/ledger.ts';
import type { ActorContext } from '../../src/db/command.ts';
import { seededTestActor } from '../support/seeded-actor.ts';
import { ADMIN_URL, urlFor, type TestDatabase } from '../support/db.ts';

export function testActor(db: TestDatabase, overrides: Partial<ActorContext> = {}): Promise<ActorContext> {
  return seededTestActor(db, overrides);
}

/** A temporary directory, removed by the returned cleanup function. */
export function tempDir(prefix: string): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), `ebmr-${prefix}-`));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

/** An external ledger outside the database (a file in a temporary directory). */
export function tempLedger(database: string, dir: string): FileLedger {
  return new FileLedger(join(dir, `${database}.ledger.jsonl`), { database });
}

/**
 * A stand-in for a module that issues protected numbers: an audited, insert-only table and a
 * SECURITY DEFINER issuing function (the pattern every owning module follows), plus a registered counter.
 */
export async function installNumberStub(db: TestDatabase, counterKey: string, blockSize: number): Promise<void> {
  const c = await db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local role ebmr_owner');
    await c.query(`
      create table if not exists testgmp.issued_number (
        id uuid primary key default gen_random_uuid(),
        counter_key text not null,
        value bigint not null,
        unique (counter_key, value))`);
    const registered = await c.query("select 1 from kernel.audited_table where table_name = 'testgmp.issued_number'::regclass");
    if (registered.rowCount === 0) {
      await c.query("select kernel.register_audited_table('testgmp.issued_number', 'number_sequence', 'counter_key', true)");
      await c.query(`
        create function testgmp.issue_number(p_key text) returns bigint
        language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
        declare v bigint;
        begin
          v := continuity.next_counter_value(p_key);
          insert into testgmp.issued_number (counter_key, value) values (p_key, v);
          return v;
        end $$`);
      await c.query('grant select on testgmp.issued_number to ebmr_app');
      await c.query('grant execute on function testgmp.issue_number(text) to ebmr_app');
    }
    await c.query("select continuity.register_protected_counter($1, 'OTHER', 'test', 'test counter', $2)", [counterKey, blockSize]);
    await c.query('commit');
  } catch (error) {
    await c.query('rollback');
    throw error;
  } finally {
    c.release();
  }
}

/** Backup of a test database (pg_dump custom format) into a directory. */
export async function backupTestDatabase(db: TestDatabase, dir: string, encryptionKey?: Buffer): Promise<BackupArtefact> {
  const now = await db.admin.query<{ t: string }>("select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as t");
  return dumpDatabase({
    sourceUrl: urlFor(db.name),
    directory: dir,
    backupId: `${db.name}-${randomBytes(4).toString('hex')}`,
    snapshotTakenAt: now.rows[0]?.t ?? '',
    ...(encryptionKey ? { encryptionKey } : {}),
  });
}

/** Restore a backup into a new database reachable by the application role (a simulated disaster restore). */
export async function restoreCopy(source: TestDatabase, artefact: BackupArtefact, dir: string, encryptionKey?: Buffer): Promise<TestDatabase> {
  const name = `${source.name}_r${randomBytes(3).toString('hex')}`;
  await restoreDatabase({
    adminUrl: ADMIN_URL,
    artefact,
    targetDatabase: name,
    sourceDatabase: source.name,
    isolate: false,
    workDir: dir,
    ...(encryptionKey ? { encryptionKey } : {}),
  });
  const admin = new pg.Pool({ connectionString: urlFor(name), max: 4 });
  const app = new pg.Pool({ connectionString: urlFor(name, { name: 'ebmr_app', password: 'ebmr_app' }), max: 4 });
  return {
    name,
    admin,
    app,
    async drop() {
      await admin.end();
      await app.end();
      await dropDatabase(ADMIN_URL, name);
    },
  };
}

/** Current database time as ISO 8601 UTC text. */
export async function dbTime(db: TestDatabase): Promise<string> {
  const { rows } = await db.app.query<{ t: string }>("select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as t");
  return rows[0]?.t ?? '';
}
