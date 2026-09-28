/**
 * Start-up guards (plan section 2; module C0 tests): the server refuses a database of the other kind, a GMP
 * copy under a sandbox name, an http origin in production and demo switches in production; the demo device
 * picker exists only with EBMR_DEMO=1 and the demo marker.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { copyDatabase, dropDatabase, onServer, openDatabase, uniqueSuffix } from '@ebmr/test-kit';
import { buildApp } from '../../src/app.ts';
import { ConfigError, parseConfig } from '../../src/config.ts';
import { ORIGINS, startServer } from '../support/harness.ts';

const randomKey = (): string => randomBytes(32).toString('hex');
const dropLater: string[] = [];
afterAll(async () => {
  for (const d of dropLater) await dropDatabase(d);
});

async function tryStart(kind: 'GMP' | 'SANDBOX', database: string, dbKind: 'GMP' | 'SANDBOX'): Promise<unknown> {
  const db = openDatabase(database, dbKind);
  try {
    const config = parseConfig({ EBMR_INSTALLATION: kind, EBMR_DATABASE: database, EBMR_PUBLIC_ORIGIN: ORIGINS[kind], EBMR_LOG_LEVEL: 'silent' }, randomKey);
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
});
