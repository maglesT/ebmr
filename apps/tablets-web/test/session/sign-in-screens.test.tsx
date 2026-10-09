/**
 * What the sign-in screens say (Phase 2 exit review, session-audit-ui): the installation a kiosk belongs to (F09), an
 * account with no role that is valid now (F10), and a terminal that cannot get a device nonce (F08). Each test runs the
 * real Gate against a fixture server.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EXAMPLES } from '@ebmr/api-contract/examples';
import type { FetchLike, SessionView } from '@ebmr/api-contract';

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

const office = EXAMPLES['session-office'].data as SessionView;
const kiosk = EXAMPLES['session-kiosk'].data as SessionView;
const envelope = (code: string, kind: string, whatHappened: string, details?: Record<string, string>) => ({
  refusal: { code, kind, whatHappened, why: '', controls: [], whatYouCanDo: [], whoCanHelp: [], ...(details ? { details } : {}) },
  correlationId: 'fixture',
  retryable: false,
});
const noSession = { status: 401, body: envelope('NO_SESSION', 'NOT_ALLOWED', 'You are not signed in on this installation.') };

/** Rejections nobody handled (a failure that escaped the screen without a word, F08). */
const unhandled: unknown[] = [];
const onUnhandled = (e: unknown) => {
  unhandled.push(e);
};

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const spki = Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64');
  holder.key = { privateKey: pair.privateKey, publicKeySpki: spki, label: 'sign-in-screens' };
  process.prependListener('unhandledRejection', onUnhandled);
});

afterAll(() => {
  process.off('unhandledRejection', onUnhandled);
});

afterEach(() => {
  cleanup();
  unhandled.length = 0;
  window.localStorage.clear();
});

function renderGate() {
  render(
    <BootProvider>
      <Gate />
    </BootProvider>,
  );
}

describe('F09: the kiosk sign-in names the installation the page belongs to', () => {
  for (const [deviceClass, code] of [
    ['SHARED', 'KIOSK-GRAN-1'],
    ['GRADE_A_B', 'KIOSK-COMP-1'],
  ] as const) {
    it(`[DI-05][DI-20] a ${deviceClass} kiosk on the GMP installation says "GMP installation", never "Sandbox (test runs)"`, async () => {
      setTransport(
        createFixtureFetch(
          {
            'meta.get': EXAMPLES['meta-gmp'].data,
            'session.deviceNonce': { nonce: 'fixture-nonce-0123456789', expiresInSeconds: 60 },
            'session.identify': { ...kiosk.device, deviceClass, deviceCode: code, roomCode: 'GRAN-1' },
            'session.demoDevices': { devices: [] },
            'session.get': noSession,
          },
          { installation: 'GMP' },
        ),
      );
      renderGate();
      expect(await screen.findByLabelText('Badge')).toBeTruthy();
      expect(document.documentElement.dataset['installation']).toBe('gmp');
      expect(screen.queryByText(/Sandbox \(test runs\)/)).toBeNull();
      expect(screen.getByText(`GMP installation · ${code} · room GRAN-1`)).toBeTruthy();
    });
  }

  it('[DI-05][DI-20] the same kiosk on the sandbox installation says "Sandbox (test runs)"', async () => {
    setTransport(
      createFixtureFetch(
        {
          'meta.get': EXAMPLES['meta-sandbox'].data,
          'session.deviceNonce': { nonce: 'fixture-nonce-0123456789', expiresInSeconds: 60 },
          'session.identify': { ...kiosk.device, deviceCode: 'KIOSK-GRAN-1', roomCode: 'GRAN-1' },
          'session.demoDevices': { devices: [] },
          'session.get': noSession,
        },
        { installation: 'SANDBOX' },
      ),
    );
    renderGate();
    expect(await screen.findByLabelText('Badge')).toBeTruthy();
    expect(screen.getByText('Sandbox (test runs) · KIOSK-GRAN-1 · room GRAN-1')).toBeTruthy();
    expect(screen.queryByText(/GMP installation/)).toBeNull();
  });
});

const NOT_PROVEN = 'Nothing was sent: this terminal could not prove itself to the server.';

/**
 * A fixture server whose device nonces stop after `okNonces` (nonce 1 is the start-up's identify): then the nonce
 * request is refused 429 (one caller used up the allowance, X34) or the server cannot be reached.
 */
function nonceFailingServer(opts: { floor: boolean; okNonces: number; failure: 'RATE_LIMITED' | 'UNREACHABLE'; login: () => unknown }) {
  const state = { nonces: 0, logins: [] as Record<string, unknown>[], changes: [] as Record<string, unknown>[] };
  const inner = createFixtureFetch(
    {
      'meta.get': opts.floor ? EXAMPLES['meta-sandbox'].data : EXAMPLES['meta-gmp'].data,
      'session.deviceNonce': () =>
        state.nonces > opts.okNonces
          ? { status: 429, body: { ...envelope('RATE_LIMITED', 'LOCKED', 'Too many requests in a short time.'), retryable: true } }
          : { nonce: `fixture-nonce-${state.nonces}-0123456789`, expiresInSeconds: 60 },
      'session.identify': opts.floor ? kiosk.device : office.device,
      'session.demoDevices': { devices: [] },
      'session.get': noSession,
      'session.login': ({ body }: { body: unknown }) => {
        state.logins.push(body as Record<string, unknown>);
        return opts.login();
      },
      'session.changeSecret': ({ body }: { body: unknown }) => {
        state.changes.push(body as Record<string, unknown>);
        return { changed: true };
      },
    },
    { installation: opts.floor ? 'SANDBOX' : 'GMP' },
  );
  const fetch: FetchLike = async (url, init) => {
    if (url.includes('/api/session/device-nonce')) {
      state.nonces += 1;
      if (state.nonces > opts.okNonces && opts.failure === 'UNREACHABLE') throw new TypeError('Failed to fetch');
    }
    return inner(url, init);
  };
  return { state, fetch };
}

describe('F08: a sign-in or secret change that cannot get a device nonce says so', () => {
  for (const failure of ['RATE_LIMITED', 'UNREACHABLE'] as const) {
    it(`[DI-38][DI-20] office sign-in, nonce ${failure === 'RATE_LIMITED' ? 'refused 429' : 'unreachable'}: nothing is sent, the screen says why, no failure escapes`, async () => {
      const s = nonceFailingServer({ floor: false, okNonces: 1, failure, login: () => office });
      setTransport(s.fetch);
      renderGate();
      expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
      await userEvent.type(screen.getByLabelText<HTMLInputElement>('User ID'), 'asha.rao');
      await userEvent.type(screen.getByLabelText<HTMLInputElement>('Password'), 'Correct-Password-1');
      await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
      expect(await screen.findByText(NOT_PROVEN)).toBeTruthy();
      expect(screen.getByText(failure === 'RATE_LIMITED' ? /Too many requests in a short time/ : /The server could not be reached/)).toBeTruthy();
      expect(s.state.nonces).toBe(2);
      expect(s.state.logins).toHaveLength(0);
      expect(screen.getByLabelText<HTMLInputElement>('Password').value).toBe('');
      expect(screen.getByRole('button', { name: 'Sign in' }).hasAttribute('disabled')).toBe(false);
      expect(unhandled.map(String), 'failures nobody handled').toEqual([]);
    });
  }

  it('[DI-38][DI-15] first-login change, nonce unreachable: the form stays, says nothing was sent, and no failure escapes', async () => {
    // Nonce 1: start-up; nonce 2: login (MUST_CHANGE_SECRET); nonce 3 (the change) cannot be had.
    const s = nonceFailingServer({
      floor: false,
      okNonces: 2,
      failure: 'UNREACHABLE',
      login: () => ({ status: 409, body: envelope('MUST_CHANGE_SECRET', 'NOT_ALLOWED', 'You must choose a new password or PIN before you continue.', { kind: 'PASSWORD', changeTicket: 'ticket-f08-0123456789' }) }),
    });
    setTransport(s.fetch);
    renderGate();
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    await userEvent.type(screen.getByLabelText<HTMLInputElement>('User ID'), 'asha.rao');
    await userEvent.type(screen.getByLabelText<HTMLInputElement>('Password'), 'Initial-Pw-4');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Choose a new password' })).toBeTruthy();
    await userEvent.type(screen.getByLabelText<HTMLInputElement>('New password'), 'New-Secret-Ccc-7');
    await userEvent.type(screen.getByLabelText<HTMLInputElement>('Repeat the new password'), 'New-Secret-Ccc-7');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText(NOT_PROVEN)).toBeTruthy();
    expect(s.state.nonces).toBe(3);
    expect(s.state.changes).toHaveLength(0);
    expect(screen.getByRole('heading', { name: 'Choose a new password' })).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('New password').value).toBe('');
    expect(unhandled.map(String), 'failures nobody handled').toEqual([]);
  });

  it('[DI-38][DI-20] kiosk badge and PIN, nonce refused 429: the screen says nothing was sent and asks for the badge again', async () => {
    const s = nonceFailingServer({ floor: true, okNonces: 1, failure: 'RATE_LIMITED', login: () => kiosk });
    setTransport(s.fetch);
    renderGate();
    await userEvent.type(await screen.findByLabelText<HTMLInputElement>('Badge'), '04A1000000F08A{Enter}');
    await screen.findByRole('group', { name: 'Enter your PIN' });
    for (const d of '482913') await userEvent.click(screen.getByRole('button', { name: d }));
    await userEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(await screen.findByText(NOT_PROVEN)).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText('Badge')).toBeTruthy());
    expect(s.state.logins).toHaveLength(0);
    expect(unhandled.map(String), 'failures nobody handled').toEqual([]);
  });
});

describe('F10: an account that holds no role now is told so, not offered an empty role choice', () => {
  it('[DI-16] the role choice says there is no role to choose, why, and who handles role grants, and offers sign-out', async () => {
    const noRole: SessionView = { ...office, roles: [], role: null, roleChoiceRequired: true, person: { ...office.person, role: '' } };
    const logouts: unknown[] = [];
    setTransport(
      createFixtureFetch(
        {
          'meta.get': EXAMPLES['meta-gmp'].data,
          'session.deviceNonce': { nonce: 'fixture-nonce-0123456789', expiresInSeconds: 60 },
          'session.identify': office.device,
          'session.demoDevices': { devices: [] },
          'session.get': () => (logouts.length ? noSession : noRole),
          'session.logout': ({ body }: { body: unknown }) => {
            logouts.push(body);
            return { loggedOut: true };
          },
        },
        { installation: 'GMP' },
      ),
    );
    renderGate();
    expect(await screen.findByRole('heading', { name: 'Choose the role you are working in' })).toBeTruthy();
    expect(screen.getByText('You hold no role on this installation now, so there is nothing to choose.')).toBeTruthy();
    expect(screen.getByText(/No role grant of your account is valid now: it may still wait for approval, have expired or have been revoked\./)).toBeTruthy();
    expect(screen.getByText(/The system administrator \(role grants\)/)).toBeTruthy();
    const signOut = screen.getAllByRole('button', { name: 'Sign out' });
    expect(signOut.length).toBeGreaterThan(0);
    await userEvent.click(signOut[signOut.length - 1] as HTMLElement);
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(logouts).toHaveLength(1);
  });

  it('[DI-16] control: an account with several roles is offered each of them', async () => {
    const several: SessionView = { ...office, roles: ['MBR_AUTHOR', 'MBR_CHECKER'], role: null, roleChoiceRequired: true };
    setTransport(
      createFixtureFetch(
        {
          'meta.get': EXAMPLES['meta-gmp'].data,
          'session.deviceNonce': { nonce: 'fixture-nonce-0123456789', expiresInSeconds: 60 },
          'session.identify': office.device,
          'session.demoDevices': { devices: [] },
          'session.get': several,
        },
        { installation: 'GMP' },
      ),
    );
    renderGate();
    expect(await screen.findByRole('heading', { name: 'Choose the role you are working in' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'MBR_AUTHOR' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'MBR_CHECKER' })).toBeTruthy();
    expect(screen.queryByText(/You hold no role/)).toBeNull();
  });
});

describe('F05: a new kiosk PIN is never longer than the PIN pad takes', () => {
  it('[DI-19][DI-15] the change fields take 12 digits at most, a longer or non-digit PIN is not sent, and the PIN set is typed in full on the pad', async () => {
    const UID = '04A1000000F05A';
    const LONG_PIN = '73914628503917';
    const TWELVE = LONG_PIN.slice(0, 12);
    const logins: Record<string, unknown>[] = [];
    const changes: Record<string, unknown>[] = [];
    setTransport(
      createFixtureFetch(
        {
          'meta.get': EXAMPLES['meta-sandbox'].data,
          'session.deviceNonce': { nonce: 'fixture-nonce-0123456789', expiresInSeconds: 60 },
          'session.identify': kiosk.device,
          'session.demoDevices': { devices: [] },
          'session.get': noSession,
          'session.login': ({ body }: { body: unknown }) => {
            logins.push(body as Record<string, unknown>);
            return changes.length
              ? { status: 401, body: envelope('EBMR-IAM-140', 'AUTH_FAILED', 'Sign-in failed.') }
              : { status: 409, body: envelope('MUST_CHANGE_SECRET', 'NOT_ALLOWED', 'You must choose a new password or PIN before you continue.', { kind: 'PIN', changeTicket: 'ticket-f05-0123456789' }) };
          },
          'session.changeSecret': ({ body }: { body: unknown }) => {
            changes.push(body as Record<string, unknown>);
            return { changed: true };
          },
        },
        { installation: 'SANDBOX' },
      ),
    );
    renderGate();
    await userEvent.type(await screen.findByLabelText<HTMLInputElement>('Badge'), `${UID}{Enter}`);
    await screen.findByRole('group', { name: 'Enter your PIN' });
    for (const d of '482913') await userEvent.click(screen.getByRole('button', { name: d }));
    await userEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(await screen.findByRole('heading', { name: 'Choose a new PIN' })).toBeTruthy();
    const first = () => screen.getByLabelText<HTMLInputElement>('New PIN');
    const second = () => screen.getByLabelText<HTMLInputElement>('Repeat the new PIN');
    expect(first().maxLength).toBe(12);
    expect(second().maxLength).toBe(12);
    expect(screen.getByText('A PIN has digits only, at most 12 of them (the most a PIN pad takes).')).toBeTruthy();

    // A value the field's limit did not stop, set by a script (no key at all): not sent, and the screen says why. Since
    // BADGE-AUTOFILL round 3 such a value is a fill, refused before its digits are read: a PIN is typed key by key.
    // (Submitted as a script would, past the browser's own length check.)
    first().value = LONG_PIN;
    second().value = LONG_PIN;
    fireEvent.submit(screen.getByRole('form', { name: 'Choose a new PIN' }));
    await waitFor(() => expect(screen.getByText('A PIN is typed here key by key, never filled in by the browser or a password manager, nor pasted. Nothing was sent: type the new PIN.')).toBeTruthy());
    expect(changes).toHaveLength(0);
    expect(first().value).toBe('');
    // Typed key by key where the browser's own limit did not hold (a browser that ignores maxlength): not sent either,
    // and the screen says the PIN is too long.
    for (const f of [first(), second()]) f.removeAttribute('maxlength');
    await userEvent.type(first(), LONG_PIN);
    await userEvent.type(second(), LONG_PIN);
    fireEvent.submit(screen.getByRole('form', { name: 'Choose a new PIN' }));
    await waitFor(() => expect(screen.getAllByText('A PIN has digits only, at most 12 of them (the most a PIN pad takes).')).toHaveLength(2));
    expect(changes).toHaveLength(0);
    expect(first().value).toBe('');
    for (const f of [first(), second()]) f.setAttribute('maxlength', '12');
    // A letter typed on a keyboard into the numeric field: not sent.
    await userEvent.type(first(), '48291a');
    await userEvent.type(second(), '48291a');
    fireEvent.submit(screen.getByRole('form', { name: 'Choose a new PIN' }));
    await waitFor(() => expect(screen.getAllByText('A PIN has digits only, at most 12 of them (the most a PIN pad takes).')).toHaveLength(2));
    expect(changes).toHaveLength(0);
    expect(first().value).toBe('');

    // Twelve digits are sent, and the pad then takes all twelve.
    await userEvent.type(first(), TWELVE);
    await userEvent.type(second(), TWELVE);
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await userEvent.type(await screen.findByLabelText<HTMLInputElement>('Badge'), `${UID}{Enter}`);
    expect(await screen.findByText('Your new PIN is set. Sign in with it now.')).toBeTruthy();
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ newSecret: TWELVE, kind: 'PIN' });
    await userEvent.type(await screen.findByLabelText<HTMLInputElement>('Badge'), `${UID}{Enter}`);
    await screen.findByRole('group', { name: 'Enter your PIN' });
    for (const d of LONG_PIN) await userEvent.click(screen.getByRole('button', { name: d }));
    await userEvent.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(logins).toHaveLength(2));
    expect(logins[1]?.['secret']).toBe(TWELVE);
  });
});

describe('F56 and T1: the kiosk sign-in takes its badge through the ui-kit BadgePrompt and its PIN on the ui-kit PinPad', () => {
  it('[DI-14][DI-19][DI-38] a PIN keyed into the sign-in badge field is not taken as a badge, and a stray key before the reader\'s burst is not sent with it', async () => {
    const UID = '04A1000000F56A';
    const logins: Record<string, unknown>[] = [];
    setTransport(
      createFixtureFetch(
        {
          'meta.get': EXAMPLES['meta-sandbox'].data,
          'session.deviceNonce': { nonce: 'fixture-nonce-0123456789', expiresInSeconds: 60 },
          'session.identify': kiosk.device,
          'session.demoDevices': { devices: [] },
          'session.get': noSession,
          'session.login': ({ body }: { body: unknown }) => {
            logins.push(body as Record<string, unknown>);
            return { status: 401, body: envelope('EBMR-IAM-140', 'AUTH_FAILED', 'Sign-in failed.') };
          },
        },
        { installation: 'SANDBOX' },
      ),
    );
    renderGate();
    const field = await screen.findByLabelText<HTMLInputElement>('Badge');
    expect(document.activeElement).toBe(field);
    expect(screen.getByText('Tap your badge to sign in.')).toBeTruthy();
    // No countdown and no Cancel: the sign-in screen waits for a badge.
    expect(screen.queryByText(/Waiting for a badge/)).toBeNull();
    await userEvent.keyboard('482913{Enter}');
    expect(await screen.findByText('That is not a badge. Nothing was sent: tap your badge on the reader.')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Enter your PIN' })).toBeNull();
    // A stray key, then the reader's burst: only the burst is the badge.
    await userEvent.type(screen.getByLabelText('Badge'), '7');
    await new Promise((r) => setTimeout(r, 300));
    await userEvent.type(screen.getByLabelText('Badge'), `${UID}{Enter}`);
    const pad = await screen.findByRole('group', { name: 'Enter your PIN' });
    // The ui-kit pad: OK only from 4 digits, at most 12, keyboard digits too.
    for (const d of '482') await userEvent.click(screen.getByRole('button', { name: d }));
    expect(screen.getByRole('button', { name: 'OK' }).hasAttribute('disabled')).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: '9' }));
    pad.focus();
    await userEvent.keyboard('13{Enter}');
    await waitFor(() => expect(logins).toHaveLength(1));
    expect(logins[0]).toMatchObject({ method: 'BADGE_PIN', identifier: UID, secret: '482913' });
    expect(await screen.findByText('Sign-in failed.')).toBeTruthy();
  });
});
