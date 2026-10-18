/**
 * The security baseline on a production start (slice 7d, finding P7D-6; DI-13; docs/security/security-baseline.md a):
 * the kernel's rules for database connections were not applied by the server. Now a production configuration refuses
 * a database URL that does not authenticate the server over TLS (sslmode verify-full; verify-ca and require pass with
 * the kernel's warning; a local socket only when allowed), and a production server asks the database itself whether
 * its sessions are encrypted (pg_stat_ssl) before it opens.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { ConfigError, parseConfig } from '../../src/config.ts';
import { startServer, type TestServer } from '../support/harness.ts';

const randomKey = () => randomBytes(32).toString('hex');
const dir = mkdtempSync(join(tmpdir(), 'ebmr-prod-'));
const secrets = join(dir, 'secrets.json');
writeFileSync(secrets, JSON.stringify({ csrfHmacKey: randomKey(), nonceKey: randomKey() }));

const production = (over: Record<string, string> = {}) => ({
  EBMR_INSTALLATION: 'GMP', EBMR_DATABASE: 'ebmr_tablets', EBMR_ENV: 'production', EBMR_PUBLIC_ORIGIN: 'https://ebmr.site.example',
  EBMR_DB_APP_URL: 'postgres://ebmr_app@db1.site.example/ebmr_tablets?sslmode=verify-full',
  EBMR_DB_AUTHN_URL: 'postgres://ebmr_authn@db1.site.example/ebmr_tablets?sslmode=verify-full',
  EBMR_SECRETS_FILE: secrets, EBMR_ANALYTICS: 'off', ...over,
});

let gmp: TestServer;
beforeAll(async () => {
  gmp = await startServer('GMP');
});
afterAll(async () => {
  await gmp?.close();
});

describe('the security baseline on a production start (slice 7d, P7D-6)', () => {
  it('[DI-13] production refuses a database URL without verified TLS: no sslmode, disable, prefer or allow; a local socket only when allowed', () => {
    expect(() => parseConfig(production(), randomKey)).not.toThrow();
    for (const bad of ['postgres://ebmr_app@db1/ebmr_tablets', 'postgres://ebmr_app@db1/ebmr_tablets?sslmode=disable', 'postgres://ebmr_app@db1/ebmr_tablets?sslmode=prefer', 'postgres://ebmr_app@db1/ebmr_tablets?sslmode=allow&sslmode=verify-full']) {
      expect(() => parseConfig(production({ EBMR_DB_APP_URL: bad }), randomKey), bad).toThrow(ConfigError);
      expect(() => parseConfig(production({ EBMR_DB_APP_URL: bad }), randomKey), bad).toThrow(/EBMR-SEC-01[17]/);
    }
    expect(() => parseConfig(production({ EBMR_DB_AUTHN_URL: 'postgres://ebmr_authn@db1/ebmr_tablets?sslmode=prefer' }), randomKey)).toThrow(/EBMR_DB_AUTHN_URL/);
    expect(() => parseConfig(production({ EBMR_DB_ANALYTICS_URL: 'postgres://ebmr_analytics@db1/ebmr_tablets', EBMR_ANALYTICS: 'on' }), randomKey)).toThrow(/EBMR_DB_ANALYTICS_URL/);
    // verify-ca and require encrypt (the kernel warns that they do not fully verify the server): accepted.
    expect(() => parseConfig(production({ EBMR_DB_APP_URL: 'postgres://ebmr_app@db1/ebmr_tablets?sslmode=require' }), randomKey)).not.toThrow();
    const socket = 'postgres://ebmr_app@localhost/ebmr_tablets?host=/var/run/postgresql';
    expect(() => parseConfig(production({ EBMR_DB_APP_URL: socket }), randomKey)).toThrow(/EBMR-SEC-013/);
    expect(() => parseConfig(production({ EBMR_DB_APP_URL: socket, EBMR_DB_ALLOW_LOCAL_SOCKET: '1' }), randomKey)).not.toThrow();
    // Development keeps its credentials and plain connections.
    expect(() => parseConfig({ EBMR_INSTALLATION: 'GMP', EBMR_DATABASE: 'ebmr_tablets', EBMR_PUBLIC_ORIGIN: 'http://localhost:3001' }, randomKey)).not.toThrow();
  });

  it('[DI-13] a production server refuses to open on database sessions the database does not see encrypted (EBMR-SEC-015)', async () => {
    const env = parseConfig(production({ EBMR_DATABASE: gmp.database }), randomKey);
    // The test cluster's connections are plain: the server must not open on them in production.
    await expect(buildApp(env, { pools: { app: gmp.db.app, authn: gmp.db.authn, close: () => Promise.resolve() } })).rejects.toThrow(/EBMR-SEC-015/);
  });
});
