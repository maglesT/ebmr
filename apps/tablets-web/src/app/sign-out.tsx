/**
 * The sign-out screens (DI-38, DI-14; review P5).
 *  - "Signing out": from the moment the sign-out starts until the server answers, the page is not usable as the
 *    person signing out any more, and does not look signed out yet.
 *  - "Sign-out not confirmed": the server did not confirm the end of the session (a lost answer, a server error, no
 *    answer in time), so the page must not look signed out: the sign-in form would invite the next person to walk up
 *    while the previous person's session is still alive. The screen blocks every other use of the page and retries
 *    the sign-out on its own until the server confirms it; a reload does the same. If another tab or a reload has
 *    finished the sign-out meanwhile, the retry starts the page again instead of ending anything.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Banner, Button } from '@ebmr/ui-kit';
import { useBoot } from './boot.tsx';
import { cls } from './classes.ts';

/** How often the screen retries the sign-out by itself. */
export const SIGN_OUT_RETRY_MS = 10_000;

/** Shown while the server is asked to end the session; nothing on the page can be used meanwhile. */
export function SigningOut() {
  return (
    <div className={cls('center')} data-testid="signing-out" aria-busy="true">
      <Banner tone="info" title="Signing out…">
        <p>Stay at this terminal until the sign-out is confirmed.</p>
      </Banner>
    </div>
  );
}

export function SignOutUnconfirmed() {
  const boot = useBoot();
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  // On this screen, signOut retries the pending sign-out (or starts the page again if it was finished elsewhere).
  const retrySignOut = boot.signOut;

  const retry = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await retrySignOut();
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, [retrySignOut]);

  useEffect(() => {
    const timer = setInterval(() => void retry(), SIGN_OUT_RETRY_MS);
    return () => clearInterval(timer);
  }, [retry]);

  return (
    <div className={cls('center')} data-testid="sign-out-unconfirmed">
      <Banner tone="error" title="Sign-out not confirmed">
        <p>The server has not confirmed that the previous person is signed out, so this terminal is not free yet.</p>
        {boot.problem ? <p>{boot.problem}</p> : null}
        <p>Stay at this terminal until the sign-out is confirmed. This page tries again every {SIGN_OUT_RETRY_MS / 1000} seconds; if it keeps failing, call the system administrator.</p>
      </Banner>
      <Button onPress={() => void retry()} isDisabled={busy}>
        {busy ? 'Signing out…' : 'Try signing out again'}
      </Button>
    </div>
  );
}
