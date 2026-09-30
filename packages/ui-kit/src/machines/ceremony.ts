/**
 * The e-signature ceremony (module C1; plan section 6; DI-36, DI-37, DI-38, INV-10), as an XState machine:
 *
 *   loadingContent -> reviewing -> awaitingTap (kiosk) -> challenging -> awaitingSecret -> signing
 *     -> done | refused | expired | changed | cancelled | switchOffered | reconciling -> notConfirmed
 *
 * Secrets never enter the machine: the host keeps the badge UID and the PIN or password in refs, the invoked
 * actors (provided by the host) read and wipe them, and the events carry no payload (TAPPED, SUBMIT). Context holds
 * only what the screen shows: the content, the challenge, the manifestation, refusals and the attempt count.
 *
 *  - The content is verified by the client: SHA-256 of the exact canonical text must equal the server's hash, or
 *    the ceremony stops before any challenge (DI-37).
 *  - A wrong PIN or password returns to the secret entry (the kernel counts it toward lockout); a lockout ends it.
 *  - The record changing (EBMR-ESIG-012/013, CONTENT_CHANGED) leads to `changed`, the challenge running out
 *    (host countdown EXPIRE, or the server's EBMR-ESIG-033) to `expired`; both offer to start again.
 *  - A lost sign response never re-sends credentials: `reconciling` reloads the signatures; a matching signature
 *    means done, none means `notConfirmed`.
 *  - A tap by another person at the challenge offers "Switch to <name>?" (`switchOffered`). Once the switch is done
 *    (SWITCHED) the ceremony ends with nothing signed (`cancelled`): the request, and any decision or justification in
 *    it, is the previous person's, so it is never challenged or signed under the new person; they start their own
 *    signing, with their own decision (INV-40, DI-38).
 *  - While a signature is being applied, EXPIRE and CANCEL are ignored: only the server's answer decides.
 */
import { assign, fromPromise, setup } from 'xstate';
import { sha256Hex } from '@ebmr/expr';
import type { ChallengeView, ManifestationView, RefusalEnvelope, SignableContentView } from '@ebmr/api-contract';

/** What an actor of the host throws: a server refusal, a lost response, or a local problem. */
export type CeremonyFailure =
  | { kind: 'REFUSAL'; status: number; envelope: RefusalEnvelope }
  | { kind: 'LOST'; message: string }
  | { kind: 'ERROR'; message: string };

export interface SignedOutcome {
  manifestation: ManifestationView;
  result: Record<string, unknown> | null;
}

export interface CeremonyInput {
  /** Shop-floor terminal: the signer taps for the challenge, then enters the PIN. */
  kiosk: boolean;
}

export interface CeremonyContext {
  kiosk: boolean;
  content: SignableContentView | null;
  challenge: ChallengeView | null;
  manifestation: ManifestationView | null;
  result: Record<string, unknown> | null;
  refusal: RefusalEnvelope | null;
  /** The refusal of the last failed secret entry (never the secret). */
  attemptError: RefusalEnvelope | null;
  attempts: number;
}

export type CeremonyEvent =
  | { type: 'SIGN' }
  | { type: 'TAPPED' }
  | { type: 'TAP_TIMEOUT' }
  | { type: 'SUBMIT' }
  | { type: 'EXPIRE' }
  | { type: 'CANCEL' }
  | { type: 'RESTART' }
  | { type: 'CLOSE' }
  | { type: 'SWITCHED' };

export function localRefusal(code: string, kind: RefusalEnvelope['refusal']['kind'], whatHappened: string, why = '', whatYouCanDo: string[] = []): RefusalEnvelope {
  return { refusal: { code, kind, whatHappened, why, controls: ['DI-37'], whatYouCanDo, whoCanHelp: [] }, correlationId: 'client', retryable: false };
}

export const EXPIRED_REFUSAL = localRefusal('EBMR-ESIG-033', 'STALE', 'The time to sign ran out. Nothing was signed.', 'A signing request is valid for 120 seconds.', ['Start the signing again.']);
export const CHANGED_REFUSAL = localRefusal('CONTENT_CHANGED', 'CONTENT_CHANGED', 'The record changed while you were reviewing it. Nothing was signed.', '', ['Review the current content, then sign again.']);
export const UNVERIFIED_REFUSAL = localRefusal(
  'CONTENT_UNVERIFIED',
  'CONTENT_CHANGED',
  'The content shown could not be verified, so it cannot be signed.',
  'The SHA-256 of the text received differs from the hash the server gave for it.',
  ['Reload the screen. If it happens again, report it.'],
);

/** A failure as a throwable Error (actors throw it; the machine reads its `kind`). */
export function ceremonyError(f: CeremonyFailure): Error & CeremonyFailure {
  return Object.assign(new Error(f.kind === 'REFUSAL' ? f.envelope.refusal.code : f.message), f);
}

const asFailure = (e: unknown): CeremonyFailure =>
  e !== null && typeof e === 'object' && 'kind' in e && ((e as CeremonyFailure).kind === 'REFUSAL' || (e as CeremonyFailure).kind === 'LOST' || (e as CeremonyFailure).kind === 'ERROR')
    ? (e as CeremonyFailure)
    : { kind: 'ERROR', message: e instanceof Error ? e.message : String(e) };

/** The refusal to show for any failure. */
export function refusalOfFailure(e: unknown): RefusalEnvelope {
  const f = asFailure(e);
  if (f.kind === 'REFUSAL') return f.envelope;
  if (f.kind === 'LOST') return localRefusal('NOT_CONFIRMED', 'NOT_SAVED', 'The server did not answer.', f.message, ['Reload the record to see what was saved.']);
  return localRefusal('CLIENT_ERROR', 'NOT_SAVED', 'The signing could not continue.', f.message, ['Reload the screen and try again.']);
}

const refusalKind = (e: unknown): string | null => {
  const f = asFailure(e);
  return f.kind === 'REFUSAL' ? f.envelope.refusal.kind : null;
};
const refusalCode = (e: unknown): string | null => {
  const f = asFailure(e);
  return f.kind === 'REFUSAL' ? f.envelope.refusal.code : null;
};

/** The content can be signed only when its text hashes to the server's hash (DI-37). */
export const contentVerified = (content: SignableContentView): boolean => sha256Hex(content.canonicalText) === content.contentHash;

const cleared = { content: null, challenge: null, manifestation: null, result: null, refusal: null, attemptError: null, attempts: 0 };

export const ceremonyMachine = setup({
  types: {
    context: {} as CeremonyContext,
    input: {} as CeremonyInput,
    events: {} as CeremonyEvent,
  },
  actors: {
    loadContent: fromPromise<SignableContentView>(() => Promise.reject(new Error('loadContent is provided by the host'))),
    createChallenge: fromPromise<ChallengeView, { content: SignableContentView }>(() => Promise.reject(new Error('createChallenge is provided by the host'))),
    sign: fromPromise<SignedOutcome, { challenge: ChallengeView }>(() => Promise.reject(new Error('sign is provided by the host'))),
    reconcile: fromPromise<ManifestationView | null, { challenge: ChallengeView }>(() => Promise.reject(new Error('reconcile is provided by the host'))),
  },
  guards: {
    isKiosk: ({ context }) => context.kiosk,
    lost: (_, params: { error: unknown }) => asFailure(params.error).kind === 'LOST',
    authFailed: (_, params: { error: unknown }) => refusalKind(params.error) === 'AUTH_FAILED',
    contentChanged: (_, params: { error: unknown }) => refusalKind(params.error) === 'CONTENT_CHANGED',
    switchUser: (_, params: { error: unknown }) => refusalKind(params.error) === 'SWITCH_USER',
    challengeExpired: (_, params: { error: unknown }) => refusalCode(params.error) === 'EBMR-ESIG-033',
  },
}).createMachine({
  id: 'ceremony',
  initial: 'loadingContent',
  context: ({ input }) => ({ kiosk: input.kiosk, ...cleared }),
  states: {
    loadingContent: {
      entry: assign(cleared),
      invoke: {
        id: 'loadContent',
        src: 'loadContent',
        onDone: [
          { guard: ({ event }) => contentVerified(event.output), target: 'reviewing', actions: assign({ content: ({ event }) => event.output }) },
          { target: 'refused', actions: assign({ refusal: UNVERIFIED_REFUSAL }) },
        ],
        onError: { target: 'refused', actions: assign({ refusal: ({ event }) => refusalOfFailure(event.error) }) },
      },
      on: { CANCEL: 'cancelled' },
    },
    reviewing: {
      on: {
        SIGN: [{ guard: 'isKiosk', target: 'awaitingTap' }, { target: 'challenging' }],
        CANCEL: 'cancelled',
      },
    },
    awaitingTap: {
      on: { TAPPED: 'challenging', TAP_TIMEOUT: 'reviewing', CANCEL: 'cancelled' },
    },
    challenging: {
      invoke: {
        id: 'createChallenge',
        src: 'createChallenge',
        input: ({ context }) => ({ content: context.content as SignableContentView }),
        onDone: { target: 'awaitingSecret', actions: assign({ challenge: ({ event }) => event.output, attemptError: null }) },
        onError: [
          { guard: { type: 'contentChanged', params: ({ event }) => ({ error: event.error }) }, target: 'changed', actions: assign({ refusal: ({ event }) => refusalOfFailure(event.error) }) },
          { guard: { type: 'switchUser', params: ({ event }) => ({ error: event.error }) }, target: 'switchOffered', actions: assign({ refusal: ({ event }) => refusalOfFailure(event.error) }) },
          { target: 'refused', actions: assign({ refusal: ({ event }) => refusalOfFailure(event.error) }) },
        ],
      },
      on: { CANCEL: 'cancelled' },
    },
    awaitingSecret: {
      on: { SUBMIT: 'signing', EXPIRE: 'expired', CANCEL: 'cancelled' },
    },
    signing: {
      invoke: {
        id: 'sign',
        src: 'sign',
        input: ({ context }) => ({ challenge: context.challenge as ChallengeView }),
        onDone: { target: 'done', actions: assign({ manifestation: ({ event }) => event.output.manifestation, result: ({ event }) => event.output.result }) },
        onError: [
          { guard: { type: 'lost', params: ({ event }) => ({ error: event.error }) }, target: 'reconciling' },
          {
            guard: { type: 'authFailed', params: ({ event }) => ({ error: event.error }) },
            target: 'awaitingSecret',
            actions: assign({ attemptError: ({ event }) => refusalOfFailure(event.error), attempts: ({ context }) => context.attempts + 1 }),
          },
          { guard: { type: 'challengeExpired', params: ({ event }) => ({ error: event.error }) }, target: 'expired' },
          { guard: { type: 'contentChanged', params: ({ event }) => ({ error: event.error }) }, target: 'changed', actions: assign({ refusal: ({ event }) => refusalOfFailure(event.error) }) },
          { target: 'refused', actions: assign({ refusal: ({ event }) => refusalOfFailure(event.error) }) },
        ],
      },
      // Only the server's answer decides once the credentials are on their way.
    },
    reconciling: {
      invoke: {
        id: 'reconcile',
        src: 'reconcile',
        input: ({ context }) => ({ challenge: context.challenge as ChallengeView }),
        onDone: [
          { guard: ({ event }) => event.output !== null, target: 'done', actions: assign({ manifestation: ({ event }) => event.output, result: null }) },
          { target: 'notConfirmed' },
        ],
        onError: { target: 'notConfirmed' },
      },
    },
    switchOffered: {
      // After the switch nothing of the previous person's request goes on: the new person starts their own signing.
      on: { SWITCHED: 'cancelled', CANCEL: 'cancelled' },
    },
    expired: {
      entry: assign({ refusal: EXPIRED_REFUSAL }),
      on: { RESTART: 'loadingContent', CLOSE: 'closed', CANCEL: 'closed' },
    },
    changed: {
      on: { RESTART: 'loadingContent', CLOSE: 'closed', CANCEL: 'closed' },
    },
    done: { type: 'final' },
    refused: { type: 'final' },
    cancelled: { type: 'final' },
    notConfirmed: { type: 'final' },
    /** Closed from expired or changed: the caller gets the refusal and reloads. */
    closed: { type: 'final' },
  },
});

export type CeremonyState =
  | 'loadingContent'
  | 'reviewing'
  | 'awaitingTap'
  | 'challenging'
  | 'awaitingSecret'
  | 'signing'
  | 'reconciling'
  | 'switchOffered'
  | 'expired'
  | 'changed'
  | 'done'
  | 'refused'
  | 'cancelled'
  | 'notConfirmed'
  | 'closed';

export type CeremonyOutcome =
  | { status: 'SIGNED'; manifestation: ManifestationView; result: Record<string, unknown> | null }
  | { status: 'CANCELLED' }
  | { status: 'REFUSED'; refusal: RefusalEnvelope }
  | { status: 'NOT_CONFIRMED' };

/** The outcome of a finished ceremony (the SignatureCeremonyPort answer), or null while it runs. */
export function ceremonyOutcome(state: CeremonyState, context: CeremonyContext): CeremonyOutcome | null {
  switch (state) {
    case 'done':
      return context.manifestation ? { status: 'SIGNED', manifestation: context.manifestation, result: context.result } : { status: 'NOT_CONFIRMED' };
    case 'cancelled':
      return { status: 'CANCELLED' };
    case 'notConfirmed':
      return { status: 'NOT_CONFIRMED' };
    case 'refused':
    case 'closed':
      return { status: 'REFUSED', refusal: context.refusal ?? CHANGED_REFUSAL };
    default:
      return null;
  }
}
