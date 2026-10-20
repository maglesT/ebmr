/**
 * Start-up guards (plan section 2; module C0 tests): the server refuses a database of the other kind, a GMP
 * copy under a sandbox name, an http origin in production and demo switches in production; the demo device
 * picker exists only with EBMR_DEMO=1 and the demo marker. The site's time zone is the site policy's (DI-27):
 * the server reads it at start-up and refuses an EBMR_SITE_ZONE naming another zone, and every context the
 * server and test-kit build declares the policy's zone, whatever zone the site moved to. A change while the
 * server runs raises one operations alert and, until a restart, refuses every API request and every gateway
 * request, ends open live displays and stops the sweeper (SITE_ZONE_CHANGED), never failing later at the kernel.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { inject } from 'vitest';
import { routes, type Result } from '@ebmr/api-contract';
import { identity, toDbContext, withCommand } from '@ebmr/kernel';
import {
  copyDatabase,
  dropDatabase,
  freshTap,
  onServer,
  openDatabase,
  openPersonaSession,
  openServiceSession,
  passwordActor,
  siteZoneOf,
  terminalOf,
  uniqueSuffix,
  type DatabaseHandle,
  type SiteSeed,
} from '@ebmr/test-kit';
import { withChangeRecord } from '../../../../packages/kernel/test/support/change-record.ts';
import { buildApp } from '../../src/app.ts';
import { demoDevicesOf } from '../../src/cli/installation.ts';
import { ConfigError, parseConfig } from '../../src/config.ts';
import { openSweeperActor, startSweeper } from '../../src/features/execution/sweeper.ts';
import { withActorCommand } from '../../src/platform/db/commands.ts';
import { SITE_ZONE_CHANGED } from '../../src/platform/site-zone.ts';
import { createFamily, NEW_FAMILY } from '../designer/support.ts';
import { enrol, fakeGateway, post } from '../devices/support.ts';
import { logCollector, ORIGINS, PG_SERVER, startServer } from '../support/harness.ts';

const randomKey = (): string => randomBytes(32).toString('hex');
const dropLater: string[] = [];
afterAll(async () => {
  for (const d of dropLater) await dropDatabase(d);
});

async function tryStart(kind: 'GMP' | 'SANDBOX', database: string, dbKind: 'GMP' | 'SANDBOX', env: Record<string, string> = {}): Promise<unknown> {
  const db = openDatabase(database, dbKind);
  try {
    const config = parseConfig({ EBMR_INSTALLATION: kind, EBMR_DATABASE: database, ...PG_SERVER, EBMR_PUBLIC_ORIGIN: ORIGINS[kind], EBMR_LOG_LEVEL: 'silent', ...env }, randomKey);
    const built = await buildApp(config, { pools: { app: db.admin, authn: db.authn, close: () => Promise.resolve() } });
    await built.close();
    return null;
  } catch (error) {
    return error;
  } finally {
    await db.close();
  }
}

describe('start-up guards', () => {
  it('[DI-05][INV-18] a GMP server refuses a sandbox database and a sandbox server refuses a GMP database', async () => {
    const t = inject('serverTemplates');
    const gmpCopy = `ebmr_t_${uniqueSuffix()}`;
    const sbxCopy = `ebmr_sandbox_t${uniqueSuffix()}`;
    await copyDatabase(t.gmp.template, gmpCopy);
    await copyDatabase(t.sandbox.template, sbxCopy);
    dropLater.push(gmpCopy, sbxCopy);
    expect(String(await tryStart('GMP', sbxCopy, 'SANDBOX'))).toMatch(/expects a GMP database but is connected to a SANDBOX database.*EBMR-SBX-007/);
    expect(String(await tryStart('SANDBOX', gmpCopy, 'GMP'))).toMatch(/expects a SANDBOX database but is connected to a GMP database.*EBMR-SBX-007/);
    expect(await tryStart('GMP', gmpCopy, 'GMP')).toBeNull();
    expect(await tryStart('SANDBOX', sbxCopy, 'SANDBOX')).toBeNull();
  });

  it('[DI-05][INV-18] a GMP database copied under a sandbox name is refused by both kinds of server (EBMR-SBX-004)', async () => {
    const t = inject('serverTemplates');
    const disguised = `ebmr_sandbox_t${uniqueSuffix()}`;
    // A raw copy (a restore under the wrong name); the connect policy cannot even be applied to it.
    await onServer((s) => s.query(`create database ${disguised} template ${t.gmp.template}`));
    dropLater.push(disguised);
    expect(String(await tryStart('SANDBOX', disguised, 'GMP'))).toMatch(/EBMR-SBX-004/);
    expect(String(await tryStart('GMP', disguised, 'GMP'))).toMatch(/EBMR-SBX-004/);
  });

  it('[DI-13] production refuses an http origin and demo switches; the origin is an origin only', () => {
    const base = { EBMR_INSTALLATION: 'GMP', EBMR_DATABASE: 'ebmr_tablets', EBMR_ENV: 'production', EBMR_DB_APP_URL: 'postgres://x', EBMR_DB_AUTHN_URL: 'postgres://y', EBMR_SECRETS_FILE: '/nonexistent' };
    expect(() => parseConfig({ ...base, EBMR_PUBLIC_ORIGIN: 'http://ebmr.example' }, randomKey)).toThrow(/production refuses an http origin/);
    expect(() => parseConfig({ ...base, EBMR_PUBLIC_ORIGIN: 'https://ebmr.example', EBMR_DEMO: '1' }, randomKey)).toThrow(/production refuses demo switches/);
    expect(() => parseConfig({ EBMR_INSTALLATION: 'GMP', EBMR_DATABASE: 'x_db', EBMR_PUBLIC_ORIGIN: 'http://localhost:3001/app' }, randomKey)).toThrow(ConfigError);
    expect(() => parseConfig({ EBMR_INSTALLATION: 'TEST', EBMR_DATABASE: 'x_db', EBMR_PUBLIC_ORIGIN: 'http://localhost:3001' }, randomKey)).toThrow(ConfigError);
  });
});

describe('demo device picker (decision D6)', () => {
  it('[DI-05] GMP answers 404 without EBMR_DEMO, and 404 with EBMR_DEMO but without the demo marker', async () => {
    const noFlag = await startServer('GMP', { demoMarker: true });
    try {
      const r = await noFlag.browser().call(routes.session.demoDevices);
      expect(r.ok).toBe(false);
      if (!r.ok && r.error.kind === 'REFUSAL') expect(r.error.status).toBe(404);
      const meta = await noFlag.browser().call(routes.meta.get);
      expect(meta.ok && meta.value.demo).toBe(false);
    } finally {
      await noFlag.close();
    }
    const noMarker = await startServer('GMP', { env: { EBMR_DEMO: '1' } });
    try {
      const r = await noMarker.browser().call(routes.session.demoDevices);
      expect(r.ok).toBe(false);
      if (!r.ok && r.error.kind === 'REFUSAL') expect(r.error.status).toBe(404);
    } finally {
      await noMarker.close();
    }
  });

  it('[DI-05] with EBMR_DEMO=1 and the marker the picker lists the demo terminals', async () => {
    const server = await startServer('SANDBOX', { demoMarker: true, env: { EBMR_DEMO: '1' } });
    try {
      const r = await server.browser().call(routes.session.demoDevices);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.devices).toEqual([]);
      const meta = await server.browser().call(routes.meta.get);
      expect(meta.ok && meta.value).toMatchObject({ installation: 'SANDBOX', demo: true, watermark: { text: 'TEST, NOT GMP' } });
    } finally {
      await server.close();
    }
  });

  it('G1 (slice 7i): each kiosk offers its own badge holders first, then every other badge holder of the installation', async () => {
    const keysFile = join(mkdtempSync(join(tmpdir(), 'ebmr-demo-keys-')), 'gmp-demo-devices.json');
    const server = await startServer('GMP', {
      demoMarker: true,
      env: { EBMR_DEMO: '1', EBMR_DEMO_KEYS_FILE: keysFile },
      beforeStart: (_db, seed) => {
        writeFileSync(keysFile, JSON.stringify(demoDevicesOf(seed)));
        return Promise.resolve();
      },
    });
    try {
      const r = await server.browser().call(routes.session.demoDevices);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const devices = r.value.devices;
      const badged = new Set(devices.flatMap((d) => d.personas.filter((p) => p.badgeUid).map((p) => p.loginName)));
      expect(badged.size).toBeGreaterThan(1);
      const kiosks = devices.filter((d) => d.deviceClass === 'SHARED' || d.deviceClass === 'GRADE_A_B');
      expect(kiosks.length).toBeGreaterThan(1);
      for (const k of kiosks) {
        const here = k.personas.map((p) => p.loginName);
        const others = (k.otherPersonas ?? []).map((p) => p.loginName);
        // Works here plus Other people is every badge holder, once; nobody is in both groups; nobody without a badge.
        expect(others.filter((n) => here.includes(n))).toEqual([]);
        expect(new Set([...here.filter((n) => badged.has(n)), ...others])).toEqual(badged);
        expect(others.length).toBe(new Set(others).size);
        expect((k.otherPersonas ?? []).every((p) => p.badgeUid !== null)).toBe(true);
      }
      // A kiosk with no home persons (KIOSK-BLEND-1 on the hosted demo) still offers everyone with a badge.
      const someoneElsewhere = kiosks.find((k) => (k.otherPersonas ?? []).length > 0);
      expect(someoneElsewhere).toBeDefined();
      // Office terminals sign in with a password: no badge reader, no Other people.
      for (const d of devices.filter((x) => x.deviceClass === 'PERSONAL')) expect(d.otherPersonas).toBeUndefined();
    } finally {
      await server.close();
    }
  });
});

/** The zone the test sites move to: not the kernel's default site.zone (Asia/Kolkata), another UTC offset. */
const MOVED = 'Europe/Berlin';
const noWork = (): Promise<void> => Promise.resolve();

/** The site moves to another time zone through the kernel (iam.set_policy), as the bootstrap administrator. */
async function setSiteZone(db: DatabaseHandle, seed: SiteSeed, zone: string): Promise<void> {
  const admin = await passwordActor(db, seed.bootstrap.admin, seed.bootstrap.admin.fingerprint, {
    reasonCode: 'TEST_SETUP',
    reasonText: 'DI-27 test: the site policy names another time zone',
    correlationId: randomUUID(),
  });
  try {
    await withCommand(db.app, await withChangeRecord(db, admin), (c) => identity.setPolicy(c, 'site.zone', zone, 'DI-27 test: the site moves to another time zone'));
  } finally {
    await identity.endSession(db.app, admin.sessionId);
  }
}

/**
 * A site.zone value recorded before kernel 0940 refused it (EBMR-IAM-119): arranged with the superuser, in a validated
 * command, without the row guard 0940 put on iam.policy_value (it did not exist then; the audit trigger still fires).
 */
async function recordSiteZoneBefore0940(db: DatabaseHandle, seed: SiteSeed, zone: string): Promise<void> {
  const admin = await passwordActor(db, seed.bootstrap.admin, seed.bootstrap.admin.fingerprint, { reasonCode: 'TEST_SETUP', reasonText: 'DI-27 test: a site zone recorded before kernel 0940', correlationId: randomUUID() });
  const c = await db.admin.connect();
  try {
    await c.query('begin');
    await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(await withChangeRecord(db, admin)))]);
    await c.query('alter table iam.policy_value disable trigger aa_site_zone_iam_policy_value');
    await c.query("insert into iam.policy_value (key, value, set_by_person, set_by_account, reason) values ('site.zone', $1, $2, $3, 'DI-27 test: recorded before kernel 0940')", [zone, admin.personId, admin.accountId]);
    await c.query('alter table iam.policy_value enable trigger aa_site_zone_iam_policy_value');
    await c.query('commit');
  } catch (error) {
    await c.query('rollback');
    throw error;
  } finally {
    c.release();
    await identity.endSession(db.app, admin.sessionId);
  }
}

describe('site time zone (DI-27)', () => {
  it('[DI-27] the server refuses to start when EBMR_SITE_ZONE differs from the site policy site.zone, or the policy holds no IANA zone name', async () => {
    const t = inject('serverTemplates');
    const copy = `ebmr_t_${uniqueSuffix()}`;
    await copyDatabase(t.gmp.template, copy);
    dropLater.push(copy);
    const db = openDatabase(copy, 'GMP');
    try {
      const before = await siteZoneOf(db.app);
      expect(before).not.toBe(MOVED);
      const refused = await tryStart('GMP', copy, 'GMP', { EBMR_SITE_ZONE: MOVED });
      expect(refused).toBeInstanceOf(ConfigError);
      expect(String(refused)).toContain(`EBMR_SITE_ZONE is ${MOVED}, but the site's time zone (policy site.zone) is ${before}`);
      expect(await tryStart('GMP', copy, 'GMP', { EBMR_SITE_ZONE: before })).toBeNull();

      // The site moves: the zone configured for it before is now refused, the policy's new zone accepted.
      await setSiteZone(db, t.gmp.seed, MOVED);
      expect(String(await tryStart('GMP', copy, 'GMP', { EBMR_SITE_ZONE: before }))).toContain(
        `EBMR_SITE_ZONE is ${before}, but the site's time zone (policy site.zone) is ${MOVED}`,
      );
      expect(await tryStart('GMP', copy, 'GMP', { EBMR_SITE_ZONE: MOVED })).toBeNull();
      expect(await tryStart('GMP', copy, 'GMP')).toBeNull();

      // The kernel refuses a site.zone that is no IANA zone name (EBMR-IAM-119, kernel 0940); the site keeps its zone ...
      await expect(setSiteZone(db, t.gmp.seed, 'IST')).rejects.toThrow(/^EBMR-IAM-119 /);
      expect(await siteZoneOf(db.app)).toBe(MOVED);
      // ... and a value recorded before 0940 is no zone the server can declare or show either.
      await recordSiteZoneBefore0940(db, t.gmp.seed, 'IST');
      const unusable = await tryStart('GMP', copy, 'GMP');
      expect(unusable).toBeInstanceOf(ConfigError);
      expect(String(unusable)).toContain('the site policy site.zone holds "IST", which is not an IANA time zone name');
    } finally {
      await db.close();
    }
  }, 60_000);

  it('[DI-27] after the site policy moves to another zone, a GMP server declares it: meta, server time, and a command through the API', async () => {
    const server = await startServer('GMP', { beforeStart: (db, seed) => setSiteZone(db, seed, MOVED) });
    try {
      expect(server.config.siteZone).toBe(MOVED);
      const meta = await server.browser().call(routes.meta.get);
      expect(meta.ok).toBe(true);
      if (meta.ok) {
        expect(meta.value.site.zone).toBe(MOVED);
        expect(meta.value.serverTime.text).toMatch(/ \(Europe\/Berlin\)$/);
      }

      // test-kit follows the policy, not the zone the template was seeded with.
      expect(server.seed.zone).not.toBe(MOVED);
      const admin = await passwordActor(server.db, server.seed.bootstrap.admin, server.seed.bootstrap.admin.fingerprint);
      expect(admin.siteZone).toBe(MOVED);
      const author = await openPersonaSession(server.db, server.seed, 'author');
      expect(author.siteZone).toBe(MOVED);
      await withCommand(server.db.app, { ...author, correlationId: randomUUID() }, noWork);
      // On this site the kernel refuses the zone the site had before (EBMR-IAM-118) ...
      await expect(withCommand(server.db.app, { ...author, siteZone: server.seed.zone, correlationId: randomUUID() }, noWork)).rejects.toThrow(/EBMR-IAM-118/);

      // ... so a command through the API proves the request's context (actorFrom) declares the new zone.
      const browser = await server.asPersona('author');
      const version = await createFamily(browser, { familyCode: 'PCM500-DI27' });
      expect(version.state).toBe('DRAFT');
    } finally {
      await server.close();
    }
  }, 120_000);

  it('[DI-27] after the site policy moves to another zone, the sandbox gateway and sweeper contexts and test-kit service and kiosk sessions declare it', async () => {
    const server = await startServer('SANDBOX', { beforeStart: (db, seed) => setSiteZone(db, seed, MOVED) });
    try {
      expect(server.config.siteZone).toBe(MOVED);

      // test-kit: the service identities and a kiosk persona with a fresh tap.
      for (const key of ['sweeper', 'gateway'] as const) {
        const service = await openServiceSession(server.db, server.seed, key);
        expect(service.siteZone).toBe(MOVED);
        await withCommand(server.db.app, { ...service, correlationId: randomUUID() }, noWork);
      }
      const operator = await openPersonaSession(server.db, server.seed, 'operator1');
      expect(operator.siteZone).toBe(MOVED);
      await withCommand(server.db.app, { ...operator, authEventId: await freshTap(server.db, server.seed, 'operator1'), correlationId: randomUUID() }, noWork);

      // The server's sweeper: its SYSTEM context is accepted by the kernel.
      const sweeperService = server.seed.services.find((s) => s.key === 'sweeper');
      if (!sweeperService) throw new Error('no sweeper identity in the seed');
      const sweeper = await openSweeperActor(server.built.ctx, {
        loginName: sweeperService.loginName,
        serviceKey: sweeperService.serviceKey,
        fingerprint: terminalOf(server.seed, sweeperService.terminal).fingerprint,
      });
      expect(sweeper.siteZone).toBe(MOVED);
      await withActorCommand(server.db.app, { ...sweeper, correlationId: randomUUID() }, noWork);
      await expect(withActorCommand(server.db.app, { ...sweeper, siteZone: server.seed.zone, correlationId: randomUUID() }, noWork)).rejects.toThrow(/EBMR-IAM-118/);

      // The server's gateway listener: the heartbeat is an INTEGRATION command (gatewayActor).
      await enrol(server);
      const gw = await fakeGateway(server);
      try {
        const heartbeat = await gw.heartbeat([{ deviceCode: 'TEST-BAL-01', state: 'ONLINE', serial: 'SIM-0001' }]);
        expect(heartbeat).toMatchObject({ status: 200 });
      } finally {
        await gw.close();
      }
    } finally {
      await server.close();
    }
  }, 120_000);

  it('[DI-27] a change of the site policy site.zone while the server runs refuses every request and formatted time until a restart (SITE_ZONE_CHANGED) and raises one operations alert', async () => {
    const log = logCollector();
    const server = await startServer('GMP', { logStream: log.stream });
    const alerts = (): Record<string, unknown>[] =>
      log
        .lines()
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((l) => l['alert'] === SITE_ZONE_CHANGED);
    const expectChanged = (r: Result<unknown>, serverZone: string, policyZone: string): void => {
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.kind).toBe('REFUSAL');
      if (r.error.kind !== 'REFUSAL') return;
      expect(r.error.status).toBe(503);
      expect(r.error.envelope.refusal).toMatchObject({ code: SITE_ZONE_CHANGED, kind: 'STALE', controls: ['DI-27'], details: { serverZone, policyZone } });
      expect(r.error.envelope.refusal.whatHappened).toMatch(/must restart/);
    };
    try {
      const before = server.config.siteZone;
      expect(before).not.toBe(MOVED);
      const author = await server.asPersona('author');
      const shown = await server.browser().call(routes.meta.get);
      expect(shown.ok && shown.value.serverTime.text.endsWith(`(${before})`)).toBe(true);
      expect(alerts()).toEqual([]);

      await setSiteZone(server.db, server.seed, MOVED);

      // Nothing is shown in the old zone: a read without a session, a signed-in read and a command are refused alike.
      expectChanged(await server.browser().call(routes.meta.get), before, MOVED);
      expectChanged(await author.call(routes.session.get), before, MOVED);
      expectChanged(await author.call(routes.designer.createFamily, { body: { ...NEW_FAMILY, familyCode: 'PCM500-DI27-MOVED' } }), before, MOVED);
      // Every request that names the API is refused, not only one whose raw path starts with `/api/`: the bare prefix and
      // a query on it reach no route, yet they are API requests (review P8: the check follows isApiRequest).
      for (const url of ['/api', '/api?probe=1', '/api/no-such-route']) {
        const res = await server.app.inject({ method: 'GET', url });
        const code = (JSON.parse(res.body) as { refusal?: { code?: string } }).refusal?.code;
        expect({ url, status: res.statusCode, code, cacheControl: res.headers['cache-control'] }).toEqual({ url, status: 503, code: SITE_ZONE_CHANGED, cacheControl: 'no-store' });
      }
      // Inside the server too: no instant is formatted and no request context is built in the old zone.
      expect(() => server.built.ctx.formatInstant(0n)).toThrow(SITE_ZONE_CHANGED);
      expect(() => server.built.ctx.siteZone.current()).toThrow(SITE_ZONE_CHANGED);
      expect(server.built.ctx.siteZone.changedTo).toEqual({ policyZone: MOVED });

      // One operations alert at error level (pino 50), naming both zones, however many requests were refused.
      expect(alerts()).toHaveLength(1);
      expect(alerts()[0]).toMatchObject({ level: 50, controls: ['DI-27'], serverZone: before, policyZone: MOVED });

      // The refusal holds until a restart, even when the policy moves back: what was shown meanwhile is unknown.
      await setSiteZone(server.db, server.seed, before);
      expectChanged(await server.browser().call(routes.meta.get), before, MOVED);
      expect(alerts()).toHaveLength(1);
    } finally {
      await server.close();
    }
  }, 120_000);

  it('[DI-27] without any request, the running server notices a change of site.zone on its interval and raises the operations alert', async () => {
    const t = inject('serverTemplates');
    const copy = `ebmr_t_${uniqueSuffix()}`;
    await copyDatabase(t.gmp.template, copy);
    dropLater.push(copy);
    const db = openDatabase(copy, 'GMP');
    const log = logCollector();
    try {
      const config = parseConfig({ EBMR_INSTALLATION: 'GMP', EBMR_DATABASE: copy, ...PG_SERVER, EBMR_PUBLIC_ORIGIN: ORIGINS.GMP, EBMR_LOG_LEVEL: 'warn' }, randomKey);
      const built = await buildApp(config, { pools: { app: db.app, authn: db.authn, close: () => Promise.resolve() }, logStream: log.stream, siteZoneCheckIntervalMs: 50 });
      try {
        const before = built.ctx.config.siteZone;
        expect(built.ctx.siteZone.changedTo).toBeNull();
        await setSiteZone(db, t.gmp.seed, MOVED);
        await vi.waitFor(() => expect(built.ctx.siteZone.changedTo).toEqual({ policyZone: MOVED }), { timeout: 10_000, interval: 50 });
        const alert = log
          .lines()
          .map((l) => JSON.parse(l) as Record<string, unknown>)
          .filter((l) => l['alert'] === SITE_ZONE_CHANGED);
        expect(alert).toHaveLength(1);
        expect(alert[0]).toMatchObject({ level: 50, serverZone: before, policyZone: MOVED });
        expect(() => built.ctx.formatInstant(0n)).toThrow(SITE_ZONE_CHANGED);
      } finally {
        await built.close();
      }
    } finally {
      await db.close();
    }
  }, 60_000);
  it('[DI-27] a change of site.zone while a sandbox server runs refuses every gateway request and ends open live displays with SITE_ZONE_CHANGED, never a reading refused in the old zone', async () => {
    const log = logCollector();
    const server = await startServer('SANDBOX', { logStream: log.stream });
    const alerts = (): Record<string, unknown>[] =>
      log
        .lines()
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((l) => l['alert'] === SITE_ZONE_CHANGED);
    const controller = new AbortController();
    try {
      const before = server.config.siteZone;
      expect(before).not.toBe(MOVED);
      await enrol(server);
      const gw = await fakeGateway(server);
      try {
        expect(await gw.heartbeat([{ deviceCode: 'TEST-BAL-01', state: 'ONLINE', serial: 'SIM-0001' }])).toMatchObject({ status: 200 });

        // An operator watches the live display of the room's scale (a real stream: the reply is hijacked).
        const operator = await server.asPersona('operator1');
        await server.app.listen({ host: '127.0.0.1', port: 0 });
        const address = server.app.server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        const cookie = [...operator.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
        const res = await fetch(`http://127.0.0.1:${port}/api/devices/scales/TEST-BAL-01/live`, { headers: { cookie, accept: 'text/event-stream' }, signal: controller.signal });
        expect(res.status).toBe(200);
        if (!res.body) throw new Error('no event stream');
        const reader = res.body.getReader();
        const firstChunk = (await reader.read()) as { done: boolean; value?: Uint8Array };
        expect(firstChunk.done).toBe(false);
        expect(new TextDecoder().decode(firstChunk.value)).toContain('"deviceCode":"TEST-BAL-01"');
        expect(alerts()).toEqual([]);

        // The site moves; no browser request is made: the gateway listener checks the policy on its own.
        await setSiteZone(server.db, server.seed, MOVED);
        const reading = gw.next();
        const up = await gw.uplink([{ reading }]);
        expect(up.status).toBe(503);
        expect(up.body.error).toMatchObject({ code: SITE_ZONE_CHANGED, relogin: false });
        const heartbeat = await gw.heartbeat([{ deviceCode: 'TEST-BAL-01', state: 'ONLINE', serial: 'SIM-0001' }]);
        expect(heartbeat.status).toBe(503);
        expect(heartbeat.body).toMatchObject({ error: { code: SITE_ZONE_CHANGED, relogin: false } });
        const nonce = await post(gw.base, '/gw/v1/nonce', {});
        expect(nonce.status).toBe(503);
        expect(nonce.body).toMatchObject({ error: { code: SITE_ZONE_CHANGED } });
        // The reading was neither ingested nor refused as bad (no READING_REFUSED alarm, no EBMR-IAM-118): the
        // gateway keeps it in its journal and sends it again after the restart.
        const { rows: ingested } = await server.db.admin.query('select 1 from tab.device_reading where id = $1', [reading.readingId]);
        expect(ingested).toEqual([]);
        const { rows: alarmed } = await server.db.admin.query<{ code: string }>('select code from tab.device_alarm where reading_id = $1 or code = $2', [reading.readingId, 'EBMR-IAM-118']);
        expect(alarmed).toEqual([]);

        // The open live display ends, and the browser's reconnect is refused like any API request.
        const ended = await Promise.race([
          (async () => {
            for (;;) {
              const chunk = (await reader.read()) as { done: boolean };
              if (chunk.done) return true;
            }
          })(),
          sleep(5_000).then(() => false),
        ]);
        expect(ended).toBe(true);
        const again = await operator.inject({ method: 'GET', url: '/api/devices/scales/TEST-BAL-01/live', headers: { accept: 'text/event-stream' } });
        expect(again.statusCode).toBe(503);
        expect(again.json()).toMatchObject({ refusal: { code: SITE_ZONE_CHANGED, details: { serverZone: before, policyZone: MOVED } } });

        // One operations alert at error level (pino 50), naming both zones, however many requests were refused.
        expect(alerts()).toHaveLength(1);
        expect(alerts()[0]).toMatchObject({ level: 50, controls: ['DI-27'], serverZone: before, policyZone: MOVED });
      } finally {
        await gw.close();
      }
    } finally {
      controller.abort();
      await server.close();
    }
  }, 120_000);

  it('[DI-27] the sweeper re-reads site.zone before every sweep: after a change while the server runs it opens no session in the old zone, and only the guard alerts', async () => {
    const log = logCollector();
    const server = await startServer('SANDBOX', { logStream: log.stream });
    try {
      const before = server.config.siteZone;
      const s = server.seed.services.find((x) => x.key === 'sweeper');
      if (!s) throw new Error('no sweeper identity in the seed');
      const dir = mkdtempSync(join(tmpdir(), 'ebmr-di27-keys-'));
      const file = join(dir, 'sandbox-service-keys.json');
      const t = terminalOf(server.seed, s.terminal);
      writeFileSync(file, JSON.stringify({ label: 'DEMO-ONLY service secrets', services: [{ ...s, fingerprint: t.fingerprint, terminalKey: t.key }] }));
      // The server's own context (the same SiteZoneGuard), with the identity file the sweeper reads.
      const app = { ...server.built.ctx, config: { ...server.built.ctx.config, serviceKeysFile: file } };
      const sessionsOf = async (): Promise<number> => {
        const { rows } = await server.db.admin.query<{ n: string }>('select count(*)::text as n from iam.session where account_id = $1', [s.accountId]);
        return Number(rows[0]?.n);
      };
      const warnings: string[] = [];
      const sweeperLog = { warn: (_o: object, msg: string) => void warnings.push(msg), info: () => undefined };

      // While the zone holds, the sweeper opens its SYSTEM session and sweeps.
      const initial = await sessionsOf();
      const first = startSweeper(app, sweeperLog, { intervalMs: 100 });
      if (!first) throw new Error('the sweeper did not start');
      try {
        await vi.waitFor(async () => expect(await sessionsOf()).toBeGreaterThan(initial), { timeout: 10_000, interval: 100 });
      } finally {
        await first.stop();
      }
      expect(warnings).toEqual([]);

      // The site moves while no request is made: the sweeper's own check notices it before any sweep.
      await setSiteZone(server.db, server.seed, MOVED);
      const opened = await sessionsOf();
      const second = startSweeper(app, sweeperLog, { intervalMs: 100 });
      if (!second) throw new Error('the sweeper did not start');
      try {
        await vi.waitFor(() => expect(server.built.ctx.siteZone.changedTo).toEqual({ policyZone: MOVED }), { timeout: 10_000, interval: 50 });
        await sleep(600); // several more intervals
      } finally {
        await second.stop();
      }
      expect(await sessionsOf()).toBe(opened);
      // A session in the old zone is refused before any authentication (SITE_ZONE_CHANGED, not EBMR-IAM-118).
      await expect(openSweeperActor(app, { loginName: s.loginName, serviceKey: s.serviceKey, fingerprint: t.fingerprint })).rejects.toThrow(SITE_ZONE_CHANGED);
      expect(await sessionsOf()).toBe(opened);
      expect(warnings).toEqual([]);
      const alerts = log
        .lines()
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((l) => l['alert'] === SITE_ZONE_CHANGED);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ level: 50, serverZone: before, policyZone: MOVED });
    } finally {
      await server.close();
    }
  }, 120_000);
});
