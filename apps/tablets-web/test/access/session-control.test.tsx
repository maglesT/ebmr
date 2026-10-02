/**
 * The session control of the access module (module C1; review P5 and the items found with it; DI-38, DI-14, DI-28),
 * with the real boot state and the real access controller against a fixture server:
 *  - before each session poll the page looks for a sign-out that another tab of this browser marked, and joins it
 *    (the page blocks and ends the session) instead of polling past it;
 *  - a poll answer that arrives after the session on show changed is dropped: it neither brings a session back after
 *    a sign-out nor unlocks, on screen, a session that was locked meanwhile;
 *  - an unlock the poll sees (another tab unlocked the session) is announced like any other unlock, so the floor reads
 *    again what the record holds.
 * The session poll and the page's periodic look at the stores run on a fake clock that never advances here, so each
 * test decides when the session is polled.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
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
const { SIGN_OUT_MARK_KEY } = await import('../../src/app/sign-out-mark.ts');
const { Provider } = await import('../../src/features/access/index.tsx');
const { useAccess } = await import('../../src/features/access/controller.tsx');
type Boot = ReturnType<typeof useBoot>;
type Access = ReturnType<typeof useAccess>;

const ASHA = EXAMPLES['session-office'].data as SessionView;
const VIKRAM: SessionView = {
  ...ASHA,
  person: { personId: '5b0c1d2e-3f40-4a51-8b62-7c83d94ea5f6', legalName: 'Vikram Shah', loginName: 'vikram.shah', role: 'MBR_CHECKER' },
  role: 'MBR_CHECKER',
  roles: ['MBR_CHECKER'],
};
const envelope = (code: string, whatHappened: string) => ({ refusal: { code, kind: 'NOT_ALLOWED', whatHappened, why: '', controls: [], whatYouCanDo: [], whoCanHelp: [] }, correlationId: 'fixture', retryable: false });

/**
 * A fixture server for this browser's office session. `hold` delays the delivery of GET /api/session answers: each
 * answer is computed when its request arrives (what the server knew then) and delivered when the hold is released.
 */
function fixtureServer() {
  const state = { alive: true, locked: false, who: ASHA, polls: 0, logouts: 0, locks: 0, hold: null as Promise<void> | null };
  const fixtures = createFixtureFetch(
    {
      'meta.get': EXAMPLES['meta-gmp'].data,
      'session.deviceNonce': { nonce: 'fixture-nonce-0123456789', expiresInSeconds: 60 },
      'session.identify': ASHA.device,
      'session.get': () => (state.alive ? { ...state.who, locked: state.locked } : { status: 401, body: envelope('NO_SESSION', 'You are not signed in on this installation.') }),
      'session.logout': () => {
        state.logouts += 1;
        state.alive = false;
        return { loggedOut: true };
      },
      'access.lock': () => {
        state.locks += 1;
        state.locked = true;
        return { ...state.who, locked: true };
      },
    },
    { installation: 'GMP' },
  );
  const fetch: FetchLike = (url, init) => {
    const poll = init.method === 'GET' && url === '/api/session';
    if (poll) state.polls += 1;
    const answer = fixtures(url, init);
    const hold = state.hold;
    return poll && hold ? hold.then(() => answer) : answer;
  };
  return { state, fetch };
}

function renderPage(): { boot: () => Boot; access: () => Access } {
  const seen: { boot: Boot | null; access: Access | null } = { boot: null, access: null };
  function Page() {
    const boot = useBoot();
    seen.boot = boot;
    return <p>{boot.phase === 'ready' ? `Signed in as ${boot.session?.person.legalName ?? ''}` : `Page: ${boot.phase}`}</p>;
  }
  function Controls() {
    seen.access = useAccess();
    return null;
  }
  render(
    <BootProvider>
      <Provider>
        <Page />
        <Controls />
      </Provider>
    </BootProvider>,
  );
  return {
    boot: () => {
      if (!seen.boot) throw new Error('no boot');
      return seen.boot;
    },
    access: () => {
      if (!seen.access) throw new Error('no access controller');
      return seen.access;
    },
  };
}

/**
 * Asks the page to check its session once the session control is there. The control registers itself in an effect,
 * which a loaded runner can run after the signed-in text is on screen; until then a check does nothing. `done` says
 * whether the check had its effect (a poll went out, or the page joined a marked sign-out).
 */
async function checkWhenControlled(page: ReturnType<typeof renderPage>, done: () => boolean): Promise<void> {
  await waitFor(() => {
    act(() => {
      page.access().checkSession();
    });
    expect(done()).toBe(true);
  });
}

/** Lets the answers already on their way arrive, and React settle. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
  });
}

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

describe('P5: the session poll and a sign-out marked by another tab', () => {
  it('[DI-38][DI-14] before each session poll the page reads the mark of a sign-out another tab started, and joins it instead of polling', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const server = fixtureServer();
    setTransport(server.fetch);
    const page = renderPage();
    expect(await screen.findByText('Signed in as Asha Rao')).toBeTruthy();

    // Another tab of this browser started a sign-out; its mark is in site storage (no storage event reaches here).
    window.localStorage.setItem(SIGN_OUT_MARK_KEY, '0f1e2d3c4b5a69788796a5b4c3d2e1f0');
    const polls = server.state.polls;
    await checkWhenControlled(page, () => page.boot().session === null);
    expect(screen.queryByText('Signed in as Asha Rao')).toBeNull();
    expect(page.boot().session).toBeNull();
    expect(server.state.polls, 'the poll went out past the mark').toBe(polls);
    expect(await screen.findByText('Page: signed-out')).toBeTruthy();
    expect(server.state).toMatchObject({ alive: false, logouts: 1 });
    // The mark it joined is cleared once the server confirmed.
    expect(window.localStorage.getItem(SIGN_OUT_MARK_KEY)).toBeNull();
  });
});

describe('late answers of the session poll', () => {
  it('[DI-38][DI-14] a poll answer that arrives after the sign-out never brings a session back, not even another person\'s', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const server = fixtureServer();
    setTransport(server.fetch);
    const page = renderPage();
    expect(await screen.findByText('Signed in as Asha Rao')).toBeTruthy();

    // Vikram Shah switched in on another tab of this browser; this page's poll then answers late with his session.
    let release: () => void = () => undefined;
    server.state.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.state.who = VIKRAM;
    const asked = server.state.polls;
    await checkWhenControlled(page, () => server.state.polls > asked);
    // Meanwhile the person at this page signs out, and the server confirms it.
    await act(async () => {
      await page.access().signOut();
    });
    expect(page.boot().phase).toBe('signed-out');

    server.state.hold = null;
    release();
    await settle();
    expect(page.boot().phase).toBe('signed-out');
    expect(page.boot().session).toBeNull();
    expect(screen.queryByText('Signed in as Vikram Shah')).toBeNull();
  });

  it('[DI-14][DI-38] a poll answered before a lock that arrives after it leaves the session locked on screen', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const server = fixtureServer();
    setTransport(server.fetch);
    const page = renderPage();
    expect(await screen.findByText('Signed in as Asha Rao')).toBeTruthy();

    let release: () => void = () => undefined;
    server.state.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The poll is answered while the session is still unlocked ...
    const asked = server.state.polls;
    await checkWhenControlled(page, () => server.state.polls > asked);
    // ... and Asha locks the screen before that answer arrives.
    act(() => {
      page.access().lock();
    });
    expect(await screen.findByRole('alertdialog', { name: 'This terminal is locked' })).toBeTruthy();
    expect(server.state.locked).toBe(true);

    server.state.hold = null;
    release();
    await settle();
    expect(screen.getByRole('alertdialog', { name: 'This terminal is locked' })).toBeTruthy();
    expect(page.boot().session?.locked).toBe(true);
  });

  it('[DI-28][DI-14] an unlock the poll sees (another tab unlocked the session) closes the lock screen and is announced like any unlock', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const server = fixtureServer();
    setTransport(server.fetch);
    const page = renderPage();
    expect(await screen.findByText('Signed in as Asha Rao')).toBeTruthy();
    act(() => {
      page.access().lock();
    });
    expect(await screen.findByRole('alertdialog', { name: 'This terminal is locked' })).toBeTruthy();

    const changes: unknown[] = [];
    const listen = (e: Event) => changes.push((e as CustomEvent).detail);
    window.addEventListener('ebmr:session-change', listen);
    try {
      // Asha unlocked the session in another tab of this browser.
      server.state.locked = false;
      const asked = server.state.polls;
      await checkWhenControlled(page, () => server.state.polls > asked);
      await waitFor(() => {
        expect(screen.queryByRole('alertdialog', { name: 'This terminal is locked' })).toBeNull();
      });
      expect(changes).toContainEqual({ reason: 'UNLOCK', personId: ASHA.person.personId });
      expect(page.boot().session?.locked).toBe(false);
    } finally {
      window.removeEventListener('ebmr:session-change', listen);
    }
  });
});
