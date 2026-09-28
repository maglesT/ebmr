/**
 * The access controller of the web app (module C1; plan section 5): one place that owns
 *  - the badge-tap service behind the BadgeTapPort (requestTap over the exact request, offerSwitch);
 *  - the session control: the kiosk-lock machine, the lock overlay, the "Switch to <name>?" dialog, and a poll of
 *    GET /api/session every 15 s (the kernel locks idle sessions; the overlay follows within 15 s);
 *  - the session-change announcements C4's pending entries listen to ('ebmr:session-change').
 *
 * Secrets: badge UIDs and PINs live in refs only, for as long as the next step needs them (a badge tapped for an
 * entry is kept 30 s so a "Switch to <name>?" offer needs only the PIN), and are wiped when used.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useMachine } from '@xstate/react';
import { fromPromise } from 'xstate';
import { routes, type Attribution, type RefusalEnvelope, type SessionView } from '@ebmr/api-contract';
import { Dialog, identity, machines } from '@ebmr/ui-kit';
import { api } from '../../api/client.ts';
import { useBoot, type Boot } from '../../app/boot.tsx';
import type { TapRequest } from '../../app/ports.tsx';
import { buildAttribution, lockCall, sessionCall, switchCall, unlockWithBadge, unlockWithPassword, type CallOutcome } from './calls.ts';

export const KEEP_TAP_MS = 30_000;
export const SESSION_POLL_MS = 15_000;

export interface AccessController {
  demoBadges: readonly identity.DemoBadge[];
  requestTap(reason: string, request: TapRequest): Promise<Attribution | null>;
  offerSwitch(refusal: RefusalEnvelope): Promise<boolean>;
  /** Switch to another person with badge and PIN (the ceremony's own "Switch to <name>?"). */
  switchTo(badgeUid: string, pin: string): Promise<CallOutcome<SessionView>>;
  lock(): void;
  lockAndSwitch(): void;
  checkSession(): void;
  signOut(): Promise<void>;
}

const AccessContext = createContext<AccessController | null>(null);

export function useAccess(): AccessController {
  const a = useContext(AccessContext);
  if (!a) throw new Error('useAccess outside the access Provider');
  return a;
}

export const isKiosk = (s: SessionView | null | undefined): boolean => s?.device.deviceClass === 'SHARED' || s?.device.deviceClass === 'GRADE_A_B';

/** DEMO-ONLY badges of this terminal (demo installations only), for the demo badge reader. */
function useDemoBadges(boot: Boot): readonly identity.DemoBadge[] {
  const [badges, setBadges] = useState<readonly identity.DemoBadge[]>([]);
  const demo = boot.meta?.demo === true;
  const code = boot.device?.deviceCode;
  useEffect(() => {
    if (!demo || !code) return;
    let live = true;
    void api.call(routes.session.demoDevices).then((r) => {
      if (!live || !r.ok) return;
      const device = r.value.devices.find((d) => d.deviceCode === code);
      setBadges((device?.personas ?? []).flatMap((p) => (p.badgeUid ? [{ legalName: p.legalName, badgeUid: p.badgeUid }] : [])));
    });
    return () => {
      live = false;
    };
  }, [demo, code]);
  return badges;
}

interface SessionControlHandle {
  offer(refusal: RefusalEnvelope): Promise<boolean>;
  lock(): void;
  lockAndSwitch(): void;
  check(): void;
}

interface TapJob {
  request: TapRequest;
  resolve: (a: Attribution | null) => void;
}

export function AccessRoot({ children, render }: { children: ReactNode; render: (ctl: AccessController) => ReactNode }) {
  const boot = useBoot();
  const bootRef = useRef(boot);
  useEffect(() => {
    bootRef.current = boot;
  });
  const demoBadges = useDemoBadges(boot);

  // ---- The badge-tap service --------------------------------------------------------------
  const [tapPrompt, setTapPrompt] = useState<{ reason: string; stage: 'badge' | 'pin' } | null>(null);
  const tapJob = useRef<TapJob | null>(null);
  const tapUid = useRef<string | null>(null);
  const remembered = useRef<string | null>(null);
  const rememberTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hasRemembered, setHasRemembered] = useState(false);

  const forgetRemembered = useCallback(() => {
    remembered.current = null;
    if (rememberTimer.current) clearTimeout(rememberTimer.current);
    rememberTimer.current = null;
    setHasRemembered(false);
  }, []);
  const remember = useCallback(
    (uid: string) => {
      forgetRemembered();
      remembered.current = uid;
      setHasRemembered(true);
      rememberTimer.current = setTimeout(forgetRemembered, KEEP_TAP_MS);
    },
    [forgetRemembered],
  );
  useEffect(() => forgetRemembered, [forgetRemembered]);

  const finishTap = useCallback((a: Attribution | null) => {
    const job = tapJob.current;
    tapJob.current = null;
    tapUid.current = null;
    setTapPrompt(null);
    job?.resolve(a);
  }, []);

  const completeTap = useCallback(
    async (uid: string, pin: string | undefined) => {
      const job = tapJob.current;
      const key = bootRef.current.deviceKey;
      if (!job || !key) {
        finishTap(null);
        return;
      }
      try {
        const attribution = await buildAttribution(key, uid, pin, job.request);
        remember(uid);
        finishTap(attribution);
      } catch {
        finishTap(null);
      }
    },
    [finishTap, remember],
  );

  const requestTap = useCallback((reason: string, request: TapRequest): Promise<Attribution | null> => {
    const s = bootRef.current.session;
    if (!s || !isKiosk(s) || !bootRef.current.deviceKey) return Promise.resolve(null);
    // One prompt at a time: an earlier unanswered request is cancelled.
    tapJob.current?.resolve(null);
    return new Promise((resolve) => {
      tapJob.current = { request, resolve };
      tapUid.current = null;
      setTapPrompt({ reason, stage: 'badge' });
    });
  }, []);

  // ---- Session control (mounted per signed-in person) ---------------------------------------
  const control = useRef<SessionControlHandle | null>(null);

  const ctl = useMemo<AccessController>(
    () => ({
      demoBadges,
      requestTap,
      offerSwitch: (refusal) => control.current?.offer(refusal) ?? Promise.resolve(false),
      switchTo: async (badgeUid, pin) => {
        const key = bootRef.current.deviceKey;
        if (!key) return { ok: false, failure: { kind: 'ERROR', message: 'this terminal has no device key' } };
        const r = await switchCall(key, badgeUid, pin);
        if (r.ok) {
          machines.announceSessionChange({ reason: 'SWITCH', personId: r.value.person.personId });
          bootRef.current.setSession(r.value);
        }
        return r;
      },
      lock: () => control.current?.lock(),
      lockAndSwitch: () => control.current?.lockAndSwitch(),
      checkSession: () => control.current?.check(),
      signOut: async () => {
        machines.announceSessionChange({ reason: 'ENDED', personId: null });
        await bootRef.current.signOut();
      },
    }),
    [demoBadges, requestTap],
  );

  const session = boot.phase === 'ready' ? boot.session : null;
  const kiosk = isKiosk(session);
  return (
    <AccessContext.Provider value={ctl}>
      {children}
      {session ? (
        <SessionControl
          key={session.person.personId}
          handle={control}
          session={session}
          kiosk={kiosk}
          demoBadges={demoBadges}
          remembered={remembered}
          hasRemembered={hasRemembered}
          forgetRemembered={forgetRemembered}
        />
      ) : null}
      {tapPrompt ? (
        <Dialog title="Confirm it is you" isOpen isDismissable={false}>
          {tapPrompt.stage === 'badge' ? (
            <identity.BadgePrompt
              reason={tapPrompt.reason}
              demoBadges={demoBadges}
              onTap={(uid) => {
                if (session?.attribution === 'TAP_PIN') {
                  tapUid.current = uid;
                  setTapPrompt({ reason: tapPrompt.reason, stage: 'pin' });
                } else {
                  void completeTap(uid, undefined);
                }
              }}
              onCancel={() => finishTap(null)}
            />
          ) : (
            <>
              <identity.PinPad
                label="Enter your PIN to confirm"
                onSubmit={(pin) => {
                  const uid = tapUid.current;
                  tapUid.current = null;
                  if (uid) void completeTap(uid, pin);
                  else finishTap(null);
                }}
              />
            </>
          )}
        </Dialog>
      ) : null}
      {render(ctl)}
    </AccessContext.Provider>
  );
}

type Secret = { kind: 'badge'; badgeUid: string; pin: string } | { kind: 'password'; loginName: string; password: string };

function take<T>(ref: RefObject<T | null>): T | null {
  const v = ref.current;
  ref.current = null;
  return v;
}

const offerOf = (refusal: RefusalEnvelope): machines.SwitchOffer => ({
  legalName: refusal.refusal.details?.['switchToLegalName'] ?? 'another person',
  loginName: refusal.refusal.details?.['switchToLoginName'] ?? '',
});

function SessionControl(props: {
  handle: RefObject<SessionControlHandle | null>;
  session: SessionView;
  kiosk: boolean;
  demoBadges: readonly identity.DemoBadge[];
  remembered: RefObject<string | null>;
  hasRemembered: boolean;
  forgetRemembered: () => void;
}) {
  const { handle, session, kiosk, demoBadges, remembered, hasRemembered, forgetRemembered } = props;
  const boot = useBoot();
  const bootRef = useRef(boot);
  useEffect(() => {
    bootRef.current = boot;
  });
  const secret = useRef<Secret | null>(null);
  const offerBadge = useRef<string | null>(null);
  const [offerBadgeTapped, setOfferBadgeTapped] = useState(false);
  const offerResolve = useRef<((ok: boolean) => void) | null>(null);
  const [switchFirst, setSwitchFirst] = useState(false);

  const machine = useMemo(
    () =>
      machines.kioskLockMachine.provide({
        actors: {
          lockSession: fromPromise(async () => {
            const r = await lockCall();
            if (!r.ok) throw r.failure;
            machines.announceSessionChange({ reason: 'LOCK', personId: r.value.person.personId });
            bootRef.current.setSession(r.value);
            return r.value;
          }),
          unlockSession: fromPromise(async () => {
            const s = take(secret);
            const key = bootRef.current.deviceKey;
            if (!s || !key) throw { kind: 'ERROR', message: 'nothing to unlock with' } satisfies machines.CeremonyFailure;
            const r = s.kind === 'badge' ? await unlockWithBadge(key, s.badgeUid, s.pin) : await unlockWithPassword(key, s.loginName, s.password);
            if (!r.ok) throw r.failure;
            machines.announceSessionChange({ reason: 'UNLOCK', personId: r.value.person.personId });
            bootRef.current.setSession(r.value);
            return r.value;
          }),
          switchUser: fromPromise(async () => {
            const s = take(secret);
            const key = bootRef.current.deviceKey;
            if (!s || s.kind !== 'badge' || !key) throw { kind: 'ERROR', message: 'nothing to switch with' } satisfies machines.CeremonyFailure;
            const r = await switchCall(key, s.badgeUid, s.pin);
            if (!r.ok) throw r.failure;
            take(offerResolve)?.(true);
            machines.announceSessionChange({ reason: 'SWITCH', personId: r.value.person.personId });
            bootRef.current.setSession(r.value);
            return r.value;
          }),
        },
      }),
    [],
  );
  const [snap, send] = useMachine(machine, { input: { locked: session.locked } });
  const state = snap.value as string;
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });

  const ended = useCallback(() => {
    take(offerResolve)?.(false);
    machines.announceSessionChange({ reason: 'ENDED', personId: null });
    bootRef.current.setSession(null);
  }, []);

  useEffect(() => {
    if (state === 'ended') ended();
  }, [state, ended]);

  // The kernel decides: poll the session so an idle lock, an end or a lock elsewhere shows here.
  const check = useCallback(() => {
    void sessionCall().then((r) => {
      if (r.ok) {
        const now = stateRef.current;
        if (r.value.person.personId !== bootRef.current.session?.person.personId) {
          bootRef.current.setSession(r.value);
          return;
        }
        if (r.value.locked && (now === 'active' || now === 'offering')) {
          machines.announceSessionChange({ reason: 'LOCK', personId: r.value.person.personId });
          send({ type: 'SERVER_LOCKED' });
        } else if (!r.value.locked && now === 'locked') send({ type: 'SERVER_ACTIVE' });
      } else if (r.failure.kind === 'REFUSAL' && r.failure.status === 401) {
        send({ type: 'ENDED' });
      }
    });
  }, [send]);

  useEffect(() => {
    const id = setInterval(check, SESSION_POLL_MS);
    return () => clearInterval(id);
  }, [check]);

  useEffect(() => {
    handle.current = {
      offer: (refusal) => {
        take(offerResolve)?.(false);
        offerBadge.current = null;
        setOfferBadgeTapped(false);
        return new Promise<boolean>((resolve) => {
          offerResolve.current = resolve;
          send({ type: 'OFFER_SWITCH', offer: offerOf(refusal) });
        });
      },
      lock: () => {
        setSwitchFirst(false);
        send({ type: 'LOCK' });
      },
      lockAndSwitch: () => {
        setSwitchFirst(true);
        send({ type: 'LOCK' });
      },
      check,
    };
    return () => {
      handle.current = null;
      take(offerResolve)?.(false);
    };
  }, [handle, send, check]);

  const lockOpen = state === 'locked' || state === 'unlocking' || state === 'locking' || (state === 'switching' && snap.context.wasLocked && !snap.context.fromOffer);
  const offerOpen = state === 'offering' || (state === 'switching' && snap.context.fromOffer);
  const offer = snap.context.offer;

  return (
    <>
      <identity.LockOverlay
        isOpen={lockOpen}
        legalName={session.person.legalName}
        loginName={session.person.loginName}
        kiosk={kiosk}
        busy={state === 'unlocking' || state === 'switching' || state === 'locking'}
        error={snap.context.error}
        offer={state === 'locked' || state === 'unlocking' ? offer : null}
        switchFirst={switchFirst}
        demoBadges={demoBadges}
        onUnlockBadge={(badgeUid, pin) => {
          secret.current = { kind: 'badge', badgeUid, pin };
          send({ type: 'UNLOCK' });
        }}
        onUnlockPassword={(loginName, password) => {
          secret.current = { kind: 'password', loginName, password };
          send({ type: 'UNLOCK' });
        }}
        onSwitch={(badgeUid, pin) => {
          secret.current = { kind: 'badge', badgeUid, pin };
          send({ type: 'SWITCH' });
        }}
        onSignOut={() => {
          machines.announceSessionChange({ reason: 'ENDED', personId: null });
          void bootRef.current.signOut();
        }}
      />
      {offer && offerOpen ? (
        <identity.SwitchUserDialog
          isOpen
          offer={offer}
          needsTap={!hasRemembered && !offerBadgeTapped}
          busy={state === 'switching'}
          error={snap.context.error}
          demoBadges={demoBadges}
          onTap={(uid) => {
            offerBadge.current = uid;
            setOfferBadgeTapped(true);
          }}
          onPin={(pin) => {
            const uid = take(offerBadge) ?? take(remembered);
            forgetRemembered();
            setOfferBadgeTapped(false);
            if (!uid) return;
            secret.current = { kind: 'badge', badgeUid: uid, pin };
            send({ type: 'SWITCH' });
          }}
          onCancel={() => {
            offerBadge.current = null;
            setOfferBadgeTapped(false);
            forgetRemembered();
            take(offerResolve)?.(false);
            send({ type: 'DISMISS' });
          }}
        />
      ) : null}
    </>
  );
}
