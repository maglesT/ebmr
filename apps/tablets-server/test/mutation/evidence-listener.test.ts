/**
 * The gateway listener's runs, its ticks and the window it vouches for, rule by rule (SQL mutation group
 * "evidence-listener": tablets 0350 item 6; decisions X36-X43). These tests close the gaps the SQL mutation run
 * (tools/sql-mutation) found in the group's server test (test/devices/listener-watch.test.ts):
 *   - tab.record_listener_tick and tab.end_listener_run: a call that names no run is refused (EBMR-DEV-075) and writes
 *     nothing; a tick closes its own run's open row only, never the open row of another run ticking beside it;
 *   - tab.listener_attested_from at the window's start, to the microsecond: the run's last tick at or before the start
 *     (a tick at the very microsecond of the start is that tick, so what came before it is outside the window), another
 *     run's tick at that microsecond, and another run's end at that microsecond (both inside the window);
 *   - the limits against the database's clock (the latest closed tick at most 2 s old; the hour of the holds, of the
 *     pruning of ticks and of the pruning of runs that never ticked) on either side of the limit. The microsecond of
 *     those limits cannot be reached: the clock is the server's and cannot be set or frozen (no clock seam, INV-16).
 * Ticks, ends and starts go through the functions the listener calls, on a connection of the listener's own login
 * (kernel 0980, ebmr_listener in a GMP database). Where a rule needs ticks at chosen times (a run of an hour, a tick at
 * the very microsecond of the window's start), the rows are written by the superuser, as listener-watch.test.ts does,
 * relative to one reading of the database's clock; tab.listener_attested_from is called as the superuser (it is granted
 * to nobody; the gate calls it).
 *
 * Controls: DI-17, DI-30, PR-20.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { copyDatabase, dropDatabase, endPool, LISTENER_LOGIN, openDatabase, openPool, uniqueSuffix, urlFor, type DatabaseHandle } from '@ebmr/test-kit';

let db: DatabaseHandle;
/** A connection of the GMP listener's own login (kernel 0980), as the listener's watch holds one. */
let listener: pg.Pool;

beforeAll(async () => {
  const name = `ebmr_t_${uniqueSuffix()}`;
  await copyDatabase(inject('serverTemplates').gmp.template, name);
  db = openDatabase(name, 'GMP');
  listener = openPool({ connectionString: urlFor(name, LISTENER_LOGIN), max: 1 });
}, 120_000);

afterAll(async () => {
  if (listener) await endPool(listener);
  if (db) {
    await db.close();
    await dropDatabase(db.name);
  }
});

/** The run key of the runs below (as runs of one server, which all begin with the same key). */
const TEST_RUN_KEY = randomBytes(32);

/** Removes every tick and every run's start. */
async function clear(): Promise<void> {
  await db.admin.query('delete from tab.listener_tick');
  await db.admin.query('delete from tab.listener_run');
}

/** What a call refused with: its SQLSTATE and message. */
async function refusal(p: Promise<unknown>): Promise<{ code: string | undefined; message: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { code: err.code, message: err.message ?? String(e) };
  }
  throw new Error('expected a refusal, the call succeeded');
}

/** A tick of run `watch` on the listener's own login (tab.record_listener_tick). */
async function tick(watch: string | null, clean: boolean | null): Promise<{ seq: number; tickedAtUs: string } | undefined> {
  return (await listener.query<{ r: { seq: number; tickedAtUs: string } }>('select tab.record_listener_tick($1, $2) as r', [watch, clean])).rows[0]?.r;
}

/** The end of run `watch` on the listener's own login (tab.end_listener_run). */
async function end(watch: string | null, clean: boolean | null): Promise<boolean | undefined> {
  return (await listener.query<{ r: boolean }>('select tab.end_listener_run($1, $2) as r', [watch, clean])).rows[0]?.r;
}

/** The start of run `watch` on the listener's own login (tab.begin_listener_run). */
async function begin(watch: string, key: Buffer): Promise<{ heldUntilUs: string | null } | undefined> {
  return (await listener.query<{ r: { heldUntilUs: string | null } }>('select tab.begin_listener_run($1, $2) as r', [watch, key])).rows[0]?.r;
}

/** Every tick on record: run, seq, clean, and whether it is closed (closed_at set). */
async function ticks(): Promise<{ watch: string; seq: number; clean: boolean | null; closed: boolean }[]> {
  const { rows } = await db.admin.query<{ watch: string; seq: number; clean: boolean | null; closed: boolean }>(
    'select watch_id::text as watch, seq, clean, closed_at is not null as closed from tab.listener_tick order by watch_id, seq',
  );
  return rows;
}

/** Records by hand that run `watch` began with `key` (as tab.begin_listener_run would). */
async function keyRun(watch: string, key: Buffer = TEST_RUN_KEY): Promise<void> {
  await db.admin.query('insert into tab.listener_run (watch_id, key_hash) values ($1, sha256($2))', [watch, key]);
}

/** The database's clock now, as text (microseconds kept): the instant the rows below are written relative to. */
async function clockNow(): Promise<string> {
  return (await db.admin.query<{ t: string }>('select clock_timestamp()::text as t')).rows[0]?.t ?? '';
}

/** Instant `t` less `ms` milliseconds (and `us` microseconds), as text. */
async function before(t: string, ms: number, us = 0): Promise<string> {
  return (await db.admin.query<{ x: string }>("select ($1::timestamptz - $2::bigint * interval '1 millisecond' - $3::bigint * interval '1 microsecond')::text as x", [t, ms, us])).rows[0]?.x ?? '';
}

/**
 * Writes by hand the ticks of run `watch`, every 500 ms from `fromMs` to `toMs` before instant `t` (seq from 1, each
 * closed 500 ms after its tick, as the next tick closes it), all clean but the latest, which is open. Ticks `unclean`
 * (ages in ms) are closed unclean; ticks `skip` are left out (a gap).
 */
async function writeSteady(t: string, watch: string, fromMs: number, toMs: number, opts: { unclean?: number[]; skip?: number[] } = {}): Promise<void> {
  await db.admin.query(
    `insert into tab.listener_tick (watch_id, seq, ticked_at, clean, closed_at)
     select $2, s.n, $1::timestamptz - s.age * interval '1 millisecond',
            case when s.age = $4 then null else not (s.age = any ($5::int[])) end,
            case when s.age = $4 then null else $1::timestamptz - (s.age - 500) * interval '1 millisecond' end
       from (select n, $3::int - (n - 1) * 500 as age from generate_series(1, ($3::int - $4::int) / 500 + 1) n) s
      where not (s.age = any ($6::int[]))`,
    [t, watch, fromMs, toMs, opts.unclean ?? [], opts.skip ?? []],
  );
}

/** Writes by hand one tick of run `watch` (seq `seq`), ticked `tickedMs` before `t` and closed `closedMs` before it (null: open). */
async function writeTick(t: string, watch: string, seq: number, tickedMs: number, closedMs: number | null, clean: boolean | null = closedMs === null ? null : true): Promise<void> {
  await db.admin.query(
    `insert into tab.listener_tick (watch_id, seq, ticked_at, clean, closed_at)
     values ($2, $3, $1::timestamptz - $4::bigint * interval '1 millisecond', $5,
             case when $6::bigint is null then null else $1::timestamptz - $6::bigint * interval '1 millisecond' end)`,
    [t, watch, seq, tickedMs, clean, closedMs],
  );
}

/**
 * tab.listener_attested_from as the gate calls it, for a window starting at `from` (default: 10 s before now, as for a
 * weighing whose transaction has just begun): the start of the window the listener vouches for, as text, or null.
 */
async function attested(from?: string): Promise<string | null> {
  const { rows } = await db.admin.query<{ a: string | null }>(
    "select tab.listener_attested_from(coalesce($1::timestamptz, clock_timestamp() - interval '10 seconds'))::text as a",
    [from ?? null],
  );
  return rows[0]?.a ?? null;
}

describe('tab.record_listener_tick and tab.end_listener_run: the run a call names, and only that run', () => {
  it('[DI-17][DI-30] a tick that names no run is refused (EBMR-DEV-075) and writes nothing: no row of any run, and the open tick of the run beside it stays open', async () => {
    await clear();
    const w = randomUUID();
    expect((await tick(w, true))?.seq).toBe(1);
    expect(await refusal(tick(null, true))).toEqual({ code: 'P0001', message: 'EBMR-DEV-075 a tick of the gateway listener names the run it belongs to' });
    expect(await ticks()).toEqual([{ watch: w, seq: 1, clean: null, closed: false }]);
    expect((await tick(w, true))?.seq).toBe(2);
    await clear();
  });

  it('[DI-17][DI-30] an end that names no run is refused (EBMR-DEV-075) and closes nothing: the open tick of the run beside it stays open until that run ends itself', async () => {
    await clear();
    const w = randomUUID();
    await tick(w, true);
    expect(await refusal(end(null, true))).toEqual({ code: 'P0001', message: 'EBMR-DEV-075 the end of a run of the gateway listener names the run' });
    expect(await ticks()).toEqual([{ watch: w, seq: 1, clean: null, closed: false }]);
    expect(await end(w, true)).toBe(true);
    expect(await ticks()).toEqual([{ watch: w, seq: 1, clean: true, closed: true }]);
    await clear();
  });

  it('[DI-17][DI-30][PR-20] a tick closes only its own run\'s open row: the open tick of another run ticking beside it stays open, to be closed by that run\'s own next tick with what that run says', async () => {
    await clear();
    const [w, v] = [randomUUID(), randomUUID()].sort();
    if (!w || !v) throw new Error('two runs');
    await tick(w, true);
    await tick(v, true);
    // w's second tick closes w's first, clean; v's first stays open.
    expect((await tick(w, true))?.seq).toBe(2);
    expect(await ticks()).toEqual([
      { watch: w, seq: 1, clean: true, closed: true },
      { watch: w, seq: 2, clean: null, closed: false },
      { watch: v, seq: 1, clean: null, closed: false },
    ]);
    // v's second tick closes v's first with what v says (not clean); w's second stays open.
    expect((await tick(v, false))?.seq).toBe(2);
    expect(await ticks()).toEqual([
      { watch: w, seq: 1, clean: true, closed: true },
      { watch: w, seq: 2, clean: null, closed: false },
      { watch: v, seq: 1, clean: false, closed: true },
      { watch: v, seq: 2, clean: null, closed: false },
    ]);
    await clear();
  });
});

describe('tab.listener_attested_from at the window\'s start, to the microsecond', () => {
  it('[DI-30][PR-20][DI-17] the run\'s ticks are counted from its last tick at or before the window\'s start: a tick at the very microsecond of the start is that tick, so an unclean tick or a gap before it is outside the window; that tick itself must be clean', async () => {
    // Ticks every 500 ms from 12 s to 0 s before t; the latest closed one 0.5 s before t, so the window starts 10.5 s
    // before t (10 s before that tick), at the very microsecond of a tick.
    const w = randomUUID();
    const scenario = async (opts: { unclean?: number[]; skip?: number[] }): Promise<{ start: string; got: string | null }> => {
      await clear();
      await keyRun(w);
      const t = await clockNow();
      await writeSteady(t, w, 12_000, 0, opts);
      return { start: await before(t, 10_500), got: await attested() };
    };
    // All clean: vouched from the start.
    let r = await scenario({});
    expect(r.got).toBe(r.start);
    // The tick before the start (11 s before t) unclean: it covers only what arrived before the window. Vouched.
    r = await scenario({ unclean: [11_000] });
    expect(r.got).toBe(r.start);
    // That tick missing (a gap before the window): vouched.
    r = await scenario({ skip: [11_000] });
    expect(r.got).toBe(r.start);
    // The tick at the start unclean: what arrived in the window's first 500 ms was not all put on record. None.
    r = await scenario({ unclean: [10_500] });
    expect(r.got).toBeNull();
    await clear();
  });

  it('[DI-30][PR-20][DI-17] another run\'s tick at the very microsecond of the window\'s start is a tick in the window: a run that stopped there without being ended, over an hour ago, keeps the run beside it from vouching for a gate whose window reaches back to it; a microsecond earlier it ticked before the window and does not', async () => {
    await clear();
    const w = randomUUID();
    const lost = randomUUID();
    await keyRun(w);
    await keyRun(lost);
    const t = await clockNow();
    // A run of over an hour (every 500 ms from 3665 s to 0 s before t); a gate whose window starts 3650 s before t (a
    // transaction begun over an hour ago).
    await writeSteady(t, w, 3_665_000, 0);
    const start = await before(t, 3_650_000);
    // The lost run's open tick at the very microsecond of the start: none.
    await writeTick(t, lost, 1, 3_650_000, null);
    expect(await attested(start)).toBeNull();
    // A microsecond before the start (and over an hour ago, so no longer a hold of its own): vouched from the start.
    await db.admin.query("update tab.listener_tick set ticked_at = ticked_at - interval '1 microsecond' where watch_id = $1", [lost]);
    expect(await attested(start)).toBe(start);
    await clear();
  });

  it('[DI-30][PR-20][DI-17] another run that ended at the very microsecond of the window\'s start was receiving in the window: no window is vouched for, though that run began with the same run key; one that ended a microsecond before the start does not count', async () => {
    await clear();
    const w = randomUUID();
    const ended = randomUUID();
    await keyRun(w);
    await keyRun(ended);
    const t = await clockNow();
    await writeSteady(t, w, 12_000, 0);
    const start = await before(t, 10_500);
    // The other run's last tick 11 s before t, closed (its end) at the very microsecond of the start: none.
    await writeTick(t, ended, 1, 11_000, 10_500);
    expect(await attested()).toBeNull();
    // Closed a microsecond before the start: it ended before the window, and holds the same key. Vouched.
    await db.admin.query("update tab.listener_tick set closed_at = closed_at - interval '1 microsecond' where watch_id = $1", [ended]);
    expect(await attested()).toBe(start);
    await clear();
  });
});

describe('the limits against the database\'s clock, on either side of the limit', () => {
  it('[DI-30][PR-20] a window is vouched for only while the run\'s latest closed tick is at most 2 s old: 1.9 s old it is, 2.1 s old it is not (written and asked in one round trip)', async () => {
    /** Writes a run whose latest closed tick is `lastMs` old and asks at once, in one round trip of statements. */
    const vouchedWith = async (lastMs: number): Promise<boolean> => {
      await clear();
      const w = randomUUID();
      await keyRun(w);
      const from = lastMs + 11_000;
      const results = (await db.admin.query(
        `insert into tab.listener_tick (watch_id, seq, ticked_at, clean, closed_at)
         select '${w}', s.n, c.t - s.age * interval '1 millisecond', case when s.age = ${String(lastMs - 500)} then null else true end,
                case when s.age = ${String(lastMs - 500)} then null else c.t - (s.age - 500) * interval '1 millisecond' end
           from (select clock_timestamp() as t) c,
                (select n, ${String(from)} - (n - 1) * 500 as age from generate_series(1, (${String(from)} - ${String(lastMs - 500)}) / 500 + 1) n) s;
         select tab.listener_attested_from(clock_timestamp() - interval '10 seconds') is not null as vouched`,
      )) as unknown as pg.QueryResult<{ vouched: boolean }>[];
      return results[1]?.rows[0]?.vouched ?? false;
    };
    expect(await vouchedWith(1_900)).toBe(true);
    expect(await vouchedWith(2_100)).toBe(false);
    await clear();
  });

  it('[DI-30][PR-20][DI-17] another run that stopped ticking without being ended keeps a run from vouching while its open tick is under an hour old: 59 min 59 s old it does, 60 min 1 s old it does not', async () => {
    await clear();
    const w = randomUUID();
    const lost = randomUUID();
    await keyRun(w);
    await keyRun(lost);
    const t = await clockNow();
    await writeSteady(t, w, 12_000, 0);
    await writeTick(t, lost, 1, 3_599_000, null);
    expect(await attested()).toBeNull();
    await db.admin.query("update tab.listener_tick set ticked_at = ticked_at - interval '2 seconds' where watch_id = $1", [lost]);
    expect(await attested()).toBe(await before(t, 10_500));
    await clear();
  });

  it('[DI-30][PR-20][DI-17] a run of another key keeps a run from vouching while its last tick was closed under an hour ago: closed 59 min 59 s ago it does, 60 min 1 s ago it does not (decision X43)', async () => {
    await clear();
    const w = randomUUID();
    const foreign = randomUUID();
    await keyRun(w);
    await keyRun(foreign, randomBytes(32));
    const t = await clockNow();
    await writeSteady(t, w, 12_000, 0);
    await writeTick(t, foreign, 1, 3_599_500, 3_599_000);
    expect(await attested()).toBeNull();
    await db.admin.query("update tab.listener_tick set ticked_at = ticked_at - interval '2 seconds', closed_at = closed_at - interval '2 seconds' where watch_id = $1", [foreign]);
    expect(await attested()).toBe(await before(t, 10_500));
    await clear();
  });

  it('[DI-17][DI-30] a run that begins is held by a run of another key that closed a tick under an hour ago, until an hour after that tick: closed 59 min 59 s ago it is, 60 min 1 s ago it is not (decision X43)', async () => {
    await clear();
    const foreign = randomUUID();
    await keyRun(foreign, randomBytes(32));
    const t = await clockNow();
    await writeTick(t, foreign, 1, 3_599_500, 3_599_000);
    const until = (await db.admin.query<{ u: string }>("select platform.epoch_micros(closed_at + interval '1 hour')::text as u from tab.listener_tick where watch_id = $1", [foreign])).rows[0]?.u;
    expect(await begin(randomUUID(), TEST_RUN_KEY)).toEqual({ heldUntilUs: until });
    await db.admin.query("update tab.listener_tick set ticked_at = ticked_at - interval '2 seconds', closed_at = closed_at - interval '2 seconds' where watch_id = $1", [foreign]);
    expect(await begin(randomUUID(), TEST_RUN_KEY)).toEqual({ heldUntilUs: null });
    await clear();
  });

  it('[DI-17][DI-30] a run\'s start prunes the runs that began over an hour ago and never ticked: one that began 60 min 1 s ago goes, one that began 59 min 59 s ago stays', async () => {
    await clear();
    const [older, younger, fresh] = [randomUUID(), randomUUID(), randomUUID()];
    await db.admin.query(
      `insert into tab.listener_run (watch_id, key_hash, began_at)
       values ($1, sha256($3), clock_timestamp() - interval '3601 seconds'), ($2, sha256($3), clock_timestamp() - interval '3599 seconds')`,
      [older, younger, TEST_RUN_KEY],
    );
    expect(await begin(fresh, TEST_RUN_KEY)).toEqual({ heldUntilUs: null });
    const { rows } = await db.admin.query<{ watch: string }>('select watch_id::text as watch from tab.listener_run order by began_at');
    expect(rows.map((r) => r.watch)).toEqual([younger, fresh]);
    await clear();
  });

  /**
   * Defect D13 of the Phase 2 exit (SQL mutation kill work): the tick prune deleted a row once its tick was an hour old,
   * but the hold of a run of another key is measured from when the row was closed (tab.listener_attested_from, and the
   * heldUntilUs tab.begin_listener_run answers). A run's last row is closed after its tick (by the run's end, or by a
   * next tick that landed late), so any tick of any run cut that hold short of the time the database had already
   * announced. Tablets 0715 prunes a row only once its tick and its close are both over an hour old (decision X43: the
   * hour runs from the close).
   */
  it('[DI-30][PR-20][DI-17] a run of another key whose last tick ticked 61 min ago and was closed 59 min ago keeps its hold until an hour after its close: a tick of any run keeps that row, a run that begins is told it is held until the close plus one hour, and no run vouches meanwhile; once the close is over an hour old the hold ends and the row is pruned (decision X43, D13)', async () => {
    await clear();
    const foreign = randomUUID();
    await keyRun(foreign, randomBytes(32));
    const t = await clockNow();
    await writeTick(t, foreign, 1, 61 * 60_000, 59 * 60_000);
    const until = (await db.admin.query<{ u: string }>("select platform.epoch_micros(closed_at + interval '1 hour')::text as u from tab.listener_tick where watch_id = $1", [foreign])).rows[0]?.u;
    const w = randomUUID();
    expect(await begin(w, TEST_RUN_KEY)).toEqual({ heldUntilUs: until });
    // The run ticks (each tick prunes): the other key's row stays, and the hold stands as announced.
    await tick(w, true);
    await tick(w, true);
    expect((await ticks()).filter((r) => r.watch === foreign)).toEqual([{ watch: foreign, seq: 1, clean: true, closed: true }]);
    expect(await begin(randomUUID(), TEST_RUN_KEY)).toEqual({ heldUntilUs: until });
    // A run of the same key with 12 s of clean ticks (the ticking run's own rows taken away, so that only this run
    // ticks in the window) is held by it: nothing is vouched for.
    await db.admin.query('delete from tab.listener_tick where watch_id = $1', [w]);
    const steady = randomUUID();
    await keyRun(steady);
    const now = await clockNow();
    await writeSteady(now, steady, 12_000, 0);
    expect(await attested()).toBeNull();
    // Closed 60 min 1 s ago: the hold has ended, the run vouches, and the next tick prunes the row.
    await db.admin.query("update tab.listener_tick set closed_at = clock_timestamp() - interval '3601 seconds' where watch_id = $1", [foreign]);
    expect(await attested()).toBe(await before(now, 10_500));
    await tick(w, true);
    expect((await ticks()).filter((r) => r.watch === foreign)).toEqual([]);
    await clear();
  });

  it('[DI-17][DI-30] a tick prunes the ticks of every run ticked over an hour ago: one ticked 60 min 1 s ago goes, one ticked 59 min 59 s ago stays', async () => {
    await clear();
    const [older, younger] = [randomUUID(), randomUUID()];
    const t = await clockNow();
    await writeTick(t, older, 1, 3_601_000, 3_600_500);
    await writeTick(t, younger, 1, 3_599_000, 3_598_500);
    const w = randomUUID();
    await tick(w, true);
    const left = await ticks();
    expect(left.map((r) => r.watch).sort()).toEqual([younger, w].sort());
    await clear();
  });
});
