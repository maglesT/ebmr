/**
 * MEDHANTA platform, Phase B slice 1 (docs/build-plan/phase-b/platform-move-plan.md, decisions 2 and 3).
 * A database set up the way the platform's set-up does it (databsee db/server/cluster.sql and database.sql: owner
 * ebmr_owner, schemas report and platform, the app login's D-17 default rights) is migrated by Batchwright's own
 * migrator as a superuser. The app login must end up with exactly the rights it holds on a standalone installation
 * (DI-17 least privilege): the platform's default grants are taken back first (0000_platform_defaults).
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { asAdmin, dropDatabase, onServer, uniqueSuffix, urlFor } from '@ebmr/test-kit';
import { extraLoginStatements, platformMigrate, platformSources, EXTRA_LOGINS, writeKeysOnce } from '../../src/cli/platform-migrate.ts';
import { parseConfig, platformEnv } from '../../src/config.ts';

const database = `ebmr_platform_${uniqueSuffix()}`;
const keysDir = mkdtempSync(join(tmpdir(), 'ebmr-platform-keys-'));

/** What databsee db/server/cluster.sql and database.sql do for product ebmr (roles are cluster-wide and exist). */
async function platformInit(): Promise<void> {
  await onServer((s) => s.query(`create database ${database} owner ebmr_owner`));
  await asAdmin(database, async (c) => {
    await c.query(`
      revoke all on schema public from public;
      grant usage on schema public to ebmr_app;
      alter default privileges for role ebmr_owner in schema public revoke update, delete, truncate on tables from ebmr_app;
      alter default privileges for role ebmr_owner in schema public grant select, insert on tables to ebmr_app;
      alter default privileges for role ebmr_owner in schema public grant usage, select on sequences to ebmr_app;
      alter default privileges for role ebmr_owner revoke execute on routines from public;
      alter default privileges for role ebmr_owner grant execute on routines to ebmr_app;
      create schema if not exists report authorization ebmr_owner;
      revoke all on schema report from public;
      create schema if not exists platform authorization ebmr_owner;
      revoke all on schema platform from public;
      create table if not exists platform.home (app text not null, one boolean primary key default true check (one));
      insert into platform.home (app) values ('ebmr_app') on conflict (one) do nothing;
      create table if not exists platform.link_log (id bigint generated always as identity primary key, at timestamptz not null default now(),
        consumer text not null, views text[] not null, switched_on boolean not null, change_ref text not null, reason text not null,
        applied_by text not null default session_user);`);
  });
}

const privileges = (db: string) => asAdmin(db, async (c) =>
  (await c.query<{ p: string }>(`select concat_ws(' ', object_kind, object_name, column_name, privilege) as p from sandbox.direct_privileges('ebmr_app') order by 1`)).rows.map((r) => r.p));
const defaultAcl = (db: string) => asAdmin(db, async (c) =>
  (await c.query<{ a: string }>(`select concat_ws(' ', pg_get_userbyid(defaclrole), coalesce(defaclnamespace::regnamespace::text, '*'), defaclobjtype, defaclacl::text) as a
     from pg_default_acl order by 1`)).rows.map((r) => r.a));

afterAll(async () => {
  await dropDatabase(database);
});

describe('MEDHANTA platform wiring (Phase B slice 1)', () => {
  it('[DI-17] [PL-08] a platform-initialised database migrates to exactly the standalone rights of the app login', async () => {
    await platformInit();
    const first = await platformMigrate({ url: urlFor(database), passwords: { authn: 'x'.repeat(16), analytics: 'y'.repeat(16) }, keysDir, setLogins: false });
    expect(platformSources().map((s) => s.namespace)).toEqual(['platform', 'kernel', 'site-services', 'recipe-core', 'tablets']);
    expect(first.applied).toBeGreaterThan(600);

    const standalone = inject('serverTemplates').gmp.template;
    // The one difference: the platform's set-up takes USAGE on schema public from PUBLIC and grants it to the app login
    // itself (database.sql); on a standalone installation the app login has the same right through PUBLIC.
    const platform = await privileges(database);
    expect(platform.filter((p) => p === 'SCHEMA public USAGE')).toHaveLength(1);
    expect(platform.filter((p) => p !== 'SCHEMA public USAGE')).toEqual(await privileges(standalone));
    // No default right of the platform's set-up is left for the app login (0000_platform_defaults).
    const acl = await defaultAcl(database);
    expect(acl.filter((a) => a.startsWith('ebmr_owner public'))).toEqual([]);
    expect(acl.some((a) => a.includes('ebmr_app=X'))).toBe(false);

    // Idempotent: a second run applies nothing; an apply after a pin change applies only the new files.
    const again = await platformMigrate({ url: urlFor(database), passwords: { authn: 'x'.repeat(16), analytics: 'y'.repeat(16) }, keysDir, setLogins: false });
    expect(again.applied).toBe(0);
  }, 600_000);

  it('[DI-13] the keys are generated once and never overwritten', () => {
    const before = readFileSync(join(keysDir, 'secrets.json'), 'utf8');
    const keys = JSON.parse(before) as { csrfHmacKey: string; nonceKey: string };
    expect(keys.csrfHmacKey).toMatch(/^[0-9a-f]{64}$/);
    expect(keys.nonceKey).toMatch(/^[0-9a-f]{64}$/);
    writeKeysOnce(keysDir);
    expect(readFileSync(join(keysDir, 'secrets.json'), 'utf8')).toBe(before);
  });

  it('[DI-13] no migration default password stays usable: authn and analytics get their secrets, every other extra login is NOLOGIN', () => {
    const s = extraLoginStatements({ authn: 'a-long-secret-password', analytics: 'another-long-secret' });
    expect(s).toHaveLength(EXTRA_LOGINS.length);
    expect(s.filter((x) => x.sql.includes(' login password ')).map((x) => x.params)).toEqual([['ebmr_authn', 'a-long-secret-password'], ['ebmr_analytics', 'another-long-secret']]);
    expect(s.filter((x) => x.sql.includes(' nologin')).map((x) => x.params[0]).sort())
      .toEqual(['ebmr_listener', 'ebmr_report', 'ebmr_sandbox', 'ebmr_sandbox_listener']);
    expect(() => extraLoginStatements({ authn: 'short', analytics: 'another-long-secret' })).toThrow(/ebmr_authn must have at least 16/);
  });

  it('[DI-13] on the platform every database URL is on verified TLS against the platform database\'s certificate', () => {
    const env = {
      EBMR_INSTALLATION: 'GMP', EBMR_ENV: 'production', EBMR_DB_CA_FILE: '/tls-ca/server.crt',
      EBMR_DATABASE_URL: 'postgres://ebmr_app:p%40ss@db:5432/ebmr', EBMR_AUTHN_PASSWORD: 'a@long/secret:pw%', EBMR_ANALYTICS_PASSWORD: 'analytics-secret-1',
      OIDC_REDIRECT_URI: 'https://ebmr.187-126-126-5.sslip.io/cb', EBMR_SECRETS_FILE: join(keysDir, 'secrets.json'),
    };
    const e = platformEnv(env);
    expect(e['EBMR_DATABASE']).toBe('ebmr');
    expect(e['EBMR_PUBLIC_ORIGIN']).toBe('https://ebmr.187-126-126-5.sslip.io');
    for (const [name, user] of [['EBMR_DB_APP_URL', 'ebmr_app'], ['EBMR_DB_AUTHN_URL', 'ebmr_authn'], ['EBMR_DB_ANALYTICS_URL', 'ebmr_analytics']] as const) {
      const u = new URL(e[name]!);
      expect([u.username, u.host, u.pathname, u.searchParams.get('sslmode'), u.searchParams.get('sslrootcert')])
        .toEqual([user, 'db:5432', '/ebmr', 'verify-full', '/tls-ca/server.crt']);
    }
    expect(decodeURIComponent(new URL(e['EBMR_DB_APP_URL']!).password)).toBe('p@ss');
    expect(decodeURIComponent(new URL(e['EBMR_DB_AUTHN_URL']!).password)).toBe('a@long/secret:pw%');

    // The production baseline accepts it with no finding to override (verify-full), and builds the server settings.
    const config = parseConfig(env, () => 'k'.repeat(32));
    expect(config).toMatchObject({ database: 'ebmr', publicOrigin: 'https://ebmr.187-126-126-5.sslip.io', https: true, port: 3000, host: '0.0.0.0' });
    // Without the certificate the platform's plain URL is still refused in production (DI-13 unchanged).
    expect(() => parseConfig({ ...env, EBMR_DB_CA_FILE: undefined, EBMR_DB_APP_URL: env.EBMR_DATABASE_URL, EBMR_DB_AUTHN_URL: env.EBMR_DATABASE_URL,
      EBMR_DB_ANALYTICS_URL: env.EBMR_DATABASE_URL, EBMR_DATABASE: 'ebmr', EBMR_PUBLIC_ORIGIN: 'https://ebmr.187-126-126-5.sslip.io' }, () => 'k'.repeat(32)))
      .toThrow(/without verified TLS/);
    // Standalone environments are untouched.
    expect(platformEnv({ EBMR_DATABASE: 'x' })).toEqual({ EBMR_DATABASE: 'x' });
  });
});
