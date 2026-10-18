/**
 * The inactivity warning of the session (module C1; slice 7g-5, decision 0025; DI-38): the kernel locks a session that
 * ran no command for its idle timeout (iam.session_activity). Shortly before that, the page says so and offers to stay
 * signed in (access.keepAlive): on an office terminal one press; on a shop-floor kiosk a fresh tap of the person's own
 * badge, which the server checks against the session's person (DI-14). The lock itself stays the kernel's: the session
 * poll shows it when it comes, whatever this warning thought.
 *
 * No clock is read: the warning counts seconds with an interval and starts again when the session view is renewed
 * (sign-in, unlock, keep-alive) or a write is accepted (apiState.onWrite), the activity the kernel counts.
 */
import { useEffect, useState } from 'react';
import type { RefusalEnvelope, SessionView } from '@ebmr/api-contract';
import { Banner, Button, Dialog, identity, machines } from '@ebmr/ui-kit';
import { apiState } from '../../api/client.ts';
import type { StoredDeviceKey } from '../../device/keystore.ts';
import { keepAliveCall } from './calls.ts';

/** How often the warning counts (ms). */
export const IDLE_TICK_MS = 1000;
/** Seconds before the idle lock the warning shows: a quarter of the timeout, at least 5 s and at most 60 s. */
export const warnSecondsOf = (timeoutSeconds: number): number => Math.min(60, Math.max(5, Math.floor(timeoutSeconds / 4)));

export function IdleWarning(props: {
  session: SessionView;
  kiosk: boolean;
  /** The lock overlay or a switch is on screen: no warning then. */
  suspended: boolean;
  deviceKey: StoredDeviceKey | null;
  demoBadges: readonly identity.DemoBadge[];
  onKept: (s: SessionView) => void;
}) {
  const { session, kiosk, suspended, deviceKey, demoBadges, onKept } = props;
  const [idle, setIdle] = useState(0);
  const [tapping, setTapping] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<RefusalEnvelope | null>(null);

  // A renewed session view (sign-in, unlock, keep-alive) is activity (state adjusted while rendering, not in an effect).
  const [counted, setCounted] = useState(session);
  if (counted !== session) {
    setCounted(session);
    setIdle(0);
  }
  useEffect(() => {
    const seen = () => setIdle(0);
    apiState.onWrite.add(seen);
    return () => {
      apiState.onWrite.delete(seen);
    };
  }, []);
  useEffect(() => {
    if (suspended) return;
    const id = setInterval(() => setIdle((s) => s + IDLE_TICK_MS / 1000), IDLE_TICK_MS);
    return () => clearInterval(id);
  }, [suspended]);

  const left = session.idleTimeoutSeconds - idle;
  const show = !suspended && !session.locked && left > 0 && left <= warnSecondsOf(session.idleTimeoutSeconds);
  if (!show && !tapping) return null;

  const keep = async (badgeUid?: string) => {
    setBusy(true);
    setRefusal(null);
    try {
      const r = await keepAliveCall(deviceKey, badgeUid);
      if (r.ok) {
        setTapping(false);
        setIdle(0);
        onKept(r.value);
      } else {
        setRefusal(machines.refusalOfFailure(r.failure));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {show ? (
        <div data-testid="idle-warning" style={{ position: 'fixed', insetInline: '1rem', bottom: '1rem', zIndex: 50 }}>
          <Banner tone="warning" title={`This session locks in ${String(Math.ceil(left))} seconds because nothing was done in it.`} live="assertive">
            <p>{kiosk ? 'Tap your own badge to stay signed in.' : 'Stay signed in if you are still working here.'}</p>
            {refusal && !tapping ? <p role="alert">{refusal.refusal.whatHappened}</p> : null}
            <Button variant="primary" isDisabled={busy} onPress={() => (kiosk ? setTapping(true) : void keep())}>
              {kiosk ? 'Tap to stay signed in' : 'Stay signed in'}
            </Button>
          </Banner>
        </div>
      ) : null}
      {tapping ? (
        <Dialog title="Stay signed in" isOpen isDismissable={false}>
          <identity.BadgePrompt
            reason="Keeping the session open"
            refusal={refusal}
            busy={busy}
            demoBadges={demoBadges}
            onTap={(uid) => void keep(uid)}
            onCancel={() => {
              setTapping(false);
              setRefusal(null);
            }}
          />
        </Dialog>
      ) : null}
    </>
  );
}
