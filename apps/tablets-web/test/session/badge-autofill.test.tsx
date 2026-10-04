/**
 * The kiosk sends no secret a browser or password manager filled in (Phase 2 exit follow-up BADGE-AUTOFILL; DI-14,
 * DI-15, DI-19, DI-38; F56 verifier and critic, gap 3: password-manager autofill into the kiosk Badge and PIN fields).
 *
 * Before, a saved ten-digit secret filled into the kiosk's Badge field went out as a badge UID with Enter (the kernel
 * refused it as an unknown badge and raised a security alert), and the first-login change took a new PIN filled in
 * or pasted, one its owner may not know and the shared kiosk browser may keep. Now the Badge field and the new-PIN
 * fields ask browsers and password managers to leave them alone, and what reached them otherwise than typed key by key
 * is never sent: the screen says why and waits for the reader's tap or the typed PIN.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EXAMPLES } from '@ebmr/api-contract/examples';
import type { SessionView } from '@ebmr/api-contract';
import { identity } from '@ebmr/ui-kit';

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

const kiosk = EXAMPLES['session-kiosk'].data as SessionView;
const TICKET = 'Change-Ticket-7f3a9c21e04b';
const SAVED = '4829137065';
const UID = '04A10000000A0A';
const PIN_TYPED = 'A PIN is typed here key by key, never filled in by the browser or a password manager, nor pasted. Nothing was sent: type the new PIN.';
const envelope = (code: string, kind: string, whatHappened: string, details?: Record<string, string>) => ({
  refusal: { code, kind, whatHappened, why: '', controls: [], whatYouCanDo: [], whoCanHelp: [], ...(details ? { details } : {}) },
  correlationId: 'fixture',
  retryable: false,
});

type Body = Record<string, unknown>;

/** A signed-out kiosk whose every sign-in asks for a first-login PIN change; every request is recorded. */
function kioskServer() {
  const logins: Body[] = [];
  const changes: Body[] = [];
  const fetch = createFixtureFetch(
    {
      'meta.get': EXAMPLES['meta-sandbox'].data,
      'session.deviceNonce': { nonce: 'fixture-nonce-0123456789', expiresInSeconds: 60 },
      'session.identify': kiosk.device,
      'session.demoDevices': { devices: [] },
      'session.get': { status: 401, body: envelope('NO_SESSION', 'NOT_ALLOWED', 'You are not signed in on this installation.') },
      'session.login': ({ body }: { body: unknown }) => {
        logins.push(body as Body);
        return { status: 409, body: envelope('MUST_CHANGE_SECRET', 'NOT_ALLOWED', 'You must choose a new password or PIN before you continue.', { kind: 'PIN', changeTicket: TICKET }) };
      },
      'session.changeSecret': ({ body }: { body: unknown }) => {
        changes.push(body as Body);
        return { changed: true };
      },
    },
    { installation: 'SANDBOX' },
  );
  return { logins, changes, fetch };
}

/** Fills a field as a browser's autofill does: the value through the native setter, then input and change events. */
function autofill(el: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

const optOut = (el: HTMLElement) => ({
  autocomplete: el.getAttribute('autocomplete'),
  onePassword: el.getAttribute('data-1p-ignore'),
  lastPass: el.getAttribute('data-lpignore'),
  bitwarden: el.getAttribute('data-bwignore'),
  dashlane: el.getAttribute('data-form-type'),
});
const OPTED_OUT = { autocomplete: 'one-time-code', onePassword: 'true', lastPass: 'true', bitwarden: 'true', dashlane: 'other' };

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const spki = Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64');
  holder.key = { privateKey: pair.privateKey, publicKeySpki: spki, label: 'PC-DESIGN-01' };
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('BADGE-AUTOFILL: the kiosk sends no secret a browser or password manager filled in', () => {
  it('[DI-14][DI-19][DI-38] kiosk sign-in: a saved ten-digit secret autofilled into the Badge field is not sent with Enter, although it reads as a badge UID; the reader\'s tap then signs in', async () => {
    const server = kioskServer();
    setTransport(server.fetch);
    render(
      <BootProvider>
        <Gate />
      </BootProvider>,
    );
    const badge = await screen.findByLabelText<HTMLInputElement>('Badge');
    expect(optOut(badge)).toEqual(OPTED_OUT);
    badge.focus();
    autofill(badge, SAVED);
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByText(identity.NOT_TAPPED)).toBeTruthy();
    expect(server.logins).toEqual([]);
    expect(badge.value).toBe('');
    // The reader's tap goes on to the PIN and signs in with the reader's UID only.
    await userEvent.type(screen.getByLabelText<HTMLInputElement>('Badge'), `${UID}{Enter}`);
    await screen.findByRole('group', { name: 'Enter your PIN' });
    for (const d of '482913') await userEvent.click(screen.getByRole('button', { name: d }));
    await userEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(await screen.findByRole('heading', { name: 'Choose a new PIN' })).toBeTruthy();
    expect(server.logins).toHaveLength(1);
    expect(server.logins[0]).toMatchObject({ method: 'BADGE_PIN', identifier: UID, secret: '482913' });
  });

  it('[DI-15][DI-19][DI-38] kiosk first-login change: a new PIN filled in or pasted is not taken (no badge is asked for, nothing is sent); typed key by key it is', async () => {
    const server = kioskServer();
    setTransport(server.fetch);
    render(
      <BootProvider>
        <Gate />
      </BootProvider>,
    );
    await userEvent.type(await screen.findByLabelText<HTMLInputElement>('Badge'), `${UID}{Enter}`);
    await screen.findByRole('group', { name: 'Enter your PIN' });
    for (const d of '482913') await userEvent.click(screen.getByRole('button', { name: d }));
    await userEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(await screen.findByRole('heading', { name: 'Choose a new PIN' })).toBeTruthy();
    const first = screen.getByLabelText<HTMLInputElement>('New PIN');
    const second = screen.getByLabelText<HTMLInputElement>('Repeat the new PIN');
    expect([optOut(first), optOut(second)]).toEqual([OPTED_OUT, OPTED_OUT]);

    // Both fields filled in by a password manager.
    autofill(first, '731904');
    autofill(second, '731904');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText(PIN_TYPED)).toBeTruthy();
    expect(screen.queryByText('Tap your badge to confirm your new PIN.')).toBeNull();
    expect([first.value, second.value]).toEqual(['', '']);
    // One typed, the other pasted.
    await userEvent.type(first, '731904');
    second.focus();
    await userEvent.paste('731904');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText(PIN_TYPED)).toBeTruthy();
    expect(screen.queryByText('Tap your badge to confirm your new PIN.')).toBeNull();
    expect(server.changes).toEqual([]);

    // Typed key by key: the badge is asked for to confirm it, and the change is sent with the reader's tap.
    await userEvent.type(screen.getByLabelText<HTMLInputElement>('New PIN'), '731904');
    await userEvent.type(screen.getByLabelText<HTMLInputElement>('Repeat the new PIN'), '731904');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Tap your badge to confirm your new PIN.')).toBeTruthy();
    expect(screen.queryByText(PIN_TYPED)).toBeNull();
    await userEvent.type(screen.getByLabelText<HTMLInputElement>('Badge'), `${UID}{Enter}`);
    expect(await screen.findByText('Your new PIN is set. Sign in with it now.')).toBeTruthy();
    expect(server.changes).toHaveLength(1);
    expect(server.changes[0]).toMatchObject({ identifier: UID, changeTicket: TICKET, newSecret: '731904' });
  });

  it('[DI-15][DI-19][DI-38] BADGE-AUTOFILL round 3: kiosk first-login change: a new PIN inserted with no key before it (the trusted insertText Chromium makes for document.execCommand(\'insertText\')) or set with no event at all is not taken (no badge is asked for, nothing is sent); typed key by key it is', async () => {
    const server = kioskServer();
    setTransport(server.fetch);
    render(
      <BootProvider>
        <Gate />
      </BootProvider>,
    );
    await userEvent.type(await screen.findByLabelText<HTMLInputElement>('Badge'), `${UID}{Enter}`);
    await screen.findByRole('group', { name: 'Enter your PIN' });
    for (const d of '482913') await userEvent.click(screen.getByRole('button', { name: d }));
    await userEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(await screen.findByRole('heading', { name: 'Choose a new PIN' })).toBeTruthy();
    const first = screen.getByLabelText<HTMLInputElement>('New PIN');
    const second = screen.getByLabelText<HTMLInputElement>('Repeat the new PIN');
    const setNatively = (el: HTMLInputElement, value: string) => Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, value);
    // What document.execCommand('insertText') does in Chromium: the text and one trusted insertText input event, no key.
    const execInsertText = (el: HTMLInputElement, text: string) => {
      el.focus();
      setNatively(el, el.value + text);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    };
    const attempts: Record<string, (a: HTMLInputElement, b: HTMLInputElement) => Promise<void> | void> = {
      'both inserted with no key': (a, b) => {
        execInsertText(a, '731904');
        execInsertText(b, '731904');
      },
      'both set with no event': (a, b) => {
        setNatively(a, '731904');
        setNatively(b, '731904');
      },
      'one typed, the other inserted with no key': async (a, b) => {
        await userEvent.type(a, '731904');
        execInsertText(b, '731904');
      },
      'one typed, the other set with no event': async (a, b) => {
        await userEvent.type(a, '731904');
        setNatively(b, '731904');
      },
    };
    for (const [name, attempt] of Object.entries(attempts)) {
      await attempt(first, second);
      await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
      expect(screen.getByText(PIN_TYPED), name).toBeTruthy();
      expect(screen.queryByText('Tap your badge to confirm your new PIN.'), name).toBeNull();
      expect([first.value, second.value], `${name}: both fields are emptied`).toEqual(['', '']);
    }
    expect(server.changes).toEqual([]);
    // Typed key by key: the badge is asked for to confirm it.
    await userEvent.type(first, '731904');
    await userEvent.type(second, '731904');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Tap your badge to confirm your new PIN.')).toBeTruthy();
    expect(server.changes).toEqual([]);
  });

  it('[DI-15][DI-19][DI-38] BADGE-AUTOFILL round 4: kiosk first-login change: a new PIN mostly set with no event and finished by a real key, a real Backspace or a deletion no key brought is not taken (no badge is asked for, nothing is sent); typed key by key it is, and the change sends the typed PIN', async () => {
    const server = kioskServer();
    setTransport(server.fetch);
    render(
      <BootProvider>
        <Gate />
      </BootProvider>,
    );
    await userEvent.type(await screen.findByLabelText<HTMLInputElement>('Badge'), `${UID}{Enter}`);
    await screen.findByRole('group', { name: 'Enter your PIN' });
    for (const d of '482913') await userEvent.click(screen.getByRole('button', { name: d }));
    await userEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(await screen.findByRole('heading', { name: 'Choose a new PIN' })).toBeTruthy();
    const first = screen.getByLabelText<HTMLInputElement>('New PIN');
    const second = screen.getByLabelText<HTMLInputElement>('Repeat the new PIN');
    const setNatively = (el: HTMLInputElement, value: string) => Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, value);
    // A value a script or password manager sets with no event; the browser puts the caret at its end.
    const setSilently = (el: HTMLInputElement, value: string) => {
      el.focus();
      setNatively(el, value);
      el.setSelectionRange(value.length, value.length);
    };
    // A real key as the browser handles it (userEvent keeps its own copy of the value, which a silent set does not
    // reach): keydown, its character or Backspace's deletion at the caret, one input event, keyup.
    const press = (el: HTMLInputElement, key: string) => {
      fireEvent.keyDown(el, { key });
      const at = el.selectionStart ?? el.value.length;
      if (key === 'Backspace') {
        setNatively(el, el.value.slice(0, at - 1) + el.value.slice(at));
        el.setSelectionRange(at - 1, at - 1);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      } else {
        setNatively(el, el.value.slice(0, at) + key + el.value.slice(at));
        el.setSelectionRange(at + 1, at + 1);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: key }));
      }
      fireEvent.keyUp(el, { key });
    };
    // What document.execCommand('delete') does in Chromium: one character less and a trusted deletion, no key.
    const execDelete = (el: HTMLInputElement) => {
      setNatively(el, el.value.slice(0, -1));
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    };
    const attempts: Record<string, (el: HTMLInputElement) => void> = {
      // The lane verifier's probe: '73190' set with no event in each field and '4' typed after it.
      'set with no event, then a real key': (el) => {
        setSilently(el, '73190');
        press(el, '4');
      },
      'set with no event, then a real Backspace': (el) => {
        setSilently(el, '7319045');
        press(el, 'Backspace');
      },
      'set with no event, then a deletion no key brought': (el) => {
        setSilently(el, '7319045');
        execDelete(el);
      },
    };
    for (const [name, attempt] of Object.entries(attempts)) {
      attempt(first);
      attempt(second);
      expect([first.value, second.value], `${name}: the PIN reached both fields`).toEqual(['731904', '731904']);
      await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
      expect(screen.getByText(PIN_TYPED), name).toBeTruthy();
      expect(screen.queryByText('Tap your badge to confirm your new PIN.'), name).toBeNull();
      expect([first.value, second.value], `${name}: both fields are emptied`).toEqual(['', '']);
    }
    expect(server.changes).toEqual([]);
    // Typed key by key (a typing slip deleted with a real Backspace included): the badge is asked for, and the change
    // sends what was typed.
    for (const ch of '7319045') press(first, ch);
    press(first, 'Backspace');
    for (const ch of '731904') press(second, ch);
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Tap your badge to confirm your new PIN.')).toBeTruthy();
    expect(screen.queryByText(PIN_TYPED)).toBeNull();
    await userEvent.type(screen.getByLabelText<HTMLInputElement>('Badge'), `${UID}{Enter}`);
    expect(await screen.findByText('Your new PIN is set. Sign in with it now.')).toBeTruthy();
    expect(server.changes).toHaveLength(1);
    expect(server.changes[0]).toMatchObject({ identifier: UID, changeTicket: TICKET, newSecret: '731904' });
  });
});
