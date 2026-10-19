/**
 * The drills and the hardening check from the operations screens (Phase 7 slice 7g, work package 2; kernel 1395, tablets
 * 1525; features/operations drills.ts):
 *  - the system administrator asks for a restore drill with a reason; the server runs the kernel's drill as a job and the
 *    backup service identity records it; QA reads the records but runs no drill; an operator reads nothing;
 *  - decision D-P7R-4: the database refuses an upgrade drill on a GMP installation and the screen offers none; on a
 *    sandbox the administrator runs one on a copy of a database and the backup service identity records it;
 *  - the administrator runs the installation hardening check; every check is recorded with its evidence, a failed check
 *    raises its alarm; QA may not run it.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { routes, type DrillsView } from '@ebmr/api-contract';
import { ADMIN_URL, copyDatabase, dropDatabase } from '@ebmr/test-kit';
import { seedBackupIdentity } from '../../src/cli/installation.ts';
import { refusalOf, valueOf } from '../esig/support.ts';
import { grantedPerson, loginOf } from '../support/granted-person.ts';
import { startServer, type TestBrowser, type TestServer } from '../support/harness.ts';

const O = routes.operations;
const servers: TestServer[] = [];
const databases: string[] = [];
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
  for (const d of databases) await dropDatabase(d).catch(() => undefined);
});

/** A server of `kind` with its backup directory, key, service identity and administration connection. */
async function drillServer(kind: 'GMP' | 'SANDBOX'): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), 'ebmr-drills-'));
  const keys = join(dir, 'service-keys.json');
  const keyFile = join(dir, 'backup-key');
  writeFileSync(keyFile, `${createHash('sha256').update('backup key of the drills test').digest('hex')}\n`, { mode: 0o600 });
  const server = await startServer(kind, {
    env: { EBMR_SERVICE_KEYS_FILE: keys, EBMR_BACKUP_DIR: join(dir, 'backups'), EBMR_BACKUP_KEY_FILE: keyFile, EBMR_BACKUP_KEY_REF: 'kms:test/backup', EBMR_PG_ADMIN_URL: ADMIN_URL },
    beforeStart: async (db, seed) => {
      writeFileSync(keys, JSON.stringify({ services: [await seedBackupIdentity(db, kind, seed, undefined)] }));
    },
  });
  servers.push(server);
  return server;
}

/** The drills page until its job has ended. */
async function settled(b: TestBrowser): Promise<DrillsView> {
  const deadline = performance.now() + 600_000;
  for (;;) {
    const v = valueOf(await b.call(O.drills));
    if (v.job.state !== 'RUNNING' || performance.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

describe('drills from the screen (DI-45, D-P7R-4)', () => {
  it('[DI-45][DI-17] the administrator runs a restore drill with a reason: the backup service identity records it with its report; QA reads it but runs none; an operator reads nothing', async () => {
    const server = await drillServer('GMP');
    const admin = await loginOf(server, await grantedPerson(server, 'SYSTEM_ADMINISTRATOR', 'IT Administrator'));
    const qa = await server.asPersona('qaInvestigator');
    const operator = await server.asPersona('operator1');
    const before = valueOf(await admin.call(O.drills));
    expect(before).toMatchObject({ installation: 'GMP', restore: { runnable: true, problem: null }, upgrade: { runnable: false }, restoreDrills: [], job: { state: 'IDLE' } });
    expect(before.upgrade.problem).toMatch(/D-P7R-4/);
    expect(refusalOf(await operator.call(O.drills)).code).toBe('EBMR-OPS-051');
    expect(refusalOf(await qa.call(O.runRestoreDrill, { body: { reason: 'try' } })).code).toBe('EBMR-IAM-040');

    const started = valueOf(await admin.call(O.runRestoreDrill, { body: { reason: 'quarterly restore test' } }));
    expect(started.job).toMatchObject({ state: 'RUNNING', kind: 'RESTORE' });
    expect(refusalOf(await admin.call(O.runRestoreDrill, { body: { reason: 'twice' } })).code).toBe('DRILL_NOT_POSSIBLE');
    const after = await settled(admin);
    expect(after.job).toMatchObject({ state: 'DONE', kind: 'RESTORE', error: null });
    const drill = after.restoreDrills[0];
    expect(drill).toMatchObject({ sourceDatabase: server.database, result: 'PASS', failures: [] });
    expect(drill?.reportSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Number(drill?.tablesCompared)).toBeGreaterThan(50);
    expect(drill?.tablesMatching).toBe(drill?.tablesCompared);
    expect(after.requests).toEqual([expect.objectContaining({ requestId: started.requestId, kind: 'RESTORE', reason: 'quarterly restore test', by: 'IT Administrator' })]);
    // The record is the backup service identity's (a SYSTEM source holding CONTINUITY.BACKUP_RECORD), the request the person's.
    const { rows } = await server.db.admin.query<{ login: string }>('select a.login_name as login from continuity.restore_drill d join iam.account a on a.id = d.recorded_by_account_id');
    expect(rows).toEqual([{ login: 'svc.backup' }]);
    expect(valueOf(await qa.call(O.drills)).restoreDrills).toHaveLength(1);
  }, 900_000);

  it('[DI-45] decision D-P7R-4: on a GMP installation the database refuses an upgrade drill, and nothing is recorded', async () => {
    const server = await startServer('GMP', { env: { EBMR_PG_ADMIN_URL: ADMIN_URL } });
    servers.push(server);
    const admin = await loginOf(server, await grantedPerson(server, 'SYSTEM_ADMINISTRATOR', 'IT Administrator'));
    expect(refusalOf(await admin.call(O.runUpgradeDrill, { body: { reason: 'try', sourceDatabase: 'ebmr_release_db', fromRelease: 'v0.9' } })).code).toBe('EBMR-OPS-041');
    expect((await server.db.admin.query('select 1 from continuity.drill_request')).rows).toEqual([]);
    // A server that cannot run a restore drill says why, and records no request.
    const view = valueOf(await admin.call(O.drills));
    expect(view.restore).toMatchObject({ runnable: false, problem: expect.stringMatching(/EBMR_BACKUP_DIR/) as string });
    expect(refusalOf(await admin.call(O.runRestoreDrill, { body: { reason: 'try' } })).code).toBe('DRILL_NOT_POSSIBLE');
    expect((await server.db.admin.query('select 1 from continuity.drill_request')).rows).toEqual([]);
  }, 120_000);

  it('[DI-45] on a sandbox the administrator runs an upgrade drill on a copy of a database; the backup service identity records its outcome', async () => {
    const server = await drillServer('SANDBOX');
    const admin = await loginOf(server, await grantedPerson(server, 'SYSTEM_ADMINISTRATOR', 'TEST-IT Administrator'));
    const source = `ebmr_upgsrc_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await copyDatabase(inject('serverTemplates').gmp.template, source);
    databases.push(source);
    expect(valueOf(await admin.call(O.drills)).upgrade).toEqual({ runnable: true, problem: null });
    const started = valueOf(await admin.call(O.runUpgradeDrill, { body: { reason: 'release candidate upgrade check', sourceDatabase: source, fromRelease: 'this-release' } }));
    expect(started.job).toMatchObject({ state: 'RUNNING', kind: 'UPGRADE' });
    const after = await settled(admin);
    expect(after.job).toMatchObject({ state: 'DONE', kind: 'UPGRADE', error: null });
    const drill = after.upgradeDrills[0];
    expect(drill).toMatchObject({ requestId: started.requestId, sourceDatabase: source, fromRelease: 'this-release' });
    expect(drill?.reportSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Number(drill?.tablesCompared)).toBeGreaterThan(50);
  }, 900_000);
});

describe('the hardening check from the screen', () => {
  it('[DI-45][DI-17] the administrator runs the installation hardening check: every check is recorded with its evidence, a failed check raises its alarm; QA may not run it', async () => {
    const server = await startServer('GMP', { env: { EBMR_PG_ADMIN_URL: ADMIN_URL } });
    servers.push(server);
    const admin = await loginOf(server, await grantedPerson(server, 'SYSTEM_ADMINISTRATOR', 'IT Administrator'));
    const qa = await server.asPersona('qaInvestigator');
    expect(refusalOf(await qa.call(O.runHardeningCheck, { body: { reason: 'try', allowedPorts: [] } })).code).toBe('EBMR-IAM-040');
    const run = valueOf(await admin.call(O.runHardeningCheck, { body: { reason: 'after the OS patch', allowedPorts: ['443', '5432'] } }));
    expect(run).toMatchObject({ reason: 'after the OS patch', by: 'IT Administrator' });
    expect(run.checks.map((c) => c.id)).toEqual(expect.arrayContaining(['PG-TLS', 'SRV-CONFIG', 'PORTS']));
    expect(run.result).toBe(run.checks.some((c) => c.status === 'FAIL') ? 'FAIL' : 'PASS');
    // No secret of the server's configuration reaches the record.
    expect(JSON.stringify(run)).not.toContain('ebmr_dev:ebmr_dev');
    const view = valueOf(await qa.call(O.drills));
    expect(view.hardeningChecks.map((h) => h.checkRunId)).toEqual([run.checkRunId]);
    const alarms = valueOf(await admin.call(O.alarms)).alarms.filter((a) => a.code === 'HARDENING_CHECK_FAILED');
    expect(alarms).toHaveLength(run.result === 'FAIL' ? 1 : 0);
  }, 300_000);
});
