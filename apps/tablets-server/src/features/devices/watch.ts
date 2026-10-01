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
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';

/** How often the listener ticks (tablets 0350: a vouched-for window ends at most 2 s before the gate reads it). */
export const LISTENER_TICK_MS = 500;
/** The longest a tick waits for its epoch's arrivals to settle; any still unsettled then counts as lost. */
export const EPOCH_SETTLE_LIMIT_MS = 5000;

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
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  /** `pool`: the watch's own pool of the listener's login; `onTick`: told how each tick went. */
  constructor(
    private readonly pool: pg.Pool,
    private readonly onTick: (outcome: TickOutcome) => void,
  ) {}

  /** Something received now that must go on record. */
  arrived(): Arrival {
    return this.current.arrived();
  }

  /**
   * Writes the first tick (rejects when it cannot: the listener then does not start) and then ticks every
   * LISTENER_TICK_MS until stop().
   */
  async start(): Promise<void> {
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
  }

  /** Stops ticking; resolves once the tick in flight has ended. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    await this.loop;
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
