/**
 * The server's only reads of the process clock (ESLint allows Date here and nowhere else in the app).
 * GMP time always comes from the database (dbNowUs in platform/db/commands.ts); this clock only serves
 * operational purposes that never enter a record: how long the tickets kept in the server's memory live (proof
 * tickets, change tickets; decision 0004 X26, X44).
 *
 * A moment is read from two clocks at once, and the time between two moments is the larger of what the two say
 * (decision 0004 X44). The process's monotonic clock (performance.now()) does not move when the host's wall clock is
 * stepped, so a wall clock set back (by hand, or by a time sync) does not lengthen a ticket. The host's wall clock
 * (Date.now()) also counts time the host spent suspended, which the monotonic clock may not, so a suspended host does
 * not lengthen a ticket either. A wall clock set forward shortens a ticket: the stricter side.
 */

/** A moment of the server process, read from both clocks (operational only; never a GMP time). */
export interface Moment {
  /** performance.now(): milliseconds on the process's monotonic clock. */
  readonly monoMs: number;
  /** Date.now(): milliseconds on the host's wall clock. */
  readonly wallMs: number;
}

/** The moment now. */
export function moment(): Moment {
  return { monoMs: performance.now(), wallMs: Date.now() };
}

/** Milliseconds from `from` to `to`: the larger of what the monotonic clock and the wall clock say. */
export function elapsedMs(from: Moment, to: Moment): number {
  return Math.max(to.monoMs - from.monoMs, to.wallMs - from.wallMs);
}
