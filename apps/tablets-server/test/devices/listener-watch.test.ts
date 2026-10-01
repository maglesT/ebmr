/**
 * Review finding P50, follow-up item p50-gate-vs-app-role, round 4 (tablets 0350 item 6, kernel 0980; decisions
 * X36-X39; controls DI-17, DI-30, PR-20): the manual-weighing gate fails closed when the gateway listener cannot put
 * its evidence on record.
 *
 * Before, the gate took the absence of a heartbeat's receipt as proof that a scale fell silent (and the absence of an
 * answer of the gateway's API as proof that it stayed unreachable). Receipts and answers were best-effort writes on a
 * pool of the application role that opened its connections only when needed, so a database too loaded to take one
 * within its statement's limit, or with no free connection, lost it, and the manual path could open beside a working
 * scale. Now the listener logs in with a role of its own, opens its connections before it listens, and ticks every
 * 500 ms on a connection of its own, saying whether everything it received since its previous tick was put on record;
 * the database counts silence only over a window of clean ticks (tab.listener_attested_from).
 *
 * Here: the rules of the vouched window, on ticks written by hand with chosen times; the tick function and who may
 * call it; the listener's connections (its own login, all open before it listens, a lost one opened again at once, no
 * start without them); and which heartbeat requests count as lost (one refused for a changed time zone) and which do
 * not (no token, a body that is no heartbeat, a token nobody handed out).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { endPool, openPool, SANDBOX_LISTENER_LOGIN, urlFor } from '@ebmr/test-kit';
import { RECEIPTS_POOL_MAX, runtimeOf, WATCH_POOL_MAX } from '../../src/features/devices/runtime.ts';
import { startGatewayListener, type GatewayListener } from '../../src/features/devices/listener.ts';
import { LISTENER_TICK_MS } from '../../src/features/devices/watch.ts';
import { startServer, type TestServer } from '../support/harness.ts';
import { enrol, loginAt, post } from './support.ts';

let server: TestServer;
let listener: GatewayListener | undefined;

beforeAll(async () => {
  server = await startServer('SANDBOX');
  await enrol(server);
}, 180_000);

afterAll(async () => {
  await listener?.close();
  await server?.close();
});

/** Removes every tick (the cases of the first group write their own). */
async function clearTicks(): Promise<void> {
  await server.db.admin.query('delete from tab.listener_tick');
}

/**
 * Writes the ticks of run `watch` by hand: one per entry, `ageMs` before now (oldest first), `clean` as given (null for
 * the run's latest, still open, tick); seq from 1 unless `seqs` says otherwise.
 */
async function writeTicks(watch: string, ticks: { ageMs: number; clean: boolean | null; seq?: number }[]): Promise<void> {
  let seq = 0;
  for (const t of ticks) {
    seq = t.seq ?? seq + 1;
    await server.db.admin.query(
      "insert into tab.listener_tick (watch_id, seq, ticked_at, clean) values ($1, $2, clock_timestamp() - make_interval(secs => $3::float8 / 1000), $4)",
      [watch, seq, t.ageMs, t.clean],
    );
  }
}

/** A run that ticked every 500 ms from `fromMs` ago to `toMs` ago, all clean but the latest. */
function steady(fromMs: number, toMs: number): { ageMs: number; clean: boolean | null }[] {
  const out: { ageMs: number; clean: boolean | null }[] = [];
  for (let age = fromMs; age >= toMs; age -= 500) out.push({ ageMs: age, clean: true });
  const last = out.at(-1);
  if (last) last.clean = null;
  return out;
}

/**
 * What tab.listener_attested_from answers for a gate whose window starts `fromMs` before now: 'none', or how far
 * (ms, rounded) before the run's latest closed tick the vouched window starts.
 */
async function vouched(watch: string, fromMs = 10_000): Promise<'none' | number> {
  const { rows } = await server.db.admin.query<{ a: string | null; lag: string | null }>(
    `select a::text, round(extract(epoch from (select max(t.ticked_at) from tab.listener_tick t where t.watch_id = $1 and t.clean is not null) - a) * 1000)::text as lag
       from (select tab.listener_attested_from(clock_timestamp() - make_interval(secs => $2::float8 / 1000)) as a) x`,
    [watch, fromMs],
  );
  const r = rows[0];
  return r?.a == null ? 'none' : Number(r.lag);
}

describe('review P50, follow-up round 4: the window the gateway listener vouches for (tablets 0350 item 6)', () => {
  it('[DI-30][PR-20] a window is vouched for only by one listener run\'s clean ticks without a gap, its latest closed tick at most 2 s old, spanning a full 10 s back from that tick (or from the gate\'s own window start when that is earlier)', async () => {
    const w = randomUUID();
    await clearTicks();
    expect(await vouched(w)).toBe('none'); // no tick at all

    await writeTicks(w, steady(12_000, 500));
    // The latest closed tick is 1 s old: the window starts 10 s before it.
    expect(await vouched(w)).toBe(10_000);
    // A gate whose own window starts earlier (a long transaction) is vouched for from there.
    expect(await vouched(w, 11_500)).toBeGreaterThanOrEqual(10_400);

    // One tick in the window unclean (something received was not put on record): none.
    await server.db.admin.query('update tab.listener_tick set clean = false where watch_id = $1 and seq = 10', [w]);
    expect(await vouched(w)).toBe('none');
    // Unclean only before the window: vouched again.
    await server.db.admin.query('update tab.listener_tick set clean = true where watch_id = $1 and seq = 10', [w]);
    await server.db.admin.query('update tab.listener_tick set clean = false where watch_id = $1 and seq = 1', [w]);
    expect(await vouched(w)).toBe(10_000);

    // A gap in the run's ticks: none.
    await server.db.admin.query('delete from tab.listener_tick where watch_id = $1 and seq = 12', [w]);
    expect(await vouched(w)).toBe('none');

    // Too short a run (its first tick 6 s ago): none.
    await clearTicks();
    await writeTicks(w, steady(6_000, 500));
    expect(await vouched(w)).toBe('none');

    // Stale: the latest closed tick is 3 s old (the listener stopped ticking): none.
    await clearTicks();
    await writeTicks(w, steady(15_000, 2_500));
    expect(await vouched(w)).toBe('none');

    // Another run that ticked inside the window (a second listener): none. One that ticked only long before: no matter.
    await clearTicks();
    await writeTicks(w, steady(12_000, 500));
    const other = randomUUID();
    await writeTicks(other, [{ ageMs: 30_000, clean: true }, { ageMs: 29_500, clean: null }]);
    expect(await vouched(w)).toBe(10_000);
    await writeTicks(other, [{ ageMs: 5_000, clean: null, seq: 3 }]);
    expect(await vouched(other)).toBe('none');
    expect(await vouched(w)).toBe('none');
    await clearTicks();
  });

  it('[DI-17][DI-30] the tick function closes the run\'s open tick with whether everything was put on record (not saying counts as not) and opens the next at the database\'s time; only the listener\'s own login may call it', async () => {
    await clearTicks();
    const w = randomUUID();
    // A connection of the listener's own login (not the server's pools: the listener has not started yet).
    const listenerPool = openPool({ connectionString: urlFor(server.database, SANDBOX_LISTENER_LOGIN), max: 1 });
    const tick = async (clean: boolean | null) =>
      (await listenerPool.query<{ r: { seq: number; tickedAtUs: string } }>('select tab.record_listener_tick($1, $2) as r', [w, clean])).rows[0]?.r;
    try {
      expect((await tick(true))?.seq).toBe(1); // the first: nothing to close
      expect((await tick(true))?.seq).toBe(2);
      expect((await tick(null))?.seq).toBe(3);
      expect((await tick(false))?.seq).toBe(4);
    } finally {
      await endPool(listenerPool);
    }
    const rows = await server.db.admin.query<{ seq: number; clean: boolean | null }>('select seq, clean from tab.listener_tick where watch_id = $1 order by seq', [w]);
    expect(rows.rows).toEqual([
      { seq: 1, clean: true },
      { seq: 2, clean: false },
      { seq: 3, clean: false },
      { seq: 4, clean: null },
    ]);
    await expect(server.db.app.query('select tab.record_listener_tick($1, true)', [w])).rejects.toThrow(/permission denied for function record_listener_tick/);
    await expect(server.db.app.query("select tab.listener_attested_from(now())")).rejects.toThrow(/permission denied for function listener_attested_from/);
    await clearTicks();
  });
});

describe('review P50, follow-up round 4: the gateway listener\'s own connections and what it counts as lost (kernel 0980, tablets 0350 item 6)', () => {
  /** The connections of this database logged in as the listener's role, by state. */
  async function listenerBackends(): Promise<number> {
    const { rows } = await server.db.admin.query<{ n: number }>(
      "select count(*)::int as n from pg_stat_activity where datname = current_database() and usename = 'ebmr_sandbox_listener'",
    );
    return rows[0]?.n ?? 0;
  }

  async function eventually(check: () => Promise<boolean>, ms = 10_000): Promise<boolean> {
    for (let waited = 0; waited < ms; waited += 100) {
      if (await check()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  it('[DI-30][PR-20][DI-17] a listener whose own login cannot connect does not start; once it can, every connection of its receipts and of its watch is open, under its own login, before anything is received, and one that is lost is opened again at once', async () => {
    await clearTicks();
    const ctx = server.built.ctx;
    const good = ctx.config.listenerUrl;
    const bad = new URL(good);
    bad.password = 'not-the-password';
    ctx.config.listenerUrl = bad.toString();
    try {
      await expect(startGatewayListener(ctx, { host: '127.0.0.1', port: 0 })).rejects.toThrow(/password authentication failed/);
    } finally {
      ctx.config.listenerUrl = good;
    }
    expect(await listenerBackends()).toBe(0);
    expect((await server.db.admin.query<{ n: number }>('select count(*)::int as n from tab.listener_tick')).rows[0]?.n).toBe(0);

    listener = await startGatewayListener(ctx, { host: '127.0.0.1', port: 0 });
    // Before any request: all of them, open and idle.
    expect(await listenerBackends()).toBe(RECEIPTS_POOL_MAX + WATCH_POOL_MAX);
    // The watch ticks.
    expect(await eventually(async () => ((await server.db.admin.query<{ n: number }>('select count(*)::int as n from tab.listener_tick')).rows[0]?.n ?? 0) >= 3)).toBe(true);

    // The database ends one of the receipts' connections while idle: the pool opens another without being asked.
    const runtime = runtimeOf(ctx);
    const { rows } = await runtime.receipts().query<{ pid: number }>('select pg_backend_pid() as pid');
    expect((await server.db.admin.query<{ ok: boolean }>('select pg_terminate_backend($1) as ok', [rows[0]?.pid])).rows).toEqual([{ ok: true }]);
    expect(await eventually(async () => (await listenerBackends()) === RECEIPTS_POOL_MAX + WATCH_POOL_MAX && runtime.receipts().totalCount === RECEIPTS_POOL_MAX)).toBe(true);
    const pids = await server.db.admin.query<{ pid: number }>("select pid from pg_stat_activity where datname = current_database() and usename = 'ebmr_sandbox_listener'");
    expect(pids.rows.map((r) => r.pid)).not.toContain(rows[0]?.pid);
  }, 60_000);

  it('[DI-30][PR-20][DI-27] a request that is no gateway\'s heartbeat (no token, a body that is no heartbeat, a token nobody handed out) loses nothing; a heartbeat refused before its receipt because the site\'s time zone changed is lost, and the listener\'s next tick says so', async () => {
    if (!listener) throw new Error('SETUP: the listener did not start');
    const base = `http://127.0.0.1:${listener.port}`;
    const login = await loginAt(base, server);
    expect(login.status).toBe(200);
    const token = (login.body as { token: string }).token;
    const heartbeat = { gatewayTimeUs: '1790584618000000', devices: [{ deviceCode: 'TEST-BAL-01', state: 'ONLINE', serial: 'SIM-0001' }], journal: { lastSeq: '0', ackedSeq: '0' } };
    const lastSeq = async () => (await server.db.admin.query<{ s: number | null }>('select max(seq) as s from tab.listener_tick')).rows[0]?.s ?? 0;
    const uncleanSince = async (seq: number) =>
      (await server.db.admin.query<{ n: number }>('select count(*)::int as n from tab.listener_tick where seq > $1 and clean = false', [seq])).rows[0]?.n ?? 0;
    /** Waits until three more ticks have been closed after `seq`. */
    const settled = async (seq: number) => expect(await eventually(async () => (await lastSeq()) >= seq + 4, 10 * LISTENER_TICK_MS + 5000)).toBe(true);

    const before = await lastSeq();
    expect((await post(base, '/gw/v1/heartbeat', heartbeat, null)).status).toBe(401); // NO_TOKEN
    expect((await post(base, '/gw/v1/heartbeat', { devices: 'none' }, token)).status).toBe(400); // SCHEMA
    expect((await post(base, '/gw/v1/heartbeat', heartbeat, 'x'.repeat(43))).status).toBe(401); // a token nobody handed out
    expect((await post(base, '/gw/v1/heartbeat', heartbeat, token)).status).toBe(200); // the gateway's own, on record
    await settled(before);
    expect(await uncleanSince(before)).toBe(0);

    // The site's time zone changes while the server runs (latched until it restarts; DI-27): the gateway's heartbeat is
    // refused before its receipt, so it is lost.
    try {
      server.built.ctx.siteZone.observe('Antarctica/Troll');
    } catch {
      // the guard refuses at once, as it should
    }
    const mark = await lastSeq();
    const refused = await post(base, '/gw/v1/heartbeat', heartbeat, token);
    expect(refused.status).toBe(503);
    expect((refused.body as { error: { code: string } }).error.code).toBe('SITE_ZONE_CHANGED');
    await settled(mark);
    expect(await uncleanSince(mark)).toBe(1);
  }, 60_000);
});
