/**
 * The sign-out screens (review P5; DI-38, DI-14): from the moment Sign out is pressed the gate blocks the page
 * ("Signing out…"); after a sign-out the server did not confirm (a refusal, or no answer in time) it never shows the
 * sign-in form but a blocking screen that retries (by a button and on its own) and reaches the sign-in form only once
 * the server confirms that no session is left. When another tab finishes the sign-out, the screen starts the page
 * again at once and ends nothing. A page that shows a session joins a sign-out another tab started as soon as it
 * learns of it, and shows no session while such a sign-out is marked. The kernel-level behaviour (lock fallback, real
 * reloads, the mark in the browser, other tabs) is proven against the real server in
 * apps/tablets-server/test/session/sign-out.test.ts.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
const { BootProvider, useBoot, SIGN_OUT_REQUEST_TIMEOUT_MS } = await import('../../src/app/boot.tsx');
const { SIGN_OUT_MARK_KEY, signOutMarkCookie } = await import('../../src/app/sign-out-mark.ts');
const { Gate } = await import('../../src/app/App.tsx');
const { SIGN_OUT_RETRY_MS } = await import('../../src/app/sign-out.tsx');
type Boot = ReturnType<typeof useBoot>;

const office = EXAMPLES['session-office'].data as SessionView;
const envelope = (code: string, whatHappened: string) => ({ refusal: { code, kind: 'NOT_ALLOWED', whatHappened, why: '', controls: [], whatYouCanDo: [], whoCanHelp: [] }, correlationId: 'fixture', retryable: false });

/** A fixture server: one office session that ends only when a logout succeeds (logouts can also go unanswered). */
function fixtureServer() {
  const state = { alive: true, locked: false, logoutFails: true, logoutHangs: false, logouts: 0, locks: 0, who: office };
  const fixtures = createFixtureFetch(
    {
      'meta.get': EXAMPLES['meta-gmp'].data,
      'session.deviceNonce': { nonce: 'fixture-nonce-0123456789', expiresInSeconds: 60 },
      'session.identify': office.device,
      'session.get': () => (state.alive ? { ...state.who, locked: state.locked } : { status: 401, body: envelope('NO_SESSION', 'You are not signed in on this installation.') }),
      'session.logout': () => {
        state.logouts += 1;
        if (state.logoutFails) return { status: 503, body: { ...envelope('INTERNAL', 'The server could not finish the request.'), retryable: true } };
        state.alive = false;
        return { loggedOut: true };
      },
      'access.lock': () => {
        state.locks += 1;
        state.locked = true;
        return { ...office, locked: true };
      },
    },
    { installation: 'GMP' },
  );
  const fetch: FetchLike = (url, init) =>
    state.logoutHangs && init.method === 'POST' && url.startsWith('/api/session/logout') ? new Promise(() => undefined) : fixtures(url, init);
  return { state, fetch };
}

function renderPage(): () => Boot {
  const seen: { boot: Boot | null } = { boot: null };
  function Page() {
    const boot = useBoot();
    seen.boot = boot;
    // The signed-in application itself is not under test here: only what the gate shows around it.
    return boot.phase === 'ready' ? <p>{`Signed in as ${boot.session?.person.legalName ?? ''}`}</p> : <Gate />;
  }
  render(
    <BootProvider>
      <Page />
    </BootProvider>,
  );
  return () => {
    if (!seen.boot) throw new Error('no boot');
    return seen.boot;
  };
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
  document.cookie = `${signOutMarkCookie('GMP') ?? ''}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/`;
});

describe('P5: the sign-out screen', () => {
  it('[DI-38][DI-14] a failed sign-out shows "Sign-out not confirmed" (never the sign-in form); the retry button reaches the sign-in form once the server confirms', async () => {
    const server = fixtureServer();
    setTransport(server.fetch);
    const boot = renderPage();
    expect(await screen.findByText('Signed in as Asha Rao')).toBeTruthy();

    await act(async () => {
      await boot().signOut();
    });
    expect(await screen.findByText('Sign-out not confirmed')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Sign in' })).toBeNull();
    expect(screen.queryByText('Signed in as Asha Rao')).toBeNull();
    expect(server.state).toMatchObject({ alive: true, locked: true, locks: 1 });

    // Still failing: the button retries and the screen stays.
    await userEvent.click(screen.getByRole('button', { name: 'Try signing out again' }));
    await waitFor(() => expect(server.state.logouts).toBeGreaterThanOrEqual(3));
    expect(screen.getByText('Sign-out not confirmed')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Sign in' })).toBeNull();

    // The server works again: the next retry signs out and only then shows the sign-in form.
    server.state.logoutFails = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try signing out again' }));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(server.state.alive).toBe(false);
    expect(screen.queryByText('Sign-out not confirmed')).toBeNull();
  });

  it('[DI-38] the screen retries the sign-out by itself', async () => {
    const server = fixtureServer();
    setTransport(server.fetch);
    const boot = renderPage();
    expect(await screen.findByText('Signed in as Asha Rao')).toBeTruthy();
    // Only the screen's retry interval runs on a fake clock (the rest of the page keeps real timers).
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await act(async () => {
      await boot().signOut();
    });
    expect(await screen.findByText('Sign-out not confirmed')).toBeTruthy();
    const before = server.state.logouts;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SIGN_OUT_RETRY_MS - 1);
    });
    expect(server.state.logouts).toBe(before);

    server.state.logoutFails = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(server.state.logouts).toBeGreaterThan(before);
    expect(server.state.alive).toBe(false);
  });

  it('[DI-38][DI-14] from the moment Sign out is pressed the page is blocked; a server that does not answer in time leaves it on "Sign-out not confirmed", never on the sign-in form', async () => {
    const server = fixtureServer();
    server.state.logoutHangs = true;
    setTransport(server.fetch);
    const boot = renderPage();
    expect(await screen.findByText('Signed in as Asha Rao')).toBeTruthy();
    // Only the deadline timers run on a fake clock that also follows real time (the page keeps working).
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    let done: Promise<void> = Promise.resolve();
    act(() => {
      done = boot().signOut();
    });
    expect(await screen.findByText('Signing out…')).toBeTruthy();
    expect(screen.queryByText('Signed in as Asha Rao')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Sign in' })).toBeNull();

    // The logout, and the one more logout after re-reading the session, both go unanswered.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SIGN_OUT_REQUEST_TIMEOUT_MS);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SIGN_OUT_REQUEST_TIMEOUT_MS);
    });
    await act(async () => {
      await done;
    });
    expect(await screen.findByText('Sign-out not confirmed')).toBeTruthy();
    expect(screen.getByText('The server did not answer in time.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Sign in' })).toBeNull();
    // The fallback lock was answered: the session needs credentials again.
    expect(server.state).toMatchObject({ alive: true, locked: true, locks: 1 });

    // The server answers again: the retry signs out and only then shows the sign-in form.
    vi.useRealTimers();
    Object.assign(server.state, { logoutHangs: false, logoutFails: false });
    await userEvent.click(screen.getByRole('button', { name: 'Try signing out again' }));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(server.state.alive).toBe(false);
  });

  it('[DI-38][DI-14] when another tab finishes the sign-out and the next person signs in, the waiting page starts again at once and ends nothing', async () => {
    const server = fixtureServer();
    setTransport(server.fetch);
    const boot = renderPage();
    expect(await screen.findByText('Signed in as Asha Rao')).toBeTruthy();
    await act(async () => {
      await boot().signOut();
    });
    expect(await screen.findByText('Sign-out not confirmed')).toBeTruthy();
    const asked = { logouts: server.state.logouts, locks: server.state.locks };

    // Another tab of this browser finished the sign-out (it cleared the mark), and Vikram Shah signed in there.
    server.state.who = { ...office, person: { ...office.person, personId: '5b0c1d2e-3f40-4a51-8b62-7c83d94ea5f6', legalName: 'Vikram Shah', loginName: 'vikram.shah' } };
    server.state.locked = false;
    window.localStorage.removeItem(SIGN_OUT_MARK_KEY);
    document.cookie = `${signOutMarkCookie('GMP') ?? ''}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/`;
    // The browser tells this tab that the mark changed.
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: SIGN_OUT_MARK_KEY, oldValue: 'mark', newValue: null }));
    });

    expect(await screen.findByText('Signed in as Vikram Shah')).toBeTruthy();
    expect(screen.queryByText('Sign-out not confirmed')).toBeNull();
    expect({ logouts: server.state.logouts, locks: server.state.locks }).toEqual(asked);
    expect(server.state.alive).toBe(true);
  });

  it('[DI-38][DI-14] while a sign-out is pending, a late answer to an earlier request neither brings the session back nor shows the sign-in form', async () => {
    const server = fixtureServer();
    setTransport(server.fetch);
    const boot = renderPage();
    expect(await screen.findByText('Signed in as Asha Rao')).toBeTruthy();
    await act(async () => {
      await boot().signOut();
    });
    expect(await screen.findByText('Sign-out not confirmed')).toBeTruthy();
    // E.g. the session poll that was on its way when Sign out was pressed: it reports Asha's (still live) session.
    act(() => {
      boot().setSession({ ...office, locked: false });
    });
    expect(boot().phase).toBe('sign-out-unconfirmed');
    act(() => {
      boot().setSession(null);
    });
    expect(boot().phase).toBe('sign-out-unconfirmed');
    expect(screen.getByText('Sign-out not confirmed')).toBeTruthy();
    expect(screen.queryByText('Signed in as Asha Rao')).toBeNull();
    // Only the confirmed sign-out moves the page on.
    server.state.logoutFails = false;
    await act(async () => {
      await boot().signOut();
    });
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
  });
});

describe('P5: a sign-out another tab of this browser started', () => {
  it('[DI-38][DI-14] a page that shows the session joins it at once when site storage tells it, and ends the session itself', async () => {
    // Only the storage event can tell the page here: its periodic look at the stores runs on a clock that never advances.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const server = fixtureServer();
    server.state.logoutFails = false;
    setTransport(server.fetch);
    renderPage();
    expect(await screen.findByText('Signed in as Asha Rao')).toBeTruthy();

    // Another tab marks its sign-out (and cannot finish it): the browser tells this tab.
    window.localStorage.setItem(SIGN_OUT_MARK_KEY, '8c7b6a5948372615f4e3d2c1b0a99887');
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: SIGN_OUT_MARK_KEY, oldValue: null, newValue: '8c7b6a5948372615f4e3d2c1b0a99887' }));
    });
    expect(screen.queryByText('Signed in as Asha Rao')).toBeNull();
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(server.state).toMatchObject({ alive: false, logouts: 1 });
    // The mark it joined is cleared once the server confirmed.
    expect(window.localStorage.getItem(SIGN_OUT_MARK_KEY)).toBeNull();
  });

  it('[DI-38][DI-14] while another tab\'s sign-out is marked, no session is shown: a session handed to the page (sign-in, role choice, switch) joins that sign-out instead', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const server = fixtureServer();
    server.state.logoutFails = false;
    setTransport(server.fetch);
    const boot = renderPage();
    expect(await screen.findByText('Signed in as Asha Rao')).toBeTruthy();

    // The mark is in the cookie alone (no event); then a session arrives, e.g. the answer to a sign-in or a switch.
    document.cookie = `${signOutMarkCookie('GMP') ?? ''}=8c7b6a5948372615f4e3d2c1b0a99887; Path=/`;
    act(() => {
      boot().setSession({ ...office, locked: false });
    });
    expect(boot().phase).not.toBe('ready');
    expect(boot().session).toBeNull();
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(server.state).toMatchObject({ alive: false, logouts: 1 });
  });
});
