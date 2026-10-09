/**
 * The owner's refused first signing tap (Phase 2 exit review F56; demo item 4; DI-14, DI-19, DI-38): the signing
 * dialog asks "Tap your badge to sign as ..." above a focused masked Badge field that looks like the PIN step after
 * it. The PIN keyed there went out as the badge UID; the kernel refused it (EBMR-IAM-140, with a REFUSED attempt and a
 * MEDIUM security alert), and the signing ended with Close as its only button.
 * Now text that cannot be a badge UID is never sent (the prompt says so and waits for the badge), and a tap the server
 * refuses for the challenge returns to the tap with the refusal shown in the prompt, as a wrong PIN returns to the pad.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '@ebmr/expr';
import { EXAMPLES } from '@ebmr/api-contract/examples';
import type { ChallengeView, FetchLike, ManifestationView, SessionView, SignableContentView } from '@ebmr/api-contract';
import type { Boot } from '../../src/app/boot.tsx';
import type { SignOutcome } from '../../src/app/ports.tsx';

const bootState: { current: Boot } = { current: undefined as unknown as Boot };
vi.mock('../../src/app/boot.tsx', () => ({ useBoot: () => bootState.current }));

const { setTransport } = await import('../../src/api/client.ts');
const { Provider } = await import('../../src/features/access/index.tsx');
const { useSignatureCeremony } = await import('../../src/app/ports.tsx');

const KIOSK = EXAMPLES['session-kiosk'].data as SessionView;
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
const MANIFESTATION: ManifestationView = {
  signatureId: 'a7b8c9d0-e1f2-4a3b-8c4d-5e6f7a8b9c03', signer: KIOSK.person, meaning: 'PERFORMED', meaningText: 'Performed by',
  signedAt: { us: '1790586600000000', text: '28-SEP-2026 14:40:00 +05:30 (Asia/Kolkata)' }, zone: 'Asia/Kolkata', valid: true,
  aggregateType: 'esig_stub', aggregateId: STUB, contentVersion: '1', contentHash: CONTENT.contentHash,
};
/** As the server answers a badge the kernel does not know (attribution.ts tapNotAccepted). */
const NOT_ACCEPTED = {
  refusal: { code: 'EBMR-IAM-140', kind: 'AUTH_FAILED', whatHappened: 'The badge was not accepted.', why: 'The badge is unknown or not active, or its account cannot act on this terminal.', controls: ['DI-14', 'DI-19'], whatYouCanDo: ['Tap your own badge again.'], whoCanHelp: [] },
  correlationId: 't',
  retryable: true,
};

const sent: { path: string; body: Record<string, unknown> | undefined }[] = [];
/** The badge UIDs the server knows; any other tap for the challenge is refused. */
let known = new Set<string>();
let nonces = 0;
let key: CryptoKeyPair;
let spki = '';

const transport: FetchLike = (url, init) => {
  const u = new URL(url, 'http://test.local');
  const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
  sent.push({ path: u.pathname, body });
  let status = 200;
  let answer: unknown = KIOSK;
  if (u.pathname === '/api/session/device-nonce') answer = { nonce: `nonce-${String((nonces += 1)).padStart(12, '0')}`, expiresInSeconds: 60 };
  else if (u.pathname === '/api/esig/content') answer = CONTENT;
  else if (u.pathname === '/api/esig/challenges') {
    const uid = (body?.['attribution'] as { badgeUid?: string } | undefined)?.badgeUid ?? '';
    if (known.has(uid)) answer = CHALLENGE;
    else {
      status = 401;
      answer = NOT_ACCEPTED;
    }
  } else if (u.pathname === '/api/esig/sign') answer = { manifestation: MANIFESTATION, result: null };
  return Promise.resolve({ status, headers: { get: () => null }, text: () => Promise.resolve(JSON.stringify(answer)) });
};

const challenges = () => sent.filter((s) => s.path === '/api/esig/challenges');

beforeAll(async () => {
  key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  spki = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('spki', key.publicKey))));
});
beforeEach(() => {
  sent.length = 0;
  nonces = 0;
  known = new Set(['04A10000000001']);
  setTransport(transport);
  bootState.current = {
    phase: 'ready', meta: null, deviceKey: { privateKey: key.privateKey, publicKeySpki: spki, label: KIOSK.device.deviceCode }, device: KIOSK.device, session: KIOSK, problem: null,
    restart: vi.fn(), setSession: vi.fn(), joinMarkedSignOut: vi.fn(() => false), signOut: vi.fn(() => Promise.resolve()), forgetTerminal: vi.fn(() => Promise.resolve()), showBrowserSignIn: vi.fn(),
  } as unknown as Boot;
});

function startSigning(): { outcome: () => Promise<SignOutcome> } {
  const ports = {} as { ceremony: ReturnType<typeof useSignatureCeremony> };
  function Harness() {
    ports.ceremony = useSignatureCeremony();
    return null;
  }
  render(
    <Provider>
      <Harness />
    </Provider>,
  );
  let outcome: Promise<SignOutcome> = Promise.resolve({ status: 'CANCELLED' });
  act(() => {
    outcome = ports.ceremony.sign({ aggregateType: 'esig_stub', aggregateId: STUB, meaning: 'PERFORMED', action: { kind: 'ESIG_STUB', stubId: STUB }, title: 'Sign entry as PERFORMED' });
  });
  return { outcome: () => outcome };
}

describe('F56: the signing badge prompt', () => {
  it('[DI-14][DI-38][DI-19] a PIN keyed into the focused Badge field is not sent as a badge UID: the prompt says so and waits for the badge', async () => {
    startSigning();
    await userEvent.click(await screen.findByRole('button', { name: 'Sign' }));
    const field = await screen.findByLabelText('Badge');
    expect(document.activeElement).toBe(field);
    await userEvent.keyboard('482913{Enter}');
    expect(await screen.findByText('That is not a badge. Nothing was sent: tap your badge on the reader.')).toBeTruthy();
    expect(challenges()).toEqual([]);
    expect(sent.filter((s) => s.path === '/api/session/device-nonce')).toEqual([]);
    // The prompt still waits for the badge, and the reader's tap goes on to the PIN.
    await userEvent.type(screen.getByLabelText('Badge'), '04A10000000001{Enter}');
    expect(await screen.findByRole('group', { name: 'Enter your PIN to sign' })).toBeTruthy();
    expect(challenges()).toHaveLength(1);
    expect((challenges()[0]?.body?.['attribution'] as { badgeUid?: string }).badgeUid).toBe('04A10000000001');
  });

  it('[DI-14][DI-38][DI-19] BADGE-AUTOFILL: a saved ten-digit secret a browser or password manager fills into the signing Badge field is not sent, although it reads as a badge UID; the reader\'s tap then goes on to the PIN', async () => {
    startSigning();
    await userEvent.click(await screen.findByRole('button', { name: 'Sign' }));
    const field = await screen.findByLabelText<HTMLInputElement>('Badge');
    expect([field.getAttribute('autocomplete'), field.getAttribute('data-1p-ignore'), field.getAttribute('data-lpignore'), field.getAttribute('data-bwignore')]).toEqual(['one-time-code', 'true', 'true', 'true']);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, '4829137065');
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByText('That was not a tap of the reader: it was filled in or pasted. Nothing was sent: tap your badge on the reader.')).toBeTruthy();
    expect(challenges()).toEqual([]);
    expect(sent.filter((s) => s.path === '/api/session/device-nonce')).toEqual([]);
    expect(field.value).toBe('');
    await userEvent.type(screen.getByLabelText('Badge'), '04A10000000001{Enter}');
    expect(await screen.findByRole('group', { name: 'Enter your PIN to sign' })).toBeTruthy();
    expect(challenges().map((c) => (c.body?.['attribution'] as { badgeUid?: string }).badgeUid)).toEqual(['04A10000000001']);
  });

  it('[DI-14][DI-38][DI-19] a badge the server does not accept returns to the tap with the refusal in the prompt, never to Close only; the next tap signs', async () => {
    const { outcome } = startSigning();
    await userEvent.click(await screen.findByRole('button', { name: 'Sign' }));
    await userEvent.type(await screen.findByLabelText('Badge'), '04A1000000FFFF{Enter}');
    expect(await screen.findByText('The badge was not accepted.')).toBeTruthy();
    expect(screen.getByText('What you can do: Tap your own badge again.')).toBeTruthy();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText<HTMLInputElement>('Badge').value).toBe('');
    expect(within(dialog).getAllByRole('button').map((b) => b.textContent)).toEqual(expect.arrayContaining(['Continue', 'Cancel']));
    expect(within(dialog).queryByRole('button', { name: 'Close' })).toBeNull();
    expect(challenges()).toHaveLength(1);

    await userEvent.type(within(dialog).getByLabelText('Badge'), '04A10000000001{Enter}');
    const pad = await screen.findByRole('group', { name: 'Enter your PIN to sign' });
    expect(screen.queryByText('The badge was not accepted.')).toBeNull();
    for (const d of '482913') await userEvent.click(within(pad).getByRole('button', { name: d }));
    await userEvent.click(within(pad).getByRole('button', { name: 'OK' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Close' }));
    await waitFor(async () => expect((await outcome()).status).toBe('SIGNED'));
    expect(challenges()).toHaveLength(2);
  });
});
