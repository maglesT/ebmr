/**
 * The access controller of the web app (module C1; plan section 5): one place that owns
 *  - the badge-tap service behind the BadgeTapPort (requestTap over the exact request, offerSwitch);
 *  - the session control: the kiosk-lock machine, the lock overlay, the "Switch to <name>?" dialog, and a poll of
 *    GET /api/session every 15 s (the kernel locks idle sessions; the overlay follows within 15 s). Before each poll
 *    the page joins a sign-out another tab of this browser marked; an answer that arrives after the session on show
 *    changed (sign-out, switch, lock or unlock meanwhile) is dropped; an unlock seen by the poll is announced as one;
 *  - the session-change announcements C4's pending entries listen to ('ebmr:session-change').
 *
 * Secrets: badge UIDs and PINs live in Vault / KeptBadge holders only, for as long as the next step needs them (a
 * badge tapped for an entry is kept 30 s so a "Switch to <name>?" offer needs only the PIN), and are wiped when used.
 */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMachine } from '@xstate/react';
import { fromPromise } from 'xstate';
import { routes, type Attribution, type RefusalEnvelope, type SessionView } from '@ebmr/api-contract';
import { Dialog, identity, machines } from '@ebmr/ui-kit';
import { api } from '../../api/client.ts';
import { useBoot, type Boot } from '../../app/boot.tsx';
import type { TapRequest } from '../../app/ports.tsx';
import { buildAttribution, lockCall, sessionCall, switchCall, unlockWithBadge, unlockWithPassword, type CallOutcome } from './calls.ts';
import { Latest, Vault } from './holders.ts';

export const SESSION_POLL_MS = 15_000;

export interface AccessController {
  demoBadges: readonly identity.DemoBadge[];
  requestTap: (reason: string, request: TapRequest) => Promise<Attribution | null>;
  offerSwitch: (refusal: RefusalEnvelope) => Promise<boolean>;
  /** Switch to another person with badge and PIN (the ceremony's own "Switch to <name>?"). */
  switchTo: (badgeUid: string, pin: string) => Promise<CallOutcome<SessionView>>;
  lock: () => void;
  lockAndSwitch: () => void;
  checkSession: () => void;
  signOut: () => Promise<void>;
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
  offer: (refusal: RefusalEnvelope) => Promise<boolean>;
  lock: () => void;
  lockAndSwitch: () => void;
  check: () => void;
}

interface TapJob {
  request: TapRequest;
  resolve: (a: Attribution | null) => void;
}

export function AccessRoot({ children, render }: { children: ReactNode; render: (ctl: AccessController) => ReactNode }) {
  const boot = useBoot();
  const [latestBoot] = useState(() => new Latest<Boot>(boot));
  // A layout effect: what a lock, switch or poll acts on is the session the page shows from the commit that shows it.
  useLayoutEffect(() => {
    latestBoot.set(boot);
  });
  const demoBadges = useDemoBadges(boot);

  // ---- The badge-tap service --------------------------------------------------------------
  // `attempt` keys the badge prompt (one tap each); `refusal` says what happened to the previous one (F08).
  const [tapPrompt, setTapPrompt] = useState<{ reason: string; stage: 'badge' | 'pin'; attempt: number; refusal: RefusalEnvelope | null } | null>(null);
  const [tapJob] = useState(() => new Vault<TapJob>());
  const [tapUid] = useState(() => new Vault<string>());
  const [hasRemembered, setHasRemembered] = useState(false);
  const [remembered] = useState(() => new identity.KeptBadge(setHasRemembered));
  useEffect(() => () => remembered.clear(), [remembered]);

  const finishTap = useCallback(
    (a: Attribution | null) => {
      const job = tapJob.take();
      tapUid.clear();
      setTapPrompt(null);
      job?.resolve(a);
    },
    [tapJob, tapUid],
  );

  const completeTap = useCallback(
    async (uid: string, pin: string | undefined) => {
      const job = tapJob.peek();
      const key = latestBoot.get().deviceKey;
      if (!job || !key) {
        finishTap(null);
        return;
      }
      const built = await buildAttribution(key, uid, pin, job.request).catch((e: unknown) => ({ ok: false as const, failure: { kind: 'ERROR' as const, message: e instanceof Error ? e.message : String(e) } }));
      if (built.ok) {
        remembered.keep(uid);
        finishTap(built.value);
        return;
      }
      // No attribution could be made (no device proof, or the terminal key failed): nothing was sent. The prompt
      // stays, says so and takes another tap; Cancel ends it (F08: it used to close without a word).
      if (tapJob.peek() !== job) return;
      setTapPrompt((p) => (p ? { reason: p.reason, stage: 'badge', attempt: p.attempt + 1, refusal: machines.refusalOfFailure(built.failure) } : p));
    },
    [finishTap, latestBoot, remembered, tapJob],
  );

  const requestTap = useCallback(
    (reason: string, request: TapRequest): Promise<Attribution | null> => {
      const b = latestBoot.get();
      if (!b.session || !isKiosk(b.session) || !b.deviceKey) return Promise.resolve(null);
      // One prompt at a time: an earlier unanswered request is cancelled.
      tapJob.take()?.resolve(null);
      return new Promise((resolve) => {
        tapJob.put({ request, resolve });
        tapUid.clear();
        setTapPrompt({ reason, stage: 'badge', attempt: 0, refusal: null });
      });
    },
    [latestBoot, tapJob, tapUid],
  );

  // ---- Session control (mounted per signed-in person) ---------------------------------------
  const [control] = useState(() => new Latest<SessionControlHandle | null>(null));

  const ctl = useMemo<AccessController>(
    () => ({
      demoBadges,
      requestTap,
      offerSwitch: (refusal) => control.get()?.offer(refusal) ?? Promise.resolve(false),
      switchTo: async (badgeUid, pin) => {
        const key = latestBoot.get().deviceKey;
        if (!key) return { ok: false, failure: { kind: 'ERROR', message: 'this terminal has no device key' } };
        const r = await switchCall(key, badgeUid, pin);
        if (r.ok) {
          machines.announceSessionChange({ reason: 'SWITCH', personId: r.value.person.personId });
          latestBoot.get().setSession(r.value);
        }
        return r;
      },
      lock: () => control.get()?.lock(),
      lockAndSwitch: () => control.get()?.lockAndSwitch(),
      checkSession: () => control.get()?.check(),
      signOut: async () => {
        machines.announceSessionChange({ reason: 'ENDED', personId: null });
        await latestBoot.get().signOut();
      },
    }),
    [demoBadges, requestTap, control, latestBoot],
  );

  const session = boot.phase === 'ready' ? boot.session : null;
  return (
    <AccessContext.Provider value={ctl}>
      {children}
      {session ? (
        <SessionControl
          key={session.person.personId}
          control={control}
          session={session}
          kiosk={isKiosk(session)}
          demoBadges={demoBadges}
          remembered={remembered}
          hasRemembered={hasRemembered}
        />
      ) : null}
      {tapPrompt ? (
        <Dialog title="Confirm it is you" isOpen isDismissable={false}>
          {tapPrompt.stage === 'badge' ? (
            <identity.BadgePrompt
              key={tapPrompt.attempt}
              reason={tapPrompt.reason}
              refusal={tapPrompt.refusal}
              demoBadges={demoBadges}
              onTap={(uid) => {
                if (session?.attribution === 'TAP_PIN') {
                  tapUid.put(uid);
                  setTapPrompt({ ...tapPrompt, stage: 'pin' });
                } else {
                  void completeTap(uid, undefined);
                }
              }}
              onCancel={() => finishTap(null)}
            />
          ) : (
            <identity.PinPad
              label="Enter your PIN to confirm"
              onSubmit={(pin) => {
                const uid = tapUid.take();
                if (uid) void completeTap(uid, pin);
                else finishTap(null);
              }}
            />
          )}
        </Dialog>
      ) : null}
      {render(ctl)}
    </AccessContext.Provider>
  );
}

type Secret = { kind: 'badge'; badgeUid: string; pin: string } | { kind: 'password'; loginName: string; password: string };

const offerOf = (refusal: RefusalEnvelope): machines.SwitchOffer => ({
  legalName: refusal.refusal.details?.['switchToLegalName'] ?? 'another person',
  loginName: refusal.refusal.details?.['switchToLoginName'] ?? '',
});

function SessionControl(props: {
  control: Latest<SessionControlHandle | null>;
  session: SessionView;
  kiosk: boolean;
  demoBadges: readonly identity.DemoBadge[];
  remembered: identity.KeptBadge;
  hasRemembered: boolean;
}) {
  const { control, session, kiosk, demoBadges, remembered, hasRemembered } = props;
  const boot = useBoot();
  const [latestBoot] = useState(() => new Latest<Boot>(boot));
  // A layout effect: what a lock, switch or poll acts on is the session the page shows from the commit that shows it.
  useLayoutEffect(() => {
    latestBoot.set(boot);
  });
  const [secret] = useState(() => new Vault<Secret>());
  const [offerBadge] = useState(() => new Vault<string>());
  const [offerResolve] = useState(() => new Vault<(ok: boolean) => void>());
  const [offerBadgeTapped, setOfferBadgeTapped] = useState(false);
  const [switchFirst, setSwitchFirst] = useState(false);

  const [machine] = useState(() =>
    machines.kioskLockMachine.provide({
      actors: {
        lockSession: fromPromise(async () => {
          const r = await lockCall();
          if (!r.ok) throw machines.ceremonyError(r.failure);
          machines.announceSessionChange({ reason: 'LOCK', personId: r.value.person.personId });
          latestBoot.get().setSession(r.value);
          return r.value;
        }),
        unlockSession: fromPromise(async () => {
          const s = secret.take();
          const key = latestBoot.get().deviceKey;
          if (!s || !key) throw machines.ceremonyError({ kind: 'ERROR', message: 'nothing to unlock with' });
          const r = s.kind === 'badge' ? await unlockWithBadge(key, s.badgeUid, s.pin) : await unlockWithPassword(key, s.loginName, s.password);
          if (!r.ok) throw machines.ceremonyError(r.failure);
          machines.announceSessionChange({ reason: 'UNLOCK', personId: r.value.person.personId });
          latestBoot.get().setSession(r.value);
          return r.value;
        }),
        switchUser: fromPromise(async () => {
          const s = secret.take();
          const key = latestBoot.get().deviceKey;
          if (!s || s.kind !== 'badge' || !key) throw machines.ceremonyError({ kind: 'ERROR', message: 'nothing to switch with' });
          const r = await switchCall(key, s.badgeUid, s.pin);
          if (!r.ok) throw machines.ceremonyError(r.failure);
          offerResolve.take()?.(true);
          machines.announceSessionChange({ reason: 'SWITCH', personId: r.value.person.personId });
          latestBoot.get().setSession(r.value);
          return r.value;
        }),
      },
    }),
  );
  const [snap, send] = useMachine(machine, { input: { locked: session.locked } });
  const state = snap.value as string;
  const [latestState] = useState(() => new Latest<string>(state));
  useLayoutEffect(() => {
    latestState.set(state);
  });

  useEffect(() => {
    if (state !== 'ended') return;
    offerResolve.take()?.(false);
    machines.announceSessionChange({ reason: 'ENDED', personId: null });
    latestBoot.get().setSession(null);
  }, [state, offerResolve, latestBoot]);

  // Whether this control is still mounted: an answer that arrives after it is gone (a sign-out, a switch to another
  // person) is not about the session on show any more.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The kernel decides: poll the session so an idle lock, an end or a lock elsewhere shows here.
  const check = useCallback(() => {
    const asked = latestBoot.get();
    // Before each poll: a sign-out that another tab of this browser marked is joined (the page blocks), never polled
    // past (DI-38, DI-14; review P5).
    if (asked.joinMarkedSignOut()) return;
    const polled = asked.session;
    void sessionCall().then((r) => {
      const b = latestBoot.get();
      // An answer about another state of the session than the one on show when it was asked (a sign-out, a switch, a
      // lock or unlock meanwhile) is dropped: the next poll asks again.
      if (!mounted.current || b.phase !== 'ready' || b.session !== polled || b.joinMarkedSignOut()) return;
      if (r.ok) {
        const now = latestState.get();
        if (r.value.person.personId !== polled?.person.personId) {
          b.setSession(r.value);
          return;
        }
        if (r.value.locked && (now === 'active' || now === 'offering')) {
          machines.announceSessionChange({ reason: 'LOCK', personId: r.value.person.personId });
          b.setSession(r.value);
          send({ type: 'SERVER_LOCKED' });
        } else if (!r.value.locked && now === 'locked') {
          // Unlocked elsewhere (another tab): a session change like any unlock, so the floor reads again (DI-28).
          machines.announceSessionChange({ reason: 'UNLOCK', personId: r.value.person.personId });
          b.setSession(r.value);
          send({ type: 'SERVER_ACTIVE' });
        }
      } else if (r.failure.kind === 'REFUSAL' && r.failure.status === 401) {
        send({ type: 'ENDED' });
      }
    });
  }, [send, latestState, latestBoot]);

  useEffect(() => {
    const id = setInterval(check, SESSION_POLL_MS);
    return () => clearInterval(id);
  }, [check]);

  // Registered in a layout effect, so lock, switch and check work the moment the page shows the session. In a passive
  // effect, which runs later, a lock asked for in between (a screen's own effect, an observer of the page) did
  // nothing: control.get() was still null.
  useLayoutEffect(() => {
    control.set({
      offer: (refusal) => {
        offerResolve.take()?.(false);
        offerBadge.clear();
        return new Promise<boolean>((resolve) => {
          offerResolve.put(resolve);
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
    });
    return () => {
      control.set(null);
      offerResolve.take()?.(false);
    };
  }, [control, send, check, offerBadge, offerResolve]);

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
          secret.put({ kind: 'badge', badgeUid, pin });
          send({ type: 'UNLOCK' });
        }}
        onUnlockPassword={(loginName, password) => {
          secret.put({ kind: 'password', loginName, password });
          send({ type: 'UNLOCK' });
        }}
        onSwitch={(badgeUid, pin) => {
          secret.put({ kind: 'badge', badgeUid, pin });
          send({ type: 'SWITCH' });
        }}
        onSignOut={() => {
          machines.announceSessionChange({ reason: 'ENDED', personId: null });
          void latestBoot.get().signOut();
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
            offerBadge.put(uid);
            setOfferBadgeTapped(true);
          }}
          onPin={(pin) => {
            const uid = offerBadge.take() ?? remembered.take();
            remembered.clear();
            setOfferBadgeTapped(false);
            if (!uid) return;
            secret.put({ kind: 'badge', badgeUid: uid, pin });
            send({ type: 'SWITCH' });
          }}
          onCancel={() => {
            offerBadge.clear();
            setOfferBadgeTapped(false);
            remembered.clear();
            offerResolve.take()?.(false);
            send({ type: 'DISMISS' });
          }}
        />
      ) : null}
    </>
  );
}
