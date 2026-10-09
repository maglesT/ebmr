/**
 * Bounds on the designer's costly reads (review P18; DI-05: the GMP server stays available for everyone's records,
 * signatures and audit while MBRs are validated and simulated): a count of the work of one kind running at once in
 * this process, checked when the work starts. Nothing waits in a queue: at the bound, the caller refuses at once
 * (503, retryable) and nothing is started.
 */

/** Takes a slot: the slot's release (idempotent), or null when `max` are taken already. */
export type AcquireSlot = (max: number) => (() => void) | null;

/** A pool of slots for one kind of work, counted in this process. */
export function slotPool(): AcquireSlot {
  let running = 0;
  return (max) => {
    if (running >= max) return null;
    running += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      running -= 1;
    };
  };
}
