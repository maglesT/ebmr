/**
 * A call given up, and its request aborted, when the server has not answered within a deadline (review F60). The caller
 * gets a NETWORK error, which every screen reads as a lost answer: a pending floor entry becomes NOT SAVED (resend under
 * the same idempotency key, D1; DI-28), a signature in flight is reconciled from the signatures read again (INV-10), a
 * sign-out is not confirmed. Without it a connection that stalls without a reset, a request queued behind the browser's
 * connections to the server, or a handler waiting on a lock leaves the screen "Saving..." with no way out.
 */
import type { Result } from '@ebmr/api-contract';

/** How long a floor entry or a signature waits for the server's answer before it is treated as lost. */
export const SEND_DEADLINE_MS = 30_000;

export const NO_ANSWER_IN_TIME = 'The server did not answer in time.';

export async function callWithDeadline<T>(ms: number, run: (signal: AbortSignal) => Promise<Result<T>>, message: string = NO_ANSWER_IN_TIME): Promise<Result<T>> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Result<T>>((resolve) => {
    timer = setTimeout(() => {
      resolve({ ok: false, error: { kind: 'NETWORK', message } });
      ctl.abort();
    }, ms);
  });
  try {
    return await Promise.race([run(ctl.signal), late]);
  } finally {
    clearTimeout(timer);
  }
}
