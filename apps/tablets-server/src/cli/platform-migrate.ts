/**
 * The eBMR's migrator on the shared hosting platform (Phase B slice 1; plan decision 2, approved by the lead on 3 Nov 2026).
 * The platform's apply runs it once per apply, in a one-shot container, before it starts the server
 * (databsee manifest `"migrate": "own"`). It connects as a superuser, as the standalone installer does (it creates
 * roles, the DDL-audit event triggers and connection limits), to the database the platform's set-up already created
 * (owner ebmr_owner, app login ebmr_app). Idempotent: an empty database gets every migration, a migrated one only the
 * pending ones; an applied file that changed stops it (kernel migrate).
 *
 *   1. the platform defaults are taken back first (sql-platform/0000_platform_defaults.sql);
 *   2. kernel, site services, recipe-core and tablets migrations, in the standalone order;
 *   3. the connect policy (sandbox.apply_connect_policy, as the installer runs it);
 *   4. the extra login roles: ebmr_authn and ebmr_analytics get EBMR_AUTHN_PASSWORD and EBMR_ANALYTICS_PASSWORD (customer
 *      secrets); every other eBMR login, which the platform does not use (listener, report and the sandbox
 *      logins), is NOLOGIN, so no migration default password ('ebmr_authn' and the like) stays usable;
 *   5. the CSRF and nonce keys and the service-keys file in the keys directory, generated once.
 *
 *   MIGRATE_DATABASE_URL=postgres://postgres:<password>@db:5432/ebmr?sslmode=verify-full&sslrootcert=/tls-ca/server.crt EBMR_AUTHN_PASSWORD=... \
 *   EBMR_ANALYTICS_PASSWORD=... EBMR_KEYS_DIR=/var/lib/ebmr/keys node --import tsx apps/tablets-server/src/cli/platform-migrate.ts
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { migrate, type MigrationSource } from '@ebmr/kernel';
import { editionMigrationSources } from '@ebmr/test-kit';
import { TABLETS_SQL } from './installation.ts';

export const PLATFORM_SQL = new URL('../../sql-platform', import.meta.url).pathname;

/** The eBMR's login roles besides ebmr_app (whose login and password the platform's apply manages). */
export const EXTRA_LOGINS = ['ebmr_authn', 'ebmr_listener', 'ebmr_analytics', 'ebmr_report', 'ebmr_sandbox', 'ebmr_sandbox_listener'] as const;

/** The platform source runs first, then the standalone sources in their standalone order. */
export function platformSources(): MigrationSource[] {
  return [{ namespace: 'platform', directory: PLATFORM_SQL }, ...editionMigrationSources([{ namespace: 'tablets', directory: TABLETS_SQL }])];
}

/** The extra logins the platform uses, with their passwords from the customer secrets. */
export interface ExtraPasswords {
  authn: string;
  analytics: string;
}

/**
 * Step 4: ebmr_authn and ebmr_analytics log in with their passwords; every other extra login is NOLOGIN. With
 * `lockAll` (a migration failed) every extra login is NOLOGIN, so no default password from a migration stays usable.
 * A role that does not exist yet is skipped (format() quotes; the statement is empty then).
 */
export function extraLoginStatements(p: ExtraPasswords, lockAll = false): { sql: string; params: string[] }[] {
  const used: Partial<Record<(typeof EXTRA_LOGINS)[number], string>> = lockAll ? {} : { ebmr_authn: p.authn, ebmr_analytics: p.analytics };
  if (!lockAll) for (const [role, pw] of Object.entries(used)) if (pw.length < 16) throw new Error(`the password of ${role} must have at least 16 characters`);
  const exists = 'where exists (select from pg_catalog.pg_roles where rolname = $1::text)';
  return EXTRA_LOGINS.map((role) => {
    const pw = used[role];
    return pw !== undefined
      ? { sql: `select format('alter role %I login password %L', $1::text, $2::text) as ddl ${exists}`, params: [role, pw] }
      : { sql: `select format('alter role %I nologin', $1::text) as ddl ${exists}`, params: [role] };
  });
}

export interface PlatformMigrateOptions {
  /** Superuser connection to the product's database. */
  url: string;
  passwords: ExtraPasswords;
  keysDir: string;
  /** Tests leave the cluster-wide role attributes alone (other test files use these roles). */
  setLogins?: boolean;
}

export async function platformMigrate(opts: PlatformMigrateOptions): Promise<{ applied: number }> {
  // The passwords are checked before anything changes (a short secret stops the run here).
  const logins = extraLoginStatements(opts.passwords);
  const client = new pg.Client({ connectionString: opts.url });
  await client.connect();
  let ok = false;
  try {
    await client.query(`select format('revoke temporary on database %I from public', current_database()) as ddl`)
      .then((r) => client.query((r.rows[0] as { ddl: string }).ddl));
    const applied = await migrate(client, platformSources());
    await client.query('select sandbox.apply_connect_policy()');
    if (opts.setLogins !== false) await runAll(client, logins);
    writeKeysOnce(opts.keysDir);
    ok = true;
    return { applied: applied.length };
  } finally {
    // A run that stopped part-way locks every extra login the migrations may have created with a default password.
    if (!ok && opts.setLogins !== false) await runAll(client, extraLoginStatements(opts.passwords, true)).catch(() => undefined);
    await client.end();
  }
}

async function runAll(client: pg.Client, statements: { sql: string; params: string[] }[]): Promise<void> {
  for (const s of statements) {
    const { rows } = await client.query<{ ddl: string }>(s.sql, s.params);
    if (rows[0]) await client.query(rows[0].ddl);
  }
}

/** The keys the installer generates once (tools/install plan, "keep"), under the platform's file names. */
export function writeKeysOnce(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // 'wx': never overwrite, also when two runs race (the second one keeps the first one's file).
  const keep = (file: string, content: string) => {
    const path = join(dir, file);
    if (existsSync(path)) return;
    try {
      writeFileSync(path, content, { mode: 0o600, flag: 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  };
  const random = () => randomBytes(32).toString('hex');
  keep('secrets.json', `${JSON.stringify({ csrfHmacKey: random(), nonceKey: random() }, null, 2)}\n`);
  keep('service-keys.json', `${JSON.stringify({ services: [] }, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const need = (name: string): string => {
    const v = process.env[name];
    if (!v) throw new Error(`${name} is required`);
    return v;
  };
  const { applied } = await platformMigrate({ url: need('MIGRATE_DATABASE_URL'), passwords: { authn: need('EBMR_AUTHN_PASSWORD'), analytics: need('EBMR_ANALYTICS_PASSWORD') }, keysDir: need('EBMR_KEYS_DIR') });
  console.log(`ebmr: ${String(applied)} migrations applied`);
}
