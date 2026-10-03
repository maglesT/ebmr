/**
 * The access module's ports end to end in the browser code (module C1; plan sections 5 and 6): the BadgeTapPort
 * builds an attribution whose device proof covers the exact request; a switch offer reuses the tapped badge; the
 * signature ceremony runs content, tap, challenge, PIN or password, and sign against the API, never re-sends
 * credentials after a lost answer, refuses unverifiable content, and keeps no secret in the page or storage.
 * The boot state is a test double; the API transport records every request.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson, sha256Hex } from '@ebmr/expr';
import { EXAMPLES } from '@ebmr/api-contract/examples';
import type { Attribution, ChallengeView, FetchLike, ManifestationView, SessionView, SignableContentView } from '@ebmr/api-contract';
import type { Boot } from '../../src/app/boot.tsx';
import type { SignOutcome } from '../../src/app/ports.tsx';

// ---- test doubles ------------------------------------------------------------------------------
const bootState: { current: Boot } = { current: undefined as unknown as Boot };
vi.mock('../../src/app/boot.tsx', () => ({ useBoot: () => bootState.current }));

const { setTransport } = await import('../../src/api/client.ts');
const { Provider } = await import('../../src/features/access/index.tsx');
const { EsigDemoPage } = await import('../../src/features/access/EsigDemo.tsx');
const { useBadgeTap, useSignatureCeremony } = await import('../../src/app/ports.tsx');
const { base64UrlOfUtf8, previewIntent } = await import('../../src/features/access/calls.ts');
const { SEND_DEADLINE_MS } = await import('../../src/api/deadline.ts');
type Ports = { tap: ReturnType<typeof useBadgeTap>; ceremony: ReturnType<typeof useSignatureCeremony> };

const KIOSK = EXAMPLES['session-kiosk'].data as SessionView;
const OFFICE = EXAMPLES['session-office'].data as SessionView;
const VERIFIER: SessionView = { ...KIOSK, person: { personId: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e61', legalName: 'TEST-Kavya Reddy', loginName: 'test-verifier-1', role: 'VERIFIER' }, role: 'VERIFIER', roles: ['VERIFIER'] };

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
describe('BadgeTapPort', () => {
  it('[INV-40][DI-14][DI-20] a tap returns an attribution whose device proof covers exactly the request it confirms', async () => {
    const ports = renderPorts();
    const request = { method: 'POST', path: '/api/test-runs/r-1/commands', body: { expectedVersion: 3, intent: { type: 'START_STEP', stepKey: 'p-blend@' } } };
    let result: Promise<Attribution | null> = Promise.resolve(null);
    act(() => {
      result = ports.tap.requestTap('Confirm the start of step 2.1.4', request);
    });
    expect(await screen.findByText('Confirm the start of step 2.1.4')).toBeTruthy();
    await tapBadge('04A10000000001');
    const a = await result;
    expect(a).toMatchObject({ method: 'BADGE_TAP', badgeUid: '04A10000000001' });
    expect(a?.pin).toBeUndefined();
    expect(a && (await verifyProof(a.proof, 'POST', '/api/test-runs/r-1/commands', request.body))).toBe(true);
    expect(a && (await verifyProof(a.proof, 'POST', '/api/test-runs/r-1/commands', { ...request.body, expectedVersion: 4 }))).toBe(false);
    expect(window.localStorage.length + window.sessionStorage.length).toBe(0);
  });

  it('[INV-40] cancel gives null; a TAP_PIN terminal class asks for the PIN after the badge', async () => {
    const ports = renderPorts();
    let result: Promise<Attribution | null> = Promise.resolve(null);
    act(() => {
      result = ports.tap.requestTap('Confirm', { method: 'POST', path: '/p', body: {} });
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(await result).toBeNull();
    bootState.current = bootWith({ ...KIOSK, attribution: 'TAP_PIN' });
    act(() => {
      result = ports.tap.requestTap('Confirm', { method: 'POST', path: '/p', body: {} });
    });
    await tapBadge('04A10000000001');
    await enterPin('Enter your PIN to confirm', '482913');
    expect(await result).toMatchObject({ badgeUid: '04A10000000001', pin: '482913' });
  });

  it('[INV-40][DI-14] after a 409 SWITCH_USER the offer reuses the badge just tapped: only the PIN, then the new session', async () => {
    answers['POST /api/session/switch'] = VERIFIER;
    const changes: unknown[] = [];
    const listen = (e: Event) => changes.push((e as CustomEvent).detail);
    window.addEventListener('ebmr:session-change', listen);
    const ports = renderPorts();
    let tapped: Promise<Attribution | null> = Promise.resolve(null);
    act(() => {
      tapped = ports.tap.requestTap('Confirm', { method: 'POST', path: '/p', body: {} });
    });
    await tapBadge('04A10000000011');
    await tapped;
    let offered: Promise<boolean> = Promise.resolve(false);
    act(() => {
      offered = ports.tap.offerSwitch({
        refusal: { code: 'SWITCH_USER', kind: 'SWITCH_USER', whatHappened: 'x', why: '', controls: [], whatYouCanDo: [], whoCanHelp: [], details: { switchToLegalName: 'TEST-Kavya Reddy', switchToLoginName: 'test-verifier-1' } },
        correlationId: 't',
        retryable: false,
      });
    });
    expect(await screen.findByRole('dialog', { name: 'Switch to TEST-Kavya Reddy?' })).toBeTruthy();
    await enterPin('Enter the PIN of TEST-Kavya Reddy', '691357');
    expect(await offered).toBe(true);
    const sw = calls('/api/session/switch')[0];
    expect(sw?.body).toMatchObject({ badgeUid: '04A10000000011', pin: '691357' });
    expect(setSessionSpy).toHaveBeenCalledWith(VERIFIER);
    expect(changes).toContainEqual({ reason: 'SWITCH', personId: VERIFIER.person.personId });
    window.removeEventListener('ebmr:session-change', listen);
  });
});

describe('SignatureCeremonyPort', () => {
  const request = { aggregateType: 'esig_stub', aggregateId: STUB, meaning: 'PERFORMED', action: { kind: 'ESIG_STUB' as const, stubId: STUB }, title: 'Sign entry as PERFORMED' };

  it('[DI-36][DI-38][INV-40] a kiosk signature: content, tap for the challenge, PIN once, manifestation; no secret stays in the page', async () => {
    answers['GET /api/esig/content'] = CONTENT;
    answers['POST /api/esig/challenges'] = challenge(['PIN']);
    answers['POST /api/esig/sign'] = { manifestation: manifestation(), result: null };
    const ports = renderPorts();
    let outcome: ReturnType<Ports['ceremony']['sign']> = Promise.resolve({ status: 'CANCELLED' });
    act(() => {
      outcome = ports.ceremony.sign(request);
    });
    expect(await screen.findByText('PERFORMED: I performed this step and recorded its data.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Sign' }));
    await tapBadge('04A10000000001');
    expect(await screen.findByRole('region', { name: 'Your signature will show' })).toBeTruthy();
    await enterPin('Enter your PIN to sign', '482913');
    expect(await screen.findByText('Signed.')).toBeTruthy();
    expect(screen.getByText('28-SEP-2026 14:40:00 +05:30 (Asia/Kolkata)')).toBeTruthy();
    const ch = calls('/api/esig/challenges')[0]?.body ?? {};
    expect(ch).toMatchObject({ clientContentHash: CONTENT.contentHash, contentVersion: '1', meaning: 'PERFORMED' });
    const att = ch['attribution'] as Attribution;
    const { attribution: _a, ...challengeBody } = ch;
    void _a;
    expect(att.badgeUid).toBe('04A10000000001');
    expect(await verifyProof(att.proof, 'POST', '/api/esig/challenges', challengeBody)).toBe(true);
    const sign = calls('/api/esig/sign');
    expect(sign).toHaveLength(1);
    const { proof, ...signBody } = sign[0]?.body ?? {};
    expect(signBody).toMatchObject({ credentials: { kind: 'PIN', pin: '482913' } });
    expect(await verifyProof(proof as Attribution['proof'], 'POST', '/api/esig/sign', signBody)).toBe(true);
    expect(calls('/api/esig/content')[0]).toMatchObject({ method: 'GET' });
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(await outcome).toMatchObject({ status: 'SIGNED', manifestation: { signatureId: manifestation().signatureId } });
    expect(document.body.innerHTML).not.toContain('482913');
    expect(window.localStorage.length + window.sessionStorage.length).toBe(0);
  });

  it('[DI-38] an office signature asks user ID and password and sends them once', async () => {
    bootState.current = bootWith(OFFICE);
    answers['GET /api/session'] = OFFICE;
    answers['GET /api/esig/content'] = CONTENT;
    answers['POST /api/esig/challenges'] = challenge(['USER_ID', 'PASSWORD'], OFFICE.person);
    answers['POST /api/esig/sign'] = { manifestation: manifestation(OFFICE.person), result: null };
    const ports = renderPorts();
    let outcome: ReturnType<Ports['ceremony']['sign']> = Promise.resolve({ status: 'CANCELLED' });
    act(() => {
      outcome = ports.ceremony.sign(request);
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Sign' }));
    const id = await screen.findByLabelText<HTMLInputElement>('User ID');
    expect(id.value).toBe('');
    await userEvent.type(id, OFFICE.person.loginName);
    await userEvent.type(screen.getByLabelText('Password'), 'Demo-Author-2026!');
    await userEvent.click(screen.getByRole('button', { name: 'Sign' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Close' }));
    expect((await outcome).status).toBe('SIGNED');
    expect(calls('/api/esig/challenges')[0]?.body?.['attribution']).toBeUndefined();
    expect(calls('/api/esig/sign')[0]?.body).toMatchObject({ credentials: { kind: 'PASSWORD', loginName: OFFICE.person.loginName, password: 'Demo-Author-2026!' } });
  });

  it('[INV-10][DI-38] a lost sign answer is never re-sent: the dialog reloads the signatures (found: signed; none: not confirmed)', async () => {
    answers['GET /api/esig/content'] = CONTENT;
    answers['POST /api/esig/challenges'] = challenge(['PIN']);
    answers['POST /api/esig/sign'] = new TypeError('network down');
    answers['GET /api/esig/signatures'] = { signatures: [] };
    const ports = renderPorts();
    let outcome: ReturnType<Ports['ceremony']['sign']> = Promise.resolve({ status: 'CANCELLED' });
    act(() => {
      outcome = ports.ceremony.sign(request);
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Sign' }));
    await tapBadge('04A10000000001');
    await enterPin('Enter your PIN to sign', '482913');
    expect(await screen.findByText('The signature was not confirmed.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(await outcome).toEqual({ status: 'NOT_CONFIRMED' });
    expect(calls('/api/esig/sign')).toHaveLength(1);
    expect(calls('/api/esig/signatures')).toHaveLength(1);

    recorded = [];
    answers['GET /api/esig/signatures'] = { signatures: [manifestation()] };
    act(() => {
      outcome = ports.ceremony.sign(request);
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Sign' }));
    await tapBadge('04A10000000001');
    await enterPin('Enter your PIN to sign', '482913');
    expect(await screen.findByText('Signed.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect((await outcome).status).toBe('SIGNED');
    expect(calls('/api/esig/sign')).toHaveLength(1);
  });

  it('[INV-10][DI-38] a sign the server never answers is given up after the deadline: the signatures are read again, the credentials never sent again (F60)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      answers['GET /api/esig/content'] = CONTENT;
      answers['POST /api/esig/challenges'] = challenge(['PIN']);
      answers['POST /api/esig/sign'] = NEVER;
      answers['GET /api/esig/signatures'] = { signatures: [manifestation()] };
      const ports = renderPorts();
      let outcome: ReturnType<Ports['ceremony']['sign']> = Promise.resolve({ status: 'CANCELLED' });
      act(() => {
        outcome = ports.ceremony.sign(request);
      });
      await userEvent.click(await screen.findByRole('button', { name: 'Sign' }));
      await tapBadge('04A10000000001');
      await enterPin('Enter your PIN to sign', '482913');
      await waitFor(() => expect(calls('/api/esig/sign')).toHaveLength(1));
      await act(async () => {
        vi.advanceTimersByTime(SEND_DEADLINE_MS - 1_000);
        await Promise.resolve();
      });
      expect(calls('/api/esig/signatures')).toHaveLength(0);
      await act(async () => {
        vi.advanceTimersByTime(1_000);
        await Promise.resolve();
      });
      expect(await screen.findByText('Signed.')).toBeTruthy();
      await userEvent.click(screen.getByRole('button', { name: 'Close' }));
      expect((await outcome).status).toBe('SIGNED');
      expect({ signs: calls('/api/esig/sign').length, reads: calls('/api/esig/signatures').length }).toEqual({ signs: 1, reads: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('[INV-40][INV-03][DI-38] a tap by another person at the signing: after the switch nothing is signed and the signing ends, so the previous person\'s decision is never challenged or signed under the new person', async () => {
    const RUN = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
    // Priya's decision on a hold point, with her comment: it is hers alone to sign.
    const decision = { kind: 'ENGINE_COMMAND' as const, runId: RUN, expectedVersion: 7, intent: { type: 'DISPOSITION_HOLD_POINT' as const, stepKey: 'H-BLEND@', disposition: 'APPROVED', comment: 'Blend uniformity within limits' } };
    const hold = { aggregateType: 'batch_step', aggregateId: `${RUN}:H-BLEND@`, meaning: 'HOLD_POINT_RELEASED', action: decision, title: 'Release hold point H-BLEND' };
    const switchUser = { status: 409, body: { refusal: { code: 'SWITCH_USER', kind: 'SWITCH_USER', whatHappened: 'This badge belongs to TEST-Kavya Reddy.', why: '', controls: [], whatYouCanDo: [], whoCanHelp: [], details: { switchToLegalName: 'TEST-Kavya Reddy', switchToLoginName: 'test-verifier-1' } }, correlationId: 't', retryable: false } };
    answers['GET /api/esig/content'] = CONTENT;
    answers['POST /api/esig/challenges'] = () => (calls('/api/esig/challenges').length === 1 ? switchUser : challenge(['PIN'], VERIFIER.person));
    answers['POST /api/esig/sign'] = { manifestation: manifestation(VERIFIER.person), result: null };
    answers['POST /api/session/switch'] = VERIFIER;
    const ports = renderPorts();
    let settled: SignOutcome | null = null;
    act(() => {
      void ports.ceremony.sign(hold).then((o) => {
        settled = o;
      });
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Sign' }));
    // Kavya's badge is tapped at Priya's signing.
    await tapBadge('04A10000000011');
    expect(await screen.findByText(/Switch to TEST-Kavya Reddy\?/)).toBeTruthy();
    await enterPin('Enter the PIN of TEST-Kavya Reddy', '691357');
    expect(calls('/api/session/switch')[0]?.body).toMatchObject({ badgeUid: '04A10000000011', pin: '691357' });
    expect(setSessionSpy).toHaveBeenCalledWith(VERIFIER);

    // The signing ends: nothing is signed, and Kavya is not asked to sign Priya's decision.
    await waitFor(() => {
      expect(settled).toEqual({ status: 'CANCELLED' });
    });
    expect(calls('/api/esig/challenges')).toHaveLength(1);
    expect(calls('/api/esig/sign')).toHaveLength(0);
    expect(calls('/api/esig/content')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Sign' })).toBeNull();
  });

  it('[DI-37] content whose text does not match its hash is never challenged; a changed record offers to review again', async () => {
    answers['GET /api/esig/content'] = { ...CONTENT, contentHash: 'ab'.repeat(32) };
    const ports = renderPorts();
    let outcome: ReturnType<Ports['ceremony']['sign']> = Promise.resolve({ status: 'CANCELLED' });
    act(() => {
      outcome = ports.ceremony.sign(request);
    });
    expect(await screen.findByText('The content shown could not be verified, so it cannot be signed.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(await outcome).toMatchObject({ status: 'REFUSED', refusal: { refusal: { code: 'CONTENT_UNVERIFIED' } } });
    expect(calls('/api/esig/challenges')).toHaveLength(0);

    answers['GET /api/esig/content'] = CONTENT;
    answers['POST /api/esig/challenges'] = {
      status: 409,
      body: { refusal: { code: 'EBMR-ESIG-013', kind: 'CONTENT_CHANGED', whatHappened: 'The record changed while you were reviewing it. Nothing was signed.', why: '', controls: ['DI-37'], whatYouCanDo: [], whoCanHelp: [] }, correlationId: 't', retryable: false },
    };
    act(() => {
      outcome = ports.ceremony.sign(request);
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Sign' }));
    await tapBadge('04A10000000001');
    expect(await screen.findByRole('button', { name: 'Review again' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(await outcome).toMatchObject({ status: 'REFUSED', refusal: { refusal: { code: 'EBMR-ESIG-013' } } });
  });
});

describe('the proposal of an exception disposition in the content preview', () => {
  const RUN = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
  // Hindi, accented Latin, a check mark and a character outside the Basic Multilingual Plane.
  const JUSTIFICATION = 'लेबल प्रिंटर एक बार अटका; लेबल दोबारा छापा गया। Café résumé: no impact ✓ 𝛼';
  // What C3's server test encodes for this proposal: Buffer.from(JSON.stringify({outcome, justification}), 'utf8').toString('base64url').
  const SERVER_ENCODED =
    'eyJvdXRjb21lIjoiTk9fSU1QQUNUIiwianVzdGlmaWNhdGlvbiI6IuCksuClh-CkrOCksiDgpKrgpY3gpLDgpL_gpILgpJ_gpLAg4KSP4KSVIOCkrOCkvuCksCDgpIXgpJ_gpJXgpL47IOCksuClh-CkrOCksiDgpKbgpYvgpKzgpL7gpLDgpL4g4KSb4KS-4KSq4KS-IOCkl-Ckr-CkvuClpCBDYWbDqSByw6lzdW3DqTogbm8gaW1wYWN0IOKckyDwnZu8In0';
  const disposition = (justification: string) => ({ kind: 'ENGINE_COMMAND' as const, runId: RUN, expectedVersion: 7, intent: { type: 'DISPOSITION_EXCEPTION' as const, exception: 'EX-1', outcome: 'NO_IMPACT' as const, justification } });
  /** What the server's parseIntent does with the part after the bar (Buffer base64url, UTF-8, JSON). */
  const serverParse = (intent: string): unknown => JSON.parse(Buffer.from(intent.slice(intent.indexOf('|') + 1), 'base64url').toString('utf8'));
  /** The signed envelope of the exception as C3 binds it: the record plus proposedDisposition {outcome, justification, deviationRef}. */
  const boundHash = (p: { outcome: string; justification: string }) =>
    sha256Hex(canonicalJson({ aggregate_type: 'batch_exception', aggregate_id: `${RUN}:EX-1`, content_version: 3, content: { title: 'Label printer jammed', status: 'OPEN', proposedDisposition: { outcome: p.outcome, justification: p.justification, deviationRef: null } } }));

  it('[DI-37] every other signing previews the plain meaning', () => {
    expect(previewIntent('PERFORMED', { kind: 'ESIG_STUB', stubId: STUB })).toBe('PERFORMED');
    expect(previewIntent('VERIFIED', { kind: 'ENGINE_COMMAND', runId: RUN, expectedVersion: 7, intent: { type: 'VERIFY', stepKey: 'p-blend@', meaning: 'VERIFIED' } })).toBe('VERIFIED');
    expect(previewIntent('STAGE_SIGNED_OFF', { kind: 'ENGINE_COMMAND', runId: RUN, expectedVersion: 7, intent: { type: 'SIGN_OFF_STAGE', stageKey: 'ST-1@' } })).toBe('STAGE_SIGNED_OFF');
  });

  it('[DI-37][PR-45] P26/P38: a hold-point decision previews its disposition and comment (null when none) as the server reads them', () => {
    const hold = (comment?: string) => ({ kind: 'ENGINE_COMMAND' as const, runId: RUN, expectedVersion: 7, intent: { type: 'DISPOSITION_HOLD_POINT' as const, stepKey: 'H-BLEND@', disposition: 'APPROVED_WITH_CONDITIONS', ...(comment !== undefined ? { comment } : {}) } });
    const withComment = previewIntent('HOLD_POINT_RELEASED', hold('Release only after the hardness retest passes'));
    expect(withComment).toMatch(/^HOLD_POINT_RELEASED\|[A-Za-z0-9_-]+$/);
    expect(serverParse(withComment)).toEqual({ disposition: 'APPROVED_WITH_CONDITIONS', comment: 'Release only after the hardness retest passes' });
    expect(serverParse(previewIntent('HOLD_POINT_RELEASED', hold()))).toEqual({ disposition: 'APPROVED_WITH_CONDITIONS', comment: null });
  });

  it('[DI-37] a disposition previews its proposal byte for byte as the server encodes it; non-ASCII text round-trips through the server parser', () => {
    const intent = previewIntent('EXCEPTION_DISPOSITIONED', disposition(JUSTIFICATION));
    expect(intent).toBe(`EXCEPTION_DISPOSITIONED|${SERVER_ENCODED}`);
    expect(intent).toMatch(/^EXCEPTION_DISPOSITIONED\|[A-Za-z0-9_-]+$/);
    expect(serverParse(intent)).toEqual({ outcome: 'NO_IMPACT', justification: JUSTIFICATION });
    // A lone surrogate is escaped by JSON.stringify, so it too comes back unchanged (never replaced).
    const odd = 'half a pair: \ud800 end';
    expect(serverParse(previewIntent('EXCEPTION_DISPOSITIONED', disposition(odd)))).toEqual({ outcome: 'NO_IMPACT', justification: odd });
    expect(base64UrlOfUtf8('')).toBe('');
    expect(base64UrlOfUtf8('é')).toBe(Buffer.from('é', 'utf8').toString('base64url'));
  });

  it('[DI-37] the previewed proposal gives the hash the challenge binds for the same action', () => {
    const action = disposition(JUSTIFICATION);
    const previewed = serverParse(previewIntent('EXCEPTION_DISPOSITIONED', action)) as { outcome: string; justification: string };
    expect(boundHash(previewed)).toBe(boundHash(action.intent));
    // Any other text is another hash: the server refuses the challenge (EBMR-ESIG-013) instead of signing it.
    expect(boundHash({ ...previewed, justification: `${JUSTIFICATION} ` })).not.toBe(boundHash(action.intent));
  });

  it('[DI-37][INV-03] the ceremony previews, challenges and signs one frozen action: a change to the caller\'s object afterwards is not sent', async () => {
    const text = JSON.stringify({ aggregate_type: 'batch_exception', aggregate_id: `${RUN}:EX-1`, content: { proposedDisposition: { outcome: 'NO_IMPACT', justification: JUSTIFICATION, deviationRef: null } }, content_version: 3 });
    const content: SignableContentView = {
      aggregateType: 'batch_exception',
      aggregateId: `${RUN}:EX-1`,
      contentVersion: '3',
      canonicalText: text,
      contentHash: sha256Hex(text),
      meaning: 'EXCEPTION_DISPOSITIONED',
      meaningText: 'I dispositioned this exception.',
      title: 'Exception dispositioned: Exception EX-1: Label printer jammed',
      preview: true,
      rendering: { kind: 'batch_exception', disposition: { proposed: { outcome: 'NO_IMPACT', justification: JUSTIFICATION, deviationRef: null } } },
    };
    const base = challenge(['PIN']);
    answers['GET /api/esig/content'] = content;
    answers['POST /api/esig/challenges'] = { ...base, aggregateType: 'batch_exception', aggregateId: `${RUN}:EX-1`, contentVersion: '3', contentHash: content.contentHash, meaning: 'EXCEPTION_DISPOSITIONED', manifestation: { ...base.manifestation, meaning: 'EXCEPTION_DISPOSITIONED' } };
    answers['POST /api/esig/sign'] = { manifestation: { ...manifestation(), aggregateType: 'batch_exception', aggregateId: `${RUN}:EX-1`, contentVersion: '3', contentHash: content.contentHash, meaning: 'EXCEPTION_DISPOSITIONED' }, result: null };
    const action = disposition(JUSTIFICATION);
    const request = { aggregateType: 'batch_exception', aggregateId: `${RUN}:EX-1`, meaning: 'EXCEPTION_DISPOSITIONED', action, title: 'Disposition exception EX-1' };
    const ports = renderPorts();
    let outcome: ReturnType<Ports['ceremony']['sign']> = Promise.resolve({ status: 'CANCELLED' });
    act(() => {
      outcome = ports.ceremony.sign(request);
    });
    const shown = await screen.findByRole('region', { name: 'Proposed disposition' });
    expect(within(shown).getByText(JUSTIFICATION)).toBeTruthy();
    expect(calls('/api/esig/content')[0]?.query).toEqual({ aggregateType: 'batch_exception', aggregateId: `${RUN}:EX-1`, intent: `EXCEPTION_DISPOSITIONED|${SERVER_ENCODED}` });
    // The caller's own object changes after the ceremony started: nothing of it reaches the challenge or the sign.
    action.intent.justification = 'Changed after the preview.';
    await userEvent.click(screen.getByRole('button', { name: 'Sign' }));
    await tapBadge('04A10000000001');
    await enterPin('Enter your PIN to sign', '482913');
    expect(await screen.findByText('Signed.')).toBeTruthy();
    const sent = disposition(JUSTIFICATION);
    expect(calls('/api/esig/challenges')[0]?.body).toMatchObject({ clientContentHash: content.contentHash, meaning: 'EXCEPTION_DISPOSITIONED', action: sent });
    expect(calls('/api/esig/sign')[0]?.body).toMatchObject({ action: sent });
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect((await outcome).status).toBe('SIGNED');
  });
});

describe('DEMO-ONLY signing page', () => {
  it('[DI-05] outside a demo installation the page offers nothing to sign', async () => {
    bootState.current = bootWith(KIOSK, { meta: { ...(EXAMPLES['meta-sandbox'].data as NonNullable<Boot['meta']>), demo: false } });
    render(<EsigDemoPage stub={STUB} meaning="PERFORMED" />);
    await waitFor(() => expect(screen.getByText('This page exists on demo installations only.')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /Sign/ })).toBeNull();
  });
});
