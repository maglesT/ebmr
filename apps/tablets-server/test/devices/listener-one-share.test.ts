/**
 * The gateway listener under one listener's share of the cluster's connections (kernel 0980; decisions X38, X41;
 * verification of listener-credential-bound, share-wording; controls DI-30, PR-20).
 *
 * One listener's share is what kernel 0980 gives a listener role where none was declared: 8, the 5 connections the
 * listener keeps (RECEIPTS_POOL_MAX and WATCH_POOL_MAX) and 3 spare. With that hard limit the listener cannot open its
 * 5 in two cases, and it then fails closed: backends left half-open by a network fault still count against the limit,
 * and in a rolling deploy the old and the new server overlap (5 + 5 > 8).
 *
 * The server tests' cluster declares a larger share (support/global-setup.ts: the test files run their own listeners
 * side by side on the same cluster-wide roles), so the real listener roles cannot be held at 8 here. The listener runs
 * on a login of its own instead, holding in this database exactly the privileges of ebmr_sandbox_listener and limited
 * to the share kernel 0980 gives (read from the kernel in a transaction that is rolled back); it is dropped afterwards.
 *
 * A half-open backend is made by a relay between the listener and the database that cuts the listener's side of a
 * connection and keeps the database's side open, as a network fault can leave it: the listener sees its connection
 * lost, the database still counts the backend (whose idle_session_timeout the listener's pools fix at 0, decision X42).
 */
import { randomBytes } from 'node:crypto';
import { connect, createServer, type AddressInfo, type Socket } from 'node:net';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_URL, endPool, onServer, openPool, urlFor, type LoginRole } from '@ebmr/test-kit';
import { DevicesRuntime, REWARM_FAILED_LOG, RECEIPTS_POOL_MAX, runtimeOf, TICK_FAILED_LOG, WATCH_POOL_MAX } from '../../src/features/devices/runtime.ts';
import { startGatewayListener } from '../../src/features/devices/listener.ts';
import { logCollector, startServer, type TestServer } from '../support/harness.ts';

const log = logCollector();
let server: TestServer;
/** The listener's stand-in login: a name outside the ebmr_ roles, so no check of those roles sees it. */
const LOGIN: LoginRole = { name: `t_listener_share_${randomBytes(4).toString('hex')}`, password: randomBytes(16).toString('hex') };
let created = false;
/** One listener's share as kernel 0980 sets it where none was declared. */
let share = 0;
const runtimes: DevicesRuntime[] = [];
const relays: Relay[] = [];
const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** Connections of the stand-in login (its limit counts them across the cluster). */
async function backends(): Promise<number> {
  const { rows } = await server.db.admin.query<{ n: number }>('select count(*)::int as n from pg_stat_activity where usename = $1', [LOGIN.name]);
  return rows[0]?.n ?? 0;
}

async function eventually(check: () => Promise<boolean> | boolean, ms = 10_000): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 100) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** Whether the database vouches for the last 10 s (tablets 0350 item 6). */
const attested = async (): Promise<boolean> =>
  (await server.db.admin.query<{ ok: boolean }>("select tab.listener_attested_from(clock_timestamp() - interval '10 seconds') is not null as ok")).rows[0]?.ok === true;

const ticksOf = async (run: string): Promise<number> =>
  (await server.db.admin.query<{ n: number }>('select count(*)::int as n from tab.listener_tick where watch_id = $1', [run])).rows[0]?.n ?? 0;

/** The server's log lines with message `msg`. */
const logged = (msg: string) =>
  log
    .lines()
    .map((l) => JSON.parse(l) as { level?: number; msg?: string; err?: string; code?: string })
    .filter((l) => l.msg === msg);

/** A runtime of the server, as a server started anew holds one (closed after the file). */
function newRuntime(): DevicesRuntime {
  const r = new DevicesRuntime(server.built.ctx);
  runtimes.push(r);
  return r;
}

interface Link {
  client: Socket;
  upstream: Socket;
  cut: boolean;
}

interface Relay {
  port: number;
  /** Every connection made through the relay, in the order the listener opened them. */
  links: Link[];
  /** Cuts the listener's side of `link`; the database's side stays open (a half-open backend). */
  cut(link: Link): void;
  /** Closes the database's side of every cut link: their backends end. */
  heal(): void;
  close(): Promise<void>;
}

/** A TCP relay to the database server of ADMIN_URL. */
async function startRelay(): Promise<Relay> {
  const target = new URL(ADMIN_URL);
  const links: Link[] = [];
  const relay = createServer((client) => {
    const upstream = connect(Number(target.port || 5432), target.hostname);
    const link: Link = { client, upstream, cut: false };
    links.push(link);
    client.on('data', (d: Buffer) => upstream.write(d));
    upstream.on('data', (d: Buffer) => {
      if (!link.cut) client.write(d);
    });
    client.on('error', () => undefined);
    upstream.on('error', () => undefined);
    // A connection the listener closes is closed on the database's side too, unless the relay cut it.
    client.on('close', () => {
      if (!link.cut) upstream.destroy();
    });
    upstream.on('close', () => client.destroy());
  });
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
  const r: Relay = {
    port: (relay.address() as AddressInfo).port,
    links,
    cut(link) {
      link.cut = true;
      link.client.destroy();
    },
    heal() {
      for (const l of links) if (l.cut) l.upstream.destroy();
    },
    async close() {
      for (const l of links) {
        l.client.destroy();
        l.upstream.destroy();
      }
      await new Promise<void>((resolve) => relay.close(() => resolve()));
    },
  };
  relays.push(r);
  return r;
}

/** The stand-in login's URL for this database, directly or through `relay`. */
function loginUrl(relay?: Relay): string {
  const url = new URL(urlFor(server.database, LOGIN));
  if (relay) {
    url.hostname = '127.0.0.1';
    url.port = String(relay.port);
  }
  return url.toString();
}

beforeAll(async () => {
  server = await startServer('SANDBOX', { logStream: log.stream });
  // What kernel 0980 gives a listener role that holds no share; role attributes are cluster-wide and other test files
  // run listeners on the real roles meanwhile, so in a transaction that is rolled back. It takes the lock that
  // kernel.apply_listener_share takes before it changes a role, so a test changing roles beside it waits, not deadlocks.
  const c = await server.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('lock table pg_catalog.pg_authid in share row exclusive mode');
    await c.query('alter role ebmr_sandbox_listener connection limit -1');
    await c.query('select kernel.apply_listener_share()');
    share = (await c.query<{ n: number }>("select rolconnlimit as n from pg_roles where rolname = 'ebmr_sandbox_listener'")).rows[0]?.n ?? -1;
  } finally {
    await c.query('rollback').catch(() => undefined);
    c.release();
  }
  await onServer((s) => s.query(`create role ${LOGIN.name} login noinherit password '${LOGIN.password}' connection limit ${share}`));
  created = true;
  // In this database the stand-in holds what the sandbox listener's login holds, as sandbox.mirror_application_privileges
  // levels that login with ebmr_listener, and may connect.
  const admin = server.db.admin;
  await admin.query(`grant connect on database ${quoteIdent(server.database)} to ${LOGIN.name}`);
  const { rows } = await admin.query<{ direction: string; object_kind: string; object_name: string; column_name: string | null; privilege: string }>(
    'select * from sandbox.role_mirror_differences($1, array[$2]::name[])',
    [LOGIN.name, 'ebmr_sandbox_listener'],
  );
  for (const d of rows) {
    const what = d.object_kind === 'COLUMN' ? `${d.privilege} (${d.column_name ?? ''}) on table ${d.object_name}` : `${d.privilege} on ${d.object_kind.toLowerCase()} ${d.object_name}`;
    await admin.query(`grant ${what} to ${LOGIN.name}`);
  }
  expect(rows.length).toBeGreaterThan(0);
  expect((await admin.query('select * from sandbox.role_mirror_differences($1, array[$2]::name[])', [LOGIN.name, 'ebmr_sandbox_listener'])).rows).toEqual([]);
}, 180_000);

afterAll(async () => {
  for (const r of runtimes) await r.close().catch(() => undefined);
  await runtimeOf(server.built.ctx).close().catch(() => undefined);
  for (const r of relays) await r.close();
  await server?.close();
  if (created) await onServer((s) => s.query(`drop role if exists ${LOGIN.name}`));
});

describe('verification of listener-credential-bound (share-wording): the gateway listener under one listener\'s share (kernel 0980, decisions X38, X41)', () => {
  it('[DI-30][PR-20] one listener\'s share, as kernel 0980 gives it where none was declared, is the 5 connections the listener keeps and 3 spare: beside 4 other connections of its login the listener does not start (the server refuses to start) and keeps nothing open; beside 3 it starts, with all 5 open and the share full', async () => {
    expect(RECEIPTS_POOL_MAX + WATCH_POOL_MAX).toBe(5);
    expect(share).toBe(RECEIPTS_POOL_MAX + WATCH_POOL_MAX + 3);
    const ctx = server.built.ctx;
    const good = ctx.config.listenerUrl;
    ctx.config.listenerUrl = loginUrl();
    // Other connections of the listener's login: backends a network fault left half-open, or a holder of its credentials.
    const others = openPool({ connectionString: loginUrl(), max: 4, idleTimeoutMillis: 0 });
    const held: pg.PoolClient[] = [];
    const runtime = newRuntime();
    try {
      for (let i = 0; i < 4; i += 1) held.push(await others.connect());
      await expect(startGatewayListener(ctx, { host: '127.0.0.1', port: 0 })).rejects.toThrow(/too many connections for role/);
      expect(await eventually(async () => (await backends()) === 4)).toBe(true);

      held.pop()?.release(true);
      expect(await eventually(async () => (await backends()) === 3)).toBe(true);
      const watch = await runtime.startWatch();
      expect(await backends()).toBe(share);
      expect(await eventually(async () => (await ticksOf(watch.id)) >= 3)).toBe(true);
    } finally {
      await runtime.close();
      ctx.config.listenerUrl = good;
      for (const c of held) c.release();
      await endPool(others);
    }
  }, 60_000);

  it('[DI-30][PR-20] backends a network fault left half-open still count against the share: the listener replaces 3 lost connections and goes on vouching; it cannot replace a 4th (REWARM_FAILED at warn, too many connections for role), and once it loses its watch\'s connection too its ticks fail (TICK_FAILED at warn) and the database vouches for no window, so nothing is keyed by hand beside the gateway\'s scales; once those backends end its ticks land again and it vouches after 10 s', async () => {
    const ctx = server.built.ctx;
    const good = ctx.config.listenerUrl;
    const relay = await startRelay();
    ctx.config.listenerUrl = loginUrl(relay);
    const runtime = newRuntime();
    try {
      const watch = await runtime.startWatch();
      // The receipts pool's connections are opened first, then the watch's.
      expect(relay.links).toHaveLength(RECEIPTS_POOL_MAX + WATCH_POOL_MAX);
      const receipts = relay.links.slice(0, RECEIPTS_POOL_MAX);
      const watchLink = relay.links[RECEIPTS_POOL_MAX] as Link;
      expect(await eventually(attested, 15_000)).toBe(true);

      // Three of the receipts' connections are cut one after another, their backends left open: each is replaced at
      // once, within the 3 spare.
      for (let k = 1; k <= 3; k += 1) {
        relay.cut(receipts[k - 1] as Link);
        expect(await eventually(async () => (await backends()) === RECEIPTS_POOL_MAX + WATCH_POOL_MAX + k && runtime.receipts().totalCount === RECEIPTS_POOL_MAX)).toBe(true);
      }
      expect(await backends()).toBe(share);
      expect(logged(REWARM_FAILED_LOG)).toEqual([]);
      expect(await attested()).toBe(true);

      // A fourth: the share is full of half-open backends and the listener's own, so it cannot be replaced.
      relay.cut(receipts[3] as Link);
      expect(await eventually(() => logged(REWARM_FAILED_LOG).length === 1)).toBe(true);
      const rewarm = logged(REWARM_FAILED_LOG)[0];
      expect(rewarm?.level).toBe(40);
      expect(rewarm?.code).toBe('53300');
      expect(rewarm?.err).toMatch(/too many connections for role/);
      expect(runtime.receipts().totalCount).toBe(RECEIPTS_POOL_MAX - 1);
      expect(await backends()).toBe(share);

      // The watch's connection: no tick lands, and the database vouches for nothing.
      relay.cut(watchLink);
      expect(await eventually(() => logged(TICK_FAILED_LOG).length === 1)).toBe(true);
      expect(logged(TICK_FAILED_LOG)[0]?.level).toBe(40);
      expect(await eventually(async () => !(await attested()), 5000)).toBe(true);
      const stuck = await ticksOf(watch.id);
      await new Promise((r) => setTimeout(r, 1500));
      expect(await ticksOf(watch.id)).toBe(stuck);
      expect(await attested()).toBe(false);

      // The half-open backends end (the database's TCP keepalive, or a superuser ends them): the ticks land again.
      relay.heal();
      expect(await eventually(async () => (await ticksOf(watch.id)) > stuck)).toBe(true);
      expect(await eventually(attested, 20_000)).toBe(true);
    } finally {
      await runtime.close();
      await relay.close();
      ctx.config.listenerUrl = good;
    }
  }, 90_000);

  it('[DI-30][PR-20] in a rolling deploy whose old and new server overlap, the new server\'s listener does not start beside the old one\'s 5 connections (5 + 5 > 8: the server refuses to start) and the old one goes on ticking; with the share of two listeners declared (16, as kernel.apply_listener_share(16) declares it for the listener roles) it starts beside it', async () => {
    const ctx = server.built.ctx;
    const good = ctx.config.listenerUrl;
    ctx.config.listenerUrl = loginUrl();
    const old = newRuntime();
    let next: { close(): Promise<void> } | undefined;
    try {
      const oldWatch = await old.startWatch();
      expect(await backends()).toBe(RECEIPTS_POOL_MAX + WATCH_POOL_MAX);

      await expect(startGatewayListener(ctx, { host: '127.0.0.1', port: 0 })).rejects.toThrow(/too many connections for role/);
      expect(await eventually(async () => (await backends()) === RECEIPTS_POOL_MAX + WATCH_POOL_MAX)).toBe(true);
      const before = await ticksOf(oldWatch.id);
      expect(await eventually(async () => (await ticksOf(oldWatch.id)) >= before + 2)).toBe(true);

      await onServer((s) => s.query(`alter role ${LOGIN.name} connection limit ${2 * share}`));
      next = await startGatewayListener(ctx, { host: '127.0.0.1', port: 0 });
      expect(await backends()).toBe(2 * (RECEIPTS_POOL_MAX + WATCH_POOL_MAX));
    } finally {
      await next?.close();
      await runtimeOf(ctx).close();
      await old.close();
      ctx.config.listenerUrl = good;
      await onServer((s) => s.query(`alter role ${LOGIN.name} connection limit ${share}`));
    }
  }, 60_000);
});
