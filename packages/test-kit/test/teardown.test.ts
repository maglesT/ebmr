/**
 * Teardown of test databases: a handle's close() resolves only once the socket of every connection its pools opened has
 * closed (endPool). A client that ended cleanly (an idle one sends its Terminate message) sees its socket closed only
 * when its backend has exited, so the forced DROP DATABASE that follows terminates none of those; a connection pg cuts
 * itself (broken, or a query still running) can receive nothing from the drop.
 *
 * pg-pool's end() resolves as soon as it has asked its idle clients to end: each has written its Terminate message,
 * but its backend may not have read it yet. A forced drop run then terminates that backend (FATAL 57P01, "terminating
 * connection due to administrator command"); the client, still ending, receives the error while idle, the pool
 * re-emits it as an 'error' event, and with no listener Vitest reports an unhandled error that fails the run although
 * every test passed. On a loaded machine that happened now and then (seed.test.ts, signed-content-hold-point.test.ts).
 *
 * A relay between the pools and PostgreSQL (packages/kernel/test/harness/relay.ts) keeps back each client's Terminate
 * message, as if its backend had not yet been scheduled to read it, and lets the connections go one at a time: the race
 * is the same on every run. close() must stay pending until the last connection has closed and resolve as soon as it
 * has, so one that waits for only some connections, leaves out a pool, or waits a fixed time instead fails. endPool
 * must also wait for a client that pg-pool's idle timeout has already removed while it is still ending (a pool of
 * openDatabase removes a client idle for 10 s): pg-pool's own end() no longer sees that client. The kernel's template
 * database is copied for each test (the db project's global set-up builds it).
 */
import { once } from 'node:events';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterEach, describe, expect, inject, it } from 'vitest';
import {
  HOLD_MS,
  backendsOf,
  expectEndPoolWaitsForIdleRemovedClient,
  expectTeardownWaitsForEveryBackend,
  hasSettled,
  poolsOf,
  startRelay,
  type Relay,
} from '../../kernel/test/harness/relay.ts';
import { bootstrapInstallation, copyDatabase, dropDatabase, endPool, onServer, openDatabase, openPool, uniqueSuffix, urlFor, type DatabaseHandle } from '../src/index.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A copy of the kernel template, dropped after the test. */
async function copied(): Promise<string> {
  const name = `ebmr_tk_${uniqueSuffix()}`;
  await copyDatabase(inject('templateDb'), name);
  cleanups.push(() => dropDatabase(name));
  return name;
}

/** A copy of the kernel template reached through a relay; dropped (and the relay closed) after the test. */
async function relayedDatabase(): Promise<{ relay: Relay; name: string }> {
  const relay = await startRelay();
  cleanups.push(() => relay.close());
  return { relay, name: await copied() };
}

/** One idle connection in the admin and authentication pools and two in the application pool. */
async function idleConnections(db: DatabaseHandle): Promise<void> {
  const app = await Promise.all([db.app.connect(), db.app.connect()]);
  for (const c of app) c.release();
  await db.admin.query('select 1');
  await db.authn.pool.query('select 1');
}

describe('test-kit teardown', () => {
  it('[meta] pg-pool alone: end() resolves while its client is still ending, and a forced drop then makes the pool emit FATAL 57P01', async () => {
    const { relay, name } = await relayedDatabase();
    const pool = new pg.Pool({ connectionString: urlFor(name, undefined, relay.adminUrl), max: 1 });
    await pool.query('select 1');
    relay.holdTerminates();
    await pool.end();
    await relay.until((cs) => cs.every((c) => c.clientEnded && c.held));
    expect(relay.connections.map((c) => c.closed)).toEqual([false]);
    expect(await backendsOf(name)).toHaveLength(1);
    const failed = once(pool, 'error') as Promise<[Error & { code?: string; client?: { _ending?: boolean } }]>;
    await dropDatabase(name);
    const [error] = await failed;
    expect(error.code).toBe('57P01');
    expect(error.client?._ending).toBe(true);
  });

  it.each(['admin', 'app', 'authn.pool'])(
    '[meta] a handle closes only once every backend of each of its pools has exited, so the forced drop after it ends none of them (%s let go last)',
    async (last) => {
      const { relay, name } = await relayedDatabase();
      const db = openDatabase(name, 'GMP', { adminUrl: relay.adminUrl });
      const pools = poolsOf(db);
      // Every pool of the handle is checked; a pool added to it must be added to the cases above too. Each can be
      // ended only by endPool (pg-pool's own end() is refused), so none is ended the racy way.
      expect(Object.keys(pools)).toEqual(['admin', 'app', 'authn.pool']);
      for (const pool of Object.values(pools)) expect(() => pool.end()).toThrow(/^a pool made by openPool\(\) is ended with endPool\(\)/);
      await expectTeardownWaitsForEveryBackend({ relay, database: name, pools, last, teardown: () => db.close(), resolvesWithLastBackend: true });
      await dropDatabase(name);
    },
  );

  it.each([
    { others: 'no other client', withIdleClient: false },
    { others: 'another client still idle in the pool', withIdleClient: true },
  ])('[meta] endPool also waits for a client the idle timeout removed that is still ending, which pg-pool\'s end() no longer sees ($others)', async ({ withIdleClient }) => {
    const { relay, name } = await relayedDatabase();
    await expectEndPoolWaitsForIdleRemovedClient({ relay, database: name, connectionString: urlFor(name, undefined, relay.adminUrl), open: openPool, end: endPool, withIdleClient });
  });

  it('[meta] closing hides nothing: the pools have no error listener, and a backend ended while its client closes still reaches the pool', async () => {
    const { relay, name } = await relayedDatabase();
    const db = openDatabase(name, 'GMP', { adminUrl: relay.adminUrl });
    await idleConnections(db);
    const pools = [db.admin, db.app, db.authn.pool];

    relay.holdTerminates();
    const closing = db.close();
    cleanups.push(async () => {
      relay.releaseAll();
      await closing;
    });
    await relay.until((cs) => cs.length === 4 && cs.every((c) => c.clientEnded && c.held));
    expect(pools.map((p) => p.listenerCount('error'))).toEqual([0, 0, 0]);

    // Not the handle's own teardown: someone else ends the application pool's backends while its clients are closing.
    const errors: (Error & { code?: string })[] = [];
    const bothFailed = new Promise<void>((resolve) => {
      db.app.on('error', (error: Error & { code?: string }) => {
        errors.push(error);
        if (errors.length === 2) resolve();
      });
    });
    const appPids = await onServer(async (s) =>
      (await s.query<{ pid: number }>("select pid from pg_catalog.pg_stat_activity where datname = $1 and backend_type = 'client backend' and usename = 'ebmr_app'", [name])).rows.map((r) => r.pid),
    );
    expect(appPids).toHaveLength(2);
    await onServer((s) => s.query('select pg_catalog.pg_terminate_backend(pid) from unnest($1::int[]) pid', [appPids]));
    await bothFailed;
    expect(errors.map((e) => e.code)).toEqual(['57P01', '57P01']);

    relay.releaseAll();
    await closing;
    expect(await backendsOf(name)).toEqual([]);
  });

  it('[meta] bootstrapInstallation returns only once the backends of its own pool have exited', async () => {
    const { relay, name } = await relayedDatabase();
    relay.holdTerminates();
    const bootstrapping = bootstrapInstallation(name, 'GMP', relay.adminUrl);
    cleanups.push(async () => {
      relay.releaseAll();
      await bootstrapping.catch(() => undefined);
    });
    await relay.until((cs) => cs.length > 0 && cs.every((c) => c.clientEnded && c.held));
    const held = [...relay.connections];
    await delay(HOLD_MS);
    expect(await hasSettled(bootstrapping), `still pending after ${HOLD_MS} ms with every Terminate held`).toBe(false);
    expect(await backendsOf(name)).toHaveLength(held.length);

    // Let the connections go one at a time: it stays pending until the last one has closed.
    for (const connection of held.slice(0, -1)) {
      relay.release(connection);
      await relay.until(() => connection.closed);
      await delay(HOLD_MS);
      expect(await hasSettled(bootstrapping)).toBe(false);
    }
    const lastOne = held.at(-1);
    if (!lastOne) throw new Error('no connection');
    relay.release(lastOne);
    const bootstrap = await bootstrapping;
    expect(bootstrap.admin.roleCode).toBe('SYSTEM_ADMINISTRATOR');
    expect(relay.connections.every((c) => c.closed)).toBe(true);
    expect(await backendsOf(name)).toEqual([]);
  });

  it('[meta] a pool made by openPool refuses its own end(), which resolves before the backends have exited; endPool ends it', async () => {
    const pool = openPool({ connectionString: urlFor(`ebmr_tk_${uniqueSuffix()}`), max: 1 });
    expect(() => pool.end()).toThrow(/^a pool made by openPool\(\) is ended with endPool\(\)/);
    expect(pool.ending).toBe(false);
    await endPool(pool);
    expect(pool.ended).toBe(true);
  });

  it('[meta] endPool refuses a pool whose connections it cannot follow, and leaves that pool as it was', async () => {
    // Never connected, so ending it afterwards leaves no backend behind.
    const pool = new pg.Pool({ connectionString: urlFor(`ebmr_tk_${uniqueSuffix()}`), max: 1 });
    await expect(endPool(pool)).rejects.toThrow(/^endPool\(\) waits only for pools made by openPool\(\)/);
    expect(pool.ending).toBe(false);
    await pool.end();
  });

  it('[meta] a connection pg cuts itself (a query still running when it goes back to an ending pool) is not waited for, and the forced drop that ends its backend raises nothing', async () => {
    const name = await copied();
    const pool = openPool({ connectionString: urlFor(name), max: 1 });
    const errors: Error[] = [];
    pool.on('error', (error) => errors.push(error));
    const client = await pool.connect();
    const pid = (await client.query<{ pid: number }>('select pg_catalog.pg_backend_pid() as pid')).rows[0]?.pid;
    const running = client.query('select pg_catalog.pg_sleep(60)');
    const cut = expect(running).rejects.toThrow(/^Connection terminated$/);
    const sleeping = async () =>
      onServer(async (s) => (await s.query("select 1 from pg_catalog.pg_stat_activity where pid = $1 and state = 'active' and query like '%pg_sleep%'", [pid])).rows.length === 1);
    while (!(await sleeping())) await delay(20);

    const ending = endPool(pool);
    // A client still checked out keeps the pool from ending.
    expect(await hasSettled(ending)).toBe(false);
    // Back to the ending pool with its query running, the client is ended by destroying its socket: no Terminate.
    client.release();
    await ending;
    await cut;
    // So the wait is over while the backend still runs the query; a closed socket receives nothing from it.
    expect(await sleeping()).toBe(true);
    await dropDatabase(name);
    expect((await backendsOf(name)).map((b) => b.pid)).not.toContain(pid);
    await new Promise((resolve) => setImmediate(resolve));
    expect(errors).toEqual([]);
  });
});

/** The .ts files under `dir` (relative to the repository root), leaving out installed and generated folders. */
function sourcesUnder(root: string, dir: string): string[] {
  if (!existsSync(join(root, dir))) return [];
  return readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.(ts|tsx|mts)$/.test(file) && !/(^|\/)(node_modules|dist|test-results|playwright-report)\//.test(file))
    .map((file) => `${dir}/${file}`);
}

describe('test code opens the pools it ends with openPool', () => {
  it('[meta] outside the kernel (which checks its own tests), no test code makes a pg.Pool without openPool, except this file', () => {
    const root = fileURLToPath(new URL('../../..', import.meta.url));
    // The test-kit, every package's and app's tests, and the tools that open test databases through the test-kit.
    const dirs = [
      'packages/test-kit/src',
      ...readdirSync(join(root, 'packages'))
        .filter((pkg) => pkg !== 'kernel')
        .map((pkg) => `packages/${pkg}/test`),
      ...readdirSync(join(root, 'apps')).map((app) => `apps/${app}/test`),
      'tools/e2e',
      'tools/demo',
    ];
    const plain = dirs
      .flatMap((dir) => sourcesUnder(root, dir))
      .filter((file) => /\bnew\s+(?:pg\.)?Pool\s*\(/.test(readFileSync(join(root, file), 'utf8')))
      .sort();
    // This file makes plain pools to show what pg-pool's end() does and what endPool refuses.
    expect(plain).toEqual(['packages/test-kit/test/teardown.test.ts']);
  });
});
