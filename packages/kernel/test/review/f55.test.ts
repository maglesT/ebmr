/**
 * Review reproducer F55: the incarnation guard (continuity.current_incarnation, kernel 0600:223) is
 * system_identifier:WAL timeline:database OID:counter table OID. A physical restore that finishes with
 * crash recovery (a pg_basebackup -X stream copy started WITHOUT recovery.signal, or a storage / VM
 * snapshot rollback) keeps all four parts, so continuity.next_counter_value (0600:318) passes the
 * EBMR-CONT-012 check and issues again every value between the restored last_value and the restored
 * reserved_ceiling - values that were already issued on the original after the backup (INV-27).
 *
 * This test performs a REAL physical restore of the test cluster:
 *   1. a protected counter gets a ledger-first block (ceiling 50) and issues 1..10; an anchor is exported;
 *   2. pg_basebackup -X stream -c fast takes a physical backup of the running cluster (time T);
 *   3. the original issues 11..30 (same block: no new ceiling reservation, no new anchor);
 *   4. the backup is started as a second postmaster with NO recovery.signal / standby.signal (it comes
 *      up by crash recovery from backup_label, on the same timeline);
 *   5. the application issues the next number in the restored database.
 *
 * Safe behaviour asserted: the restored database must NOT issue a value already issued after the
 * backup (11..30). Refusing (e.g. EBMR-CONT-012, incarnation changed) is safe; issuing a value above
 * 30 is safe; issuing 11 is the defect.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportAnchor } from '../../src/continuity/anchors.ts';
import type { FileLedger } from '../../src/continuity/ledger.ts';
import { reserveCounterBlock } from '../../src/continuity/numbers.ts';
import { checkAgainstLedger } from '../../src/continuity/restore.ts';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { ADMIN_URL, createTestDatabase, type TestDatabase } from '../support/db.ts';
import { installNumberStub, tempDir, tempLedger, testActor } from '../continuity/helpers.ts';

const KEY = 'test.number:F55';
const BIN = execFileSync('pg_config', ['--bindir']).toString().trim();

let db: TestDatabase;
let ops: ActorContext;
let ledger: FileLedger;
const dir = tempDir('f55');

// Physical copy of the cluster (outside the repository, removed in afterAll).
const work = mkdtempSync(join(tmpdir(), 'ebmr-f55-pg-'));
const dataDir = join(work, 'data');
const sockDir = join(work, 'sock');
const logFile = join(work, 'restored.log');
const port = 20000 + Math.floor(Math.random() * 20000);
let started = false;
let restoredApp: pg.Pool | undefined;
let restoredAdmin: pg.Pool | undefined;

const issueOn = (pool: pg.Pool) =>
  withCommand(pool, ops, async (c) => (await c.query<{ v: string }>('select testgmp.issue_number($1)::text as v', [KEY])).rows[0]?.v ?? '');

function asPostgres(cmd: string, args: string[]): string {
  return execFileSync('runuser', ['-u', 'postgres', '--', cmd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

function restoredUrl(database: string, user: { name: string; password: string }): string {
  const u = new URL(ADMIN_URL);
  u.hostname = '127.0.0.1';
  u.port = String(port);
  u.pathname = `/${database}`;
  u.username = user.name;
  u.password = user.password;
  return u.toString();
}

beforeAll(async () => {
  db = await createTestDatabase();
  ops = await testActor(db, { roleCode: 'SERVICE_ACCOUNT', source: 'SYSTEM' });
  await installNumberStub(db, KEY, 50);
  ledger = tempLedger('f55', dir.path);
  expect(await reserveCounterBlock(db.app, ops, ledger, KEY)).toBe(50n);
  for (let i = 1; i <= 10; i++) expect(await issueOn(db.app)).toBe(String(i));
  // The anchor job ran before the backup: its anchor (and high-water marks) are in the external ledger.
  await exportAnchor(db.app, ledger);
}, 120_000);

afterAll(async () => {
  await restoredApp?.end().catch(() => undefined);
  await restoredAdmin?.end().catch(() => undefined);
  if (started) {
    try {
      asPostgres(join(BIN, 'pg_ctl'), ['-D', dataDir, '-m', 'immediate', '-w', 'stop']);
    } catch {
      /* already stopped */
    }
  }
  rmSync(work, { recursive: true, force: true });
  await db.drop();
  dir.cleanup();
}, 180_000);

describe('F55 incarnation guard after a physical restore that ends with crash recovery', () => {
  it('[INV-27] a pg_basebackup copy started without recovery.signal does not reissue counter values issued after the backup', async () => {
    const incarnationBefore = (await db.admin.query<{ i: string }>('select continuity.current_incarnation() as i')).rows[0]?.i;

    // (2) Physical backup of the running cluster at time T (WAL streamed into the backup).
    execFileSync(join(BIN, 'pg_basebackup'), ['-d', ADMIN_URL, '-D', dataDir, '-X', 'stream', '-c', 'fast', '--no-sync'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(existsSync(join(dataDir, 'backup_label'))).toBe(true);
    expect(existsSync(join(dataDir, 'recovery.signal'))).toBe(false);
    expect(existsSync(join(dataDir, 'standby.signal'))).toBe(false);

    // (3) After the backup the original keeps issuing from the same block: 11..30, labels printed.
    const afterBackup: string[] = [];
    for (let i = 0; i < 20; i++) afterBackup.push(await issueOn(db.app));
    expect(afterBackup).toEqual(Array.from({ length: 20 }, (_, i) => String(11 + i)));

    // (4) Start the backup as a second postmaster, without recovery.signal (crash recovery from backup_label).
    mkdirSync(sockDir);
    // Debian keeps postgresql.conf outside the data directory; give the copy a minimal one like the original's.
    writeFileSync(join(dataDir, 'postgresql.conf'), "timezone = 'Etc/UTC'\ndatestyle = 'iso, mdy'\n");
    chmodSync(work, 0o755);
    execFileSync('chown', ['-R', 'postgres:postgres', dataDir, sockDir]);
    chmodSync(dataDir, 0o700);
    const opts = [
      `-p ${port}`,
      "-c listen_addresses='127.0.0.1'",
      `-c unix_socket_directories='${sockDir}'`,
      '-c shared_buffers=128MB',
      '-c max_connections=30',
      '-c hba_file=/etc/postgresql/16/main/pg_hba.conf',
      '-c ident_file=/etc/postgresql/16/main/pg_ident.conf',
      '-c archive_mode=off',
    ].join(' ');
    execFileSync('touch', [logFile]);
    execFileSync('chown', ['postgres:postgres', logFile]);
    started = true;
    try {
      asPostgres(join(BIN, 'pg_ctl'), ['-D', dataDir, '-l', logFile, '-w', '-t', '180', '-o', opts, 'start']);
    } catch (error) {
      throw new Error(`setup: the restored cluster did not start: ${(error as Error).message}\n${readFileSync(logFile, 'utf8')}`);
    }
    const serverLog = readFileSync(logFile, 'utf8');

    restoredAdmin = new pg.Pool({ connectionString: restoredUrl(db.name, { name: new URL(ADMIN_URL).username, password: new URL(ADMIN_URL).password }), max: 2 });
    restoredApp = new pg.Pool({ connectionString: restoredUrl(db.name, { name: 'ebmr_app', password: 'ebmr_app' }), max: 2 });

    // Sanity: the restored database holds the state at T (last_value 10, same block of 50).
    const counter = (
      await restoredAdmin.query<{ last_value: string; reserved_ceiling: string; ceiling_incarnation: string; now_incarnation: string; in_recovery: boolean }>(
        `select last_value::text, reserved_ceiling::text, ceiling_incarnation, continuity.current_incarnation() as now_incarnation,
                pg_is_in_recovery() as in_recovery
           from continuity.counter where sequence_key = $1`,
        [KEY],
      )
    ).rows[0];
    expect(counter).toMatchObject({ last_value: '10', reserved_ceiling: '50', in_recovery: false });

    // Evidence only (not asserted): the start-up check against the external ledger.
    const check = await checkAgainstLedger(restoredApp, ledger);

    // (5) The next number issued in the restored database.
    let outcome: { issued?: string; refused?: string };
    try {
      outcome = { issued: await issueOn(restoredApp) };
    } catch (error) {
      outcome = { refused: (error as Error).message };
    }

    const evidence = JSON.stringify(
      {
        incarnationBeforeBackup: incarnationBefore,
        ceilingIncarnation: counter?.ceiling_incarnation,
        incarnationAfterRestore: counter?.now_incarnation,
        alreadyIssuedAfterBackup: `${afterBackup[0]}..${afterBackup[afterBackup.length - 1]}`,
        restoredOutcome: outcome,
        checkAgainstLedger: { ok: check.ok, findings: check.findings.map((f) => `${f.severity} ${f.code} ${f.subject}`) },
        serverLog: serverLog.split('\n').filter((l) => /backup recovery|timeline|redo|ready to accept/.test(l)),
      },
      null,
      2,
    );

    // Safe behaviour: never hand out again a number that the original issued after the backup.
    const reissued = outcome.issued !== undefined && afterBackup.includes(outcome.issued);
    expect(reissued, `restored database reissued an already-issued protected number:\n${evidence}`).toBe(false);
  }, 600_000);
});
