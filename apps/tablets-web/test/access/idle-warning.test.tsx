/**
 * The inactivity warning of the session (module C1; slice 7g-5, decision 0025; DI-38; route access.keepAlive), with the
 * real boot state and access controller against a fixture server: shortly before the kernel's idle lock the page warns
 * and offers to stay signed in; on an office terminal one press sends the keep-alive; an accepted write starts the count
 * again; on a shop-floor kiosk the person taps their own badge (the server checks it). The count runs on the fake
 * interval clock; no clock is read.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EXAMPLES } from '@ebmr/api-contract/examples';
import { routes, type FetchLike, type SessionView } from '@ebmr/api-contract';

const holder = vi.hoisted(() => ({ key: null as null | { privateKey: CryptoKey; publicKeySpki: string; label: string } }));
vi.mock('../../src/device/keystore.ts', () => ({
  loadDeviceKey: () => Promise.resolve(holder.key),
  saveDeviceKey: () => Promise.resolve(),
  forgetDeviceKey: () => Promise.resolve(),
  importDemoKey: () => Promise.reject(new Error('not used in this test')),
}));

const { api, apiState, setTransport } = await import('../../src/api/client.ts');
const { createFixtureFetch } = await import('../../src/api/fixture-fetch.ts');
const { BootProvider } = await import('../../src/app/boot.tsx');
const { Provider } = await import('../../src/features/access/index.tsx');
const { warnSecondsOf } = await import('../../src/features/access/idle-warning.tsx');

const OFFICE: SessionView = { ...(EXAMPLES['session-office'].data as SessionView), idleTimeoutSeconds: 40 };
const KIOSK: SessionView = { ...(EXAMPLES['session-kiosk'].data as SessionView), idleTimeoutSeconds: 40 };

function server(session: SessionView) {
  const seen: { method: string; url: string; body: unknown }[] = [];
  const fixtures = createFixtureFetch(
    {
      'meta.get': EXAMPLES['meta-gmp'].data,
      'session.deviceNonce': { nonce: 'fixture-nonce-0123456789', expiresInSeconds: 60 },
      'session.identify': session.device,
      'session.get': session,
      'access.keepAlive': session,
      'notifications.acknowledge': { acknowledged: true },
    },
    { installation: 'GMP' },
  );
  const fetch: FetchLike = (url, init) => {
    seen.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined });
    return fixtures(url, init);
  };
  return { seen, fetch };
}

function renderPage() {
  render(
    <BootProvider>
      <Provider>
        <p>Signed in</p>
      </Provider>
    </BootProvider>,
  );
}

/** Lets `seconds` pass on the fake interval clock, one second at a time (each tick renders). */
const tick = async (seconds: number) => {
  for (let i = 0; i < seconds; i += 1) {
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });
  }
};

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const spki = Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64');
  holder.key = { privateKey: pair.privateKey, publicKeySpki: spki, label: 'PC-DESIGN-01' };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.localStorage.clear();
});

describe('the inactivity warning (DI-38)', () => {
  it('[DI-38] warns a quarter of the timeout before the idle lock (5 to 60 s)', () => {
    expect(warnSecondsOf(40)).toBe(10);
    expect(warnSecondsOf(900)).toBe(60);
    expect(warnSecondsOf(8)).toBe(5);
  });

  it('[DI-38] on an office terminal the warning shows before the idle lock and one press keeps the session alive', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const s = server(OFFICE);
    setTransport(s.fetch);
    renderPage();
    await screen.findByText('Signed in');
    await waitFor(() => expect(s.seen.some((r) => r.url === '/api/session')).toBe(true));
    await tick(28);
    expect(screen.queryByTestId('idle-warning')).toBeNull();
    await tick(4);
    const warning = await screen.findByTestId('idle-warning');
    expect(warning.textContent).toMatch(/This session locks in (8|9|10) seconds because nothing was done in it\./);
    await userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) }).click(screen.getByRole('button', { name: 'Stay signed in' }));
    await waitFor(() => expect(s.seen.filter((r) => r.method === 'POST' && r.url === routes.access.keepAlive.path)).toHaveLength(1));
    expect(s.seen.find((r) => r.method === 'POST' && r.url === routes.access.keepAlive.path)?.body).toEqual({});
    await waitFor(() => expect(screen.queryByTestId('idle-warning')).toBeNull());
  });

  it('[DI-38] an accepted write is activity: the count starts again', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const s = server(OFFICE);
    setTransport(s.fetch);
    renderPage();
    await screen.findByText('Signed in');
    await waitFor(() => expect(s.seen.some((r) => r.url === '/api/session')).toBe(true));
    await tick(25);
    // A command of the session (any accepted POST other than the nonce and the terminal check).
    await act(async () => {
      await api.call(routes.notifications.acknowledge, { params: { notificationId: '0b8f1c2a-1111-4c7d-8e9f-0a1b2c3d4e99' }, body: {} });
    });
    await tick(10);
    expect(screen.queryByTestId('idle-warning')).toBeNull();
    await tick(22);
    expect(await screen.findByTestId('idle-warning')).toBeTruthy();
  });

  it('[DI-38][DI-14] on a shop-floor kiosk the person taps their own badge to stay signed in', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const s = server(KIOSK);
    setTransport(s.fetch);
    renderPage();
    await screen.findByText('Signed in');
    await waitFor(() => expect(s.seen.some((r) => r.url === '/api/session')).toBe(true));
    await tick(32);
    const warning = await screen.findByTestId('idle-warning');
    expect(warning.textContent).toContain('Tap your own badge to stay signed in.');
    await userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) }).click(screen.getByRole('button', { name: 'Tap to stay signed in' }));
    expect(await screen.findByRole('dialog', { name: 'Stay signed in' })).toBeTruthy();
    // Nothing is sent before the tap.
    expect(s.seen.filter((r) => r.url === routes.access.keepAlive.path)).toHaveLength(0);
  });

  it('[DI-38] the client tells the warning about accepted writes only', async () => {
    const s = server(OFFICE);
    setTransport(s.fetch);
    apiState.installation = 'GMP';
    const told = vi.fn();
    apiState.onWrite.add(told);
    try {
      await api.call(routes.session.get);
      await api.call(routes.session.deviceNonce, { body: { spki: 'AAAA' } });
      expect(told).not.toHaveBeenCalled();
      await api.call(routes.access.keepAlive, { body: {} });
      expect(told).toHaveBeenCalledTimes(1);
    } finally {
      apiState.onWrite.delete(told);
      apiState.installation = undefined;
    }
  });
});
