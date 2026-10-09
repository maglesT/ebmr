/**
 * The pendingEntry machine (module C4; plan section 9 "Entry rules"; decision D1; DI-28, INV-40).
 *
 *   editing -> awaitingTap -> sending -> saved | notSaved | refused | stale | discarded
 *
 * - SUBMIT fixes the entry: its exact payload and a new idempotency key. On a shared terminal the entry then
 *   waits for a badge tap of the signed-in person (INV-40); office terminals send at once.
 * - notSaved (the answer was lost in transit) is blocking: the entry is not shown as recorded (DI-28). The only
 *   ways out are RESEND (same key, same payload, and a fresh tap: a tap is single use) or DISCARD. If the first
 *   attempt did commit, the server replays its stored result for the same key, so nothing is recorded twice.
 * - refused (a definite answer from the server) retires the key: the person corrects and submits a new entry.
 * - stale (the run moved on) retires the key too; the screen reloads and lists what changed.
 * - A session change (another person signs in, or switches user) discards anything pending: an entry is never
 *   sent under a person other than the one who made it. A tap by another person (SWITCH_USER) discards too.
 *
 * The machine holds no attribution, PIN, proof or other secret: the hook that drives it keeps the tap result in
 * a local variable for the one request it belongs to. Nothing here is stored in the browser.
 */
import type { RefusalEnvelope } from '@ebmr/api-contract';
import { assign, setup } from 'xstate';

/** The exact body of the command (e.g. {expectedVersion, intent, viewStepKey}); resent unchanged. */
export type PendingPayload = Readonly<Record<string, unknown>>;
export type DiscardReason = 'SESSION_CHANGED' | 'SWITCH_USER' | 'DISCARDED';

export interface PendingEntryInput {
  /** Shared terminal (session attribution TAP or TAP_PIN): every send needs a fresh badge tap. */
  tapRequired: boolean;
  /** A fresh idempotency key (UUID). */
  newKey: () => string;
}

export interface PendingEntryContext {
  tapRequired: boolean;
  newKey: () => string;
  /** Idempotency key of the current entry: fixed at SUBMIT, kept for every resend. */
  key: string | null;
  payload: PendingPayload | null;
  /** Plain words for the entry, e.g. "Blend time: 15 min". */
  summary: string;
  /** Person who made the entry (the session's person at SUBMIT). */
  owner: string | null;
  /** The current wait for a tap is for a resend (cancel returns to notSaved). */
  resend: boolean;
  /** Requests sent with the current key. */
  sends: number;
  /** Badge taps given for the current key (one per send on a shared terminal). */
  taps: number;
  refusal: RefusalEnvelope | null;
  /** What changed when the entry arrived stale. */
  changes: readonly string[];
  discardReason: DiscardReason | null;
  /** Counts session changes, so forms can clear what the previous person typed. */
  sessionEpoch: number;
}

export type PendingEntryEvent =
  | { type: 'SUBMIT'; payload: PendingPayload; summary: string; owner: string | null }
  | { type: 'TAPPED' }
  | { type: 'TAP_CANCELLED' }
  | { type: 'SAVED' }
  | { type: 'LOST' }
  | { type: 'REFUSED'; refusal: RefusalEnvelope }
  | { type: 'STALE'; refusal: RefusalEnvelope | null; changes: readonly string[] }
  | { type: 'SWITCH_USER'; refusal: RefusalEnvelope }
  | { type: 'RESEND' }
  | { type: 'DISCARD' }
  | { type: 'RESET' }
  | { type: 'SESSION_CHANGED' };

export type PendingEntryState = 'editing' | 'awaitingTap' | 'sending' | 'saved' | 'notSaved' | 'refused' | 'stale' | 'discarded';

const EMPTY = { key: null, payload: null, summary: '', owner: null, resend: false, sends: 0, taps: 0, refusal: null, changes: [], discardReason: null } as const;

export const pendingEntryMachine = setup({
  types: {
    context: {} as PendingEntryContext,
    events: {} as PendingEntryEvent,
    input: {} as PendingEntryInput,
  },
  guards: {
    tapRequired: ({ context }) => context.tapRequired,
    isResend: ({ context }) => context.resend,
  },
  actions: {
    newEntry: assign(({ context, event }) => {
      if (event.type !== 'SUBMIT') return {};
      return { ...EMPTY, key: context.newKey(), payload: event.payload, summary: event.summary, owner: event.owner };
    }),
    countSend: assign(({ context }) => ({ sends: context.sends + 1 })),
    countTap: assign(({ context }) => ({ taps: context.taps + 1 })),
    markResend: assign({ resend: true }),
    clearResend: assign({ resend: false }),
    clearEntry: assign(() => ({ ...EMPTY })),
    keepRefusal: assign(({ event }) => (event.type === 'REFUSED' || event.type === 'SWITCH_USER' ? { refusal: event.refusal } : {})),
    keepStale: assign(({ event }) => (event.type === 'STALE' ? { refusal: event.refusal, changes: event.changes } : {})),
    discardedBySession: assign(({ context }) => ({ ...EMPTY, summary: context.summary, discardReason: 'SESSION_CHANGED' as const })),
    discardedBySwitch: assign(({ context, event }) => ({ ...EMPTY, summary: context.summary, discardReason: 'SWITCH_USER' as const, refusal: event.type === 'SWITCH_USER' ? event.refusal : null })),
    discardedByPerson: assign(({ context }) => ({ ...EMPTY, summary: context.summary, discardReason: 'DISCARDED' as const })),
    bumpEpoch: assign(({ context }) => ({ sessionEpoch: context.sessionEpoch + 1 })),
  },
}).createMachine({
  id: 'pendingEntry',
  context: ({ input }) => ({ ...EMPTY, tapRequired: input.tapRequired, newKey: input.newKey, sessionEpoch: 0 }),
  initial: 'editing',
  states: {
    editing: {
      on: {
        SUBMIT: [
          { guard: 'tapRequired', target: 'awaitingTap', actions: 'newEntry' },
          { target: 'sending', actions: ['newEntry', 'countSend'] },
        ],
        SESSION_CHANGED: { target: 'editing', actions: ['clearEntry', 'bumpEpoch'] },
      },
    },
    awaitingTap: {
      on: {
        TAPPED: { target: 'sending', actions: ['countTap', 'countSend', 'clearResend'] },
        TAP_CANCELLED: [
          { guard: 'isResend', target: 'notSaved', actions: 'clearResend' },
          { target: 'editing', actions: 'clearEntry' },
        ],
        SESSION_CHANGED: { target: 'discarded', actions: ['discardedBySession', 'bumpEpoch'] },
      },
    },
    sending: {
      on: {
        SAVED: { target: 'saved' },
        LOST: { target: 'notSaved' },
        REFUSED: { target: 'refused', actions: 'keepRefusal' },
        STALE: { target: 'stale', actions: 'keepStale' },
        SWITCH_USER: { target: 'discarded', actions: ['discardedBySwitch', 'bumpEpoch'] },
        SESSION_CHANGED: { target: 'discarded', actions: ['discardedBySession', 'bumpEpoch'] },
      },
    },
    notSaved: {
      on: {
        RESEND: [
          { guard: 'tapRequired', target: 'awaitingTap', actions: 'markResend' },
          { target: 'sending', actions: 'countSend' },
        ],
        DISCARD: { target: 'discarded', actions: 'discardedByPerson' },
        SESSION_CHANGED: { target: 'discarded', actions: ['discardedBySession', 'bumpEpoch'] },
      },
    },
    saved: {
      on: {
        SUBMIT: [
          { guard: 'tapRequired', target: 'awaitingTap', actions: 'newEntry' },
          { target: 'sending', actions: ['newEntry', 'countSend'] },
        ],
        RESET: { target: 'editing', actions: 'clearEntry' },
        SESSION_CHANGED: { target: 'editing', actions: ['clearEntry', 'bumpEpoch'] },
      },
    },
    refused: {
      on: {
        SUBMIT: [
          { guard: 'tapRequired', target: 'awaitingTap', actions: 'newEntry' },
          { target: 'sending', actions: ['newEntry', 'countSend'] },
        ],
        RESET: { target: 'editing', actions: 'clearEntry' },
        SESSION_CHANGED: { target: 'discarded', actions: ['discardedBySession', 'bumpEpoch'] },
      },
    },
    stale: {
      on: {
        SUBMIT: [
          { guard: 'tapRequired', target: 'awaitingTap', actions: 'newEntry' },
          { target: 'sending', actions: ['newEntry', 'countSend'] },
        ],
        RESET: { target: 'editing', actions: 'clearEntry' },
        SESSION_CHANGED: { target: 'discarded', actions: ['discardedBySession', 'bumpEpoch'] },
      },
    },
    discarded: {
      on: {
        SUBMIT: [
          { guard: 'tapRequired', target: 'awaitingTap', actions: 'newEntry' },
          { target: 'sending', actions: ['newEntry', 'countSend'] },
        ],
        RESET: { target: 'editing', actions: 'clearEntry' },
        SESSION_CHANGED: { target: 'discarded', actions: 'bumpEpoch' },
      },
    },
  },
});

export type PendingEntryMachine = typeof pendingEntryMachine;

/** States in which something typed is on its way, or waits for the person, and is not yet in the record. */
export const UNSETTLED_STATES: readonly PendingEntryState[] = ['awaitingTap', 'sending', 'notSaved'];
