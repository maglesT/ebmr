/**
 * The warning before the inactivity lock and the absolute end (outline 7.4; WCAG 2.2 success criterion 2.2.1; DI-14,
 * DI-38; slice 7d finding A11Y-1), with the real boot state and the real access controller against a fixture server:
 *  - office: the warning opens when the server says the lock is near; "Keep working" sends the keep-alive with no
 *    attribution and the warning closes on the server's new answer;
 *  - kiosk: the warning asks for a badge tap; the tap is sent as the keep-alive's badge with a device proof over it;
 *    "Lock now" locks the terminal;
 *  - the absolute end is announced once and nothing extends it;
 *  - with time to spare there is no warning.
 */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
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
const { BootProvider, useBoot } = await import('../../src/app/boot.tsx');
const { Provider } = await import('../../src/features/access/index.tsx');

const OFFICE = EXAMPLES['session-office'].data as SessionView;
const KIOSK = EXAMPLES['session-kiosk'].data as SessionView;

function fixtureServer(base: SessionView, first: { idleLockInSeconds: number | null; endsInSeconds: number | null }) {
  const state = { view: { ...base, ...first }, keepAlives: [] as unknown[], locks: 0 };
  const fixtures = createFixtureFetch(
    {
      'meta.get': EXAMPLES[base === KIOSK ? 'meta-sandbox' : 'meta-gmp'].data,
      'session.deviceNonce': { nonce: 'fixture-nonce-0123456789', expiresInSeconds: 60 },
      'session.identify': base.device,
      'session.demoDevices': { devices: [] },
      'session.get': () => state.view,
      'access.keepAlive': ({ body }: { body: unknown }) => {
        state.keepAlives.push(body);
        state.view = { ...state.view, idleLockInSeconds: state.view.idleTimeoutSeconds };
        return state.view;
      },
      'access.lock': () => {
        state.locks += 1;
        state.view = { ...state.view, locked: true, idleLockInSeconds: null };
        return state.view;
      },
    },
    { installation: base === KIOSK ? 'SANDBOX' : 'GMP' },
  );
  const fetch: FetchLike = (url, init) => fixtures(url, init);
  return { state, fetch };
}

function renderPage() {
  function Page() {
    const boot = useBoot();
    return <p>{boot.phase === 'ready' ? `Signed in as ${boot.session?.person.legalName ?? ''}` : `Page: ${boot.phase}`}</p>;
  }
  render(
    <BootProvider>
      <Provider>
        <Page />
      </Provider>
    </BootProvider>,
  );
}

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const spki = Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64');
  holder.key = { privateKey: pair.privateKey, publicKeySpki: spki, label: 'PC-DESIGN-01' };
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('the warning before the inactivity lock (A11Y-1)', () => {
  it('[DI-14][DI-38] office: the warning opens when the lock is near; "Keep working" sends the keep-alive and closes it', async () => {
    const server = fixtureServer(OFFICE, { idleLockInSeconds: 40, endsInSeconds: 40_000 });
    setTransport(server.fetch);
    renderPage();
    const dialog = await screen.findByRole('alertdialog', { name: 'Are you still working?' });
    expect(within(dialog).getByText(/It locks in (40|39|38) s\./)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep working' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(server.state.keepAlives).toEqual([{}]);
    expect(screen.getByText(`Signed in as ${OFFICE.person.legalName}`)).toBeTruthy();
  });

  it('[DI-14][INV-40] kiosk: the warning asks for a badge tap, sent as the keep-alive with a device proof over it; "Lock now" locks', async () => {
    holder.key = holder.key && { ...holder.key, label: KIOSK.device.deviceCode };
    const server = fixtureServer(KIOSK, { idleLockInSeconds: 30, endsInSeconds: 40_000 });
    setTransport(server.fetch);
    renderPage();
    const dialog = await screen.findByRole('alertdialog', { name: 'Are you still working?' });
    expect(within(dialog).getByText('Tap your badge to keep working.')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Keep working' })).toBeNull();
    await userEvent.type(within(dialog).getByLabelText('Badge'), '04A10000000001{Enter}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(server.state.keepAlives).toHaveLength(1);
    expect(server.state.keepAlives[0]).toMatchObject({ badgeUid: '04A10000000001', proof: { nonce: 'fixture-nonce-0123456789' } });

    // The lock comes near again: "Lock now" locks the terminal at once.
    act(() => {
      server.state.view = { ...server.state.view, idleLockInSeconds: 20 };
    });
    cleanup();
    renderPage();
    const again = await screen.findByRole('alertdialog', { name: 'Are you still working?' });
    await userEvent.click(within(again).getByRole('button', { name: 'Lock now' }));
    await waitFor(() => expect(server.state.locks).toBe(1));
    await waitFor(() => expect(screen.queryByRole('alertdialog', { name: 'Are you still working?' })).toBeNull());
  });

  it('[DI-14][DI-38] the absolute end is announced once, with nothing to extend it; with time to spare there is no warning', async () => {
    const server = fixtureServer(OFFICE, { idleLockInSeconds: 900, endsInSeconds: 200 });
    setTransport(server.fetch);
    renderPage();
    const dialog = await screen.findByRole('alertdialog', { name: 'Your session ends soon' });
    expect(within(dialog).getByText(/Your session ends in 3 min \d\d s/)).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Keep working' })).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    // It stays closed for this session.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1500));
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(server.state.keepAlives).toEqual([]);

    cleanup();
    const calm = fixtureServer(OFFICE, { idleLockInSeconds: 900, endsInSeconds: 40_000 });
    setTransport(calm.fetch);
    renderPage();
    expect(await screen.findByText(`Signed in as ${OFFICE.person.legalName}`)).toBeTruthy();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1200));
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
