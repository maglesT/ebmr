/**
 * The background workers and the backups from the operations screens (Phase 7 slice 7g-4; decision 0025 point 2; kernel
 * 1376, tablets 1485; features/operations workers.ts, backups.ts):
 *  - the system administrator stops, starts and restarts an adapter's worker and the analytics runner with a reason,
 *    each act recorded with its outcome; an adapter refused on its transport at a start from the screen is refused as
 *    at the server's start (EBMR-INT-034) and recorded REFUSED; another role is refused (PLATFORM.OPERATE);
 *  - the system administrator takes a backup: the request is recorded with the reason, the backup service identity
 *    records the run and the catalogue entry, the screen lists it with its size, time and hash, and a copy of the stored
 *    artefact is the artefact as stored, recorded; QA reads the catalogue but takes no backup; an operator reads nothing.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routes } from '@ebmr/api-contract';
import { ADMIN_URL, passwordActor, type DatabaseHandle, type SiteSeed } from '@ebmr/test-kit';
import { afterAll, describe, expect, it } from 'vitest';
import { registerAdapter, setMirrorMode, type Administration, type TestAdapter } from '../../../../packages/kernel/test/integrations/support.ts';
import type { TestDatabase } from '../../../../packages/kernel/test/support/db.ts';
import { seedBackupIdentity } from '../../src/cli/installation.ts';
import { refusalOf, valueOf } from '../esig/support.ts';
import { grantedPerson, loginOf } from '../support/granted-person.ts';
import { startServer, type TestServer } from '../support/harness.ts';
import { spawnFeedSimulator, type FeedSimProcess } from '../integrations/feed-simulator.ts';

const O = routes.operations;
const servers: TestServer[] = [];
const sims: FeedSimProcess[] = [];
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
  await Promise.all(sims.map((s) => s.close()));
});

const adminOf = async (s: TestServer) => loginOf(s, await grantedPerson(s, 'SYSTEM_ADMINISTRATOR', 'IT Administrator'));

/** A GMP server whose service-keys file configures an LMS adapter at a running LMS simulator, in MIRROR mode. */
async function serverWithLmsAdapter(endpointOf: (sim: FeedSimProcess) => string): Promise<{ server: TestServer; adapter: TestAdapter; file: string }> {
  const sim = await spawnFeedSimulator('LMS');
  sims.push(sim);
  const file = join(mkdtempSync(join(tmpdir(), 'ebmr-ops-workers-')), 'service-keys.json');
  let adapter: TestAdapter | undefined;
  const server = await startServer('GMP', {
    env: { EBMR_SERVICE_KEYS_FILE: file },
    beforeStart: async (handle: DatabaseHandle, seed: SiteSeed) => {
      const db = handle as unknown as TestDatabase;
      const adm: Administration = {
        admin: await passwordActor(handle, seed.bootstrap.admin, seed.bootstrap.admin.fingerprint),
        owner: await passwordActor(handle, seed.bootstrap.owner, seed.bootstrap.owner.fingerprint),
        authn: handle.authn,
      };
      adapter = await registerAdapter(db, 'LMS', adm);
      await setMirrorMode(db, 'LMS_QUALIFICATION', 'MIRROR', adm);
      const s = adapter.actor.seed;
      writeFileSync(file, JSON.stringify({ services: [{ terminal: 'SRV-LMS-ADAPTER-01', loginName: s.loginName, serviceKey: s.password, fingerprint: s.deviceFingerprint, endpoint: endpointOf(sim) }] }));
    },
  });
  servers.push(server);
  if (!adapter) throw new Error('the adapter was not registered');
  return { server, adapter, file };
}

const acts = async (s: TestServer) =>
  (await s.db.admin.query<{ act: string; target: string; outcome: string; reason: string }>('select act, target, outcome, reason from platform.operations_act order by recorded_at, id')).rows;

describe('the background workers (decision 0025)', () => {
  it('[DI-31][DI-17] the system administrator stops, starts and restarts an adapter\'s worker with a reason, each act recorded; QA is refused (PLATFORM.OPERATE)', async () => {
    const { server, adapter } = await serverWithLmsAdapter((sim) => `${sim.base}/lms/v1`);
    const admin = await adminOf(server);
    const qa = await server.asPersona('qaInvestigator');
    const list = valueOf(await admin.call(O.workers));
    expect(list.workers).toEqual([{ kind: 'ADAPTER', code: adapter.code, sourceSystem: 'LMS', running: true, state: expect.stringMatching(/IDLE|RUNNING/), problem: null }]);
    expect(refusalOf(await qa.call(O.controlWorker, { params: { code: adapter.code }, body: { action: 'STOP', reason: 'try' } })).code).toBe('EBMR-IAM-040');
    const stopped = valueOf(await admin.call(O.controlWorker, { params: { code: adapter.code }, body: { action: 'STOP', reason: 'LMS maintenance window' } }));
    expect(stopped).toMatchObject({ running: false, state: 'STOPPED' });
    expect(valueOf(await qa.call(routes.integrations.adapter, { params: { adapterCode: adapter.code } })).health.worker).toBeNull();
    const started = valueOf(await admin.call(O.controlWorker, { params: { code: adapter.code }, body: { action: 'START', reason: 'LMS back' } }));
    expect(started).toMatchObject({ running: true, problem: null });
    expect(valueOf(await admin.call(O.controlWorker, { params: { code: adapter.code }, body: { action: 'RESTART', reason: 'pick up the new key' } })).running).toBe(true);
    expect(await acts(server)).toEqual([
      { act: 'ADAPTER_STOP', target: adapter.code, outcome: 'DONE', reason: 'LMS maintenance window' },
      { act: 'ADAPTER_START', target: adapter.code, outcome: 'DONE', reason: 'LMS back' },
      { act: 'ADAPTER_RESTART', target: adapter.code, outcome: 'DONE', reason: 'pick up the new key' },
    ]);
    const shown = valueOf(await admin.call(O.workers)).acts;
    expect(shown.map((a) => a.act)).toEqual(['ADAPTER_RESTART', 'ADAPTER_START', 'ADAPTER_STOP']);
    expect(shown[0]).toMatchObject({ by: 'IT Administrator', outcome: 'DONE' });
    expect(refusalOf(await admin.call(O.controlWorker, { params: { code: 'NO-SUCH-ADAPTER' }, body: { action: 'START', reason: 'x' } }))).toMatchObject({ status: 404, code: 'NO_SUCH_WORKER' });
  }, 120_000);

  it('[DI-31] a start from the screen of an adapter whose base URL is off loopback without mutual TLS is refused as at the server\'s start (EBMR-INT-034), and the refusal is recorded', async () => {
    const { server, adapter } = await serverWithLmsAdapter(() => 'http://lms.example.com:4053/lms/v1');
    const admin = await adminOf(server);
    const before = valueOf(await admin.call(O.workers)).workers[0];
    expect(before).toMatchObject({ code: adapter.code, running: false, state: 'STOPPED', problem: expect.stringMatching(/^EBMR-INT-034 /) });
    const refused = refusalOf(await admin.call(O.controlWorker, { params: { code: adapter.code }, body: { action: 'START', reason: 'start it anyway' } }));
    expect(refused).toMatchObject({ status: 409, code: 'WORKER_REFUSED' });
    expect(refused.why).toMatch(/^EBMR-INT-034 /);
    expect(await acts(server)).toEqual([{ act: 'ADAPTER_START', target: adapter.code, outcome: 'REFUSED', reason: 'start it anyway' }]);
  }, 120_000);

  it('[DI-17] the system administrator stops and starts the analytics runner with a reason (GMP with the runner on)', async () => {
    const server = await startServer('GMP', { env: { EBMR_ANALYTICS: 'on' }, analytics: { pollMs: 3_600_000 } });
    servers.push(server);
    const admin = await adminOf(server);
    expect(valueOf(await admin.call(O.workers)).workers).toEqual([{ kind: 'ANALYTICS', code: 'ANALYTICS', sourceSystem: null, running: true, state: 'RUNNING', problem: null }]);
    expect(valueOf(await admin.call(O.controlWorker, { params: { code: 'ANALYTICS' }, body: { action: 'STOP', reason: 'pause the runner' } }))).toMatchObject({ running: false, state: 'STOPPED' });
    expect(valueOf(await admin.call(O.controlWorker, { params: { code: 'ANALYTICS' }, body: { action: 'START', reason: 'resume' } }))).toMatchObject({ running: true });
    expect((await acts(server)).map((a) => `${a.act} ${a.outcome}`)).toEqual(['ANALYTICS_STOP DONE', 'ANALYTICS_START DONE']);
  }, 120_000);
});

describe('backups from the screen (DI-45)', () => {
  it('[DI-45] the system administrator takes a backup: the request is recorded with the reason, the backup service identity records the run and the catalogue entry, and the screen lists it with its size, time and hash; a copy is the artefact as stored, and the copy is recorded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ebmr-ops-backup-'));
    const keys = join(dir, 'service-keys.json');
    const keyFile = join(dir, 'backup-key');
    writeFileSync(keyFile, `${createHash('sha256').update('backup key of the test').digest('hex')}\n`, { mode: 0o600 });
    const server = await startServer('GMP', {
      env: { EBMR_SERVICE_KEYS_FILE: keys, EBMR_BACKUP_DIR: join(dir, 'backups'), EBMR_BACKUP_KEY_FILE: keyFile, EBMR_BACKUP_KEY_REF: 'kms:test/backup', EBMR_PG_ADMIN_URL: ADMIN_URL },
      beforeStart: async (db, seed) => {
        const entry = await seedBackupIdentity(db, 'GMP', seed, undefined);
        writeFileSync(keys, JSON.stringify({ services: [entry] }));
      },
    });
    servers.push(server);
    const admin = await adminOf(server);
    const qa = await server.asPersona('qaInvestigator');
    const operator = await server.asPersona('operator1');
    expect(valueOf(await admin.call(O.backups))).toMatchObject({ configured: true, problem: null, backups: [], runs: [], requests: [] });
    expect(refusalOf(await operator.call(O.backups))).toMatchObject({ code: 'EBMR-OPS-030', status: 403 });
    expect(refusalOf(await qa.call(O.runBackup, { body: { reason: 'try', tier: 'OPERATIONAL' } })).code).toBe('EBMR-IAM-040');
    expect(refusalOf(await admin.call(O.runBackup, { body: { reason: 'try', tier: 'RETENTION_GRADE' } }))).toMatchObject({ code: 'BACKUP_TIER_NOT_HERE' });

    const taken = valueOf(await admin.call(O.runBackup, { body: { reason: 'before the demo', tier: 'OPERATIONAL' } }));
    expect(taken.error).toBeNull();
    expect(taken.run).toMatchObject({ status: 'SUCCEEDED', jobName: `request-${taken.requestId}`, tier: 'OPERATIONAL' });
    const view = valueOf(await qa.call(O.backups));
    expect(view.requests).toEqual([expect.objectContaining({ requestId: taken.requestId, reason: 'before the demo', by: 'IT Administrator' })]);
    const b = view.backups[0];
    expect(b).toMatchObject({ backupId: taken.run?.backupId, tier: 'OPERATIONAL', method: 'PG_DUMP_CUSTOM', databaseName: server.database, encryptionKeyRef: 'kms:test/backup', downloadable: true });
    expect(Number(b?.sizeBytes)).toBeGreaterThan(1000);
    expect(b?.sha256).toMatch(/^[0-9a-f]{64}$/);
    // The run is the backup service identity's (SYSTEM source, SERVICE_ACCOUNT), the request the administrator's.
    const { rows } = await server.db.admin.query<{ login: string }>('select a.login_name as login from continuity.backup_job_run r join iam.account a on a.id = r.recorded_by_account_id');
    expect(rows).toEqual([{ login: 'svc.backup' }]);

    expect(refusalOf(await qa.call(O.backupFile, { params: { backupId: b?.backupId ?? '' } })).code).toBe('EBMR-IAM-040');
    const copy = valueOf(await admin.call(O.backupFile, { params: { backupId: b?.backupId ?? '' } }));
    const bytes = Buffer.from(copy.contentBase64, 'base64');
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(b?.sha256);
    expect(bytes.subarray(0, 8).toString('latin1')).toBe('EBMRENC1');
    expect(JSON.parse(copy.manifest)).toMatchObject({ artefactSha256: b?.sha256, encrypted: true });
    const downloads = await server.db.admin.query<{ n: string }>('select count(*) as n from continuity.backup_download');
    expect(downloads.rows[0]?.n).toBe('1');
  }, 180_000);

  it('[DI-45] a server without its backup configuration takes no backup and records no request; the screen says what is missing', async () => {
    const server = await startServer('GMP');
    servers.push(server);
    const admin = await adminOf(server);
    const view = valueOf(await admin.call(O.backups));
    expect(view).toMatchObject({ configured: false, problem: expect.stringMatching(/EBMR_BACKUP_DIR/) });
    expect(refusalOf(await admin.call(O.runBackup, { body: { reason: 'try', tier: 'OPERATIONAL' } }))).toMatchObject({ status: 503, code: 'BACKUP_NOT_CONFIGURED' });
    expect((await server.db.admin.query('select 1 from continuity.backup_request')).rows).toEqual([]);
  });
});
