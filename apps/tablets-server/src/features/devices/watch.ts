/**
 * The gateway listener's watch (tablets 0350 item 6; review finding P50, follow-up item p50-gate-vs-app-role; DI-30,
 * PR-20): what lets the manual-weighing gate fail closed when the listener cannot put its evidence on record.
 *
 * Everything the listener receives that must go on record (a heartbeat, whose receipt keeps the manual path shut; an
 * answer of the gateway's API, which keeps a report that the API cannot be reached from counting) is an arrival of the
 * epoch current when it came in, settled once it is on record (or once it proved to be no gateway's evidence) or lost.
 * Every LISTENER_TICK_MS the watch writes a tick on a connection of its own, of the listener's own login
 * (tab.record_listener_tick, which only that login may call; kernel 0980): it closes the database's previous tick with
 * whether the epoch that ended at that tick's answer was clean (every arrival settled on record), and opens the next one
 * at the database's time. A tick waits for its epoch's arrivals to settle, at most EPOCH_SETTLE_LIMIT_MS (after which
 * they count as lost). The epoch changes only when a tick is answered; a tick that fails makes both the epoch it closes
 * and the one going on unclean, since whether it reached the database is not known. The database vouches for a window
 * only from consecutive clean ticks, the latest at most 2 s old (tab.listener_attested_from), so a listener that loses
 * evidence, cannot tick, or is not running keeps the manual path shut: a denial of the fallback, never a weight beside
 * a working scale.
 *
 * When the listener stops, the watch ends its run on record (end(), tab.end_listener_run): the run's open tick is
 * closed with whether everything that arrived up to the end was put on record, and the run ticks no more. A run that
 * stops without being ended (the process killed, or the end not written) is taken by the database as a listener that
 * may still be receiving while its ticks cannot land, so no other run vouches for a window until an hour after its last
 * tick (decision X40). Session defaults a holder of the listener's credentials sets on the listener's login do not keep
 * it from ticking: its pools fix those settings, and nothing is vouched for while such a default stands (decision X42;
 * runtime.ts LISTENER_SESSION_PINS).
 *
 * A run that ended on record holds nothing beyond its end, and the database cannot tell a listener started again from
 * a holder of the listener's credentials who ticks a run of its own. So each run begins on record before its first
 * tick (tab.begin_listener_run) with a run key the server derives from secrets only its host holds (listenerRunKey:
 * the same for every run of a server with the same EBMR_SECRETS_FILE; the database keeps only its SHA-256), and while
 * a run of another key, or of none, closed a tick within the last hour no run vouches (decision X43). A server started
 * again with the same secrets vouches once it has ticked clean for 10 s, as before; a holder of the listener's
 * credentials alone, only once no run with the server's key has ticked for an hour (decision X39 (6)).
 */
import { createHmac, randomUUID } from 'node:crypto';
import type pg from 'pg';

/** How often the listener ticks (tablets 0350: a vouched-for window ends at most 2 s before the gate reads it). */
export const LISTENER_TICK_MS = 500;
/** The longest a tick waits for its epoch's arrivals to settle; any still unsettled then counts as lost. */
export const EPOCH_SETTLE_LIMIT_MS = 5000;

/** What the run key is derived for, so that it is no other use's key (decision X43). */
const RUN_KEY_LABEL = 'ebmr/tablets/gateway-listener-run-key/v1';

/**
 * The run key every run of this server's listener begins with (tab.begin_listener_run; decision X43): HMAC-SHA-256 of
 * a fixed label under the server's nonce key (EBMR_SECRETS_FILE), so it is the same for every run of a server with the
 * same secrets file, another for other secrets, and nothing a holder of the listener's database credentials alone can
 * make. A server without EBMR_SECRETS_FILE (development) draws its secrets at start, so each process has a key of its own.
 */
export function listenerRunKey(secrets: { nonceKey: string }): Buffer {
  return createHmac('sha256', secrets.nonceKey).update(RUN_KEY_LABEL, 'utf8').digest();
}

/** How the database took a run's start (tab.begin_listener_run). */
export interface RunBegun {
  /**
   * Null, or the database time (microseconds since the epoch, as text) until which runs of another key, or of none,
   * that ticked within the last hour keep this run from vouching (decision X43).
   */
  heldUntilUs: string | null;
}

/** What the listener received that must go on record. */
export interface Arrival {
  /** True when the receipt or answer was started (its own outcome then settles it). */
  started: boolean;
  /** On record (or no gateway's evidence): true; lost: false. Only the first call counts. */
  settle(onRecord: boolean): void;
}

class Epoch {
  lost = false;
  private readonly pending = new Set<Promise<void>>();

  arrived(): Arrival {
    let done = false;
    let finish!: () => void;
    const settledP = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.pending.add(settledP);
    return {
      started: false,
      settle: (onRecord: boolean) => {
        if (done) return;
        done = true;
        if (!onRecord) this.lost = true;
        this.pending.delete(settledP);
        finish();
      },
    };
  }

  /** Whether every arrival of the epoch settled on record, waiting at most `limitMs` for those still out. */
  async clean(limitMs: number): Promise<boolean> {
    if (this.pending.size > 0) {
      let timer: NodeJS.Timeout | undefined;
      const late = await Promise.race([
        Promise.all([...this.pending]).then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), limitMs);
        }),
      ]);
      clearTimeout(timer);
      if (late) this.lost = true;
    }
    return !this.lost;
  }
}

/** The outcome of one tick, for the runtime's log. */
export type TickOutcome = { ok: true; clean: boolean | null } | { ok: false; error: unknown };

export class ListenerWatch {
  /** This run of the listener (tab.listener_tick.watch_id). */
  readonly id = randomUUID();
  private current = new Epoch();
  private ended: Epoch | null = null;
  private stopped = false;
  private ending: Promise<void> | null = null;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  /**
   * `pool`: the watch's own pool of the listener's login; `runKey`: the key this run begins with (listenerRunKey);
   * `onTick`: told how each tick went.
   */
  constructor(
    private readonly pool: pg.Pool,
    private readonly runKey: Buffer,
    private readonly onTick: (outcome: TickOutcome) => void,
  ) {}

  /** Something received now that must go on record. */
  arrived(): Arrival {
    return this.current.arrived();
  }

  /**
   * Begins the run on record with its key (tab.begin_listener_run) and writes the first tick (rejects when it cannot do
   * either: the listener then does not start), then ticks every LISTENER_TICK_MS until stop(). Resolves with how the
   * database took the run's start.
   */
  async start(): Promise<RunBegun> {
    const { rows } = await this.pool.query<{ r: { heldUntilUs?: string | null } | null }>('select tab.begin_listener_run($1, $2) as r', [this.id, this.runKey]);
    const begun: RunBegun = { heldUntilUs: rows[0]?.r?.heldUntilUs ?? null };
    await this.tick(true);
    this.loop = (async () => {
      while (!this.stopped) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, LISTENER_TICK_MS);
          this.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        this.wake = null;
        if (this.stopped) break;
        await this.tick(false);
      }
    })();
    return begun;
  }

  /** Stops ticking; resolves once the tick in flight has ended. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    await this.loop;
  }

  /**
   * Stops ticking and ends this run on record (tab.end_listener_run), once the listener receives nothing more: closes
   * the run's open tick with whether everything that arrived since the previous tick's answer, up to now, was put on
   * record (waiting for what is still out, at most EPOCH_SETTLE_LIMIT_MS, as a tick does). Rejects when the end cannot be
   * written: the run then counts as stopped without being ended (decision X40). Called again, gives the first call's
   * outcome.
   */
  end(): Promise<void> {
    this.ending ??= (async () => {
      await this.stop();
      const [before, since] = await Promise.all([this.ended?.clean(EPOCH_SETTLE_LIMIT_MS) ?? true, this.current.clean(EPOCH_SETTLE_LIMIT_MS)]);
      await this.pool.query('select tab.end_listener_run($1, $2) as r', [this.id, before && since]);
    })();
    return this.ending;
  }

  private async tick(first: boolean): Promise<void> {
    const ended = this.ended;
    const clean = ended ? await ended.clean(EPOCH_SETTLE_LIMIT_MS) : null;
    try {
      await this.pool.query('select tab.record_listener_tick($1, $2) as r', [this.id, clean]);
      // The tick is on record: the epoch going on ends at its answer, and the next tick says whether it was clean.
      this.ended = this.current;
      this.current = new Epoch();
      this.onTick({ ok: true, clean });
    } catch (error) {
      // Whether it reached the database is not known: what it closes and what goes on count as lost.
      if (ended) ended.lost = true;
      this.current.lost = true;
      this.onTick({ ok: false, error });
      if (first) throw error;
    }
  }
}
