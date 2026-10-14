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
 *
 * Final verification of the item (listener-credential-bound; decisions X36, X39, X40): a holder of the listener's own
 * credentials could keep the real listener's ticks from landing (a loaded database ends them at their 2 s limit) and
 * tick a run of its own clean, and the database vouched for that run alone once the real one had not ticked for 10 s,
 * over a window in which the real listener's evidence was lost. Now a listener that stops ends its run on record
 * (tab.end_listener_run, which the server's close calls), and a run that stopped without being ended keeps every other
 * run from vouching for an hour after its last tick; a run that ended, or ticked, inside the window still does.
 *
 * Verification of that item (x39-alter-role; decision X42): the listener's login may set session defaults on itself
 * (ALTER ROLE ... SET), which reached the listener's next connections (read-only transactions kept every tick from
 * landing, with nothing sustained). Now no run vouches while a listener login that may connect has such a default, and
 * the listener's pools fix the settings that kept its statements from landing in their startup options.
 *
 * Verification of that item (docs-no-listener; decision X43): a run that ended on record held the others only for a
 * window that holds its end, so after a planned restart or deploy, or with no listener running, a run of a holder of
 * the listener's credentials vouched once it had ticked clean for 10 s, with nothing to wait out (this file's server
 * test asserted it). Now each run begins with a run key derived from the server's secrets (the database keeps its
 * SHA-256), and while a run of another key, or of none, closed a tick within the last hour no run vouches. The runs
 * written by hand below begin with one key (TEST_RUN_KEY), as runs of one server would, unless a case says otherwise.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { endPool, openPool, SANDBOX_LISTENER_LOGIN, urlFor } from '@ebmr/test-kit';
import {
  DevicesRuntime,
  IDLE_CONNECTION_LOST_LOG,
  RECEIPTS_POOL_MAX,
  RUN_HELD_BY_OTHER_KEY_LOG,
  RUN_NOT_ENDED_LOG,
  runtimeOf,
  WATCH_POOL_MAX,
} from '../../src/features/devices/runtime.ts';
import { startGatewayListener, type GatewayListener } from '../../src/features/devices/listener.ts';
import { EPOCH_SETTLE_LIMIT_MS, LISTENER_TICK_MS, ListenerWatch, listenerRunKey } from '../../src/features/devices/watch.ts';
import { logCollector, startServer, type TestServer } from '../support/harness.ts';
import { enrol, loginAt, post } from './support.ts';

const log = logCollector();
let server: TestServer;
/** A database name as an SQL identifier. */
const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;
let listener: GatewayListener | undefined;

beforeAll(async () => {
  server = await startServer('SANDBOX', { logStream: log.stream });
  await enrol(server);
}, 180_000);

afterAll(async () => {
  await listener?.close();
  await server?.close();
});

/** Removes every tick and every run's start (the cases of the first group write their own). */
async function clearTicks(): Promise<void> {
  await server.db.admin.query('delete from tab.listener_tick');
  await server.db.admin.query('delete from tab.listener_run');
}

/** The run key of the runs written by hand (as runs of one server, which all begin with the same key). */
const TEST_RUN_KEY = randomBytes(32);

/** Records by hand that run `watch` began with `key` (tab.listener_run; null: it never began, so it has no key). */
async function keyRun(watch: string, key: Buffer | null): Promise<void> {
  if (key === null) return;
  await server.db.admin.query('insert into tab.listener_run (watch_id, key_hash) values ($1, sha256($2)) on conflict (watch_id) do nothing', [watch, key]);
}

/**
 * Writes the ticks of run `watch` by hand: one per entry, `ageMs` before now (oldest first), `clean` as given (null for
 * the run's latest, still open, tick), a closed one closed `closedAgeMs` before now (default 500 ms after its tick, as
 * the next tick closes it); seq from 1 unless `seq` says otherwise. The run began with `key` (default TEST_RUN_KEY;
 * null: it never began).
 */
async function writeTicks(watch: string, ticks: { ageMs: number; clean: boolean | null; seq?: number; closedAgeMs?: number }[], key: Buffer | null = TEST_RUN_KEY): Promise<void> {
  await keyRun(watch, key);
  let seq = 0;
  for (const t of ticks) {
    seq = t.seq ?? seq + 1;
    await server.db.admin.query(
      `insert into tab.listener_tick (watch_id, seq, ticked_at, clean, closed_at)
       values ($1, $2, clock_timestamp() - make_interval(secs => $3::float8 / 1000), $4,
               case when $4::boolean is null then null else clock_timestamp() - make_interval(secs => $5::float8 / 1000) end)`,
      [watch, seq, t.ageMs, t.clean, t.closedAgeMs ?? Math.max(0, t.ageMs - 500)],
    );
  }
}

/** As writeTicks(watch, steady(fromMs, toMs), key), in one statement (for runs of an hour). */
async function writeSteady(watch: string, fromMs: number, toMs: number, key: Buffer | null = TEST_RUN_KEY): Promise<void> {
  await keyRun(watch, key);
  await server.db.admin.query(
    `with c as (select clock_timestamp() as t),
          s as (select n, $2::int - (n - 1) * 500 as age, n = ($2::int - $3::int) / 500 + 1 as open
                  from generate_series(1, ($2::int - $3::int) / 500 + 1) n)
     insert into tab.listener_tick (watch_id, seq, ticked_at, clean, closed_at)
     select $1, s.n, c.t - make_interval(secs => s.age::float8 / 1000),
            case when s.open then null else true end,
            case when s.open then null else c.t - make_interval(secs => (s.age - 500)::float8 / 1000) end
       from s cross join c`,
    [watch, fromMs, toMs],
  );
}

/** Moves every tick of run `watch` `ms` further into the past. */
async function age(watch: string, ms: number): Promise<void> {
  await server.db.admin.query(
    'update tab.listener_tick set ticked_at = ticked_at - make_interval(secs => $2::float8 / 1000), closed_at = closed_at - make_interval(secs => $2::float8 / 1000) where watch_id = $1',
    [watch, ms],
  );
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
async function vouched(watch: string, fromMs = 10_000, on: Pick<pg.ClientBase, 'query'> = server.db.admin): Promise<'none' | number> {
  const { rows } = await on.query<{ a: string | null; lag: string | null }>(
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

    // Another run that ticked inside the window (a second listener): none. One that ended long before: no matter.
    await clearTicks();
    await writeTicks(w, steady(12_000, 500));
    const other = randomUUID();
    await writeTicks(other, [{ ageMs: 30_000, clean: true }, { ageMs: 29_500, clean: true }]);
    expect(await vouched(w)).toBe(10_000);
    await writeTicks(other, [{ ageMs: 5_000, clean: null, seq: 3 }]);
    expect(await vouched(other)).toBe('none');
    expect(await vouched(w)).toBe('none');
    await clearTicks();
  });

  it('[DI-30][PR-20][DI-17] a run that stopped ticking without being ended keeps every other run from vouching for an hour after its last tick; a run that ended inside the window keeps it too, one that ended before it does not', async () => {
    const w = randomUUID();
    await clearTicks();
    await writeTicks(w, steady(12_000, 500));
    expect(await vouched(w)).toBe(10_000);

    // Ended before the window: no matter. Its last tick before the window but its end inside it: none (it was
    // receiving until its end).
    const ended = randomUUID();
    await writeTicks(ended, [{ ageMs: 30_000, clean: true }, { ageMs: 29_500, clean: true, closedAgeMs: 29_000 }]);
    expect(await vouched(w)).toBe(10_000);
    await server.db.admin.query("update tab.listener_tick set closed_at = clock_timestamp() - interval '5 seconds' where watch_id = $1 and seq = 2", [ended]);
    expect(await vouched(w)).toBe('none');
    await server.db.admin.query('delete from tab.listener_tick where watch_id = $1', [ended]);
    expect(await vouched(w)).toBe(10_000);

    // Stopped ticking 29.5 s ago without being ended (its latest row still open): a listener that may still be
    // receiving while its ticks cannot land, so the clean run beside it vouches for nothing, ...
    const lost = randomUUID();
    await writeTicks(lost, [{ ageMs: 30_000, clean: true }, { ageMs: 29_500, clean: null }]);
    expect(await vouched(w)).toBe('none');
    // ... still 59 minutes after its last tick, ...
    await age(lost, 59 * 60_000);
    expect(await vouched(w)).toBe('none');
    // ... and no more once its last tick is over an hour old (the hour the ticks are kept);
    await age(lost, 2 * 60_000);
    expect(await vouched(w)).toBe(10_000);
    // unless the gate's own window (a transaction begun over an hour ago) reaches back to that tick.
    await clearTicks();
    const long = randomUUID();
    await writeSteady(long, 3_665_000, 500);
    await writeTicks(lost, [{ ageMs: 3_640_000, clean: null }]);
    expect(await vouched(long)).toBe(10_000);
    expect(await vouched(long, 3_650_000)).toBe('none');
    await server.db.admin.query('delete from tab.listener_tick where watch_id = $1', [lost]);
    expect(await vouched(long, 3_650_000)).toBeGreaterThanOrEqual(3_640_000);
    await clearTicks();
  });

  it('[DI-30][PR-20][DI-17] no run vouches while a listener login that may connect to the database has session defaults of its own (ALTER ROLE ... SET, which that login may run on itself), for this database or for every database; a default for another database, or of a login that may not connect here, does not count', async () => {
    const w = randomUUID();
    await clearTicks();
    await writeTicks(w, steady(12_000, 500));
    expect(await vouched(w)).toBe(10_000);
    const db = quoteIdent(server.database);

    // The listener's own login, with no privilege beyond it, sets a default for its next sessions in this database:
    // nothing is vouched for until it is removed again.
    const own = openPool({ connectionString: urlFor(server.database, SANDBOX_LISTENER_LOGIN), max: 1 });
    try {
      await own.query(`alter role ebmr_sandbox_listener in database ${db} set default_transaction_read_only = on`);
      expect(await vouched(w)).toBe('none');
      await own.query(`alter role ebmr_sandbox_listener in database ${db} reset all`);
      expect(await vouched(w)).toBe(10_000);
      await own.query(`alter role ebmr_sandbox_listener in database ${db} set idle_session_timeout = '1s'`);
      expect(await vouched(w)).toBe('none');
    } finally {
      await own.query(`alter role ebmr_sandbox_listener in database ${db} reset all`).catch(() => undefined);
      await endPool(own);
    }
    expect(await vouched(w)).toBe(10_000);

    // The other forms, each in a transaction rolled back (a role's defaults for every database reach the listeners of
    // the test files running beside this one): ...
    const c = await server.db.admin.connect();
    const rolledBack = async (statements: string[]): Promise<'none' | number> => {
      await c.query('begin');
      try {
        for (const s of statements) await c.query(s);
        return await vouched(w, 10_000, c);
      } finally {
        await c.query('rollback');
      }
    };
    try {
      // ... a default for every database counts; ...
      expect(await rolledBack(["alter role ebmr_sandbox_listener set work_mem = '64kB'"])).toBe('none');
      // ... one for another database reaches no session here; ...
      expect(await rolledBack(["alter role ebmr_sandbox_listener in database postgres set work_mem = '64kB'"])).toBe(10_000);
      // ... nor does one of the GMP listener's login, which may not connect to a sandbox, unless it may.
      expect(await rolledBack([`alter role ebmr_listener in database ${db} set work_mem = '64kB'`])).toBe(10_000);
      expect(await rolledBack([`grant connect on database ${db} to ebmr_listener`, `alter role ebmr_listener in database ${db} set work_mem = '64kB'`])).toBe('none');
    } finally {
      c.release();
    }
    expect(await vouched(w)).toBe(10_000);
    await clearTicks();
  });

  it('[DI-30][PR-20][DI-17] within the hour after another run\'s last closed tick a run vouches only when it began with the same run key: a run of another key, or one that never began, keeps it from vouching until that tick is an hour old, however it ended; a run with no key vouches only when no other run closed a tick within the hour (decision X43)', async () => {
    const w = randomUUID();
    const otherKey = randomBytes(32);
    /** A run that ticked 30 s ago and ended on record (its last tick closed, clean) 29.8 s ago. */
    const endedRun = (watch: string, key: Buffer | null) => writeTicks(watch, [{ ageMs: 30_500, clean: true }, { ageMs: 30_000, clean: true, closedAgeMs: 29_800 }], key);
    await clearTicks();
    await writeTicks(w, steady(12_000, 500));
    expect(await vouched(w)).toBe(10_000);

    // A run of the same key that ended before the window (the server started again with the same secrets): no matter.
    const same = randomUUID();
    await endedRun(same, TEST_RUN_KEY);
    expect(await vouched(w)).toBe(10_000);
    await server.db.admin.query('delete from tab.listener_tick where watch_id = $1', [same]);

    // One of another key (other secrets, or a key of someone holding the listener's credentials), ended as cleanly:
    // none, still 59 minutes after its last tick, and no more once that tick is over an hour old.
    const foreign = randomUUID();
    await endedRun(foreign, otherKey);
    expect(await vouched(w)).toBe('none');
    await age(foreign, 59 * 60_000);
    expect(await vouched(w)).toBe('none');
    await age(foreign, 2 * 60_000);
    expect(await vouched(w)).toBe(10_000);
    // One that never began (no key): the same.
    const keyless = randomUUID();
    await endedRun(keyless, null);
    expect(await vouched(w)).toBe('none');
    await age(keyless, 61 * 60_000);
    expect(await vouched(w)).toBe(10_000);

    // The other way round, as after the server's run ended on record (a planned restart or deploy, a server started
    // again without EBMR_GATEWAY_LISTEN) with no listener running since: runs of someone holding only the listener's
    // credentials tick clean for 12 s, with a key of their own or none. Before decision X43 each vouched, with nothing
    // to wait out. Now none does within the hour after the server's run's last tick, ...
    await clearTicks();
    const serverRun = randomUUID();
    await writeTicks(serverRun, [{ ageMs: 20_500, clean: true }, { ageMs: 20_000, clean: true, closedAgeMs: 19_800 }]);
    const holder = randomUUID();
    await writeTicks(holder, steady(12_000, 500), otherKey);
    expect(await vouched(holder)).toBe('none');
    // ... not even after another run of the holder's own key ended before it (its runs agree with each other, not with
    // the server's), ...
    const holderBefore = randomUUID();
    await writeTicks(holderBefore, [{ ageMs: 15_500, clean: true }, { ageMs: 15_000, clean: true, closedAgeMs: 14_800 }], otherKey);
    expect(await vouched(holder)).toBe('none');
    await server.db.admin.query('delete from tab.listener_tick where watch_id = any($1::uuid[])', [[holder, holderBefore]]);
    const bare = randomUUID();
    await writeTicks(bare, steady(12_000, 500), null);
    expect(await vouched(bare)).toBe('none');
    // ... and once the server's run's last tick is over an hour old, a run vouches whatever its key (decision X39 (6)):
    // the database cannot tell it from a listener that starts with no run ticking within the hour.
    await age(serverRun, 61 * 60_000);
    expect(await vouched(bare)).toBe(10_000);
    // A run with no key is held by every other run that closed a tick within the hour, one with no key among them.
    await endedRun(randomUUID(), null);
    expect(await vouched(bare)).toBe('none');
    await clearTicks();
  });

  it('[DI-17][DI-30] a run begins on record before its first tick, once, with its run key: the database keeps the key\'s SHA-256, not the key, answers until when runs of another key or of none that closed a tick within the hour hold it, and prunes runs that began over an hour ago and have no tick left; only the listener\'s own login may begin a run (decision X43)', async () => {
    await clearTicks();
    const listenerPool = openPool({ connectionString: urlFor(server.database, SANDBOX_LISTENER_LOGIN), max: 1 });
    const begin = async (watch: string | null, key: Buffer | null) =>
      (await listenerPool.query<{ r: { heldUntilUs: string | null } }>('select tab.begin_listener_run($1, $2) as r', [watch, key])).rows[0]?.r;
    const tick = async (watch: string) => listenerPool.query('select tab.record_listener_tick($1, true)', [watch]);
    const runRows = async (watch: string) => (await server.db.admin.query<{ n: number }>('select count(*)::int as n from tab.listener_run where watch_id = $1', [watch])).rows[0]?.n;
    const w = randomUUID();
    const otherKey = randomBytes(32);
    try {
      // Nothing else ticked within the hour: nothing holds it.
      expect(await begin(w, TEST_RUN_KEY)).toEqual({ heldUntilUs: null });
      const kept = await server.db.admin.query<{ hashed: boolean; raw: number }>(
        'select key_hash = sha256($2) as hashed, (select count(*)::int from tab.listener_run x where x.key_hash = $2) as raw from tab.listener_run where watch_id = $1',
        [w, TEST_RUN_KEY],
      );
      expect(kept.rows).toEqual([{ hashed: true, raw: 0 }]);
      // Once: not again, with its key or another.
      await expect(begin(w, TEST_RUN_KEY)).rejects.toThrow(/EBMR-DEV-078 this run of the gateway listener has begun or ticked already/);
      await expect(begin(w, otherKey)).rejects.toThrow(/EBMR-DEV-078/);
      await tick(w);
      await tick(w);
      // Only before its first tick: a run that ticked without beginning has no key, and keeps none.
      const v = randomUUID();
      await tick(v);
      await expect(begin(v, otherKey)).rejects.toThrow(/EBMR-DEV-078/);
      expect(await runRows(v)).toBe(0);
      // A key of 32 bytes, and the run named.
      const x = randomUUID();
      await expect(begin(x, randomBytes(31))).rejects.toThrow(/EBMR-DEV-077 a run of the gateway listener begins with the server's run key \(32 bytes\)/);
      await expect(begin(x, null)).rejects.toThrow(/EBMR-DEV-077/);
      await expect(begin(null, TEST_RUN_KEY)).rejects.toThrow(/EBMR-DEV-075/);
      expect(await runRows(x)).toBe(0);

      // Held: by a run of another key that closed a tick 10 minutes ago, until an hour after that tick (run w, of the same
      // key, which closed a tick just now, does not count; v, with no key, would, so its ticks go first).
      await server.db.admin.query('delete from tab.listener_tick where watch_id = $1', [v]);
      const foreign = randomUUID();
      await writeTicks(foreign, [{ ageMs: 600_500, clean: true }, { ageMs: 600_000, clean: true, closedAgeMs: 599_800 }], otherKey);
      const until = (await server.db.admin.query<{ u: string }>("select platform.epoch_micros(max(closed_at) + interval '1 hour')::text as u from tab.listener_tick where watch_id = $1", [foreign])).rows[0]?.u;
      expect(await begin(randomUUID(), TEST_RUN_KEY)).toEqual({ heldUntilUs: until });
      // A run of that other key is held by run w's tick instead.
      const wUntil = (await server.db.admin.query<{ u: string }>("select platform.epoch_micros(max(closed_at) + interval '1 hour')::text as u from tab.listener_tick where watch_id = $1", [w])).rows[0]?.u;
      expect(await begin(randomUUID(), otherKey)).toEqual({ heldUntilUs: wUntil });

      // Pruned at the next start: a run that began over an hour ago and has no tick left. Kept: one that began as long
      // ago but still has a tick, and one that began just now and has not ticked yet.
      const stale = randomUUID();
      const old = randomUUID();
      const fresh = randomUUID();
      await server.db.admin.query(
        "insert into tab.listener_run (watch_id, key_hash, began_at) values ($1, sha256($3), clock_timestamp() - interval '61 minutes'), ($2, sha256($3), clock_timestamp() - interval '61 minutes')",
        [stale, old, TEST_RUN_KEY],
      );
      await writeTicks(old, [{ ageMs: 1_000, clean: null }]);
      expect(await begin(fresh, TEST_RUN_KEY)).toMatchObject({ heldUntilUs: until });
      expect([await runRows(stale), await runRows(old), await runRows(fresh)]).toEqual([0, 1, 1]);
    } finally {
      await endPool(listenerPool);
    }
    await expect(server.db.app.query('select tab.begin_listener_run($1, $2)', [randomUUID(), TEST_RUN_KEY])).rejects.toThrow(/permission denied for function begin_listener_run/);
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

  it('[DI-17][DI-30] the end of a run closes its open tick, at the database\'s time, with whether everything up to the end was put on record (not saying counts as not), and the run ticks no more; only the listener\'s own login may end a run', async () => {
    await clearTicks();
    const w = randomUUID();
    const v = randomUUID();
    const listenerPool = openPool({ connectionString: urlFor(server.database, SANDBOX_LISTENER_LOGIN), max: 1 });
    const call = async (sql: string, watch: string, clean: boolean | null) => (await listenerPool.query<{ r: unknown }>(sql, [watch, clean])).rows[0]?.r;
    const TICK = 'select tab.record_listener_tick($1, $2) as r';
    const END = 'select tab.end_listener_run($1, $2) as r';
    try {
      await call(TICK, w, true);
      await call(TICK, w, true);
      expect(await call(END, w, null)).toBe(true);
      expect(await call(END, w, true)).toBe(false); // nothing left open
      await expect(call(TICK, w, true)).rejects.toThrow(/EBMR-DEV-076 this run of the gateway listener has ended/);
      await call(TICK, v, null);
      expect(await call(END, v, true)).toBe(true);
      expect(await call(END, randomUUID(), true)).toBe(false); // a run that never ticked
    } finally {
      await endPool(listenerPool);
    }
    const rows = await server.db.admin.query<{ watch: string; seq: number; clean: boolean | null; closed: boolean }>(
      'select watch_id::text as watch, seq, clean, closed_at >= ticked_at and closed_at <= clock_timestamp() as closed from tab.listener_tick order by watch_id = $1 desc, seq',
      [w],
    );
    expect(rows.rows).toEqual([
      { watch: w, seq: 1, clean: true, closed: true },
      { watch: w, seq: 2, clean: false, closed: true },
      { watch: v, seq: 1, clean: true, closed: true },
    ]);
    await expect(server.db.app.query('select tab.end_listener_run($1, true)', [v])).rejects.toThrow(/permission denied for function end_listener_run/);
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
    // pg_terminate_backend only sends the signal: until the backend has exited (and the pool has seen it), the old
    // connection still counts, so the full count alone could be met before the replacement exists. Wait for both: the
    // ended backend gone and the pool full again.
    const listenerPids = async () =>
      (await server.db.admin.query<{ pid: number }>("select pid from pg_stat_activity where datname = current_database() and usename = 'ebmr_sandbox_listener'")).rows.map((r) => r.pid);
    expect(
      await eventually(async () => {
        const live = await listenerPids();
        return !live.includes(rows[0]?.pid ?? -1) && live.length === RECEIPTS_POOL_MAX + WATCH_POOL_MAX && runtime.receipts().totalCount === RECEIPTS_POOL_MAX;
      }),
    ).toBe(true);
    expect(await listenerPids()).not.toContain(rows[0]?.pid);
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

  it('[DI-30][PR-20][DI-17] when the server closes, the listener ends its run on record: its last tick closed, clean, and no tick of that run taken after. Within the hour after that tick, a run of someone holding only the listener\'s credentials (none begun, or begun with a key of its own) vouches for nothing however long it ticks clean with no listener running; the server started again with the same secrets vouches once it has ticked clean for 10 s, as before; started with other secrets, it says so at warn as its run begins and vouches for nothing until the old key\'s last tick is an hour old (decision X43)', async () => {
    const otherLog = logCollector();
    const other = await startServer('SANDBOX', { logStream: otherLog.stream });
    const ctx = other.built.ctx;
    const secrets = ctx.config.secrets;
    const runtimes: DevicesRuntime[] = [];
    const admin = other.db.admin;
    const attested = async () =>
      (await admin.query<{ ok: boolean }>("select tab.listener_attested_from(clock_timestamp() - interval '10 seconds') is not null as ok")).rows[0]?.ok === true;
    const held = () =>
      otherLog
        .lines()
        .map((l) => JSON.parse(l) as { level?: number; msg?: string; heldUntilUs?: string })
        .filter((l) => l.msg === RUN_HELD_BY_OTHER_KEY_LOG);
    /** Writes run `watch`'s ticks by hand: 24 of them, 500 ms apart, from 12 s ago, clean, the latest open. */
    const tickedClean = (watch: string) =>
      admin.query(
        `insert into tab.listener_tick (watch_id, seq, ticked_at, clean, closed_at)
         select $1, n, clock_timestamp() - make_interval(secs => (12 - (n - 1) * 0.5)), case when n < 24 then true end,
                case when n < 24 then clock_timestamp() - make_interval(secs => (11.5 - (n - 1) * 0.5)) end
           from generate_series(1, 24) n`,
        [watch],
      );
    try {
      const l = await startGatewayListener(ctx, { host: '127.0.0.1', port: 0 });
      const ticks = async () => (await admin.query<{ n: number }>('select count(*)::int as n from tab.listener_tick')).rows[0]?.n ?? 0;
      expect(await eventually(async () => (await ticks()) >= 3)).toBe(true);
      await l.close();
      await runtimeOf(ctx).close();
      const { rows } = await admin.query<{ watch: string; open: number; last: boolean | null; n: number }>(
        `select watch_id::text as watch, count(*) filter (where clean is null)::int as open,
                (array_agg(clean order by seq desc))[1] as last, count(*)::int as n
           from tab.listener_tick group by watch_id`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ open: 0, last: true });
      const run = rows[0]?.watch ?? '';
      // It began with the run key of the server's secrets, of which the database keeps the SHA-256.
      expect((await admin.query<{ ok: boolean }>('select key_hash = sha256($2) as ok from tab.listener_run where watch_id = $1', [run, listenerRunKey(secrets)])).rows).toEqual([{ ok: true }]);
      expect(held()).toEqual([]);
      const holder = openPool({ connectionString: urlFor(other.database, SANDBOX_LISTENER_LOGIN), max: 1 });
      try {
        await expect(holder.query('select tab.record_listener_tick($1, true)', [run])).rejects.toThrow(/EBMR-DEV-076/);
        // As the database sees it 20 s after the server closed, with no listener running since: someone holding the
        // listener's credentials ticks a run of its own clean for 12 s. Before decision X43 the database vouched for it
        // (this case asserted so), with nothing to wait out; now it does not, begun with a key of its own (the database
        // tells it until when it is held) or not begun at all.
        await admin.query(
          "update tab.listener_tick set ticked_at = ticked_at - interval '20 seconds', closed_at = closed_at - interval '20 seconds' where watch_id = $1",
          [run],
        );
        const until = (await admin.query<{ u: string }>("select platform.epoch_micros(max(closed_at) + interval '1 hour')::text as u from tab.listener_tick where watch_id = $1", [run])).rows[0]?.u;
        const own = randomUUID();
        expect((await holder.query<{ r: unknown }>('select tab.begin_listener_run($1, $2) as r', [own, randomBytes(32)])).rows[0]?.r).toEqual({ heldUntilUs: until });
        await tickedClean(own);
        expect(await attested()).toBe(false);
        await admin.query('delete from tab.listener_tick where watch_id = $1', [own]);
        const bare = randomUUID();
        await tickedClean(bare);
        expect(await attested()).toBe(false);
        // Those runs would keep the server's next run from vouching for an hour after their last tick (a denial, as a
        // run left open would be); removed here.
        await admin.query('delete from tab.listener_tick where watch_id = $1', [bare]);
      } finally {
        await endPool(holder);
      }

      // The server started again with the same secrets: its run vouches once it has ticked clean for 10 s, as before.
      const again = new DevicesRuntime(ctx);
      runtimes.push(again);
      const second = await again.startWatch();
      expect(await eventually(attested, 15_000)).toBe(true);
      expect(held()).toEqual([]);
      await again.close();

      // Started with other secrets (another EBMR_SECRETS_FILE, or a development server without one): its run begins with
      // another key, which it logs at warn with the time until which it is held, and it vouches for nothing while it
      // ticks clean for 12 s, ...
      ctx.config.secrets = { ...secrets, nonceKey: randomBytes(32).toString('hex') };
      const rotated = new DevicesRuntime(ctx);
      runtimes.push(rotated);
      const third = await rotated.startWatch();
      const oldUntil = (await admin.query<{ u: string }>("select platform.epoch_micros(max(closed_at) + interval '1 hour')::text as u from tab.listener_tick where watch_id = $1", [second.id])).rows[0]?.u;
      expect(held().map((h) => [h.level, h.heldUntilUs])).toEqual([[40, oldUntil]]);
      await new Promise((r) => setTimeout(r, 12_000));
      const mine = await admin.query<{ closed: number; unclean: number }>(
        'select count(*) filter (where clean is not null)::int as closed, count(*) filter (where clean = false)::int as unclean from tab.listener_tick where watch_id = $1',
        [third.id],
      );
      expect(mine.rows[0]?.unclean).toBe(0);
      expect(mine.rows[0]?.closed).toBeGreaterThanOrEqual(20);
      expect(await attested()).toBe(false);
      // ... until the runs of the old key ticked over an hour ago.
      await admin.query(
        "update tab.listener_tick set ticked_at = ticked_at - interval '61 minutes', closed_at = closed_at - interval '61 minutes' where watch_id = any($1::uuid[])",
        [[run, second.id]],
      );
      expect(await eventually(attested, 2000)).toBe(true);
    } finally {
      ctx.config.secrets = secrets;
      for (const r of runtimes) await r.close().catch(() => undefined);
      await other.close();
    }
  }, 90_000);

  it('[DI-30][PR-20] a run the server cannot end on record as it closes is logged at warn and stays open; the database takes it as a listener that stopped without being ended, so a run ticking clean beside it vouches for nothing until its last tick is an hour old', async () => {
    const ctx = server.built.ctx;
    await listener?.close();
    listener = undefined;
    const { rows } = await server.db.admin.query<{ w: string }>('select watch_id::text as w from tab.listener_tick order by ticked_at desc limit 1');
    const run = rows[0]?.w ?? '';
    // The listener's login loses the right to end a run (in this database only): its end fails.
    await server.db.admin.query('revoke execute on function tab.end_listener_run(uuid, boolean) from ebmr_sandbox_listener');
    await runtimeOf(ctx).close();
    const warned = log
      .lines()
      .map((l) => JSON.parse(l) as { level?: number; msg?: string; err?: string })
      .filter((l) => l.msg === RUN_NOT_ENDED_LOG);
    expect(warned).toHaveLength(1);
    expect(warned[0]?.level).toBe(40);
    expect(warned[0]?.err).toMatch(/permission denied for function end_listener_run/);
    const open = await server.db.admin.query<{ seq: number }>('select seq from tab.listener_tick where watch_id = $1 and clean is null', [run]);
    expect(open.rows).toHaveLength(1);

    // Its last tick 20 minutes back: a run ticking clean for 12 s beside it vouches for nothing; 61 minutes back, it does.
    // That run holds the server's run key, so only the open run holds it (decision X40), not a key of its own (X43).
    await age(run, 20 * 60_000);
    const w = randomUUID();
    await writeTicks(w, steady(12_000, 500), listenerRunKey(ctx.config.secrets));
    expect(await vouched(w)).toBe('none');
    await age(run, 41 * 60_000);
    expect(await vouched(w)).toBe(10_000);
  }, 60_000);
});

describe('final verification of the item (listener-credential-bound): what the watch says when it ends its run (watch.ts end())', () => {
  /** A pool that answers every statement at once and keeps what it was sent. */
  function fakePool(): { pool: pg.Pool; sent: { sql: string; params: unknown[] }[] } {
    const sent: { sql: string; params: unknown[] }[] = [];
    const pool = {
      query: (sql: string, params: unknown[]) => {
        sent.push({ sql, params });
        return Promise.resolve({ rows: [{ r: null }] });
      },
    } as unknown as pg.Pool;
    return { pool, sent };
  }
  const ends = (sent: { sql: string; params: unknown[] }[]) => sent.filter((q) => q.sql.includes('tab.end_listener_run')).map((q) => q.params);

  it('[DI-30][PR-20] the end says whether everything that arrived since the last tick\'s answer was put on record: false after a loss, true otherwise; it waits for what is still out; a second call ends nothing more', async () => {
    const key = randomBytes(32);
    const lostCase = fakePool();
    const lossy = new ListenerWatch(lostCase.pool, key, () => undefined);
    await lossy.start();
    lossy.arrived().settle(false);
    await lossy.end();
    expect(ends(lostCase.sent)).toEqual([[lossy.id, false]]);

    const cleanCase = fakePool();
    const clean = new ListenerWatch(cleanCase.pool, key, () => undefined);
    await clean.start();
    clean.arrived().settle(true);
    const out = clean.arrived();
    const settled = Date.now();
    setTimeout(() => out.settle(true), 300);
    await clean.end();
    expect(Date.now() - settled).toBeGreaterThanOrEqual(250);
    expect(Date.now() - settled).toBeLessThan(EPOCH_SETTLE_LIMIT_MS);
    await clean.end();
    expect(ends(cleanCase.sent)).toEqual([[clean.id, true]]);
  });

  it('[DI-30][PR-20][DI-17] a run begins on record with its run key before its first tick, and says what the database answered; the run key is derived from the server\'s nonce key, the same for the same secrets and another for others, and is not that key (decision X43)', async () => {
    const secrets = { csrfHmacKey: randomBytes(32).toString('hex'), nonceKey: randomBytes(32).toString('hex') };
    const key = listenerRunKey(secrets);
    expect(key).toHaveLength(32);
    expect(listenerRunKey({ ...secrets })).toEqual(key);
    const otherCsrf: { csrfHmacKey: string; nonceKey: string } = { ...secrets, csrfHmacKey: randomBytes(32).toString('hex') };
    expect(listenerRunKey(otherCsrf)).toEqual(key);
    expect(listenerRunKey({ ...secrets, nonceKey: randomBytes(32).toString('hex') })).not.toEqual(key);
    expect(key.toString('hex')).not.toBe(secrets.nonceKey);
    expect(key).not.toEqual(createHash('sha256').update(secrets.nonceKey, 'utf8').digest());

    const sent: { sql: string; params: unknown[] }[] = [];
    const pool = {
      query: (sql: string, params: unknown[]) => {
        sent.push({ sql, params });
        return Promise.resolve({ rows: [{ r: sql.includes('tab.begin_listener_run') ? { heldUntilUs: '1790584618000000' } : { seq: sent.length } }] });
      },
    } as unknown as pg.Pool;
    const watch = new ListenerWatch(pool, key, () => undefined);
    expect(await watch.start()).toEqual({ heldUntilUs: '1790584618000000' });
    await watch.stop();
    expect(sent.slice(0, 2).map((q) => [q.sql.match(/tab\.\w+/)?.[0], q.params])).toEqual([
      ['tab.begin_listener_run', [watch.id, key]],
      ['tab.record_listener_tick', [watch.id, null]],
    ]);
    expect(sent.filter((q) => q.sql.includes('tab.begin_listener_run'))).toHaveLength(1);
  });
});


describe('verification of listener-credential-bound (x39-alter-role): session defaults the listener\'s own login sets on itself (decision X42)', () => {
  const SETTINGS_SQL =
    "select current_setting('default_transaction_read_only') as ro, current_setting('idle_session_timeout') as idle, current_setting('idle_in_transaction_session_timeout') as tx";

  it('[DI-30][PR-20][DI-17] defaults the listener\'s login set on itself before the listener connected (read-only transactions, idle timeouts) do not reach the listener\'s pools, which fix those settings: it starts, ticks clean and keeps its connections; while the defaults stand the database vouches for no window, and once they are removed the run that kept ticking vouches at once', async () => {
    const otherLog = logCollector();
    const other = await startServer('SANDBOX', { logStream: otherLog.stream });
    const db = quoteIdent(other.database);
    const listenerUrl = urlFor(other.database, SANDBOX_LISTENER_LOGIN);
    // What the credential's holder runs, with nothing but that login (its connection open before the defaults).
    const holder = openPool({ connectionString: listenerUrl, max: 1, idleTimeoutMillis: 0 });
    const backends = async () =>
      (await other.db.admin.query<{ pid: number }>("select pid from pg_stat_activity where datname = current_database() and usename = 'ebmr_sandbox_listener' order by pid")).rows.map((r) => r.pid);
    const attested = async () =>
      (await other.db.admin.query<{ ok: boolean }>("select tab.listener_attested_from(clock_timestamp() - interval '10 seconds') is not null as ok")).rows[0]?.ok === true;
    async function eventually(check: () => Promise<boolean>, ms: number): Promise<boolean> {
      for (let waited = 0; waited < ms; waited += 100) {
        if (await check()) return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    }
    let l: GatewayListener | undefined;
    try {
      for (const setting of ['default_transaction_read_only = on', "idle_session_timeout = '1s'", "idle_in_transaction_session_timeout = '1s'"]) {
        await holder.query(`alter role ebmr_sandbox_listener in database ${db} set ${setting}`);
      }
      // A connection of that login opened now takes them: its tick is refused.
      const plain = openPool({ connectionString: listenerUrl, max: 1 });
      plain.on('error', () => undefined);
      try {
        expect((await plain.query(SETTINGS_SQL)).rows).toEqual([{ ro: 'on', idle: '1s', tx: '1s' }]);
        await expect(plain.query('select tab.record_listener_tick($1, true)', [randomUUID()])).rejects.toThrow(/read-only transaction/);
      } finally {
        await endPool(plain);
      }

      // The server's listener starts all the same: its pools' sessions run with the settings they fix, ...
      l = await startGatewayListener(other.built.ctx, { host: '127.0.0.1', port: 0 });
      expect((await runtimeOf(other.built.ctx).receipts().query(SETTINGS_SQL)).rows).toEqual([{ ro: 'off', idle: '0', tx: '0' }]);
      expect(await eventually(async () => (await backends()).length === RECEIPTS_POOL_MAX + WATCH_POOL_MAX + 1, 5000)).toBe(true);
      const kept = await backends();
      // ... it ticks clean for longer than the vouched window, and its connections outlive the idle timeout its login set;
      await new Promise((r) => setTimeout(r, 12_000));
      expect(await backends()).toEqual(kept);
      expect(otherLog.lines().filter((line) => (JSON.parse(line) as { msg?: string }).msg === IDLE_CONNECTION_LOST_LOG)).toEqual([]);
      const run = await other.db.admin.query<{ runs: number; closed: number; unclean: number }>(
        'select count(distinct watch_id)::int as runs, count(*) filter (where clean is not null)::int as closed, count(*) filter (where clean = false)::int as unclean from tab.listener_tick',
      );
      expect(run.rows[0]).toMatchObject({ runs: 1, unclean: 0 });
      expect(run.rows[0]?.closed).toBeGreaterThanOrEqual(20);
      // but while the defaults stand the database vouches for no window; ...
      expect(await attested()).toBe(false);
      // ... once they are removed (the connections that took the fixed settings stay as they are), the run that kept
      // ticking vouches at once.
      await holder.query(`alter role ebmr_sandbox_listener in database ${db} reset all`);
      expect(await eventually(attested, 2000)).toBe(true);
    } finally {
      await holder.query(`alter role ebmr_sandbox_listener in database ${db} reset all`).catch(() => undefined);
      await l?.close();
      await endPool(holder);
      await other.close();
    }
  }, 90_000);
});
