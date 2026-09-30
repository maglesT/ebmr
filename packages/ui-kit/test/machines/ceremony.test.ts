/**
 * The e-signature ceremony machine (module C1; plan section 6; DI-19, DI-36, DI-37, DI-38, INV-10), explored with
 * @xstate/graph: every state is reachable, and the paths that matter (secret wiped, expiry, changed content,
 * lockout, lost answer) end where they must. The asynchronous steps are the invoked actors' done and error events.
 * A replay with real actors shows the secret never reaches the machine and is wiped by the host's actor.
 */
import { describe, expect, it } from 'vitest';
import { createActor, fromPromise, transition, type AnyEventObject } from 'xstate';
import { getShortestPaths, getSimplePaths } from '@xstate/graph';
import { sha256Hex } from '@ebmr/expr';
import type { ChallengeView, ManifestationView, RefusalEnvelope, SignableContentView } from '@ebmr/api-contract';
import { ceremonyError, ceremonyMachine, ceremonyOutcome, contentVerified, type CeremonyEvent, type CeremonyFailure, type CeremonyState, type SignedOutcome } from '../../src/machines/ceremony.ts';

const TEXT = '{"aggregate_id":"s-1","aggregate_type":"esig_stub","content":{"title":"Binder added","value":"12.503"},"content_version":1}';
const CONTENT: SignableContentView = {
  aggregateType: 'esig_stub',
  aggregateId: 's-1',
  contentVersion: '1',
  canonicalText: TEXT,
  contentHash: sha256Hex(TEXT),
  meaning: 'PERFORMED',
  meaningText: 'I performed this step and recorded its data.',
  title: 'Performed: Binder added',
  preview: false,
  rendering: { kind: 'fallback', content: { title: 'Binder added', value: '12.503' } },
};
const CHALLENGE: ChallengeView = {
  challengeId: '6b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e',
  aggregateType: 'esig_stub',
  aggregateId: 's-1',
  contentVersion: '1',
  contentHash: CONTENT.contentHash,
  meaning: 'PERFORMED',
  expiresAt: { us: '1790586663000000', text: '28-SEP-2026 14:41:03 +05:30 (Asia/Kolkata)' },
  expiresInSeconds: 120,
  requires: ['PIN'],
  manifestation: { legalName: 'TEST-Priya Nair', loginName: 'test-operator-1', role: 'OPERATOR', meaning: 'PERFORMED', meaningText: 'Performed by', zone: 'Asia/Kolkata' },
};
const MANIFESTATION: ManifestationView = {
  signatureId: 'a7b8c9d0-e1f2-4a3b-8c4d-5e6f7a8b9c03',
  signer: { personId: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e51', legalName: 'TEST-Priya Nair', loginName: 'test-operator-1', role: 'OPERATOR' },
  meaning: 'PERFORMED',
  meaningText: 'Performed by',
  signedAt: { us: '1790586600000000', text: '28-SEP-2026 14:40:00 +05:30 (Asia/Kolkata)' },
  zone: 'Asia/Kolkata',
  valid: true,
  aggregateType: 'esig_stub',
  aggregateId: 's-1',
  contentVersion: '1',
  contentHash: CONTENT.contentHash,
};

const env = (code: string, kind: RefusalEnvelope['refusal']['kind']): RefusalEnvelope => ({
  refusal: { code, kind, whatHappened: code, why: '', controls: [], whatYouCanDo: [], whoCanHelp: [] },
  correlationId: 'test',
  retryable: false,
});
const refused = (status: number, code: string, kind: RefusalEnvelope['refusal']['kind']): CeremonyFailure => ({ kind: 'REFUSAL', status, envelope: env(code, kind) });

const done = (id: string, output: unknown): AnyEventObject => ({ type: `xstate.done.actor.${id}`, output });
const fail = (id: string, error: unknown): AnyEventObject => ({ type: `xstate.error.actor.${id}`, error });

const EVENTS = [
  { type: 'SIGN' },
  { type: 'TAPPED' },
  { type: 'TAP_TIMEOUT' },
  { type: 'SUBMIT' },
  { type: 'EXPIRE' },
  { type: 'CANCEL' },
  { type: 'RESTART' },
  { type: 'CLOSE' },
  { type: 'SWITCHED' },
  done('loadContent', CONTENT),
  done('loadContent', { ...CONTENT, contentHash: 'ff'.repeat(32) }),
  fail('loadContent', refused(404, 'ESIG_CONTENT_NOT_FOUND', 'STALE')),
  done('createChallenge', CHALLENGE),
  fail('createChallenge', refused(409, 'EBMR-ESIG-013', 'CONTENT_CHANGED')),
  fail('createChallenge', refused(409, 'SWITCH_USER', 'SWITCH_USER')),
  fail('createChallenge', refused(422, 'EBMR-ESIG-026', 'NOT_ALLOWED')),
  done('sign', { manifestation: MANIFESTATION, result: null }),
  fail('sign', refused(401, 'EBMR-IAM-140', 'AUTH_FAILED')),
  fail('sign', refused(423, 'AUTH_LOCKED', 'LOCKED')),
  fail('sign', refused(409, 'EBMR-ESIG-033', 'STALE')),
  fail('sign', refused(409, 'CONTENT_CHANGED', 'CONTENT_CHANGED')),
  fail('sign', refused(422, 'EBMR-ESIG-044', 'INDEPENDENCE')),
  fail('sign', { kind: 'LOST', message: 'network' } satisfies CeremonyFailure),
  done('reconcile', MANIFESTATION),
  done('reconcile', null),
] as unknown as CeremonyEvent[];

const serialize = (s: { value: unknown; context: { attempts: number } }) => `${JSON.stringify(s.value)}|${Math.min(s.context.attempts, 2)}`;

function pathsTo(kiosk: boolean, target: CeremonyState) {
  return getShortestPaths(ceremonyMachine, { input: { kiosk }, events: EVENTS, serializeState: serialize, toState: (s) => s.value === target });
}

const eventTypes = (p: { steps: { event: AnyEventObject }[] }) => p.steps.map((s) => (s.event.type.startsWith('xstate.') ? `${s.event.type.replace('xstate.', '').replace('.actor', '')}` : s.event.type));

describe('ceremony machine paths', () => {
  it('[DI-38][DI-36] every state is reachable; a kiosk signature always passes review, the tap, the challenge and the secret', () => {
    const all = getShortestPaths(ceremonyMachine, { input: { kiosk: true }, events: EVENTS, serializeState: serialize });
    const reached = new Set(all.map((p) => p.state.value as string));
    for (const s of ['loadingContent', 'reviewing', 'awaitingTap', 'challenging', 'awaitingSecret', 'signing', 'reconciling', 'switchOffered', 'expired', 'changed', 'done', 'refused', 'cancelled', 'notConfirmed', 'closed']) {
      expect(reached.has(s), s).toBe(true);
    }
    const signed = pathsTo(true, 'done');
    expect(eventTypes(signed[0] ?? { steps: [] })).toEqual(['init', 'done.loadContent', 'SIGN', 'TAPPED', 'done.createChallenge', 'SUBMIT', 'done.sign']);
    // Office: no tap.
    expect(eventTypes(pathsTo(false, 'done')[0] ?? { steps: [] })).toEqual(['init', 'done.loadContent', 'SIGN', 'done.createChallenge', 'SUBMIT', 'done.sign']);
    // No simple path reaches done without the signer's secret and the server's signature.
    const simple = getSimplePaths(ceremonyMachine, { input: { kiosk: true }, events: EVENTS, serializeState: serialize, toState: (s) => s.value === 'done' });
    expect(simple.length).toBeGreaterThan(0);
    for (const p of simple) {
      const types = eventTypes(p);
      expect(types.includes('SUBMIT') || types.includes('done.reconcile')).toBe(true);
      expect(types.includes('done.sign') || types.includes('done.reconcile')).toBe(true);
    }
  });

  it('[DI-37] content whose text does not hash to the server\'s hash is never signed; a changed record leads to "changed", then back to review', () => {
    expect(contentVerified(CONTENT)).toBe(true);
    expect(contentVerified({ ...CONTENT, canonicalText: `${TEXT} ` })).toBe(false);
    const refusedPaths = getSimplePaths(ceremonyMachine, { input: { kiosk: false }, events: EVENTS, serializeState: serialize, toState: (s) => s.value === 'refused' && s.context.refusal?.refusal.code === 'CONTENT_UNVERIFIED' });
    expect(refusedPaths.length).toBeGreaterThan(0);
    for (const p of refusedPaths) expect(eventTypes(p)).not.toContain('done.createChallenge');
    const changed = pathsTo(false, 'changed');
    expect(eventTypes(changed[0] ?? { steps: [] })).toEqual(['init', 'done.loadContent', 'SIGN', 'error.createChallenge']);
    const s = changed[0]?.state;
    expect(s?.context.refusal?.refusal.kind).toBe('CONTENT_CHANGED');
    const [restarted] = transition(ceremonyMachine, s as never, { type: 'RESTART' });
    expect(restarted.value).toBe('loadingContent');
    expect(restarted.context.challenge).toBeNull();
  });

  it('[DI-38] the challenge expiry ends the secret entry; a signature already on its way is decided by the server only', () => {
    const expired = pathsTo(true, 'expired');
    const types = eventTypes(expired[0] ?? { steps: [] });
    expect(types.at(-1) === 'EXPIRE' || types.at(-1) === 'error.sign').toBe(true);
    // While signing, EXPIRE and CANCEL are ignored.
    const signing = pathsTo(true, 'signing')[0]?.state;
    for (const type of ['EXPIRE', 'CANCEL']) {
      const [next] = transition(ceremonyMachine, signing as never, { type } as never);
      expect((next as { value: unknown }).value).toBe('signing');
    }
    // The server's EBMR-ESIG-033 also ends in expired.
    const [late] = transition(ceremonyMachine, signing as never, fail('sign', refused(409, 'EBMR-ESIG-033', 'STALE')) as never);
    expect((late as { value: unknown }).value).toBe('expired');
    expect(ceremonyOutcome('closed', late.context)).toMatchObject({ status: 'REFUSED', refusal: { refusal: { code: 'EBMR-ESIG-033' } } });
  });

  it('[DI-19][DI-38] a wrong PIN returns to the secret entry and counts; the lockout ends the ceremony as refused', () => {
    const signing = pathsTo(true, 'signing')[0]?.state;
    const [again] = transition(ceremonyMachine, signing as never, fail('sign', refused(401, 'EBMR-IAM-140', 'AUTH_FAILED')) as never);
    expect((again as { value: unknown }).value).toBe('awaitingSecret');
    expect((again as { context: { attempts: number; attemptError: RefusalEnvelope } }).context).toMatchObject({ attempts: 1, attemptError: { refusal: { code: 'EBMR-IAM-140' } } });
    const [locked] = transition(ceremonyMachine, signing as never, fail('sign', refused(423, 'AUTH_LOCKED', 'LOCKED')) as never);
    expect((locked as { value: unknown }).value).toBe('refused');
    const lockoutPaths = getSimplePaths(ceremonyMachine, {
      input: { kiosk: true },
      events: EVENTS,
      serializeState: serialize,
      toState: (s) => s.value === 'refused' && s.context.refusal?.refusal.code === 'AUTH_LOCKED',
    });
    expect(lockoutPaths.some((p) => eventTypes(p).filter((t) => t === 'SUBMIT').length >= 2)).toBe(true);
  });

  it('[INV-10][DI-38] a lost answer never re-sends credentials: it reconciles to done with the found signature, or to notConfirmed', () => {
    const lost = pathsTo(true, 'notConfirmed')[0];
    const types = eventTypes(lost ?? { steps: [] });
    expect(types.slice(-2)).toEqual(['error.sign', 'done.reconcile']);
    expect(types.filter((t) => t === 'SUBMIT')).toHaveLength(1);
    const reconciling = transition(ceremonyMachine, pathsTo(true, 'signing')[0]?.state as never, fail('sign', { kind: 'LOST', message: 'network' }) as never)[0] as { value: unknown };
    expect(reconciling.value).toBe('reconciling');
    const [after] = transition(ceremonyMachine, reconciling as never, { type: 'SUBMIT' } as never);
    expect((after as { value: unknown }).value).toBe('reconciling');
    const [ok] = transition(ceremonyMachine, reconciling as never, done('reconcile', MANIFESTATION) as never);
    expect(ceremonyOutcome(ok.value, ok.context)).toMatchObject({ status: 'SIGNED', manifestation: { signatureId: MANIFESTATION.signatureId } });
  });

  it('[INV-40][DI-38] a tap by another person offers the switch; after it the ceremony ends with nothing signed, so the new person starts their own signing', () => {
    const offered = pathsTo(true, 'switchOffered')[0];
    expect(eventTypes(offered ?? { steps: [] }).at(-1)).toBe('error.createChallenge');
    const [after] = transition(ceremonyMachine, offered?.state as never, { type: 'SWITCHED' } as never);
    const ended = after as unknown as { value: CeremonyState; context: Parameters<typeof ceremonyOutcome>[1] };
    expect(ended.value).toBe('cancelled');
    expect(ceremonyOutcome(ended.value, ended.context)).toEqual({ status: 'CANCELLED' });
    // No path signs anything once a switch happened: the previous person's request never meets the new person's secret.
    const signed = getSimplePaths(ceremonyMachine, { input: { kiosk: true }, events: EVENTS, serializeState: serialize, toState: (s) => s.value === 'done' });
    expect(signed.length).toBeGreaterThan(0);
    for (const p of signed) expect(eventTypes(p)).not.toContain('SWITCHED');
  });
});

describe('ceremony with real actors', () => {
  it('[DI-38][INV-10] the PIN never enters the machine: the host keeps it for one request and the actor wipes it', async () => {
    const PIN = '482913';
    const vault: { pin: string | null } = { pin: null };
    const sent: unknown[] = [];
    const machine = ceremonyMachine.provide({
      actors: {
        loadContent: fromPromise<SignableContentView>(() => Promise.resolve(CONTENT)),
        createChallenge: fromPromise<ChallengeView, { content: SignableContentView }>(() => Promise.resolve(CHALLENGE)),
        sign: fromPromise<SignedOutcome, { challenge: ChallengeView }>(() => {
          const pin = vault.pin;
          vault.pin = null;
          sent.push({ credentials: { kind: 'PIN', pin } });
          return Promise.resolve({ manifestation: MANIFESTATION, result: null });
        }),
        reconcile: fromPromise<ManifestationView | null, { challenge: ChallengeView }>(() => Promise.resolve(null)),
      },
    });
    const actor = createActor(machine, { input: { kiosk: true } });
    const seen: string[] = [];
    actor.subscribe((s) => seen.push(JSON.stringify(s.toJSON())));
    actor.start();
    await new Promise((r) => setTimeout(r, 0));
    actor.send({ type: 'SIGN' });
    actor.send({ type: 'TAPPED' });
    await new Promise((r) => setTimeout(r, 0));
    expect(actor.getSnapshot().value).toBe('awaitingSecret');
    vault.pin = PIN;
    actor.send({ type: 'SUBMIT' });
    await new Promise((r) => setTimeout(r, 0));
    expect(actor.getSnapshot().value).toBe('done');
    expect(vault.pin).toBeNull();
    expect(sent).toEqual([{ credentials: { kind: 'PIN', pin: PIN } }]);
    expect(seen.some((s) => s.includes(PIN))).toBe(false);
    expect(Object.keys(actor.getSnapshot().context).sort()).toEqual(['attemptError', 'attempts', 'challenge', 'content', 'kiosk', 'manifestation', 'refusal', 'result']);
    actor.stop();
  });

  it('[DI-38] a throwable failure keeps its kind for the machine', () => {
    const e = ceremonyError(refused(401, 'EBMR-IAM-140', 'AUTH_FAILED'));
    expect(e).toBeInstanceOf(Error);
    expect(e.kind).toBe('REFUSAL');
    const [next] = transition(ceremonyMachine, pathsTo(true, 'signing')[0]?.state as never, fail('sign', e) as never);
    expect((next as { value: unknown }).value).toBe('awaitingSecret');
  });
});
