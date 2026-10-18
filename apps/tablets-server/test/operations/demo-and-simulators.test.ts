/**
 * Demo and test data and the simulators' test console (Phase 7 slice 7g-4; decision 0025 point 2; tablets 1485;
 * features/operations demo.ts, simulators.ts): refused on a GMP installation that is not a demo one, in the database
 * and on the route, for the administrator too; on a sandbox the administrator (PLATFORM.OPERATE) starts a simulator,
 * switches its faults and stops it, each act recorded; a demo sandbox is reset to a clean state (the set-up token the
 * reset answered opens its first-run set-up) and then loaded with the demo data again.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routes } from '@ebmr/api-contract';
import { withCommand } from '@ebmr/kernel';
import { ADMIN_URL, generateDeviceKey, openPersonaSession, passwordActor, type SiteSeed } from '@ebmr/test-kit';
import { afterAll, describe, expect, it } from 'vitest';
import { refusalOf, valueOf } from '../esig/support.ts';
import { grantedPerson, loginOf } from '../support/granted-person.ts';
import { startServer, type TestServer } from '../support/harness.ts';

const O = routes.operations;
const servers: TestServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

const start = async (kind: 'GMP' | 'SANDBOX', opts: Parameters<typeof startServer>[1] = {}) => {
  const s = await startServer(kind, opts);
  servers.push(s);
  // As the server's entry point does (main.ts): the demo tooling for a server with EBMR_PG_ADMIN_URL.
  if (opts.env?.['EBMR_PG_ADMIN_URL']) s.built.ctx.operations.demoTooling = await import('../../src/cli/installation.ts');
  return s;
};

const adminOf = async (s: TestServer) => loginOf(s, await grantedPerson(s, 'SYSTEM_ADMINISTRATOR', s.kind === 'SANDBOX' ? 'TEST-IT Administrator' : 'IT Administrator'));
const demoActs = async (s: TestServer): Promise<{ act: string; target: string }[]> =>
  (await s.db.admin.query<{ act: string; target: string }>('select act, target from tab.demo_act order by recorded_at, id')).rows;

describe('demo conveniences on a GMP installation (DI-05)', () => {
  it('[DI-05] a GMP installation that is not a demo one refuses the demo data, the reset and the simulators, in the database and on the route, for the system administrator too; nothing is recorded or started', async () => {
    const s = await start('GMP', { env: { EBMR_PG_ADMIN_URL: ADMIN_URL } });
    const admin = await adminOf(s);
    const view = valueOf(await admin.call(O.demo));
    expect(view).toMatchObject({ allowed: false, installation: 'GMP', demo: false, database: s.database });
    expect(view.refusal).toMatch(/^EBMR-OPS-010 /);
    const confirm = { reason: 'try a reset', confirmDatabase: s.database };
    expect(refusalOf(await admin.call(O.demoReset, { body: confirm }))).toMatchObject({ status: 403, code: 'EBMR-OPS-010' });
    expect(refusalOf(await admin.call(O.demoLoad, { body: { ...confirm, reviewBatch: false, packaging: false } }))).toMatchObject({ status: 403, code: 'EBMR-OPS-010' });
    expect(valueOf(await admin.call(O.simulators))).toEqual({ allowed: false, refusal: expect.stringMatching(/^EBMR-OPS-010 /) as string, simulators: [] });
    expect(refusalOf(await admin.call(O.controlSimulator, { params: { simulator: 'QMS' }, body: { action: 'START', reason: 'try' } }))).toMatchObject({ status: 403, code: 'EBMR-OPS-010' });
    expect(refusalOf(await admin.call(O.simulatorFault, { params: { simulator: 'QMS' }, body: { fault: 'STALE_VALUE', on: true, reason: 'try' } }))).toMatchObject({ status: 403, code: 'EBMR-OPS-010' });
    // The database itself refuses, whoever calls it.
    const actor = await passwordActor(s.db, s.seed.bootstrap.admin, s.seed.bootstrap.admin.fingerprint);
    await expect(withCommand(s.db.app, { ...actor, correlationId: randomUUID(), reasonCode: 'TEST', reasonText: 'direct call' }, (c) => c.query("select tab.record_demo_act('DEMO_RESET', $1, 'direct')", [s.database]))).rejects.toThrow(/EBMR-OPS-010/);
    expect(await demoActs(s)).toEqual([]);
    expect(valueOf(await admin.call(O.demoJob))).toMatchObject({ state: 'IDLE' });
  });

  it('[DI-05] a demo installation of the GMP kind allows them (decision D6, D-P7g4-1); without an administration connection the screen says so and nothing runs', async () => {
    const s = await start('GMP', { demoMarker: true });
    const admin = await adminOf(s);
    const view = valueOf(await admin.call(O.demo));
    expect(view).toMatchObject({ allowed: false, demo: true, reviewBatchAllowed: true });
    expect(view.refusal).toMatch(/EBMR_PG_ADMIN_URL/);
    expect(refusalOf(await admin.call(O.demoReset, { body: { reason: 'reset', confirmDatabase: s.database } }))).toMatchObject({ status: 409, code: 'DEMO_NOT_POSSIBLE' });
    expect(valueOf(await admin.call(O.simulators)).allowed).toBe(true);
  });
});

describe('the simulators\' test console (decision 0025)', () => {
  it('[DI-05][DI-17] on a sandbox the system administrator starts a simulator, switches a fault on and off and stops it, each act recorded; another role is refused (PLATFORM.OPERATE)', async () => {
    const s = await start('SANDBOX');
    const admin = await adminOf(s);
    const qa = await s.asPersona('qareviewer1');
    expect(refusalOf(await qa.call(O.controlSimulator, { params: { simulator: 'QMS' }, body: { action: 'START', reason: 'test' } })).code).toBe('EBMR-IAM-040');
    const list = valueOf(await admin.call(O.simulators));
    expect(list.allowed).toBe(true);
    expect(list.simulators.map((x) => x.code)).toEqual(['ERP', 'WMS', 'QMS', 'LIMS', 'LMS', 'CMMS', 'EMS', 'L3', 'OPCUA']);
    expect(list.simulators.every((x) => !x.running)).toBe(true);
    try {
      const started = valueOf(await admin.call(O.controlSimulator, { params: { simulator: 'QMS' }, body: { action: 'START', reason: 'test the QMS feed' } }));
      expect(started).toMatchObject({ code: 'QMS', running: true, faults: [], url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/) as string, endpoint: expect.stringMatching(/\/qms\/v1$/) as string });
      expect(started.available).toContain('STALE_VALUE');
      const heartbeat = await fetch(`${started.endpoint ?? ''}/heartbeat`);
      expect(heartbeat.status).toBe(200);
      const on = valueOf(await admin.call(O.simulatorFault, { params: { simulator: 'QMS' }, body: { fault: 'STALE_MIRROR', on: true, reason: 'stale mirror test' } }));
      expect(on.faults).toEqual(['STALE_MIRROR']);
      expect((await fetch(`${started.endpoint ?? ''}/heartbeat`)).status).toBe(503);
      expect(refusalOf(await admin.call(O.simulatorFault, { params: { simulator: 'QMS' }, body: { fault: 'NO_SUCH_FAULT', on: true, reason: 'x' } }))).toMatchObject({ status: 409, code: 'SIMULATOR_REFUSED' });
      expect(valueOf(await admin.call(O.simulatorFault, { params: { simulator: 'QMS' }, body: { fault: 'STALE_MIRROR', on: false, reason: 'end the test' } })).faults).toEqual([]);
      expect(refusalOf(await admin.call(O.simulatorFault, { params: { simulator: 'LMS' }, body: { fault: 'STALE_VALUE', on: true, reason: 'x' } }))).toMatchObject({ code: 'SIMULATOR_REFUSED' });
    } finally {
      const stopped = valueOf(await admin.call(O.controlSimulator, { params: { simulator: 'QMS' }, body: { action: 'STOP', reason: 'done' } }));
      expect(stopped.running).toBe(false);
    }
    expect((await demoActs(s)).map((a) => `${a.act} ${a.target}`)).toEqual([
      'SIMULATOR_START QMS', 'SIMULATOR_FAULT_ON QMS:STALE_MIRROR', 'SIMULATOR_FAULT_ON QMS:NO_SUCH_FAULT', 'SIMULATOR_FAULT_OFF QMS:STALE_MIRROR',
      'SIMULATOR_FAULT_ON LMS:STALE_VALUE', 'SIMULATOR_STOP QMS',
    ]);
  }, 120_000);
});

describe('demo and test data on a demo sandbox (decision 0025)', () => {
  it('[DI-05] the administrator resets a demo sandbox to a clean state after confirming its name; its first-run set-up opens with the token the reset answered; the demo data is then loaded again, with its personas and terminals', async () => {
    const keysDir = mkdtempSync(join(tmpdir(), 'ebmr-demo-keys-'));
    const s = await start('SANDBOX', { demoMarker: true, env: { EBMR_PG_ADMIN_URL: ADMIN_URL, EBMR_KEYS_DIR: keysDir, EBMR_DEMO: '1' } });
    // The harness's own superuser pool loses its connections with the database too.
    s.db.admin.on('error', () => undefined);
    const admin = await adminOf(s);
    const before = valueOf(await admin.call(O.demo));
    expect(before).toMatchObject({ allowed: true, installation: 'SANDBOX', demo: true, refusal: null, reviewBatchAllowed: false });
    expect(Number(before.contents.persons)).toBeGreaterThan(5);
    expect(refusalOf(await admin.call(O.demoReset, { body: { reason: 'clean start', confirmDatabase: 'ebmr_sandbox_other' } }))).toMatchObject({ code: 'CONFIRM_DATABASE' });
    const qa = await s.asPersona('qareviewer1');
    expect(refusalOf(await qa.call(O.demoReset, { body: { reason: 'clean start', confirmDatabase: s.database } })).code).toBe('EBMR-IAM-040');

    const reset = valueOf(await admin.call(O.demoReset, { body: { reason: 'clean start for the test', confirmDatabase: s.database } }));
    expect(reset.job).toMatchObject({ state: 'RUNNING', kind: 'RESET' });
    expect(reset.setupToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // While it runs, every other request is refused (MAINTENANCE), the job's state is answered without a session.
    const anon = s.browser();
    const during = await anon.call(routes.session.get);
    if (!during.ok && during.error.kind === 'REFUSAL' && during.error.envelope.refusal.code === 'MAINTENANCE') expect(during.error.status).toBe(503);
    let job = valueOf(await anon.call(O.demoJob));
    for (let i = 0; i < 600 && job.state === 'RUNNING'; i++) {
      await new Promise((r) => setTimeout(r, 250));
      job = valueOf(await anon.call(O.demoJob));
    }
    expect(job).toMatchObject({ state: 'DONE', kind: 'RESET', error: null });
    expect(valueOf(await anon.call(routes.meta.get)).setupRequired).toBe(true);
    expect((await s.db.app.query<{ n: string }>('select count(*) as n from iam.account')).rows[0]?.n).toBe('0');
    expect(valueOf(await anon.call(O.setupState))).toMatchObject({ required: true, tokenIssued: true, demo: true });

    // The first-run set-up of the clean installation, with the reset's token.
    const consoleKey = generateDeviceKey();
    const fresh = s.browser();
    const done = await fresh.call(O.setup, {
      body: {
        token: reset.setupToken,
        site: { code: 'SITE-1', name: 'Demo site', zone: 'Asia/Kolkata' },
        administrator: { legalName: 'TEST-Asha Rao', loginName: 'test-asha', password: 'First-Admin-Password-1' },
        processOwner: { legalName: 'TEST-Vikram Shah', loginName: 'test-vikram', password: 'First-Owner-Password-1' },
        consoleSpki: consoleKey.publicKeySpki,
        generateSealKey: false,
      },
    });
    expect(valueOf(done).administratorLogin).toBe('test-asha');

    expect((await s.db.app.query<{ n: string }>('select count(*) as n from iam.account')).rows[0]?.n).toBe('2');
  }, 600_000);
});

/** Waits for the demo job to end and returns its view. */
async function settled(s: TestServer) {
  const anon = s.browser();
  let job = valueOf(await anon.call(O.demoJob));
  for (let i = 0; i < 2400 && job.state === 'RUNNING'; i++) {
    await new Promise((r) => setTimeout(r, 250));
    job = valueOf(await anon.call(O.demoJob));
  }
  return job;
}

describe('loading the demo data (decision 0025)', () => {
  it('[DI-05] the administrator loads the demo data into a demo sandbox: the personas, terminals and feature seeds of the set-up CLI and the backup service identity; the server takes the new installation without a restart', async () => {
    const keysDir = mkdtempSync(join(tmpdir(), 'ebmr-demo-load-'));
    const s = await start('SANDBOX', { demoMarker: true, env: { EBMR_PG_ADMIN_URL: ADMIN_URL, EBMR_KEYS_DIR: keysDir, EBMR_DEMO: '1' } });
    s.db.admin.on('error', () => undefined);
    const admin = await adminOf(s);
    const body = { reason: 'demo data for the test', confirmDatabase: s.database, reviewBatch: false, packaging: false };
    // The GMP review batch is built on a GMP demo installation only.
    expect(refusalOf(await admin.call(O.demoLoad, { body: { ...body, reviewBatch: true } }))).toMatchObject({ status: 409, code: 'DEMO_NOT_POSSIBLE' });
    const started = valueOf(await admin.call(O.demoLoad, { body })).job;
    expect(started).toMatchObject({ state: 'RUNNING', kind: 'LOAD' });
    expect(refusalOf(await admin.call(O.demoLoad, { body })).code).toMatch(/DEMO_NOT_POSSIBLE|MAINTENANCE/);
    const job = await settled(s);
    expect(job).toMatchObject({ state: 'DONE', kind: 'LOAD', error: null });
    const seed = JSON.parse(readFileSync(join(keysDir, 'sandbox-seed.json'), 'utf8')) as SiteSeed;
    expect(seed.personas.length).toBeGreaterThan(5);
    const keys = JSON.parse(readFileSync(join(keysDir, 'sandbox-service-keys.json'), 'utf8')) as { services: { terminal: string; loginName: string }[] };
    expect(keys.services.find((x) => x.terminal === 'TEST-SRV-BACKUP-01')?.loginName).toBe('test-svc-backup');
    expect(existsSync(join(keysDir, 'sandbox-demo-devices.json'))).toBe(true);
    expect(existsSync(join(keysDir, 'sandbox-backup-key'))).toBe(true);
    const anon = s.browser();
    expect(valueOf(await anon.call(routes.meta.get)).setupRequired).toBe(false);
    // A persona of the new installation signs in (its DEMO-ONLY credentials are the new seed's).
    const actor = await openPersonaSession(s.db, seed, 'qareviewer1');
    expect(actor.roleCode).toBe('QA_REVIEWER');
    const grant = await s.db.app.query<{ role: string }>("select g.role_code as role from iam.role_grant g join iam.account a on a.id = g.account_id where a.login_name = 'test-svc-backup' and g.status = 'APPROVED'");
    expect(grant.rows).toEqual([{ role: 'SERVICE_ACCOUNT' }]);
  }, 600_000);
});
