/**
 * Test databases. Global setup builds one template database with every migration applied; each
 * test file gets its own copy (CREATE DATABASE ... TEMPLATE), so tests are isolated and fast.
 *
 * EBMR_PG_ADMIN_URL: a superuser connection (default postgres://ebmr_dev:ebmr_dev@localhost:5432/postgres).
 * The application role is ebmr_app (created by kernel migration 0001).
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';

export const ADMIN_URL = process.env['EBMR_PG_ADMIN_URL'] ?? 'postgres://ebmr_dev:ebmr_dev@localhost:5432/postgres';

export function urlFor(database: string, user?: { name: string; password: string }): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${database}`;
  if (user) {
    url.username = user.name;
    url.password = user.password;
  }
  return url.toString();
}

export interface TestDatabase {
  name: string;
  /** Superuser pool: for setup and for attacks that need superuser rights. */
  admin: pg.Pool;
  /** Application-role pool: what the product uses; bypass tests attack through this. */
  app: pg.Pool;
  drop(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `ebmr_t_${randomBytes(6).toString('hex')}`;
  const server = new pg.Client({ connectionString: ADMIN_URL });
  await server.connect();
  await server.query(`create database ${name} template ${inject('templateDb')}`);
  // Database-level privileges are not copied from a template; re-apply what kernel migration 0001 sets.
  await server.query(`revoke temporary on database ${name} from public`);
  await server.end();
  const admin = new pg.Pool({ connectionString: urlFor(name), max: 4 });
  // Database-level CONNECT privileges are not copied from a template either (sandbox 0800, INV-18).
  const { rows } = await admin.query<{ fn: string | null }>("select to_regprocedure('sandbox.apply_connect_policy()')::text as fn");
  if (rows[0]?.fn) await admin.query('select sandbox.apply_connect_policy()');
  const app = new pg.Pool({ connectionString: urlFor(name, { name: 'ebmr_app', password: 'ebmr_app' }), max: 4 });
  return {
    name,
    admin,
    app,
    async drop() {
      // pool.end() resolves once its clients are removed, before their sockets finish closing, so the
      // forced DROP below can terminate a backend whose client is still closing (FATAL 57P01). The pool
      // re-emits that as an 'error' event; without a listener it becomes an unhandled error that fails
      // the whole run. At teardown it is noise, not a test result.
      for (const pool of [admin, app]) pool.on('error', () => undefined);
      await admin.end();
      await app.end();
      const s = new pg.Client({ connectionString: ADMIN_URL });
      await s.connect();
      await s.query(`drop database if exists ${name} with (force)`);
      await s.end();
    },
  };
}
