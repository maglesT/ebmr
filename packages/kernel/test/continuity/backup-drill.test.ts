import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportAnchor } from '../../src/continuity/anchors.ts';
import { decryptFile, recordRestoreDrill, runBackupJob, runRestoreDrill, sha256File, type DrillReport } from '../../src/continuity/backup-drill.ts';
import { recordHardeningAttestation } from '../../src/continuity/hardening.ts';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { ADMIN_URL, createTestDatabase, urlFor, type TestDatabase } from '../support/db.ts';
import { tempDir, tempLedger, testActor } from './helpers.ts';

const REPO = new URL('../../../../', import.meta.url).pathname;
/**
 * Per-test budget for a restore drill (pg_dump, encrypt, pg_restore into a new database, per-table content
 * hashing). Alone a drill takes a few seconds, but in the full three-project run it overlaps the server
 * project's template builds and has gone past the default 30 s. Vitest does not cancel a timed-out test, so an
 * abandoned drill keeps its child processes and database running and slows the next drill into a timeout too.
 * Same budget as the other heavy database tests in the kernel (e.g. review/f55, mutation/protected-numbers).
 */
const DRILL_TIMEOUT_MS = 120_000;
let db: TestDatabase;
let ops: ActorContext;
const dir = tempDir('drill');
const key = randomBytes(32);

async function databaseExists(name: string): Promise<boolean> {
  const { rows } = await db.admin.query('select 1 from pg_database where datname = $1', [name]);
  return rows.length === 1;
}

function runScript(script: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(join(REPO, script), args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('close', (code) => resolve({ code: code ?? -1, out }));
  });
}

beforeAll(async () => {
  db = await createTestDatabase();
  ops = await testActor(db, { roleCode: 'SERVICE_ACCOUNT', source: 'SYSTEM' });
  // Hardening attestations are IT administration (CONTINUITY.HARDENING_ATTEST, system administrator).
  const itAdmin = await testActor(db, { roleCode: 'SYSTEM_ADMINISTRATOR' });
  // GMP content of several kinds: audited records, an insert-only table, an attestation, anchors.
  const batch = randomUUID();
  await withCommand(db.app, ops, async (c) => {
    for (const v of ['12.503', '12.498', '12.511']) await c.query('insert into testgmp.sample (batch_id, value) values ($1, $2)', [batch, v]);
    await c.query('insert into testgmp.reading (batch_id, value) values ($1, 7)', [batch]);
  });
  await withCommand(db.app, itAdmin, async (c) => {
    await recordHardeningAttestation(c, {
      deviceId: randomUUID(),
      deviceClass: 'SHARED',
      usbMassStorageBlocked: true,
      kioskModeEnforced: true,
      malwareProtectionActive: true,
      osPatchWithinSla: true,
      method: 'MDM_COMPLIANCE_REPORT',
      evidenceRef: 'MDM-EXPORT-001',
    });
  });
  await withCommand(db.app, { ...ops, reasonCode: 'TRANSCRIPTION_ERROR', reasonText: 'wrong digit' }, (c) =>
    c.query("update testgmp.sample set note = 'checked' where batch_id = $1", [batch]),
  );
  await exportAnchor(db.app, tempLedger('drill-source', dir.path));
});
afterAll(async () => {
  await db.drop();
  dir.cleanup();
});

describe('restore drill', () => {
  let report: DrillReport;

  it('[DI-45] a drill restores into an isolated database and matches records, audit trails and signature tables by ordered content hash', async () => {
    const reportDir = join(dir.path, 'reports-pass');
    const outcome = await runRestoreDrill({ sourceUrl: urlFor(db.name), adminUrl: ADMIN_URL, reportDir, encryptionKey: key });
    report = outcome.report;
    expect(report.failures).toEqual([]);
    expect(report.result).toBe('PASS');

    // The backup was encrypted at rest and its fixity checked; the restore was isolated and removed.
    expect(report.backup).toMatchObject({ format: 'PG_DUMP_CUSTOM', encrypted: true, fixityVerified: true });
    expect(report.restore).toMatchObject({ isolated: true, dropped: true });
    expect(await databaseExists(report.restore?.database ?? '')).toBe(false);

    // Chains and anchors verified on both sides.
    for (const side of [report.verification.source, report.verification.restored]) {
      expect(side).toMatchObject({ available: true, chainProblems: [], anchorProblems: [] });
      expect(side?.chains).toBeGreaterThan(0);
      expect(side?.anchors).toBeGreaterThan(0);
    }

    // Every table compared; the categories the control names are present and matching.
    const table = (name: string) => report.tables.find((t) => t.table === name);
    expect(table('kernel.audit_event')).toMatchObject({ category: 'AUDIT_TRAIL', match: true });
    expect(table('kernel.audit_chain_head')).toMatchObject({ category: 'AUDIT_TRAIL', match: true });
    expect(table('testgmp.sample')).toMatchObject({ category: 'RECORDS', sourceRows: 3, restoredRows: 3, match: true });
    expect(table('continuity.device_hardening_attestation')).toMatchObject({ category: 'RECORDS', sourceRows: 1, match: true });
    expect(report.tables.every((t) => t.match)).toBe(true);
    expect(report.tables.filter((t) => t.category === 'SIGNATURES').every((t) => t.match)).toBe(true);
    expect(report.summary.tablesMatching).toBe(report.summary.tablesCompared);
    expect(report.summary.byCategory.AUDIT_TRAIL.rows).toBeGreaterThan(0);

    // Sample records opened with their audit trail on both sides.
    expect(report.samples.length).toBeGreaterThan(0);
    expect(report.samples.every((s) => s.auditMatch && (!s.rowCompared || s.rowMatch))).toBe(true);

    // Reports: JSON (machine) and Markdown (for the reviewer), under the given directory.
    expect(JSON.parse(readFileSync(outcome.jsonPath, 'utf8'))).toMatchObject({ kind: 'ebmr.restore-drill', drillId: report.drillId, result: 'PASS' });
    const md = readFileSync(outcome.markdownPath, 'utf8');
    expect(md).toContain(`# Restore drill report ${report.drillId}`);
    expect(md).toContain('**Result: PASS**');
    expect(md).toContain('| AUDIT_TRAIL |');

    // The result is recorded in the database with the report hash.
    const id = await recordRestoreDrill({ pool: db.app, ctx: ops }, outcome);
    const { rows } = await db.app.query<{ result: string; report_sha256: string }>('select result, report_sha256 from continuity.restore_drill where id = $1', [id]);
    expect(rows).toEqual([{ result: 'PASS', report_sha256: await sha256File(outcome.jsonPath) }]);
  }, DRILL_TIMEOUT_MS);

  it('[DI-45] while a drill copy exists, the application role cannot connect to it', async () => {
    const outcome = await runRestoreDrill({ sourceUrl: urlFor(db.name), adminUrl: ADMIN_URL, reportDir: join(dir.path, 'reports-keep'), keepRestoredDatabase: true, sampleSize: 1 });
    const name = outcome.report.restore?.database ?? '';
    try {
      expect(outcome.report.result).toBe('PASS');
      expect(await databaseExists(name)).toBe(true);
      const app = new pg.Client({ connectionString: urlFor(name, { name: 'ebmr_app', password: 'ebmr_app' }) });
      await expect(app.connect()).rejects.toThrow(/permission denied for database/);
    } finally {
      await db.admin.query(`drop database if exists "${name}" with (force)`);
    }
  }, DRILL_TIMEOUT_MS);

  it('[DI-45] a drill detects a restored copy that differs from production, reports it and raises an alarm', async () => {
    const outcome = await runRestoreDrill({
      sourceUrl: urlFor(db.name),
      adminUrl: ADMIN_URL,
      reportDir: join(dir.path, 'reports-fail'),
      beforeCompare: async (url) => {
        // A corrupted restore: one record value and one audit event differ from production.
        const c = new pg.Client({ connectionString: url });
        await c.connect();
        try {
          await c.query('begin');
          await c.query('set local session_replication_role = replica');
          await c.query("update testgmp.sample set value = value + 1 where value = '12.498'");
          await c.query("update kernel.audit_event set payload = jsonb_set(payload, '{source}', '\"API\"') where id = (select min(id) from kernel.audit_event)");
          await c.query('commit');
        } finally {
          await c.end();
        }
      },
    });
    expect(outcome.report.result).toBe('FAIL');
    const failures = outcome.report.failures.join('\n');
    expect(failures).toContain('table testgmp.sample: rows 3/3, content hash differs');
    expect(failures).toContain('table kernel.audit_event: rows');
    expect(failures).toMatch(/restored: [1-9]\d* chain problem/);
    expect(outcome.report.tables.find((t) => t.table === 'testgmp.sample')?.match).toBe(false);
    expect(readFileSync(outcome.markdownPath, 'utf8')).toContain('**Result: FAIL**');

    const drillRow = await recordRestoreDrill({ pool: db.app, ctx: ops }, outcome);
    const alarm = await db.app.query<{ severity: string }>(
      "select severity from continuity.open_alarm where alarm_code = 'RESTORE_DRILL_FAILED' and details ->> 'restore_drill_id' = $1",
      [drillRow],
    );
    expect(alarm.rows).toEqual([{ severity: 'HIGH' }]);
  }, DRILL_TIMEOUT_MS);

  it('[DI-45][DI-23] a drill verifies every chain found in the audit trail: a chain whose head row was deleted is still verified and reported', async () => {
    const outcome = await runRestoreDrill({
      sourceUrl: urlFor(db.name),
      adminUrl: ADMIN_URL,
      reportDir: join(dir.path, 'reports-head'),
      sampleSize: 1,
      beforeCompare: async (url) => {
        // A corrupted restore: one chain lost its head row; its events are all there.
        const c = new pg.Client({ connectionString: url });
        await c.connect();
        try {
          await c.query('begin');
          await c.query('set local session_replication_role = replica');
          await c.query("delete from kernel.audit_chain_head where chain_key = (select min(chain_key) from kernel.audit_chain_head where chain_key like 'batch:%')");
          await c.query('commit');
        } finally {
          await c.end();
        }
      },
    });
    expect(outcome.report.result).toBe('FAIL');
    const restored = outcome.report.verification.restored;
    expect(restored?.chainProblems.some((p) => /^batch:\S+ seq \d+: chain head is missing although the chain has events/.test(p))).toBe(true);
    // The chain still counts: both sides verified the same chains.
    expect(restored?.chains).toBe(outcome.report.verification.source?.chains);
    expect(outcome.report.failures).toContainEqual(expect.stringMatching(/^restored: [1-9]\d* chain problem/));
  }, DRILL_TIMEOUT_MS);

  it('[DI-45] the drill script runs end to end and exits 0 on PASS', async () => {
    const reportDir = join(dir.path, 'reports-cli');
    const r = await runScript('ops/backup/drill.sh', ['--source-url', urlFor(db.name), '--admin-url', ADMIN_URL, '--report-dir', reportDir, '--sample-size', '2']);
    expect(r.out).toContain(': PASS');
    expect(r.code).toBe(0);
    const json = r.out.match(/report: (\S+\.json)/)?.[1] ?? '';
    expect(JSON.parse(readFileSync(json, 'utf8'))).toMatchObject({ result: 'PASS' });
  }, DRILL_TIMEOUT_MS);
});

describe('backup jobs', () => {
  it('[DI-45] a successful retention-grade backup is encrypted, hashed, write-once and catalogued', async () => {
    const backupDir = join(dir.path, 'store');
    const outcome = await runBackupJob({
      sourceUrl: urlFor(db.name),
      backupDir,
      reportDir: join(dir.path, 'backup-reports'),
      jobName: 'nightly-retention',
      tier: 'RETENTION_GRADE',
      encryptionKey: key,
      encryptionKeyRef: 'kms:ebmr/backup/test',
      immutableDays: 5840,
      recorder: { pool: db.app, ctx: ops },
    });
    expect(outcome.report.error).toBeNull();
    expect(outcome.report.status).toBe('SUCCEEDED');
    expect(outcome.report.recordError).toBeNull();
    const b = outcome.report.backup;
    if (!b) throw new Error('no backup');
    expect(statSync(b.file).mode & 0o777).toBe(0o444);
    const head = readFileSync(b.file).subarray(0, 5).toString('latin1');
    expect(head).not.toBe('PGDMP'); // not a readable dump: encrypted at rest
    const plain = join(dir.path, 'check.dump');
    await decryptFile(b.file, plain, key);
    expect(readFileSync(plain).subarray(0, 5).toString('latin1')).toBe('PGDMP');
    expect(await sha256File(plain)).toBe(b.dumpSha256);

    const { rows } = await db.app.query<{ tier: string; artefact_sha256: string; encryption_key_ref: string; immutable_until: string }>(
      "select tier, artefact_sha256, encryption_key_ref, immutable_until::text from continuity.backup_catalogue where backup_id = $1",
      [b.backupId],
    );
    expect(rows).toEqual([{ tier: 'RETENTION_GRADE', artefact_sha256: b.artefactSha256, encryption_key_ref: 'kms:ebmr/backup/test', immutable_until: b.immutableUntil }]);
  });

  it('[DI-45] a failing backup job is logged, raises an alarm, writes its report and exits non-zero', async () => {
    const reportDir = join(dir.path, 'backup-fail');
    const outcome = await runBackupJob({
      sourceUrl: urlFor(`${db.name}_missing`),
      clockUrl: urlFor(db.name),
      backupDir: join(dir.path, 'store-fail'),
      reportDir,
      jobName: 'nightly-operational',
      tier: 'OPERATIONAL',
      encryptionKey: key,
      encryptionKeyRef: 'kms:ebmr/backup/test',
      recorder: { pool: db.app, ctx: ops },
    });
    expect(outcome.report.status).toBe('FAILED');
    expect(outcome.report.error).toMatch(/pg_dump failed/);
    expect(existsSync(outcome.jsonPath) && existsSync(outcome.markdownPath)).toBe(true);
    const run = await db.app.query<{ status: string; error_text: string }>('select status, error_text from continuity.backup_job_run where id = $1', [outcome.report.jobRunId]);
    expect(run.rows[0]?.status).toBe('FAILED');
    const alarm = await db.app.query<{ severity: string }>("select severity from continuity.open_alarm where alarm_code = 'BACKUP_JOB_FAILED' and details ->> 'job_run_id' = $1", [
      outcome.report.jobRunId,
    ]);
    expect(alarm.rows).toEqual([{ severity: 'HIGH' }]);

    // The same through the job script: non-zero exit, a report, and another alarm row.
    const keyFile = join(dir.path, 'backup.key');
    writeFileSync(keyFile, key.toString('hex'));
    const alarmsBefore = await db.app.query<{ n: string }>("select count(*)::text as n from continuity.alarm where alarm_code = 'BACKUP_JOB_FAILED'");
    const r = await runScript('ops/backup/backup.sh', [
      '--source-url', urlFor(`${db.name}_missing`),
      '--clock-url', urlFor(db.name),
      '--backup-dir', join(dir.path, 'store-fail-cli'),
      '--report-dir', reportDir,
      '--encryption-key-file', keyFile,
      '--encryption-key-ref', 'kms:ebmr/backup/test',
      '--job-name', 'nightly-cli',
      '--record-url', urlFor(db.name, { name: 'ebmr_app', password: 'ebmr_app' }),
      '--actor-json', JSON.stringify(ops),
    ]);
    expect(r.out).toContain('backup job nightly-cli: FAILED');
    expect(r.code).toBe(1);
    const alarmsAfter = await db.app.query<{ n: string }>("select count(*)::text as n from continuity.alarm where alarm_code = 'BACKUP_JOB_FAILED'");
    expect(Number(alarmsAfter.rows[0]?.n)).toBe(Number(alarmsBefore.rows[0]?.n) + 1);
  }, 60_000);

  it('[DI-45] a catalogued backup cannot be deleted or altered through the database, not even by the table owner', async () => {
    const { rows } = await db.app.query<{ backup_id: string }>('select backup_id from continuity.backup_catalogue limit 1');
    const id = rows[0]?.backup_id;
    expect(id).toBeDefined();
    for (const sql of ['delete from continuity.backup_catalogue', "update continuity.backup_catalogue set storage_uri = 'file:///dev/null'", 'truncate continuity.backup_catalogue cascade', 'delete from continuity.backup_job_run', 'delete from continuity.restore_drill']) {
      await expect(db.app.query(sql)).rejects.toThrow(/permission denied/);
    }
    const c = await db.admin.connect();
    try {
      for (const sql of ['delete from continuity.backup_catalogue', "update continuity.backup_catalogue set storage_uri = 'file:///dev/null'", 'truncate continuity.backup_catalogue cascade']) {
        await c.query('begin');
        try {
          await c.query('set local role ebmr_owner');
          await expect(c.query(sql)).rejects.toThrow('EBMR-AUDIT-004');
        } finally {
          await c.query('rollback');
        }
      }
    } finally {
      c.release();
    }
    const still = await db.app.query('select 1 from continuity.backup_catalogue where backup_id = $1', [id]);
    expect(still.rows).toHaveLength(1);
  });

  it('[DI-45] a person at a terminal cannot record a backup or a drill result; only the system service account can', async () => {
    const person = await testActor(db, { roleCode: 'SYSTEM_ADMINISTRATOR' });
    const fake = {
      job_name: 'forged', tier: 'OPERATIONAL', status: 'SUCCEEDED', started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:01:00Z',
      backup: { backup_id: 'forged-backup-0001', method: 'PG_DUMP_CUSTOM', database_name: db.name, artefact_sha256: 'a'.repeat(64), size_bytes: '1',
                storage_uri: 'file:///nowhere', encryption_key_ref: 'kms:none', tool_version: 'x', snapshot_taken_at: '2026-01-01T00:00:00Z' },
    };
    await expect(withCommand(db.app, person, (c) => c.query('select continuity.record_backup_job($1::jsonb)', [JSON.stringify(fake)]))).rejects.toThrow('EBMR-CONT-030');
    await expect(withCommand(db.app, person, (c) => c.query('select continuity.record_restore_drill($1::jsonb)', [JSON.stringify({ drill_id: 'forged-drill-1' })]))).rejects.toThrow('EBMR-CONT-031');
  });

  it('[DI-45] the catalogue itself refuses a retention-grade entry without a write-once lock, or with a lock that has already lapsed', async () => {
    const run = (tier: string, immutableUntil: string | null) => ({
      job_name: 'direct-record', tier, status: 'SUCCEEDED', started_at: '2026-09-01T01:00:00Z', finished_at: '2026-09-01T01:05:00Z',
      backup: { backup_id: `direct-${randomBytes(4).toString('hex')}`, method: 'PG_DUMP_CUSTOM', database_name: db.name, artefact_sha256: 'c'.repeat(64),
                size_bytes: '42', storage_uri: 's3://ebmr-backup-worm/direct', immutable_until: immutableUntil, encryption_key_ref: 'kms:ebmr/backup/test',
                tool_version: 'pg_dump 16', snapshot_taken_at: '2026-09-01T01:00:00Z' },
    });
    const record = (p: unknown) => withCommand(db.app, ops, (c) => c.query<{ id: string }>('select continuity.record_backup_job($1::jsonb)::text as id', [JSON.stringify(p)]));
    await expect(record(run('RETENTION_GRADE', null))).rejects.toThrow(/^EBMR-CONT-030 .*retention_grade_needs_write_once_lock/);
    await expect(record(run('RETENTION_GRADE', '2000-01-01'))).rejects.toThrow(/^EBMR-CONT-030 .*write_once_lock_runs_past_snapshot/);
    await expect(record(run('RETENTION_GRADE', '2026-09-01'))).rejects.toThrow(/^EBMR-CONT-030 .*write_once_lock_runs_past_snapshot/);
    await expect(record(run('OPERATIONAL', '2000-01-01'))).rejects.toThrow(/^EBMR-CONT-030 .*write_once_lock_runs_past_snapshot/);
    expect((await record(run('RETENTION_GRADE', '2042-09-01'))).rows[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await record(run('OPERATIONAL', null))).rows[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('[DI-45] a backup job with a write-once period that is not a positive number of days fails, is logged and alarmed', async () => {
    const outcome = await runBackupJob({
      sourceUrl: urlFor(db.name),
      backupDir: join(dir.path, 'store-3'),
      reportDir: join(dir.path, 'backup-reports-3'),
      jobName: 'nightly-retention',
      tier: 'RETENTION_GRADE',
      encryptionKey: key,
      encryptionKeyRef: 'kms:ebmr/backup/test',
      immutableDays: -10,
      recorder: { pool: db.app, ctx: ops },
    });
    expect(outcome.report.status).toBe('FAILED');
    expect(outcome.report.error).toContain('positive whole number of days');
    expect(outcome.report.backup).toBeNull();
    const run = await db.app.query<{ status: string }>('select status from continuity.backup_job_run where id = $1', [outcome.report.jobRunId]);
    expect(run.rows).toEqual([{ status: 'FAILED' }]);
  });

  it('[DI-45] a backup whose encryption key file cannot be read when the job runs is a failed run: logged, alarmed, reported, exit 1 (not a usage error)', async () => {
    const missingKey = join(dir.path, 'secrets-not-mounted', 'backup.key');
    const outcome = await runBackupJob({
      sourceUrl: urlFor(db.name),
      backupDir: join(dir.path, 'store-4'),
      reportDir: join(dir.path, 'backup-reports-4'),
      jobName: 'nightly-operational',
      tier: 'OPERATIONAL',
      encryptionKey: { file: missingKey },
      encryptionKeyRef: 'kms:ebmr/backup/test',
      recorder: { pool: db.app, ctx: ops },
    });
    expect(outcome.report.status).toBe('FAILED');
    expect(outcome.report.error).toContain(missingKey);
    expect(existsSync(outcome.jsonPath) && existsSync(outcome.markdownPath)).toBe(true);
    const alarm = await db.app.query<{ severity: string }>("select severity from continuity.open_alarm where alarm_code = 'BACKUP_JOB_FAILED' and details ->> 'job_run_id' = $1", [
      outcome.report.jobRunId,
    ]);
    expect(alarm.rows).toEqual([{ severity: 'HIGH' }]);

    // The same through the job script: exit 1 with its report and one more alarm row.
    const alarmsBefore = await db.app.query<{ n: string }>("select count(*)::text as n from continuity.alarm where alarm_code = 'BACKUP_JOB_FAILED'");
    const r = await runScript('ops/backup/backup.sh', [
      '--source-url', urlFor(db.name),
      '--backup-dir', join(dir.path, 'store-4-cli'),
      '--report-dir', join(dir.path, 'backup-reports-4'),
      '--encryption-key-file', missingKey,
      '--encryption-key-ref', 'kms:ebmr/backup/test',
      '--job-name', 'nightly-cli-key',
      '--record-url', urlFor(db.name, { name: 'ebmr_app', password: 'ebmr_app' }),
      '--actor-json', JSON.stringify(ops),
    ]);
    expect(r.out).toContain('backup job nightly-cli-key: FAILED');
    expect(r.code).toBe(1);
    const alarmsAfter = await db.app.query<{ n: string }>("select count(*)::text as n from continuity.alarm where alarm_code = 'BACKUP_JOB_FAILED'");
    expect(Number(alarmsAfter.rows[0]?.n)).toBe(Number(alarmsBefore.rows[0]?.n) + 1);
  }, 60_000);

  it('[DI-45] a retention-grade backup cannot be catalogued without write-once retention', async () => {
    const outcome = await runBackupJob({
      sourceUrl: urlFor(db.name),
      backupDir: join(dir.path, 'store-2'),
      reportDir: join(dir.path, 'backup-reports-2'),
      jobName: 'nightly-retention',
      tier: 'RETENTION_GRADE',
      encryptionKey: key,
      encryptionKeyRef: 'kms:ebmr/backup/test',
      recorder: { pool: db.app, ctx: ops },
    });
    expect(outcome.report.status).toBe('FAILED');
    expect(outcome.report.error).toContain('write-once retention period');
  });
});
