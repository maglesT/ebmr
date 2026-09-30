/**
 * Start-up of the SPA (plan section 5): /api/meta (installation, watermark, server time), the terminal key from
 * IndexedDB, device identification by proof, then the session. Credentials and the CSRF token never enter
 * TanStack Query caches: they live in this component's state and in the API client's memory only.
 *
 * Sign-out (DI-38, DI-14; review P5): the page blocks as soon as the sign-out starts (phase 'signing-out'), and shows
 * the sign-in form only once the server has confirmed that this browser holds no session any more (logout answered,
 * or 401 NO_SESSION). A sign-out the server did not confirm (a lost or refused answer, or none within
 * SIGN_OUT_REQUEST_TIMEOUT_MS) keeps the page on a blocking "sign-out not confirmed" screen that retries (phase
 * 'sign-out-unconfirmed'), falls back to locking the session so it needs credentials again, and is marked in this
 * browser (sign-out-mark.ts: site storage and a same-site cookie): a reload finishes the sign-out before anything
 * else and never shows the previous person's session; a browser that can keep no mark ends any session it finds at
 * start-up. A retry never ends a session opened after another tab or a reload finished the sign-out.
 * Every other tab of this browser that shows a session or the sign-in form joins a sign-out marked there as soon as
 * it sees the mark (a storage event, becoming visible, or its next look at the stores every SIGN_OUT_MARK_CHECK_MS):
 * it blocks at once and ends (else locks) the session itself, so closing the tab that started the sign-out leaves no
 * tab usable as the person who signed out.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { routes, type CallError, type DeviceView, type MetaView, type Result, type SessionView } from '@ebmr/api-contract';
import { machines } from '@ebmr/ui-kit';
import { api, apiState, deviceProof } from '../api/client.ts';
import { forgetDeviceKey, loadDeviceKey, type StoredDeviceKey } from '../device/keystore.ts';
import { anchorServerTime } from './clock.ts';
import {
  confirmSignedOut,
  forgetSignOut,
  joinSignOut,
  SIGN_OUT_MARK_CHECK_MS,
  SIGN_OUT_MARK_KEY,
  signOutMarkedElsewhere,
  signOutPendingAtStartUp,
  signOutPendingHere,
  signOutStillPending,
  startSignOut,
} from './sign-out-mark.ts';

export type BootPhase = 'loading' | 'failed' | 'mismatch' | 'no-device' | 'device-refused' | 'signed-out' | 'signing-out' | 'sign-out-unconfirmed' | 'ready';

export interface BootState {
  phase: BootPhase;
  meta: MetaView | null;
  deviceKey: StoredDeviceKey | null;
  device: DeviceView | null;
  session: SessionView | null;
  problem: string | null;
}

export interface Boot extends BootState {
  /** Re-runs the whole start-up (after choosing a terminal). */
  restart(): void;
  /**
   * A session from sign-in, role choice or switch of user; ignored while this page has a sign-out pending, and while
   * this browser keeps the mark of a sign-out (this page then joins it instead: joinMarkedSignOut).
   */
  setSession(session: SessionView | null): void;
  /**
   * Looks for the mark of a sign-out that another tab of this browser started (sign-out-mark.ts). When there is one,
   * this page joins it at once (it blocks, then ends the session, else locks it) and the answer is true; it is also
   * true while this page has a sign-out of its own under way. The caller then must not act on the session any more
   * (the access controller asks before each session poll).
   */
  joinMarkedSignOut(): boolean;
  /**
   * Signs the person out: the page blocks at once ('signing-out') and reaches 'signed-out' only when the server
   * confirms that no session is left, else 'sign-out-unconfirmed'. On a page with a sign-out pending (the "sign-out not
   * confirmed" screen) it retries that sign-out; if another tab or a reload has finished it meanwhile, it re-runs the
   * start-up instead and ends nothing (the session the browser holds by then may be another person's).
   */
  signOut: () => Promise<void>;
  forgetTerminal(): Promise<void>;
}

const BootContext = createContext<Boot | null>(null);

export function useBoot(): Boot {
  const b = useContext(BootContext);
  if (!b) throw new Error('useBoot outside BootProvider');
  return b;
}

/** How long one sign-out request may take; after that the sign-out counts as not confirmed (and is retried). */
export const SIGN_OUT_REQUEST_TIMEOUT_MS = 15_000;
const TIMED_OUT = 'The server did not answer in time.';

const describe = (e: CallError): string =>
  e.kind === 'REFUSAL'
    ? `${e.envelope.refusal.whatHappened} ${e.envelope.refusal.why}`.trim()
    : e.kind === 'NETWORK'
      ? e.message === TIMED_OUT
        ? TIMED_OUT
        : 'The server cannot be reached.'
      : e.kind === 'PROTOCOL'
        ? e.message
        : 'Installation mismatch.';

/** The server's own answer that this browser holds no session (never assumed from a lost or failed answer). */
const isNoSession = (e: CallError): boolean => e.kind === 'REFUSAL' && e.status === 401 && e.envelope.refusal.code === 'NO_SESSION';

/** One sign-out request, given up (and aborted) when the server has not answered within SIGN_OUT_REQUEST_TIMEOUT_MS. */
async function withDeadline<T>(run: (signal: AbortSignal) => Promise<Result<T>>): Promise<Result<T>> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Result<T>>((resolve) => {
    timer = setTimeout(() => {
      resolve({ ok: false, error: { kind: 'NETWORK', message: TIMED_OUT } });
      ctl.abort();
    }, SIGN_OUT_REQUEST_TIMEOUT_MS);
  });
  try {
    return await Promise.race([run(ctl.signal), late]);
  } finally {
    clearTimeout(timer);
  }
}

type SignOutOutcome = { kind: 'ENDED' } | { kind: 'UNCONFIRMED'; problem: string } | { kind: 'ELSEWHERE' };
const ENDED: SignOutOutcome = { kind: 'ENDED' };
const ELSEWHERE: SignOutOutcome = { kind: 'ELSEWHERE' };

/**
 * Ends this browser's server session and says whether the server confirmed it. A lost or refused logout is followed
 * by GET /api/session (a fresh CSRF token, or the confirmation that no session is left) and one more logout; if the
 * session is still alive after that, it is locked so it needs credentials again, and the outcome is "not confirmed".
 * Before each request that ends or locks a session, `stillWanted` is asked: once another tab or a reload has finished
 * this sign-out, the session the browser holds may be another person's, opened since (outcome ELSEWHERE).
 */
async function endServerSession(stillWanted: () => boolean): Promise<SignOutOutcome> {
  const unconfirmed = (e: CallError): SignOutOutcome => ({ kind: 'UNCONFIRMED', problem: describe(e) });
  if (apiState.csrfToken !== undefined) {
    if (!stillWanted()) return ELSEWHERE;
    const out = await withDeadline((signal) => api.call(routes.session.logout, { body: {}, signal }));
    if (out.ok || isNoSession(out.error)) return ENDED;
  }
  const now = await withDeadline((signal) => api.call(routes.session.get, { signal }));
  if (!now.ok) return isNoSession(now.error) ? ENDED : unconfirmed(now.error);
  apiState.csrfToken = now.value.csrfToken;
  if (!stillWanted()) return ELSEWHERE;
  const again = await withDeadline((signal) => api.call(routes.session.logout, { body: {}, signal }));
  if (again.ok || isNoSession(again.error)) return ENDED;
  if (!stillWanted()) return ELSEWHERE;
  const locked = await withDeadline((signal) => api.call(routes.access.lock, { body: {}, signal }));
  if (!locked.ok && isNoSession(locked.error)) return ENDED;
  return unconfirmed(again.error);
}

async function runBoot(): Promise<BootState> {
  const empty: BootState = { phase: 'loading', meta: null, deviceKey: null, device: null, session: null, problem: null };
  apiState.installation = undefined;
  const meta = await api.call(routes.meta.get);
  if (!meta.ok) return { ...empty, phase: 'failed', problem: describe(meta.error) };
  const installation = meta.value.installation;
  apiState.installation = installation;
  anchorServerTime(meta.value.serverTime.us);
  document.documentElement.dataset['installation'] = installation.toLowerCase();
  const withMeta = { ...empty, meta: meta.value };
  if (window.location.pathname === '/demo/devices') return { ...withMeta, phase: 'no-device' };
  const deviceKey = await loadDeviceKey();
  if (!deviceKey) return { ...withMeta, phase: 'no-device' };
  const proof = await deviceProof(deviceKey, 'POST', '/api/session/identify', {});
  const device = await api.call(routes.session.identify, { body: { proof } });
  if (!device.ok) return { ...withMeta, deviceKey, phase: 'device-refused', problem: describe(device.error) };
  document.documentElement.dataset['density'] = device.value.density.toLowerCase();
  const session = await api.call(routes.session.get);
  const known = { ...withMeta, deviceKey, device: device.value };
  if (signOutPendingAtStartUp(installation)) {
    // A sign-out the server never confirmed (or a browser that could not have kept its mark): finish it first; the
    // session it concerned is never shown again.
    apiState.csrfToken = session.ok ? session.value.csrfToken : undefined;
    const outcome: SignOutOutcome = session.ok
      ? await endServerSession(() => signOutStillPending(installation))
      : isNoSession(session.error)
        ? ENDED
        : { kind: 'UNCONFIRMED', problem: describe(session.error) };
    apiState.csrfToken = undefined;
    if (outcome.kind === 'ELSEWHERE') {
      // Another tab finished it meanwhile: start again, showing what this browser holds now.
      forgetSignOut();
      return runBoot();
    }
    if (outcome.kind === 'UNCONFIRMED') return { ...known, phase: 'sign-out-unconfirmed', problem: outcome.problem };
    confirmSignedOut(installation);
    return { ...known, phase: 'signed-out' };
  }
  if (!session.ok) {
    apiState.csrfToken = undefined;
    return { ...known, phase: 'signed-out' };
  }
  apiState.csrfToken = session.value.csrfToken;
  return { ...known, session: session.value, phase: 'ready' };
}

export function BootProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<BootState>({ phase: 'loading', meta: null, deviceKey: null, device: null, session: null, problem: null });
  const [generation, setGeneration] = useState(0);
  /** The sign-out in progress in this page (one at a time: a second request joins it). */
  const signingOut = useRef<Promise<void> | null>(null);

  useEffect(() => {
    let live = true;
    const onMismatch = () => setState((s) => ({ ...s, phase: 'mismatch' }));
    apiState.onMismatch.add(onMismatch);
    runBoot()
      .then((s) => {
        if (live) setState(apiState.mismatch ? { ...s, phase: 'mismatch' } : s);
      })
      .catch((e: unknown) => {
        if (live) setState((s) => ({ ...s, phase: 'failed', problem: e instanceof Error ? e.message : String(e) }));
      });
    return () => {
      live = false;
      apiState.onMismatch.delete(onMismatch);
    };
  }, [generation]);

  const restart = useCallback(() => setGeneration((g) => g + 1), []);

  /** Runs one sign-out step at a time; the page's outcome follows the server's answer. */
  const serialized = useCallback((step: () => Promise<void>): Promise<void> => {
    if (signingOut.current) return signingOut.current;
    const run = step().finally(() => {
      signingOut.current = null;
    });
    signingOut.current = run;
    return run;
  }, []);

  const finish = useCallback(async () => {
    const installation = apiState.installation;
    const outcome = await endServerSession(() => signOutStillPending(installation)).catch(
      (e: unknown): SignOutOutcome => ({ kind: 'UNCONFIRMED', problem: e instanceof Error ? e.message : String(e) }),
    );
    apiState.csrfToken = undefined;
    if (outcome.kind === 'ENDED') {
      confirmSignedOut(installation);
      setState((s) => ({ ...s, session: null, phase: 'signed-out', problem: null }));
    } else if (outcome.kind === 'ELSEWHERE') {
      forgetSignOut();
      restart();
    } else {
      setState((s) => ({ ...s, session: null, phase: 'sign-out-unconfirmed', problem: outcome.problem }));
    }
  }, [restart]);

  const signOut = useCallback(
    () =>
      serialized(async () => {
        if (signOutPendingHere()) {
          // A retry of this page's unconfirmed sign-out.
          if (!signOutStillPending(apiState.installation)) {
            // Finished elsewhere (another tab, a reload): the session this browser holds now may be another person's.
            forgetSignOut();
            restart();
            return;
          }
        } else {
          startSignOut(apiState.installation);
          // Blocking at once: the page is not usable as the person signing out while the server is asked.
          setState((s) => ({ ...s, session: null, phase: 'signing-out', problem: null }));
        }
        await finish();
      }),
    [serialized, finish, restart],
  );

  const joinMarkedSignOut = useCallback((): boolean => {
    if (signingOut.current !== null || signOutPendingHere()) return true;
    if (!signOutMarkedElsewhere(apiState.installation)) return false;
    // The step's first part runs at once (before its first await): the page is blocked when this returns.
    void serialized(async () => {
      // Checked again: the mark may have gone meanwhile (another tab finished that sign-out).
      if (!joinSignOut(apiState.installation)) return;
      machines.announceSessionChange({ reason: 'ENDED', personId: null });
      setState((s) => ({ ...s, session: null, phase: 'signing-out', problem: null }));
      await finish();
    });
    return true;
  }, [serialized, finish]);

  const setSession = useCallback(
    (session: SessionView | null) => {
      // While a sign-out is pending here, only the server's confirmation (through the sign-out itself) moves the page
      // on: a late answer to an earlier request must neither bring the session back nor show the sign-in form. While
      // this browser keeps the mark of another tab's sign-out, no session is shown either: this page joins it.
      if (joinMarkedSignOut()) return;
      apiState.csrfToken = session?.csrfToken;
      setState((s) => ({ ...s, session, phase: session ? 'ready' : s.device ? 'signed-out' : s.phase }));
    },
    [joinMarkedSignOut],
  );

  // A page that shows a session or the sign-in form joins a sign-out marked by another tab of this browser: at once
  // when site storage tells it (a storage event) or the page becomes visible again, and otherwise at its next look at
  // the stores (a mark kept only in the cookie raises no event).
  const watching = state.phase === 'ready' || state.phase === 'signed-out';
  useEffect(() => {
    if (!watching) return;
    const look = () => {
      joinMarkedSignOut();
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === SIGN_OUT_MARK_KEY) look();
    };
    const onVisible = () => {
      if (document.visibilityState !== 'hidden') look();
    };
    look();
    const timer = setInterval(look, SIGN_OUT_MARK_CHECK_MS);
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', look);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', look);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [watching, joinMarkedSignOut]);

  // Another tab that finishes the sign-out clears the mark in site storage: this page then starts again at once
  // instead of waiting for its next retry (which would find the same).
  const unconfirmed = state.phase === 'sign-out-unconfirmed';
  useEffect(() => {
    if (!unconfirmed) return;
    const onStorage = (e: StorageEvent) => {
      if (e.key !== null && e.key !== SIGN_OUT_MARK_KEY) return;
      if (signingOut.current === null && !signOutStillPending(apiState.installation)) {
        forgetSignOut();
        restart();
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [unconfirmed, restart]);

  const forgetTerminal = useCallback(async () => {
    await forgetDeviceKey();
    setGeneration((g) => g + 1);
  }, []);

  const value = useMemo<Boot>(
    () => ({ ...state, restart, setSession, joinMarkedSignOut, signOut, forgetTerminal }),
    [state, restart, setSession, joinMarkedSignOut, signOut, forgetTerminal],
  );
  return <BootContext.Provider value={value}>{children}</BootContext.Provider>;
}
