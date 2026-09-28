/**
 * Helpers for the sandbox tests (DI-05, INV-18): the edition's migration sources, provisioned sandbox
 * databases and connection attempts under a given login role.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import pg from 'pg';
import { KERNEL_MIGRATIONS, type MigrationSource } from '../../src/db/migrate.ts';
import { provisionSandboxDatabase } from '../../src/sandbox/provision.ts';
import { ADMIN_URL, urlFor } from '../support/db.ts';

export const SANDBOX_LOGIN = { name: 'ebmr_sandbox', password: 'ebmr_sandbox' };
export const APP_LOGIN = { name: 'ebmr_app', password: 'ebmr_app' };
export const AUTHN_LOGIN = { name: 'ebmr_authn', password: 'ebmr_authn' };

/** The migrations of an edition database, as the test template applies them (without the test fixtures). */
export function editionMigrationSources(): MigrationSource[] {
  const sources: MigrationSource[] = [KERNEL_MIGRATIONS];
  const siteServices = new URL('../../../site-services/sql', import.meta.url).pathname;
  if (existsSync(siteServices)) sources.push({ namespace: 'site-services', directory: siteServices });
  const recipeCore = new URL('../../../recipe-core/sql', import.meta.url).pathname;
  if (existsSync(recipeCore)) sources.push({ namespace: 'recipe-core', directory: recipeCore });
  return sources;
}

export const uniqueSuffix = (): string => randomBytes(6).toString('hex');
export const sandboxTestName = (): string => `ebmr_sandbox_t${uniqueSuffix()}`;

export async function onServer<T>(work: (server: pg.Client) => Promise<T>): Promise<T> {
  const server = new pg.Client({ connectionString: ADMIN_URL });
  await server.connect();
  try {
    return await work(server);
  } finally {
    await server.end();
  }
}

export async function dropDatabase(name: string): Promise<void> {
  await onServer((s) => s.query(`drop database if exists "${name}" with (force)`));
}

export async function databaseExists(name: string): Promise<boolean> {
  return onServer(async (s) => (await s.query('select 1 from pg_database where datname = $1', [name])).rows.length > 0);
}

/** Connects as the given login role and runs one query; returns the error message, or null on success. */
export async function attempt(database: string, login: { name: string; password: string }, sql = 'select 1'): Promise<string | null> {
  const client = new pg.Client({ connectionString: urlFor(database, login) });
  try {
    await client.connect();
    await client.query(sql);
    return null;
  } catch (error) {
    return (error as Error).message;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Runs `work` on a superuser client of the database, then closes it. */
export async function asAdmin<T>(database: string, work: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: urlFor(database) });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

export interface TestSandbox {
  name: string;
  /** Superuser pool. */
  admin: pg.Pool;
  /** The sandbox application's pool (ebmr_sandbox). */
  sandbox: pg.Pool;
  drop(): Promise<void>;
}

/** Provisions a fresh sandbox with the edition's migrations and opens its pools. */
export async function provisionTestSandbox(name = sandboxTestName()): Promise<TestSandbox> {
  await provisionSandboxDatabase({ adminUrl: ADMIN_URL, database: name, sources: editionMigrationSources() });
  return openSandbox(name);
}

export function openSandbox(name: string): TestSandbox {
  const admin = new pg.Pool({ connectionString: urlFor(name), max: 2 });
  const sandbox = new pg.Pool({ connectionString: urlFor(name, SANDBOX_LOGIN), max: 2 });
  return {
    name,
    admin,
    sandbox,
    async drop() {
      await admin.end();
      await sandbox.end();
      await dropDatabase(name);
    },
  };
}
