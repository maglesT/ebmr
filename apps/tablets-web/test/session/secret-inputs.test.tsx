/**
 * Sign-in secrets (review CN2; plan sections 5 and 6; DI-38, DI-15, DI-19, decision D7): the password of the office
 * sign-in, the new password or PIN of the first-login change and the badge UID of the kiosk sign-in are handed over
 * once and are then gone: not in the input's value, not in its value attribute, not in the document, not in browser
 * storage, not in any React state or props, and not written back by the next render (the busy flag, a refusal, the
 * "entries differ" warning). The change ticket and the badge UID of a first-login change wait in a ref (never in
 * React state) and are wiped when the change ends. A refused attempt leaves empty fields, so pressing the button
 * again does not resend it.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EXAMPLES } from '@ebmr/api-contract/examples';
import type { SessionView } from '@ebmr/api-contract';
import { identity } from '@ebmr/ui-kit';
import { domTraces, reactTraces, storageTraces } from '../../../../packages/ui-kit/test/support/secret-traces.ts';

const holder = vi.hoisted(() => ({ key: null as null | { privateKey: CryptoKey; publicKeySpki: string; label: string } }));
vi.mock('../../src/device/keystore.ts', () => ({
  loadDeviceKey: () => Promise.resolve(holder.key),
  saveDeviceKey: () => Promise.resolve(),
  forgetDeviceKey: () => Promise.resolve(),
  importDemoKey: () => Promise.reject(new Error('not used in this test')),
}));

const { setTransport } = await import('../../src/api/client.ts');
const { createFixtureFetch } = await import('../../src/api/fixture-fetch.ts');
const { BootProvider } = await import('../../src/app/boot.tsx');
const { Gate } = await import('../../src/app/App.tsx');
const { KEEP_BADGE_MS } = identity;

const office = EXAMPLES['session-office'].data as SessionView;
const kiosk = EXAMPLES['session-kiosk'].data as SessionView;
const TICKET = 'Change-Ticket-7f3a9c21e04b';
const envelope = (code: string, kind: string, whatHappened: string, details?: Record<string, string>) => ({
  refusal: { code, kind, whatHappened, why: '', controls: [], whatYouCanDo: [], whoCanHelp: [], ...(details ? { details } : {}) },
  correlationId: 'fixture',
  retryable: false,
});
const NOT_ACCEPTED = 'The user ID or password was not accepted.';
const TOO_SHORT = 'The new password is too short.';

type Body = Record<string, unknown>;

/** A fixture server for a signed-out terminal: every login and change request is recorded. */
function fixtureServer(opts: { floor: boolean; login: (body: Body) => unknown; change?: (body: Body) => unknown }) {
  const logins: Body[] = [];
  const changes: Body[] = [];
  const fetch = createFixtureFetch(
    {
      'meta.get': opts.floor ? EXAMPLES['meta-sandbox'].data : EXAMPLES['meta-gmp'].data,
      'session.deviceNonce': { nonce: 'fixture-nonce-0123456789', expiresInSeconds: 60 },
      'session.identify': opts.floor ? kiosk.device : office.device,
      'session.demoDevices': { devices: [] },
      'session.get': { status: 401, body: envelope('NO_SESSION', 'NOT_ALLOWED', 'You are not signed in on this installation.') },
      'session.login': ({ body }: { body: unknown }) => {
        logins.push(body as Body);
        return opts.login(body as Body);
      },
      'session.changeSecret': ({ body }: { body: unknown }) => {
        changes.push(body as Body);
        return opts.change ? opts.change(body as Body) : { changed: true };
      },
    },
    { installation: opts.floor ? 'SANDBOX' : 'GMP' },
  );
  return { logins, changes, fetch };
}

function renderGate() {
  render(
    <BootProvider>
      <Gate />
    </BootProvider>,
  );
}

/** Nothing of the secret is left in the field, the document or React. */
function expectGone(input: HTMLInputElement, secret: string) {
  expect(domTraces(input, secret), 'DOM').toEqual([]);
  expect(storageTraces(secret), 'browser storage (D7)').toEqual([]);
  expect(reactTraces(secret), 'React state, props and refs').toEqual([]);
  expect(input.value, 'the field after clearing').toBe('');
  expect(input.getAttribute('value'), 'value attribute').toBeNull();
}

/** Not in the document or in React state and props (a ref may hold it until the flow ends). */
function expectOnlyInRefs(secret: string) {
  expect(document.documentElement.outerHTML.includes(secret), 'document HTML').toBe(false);
  expect(storageTraces(secret), 'browser storage (D7)').toEqual([]);
  expect(reactTraces(secret, { allowRefs: true }), 'React state and props').toEqual([]);
}

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const spki = Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64');
  holder.key = { privateKey: pair.privateKey, publicKeySpki: spki, label: 'PC-DESIGN-01' };
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  window.localStorage.clear();
});

describe('CN2: sign-in secrets stay cleared', () => {
  it('[DI-38][DI-19] office sign-in: a refused password is gone from the field, the DOM and React, and is not sent again', async () => {
    const SECRET = 'Near-Correct-Pw-3';
    const server = fixtureServer({ floor: false, login: () => ({ status: 401, body: envelope('EBMR-AUTH-001', 'AUTH_FAILED', NOT_ACCEPTED) }) });
    setTransport(server.fetch);
    renderGate();
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    const pw = screen.getByLabelText<HTMLInputElement>('Password');
    await userEvent.type(screen.getByLabelText<HTMLInputElement>('User ID'), 'asha.rao');
    await userEvent.type(pw, SECRET);
    expect(reactTraces(SECRET), 'while typing').toEqual([]);
    expect(pw.getAttribute('value')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(NOT_ACCEPTED)).toBeTruthy();
    expect(server.logins).toHaveLength(1);
    expect(server.logins[0]).toMatchObject({ method: 'PASSWORD', identifier: 'asha.rao', secret: SECRET });
    // The busy flag and the refusal re-rendered the form: the password must not have come back.
    expectGone(screen.getByLabelText<HTMLInputElement>('Password'), SECRET);
    // Signing in again with the emptied field sends nothing (no second attempt counts toward the lockout), also
    // when the submit skips the browser's own required-field check (a script or an extension submitting the form).
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    fireEvent.submit(screen.getByRole('form', { name: 'Sign in' }));
    await new Promise((r) => setTimeout(r, 50));
    expect(server.logins).toHaveLength(1);
    expectGone(screen.getByLabelText<HTMLInputElement>('Password'), SECRET);
  });

  it('[DI-38][DI-15] first-login change: new secrets are gone after "entries differ", after a refusal and after success; the ticket never enters React state', async () => {
    const INITIAL = 'Initial-Pw-4';
    const [A, B, C] = ['New-Secret-Aaa-5', 'New-Secret-Bbb-6', 'New-Secret-Ccc-7'];
    const server = fixtureServer({
      floor: false,
      login: () => ({ status: 409, body: envelope('MUST_CHANGE_SECRET', 'NOT_ALLOWED', 'You must choose a new password or PIN before you continue.', { kind: 'PASSWORD', changeTicket: TICKET }) }),
      change: (body) => (body['newSecret'] === A ? { status: 422, body: envelope('EBMR-IAM-150', 'INVALID_INPUT', TOO_SHORT) } : { changed: true }),
    });
    setTransport(server.fetch);
    renderGate();
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    await userEvent.type(screen.getByLabelText<HTMLInputElement>('User ID'), 'asha.rao');
    await userEvent.type(screen.getByLabelText<HTMLInputElement>('Password'), INITIAL);
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Choose a new password' })).toBeTruthy();
    expect(reactTraces(INITIAL)).toEqual([]);
    expect(document.documentElement.outerHTML).not.toContain(INITIAL);
    expectOnlyInRefs(TICKET);

    const first = () => screen.getByLabelText<HTMLInputElement>('New password');
    const second = () => screen.getByLabelText<HTMLInputElement>('Repeat the new password');
    // Two different entries: warned, nothing sent, both fields empty and nothing written back.
    await userEvent.type(first(), A);
    await userEvent.type(second(), B);
    expect(reactTraces(A), 'while typing').toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('The two entries differ.')).toBeTruthy();
    expect(server.changes).toHaveLength(0);
    expectGone(first(), A);
    expectGone(second(), B);

    // Refused by the server: the refusal is shown, both fields stay empty.
    await userEvent.type(first(), A);
    await userEvent.type(second(), A);
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText(TOO_SHORT)).toBeTruthy();
    expect(server.changes).toHaveLength(1);
    expect(server.changes[0]).toMatchObject({ method: 'PASSWORD', identifier: 'asha.rao', changeTicket: TICKET, newSecret: A, kind: 'PASSWORD' });
    expectGone(first(), A);
    expectGone(second(), A);
    expectOnlyInRefs(TICKET);

    // Accepted: back to the sign-in form; the new secret and the ticket are gone everywhere, refs included.
    await userEvent.type(first(), C);
    await userEvent.type(second(), C);
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Your new password is set. Sign in with it now.')).toBeTruthy();
    expect(server.changes).toHaveLength(2);
    expect(server.changes[1]).toMatchObject({ changeTicket: TICKET, newSecret: C });
    for (const s of [A, B, C, INITIAL, TICKET]) {
      expect(document.documentElement.outerHTML.includes(s), s).toBe(false);
      expect(storageTraces(s), s).toEqual([]);
      expect(reactTraces(s), s).toEqual([]);
    }
  });

  it('[INV-40][DI-38][DI-15] kiosk sign-in: the badge UID is gone after Enter and never enters React state, also when a first-login change follows', async () => {
    const UID = '04A1000000FACE';
    const server = fixtureServer({
      floor: true,
      login: () => ({ status: 409, body: envelope('MUST_CHANGE_SECRET', 'NOT_ALLOWED', 'You must choose a new password or PIN before you continue.', { kind: 'PIN', changeTicket: TICKET }) }),
    });
    setTransport(server.fetch);
    renderGate();
    const badge = await screen.findByLabelText<HTMLInputElement>('Badge');
    await userEvent.type(badge, UID);
    expect(reactTraces(UID), 'while typing').toEqual([]);
    await userEvent.type(badge, '{Enter}');
    const pad = await screen.findByRole('group', { name: 'Enter your PIN' });
    // Between the badge and the PIN the UID waits in a ref only.
    expectOnlyInRefs(UID);
    expect(badge.value).toBe('');
    for (const d of '482913') await userEvent.click(screen.getByRole('button', { name: d }));
    expect(pad.textContent).not.toContain('482913');
    await userEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(await screen.findByRole('heading', { name: 'Choose a new PIN' })).toBeTruthy();
    expect(server.logins[0]).toMatchObject({ method: 'BADGE_PIN', identifier: UID, secret: '482913' });
    // The change needs the badge UID and the ticket again: they wait in a ref, never in React state or the DOM.
    expectOnlyInRefs(UID);
    expectOnlyInRefs(TICKET);
    await userEvent.type(screen.getByLabelText<HTMLInputElement>('New PIN'), '731904');
    await userEvent.type(screen.getByLabelText<HTMLInputElement>('Repeat the new PIN'), '731904');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Your new PIN is set. Sign in with it now.')).toBeTruthy();
    expect(server.changes[0]).toMatchObject({ method: 'BADGE_PIN', identifier: UID, changeTicket: TICKET, newSecret: '731904', kind: 'PIN' });
    await waitFor(() => expect(screen.getByLabelText<HTMLInputElement>('Badge')).toBeTruthy());
    for (const s of [UID, TICKET, '731904']) {
      expect(document.documentElement.outerHTML.includes(s), s).toBe(false);
      expect(storageTraces(s), s).toEqual([]);
      expect(reactTraces(s), s).toEqual([]);
    }
  });

  it('[INV-40][DI-38] kiosk sign-in: a badge left waiting at the PIN step is wiped after KEEP_BADGE_MS, and the screen asks for a badge again', async () => {
    const UID = '04A1000000A11E';
    const server = fixtureServer({ floor: true, login: () => ({ status: 401, body: envelope('AUTH_FAILED', 'AUTH_FAILED', 'The badge or PIN was not accepted.') }) });
    setTransport(server.fetch);
    renderGate();
    const field = await screen.findByLabelText<HTMLInputElement>('Badge');
    // The badge's time limit runs on a fake clock that also follows real time (the page keeps working).
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    await userEvent.type(field, `${UID}{Enter}`);
    await screen.findByRole('group', { name: 'Enter your PIN' });
    expectOnlyInRefs(UID);

    // The person walks away without entering the PIN.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(KEEP_BADGE_MS);
    });
    expect(screen.queryByRole('group', { name: 'Enter your PIN' })).toBeNull();
    expect(await screen.findByLabelText('Badge')).toBeTruthy();
    expect(reactTraces(UID), 'anywhere in React, refs included').toEqual([]);
    expect(document.documentElement.outerHTML.includes(UID)).toBe(false);
    expect(server.logins).toHaveLength(0);
  });

  it('[DI-38][DI-15] cancelling a first-login change wipes the ticket and the identifier', async () => {
    const UID = '04A1000000D00D';
    const server = fixtureServer({
      floor: true,
      login: () => ({ status: 409, body: envelope('MUST_CHANGE_SECRET', 'NOT_ALLOWED', 'You must choose a new password or PIN before you continue.', { kind: 'PIN', changeTicket: TICKET }) }),
    });
    setTransport(server.fetch);
    renderGate();
    await userEvent.type(await screen.findByLabelText<HTMLInputElement>('Badge'), `${UID}{Enter}`);
    await screen.findByRole('group', { name: 'Enter your PIN' });
    for (const d of '1357') await userEvent.click(screen.getByRole('button', { name: d }));
    await userEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(await screen.findByRole('heading', { name: 'Choose a new PIN' })).toBeTruthy();
    await userEvent.type(screen.getByLabelText<HTMLInputElement>('New PIN'), '2468');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Choose a new PIN' })).toBeNull());
    expect(server.changes).toHaveLength(0);
    for (const s of [UID, TICKET, '2468']) {
      expect(document.documentElement.outerHTML.includes(s), s).toBe(false);
      expect(storageTraces(s), s).toEqual([]);
      expect(reactTraces(s), s).toEqual([]);
    }
  });
});
