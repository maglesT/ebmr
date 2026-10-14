/**
 * The adapters start with the server (Phase 6 slice 6a; DI-31; D-P6a-5; adapters/start.ts): an adapter configured in
 * the service-keys file runs only when the site runs its system in MIRROR mode, stops when the server closes, and its
 * worker's health shows on the integrations routes. A STAND_IN site starts none, even with an adapter configured.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routes } from '@ebmr/api-contract';
import { dropDatabase, passwordActor, type DatabaseHandle, type SiteSeed } from '@ebmr/test-kit';
import { afterAll, describe, expect, it } from 'vitest';
import { count, registerAdapter, setMirrorMode, type Administration, type TestAdapter } from '../../../../packages/kernel/test/integrations/support.ts';
import type { TestDatabase } from '../../../../packages/kernel/test/support/db.ts';
import { startServer, type TestServer } from '../support/harness.ts';
import { spawnFeedSimulator, type FeedSimProcess } from './feed-simulator.ts';

const sims: FeedSimProcess[] = [];
const servers: TestServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
  await Promise.all(sims.map((s) => s.close()));
});

/** A GMP server whose service-keys file configures an LMS adapter at a running LMS simulator, in `mode`. */
async function serverWithLmsAdapter(mode: 'MIRROR' | 'STAND_IN'): Promise<{ server: TestServer; adapter: TestAdapter; sim: FeedSimProcess }> {
  const sim = await spawnFeedSimulator('LMS');
  sims.push(sim);
  const file = join(mkdtempSync(join(tmpdir(), 'ebmr-adapters-')), 'service-keys.json');
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
      if (mode === 'MIRROR') await setMirrorMode(db, 'LMS_QUALIFICATION', 'MIRROR', adm);
      const s = adapter.actor.seed;
      writeFileSync(file, JSON.stringify({
        services: [{ terminal: 'SRV-LMS-ADAPTER-01', loginName: s.loginName, serviceKey: s.password, fingerprint: s.deviceFingerprint, endpoint: `${sim.base}/lms/v1` }],
      }));
    },
  });
  servers.push(server);
  if (!adapter) throw new Error('the adapter was not registered');
  return { server, adapter, sim };
}

/** The adapter account's open sessions (the worker holds one while it runs). */
const openSessions = (server: TestServer, a: TestAdapter) =>
  count(server.db as unknown as TestDatabase, 'select count(*) as n from iam.session where account_id = $1 and ended_at is null and id <> $2', [a.actor.accountId, a.actor.sessionId]);

describe('the integration adapters start with the server (DI-31)', () => {
  it('[DI-31] an LMS adapter in MIRROR mode starts with the server, shows its worker on the routes, keeps the mirror fresh and stops on close', async () => {
    const { server, adapter } = await serverWithLmsAdapter('MIRROR');
    const qa = await server.asPersona('qaInvestigator');
    let worker: unknown = null;
    for (let i = 0; i < 100; i++) {
      const r = await qa.call(routes.integrations.adapter, { params: { adapterCode: adapter.code } });
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      worker = r.value.health.worker;
      if (r.value.health.worker && Number(r.value.health.worker.cycles) >= 1 && r.value.health.mirrors.every((m) => !m.stale)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(worker).toMatchObject({ state: 'IDLE', cursor: '0', head: '0', lastError: null });
    const list = await qa.call(routes.integrations.adapters, {});
    expect(list.ok && list.value.adapters.find((a) => a.adapterCode === adapter.code)?.worker).toMatchObject({ state: 'IDLE' });
    expect(await openSessions(server, adapter)).toBe(1);
    // Close: the worker stops and ends its session (checked before the test database is dropped).
    await server.built.close();
    servers.splice(servers.indexOf(server), 1);
    expect(await openSessions(server, adapter)).toBe(0);
    await server.db.close();
    await dropDatabase(server.config.database);
  });

  it('[DI-31] a STAND_IN site starts no adapter, even with one configured', async () => {
    const { server, adapter } = await serverWithLmsAdapter('STAND_IN');
    const qa = await server.asPersona('qaInvestigator');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const r = await qa.call(routes.integrations.adapter, { params: { adapterCode: adapter.code } });
    expect(r.ok && r.value.health.worker).toBeNull();
    expect(await openSessions(server, adapter)).toBe(0);
  });
});
