/**
 * Kiosk access and signing when the terminal cannot get a device nonce (Phase 2 exit review F08; DI-38, DI-20): the
 * request it was for is never sent, and the screen says so instead of failing without a word. A badge tap for an
 * entry keeps its prompt open with the reason and takes another tap; a signature is refused as "nothing was sent"
 * (never reconciled as a lost answer); a "Switch to <name>?" is refused and can be tried again (it used to hang).
 * The boot state is a test double; the API transport records every request.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '@ebmr/expr';
import { EXAMPLES } from '@ebmr/api-contract/examples';
import type { Attribution, ChallengeView, FetchLike, SessionView, SignableContentView } from '@ebmr/api-contract';
import type { Boot } from '../../src/app/boot.tsx';
import type { SignOutcome } from '../../src/app/ports.tsx';

const bootState: { current: Boot } = { current: undefined as unknown as Boot };
vi.mock('../../src/app/boot.tsx', () => ({ useBoot: () => bootState.current }));

const { setTransport } = await import('../../src/api/client.ts');
const { Provider } = await import('../../src/features/access/index.tsx');
const { useBadgeTap, useSignatureCeremony } = await import('../../src/app/ports.tsx');
type Ports = { tap: ReturnType<typeof useBadgeTap>; ceremony: ReturnType<typeof useSignatureCeremony> };

const KIOSK = EXAMPLES['session-kiosk'].data as SessionView;
const VERIFIER: SessionView = { ...KIOSK, person: { personId: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e61', legalName: 'TEST-Kavya Reddy', loginName: 'test-verifier-1', role: 'VERIFIER' }, role: 'VERIFIER', roles: ['VERIFIER'] };
const STUB = '6b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e';
const TEXT = `{"aggregate_id":"${STUB}","aggregate_type":"esig_stub","content":{"title":"Binder added","value":"12.503"},"content_version":1}`;
const CONTENT: SignableContentView = {
  aggregateType: 'esig_stub', aggregateId: STUB, contentVersion: '1', canonicalText: TEXT, contentHash: sha256Hex(TEXT), meaning: 'PERFORMED',
  meaningText: 'I performed this step and recorded its data.', title: 'Performed: Binder added', preview: false,
  rendering: { kind: 'fallback', state: 'OPEN', content: { title: 'Binder added', value: '12.503' } },
};
const CHALLENGE: ChallengeView = {
  challengeId: 'f6a7b8c9-d0e1-4f2a-9b3c-4d5e6f7a8b92', aggregateType: 'esig_stub', aggregateId: STUB, contentVersion: '1', contentHash: CONTENT.contentHash, meaning: 'PERFORMED',
  expiresAt: { us: '99999999999999999', text: 'far away' }, expiresInSeconds: 120, requires: ['PIN'],
  manifestation: { legalName: KIOSK.person.legalName, loginName: KIOSK.person.loginName, role: KIOSK.person.role, meaning: 'PERFORMED', meaningText: 'Performed by', zone: 'Asia/Kolkata' },
};
const SWITCH_USER = {
  status: 409,
  body: { refusal: { code: 'SWITCH_USER', kind: 'SWITCH_USER', whatHappened: 'Another person tapped.', why: '', controls: [], whatYouCanDo: [], whoCanHelp: [], details: { switchToLegalName: 'TEST-Kavya Reddy', switchToLoginName: 'test-verifier-1' } }, correlationId: 't', retryable: false },
};
const NOT_PROVEN = 'Nothing was sent: this terminal could not prove itself to the server.';

let recorded: { path: string; body: Record<string, unknown> | undefined }[] = [];
let answers: Record<string, unknown> = {};
let nonces = 0;
/** Whether the next nonce request is refused (429, the allowance used up: X34). */
let nonceDown = false;
let key: CryptoKeyPair;
let spki = '';

const unhandled: unknown[] = [];
const onUnhandled = (e: unknown) => {
  unhandled.push(e);
};

const isAnswer = (v: unknown): v is { status: number; body: unknown } => typeof v === 'object' && v !== null && 'status' in v && 'body' in v;

const transport: FetchLike = (url, init) => {
  const u = new URL(url, 'http://test.local');
  const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
  recorded.push({ path: u.pathname, body });
  let a: unknown;
  if (u.pathname === '/api/session/device-nonce') {
    nonces += 1;
    a = nonceDown
      ? { status: 429, body: { refusal: { code: 'RATE_LIMITED', kind: 'LOCKED', whatHappened: 'Too many requests in a short time.', why: '', controls: [], whatYouCanDo: ['Wait a minute and try again.'], whoCanHelp: [] }, correlationId: 't', retryable: true } }
      : { nonce: `nonce-${String(nonces).padStart(12, '0')}`, expiresInSeconds: 60 };
  } else {
    a = answers[`${init.method} ${u.pathname}`] ?? { status: 404, body: { refusal: { code: 'NOT_FOUND', kind: 'NOT_ENABLED', whatHappened: u.pathname, why: '', controls: [], whatYouCanDo: [], whoCanHelp: [] }, correlationId: 't', retryable: false } };
  }
  const { status, body: out } = isAnswer(a) ? a : { status: 200, body: a };
  return Promise.resolve({ status, headers: { get: () => null }, text: () => Promise.resolve(JSON.stringify(out)) });
};

function bootWith(session: SessionView): Boot {
  return {
    phase: 'ready', meta: null, deviceKey: { privateKey: key.privateKey, publicKeySpki: spki, label: session.device.deviceCode }, device: session.device, session, problem: null,
    restart: vi.fn(), setSession: vi.fn(), joinMarkedSignOut: vi.fn(() => false), signOut: vi.fn(() => Promise.resolve()), forgetTerminal: vi.fn(() => Promise.resolve()),
  };
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
  await userEvent.type(await screen.findByLabelText('Badge'), `${uid}{Enter}`);
}

async function enterPin(name: string, pin: string) {
  const pad = await screen.findByRole('group', { name });
  for (const d of pin) await userEvent.click(within(pad).getByRole('button', { name: d }));
  await userEvent.click(within(pad).getByRole('button', { name: 'OK' }));
}

const calls = (path: string) => recorded.filter((r) => r.path === path);

beforeAll(async () => {
  key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  spki = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('spki', key.publicKey))));
  process.prependListener('unhandledRejection', onUnhandled);
});
afterAll(() => {
  process.off('unhandledRejection', onUnhandled);
});
beforeEach(() => {
  recorded = [];
  answers = { 'GET /api/session': KIOSK };
  nonces = 0;
  nonceDown = false;
  unhandled.length = 0;
  setTransport(transport);
  bootState.current = bootWith(KIOSK);
});
afterEach(() => {
  window.localStorage.clear();
});

describe('F08: no device nonce on the kiosk', () => {
  it('[INV-40][DI-38][DI-20] a badge tap for an entry: the prompt says nothing was sent and takes another tap', async () => {
    const ports = renderPorts();
    let result: Promise<Attribution | null> = Promise.resolve(null);
    act(() => {
      result = ports.tap.requestTap('Confirm the start of step 2.1.4', { method: 'POST', path: '/api/test-runs/r-1/commands', body: { expectedVersion: 3 } });
    });
    nonceDown = true;
    await tapBadge('04A10000000001');
    expect(await screen.findByText(NOT_PROVEN)).toBeTruthy();
    expect(screen.getByText(/Too many requests in a short time/)).toBeTruthy();
    // The prompt is still open for this request, with an empty field.
    expect(screen.getByText('Confirm the start of step 2.1.4')).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Badge').value).toBe('');
    nonceDown = false;
    await tapBadge('04A10000000001');
    expect(await result).toMatchObject({ method: 'BADGE_TAP', badgeUid: '04A10000000001' });
    expect(unhandled.map(String)).toEqual([]);
  });

  it('[INV-10][DI-38][DI-20] a signature whose PIN cannot be sent with a proof is refused as nothing sent, never reconciled as a lost answer', async () => {
    answers['GET /api/esig/content'] = CONTENT;
    answers['POST /api/esig/challenges'] = CHALLENGE;
    answers['GET /api/esig/signatures'] = { signatures: [] };
    const ports = renderPorts();
    let outcome: Promise<SignOutcome> = Promise.resolve({ status: 'CANCELLED' });
    act(() => {
      outcome = ports.ceremony.sign({ aggregateType: 'esig_stub', aggregateId: STUB, meaning: 'PERFORMED', action: { kind: 'ESIG_STUB', stubId: STUB }, title: 'Sign entry as PERFORMED' });
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Sign' }));
    await tapBadge('04A10000000001');
    await screen.findByRole('group', { name: 'Enter your PIN to sign' });
    nonceDown = true;
    await enterPin('Enter your PIN to sign', '482913');
    expect(await screen.findByText(NOT_PROVEN)).toBeTruthy();
    expect(calls('/api/esig/sign')).toHaveLength(0);
    expect(calls('/api/esig/signatures')).toHaveLength(0);
    expect(screen.queryByText('The signature was not confirmed.')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(await outcome).toMatchObject({ status: 'REFUSED', refusal: { refusal: { code: 'NO_DEVICE_PROOF' } } });
    expect(unhandled.map(String)).toEqual([]);
  });

  it('[INV-40][DI-38][DI-20] "Switch to <name>?" whose PIN cannot be sent with a proof is refused and can be tried again', async () => {
    answers['GET /api/esig/content'] = CONTENT;
    answers['POST /api/esig/challenges'] = SWITCH_USER;
    answers['POST /api/session/switch'] = VERIFIER;
    const ports = renderPorts();
    act(() => {
      void ports.ceremony.sign({ aggregateType: 'esig_stub', aggregateId: STUB, meaning: 'PERFORMED', action: { kind: 'ESIG_STUB', stubId: STUB }, title: 'Sign entry as PERFORMED' });
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Sign' }));
    await tapBadge('04A10000000011');
    await screen.findByRole('group', { name: 'Enter the PIN of TEST-Kavya Reddy' });
    nonceDown = true;
    await enterPin('Enter the PIN of TEST-Kavya Reddy', '691357');
    expect(await screen.findByText(NOT_PROVEN)).toBeTruthy();
    expect(calls('/api/session/switch')).toHaveLength(0);
    nonceDown = false;
    await enterPin('Enter the PIN of TEST-Kavya Reddy', '691357');
    await waitFor(() => expect(calls('/api/session/switch')).toHaveLength(1));
    expect(calls('/api/session/switch')[0]?.body).toMatchObject({ badgeUid: '04A10000000011', pin: '691357' });
    expect(unhandled.map(String)).toEqual([]);
  });
});
