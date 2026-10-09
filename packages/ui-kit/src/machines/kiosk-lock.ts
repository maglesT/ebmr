/**
 * Kiosk and office session lock (module C1; plan section 5, "Lock, unlock, keep-alive and switch"; DI-14, DI-38).
 *
 *   active -> locking -> locked -> unlocking -> active
 *   active | locked -> switching -> active (another person's session, new cookie) | back where it was
 *   any -> ended (the kernel ended the session: lockout, logout elsewhere, absolute timeout)
 *
 * The kernel is authoritative: it locks a session after the idle time of its terminal class; the host polls the
 * session and sends SERVER_LOCKED / SERVER_ACTIVE / ENDED. As in the ceremony, secrets never enter the machine:
 * UNLOCK and SWITCH carry no payload; the host's actors read the badge, PIN or password from refs and wipe them.
 * A 409 SWITCH_USER answer to an unlock (another person's badge at the lock screen) becomes a switch offer.
 *
 * Every change of the session's person or lock state is a session change: the step screen discards any unsent
 * entry (C4 listens for the host's 'ebmr:session-change' event).
 */
import { assign, fromPromise, setup } from 'xstate';
import type { RefusalEnvelope, SessionView } from '@ebmr/api-contract';
import { refusalOfFailure } from './ceremony.ts';

export interface SwitchOffer {
  legalName: string;
  loginName: string;
}

export interface KioskLockContext {
  error: RefusalEnvelope | null;
  offer: SwitchOffer | null;
  /** Whether the session was locked at start or when the switch started (a failed switch returns there). */
  wasLocked: boolean;
  /** A switch started from a "Switch to <name>?" offer (a failed switch returns to the offer). */
  fromOffer: boolean;
}

export type KioskLockEvent =
  | { type: 'LOCK' }
  | { type: 'UNLOCK' }
  | { type: 'SWITCH' }
  | { type: 'OFFER_SWITCH'; offer: SwitchOffer }
  | { type: 'DISMISS' }
  | { type: 'SERVER_LOCKED' }
  | { type: 'SERVER_ACTIVE' }
  | { type: 'ENDED' };

export const SESSION_CHANGE_EVENT = 'ebmr:session-change';

export type SessionChangeReason = 'SWITCH' | 'LOCK' | 'UNLOCK' | 'ENDED';

export interface SessionChangeDetail {
  reason: SessionChangeReason;
  /** The person now signed in (null when the session ended). */
  personId: string | null;
}

/** Announces a session change to the page (C4's pending entries listen and discard unsent work). */
export function announceSessionChange(detail: SessionChangeDetail, target: EventTarget | undefined = globalThis): void {
  if (!target || typeof (target as { dispatchEvent?: unknown }).dispatchEvent !== 'function') return;
  target.dispatchEvent(new CustomEvent<SessionChangeDetail>(SESSION_CHANGE_EVENT, { detail }));
}

/** Subscribes to session changes; returns the unsubscribe function. */
export function onSessionChange(listener: (detail: SessionChangeDetail) => void, target: EventTarget | undefined = globalThis): () => void {
  if (!target || typeof (target as { addEventListener?: unknown }).addEventListener !== 'function') return () => undefined;
  const handler = (e: Event) => listener((e as CustomEvent<SessionChangeDetail>).detail);
  target.addEventListener(SESSION_CHANGE_EVENT, handler);
  return () => target.removeEventListener(SESSION_CHANGE_EVENT, handler);
}

const kindOf = (e: unknown): string | null => {
  const r = refusalOfFailure(e);
  return r.refusal.kind;
};

const offerOf = (e: unknown): SwitchOffer | null => {
  const r = refusalOfFailure(e).refusal;
  if (r.kind !== 'SWITCH_USER') return null;
  return { legalName: r.details?.['switchToLegalName'] ?? 'another person', loginName: r.details?.['switchToLoginName'] ?? '' };
};

export const kioskLockMachine = setup({
  types: {
    context: {} as KioskLockContext,
    events: {} as KioskLockEvent,
    input: {} as { locked: boolean },
  },
  actors: {
    lockSession: fromPromise<SessionView>(() => Promise.reject(new Error('lockSession is provided by the host'))),
    unlockSession: fromPromise<SessionView>(() => Promise.reject(new Error('unlockSession is provided by the host'))),
    switchUser: fromPromise<SessionView>(() => Promise.reject(new Error('switchUser is provided by the host'))),
  },
  guards: {
    ended: (_, params: { error: unknown }) => {
      const r = refusalOfFailure(params.error).refusal;
      return r.code === 'NO_SESSION' || r.code === 'AUTH_LOCKED';
    },
    switchUser: (_, params: { error: unknown }) => kindOf(params.error) === 'SWITCH_USER',
    wasLocked: ({ context }) => context.wasLocked,
    fromOffer: ({ context }) => context.fromOffer,
  },
}).createMachine({
  id: 'kioskLock',
  initial: 'starting',
  context: ({ input }) => ({ error: null, offer: null, wasLocked: input.locked, fromOffer: false }),
  states: {
    starting: {
      always: [{ guard: 'wasLocked', target: 'locked' }, { target: 'active' }],
    },
    active: {
      entry: assign({ offer: null }),
      on: {
        LOCK: 'locking',
        SERVER_LOCKED: 'locked',
        SWITCH: { target: 'switching', actions: assign({ wasLocked: false, fromOffer: false }) },
        OFFER_SWITCH: { target: 'offering', actions: assign({ offer: ({ event }) => event.offer, error: null }) },
        ENDED: 'ended',
      },
    },
    /** "Switch to <name>?" after a tap by another person (the badge is kept by the host for 30 s). */
    offering: {
      on: {
        SWITCH: { target: 'switching', actions: assign({ wasLocked: false, fromOffer: true, error: null }) },
        DISMISS: 'active',
        SERVER_LOCKED: 'locked',
        ENDED: 'ended',
      },
    },
    locking: {
      invoke: {
        src: 'lockSession',
        onDone: { target: 'locked', actions: assign({ wasLocked: true }) },
        onError: [
          { guard: { type: 'ended', params: ({ event }) => ({ error: event.error }) }, target: 'ended' },
          { target: 'active', actions: assign({ error: ({ event }) => refusalOfFailure(event.error) }) },
        ],
      },
    },
    locked: {
      on: {
        UNLOCK: { target: 'unlocking', actions: assign({ error: null }) },
        SWITCH: { target: 'switching', actions: assign({ wasLocked: true, fromOffer: false, error: null }) },
        OFFER_SWITCH: { actions: assign({ offer: ({ event }) => event.offer }) },
        SERVER_ACTIVE: 'active',
        ENDED: 'ended',
      },
    },
    unlocking: {
      invoke: {
        src: 'unlockSession',
        onDone: { target: 'active', actions: assign({ error: null }) },
        onError: [
          { guard: { type: 'ended', params: ({ event }) => ({ error: event.error }) }, target: 'ended', actions: assign({ error: ({ event }) => refusalOfFailure(event.error) }) },
          { guard: { type: 'switchUser', params: ({ event }) => ({ error: event.error }) }, target: 'locked', actions: assign({ offer: ({ event }) => offerOf(event.error), error: ({ event }) => refusalOfFailure(event.error) }) },
          { target: 'locked', actions: assign({ error: ({ event }) => refusalOfFailure(event.error) }) },
        ],
      },
    },
    switching: {
      invoke: {
        src: 'switchUser',
        onDone: { target: 'active', actions: assign({ error: null, offer: null, wasLocked: false, fromOffer: false }) },
        onError: [
          { guard: { type: 'ended', params: ({ event }) => ({ error: event.error }) }, target: 'ended', actions: assign({ error: ({ event }) => refusalOfFailure(event.error) }) },
          { guard: 'fromOffer', target: 'offering', actions: assign({ error: ({ event }) => refusalOfFailure(event.error) }) },
          { guard: 'wasLocked', target: 'locked', actions: assign({ error: ({ event }) => refusalOfFailure(event.error) }) },
          { target: 'active', actions: assign({ error: ({ event }) => refusalOfFailure(event.error) }) },
        ],
      },
    },
    ended: { type: 'final' },
  },
});
