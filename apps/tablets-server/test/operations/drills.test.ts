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
import { withCommand } from '@ebmr/kernel';
import { ADMIN_URL, copyDatabase, dropDatabase, passwordActor } from '@ebmr/test-kit';
import { seedBackupIdentity } from '../../src/cli/installation.ts';
import { backupIdentityOf, backupServiceActor } from '../../src/features/operations/backups.ts';
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

describe('drills and hardening checks in the database, whoever writes them (kernel 1395)', () => {
  /** The message of the refusal (or 'ok' with the answer) of `sql` run as `actor`. */
  const run = async (server: TestServer, actor: Awaited<ReturnType<typeof passwordActor>>, sql: string, params: unknown[]): Promise<string> => {
    try {
      await withCommand(server.db.app, { ...actor, correlationId: randomUUID(), reasonCode: 'TEST', reasonText: 'direct call' }, (c) => c.query(sql, params));
      return 'ok';
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };

  it('[DI-45][DI-17] a drill request names its kind, its reason up to 1000 characters and, for an upgrade drill only, a database name; an upgrade drill is recorded only by a SYSTEM service identity, only for a person\'s upgrade request of the same database, only when valid, and a failed one raises its alarm', async () => {
    const server = await drillServer('SANDBOX');
    const admin = await passwordActor(server.db, server.seed.bootstrap.admin, server.seed.bootstrap.admin.fingerprint);
    const request = (kind: string | null, reason: string | null, source: string | null) => run(server, admin, 'select continuity.request_drill($1, $2, $3)', [kind, reason, source]);
    const refused = /^EBMR-OPS-040 /;
    expect(await request(null, 'a reason', null)).toMatch(refused);
    expect(await request('BACKUP', 'a reason', null)).toMatch(refused);
    expect(await request('RESTORE', '', null)).toMatch(refused);
    expect(await request('RESTORE', null, null)).toMatch(refused);
    expect(await request('RESTORE', 'x'.repeat(1001), null)).toMatch(refused);
    expect(await request('RESTORE', 'a reason', 'ebmr_src_one')).toMatch(refused);
    expect(await request('UPGRADE', 'a reason', null)).toMatch(refused);
    expect(await request('UPGRADE', 'a reason', 'Bad-Name')).toMatch(refused);
    expect(await request('UPGRADE', 'a reason', '1ebmr')).toMatch(refused);
    expect((await server.db.admin.query('select 1 from continuity.drill_request')).rows).toEqual([]);
    expect(await request('RESTORE', 'x'.repeat(1000), null)).toBe('ok');
    expect(await request('UPGRADE', 'upgrade one', 'ebmr_src_one')).toBe('ok');
    expect(await request('UPGRADE', 'upgrade two', 'ebmr_src_two')).toBe('ok');
    const ids = Object.fromEntries((await server.db.admin.query<{ k: string; id: string }>("select coalesce(source_database, 'restore') as k, id::text as id from continuity.drill_request")).rows.map((r) => [r.k, r.id]));
    expect(Object.keys(ids).sort()).toEqual(['ebmr_src_one', 'ebmr_src_two', 'restore']);

    const who = backupIdentityOf(server.built.ctx);
    if (!who) throw new Error('SETUP: no backup service identity');
    const service = await backupServiceActor(server.built.ctx, who, ids['ebmr_src_one'] ?? '', { code: 'TEST', text: 'direct call' });
    const drill = (over: Record<string, unknown>) => ({
      drill_id: `drill.${randomUUID()}`, request_id: ids['ebmr_src_one'], source_database: 'ebmr_src_one', from_release: 'v0.9', result: 'PASS', failures: [],
      tables_compared: 10, tables_changed: 0, chains_verified: 1, migrations_applied: 2, report_sha256: 'a'.repeat(64), report_uri: 'file:///drills/upgrade.json', ...over,
    });
    const record = (actor: Awaited<ReturnType<typeof passwordActor>>, d: unknown) => run(server, actor, 'select continuity.record_upgrade_drill($1::jsonb)', [d === null ? null : JSON.stringify(d)]);
    expect(await record(service, null)).toMatch(/^EBMR-OPS-042 an upgrade drill record is required$/);
    expect(await record(service, [drill({})])).toMatch(/^EBMR-OPS-042 an upgrade drill record is required$/);
    expect(await record(admin, drill({}))).toMatch(/^EBMR-OPS-042 upgrade drills are recorded only by a system service account/);
    const unanswered = /^EBMR-OPS-042 an upgrade drill record answers a person's request for an upgrade drill of the same database$/;
    expect(await record(service, drill({ source_database: 'ebmr_src_two' }))).toMatch(unanswered);
    expect(await record(service, drill({ request_id: randomUUID() }))).toMatch(unanswered);
    expect(await record(service, drill({ request_id: ids['restore'], source_database: 'ebmr_src_one' }))).toMatch(unanswered);
    expect(await record(service, drill({ request_id: 'not-a-uuid' }))).toMatch(unanswered);
    expect(await record(service, drill({ result: 'MAYBE' }))).toMatch(/^EBMR-OPS-042 invalid upgrade drill record: /);
    expect(await record(service, drill({ result: 'PASS', tables_changed: 1 }))).toMatch(/^EBMR-OPS-042 invalid upgrade drill record: /);
    expect(await record(service, drill({ report_sha256: 'A'.repeat(64) }))).toMatch(/^EBMR-OPS-042 invalid upgrade drill record: /);
    expect((await server.db.admin.query('select 1 from continuity.upgrade_drill')).rows).toEqual([]);
    const failedAlarms = async () => (await server.db.admin.query("select 1 from continuity.alarm where alarm_code = 'UPGRADE_DRILL_FAILED'")).rows.length;
    expect(await record(service, drill({}))).toBe('ok');
    expect(await failedAlarms()).toBe(0);
    expect(await record(service, drill({ request_id: ids['ebmr_src_two'], source_database: 'ebmr_src_two', result: 'FAIL', failures: ['a table changed'], tables_changed: 1 }))).toBe('ok');
    expect(await failedAlarms()).toBe(1);
  }, 300_000);

  it('[DI-45][DI-17] a hardening check is recorded only with every check named with its status and the reason up to 1000 characters, with the result its checks give; a failed one raises its alarm naming the failed checks', async () => {
    const server = await startServer('GMP');
    servers.push(server);
    const admin = await passwordActor(server.db, server.seed.bootstrap.admin, server.seed.bootstrap.admin.fingerprint);
    const report = (over: Record<string, unknown>) => ({ result: 'PASS', checks: [{ id: 'PG-TLS', status: 'PASS' }, { id: 'PORTS', status: 'WARN' }, { id: 'SRV-CONFIG', status: 'NOT_APPLICABLE' }], report_sha256: 'b'.repeat(64), ...over });
    const check = (r: unknown, reason: string | null = 'after the OS patch') => run(server, admin, 'select continuity.record_hardening_check($1::jsonb, $2)', [r === null ? null : JSON.stringify(r), reason]);
    const incomplete = /^EBMR-OPS-043 a hardening check names every check with its status/;
    const notItsResult = /^EBMR-OPS-043 the result of a hardening check is FAIL when a check fails and PASS otherwise$/;
    expect(await check(null)).toMatch(incomplete);
    expect(await check([report({})])).toMatch(incomplete);
    expect(await check(report({ checks: { id: 'PG-TLS', status: 'PASS' } }))).toMatch(incomplete);
    expect(await check(report({ checks: [] }))).toMatch(incomplete);
    expect(await check(report({}), '')).toMatch(incomplete);
    expect(await check(report({}), null)).toMatch(incomplete);
    expect(await check(report({}), 'x'.repeat(1001))).toMatch(incomplete);
    expect(await check(report({ checks: ['PG-TLS'] }))).toMatch(incomplete);
    expect(await check(report({ checks: [{ status: 'PASS' }] }))).toMatch(incomplete);
    expect(await check(report({ checks: [{ id: '', status: 'PASS' }] }))).toMatch(incomplete);
    expect(await check(report({ checks: [{ id: 'PG-TLS', status: 'MAYBE' }] }))).toMatch(incomplete);
    expect(await check(report({ checks: [{ id: 'PG-TLS' }] }))).toMatch(incomplete);
    expect(await check(report({ checks: [{ id: 'PG-TLS', status: 'FAIL' }, { id: 'PORTS', status: 'PASS' }] }))).toMatch(notItsResult);
    expect(await check(report({ result: 'FAIL' }))).toMatch(notItsResult);
    expect(await check(report({ result: undefined }))).toMatch(notItsResult);
    expect(await check(report({ report_sha256: 'B'.repeat(64) }))).toMatch(/^EBMR-OPS-043 invalid hardening check: /);
    expect((await server.db.admin.query('select 1 from continuity.hardening_check')).rows).toEqual([]);
    const alarms = async () => (await server.db.admin.query<{ failed: unknown }>("select details -> 'failed' as failed from continuity.alarm where alarm_code = 'HARDENING_CHECK_FAILED' order by recorded_at")).rows.map((r) => r.failed);
    expect(await check(report({}), 'x'.repeat(1000))).toBe('ok');
    expect(await alarms()).toEqual([]);
    expect(await check(report({ result: 'FAIL', checks: [{ id: 'PG-TLS', status: 'FAIL' }, { id: 'PORTS', status: 'PASS' }, { id: 'SRV-CONFIG', status: 'FAIL' }] }))).toBe('ok');
    expect(await alarms()).toEqual([['PG-TLS', 'SRV-CONFIG']]);
    expect((await server.db.admin.query('select result from continuity.hardening_check order by recorded_at')).rows).toEqual([{ result: 'PASS' }, { result: 'FAIL' }]);
  });
});
