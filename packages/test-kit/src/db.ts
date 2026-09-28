/**
 * Databases for tests, demos and E2E runs: template databases built once from the edition's migrations,
 * copies per test file (CREATE DATABASE ... TEMPLATE), and pools for the three login roles.
 *
 * Database-level privileges are not copied from a template, so every copy re-applies what kernel migration
 * 0001 sets (no TEMPORARY for PUBLIC) and the sandbox connect policy (kernel 0800, INV-18).
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import pg from 'pg';
import { KERNEL_MIGRATIONS, migrate, type AppliedMigration, type MigrationSource } from '@ebmr/kernel';
import type { identity } from '@ebmr/kernel';

export type { MigrationSource };

/** Superuser connection (tests, set-up CLI, demo); the database part is replaced per database. */
export const ADMIN_URL = process.env['EBMR_PG_ADMIN_URL'] ?? 'postgres://ebmr_dev:ebmr_dev@localhost:5432/postgres';

export interface LoginRole {
  name: string;
  password: string;
}
/** Development credentials of the login roles (kernel migrations 0001, 0100, 0800); production uses a vault. */
export const APP_LOGIN: LoginRole = { name: 'ebmr_app', password: 'ebmr_app' };
export const AUTHN_LOGIN: LoginRole = { name: 'ebmr_authn', password: 'ebmr_authn' };
export const SANDBOX_LOGIN: LoginRole = { name: 'ebmr_sandbox', password: 'ebmr_sandbox' };

export type InstallationKind = 'GMP' | 'SANDBOX';

export function urlFor(database: string, user?: LoginRole, adminUrl = ADMIN_URL): string {
  const url = new URL(adminUrl);
  url.pathname = `/${encodeURIComponent(database)}`;
  if (user) {
    url.username = user.name;
    url.password = user.password;
  }
  return url.toString();
}

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;
export const uniqueSuffix = (): string => randomBytes(6).toString('hex');

export async function onServer<T>(work: (server: pg.Client) => Promise<T>, adminUrl = ADMIN_URL): Promise<T> {
  const server = new pg.Client({ connectionString: adminUrl });
  await server.connect();
  try {
    return await work(server);
  } finally {
    await server.end();
  }
}

export async function databaseExists(name: string, adminUrl = ADMIN_URL): Promise<boolean> {
  return onServer(async (s) => (await s.query('select 1 from pg_catalog.pg_database where datname = $1', [name])).rows.length > 0, adminUrl);
}

export async function dropDatabase(name: string, adminUrl = ADMIN_URL): Promise<void> {
  await onServer((s) => s.query(`drop database if exists ${quoteIdent(name)} with (force)`), adminUrl);
}

/** Runs `work` on a superuser client of one database. */
export async function asAdmin<T>(database: string, work: (c: pg.Client) => Promise<T>, adminUrl = ADMIN_URL): Promise<T> {
  const client = new pg.Client({ connectionString: urlFor(database, undefined, adminUrl) });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/**
 * The migrations of a tablets edition database, in order: kernel, site services, recipe-core, then any
 * edition sources (the tablets server passes its own `sql` directory; test-kit never imports an app).
 */
export function editionMigrationSources(extra: MigrationSource[] = []): MigrationSource[] {
  const sources: MigrationSource[] = [KERNEL_MIGRATIONS];
  const siteServices = new URL('../../site-services/sql', import.meta.url).pathname;
  if (existsSync(siteServices)) sources.push({ namespace: 'site-services', directory: siteServices });
  const recipeCore = new URL('../../recipe-core/sql', import.meta.url).pathname;
  if (existsSync(recipeCore)) sources.push({ namespace: 'recipe-core', directory: recipeCore });
  return [...sources, ...extra];
}

/**
 * Creates a GMP database (never under the sandbox prefix) and applies the migrations. Used for templates
 * (tests copy them) and for the demo and E2E GMP databases.
 */
export async function createGmpDatabase(name: string, sources: MigrationSource[], adminUrl = ADMIN_URL): Promise<AppliedMigration[]> {
  if (name.toLowerCase().startsWith('ebmr_sandbox_')) throw new Error(`${name} is a sandbox name; a GMP database may not use it (DI-05)`);
  await onServer((s) => s.query(`create database ${quoteIdent(name)} template template0 encoding 'UTF8'`), adminUrl);
  try {
    await onServer((s) => s.query(`revoke temporary on database ${quoteIdent(name)} from public`), adminUrl);
    const applied = await asAdmin(name, (c) => migrate(c, sources), adminUrl);
    await asAdmin(name, (c) => c.query('select sandbox.apply_connect_policy()'), adminUrl);
    return applied;
  } catch (error) {
    await dropDatabase(name, adminUrl);
    throw error;
  }
}

/** `createTemplateDatabase(sources)`: a GMP template with a unique name, returned for copying. */
export async function createTemplateDatabase(sources: MigrationSource[], opts: { prefix?: string; adminUrl?: string } = {}): Promise<string> {
  const name = `${opts.prefix ?? 'ebmr_tpl'}_${uniqueSuffix()}`;
  await createGmpDatabase(name, sources, opts.adminUrl ?? ADMIN_URL);
  return name;
}

/**
 * Copies a template (GMP or sandbox) under a new name and re-applies the database privileges and the connect
 * policy. A SANDBOX-marked template must be copied under an ebmr_sandbox_* name, a GMP one under any other
 * name, or the copy reports no installation kind (EBMR-SBX-004).
 */
export async function copyDatabase(template: string, name: string, adminUrl = ADMIN_URL): Promise<void> {
  await onServer(async (s) => {
    await s.query(`create database ${quoteIdent(name)} template ${quoteIdent(template)}`);
    await s.query(`revoke connect, temporary on database ${quoteIdent(name)} from public`);
  }, adminUrl);
  await asAdmin(name, (c) => c.query('select sandbox.apply_connect_policy()'), adminUrl);
}

/** Pools of one database for the roles a server uses. */
export interface DatabaseHandle {
  name: string;
  kind: InstallationKind;
  /** Superuser pool (set-up, attacks that need superuser rights). */
  admin: pg.Pool;
  /** The application role: ebmr_app in GMP, ebmr_sandbox in a sandbox. */
  app: pg.Pool;
  /** The authentication service: ebmr_authn in GMP, ebmr_sandbox in a sandbox (mirrored privileges). */
  authn: identity.AuthnDb;
  close(): Promise<void>;
}

export function openDatabase(name: string, kind: InstallationKind, opts: { adminUrl?: string; max?: number } = {}): DatabaseHandle {
  const adminUrl = opts.adminUrl ?? ADMIN_URL;
  const max = opts.max ?? 4;
  const admin = new pg.Pool({ connectionString: urlFor(name, undefined, adminUrl), max: 2 });
  const app = new pg.Pool({ connectionString: urlFor(name, kind === 'GMP' ? APP_LOGIN : SANDBOX_LOGIN, adminUrl), max });
  const authnPool = new pg.Pool({ connectionString: urlFor(name, kind === 'GMP' ? AUTHN_LOGIN : SANDBOX_LOGIN, adminUrl), max: 2 });
  return {
    name,
    kind,
    admin,
    app,
    authn: { pool: authnPool },
    async close() {
      await Promise.all([admin.end(), app.end(), authnPool.end()]);
    },
  };
}
