/**
 * The end-to-end seed is a physical snapshot of the cluster (lead ruling on #268, 14 November 2026; tools/e2e/seed.ts,
 * tools/ci/start-postgres.sh `snapshot` and `start --from-seed`). This test runs that path end to end on two private
 * clusters, the way the seed job and an end-to-end group do: a numbering ceiling is reserved and a number issued in the
 * seed job's cluster, the cluster is stopped and snapshotted, and a second cluster started from the snapshot carries
 * the same database incarnation (kernel 0600) and goes on issuing numbers: the restart retires the rest of the open
 * block, as any restart does, and the next block is reserved through the same ledger, above every number the seed job
 * could have issued. Nothing runs
 * the restore procedure and nothing touches the incarnation. A copy of the same database made inside the second cluster
 * (a new database oid, as a pg_dump/pg_restore seed made) is another incarnation, and the kernel refuses it numbers
 * (EBMR-CONT-012) until the restore procedure has run: the reason the seed is physical.
 *
 * initdb refuses root, so under root (a development container) the clusters run as the postgres user.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { migrate } from '../../../packages/kernel/src/db/migrate.ts';
import { withCommand } from '../../../packages/kernel/src/db/command.ts';
import { INCARNATION_CHANGED, withProtectedNumbers } from '../../../packages/kernel/src/continuity/numbers.ts';
import { installNumberStub, tempLedger, testActor } from '../../../packages/kernel/test/continuity/helpers.ts';
import { endPool, openPool, urlOn } from '../../../packages/kernel/test/harness/pools.ts';
import type { TestDatabase } from '../../../packages/kernel/test/support/db.ts';
import { templateSources } from '../../../packages/kernel/test/support/global-setup.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCRIPT = join(ROOT, 'tools/ci/start-postgres.sh');
const AS_ROOT = process.getuid?.() === 0;
const KEY = 'test.number:SEED';
const work = mkdtempSync(join(tmpdir(), 'ebmr-seed-snapshot-'));
chmodSync(work, 0o777);
const running: string[] = [];

/** Runs start-postgres.sh as a private cluster (EBMR_CI_HOST=private), its exports read from stdout, never a job's env. */
function script(args: string[], env: Record<string, string>): Record<string, string> {
  const vars = { EBMR_CI_HOST: 'private', GITHUB_ENV: '', GITHUB_PATH: '', ...env };
  const cmd = AS_ROOT
    ? ['sudo', '-u', 'postgres', 'env', ...Object.entries(vars).map(([k, v]) => `${k}=${v}`), 'bash', SCRIPT, ...args]
    : ['bash', SCRIPT, ...args];
  const r = spawnSync(cmd[0] as string, cmd.slice(1), { encoding: 'utf8', env: { ...process.env, ...vars }, cwd: work });
  if (r.status !== 0) throw new Error(`start-postgres.sh ${args.join(' ')} failed (${String(r.status)}): ${r.stderr.slice(-2000)}`);
  const out: Record<string, string> = {};
  for (const m of r.stdout.matchAll(/^export ([A-Z_]+)=(.*)$/gm)) out[m[1] as string] = (m[2] as string).replace(/^'(.*)'$/, '$1');
  return out;
}

/** The test database's pools, opened and ended as every test's are (kernel test harness pools.ts). */
function open(admin: string, database: string): TestDatabase {
  const db = {
    name: database,
    admin: openPool({ connectionString: urlOn(admin, database), max: 2 }),
    app: openPool({ connectionString: urlOn(admin, database, { name: 'ebmr_app', password: 'ebmr_app' }), max: 2 }),
    async drop() {
      await endPool(db.admin);
      await endPool(db.app);
    },
  };
  return db;
}

const incarnation = async (db: TestDatabase): Promise<string> =>
  (await db.admin.query<{ i: string }>('select continuity.current_incarnation() as i')).rows[0]?.i ?? '';

afterAll(() => {
  for (const data of running) {
    try {
      script(['stop'], { EBMR_CI_PGDATA: data });
    } catch {
      // already stopped
    }
  }
  rmSync(work, { recursive: true, force: true });
});

describe('the end-to-end seed as a physical snapshot (start-postgres.sh snapshot, start --from-seed)', () => {
  it('[DI-45] a cluster started from the seed\'s snapshot is the seed job\'s database incarnation and goes on issuing numbers, through the same ledger, above every number reserved before the snapshot; a logical copy is another incarnation and is refused them', { timeout: 600_000 }, async () => {
    // The seed job: its cluster, a migrated database, a ceiling reserved (ledger first) and the first number issued.
    const a = script(['start'], { EBMR_CI_PG_DIR: join(work, 'seed-job') });
    const aData = a['EBMR_CI_PGDATA'] as string;
    running.push(aData);
    const adminA = a['EBMR_PG_ADMIN_URL'] as string;
    const server = new pg.Client({ connectionString: adminA });
    await server.connect();
    await server.query('create database ebmr_seed_snapshot');
    await server.end();
    const migrator = new pg.Client({ connectionString: urlOn(adminA, 'ebmr_seed_snapshot') });
    await migrator.connect();
    await migrate(migrator, templateSources());
    await migrator.end();

    let db = open(adminA, 'ebmr_seed_snapshot');
    await installNumberStub(db, KEY, 5);
    const ops = await testActor(db, { roleCode: 'SERVICE_ACCOUNT', source: 'SYSTEM' });
    const ledger = tempLedger('seed-snapshot', work);
    const issue = (on: TestDatabase) => withCommand(on.app, ops, async (c) => (await c.query<{ v: string }>('select testgmp.issue_number($1)::text as v', [KEY])).rows[0]?.v);
    const first = await withProtectedNumbers(db.app, ops, ledger, async (c) => (await c.query<{ v: string }>('select testgmp.issue_number($1)::text as v', [KEY])).rows[0]?.v);
    expect(first).toBe('1');
    const seedIncarnation = await incarnation(db);
    expect(seedIncarnation).toMatch(/^\d+:[0-9A-F]{8}:\d+:\d+$/);
    await db.drop();

    // The snapshot: PostgreSQL stopped cleanly, its data directory tarred.
    const snap = join(work, 'seed', 'cluster.tar');
    script(['snapshot', snap], { EBMR_CI_PGDATA: aData });
    running.splice(running.indexOf(aData), 1);

    // An end-to-end group: its own cluster, started from the snapshot.
    const b = script(['start', '--from-seed', snap], { EBMR_CI_PG_DIR: join(work, 'group-job') });
    running.push(b['EBMR_CI_PGDATA'] as string);
    const adminB = b['EBMR_PG_ADMIN_URL'] as string;
    expect(new URL(adminB).port).not.toBe(new URL(adminA).port);
    db = open(adminB, 'ebmr_seed_snapshot');
    try {
      expect(await incarnation(db)).toBe(seedIncarnation);
      expect((await db.admin.query<{ s: boolean }>('select continuity.identifiers_secured() as s')).rows[0]?.s).toBe(true);
      // The server started after the seed job reserved its block (1 to 5), so the rest of that block is retired, as on
      // any restart (kernel 0600, EBMR-CONT-011); the next block is reserved through the same external ledger, ledger
      // first, which the kernel allows only to the same incarnation, and the numbering goes on above every number the
      // seed job could have issued. No restore procedure runs.
      await expect(issue(db)).rejects.toThrow('EBMR-CONT-011');
      expect(await withProtectedNumbers(db.app, ops, ledger, async (c) => (await c.query<{ v: string }>('select testgmp.issue_number($1)::text as v', [KEY])).rows[0]?.v)).toBe('6');
      expect(await issue(db)).toBe('7');
      const { rows } = await db.admin.query<{ c: string }>('select new_ceiling::text as c from continuity.ceiling_reservation where sequence_key = $1 order by new_ceiling', [KEY]);
      expect(rows.map((r) => r.c)).toEqual(['5', '10']);
    } finally {
      await db.drop();
    }

    // A logical copy (a new database oid, as a pg_dump/pg_restore seed made): another incarnation, refused numbers.
    const serverB = new pg.Client({ connectionString: adminB });
    await serverB.connect();
    await serverB.query('create database ebmr_seed_snapshot_copy template ebmr_seed_snapshot');
    await serverB.end();
    const copy = open(adminB, 'ebmr_seed_snapshot_copy');
    try {
      expect(await incarnation(copy)).not.toBe(seedIncarnation);
      // Not even a new block: the reservation itself is refused until the restore procedure has run.
      await expect(withProtectedNumbers(copy.admin, ops, ledger, async (c) => (await c.query<{ v: string }>('select testgmp.issue_number($1)::text as v', [KEY])).rows[0]?.v)).rejects.toThrow(INCARNATION_CHANGED);
    } finally {
      await copy.drop();
    }
  });
});
