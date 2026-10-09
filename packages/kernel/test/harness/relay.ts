/**
 * A TCP relay between pg clients and the PostgreSQL server of ADMIN_URL that keeps back what each client sends from
 * its Terminate message on, as if the backend had not yet been scheduled to read it, and lets each connection go on
 * its own. With it the teardown race (a forced DROP DATABASE run while a client is still ending) is the same on every
 * run, and a teardown can be checked to wait for every backend, not only for some of them or for a while.
 *
 * The relay reads the client's messages in the clear: the test URLs ask for no TLS.
 */
import { once } from 'node:events';
import net from 'node:net';
import { setImmediate as nextMacrotask, setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { expect } from 'vitest';
import { ADMIN_URL } from '../support/db.ts';

export interface RelayedConnection {
  /** The relay's local port towards the server: pg_stat_activity.client_port of this connection's backend. */
  serverSidePort: number | null;
  /** The client has sent its Terminate message and ended its side. */
  clientEnded: boolean;
  /** A Terminate message of this connection is being kept back. */
  held: boolean;
  /** Both sockets are closed: the server closed its side, which PostgreSQL does for a Terminate once the backend has exited. */
  closed: boolean;
}

export interface Relay {
  /** ADMIN_URL with its host and port replaced by the relay's. */
  adminUrl: string;
  connections: readonly RelayedConnection[];
  /** From now on each client's Terminate message (and its end) is kept back: its backend has not read it yet. */
  holdTerminates(): void;
  /** Forwards what one connection kept back, and its client's end; the others stay held. */
  release(connection: RelayedConnection): void;
  /** Stops holding and forwards everything kept back. */
  releaseAll(): void;
  /** Resolves once `ready(connections)` holds. */
  until(ready: (connections: readonly RelayedConnection[]) => boolean): Promise<void>;
  close(): Promise<void>;
}

const TERMINATE = 0x58; // 'X', the last message a client sends
/** Codes of the untyped requests a client may send before its startup message (SSL, GSSAPI encryption, cancel). */
const PRE_STARTUP_CODES = new Set([80877102, 80877103, 80877104]);

/**
 * Follows the messages a client sends (the startup message and the requests before it have no type byte, every later
 * message has) and returns the offset in `chunk` where a Terminate message starts, or -1.
 */
function terminateFinder(): (chunk: Buffer) => number {
  let startup = true;
  let header = Buffer.alloc(0);
  let body: Buffer[] = [];
  let remaining = 0;
  return (chunk) => {
    let i = 0;
    while (i < chunk.length) {
      if (remaining > 0) {
        const n = Math.min(remaining, chunk.length - i);
        if (startup) body.push(chunk.subarray(i, i + n));
        remaining -= n;
        i += n;
        if (remaining === 0 && startup) {
          // A request before the startup message is followed by another untyped message.
          const code = Buffer.concat(body).readInt32BE(0);
          if (!PRE_STARTUP_CODES.has(code)) startup = false;
          body = [];
        }
        continue;
      }
      if (!startup && header.length === 0 && chunk[i] === TERMINATE) return i;
      const headerLength = startup ? 4 : 5;
      const take = chunk.subarray(i, i + headerLength - header.length);
      header = Buffer.concat([header, take]);
      i += take.length;
      if (header.length === headerLength) {
        remaining = header.readInt32BE(headerLength - 4) - 4;
        header = Buffer.alloc(0);
      }
    }
    return -1;
  };
}

/** Starts a relay to the server of ADMIN_URL on a free local port. */
export async function startRelay(): Promise<Relay> {
  const target = new URL(ADMIN_URL);
  const connections: RelayedConnection[] = [];
  const pairs = new Map<RelayedConnection, { client: net.Socket; upstream: net.Socket; kept: Buffer[] | null }>();
  const waiters = new Set<() => void>();
  const changed = () => {
    for (const check of [...waiters]) check();
  };
  let holding = false;
  const forward = (state: RelayedConnection) => {
    const pair = pairs.get(state);
    if (!pair?.kept) return;
    const kept = pair.kept;
    pair.kept = null;
    state.held = false;
    if (pair.upstream.destroyed) return;
    for (const chunk of kept) pair.upstream.write(chunk);
    if (state.clientEnded) pair.upstream.end();
  };
  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    const upstream = net.connect({ host: target.hostname, port: Number(target.port || 5432), allowHalfOpen: true });
    const state: RelayedConnection = { serverSidePort: null, clientEnded: false, held: false, closed: false };
    const pair = { client, upstream, kept: null as Buffer[] | null };
    pairs.set(state, pair);
    connections.push(state);
    upstream.once('connect', () => {
      state.serverSidePort = upstream.localPort ?? null;
      changed();
    });
    const findTerminate = terminateFinder();
    client.on('data', (chunk: Buffer) => {
      if (pair.kept) {
        pair.kept.push(chunk);
        return;
      }
      const at = findTerminate(chunk);
      if (at < 0 || !holding) {
        upstream.write(chunk);
        return;
      }
      upstream.write(chunk.subarray(0, at));
      pair.kept = [chunk.subarray(at)];
      state.held = true;
      changed();
    });
    client.on('end', () => {
      state.clientEnded = true;
      if (!pair.kept) upstream.end();
      changed();
    });
    upstream.on('data', (chunk: Buffer) => client.write(chunk));
    upstream.on('end', () => client.end());
    const closeBoth = () => {
      client.destroy();
      upstream.destroy();
      if (!state.closed) {
        state.closed = true;
        changed();
      }
    };
    for (const socket of [client, upstream]) {
      socket.on('close', closeBoth);
      socket.on('error', closeBoth);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as net.AddressInfo;
  const relayed = new URL(ADMIN_URL);
  relayed.hostname = '127.0.0.1';
  relayed.port = String(address.port);
  return {
    adminUrl: relayed.toString(),
    connections,
    holdTerminates() {
      holding = true;
    },
    release(connection) {
      forward(connection);
    },
    releaseAll() {
      holding = false;
      for (const state of connections) forward(state);
    },
    until(ready) {
      return new Promise<void>((resolve) => {
        const check = () => {
          if (!ready(connections)) return;
          waiters.delete(check);
          resolve();
        };
        waiters.add(check);
        check();
      });
    },
    async close() {
      for (const { client, upstream } of pairs.values()) {
        client.destroy();
        upstream.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Runs `work` on a direct superuser connection to the server (not through any relay). */
export async function onServer<T>(work: (server: pg.Client) => Promise<T>): Promise<T> {
  const server = new pg.Client({ connectionString: ADMIN_URL });
  await server.connect();
  try {
    return await work(server);
  } finally {
    await server.end();
  }
}

/** Client backends connected to `database` (an autovacuum worker may visit it too; it is no client's). */
export async function backendsOf(database: string): Promise<{ pid: number; port: number | null }[]> {
  return onServer(async (s) =>
    (
      await s.query<{ pid: number; port: number | null }>(
        "select pid, client_port as port from pg_catalog.pg_stat_activity where datname = $1 and backend_type = 'client backend' order by pid",
        [database],
      )
    ).rows,
  );
}

/** Whether `promise` has settled by the time callbacks already queued (ticks, microtasks, one macrotask) have run. */
export async function hasSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  await nextMacrotask();
  return settled;
}

/**
 * How long a teardown must stay pending while every Terminate is held: a teardown that waits a fixed time instead of
 * for the backends is caught when that time is shorter.
 */
export const HOLD_MS = 500;

/** Resolves when `pool` has removed `client`, which pg-pool does once the client's socket has closed. */
function removal(pool: pg.Pool, client: pg.PoolClient): Promise<void> {
  return new Promise((resolve) => {
    const onRemove = (removed: pg.PoolClient) => {
      if (removed !== client) return;
      pool.off('remove', onRemove);
      resolve();
    };
    pool.on('remove', onRemove);
  });
}

/** Every pg.Pool among the properties of `handle`, and of the objects it holds (one level down), by property path. */
export function poolsOf(handle: object): Record<string, pg.Pool> {
  const found: Record<string, pg.Pool> = {};
  for (const [key, value] of Object.entries(handle)) {
    if (value instanceof pg.Pool) found[key] = value;
    else if (value && typeof value === 'object') {
      for (const [inner, v] of Object.entries(value as object)) if (v instanceof pg.Pool) found[`${key}.${inner}`] = v;
    }
  }
  return found;
}

export interface TeardownCase {
  relay: Relay;
  /** The database the pools are connected to (through the relay). */
  database: string;
  /** Every pool of the handle under test, by name; none may have connected yet. */
  pools: Record<string, pg.Pool>;
  /** The pool whose connections are let go last. */
  last: string;
  /** The teardown under test: ends the pools (and may drop the database afterwards). */
  teardown: () => Promise<void>;
  /**
   * The teardown does nothing once its pools have ended (it drops no database): it must then have resolved by the time
   * the pool of the last connection has removed that client, before any timer can have run. A drop that follows takes
   * its own time, so a teardown that drops says false here.
   */
  resolvesWithLastBackend: boolean;
}

/**
 * Checks that `teardown` resolves only once every backend of every pool has exited (every connection here is idle, so
 * each client ends cleanly with a Terminate message).
 *
 * Each pool gets two idle connections through the relay. Their Terminate messages are kept back and `teardown` is
 * called: after HOLD_MS it must still be pending, with every backend still there. The connections are then let go one
 * at a time, both of every other pool first, then one of `last`: after each, once its pool has seen the socket close
 * and removed the client, that backend must be gone and `teardown` still pending (with only the last one held, again
 * after HOLD_MS). Only when the second connection of `last` goes may it resolve, and with `resolvesWithLastBackend` it
 * must have resolved once that client is removed. A teardown that waits for one connection per pool, or leaves out a
 * pool, fails here whenever `last` names the pool it gets wrong (run the case once per pool). One that waits a fixed
 * time instead of for the backends fails when the time is under about 2 x HOLD_MS; with `resolvesWithLastBackend` it
 * fails whatever the time, unless the time ends in the few milliseconds between the last two checks. A teardown that
 * drops the database too early terminates a backend that is still held: its pool, with no error listener, then emits
 * FATAL 57P01 as an unhandled error, and the backend is missing at the next check.
 */
export async function expectTeardownWaitsForEveryBackend(c: TeardownCase): Promise<void> {
  expect(Object.keys(c.pools)).toContain(c.last);
  const connections: { pool: string; client: pg.PoolClient; pid: number }[] = [];
  for (const [name, pool] of Object.entries(c.pools)) {
    expect(pool.totalCount, `${name} has not connected yet`).toBe(0);
    const clients = await Promise.all([pool.connect(), pool.connect()]);
    for (const client of clients) {
      const pid = (await client.query<{ pid: number }>('select pg_catalog.pg_backend_pid() as pid')).rows[0]?.pid;
      if (pid === undefined) throw new Error('no backend pid');
      connections.push({ pool: name, client, pid });
    }
    for (const client of clients) client.release();
  }
  const pids = (xs: { pid: number }[]) => xs.map((x) => x.pid).sort((a, b) => a - b);
  await c.relay.until((cs) => cs.length === connections.length && cs.every((r) => r.serverSidePort !== null));
  const byPort = new Map(c.relay.connections.map((r) => [r.serverSidePort, r]));
  const backends = await backendsOf(c.database);
  expect(pids(backends)).toEqual(pids(connections));
  const relayed = new Map(connections.map((x) => [x, byPort.get(backends.find((b) => b.pid === x.pid)?.port ?? null)]));
  for (const [x, r] of relayed) expect(r, `backend ${x.pid} of ${x.pool} is relayed`).toBeDefined();
  const order = [...connections.filter((x) => x.pool !== c.last), ...connections.filter((x) => x.pool === c.last)];

  c.relay.holdTerminates();
  const ending = c.teardown();
  let done = false;
  try {
    // Every client has written its Terminate and ended its side; no backend has read it. (The other two only turn a
    // teardown that settles at once, or a pool it never ends, into a failure below instead of a test time-out.)
    await Promise.race([c.relay.until((cs) => cs.every((r) => r.clientEnded && r.held)), ending.catch(() => undefined), delay(10_000, undefined, { ref: false })]);
    expect(c.relay.connections.map((r) => r.clientEnded && r.held), 'every client has ended and its Terminate is held').toEqual(connections.map(() => true));
    await delay(HOLD_MS);
    expect(await hasSettled(ending), `teardown still pending after ${HOLD_MS} ms with every Terminate held`).toBe(false);
    expect(pids(await backendsOf(c.database))).toEqual(pids(connections));

    for (const [i, x] of order.entries()) {
      const r = relayed.get(x);
      if (!r) throw new Error('unrelayed connection');
      const removed = removal(c.pools[x.pool] as pg.Pool, x.client);
      c.relay.release(r);
      await removed;
      if (i === order.length - 1) break;
      if (i === order.length - 2) await delay(HOLD_MS);
      expect(await hasSettled(ending), `teardown pending while ${order.length - 1 - i} connection(s) are held (${x.pool} ${i + 1} let go)`).toBe(false);
      const left = pids(await backendsOf(c.database));
      expect(left).not.toContain(x.pid);
      expect(left).toEqual(pids(order.slice(i + 1)));
    }
    // The last client is removed (its pool saw the socket close) and pg reports its end on the next tick: a teardown
    // that waits only for the backends has resolved by the next macrotask.
    if (c.resolvesWithLastBackend) expect(await hasSettled(ending), 'teardown resolved as soon as the last connection had closed').toBe(true);
    await ending;
    done = true;
  } finally {
    if (!done) {
      c.relay.releaseAll();
      await ending.catch(() => undefined);
    }
  }
  expect(c.relay.connections.every((r) => r.closed)).toBe(true);
  expect(await backendsOf(c.database)).toEqual([]);
}

/** How long a released client stays idle before its pool's idle timeout removes it, in the idle-removal check. */
export const IDLE_TIMEOUT_MS = 100;

export interface IdleRemovalCase {
  relay: Relay;
  /** The database the pool connects to (through the relay). */
  database: string;
  /** The URL of `database` through the relay. */
  connectionString: string;
  /** Makes the pool under test (an openPool) from the configuration the check gives. */
  open: (config: pg.PoolConfig) => pg.Pool;
  /** Ends the pool (an endPool). */
  end: (pool: pg.Pool) => Promise<void>;
  /** Whether a second client is still idle in the pool when `end` starts, so that pg-pool's own end() has one to end. */
  withIdleClient: boolean;
}

/**
 * Checks that `end` also waits for a client that pg-pool's idle timeout has already removed and that is still ending.
 *
 * pg-pool's idle timeout takes a client off the pool's lists and asks it to end; a pool of `openDatabase` removes a
 * client idle for 10 s (pg-pool's default), so a pool ended after a pause can hold such a client, which pg-pool's own
 * end() no longer sees (with no other client it resolves at once). A forced drop run before that client's backend has
 * read its Terminate ends the backend just the same (FATAL 57P01).
 *
 * The pool gets one connection (two with `withIdleClient`, and a minimum of one, so the idle timeout removes only the
 * first released). Every Terminate is kept back from before the release: once the idle timeout has removed the first
 * client (its Terminate held, its backend still there) `end` is called. It must stay pending for HOLD_MS; with
 * `withIdleClient` the client still idle is let go first, and once its pool has removed it `end` must still be pending
 * after HOLD_MS more. Only when the removed client is let go may it resolve, and it must have resolved by the next
 * macrotask once its pool reports that client removed. An end that waits only for the clients pg-pool still lists when
 * it starts fails here: at the first check without another client, after the idle client is let go with one.
 */
export async function expectEndPoolWaitsForIdleRemovedClient(c: IdleRemovalCase): Promise<void> {
  const pool = c.open({ connectionString: c.connectionString, max: c.withIdleClient ? 2 : 1, min: c.withIdleClient ? 1 : 0, idleTimeoutMillis: IDLE_TIMEOUT_MS });
  const clients: { client: pg.PoolClient; pid: number }[] = [];
  for (let i = 0; i < (c.withIdleClient ? 2 : 1); i++) {
    const client = await pool.connect();
    const pid = (await client.query<{ pid: number }>('select pg_catalog.pg_backend_pid() as pid')).rows[0]?.pid;
    if (pid === undefined) throw new Error('no backend pid');
    clients.push({ client, pid });
  }
  await c.relay.until((cs) => cs.length === clients.length && cs.every((r) => r.serverSidePort !== null));
  const byPort = new Map(c.relay.connections.map((r) => [r.serverSidePort, r]));
  const backends = await backendsOf(c.database);
  const relayedOf = (x: { pid: number }): RelayedConnection => {
    const r = byPort.get(backends.find((b) => b.pid === x.pid)?.port ?? null);
    if (!r) throw new Error(`backend ${x.pid} is not relayed`);
    return r;
  };
  const [removed, idle] = clients;
  if (!removed) throw new Error('no client');
  const pids = (xs: { pid: number }[]) => xs.map((x) => x.pid).sort((a, b) => a - b);

  c.relay.holdTerminates();
  // Released in this order, the first client's idle timer runs first; with a minimum of one the second stays.
  for (const { client } of clients) client.release();
  await c.relay.until(() => relayedOf(removed).clientEnded && relayedOf(removed).held);
  expect(pool.totalCount, 'the idle timeout has taken the removed client off the pool').toBe(clients.length - 1);
  expect(pool.idleCount).toBe(clients.length - 1);
  expect(pids(await backendsOf(c.database)), 'its backend has not read its Terminate').toEqual(pids(clients));

  const ending = c.end(pool);
  let done = false;
  try {
    await Promise.race([c.relay.until((cs) => cs.every((r) => r.clientEnded && r.held)), ending.catch(() => undefined), delay(10_000, undefined, { ref: false })]);
    expect(c.relay.connections.map((r) => r.clientEnded && r.held), 'every client has ended and its Terminate is held').toEqual(clients.map(() => true));
    await delay(HOLD_MS);
    expect(await hasSettled(ending), `end pending after ${HOLD_MS} ms with the removed client's Terminate held`).toBe(false);
    expect(pids(await backendsOf(c.database))).toEqual(pids(clients));

    if (idle) {
      const idleGone = removal(pool, idle.client);
      c.relay.release(relayedOf(idle));
      await idleGone;
      await delay(HOLD_MS);
      expect(await hasSettled(ending), 'end pending while the client the idle timeout removed is held').toBe(false);
      expect(pids(await backendsOf(c.database)), 'only the backend of the removed client is left').toEqual([removed.pid]);
    }
    const removedGone = removal(pool, removed.client);
    c.relay.release(relayedOf(removed));
    await removedGone;
    expect(await hasSettled(ending), 'end resolved as soon as the removed client had closed').toBe(true);
    await ending;
    done = true;
  } finally {
    if (!done) {
      c.relay.releaseAll();
      await ending.catch(() => undefined);
    }
  }
  expect(pool.ended).toBe(true);
  expect(c.relay.connections.every((r) => r.closed)).toBe(true);
  expect(await backendsOf(c.database)).toEqual([]);
}
