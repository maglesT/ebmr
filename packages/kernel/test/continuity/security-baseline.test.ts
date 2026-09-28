import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertEncryptedDatabaseSession,
  assertProductionConfig,
  checkDatabaseUrl,
  checkIntegrationEndpoint,
  checkPgHba,
  checkPostgresqlConf,
  checkProductionConfig,
  checkServerConfig,
  SecurityBaselineError,
  type ProductionConfig,
  type ServerConfig,
} from '../../src/continuity/security-baseline.ts';
import { createTestDatabase, urlFor, type TestDatabase } from '../support/db.ts';

const OPS = new URL('../../../../ops/postgres/', import.meta.url).pathname;
const SQL = new URL('../../sql/', import.meta.url).pathname;

const TLS = { certFile: '/etc/ebmr/tls/server.crt', keyFile: '/etc/ebmr/tls/server.key', minVersion: 'TLSv1.2' as const };
const HSTS = { maxAgeSeconds: 31_536_000, includeSubDomains: true };
const COOKIES = { secure: true, httpOnly: true, sameSite: 'Strict' as const };
const withoutTls: ServerConfig = { publicUrl: 'https://ebmr.plant1.example.in', tlsTermination: 'SERVER', plainHttp: 'REDIRECT_TO_HTTPS', hsts: HSTS, cookies: COOKIES };
const withoutHsts: ServerConfig = { publicUrl: 'https://ebmr.plant1.example.in', tlsTermination: 'SERVER', tls: TLS, plainHttp: 'REDIRECT_TO_HTTPS', cookies: COOKIES };
const goodServer: ServerConfig = { ...withoutTls, tls: TLS };

const goodConfig: ProductionConfig = {
  environment: 'production',
  database: { url: 'postgres://ebmr_app@db1.plant1.example.in:5432/ebmr_tablets?sslmode=verify-full' },
  siteServicesDatabase: { url: 'postgres://ebmr_app@db1.plant1.example.in:5432/ebmr_site?sslmode=verify-full' },
  server: goodServer,
  integrations: [
    { name: 'erp', url: 'https://erp.example.in/api' },
    { name: 'press', url: 'opc.tcp://press-01.ot.example.in:4840', opcUaSecurityMode: 'SignAndEncrypt' },
  ],
};

const errors = (findings: { severity: string; code: string }[]) => findings.filter((f) => f.severity === 'ERROR').map((f) => f.code);

describe('production configuration', () => {
  it('[DI-13] a database URL that would allow a connection without TLS is refused', () => {
    for (const url of [
      'postgres://ebmr_app@db1/ebmr_tablets',
      'postgres://ebmr_app@db1/ebmr_tablets?sslmode=disable',
      'postgres://ebmr_app@db1/ebmr_tablets?sslmode=allow',
      'postgres://ebmr_app@db1/ebmr_tablets?sslmode=prefer',
      'postgres://ebmr_app@db1/ebmr_tablets?ssl=false&sslmode=require',
    ]) {
      expect(errors(checkDatabaseUrl(url)), url).toContain('EBMR-SEC-011');
    }
    expect(checkDatabaseUrl('postgres://ebmr_app@db1/ebmr_tablets?sslmode=verify-full')).toEqual([]);
    // require encrypts but does not verify the server: accepted with a warning.
    expect(checkDatabaseUrl('postgres://ebmr_app@db1/ebmr_tablets?sslmode=require').map((f) => [f.severity, f.code])).toEqual([['WARNING', 'EBMR-SEC-012']]);
    // A local socket has no network path, but must be allowed explicitly.
    expect(errors(checkDatabaseUrl('postgres://ebmr_app@%2Fvar%2Frun%2Fpostgresql/ebmr_tablets'))).toEqual(['EBMR-SEC-013']);

    // A parameter given twice: the check would read the first value and the driver the last, so a
    // URL that looks verified could connect without TLS or without verifying the server (F61).
    for (const url of [
      'postgres://ebmr_app@db1/ebmr_tablets?sslmode=verify-full&sslmode=disable',
      'postgres://ebmr_app@db1/ebmr_tablets?sslmode=verify-full&sslmode=no-verify',
      'postgres://ebmr_app@db1/ebmr_tablets?host=%2Frun%2Fpg&host=db2&sslmode=verify-full',
    ]) {
      expect(errors(checkDatabaseUrl(url, 'database.url', { allowLocalSocket: true })), url).toEqual(['EBMR-SEC-017']);
    }
    expect(() => assertProductionConfig({ ...goodConfig, database: { url: 'postgres://ebmr_app@db1/ebmr_tablets?sslmode=verify-full&sslmode=disable' } })).toThrow(
      /EBMR-SEC-017 database\.url/,
    );

    const bad: ProductionConfig = { ...goodConfig, database: { url: 'postgres://ebmr_app:secret@db1/ebmr_tablets' } };
    expect(() => assertProductionConfig(bad)).toThrow(SecurityBaselineError);
    expect(() => assertProductionConfig(bad)).toThrow(/EBMR-SEC-001[\s\S]*EBMR-SEC-011 database\.url/);
  });

  it('[DI-13] a server configuration that would serve plain HTTP or weak sessions is refused', () => {
    expect(checkServerConfig(goodServer)).toEqual([]);
    const cases: [ServerConfig, string][] = [
      [{ ...goodServer, publicUrl: 'http://ebmr.plant1.example.in' }, 'EBMR-SEC-020'],
      [{ ...goodServer, plainHttp: 'SERVE' }, 'EBMR-SEC-021'],
      [withoutTls, 'EBMR-SEC-022'],
      [{ ...goodServer, tls: { certFile: 'a', keyFile: 'b', minVersion: 'TLSv1.1' as 'TLSv1.2' } }, 'EBMR-SEC-023'],
      [withoutHsts, 'EBMR-SEC-024'],
      [{ ...goodServer, hsts: { maxAgeSeconds: 3600 } }, 'EBMR-SEC-024'],
      [{ ...goodServer, cookies: { secure: false, httpOnly: true, sameSite: 'Strict' } }, 'EBMR-SEC-025'],
      [{ ...goodServer, cookies: { secure: true, httpOnly: false, sameSite: 'Strict' } }, 'EBMR-SEC-025'],
      [{ ...goodServer, cookies: { secure: true, httpOnly: true, sameSite: 'Lax' } }, 'EBMR-SEC-025'],
    ];
    for (const [cfg, code] of cases) {
      expect(errors(checkServerConfig(cfg)), JSON.stringify(cfg)).toContain(code);
      expect(() => assertProductionConfig({ ...goodConfig, server: cfg })).toThrow(SecurityBaselineError);
    }
    // TLS terminated by a reverse proxy needs no certificate in the application server.
    expect(checkServerConfig({ ...withoutTls, tlsTermination: 'REVERSE_PROXY' })).toEqual([]);
  });

  it('[DI-13] interface connections must use encrypted transports', () => {
    expect(errors(checkIntegrationEndpoint({ name: 'erp', url: 'http://erp.example.in/api' }))).toEqual(['EBMR-SEC-030']);
    expect(errors(checkIntegrationEndpoint({ name: 'ems', url: 'mqtt://ems.example.in:1883' }))).toEqual(['EBMR-SEC-030']);
    expect(errors(checkIntegrationEndpoint({ name: 'press', url: 'opc.tcp://press-01:4840', opcUaSecurityMode: 'None' }))).toEqual(['EBMR-SEC-031']);
    expect(errors(checkIntegrationEndpoint({ name: 'press', url: 'opc.tcp://press-01:4840', opcUaSecurityMode: 'Sign' }))).toEqual(['EBMR-SEC-031']);
    expect(checkIntegrationEndpoint({ name: 'ems', url: 'mqtts://ems.example.in:8883' })).toEqual([]);
  });

  it('[DI-13] a complete TLS configuration passes; the same gaps in development are only warnings', () => {
    expect(assertProductionConfig(goodConfig)).toEqual([]);
    const weak: ProductionConfig = { ...goodConfig, environment: 'development', database: { url: 'postgres://dev@localhost/ebmr' }, server: { ...goodServer, publicUrl: 'http://localhost:3001' } };
    const findings = checkProductionConfig(weak);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.severity === 'WARNING')).toBe(true);
    expect(() => assertProductionConfig({ ...weak, environment: 'validation' })).toThrow(SecurityBaselineError);
  });
});

describe('database connections at run time', () => {
  let db: TestDatabase;
  let serverSsl = false;
  beforeAll(async () => {
    db = await createTestDatabase();
    serverSsl = (await db.admin.query<{ ssl: string }>('show ssl')).rows[0]?.ssl === 'on';
  });
  afterAll(async () => {
    await db.drop();
  });

  it('[DI-13] a non-TLS database session is refused by the server-side check', async () => {
    // The test harness connects without TLS, as a misconfigured application would.
    await expect(assertEncryptedDatabaseSession(db.app)).rejects.toThrow('EBMR-SEC-015');
  });

  it('[DI-13] a client that requires a verified TLS connection never falls back to plain text', async () => {
    // Against a server without TLS the client refuses; against a server whose certificate it cannot verify, too.
    const client = new pg.Client({ connectionString: `${urlFor(db.name, { name: 'ebmr_app', password: 'ebmr_app' })}?sslmode=verify-full` });
    await expect(client.connect()).rejects.toThrow(/SSL|certificate|self.signed/i);
    await client.end().catch(() => undefined);
  });

  it('[DI-13] an encrypted session passes the server-side check (when the database server offers TLS)', async (ctx) => {
    if (!serverSsl) ctx.skip();
    // Certificate verification is out of scope here (test server certificate); the check reads pg_stat_ssl.
    const client = new pg.Client({ connectionString: urlFor(db.name, { name: 'ebmr_app', password: 'ebmr_app' }), ssl: { rejectUnauthorized: false } });
    await client.connect();
    try {
      const session = await assertEncryptedDatabaseSession(client);
      expect(['TLSv1.2', 'TLSv1.3']).toContain(session.version);
    } finally {
      await client.end();
    }
  });
});

describe('database server templates', () => {
  it('[DI-13] the pg_hba.conf template names only roles of the installation: those the migrations create and the provisioned ones it lists (F64)', () => {
    const template = readFileSync(`${OPS}pg_hba.conf.template`, 'utf8');
    const created = readdirSync(SQL)
      .filter((f) => f.endsWith('.sql'))
      .flatMap((f) => [...readFileSync(`${SQL}${f}`, 'utf8').matchAll(/create role\s+([a-z_][a-z0-9_]*)/gi)].map((m) => m[1] ?? ''));
    expect(created).toEqual(expect.arrayContaining(['ebmr_owner', 'ebmr_app', 'ebmr_authn']));
    const provisioned = (/^# provisioned-roles:(.*)$/m.exec(template)?.[1] ?? '').trim().split(/\s+/);
    expect(provisioned).toContain('ebmr_backup');
    const knownRoles = [...created, ...provisioned];
    expect(checkPgHba(template, 'pg_hba.conf', { knownRoles })).toEqual([]);
    // The authentication service connects as ebmr_authn: a rule naming anything else never matches it.
    expect(template).toMatch(/^hostssl\s+\S+\s+ebmr_app,ebmr_authn\s/m);
    expect(checkPgHba('hostssl ebmr_tablets ebmr_app,ebmr_auth 10.10.20.0/24 scram-sha-256', 'pg_hba.conf', { knownRoles }).map((f) => [f.code, f.message])).toEqual([
      ['EBMR-SEC-045', 'role ebmr_auth is not a role of the installation; the rule would never match it'],
    ]);
  });

  it('[DI-13] the pg_hba.conf template admits network connections only over TLS with SCRAM or certificates', () => {
    expect(checkPgHba(readFileSync(`${OPS}pg_hba.conf.template`, 'utf8'))).toEqual([]);
    const bad = [
      'host    all  all  0.0.0.0/0  scram-sha-256',
      'hostssl all  all  10.0.0.0/8 md5',
      'hostssl all  all  10.0.0.0/8 trust',
      'local   all  all             trust',
      'include other.conf',
    ].join('\n');
    const codes = checkPgHba(bad).map((f) => f.code);
    expect(new Set(codes)).toEqual(new Set(['EBMR-SEC-041', 'EBMR-SEC-042', 'EBMR-SEC-043', 'EBMR-SEC-040']));
    // Without any hostssl rule the application could not connect over TLS at all.
    expect(checkPgHba('local all postgres peer').map((f) => f.code)).toEqual(['EBMR-SEC-044']);
    expect(checkPgHba('hostnossl all all 0.0.0.0/0 reject\nhostssl all all 10.0.0.0/8 scram-sha-256')).toEqual([]);
  });

  it('[DI-13] the postgresql.conf template turns TLS on with TLS 1.2 or later and SCRAM hashing', () => {
    expect(checkPostgresqlConf(readFileSync(`${OPS}postgresql.tls.conf.template`, 'utf8'))).toEqual([]);
    expect(checkPostgresqlConf("ssl = off\nssl_min_protocol_version = 'TLSv1'\npassword_encryption = md5").map((f) => f.code)).toEqual([
      'EBMR-SEC-050',
      'EBMR-SEC-051',
      'EBMR-SEC-052',
    ]);
  });
});
