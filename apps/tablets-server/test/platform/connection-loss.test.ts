/**
 * Requirement R3.12 (hosted-demo trials, October 2026): the servers ended when PostgreSQL restarted (57P01 arrived as an
 * 'error' event no one listened to) and the site stayed down until someone restarted them. These tests end every backend
 * of a running server's database, with connections both idle in the pools and handed out between queries, and expect the
 * server to log the loss, stay up and answer the next requests on new connections.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { endPool, onServer, openPool } from '@ebmr/test-kit';
import { CONNECTION_LOST_LOG, surviveConnectionLoss } from '../../src/platform/db/pools.ts';
import { logCollector, startServer, type TestServer } from '../support/harness.ts';

const terminateAll = (database: string): Promise<number> =>
  onServer(async (s) => (await s.query<{ n: number }>('select count(pg_catalog.pg_terminate_backend(pid))::int as n from pg_catalog.pg_stat_activity where datname = $1 and usename <> current_user', [database])).rows[0]?.n ?? 0);

describe('R3.12: a lost database connection never ends the server', () => {
  const logs = logCollector();
  let server: TestServer;
  beforeAll(async () => {
    server = await startServer('GMP', { logStream: logs.stream });
  });
  afterAll(async () => {
    await server.close();
  });

  it('[meta] the server stays up when every backend is terminated (57P01) and answers on new connections', async () => {
    const before = await server.asPersona('steward');
    expect((await before.call(routes.session.get)).ok).toBe(true);
    // Connections idle in both pools, and one of each handed out and between queries.
    await Promise.all(Array.from({ length: 3 }, () => server.db.app.query('select 1')));
    await server.db.authn.pool.query('select 1');
    const heldApp = await server.db.app.connect();
    const heldAuthn = await server.db.authn.pool.connect();
    const lostBefore = logs.lines().filter((l) => l.includes(CONNECTION_LOST_LOG)).length;

    expect(await terminateAll(server.database)).toBeGreaterThanOrEqual(2);
    // The process is still here (an unhandled 'error' event would have failed the run); the losses are logged.
    for (let i = 0; i < 50 && logs.lines().filter((l) => l.includes(CONNECTION_LOST_LOG)).length < lostBefore + 2; i += 1) await sleep(100);
    expect(logs.lines().filter((l) => l.includes(CONNECTION_LOST_LOG)).length).toBeGreaterThanOrEqual(lostBefore + 2);
    await expect(heldApp.query('select 1')).rejects.toThrow();
    heldApp.release();
    heldAuthn.release();

    // New connections: the same browser's session is read again, and a new sign-in works.
    expect((await before.call(routes.session.get)).ok).toBe(true);
    const after = await server.asPersona('steward');
    expect((await after.call(routes.session.get)).ok).toBe(true);
  });

  it('[meta] surviveConnectionLoss reports a connection lost while idle in the pool, and the pool opens a new one', async () => {
    const pool = openPool({ connectionString: (server.db.admin.options as { connectionString: string }).connectionString, max: 2 });
    const errors: string[] = [];
    surviveConnectionLoss(pool, (e) => errors.push((e as { code?: string }).code ?? e.message));
    surviveConnectionLoss(pool, (e) => errors.push(`twice: ${e.message}`));
    try {
      const { rows } = await pool.query<{ pid: number }>('select pg_catalog.pg_backend_pid() as pid');
      await onServer((s) => s.query('select pg_catalog.pg_terminate_backend($1)', [rows[0]?.pid]));
      for (let i = 0; i < 50 && errors.length === 0; i += 1) await sleep(100);
      expect(errors).toEqual(['57P01']);
      expect((await pool.query<{ one: number }>('select 1 as one')).rows[0]?.one).toBe(1);
    } finally {
      await endPool(pool);
    }
  });
});
