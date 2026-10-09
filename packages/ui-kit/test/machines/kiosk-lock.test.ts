/**
 * The kiosk-lock machine (module C1; plan section 5; DI-14, DI-38): lock, unlock by the session's own person, a
 * switch offer when another person taps at the lock screen, switches from the lock screen and from an offer, and
 * the end of the session. Explored with @xstate/graph over the actors' done and error events.
 */
import { describe, expect, it, vi } from 'vitest';
import { transition, type AnyEventObject } from 'xstate';
import { getShortestPaths } from '@xstate/graph';
import type { RefusalEnvelope, SessionView } from '@ebmr/api-contract';
import { announceSessionChange, kioskLockMachine, onSessionChange, SESSION_CHANGE_EVENT, type KioskLockEvent } from '../../src/machines/kiosk-lock.ts';
import type { CeremonyFailure } from '../../src/machines/ceremony.ts';

const env = (code: string, kind: RefusalEnvelope['refusal']['kind'], details?: Record<string, string>): RefusalEnvelope => ({
  refusal: { code, kind, whatHappened: code, why: '', controls: [], whatYouCanDo: [], whoCanHelp: [], ...(details ? { details } : {}) },
  correlationId: 't',
  retryable: false,
});
const refused = (status: number, code: string, kind: RefusalEnvelope['refusal']['kind'], details?: Record<string, string>): CeremonyFailure => ({ kind: 'REFUSAL', status, envelope: env(code, kind, details) });
const SESSION = {} as SessionView;
const done = (id: string): AnyEventObject => ({ type: `xstate.done.actor.${id}`, output: SESSION });
const fail = (id: string, error: unknown): AnyEventObject => ({ type: `xstate.error.actor.${id}`, error });
const OFFER = { legalName: 'TEST-Kavya Reddy', loginName: 'test-verifier-1' };

// Invoke ids are generated from the state path when not named; resolve them from the machine.
const idOf = (state: string): string => {
  const node = kioskLockMachine.getStateNodeById(`kioskLock.${state}`);
  const inv = node.invoke[0];
  if (!inv) throw new Error(`no invoke in ${state}`);
  return inv.id;
};

const EVENTS = [
  { type: 'LOCK' },
  { type: 'UNLOCK' },
  { type: 'SWITCH' },
  { type: 'OFFER_SWITCH', offer: OFFER },
  { type: 'DISMISS' },
  { type: 'SERVER_LOCKED' },
  { type: 'SERVER_ACTIVE' },
  { type: 'ENDED' },
  done(idOf('locking')),
  done(idOf('unlocking')),
  done(idOf('switching')),
  fail(idOf('unlocking'), refused(401, 'EBMR-IAM-140', 'AUTH_FAILED')),
  fail(idOf('unlocking'), refused(409, 'SWITCH_USER', 'SWITCH_USER', { switchToLegalName: OFFER.legalName, switchToLoginName: OFFER.loginName })),
  fail(idOf('unlocking'), refused(423, 'AUTH_LOCKED', 'LOCKED')),
  fail(idOf('switching'), refused(401, 'EBMR-IAM-140', 'AUTH_FAILED')),
  fail(idOf('locking'), refused(401, 'NO_SESSION', 'NOT_ALLOWED')),
] as unknown as KioskLockEvent[];

const paths = (target: (s: { value: unknown; context: Record<string, unknown> }) => boolean, locked = false) =>
  getShortestPaths(kioskLockMachine, { input: { locked }, events: EVENTS, serializeState: (s) => JSON.stringify([s.value, s.context]), toState: target as never });
const types = (p: { steps: { event: AnyEventObject }[] } | undefined) => (p?.steps ?? []).map((s) => s.event.type.replace(/^xstate\.(done|error)\.actor\..*$/, (m) => (m.includes('.done.') ? 'done' : 'error')));

describe('kiosk-lock machine', () => {
  it('[DI-38][DI-14] a locked session opens only through the unlock or a switch; another person\'s badge at the lock becomes a switch offer', () => {
    expect(types(paths((s) => s.value === 'active', true)[0])).not.toEqual(['xstate.init']);
    const fromLock = getShortestPaths(kioskLockMachine, { input: { locked: true }, events: EVENTS, serializeState: (s) => JSON.stringify(s.value), toState: (s) => s.value === 'active' });
    expect(fromLock.every((p) => types(p).some((t) => t === 'done' || t === 'SERVER_ACTIVE'))).toBe(true);
    const start = kioskLockMachine.resolveState({ value: 'locked', context: { error: null, offer: null, wasLocked: true, fromOffer: false } });
    const [unlocking] = transition(kioskLockMachine, start, { type: 'UNLOCK' });
    const [offered] = transition(kioskLockMachine, unlocking, fail(idOf('unlocking'), refused(409, 'SWITCH_USER', 'SWITCH_USER', { switchToLegalName: OFFER.legalName, switchToLoginName: OFFER.loginName })) as never);
    expect(offered.value).toBe('locked');
    expect(offered.context.offer).toEqual(OFFER);
    const [switching] = transition(kioskLockMachine, offered, { type: 'SWITCH' });
    const [back] = transition(kioskLockMachine, switching, fail(idOf('switching'), refused(401, 'EBMR-IAM-140', 'AUTH_FAILED')) as never);
    expect(back.value).toBe('locked');
    const [ok] = transition(kioskLockMachine, switching, done(idOf('switching')) as never);
    expect(ok.value).toBe('active');
  });

  it('[DI-19] a lockout at the unlock ends the session', () => {
    const start = kioskLockMachine.resolveState({ value: 'locked', context: { error: null, offer: null, wasLocked: true, fromOffer: false } });
    const [unlocking] = transition(kioskLockMachine, start, { type: 'UNLOCK' });
    const [ended] = transition(kioskLockMachine, unlocking, fail(idOf('unlocking'), refused(423, 'AUTH_LOCKED', 'LOCKED')) as never);
    expect(ended.value).toBe('ended');
    expect(paths((s) => s.value === 'ended').length).toBeGreaterThan(0);
  });

  it('[INV-40][DI-14] an offer after another person\'s tap switches or is dismissed; a failed switch returns to the offer', () => {
    const offered = paths((s) => s.value === 'offering')[0];
    expect(types(offered)).toEqual(['xstate.init', 'OFFER_SWITCH']);
    const [switching] = transition(kioskLockMachine, offered?.state as never, { type: 'SWITCH' } as never);
    const [again] = transition(kioskLockMachine, switching, fail(idOf('switching'), refused(401, 'EBMR-IAM-140', 'AUTH_FAILED')) as never);
    expect(again.value).toBe('offering');
    const [dismissed] = transition(kioskLockMachine, again, { type: 'DISMISS' });
    expect(dismissed.value).toBe('active');
  });

  it('[DI-38] session changes are announced to the page (C4 discards unsent entries on SWITCH, LOCK and ENDED)', () => {
    const seen = vi.fn();
    const off = onSessionChange(seen);
    announceSessionChange({ reason: 'SWITCH', personId: 'p-2' });
    off();
    announceSessionChange({ reason: 'LOCK', personId: 'p-2' });
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith({ reason: 'SWITCH', personId: 'p-2' });
    expect(SESSION_CHANGE_EVENT).toBe('ebmr:session-change');
  });
});
