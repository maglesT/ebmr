/**
 * The two-row ceremony (Phase 4 slice 4c; D-P4-5): a signing request with a companion (the manufacturer and US release
 * signed once) loads and checks both texts, shows both meanings, opens a challenge for each (on a kiosk each with its
 * own attribution from the one tap), and sends the credentials once with `companionChallengeId`. A companion text that
 * does not match its hash is never challenged. The boot state is a test double; the API transport records every request.
 */
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson, sha256Hex } from '@ebmr/expr';
import { EXAMPLES } from '@ebmr/api-contract/examples';
import type { Attribution, ChallengeView, FetchLike, ManifestationView, SessionView, SignableContentView } from '@ebmr/api-contract';
import type { Boot } from '../../src/app/boot.tsx';

// ---- test doubles ------------------------------------------------------------------------------
const bootState: { current: Boot } = { current: undefined as unknown as Boot };
vi.mock('../../src/app/boot.tsx', () => ({ useBoot: () => bootState.current }));

const { setTransport } = await import('../../src/api/client.ts');
const { Provider } = await import('../../src/features/access/index.tsx');
const { useBadgeTap, useSignatureCeremony } = await import('../../src/app/ports.tsx');
type Ports = { tap: ReturnType<typeof useBadgeTap>; ceremony: ReturnType<typeof useSignatureCeremony> };

const KIOSK = EXAMPLES['session-kiosk'].data as SessionView;
const OFFICE = EXAMPLES['session-office'].data as SessionView;

const TEXT = '{"aggregate_id":"6b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e","aggregate_type":"esig_stub","content":{"title":"Binder added","value":"12.503"},"content_version":1}';
const STUB = '6b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e';
const CONTENT: SignableContentView = {
  aggregateType: 'esig_stub',
  aggregateId: STUB,
  contentVersion: '1',
  canonicalText: TEXT,
  contentHash: sha256Hex(TEXT),
  meaning: 'PERFORMED',
  meaningText: 'I performed this step and recorded its data.',
  title: 'Performed: Binder added',
  preview: false,
  rendering: { kind: 'fallback', state: 'OPEN', content: { title: 'Binder added', value: '12.503' } },
};
const challenge = (requires: ChallengeView['requires'], person = KIOSK.person): ChallengeView => ({
  challengeId: 'f6a7b8c9-d0e1-4f2a-9b3c-4d5e6f7a8b92',
  aggregateType: 'esig_stub',
  aggregateId: STUB,
  contentVersion: '1',
  contentHash: CONTENT.contentHash,
  meaning: 'PERFORMED',
  expiresAt: { us: '99999999999999999', text: 'far away' },
  expiresInSeconds: 120,
  requires,
  manifestation: { legalName: person.legalName, loginName: person.loginName, role: person.role, meaning: 'PERFORMED', meaningText: 'Performed by', zone: 'Asia/Kolkata' },
});
const manifestation = (person = KIOSK.person): ManifestationView => ({
  signatureId: 'a7b8c9d0-e1f2-4a3b-8c4d-5e6f7a8b9c03',
  signer: person,
  meaning: 'PERFORMED',
  meaningText: 'Performed by',
  signedAt: { us: '1790586600000000', text: '28-SEP-2026 14:40:00 +05:30 (Asia/Kolkata)' },
  zone: 'Asia/Kolkata',
  valid: true,
  aggregateType: 'esig_stub',
  aggregateId: STUB,
  contentVersion: '1',
  contentHash: CONTENT.contentHash,
});

interface Recorded {
  method: string;
  path: string;
  query: Record<string, string>;
  body: Record<string, unknown> | undefined;
}
type Answer = unknown;

let recorded: Recorded[] = [];
let answers: Record<string, Answer> = {};
let nonceCount = 0;
let key: CryptoKeyPair;
let spki = '';

/** An answer that never comes (a stalled connection, a handler waiting on a lock). */
const NEVER = Symbol('never');

const isAnswer = (v: unknown): v is { status: number; body: unknown } => typeof v === 'object' && v !== null && 'status' in v && 'body' in v;

const transport: FetchLike = (url, init) => {
  const u = new URL(url, 'http://test.local');
  const r: Recorded = { method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined };
  recorded.push(r);
  const headers = { get: () => null };
  let a: unknown;
  if (r.path === '/api/session/device-nonce') {
    nonceCount += 1;
    a = { nonce: `nonce-${String(nonceCount).padStart(12, '0')}`, expiresInSeconds: 60 };
  } else {
    const k = `${r.method} ${r.path}`;
    const entry = answers[k];
    if (entry === undefined) a = { status: 404, body: { refusal: { code: 'NOT_FOUND', kind: 'NOT_ENABLED', whatHappened: k, why: '', controls: [], whatYouCanDo: [], whoCanHelp: [] }, correlationId: 't', retryable: false } };
    else a = typeof entry === 'function' ? (entry as (x: Recorded) => Answer)(r) : entry;
  }
  if (a === NEVER) return new Promise(() => undefined);
  if (a instanceof Error) return Promise.reject(a);
  const { status, body } = isAnswer(a) ? a : { status: 200, body: a };
  return Promise.resolve({ status, headers, text: () => Promise.resolve(JSON.stringify(body)) });
};

const setSessionSpy = vi.fn();

function bootWith(session: SessionView, over: Partial<Boot> = {}): Boot {
  return {
    phase: 'ready',
    meta: null,
    deviceKey: { privateKey: key.privateKey, publicKeySpki: spki, label: session.device.deviceCode },
    device: session.device,
    session,
    problem: null,
    restart: vi.fn(),
    setSession: setSessionSpy,
    joinMarkedSignOut: vi.fn(() => false),
    signOut: vi.fn(() => Promise.resolve()),
    forgetTerminal: vi.fn(() => Promise.resolve()), showBrowserSignIn: vi.fn(),
    ...over,
  };
}

async function verifyProof(proof: Attribution['proof'], method: string, path: string, body: unknown): Promise<boolean> {
  const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const message = new TextEncoder().encode(`${proof.nonce}|${method}|${path}|${sha256Hex(canonicalJson(body))}`);
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key.publicKey, b64(proof.sig), message);
}

function renderPorts(): Ports {
  const ports = {} as Ports;
  function Harness() {
    ports.tap = useBadgeTap();
    ports.ceremony = useSignatureCeremony();
    return null;
  }
  render(
    <Provider>
      <Harness />
    </Provider>,
  );
  return ports;
}

async function tapBadge(uid: string) {
  const field = await screen.findByLabelText('Badge');
  await userEvent.type(field, `${uid}{Enter}`);
}

async function enterPin(name: string, pin: string) {
  const pad = await screen.findByRole('group', { name });
  for (const d of pin) await userEvent.click(within(pad).getByRole('button', { name: d }));
  await userEvent.click(within(pad).getByRole('button', { name: 'OK' }));
}

beforeAll(async () => {
  key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const der = new Uint8Array(await crypto.subtle.exportKey('spki', key.publicKey));
  spki = btoa(String.fromCharCode(...der));
});
beforeEach(() => {
  recorded = [];
  answers = { 'GET /api/session': KIOSK };
  nonceCount = 0;
  setTransport(transport);
  bootState.current = bootWith(KIOSK);
});
afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

const calls = (path: string) => recorded.filter((r) => r.path === path);

// ---- tests -------------------------------------------------------------------------------------

const US_TEXT = '{"aggregate_id":"lot-1/RELEASE","aggregate_type":"us_disposition","content":{"decision":"RELEASE"},"content_version":1}';
const US_CONTENT: SignableContentView = {
  aggregateType: 'us_disposition',
  aggregateId: 'lot-1/RELEASE',
  contentVersion: '1',
  canonicalText: US_TEXT,
  contentHash: sha256Hex(US_TEXT),
  meaning: 'US_DISPOSITION',
  meaningText: 'I release this lot for the US market.',
  title: 'US disposition of lot P26-0001',
  preview: false,
  rendering: { kind: 'fallback', content: { decision: 'RELEASE' } },
};
const US_CHALLENGE = '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';
const contentFor = (usContent: SignableContentView) => (r: Recorded) => (r.query['aggregateType'] === 'us_disposition' ? usContent : CONTENT);
const challengeFor = (requires: ChallengeView['requires'], person = KIOSK.person) => (r: Recorded) =>
  r.body?.['aggregateType'] === 'us_disposition' ? { ...challenge(requires, person), challengeId: US_CHALLENGE, aggregateType: 'us_disposition', aggregateId: 'lot-1/RELEASE', contentHash: US_CONTENT.contentHash, meaning: 'US_DISPOSITION' } : challenge(requires, person);

describe('the two-row ceremony (D-P4-5)', () => {
  const request = {
    aggregateType: 'esig_stub',
    aggregateId: STUB,
    meaning: 'PERFORMED',
    action: { kind: 'ESIG_STUB' as const, stubId: STUB },
    title: 'Release for the manufacturer and the US',
    companion: { aggregateType: 'us_disposition', aggregateId: 'lot-1/RELEASE', meaning: 'US_DISPOSITION' },
  };

  it('[D-P4-5][DI-38] office: both texts loaded and both meanings shown, a challenge for each, the credentials sent once with the companion challenge', async () => {
    bootState.current = bootWith(OFFICE);
    answers['GET /api/session'] = OFFICE;
    answers['GET /api/esig/content'] = contentFor(US_CONTENT);
    answers['POST /api/esig/challenges'] = challengeFor(['USER_ID', 'PASSWORD'], OFFICE.person);
    answers['POST /api/esig/sign'] = { manifestation: manifestation(OFFICE.person), result: null };
    const ports = renderPorts();
    let outcome: ReturnType<Ports['ceremony']['sign']> = Promise.resolve({ status: 'CANCELLED' });
    act(() => {
      outcome = ports.ceremony.sign(request);
    });
    expect(await screen.findByText(/US_DISPOSITION: I release this lot for the US market\./)).toBeTruthy();
    expect(calls('/api/esig/content').map((r) => r.query['intent'])).toEqual(['PERFORMED', 'US_DISPOSITION']);
    await userEvent.click(screen.getByRole('button', { name: 'Sign' }));
    await userEvent.type(await screen.findByLabelText('User ID'), OFFICE.person.loginName);
    await userEvent.type(screen.getByLabelText('Password'), 'Demo-Author-2026!');
    await userEvent.click(screen.getByRole('button', { name: 'Sign' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Close' }));
    expect((await outcome).status).toBe('SIGNED');
    const challenges = calls('/api/esig/challenges');
    expect(challenges).toHaveLength(2);
    expect(challenges[1]?.body).toMatchObject({ aggregateType: 'us_disposition', aggregateId: 'lot-1/RELEASE', meaning: 'US_DISPOSITION', contentVersion: '1', clientContentHash: US_CONTENT.contentHash, action: request.action });
    const sign = calls('/api/esig/sign');
    expect(sign).toHaveLength(1);
    const { proof, ...signBody } = sign[0]?.body ?? {};
    expect(signBody).toMatchObject({ challengeId: challenge(['PIN']).challengeId, companionChallengeId: US_CHALLENGE, credentials: { kind: 'PASSWORD' } });
    expect(await verifyProof(proof as Attribution['proof'], 'POST', '/api/esig/sign', signBody)).toBe(true);
  });

  it('[D-P4-5][INV-40] kiosk: the one tap confirms both challenges, each with a device proof over its own request; the PIN is entered once', async () => {
    answers['GET /api/esig/content'] = contentFor(US_CONTENT);
    answers['POST /api/esig/challenges'] = challengeFor(['PIN']);
    answers['POST /api/esig/sign'] = { manifestation: manifestation(), result: null };
    const ports = renderPorts();
    let outcome: ReturnType<Ports['ceremony']['sign']> = Promise.resolve({ status: 'CANCELLED' });
    act(() => {
      outcome = ports.ceremony.sign(request);
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Sign' }));
    await tapBadge('04A10000000001');
    await enterPin('Enter your PIN to sign', '482913');
    await userEvent.click(await screen.findByRole('button', { name: 'Close' }));
    expect((await outcome).status).toBe('SIGNED');
    const challenges = calls('/api/esig/challenges');
    expect(challenges).toHaveLength(2);
    for (const c of challenges) {
      const { attribution, ...b } = c.body ?? {};
      const att = attribution as Attribution;
      expect(att.badgeUid).toBe('04A10000000001');
      expect(await verifyProof(att.proof, 'POST', '/api/esig/challenges', b)).toBe(true);
    }
    expect(calls('/api/esig/sign')[0]?.body).toMatchObject({ companionChallengeId: US_CHALLENGE, credentials: { kind: 'PIN', pin: '482913' } });
    expect(document.body.innerHTML).not.toContain('482913');
  });

  it('[D-P4-5][DI-37] a companion text that does not match its hash is never challenged and nothing is signed', async () => {
    bootState.current = bootWith(OFFICE);
    answers['GET /api/session'] = OFFICE;
    answers['GET /api/esig/content'] = contentFor({ ...US_CONTENT, contentHash: 'cd'.repeat(32) });
    answers['POST /api/esig/challenges'] = challengeFor(['USER_ID', 'PASSWORD'], OFFICE.person);
    const ports = renderPorts();
    let outcome: ReturnType<Ports['ceremony']['sign']> = Promise.resolve({ status: 'CANCELLED' });
    act(() => {
      outcome = ports.ceremony.sign(request);
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Close' }));
    expect((await outcome).status).not.toBe('SIGNED');
    expect(calls('/api/esig/challenges')).toHaveLength(0);
    expect(calls('/api/esig/sign')).toHaveLength(0);
  });
});
