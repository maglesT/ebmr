/**
 * Review F41, round 4 (DI-13, DI-14, DI-38): cookies ignore ports, so a page on another port of this computer can set this
 * installation's session cookie when the browser holds none (another person's live session, from another terminal), and
 * another tab's sign-in replaces the cookie while a page works; the page then worked in that session. Now the page names
 * the key of its own terminal and the person its session started with on every request (page-binding.ts), the server
 * serves any other session as nobody (SESSION_OTHER_TERMINAL, SESSION_CHANGED), and the page: shows the sign-in form
 * when the browser's sign-in was opened on another terminal; stops showing the session at once, and says so, when the
 * browser's sign-in is another person's; and keeps the person its session started with across a reload of the tab.
 * The server's half is proven in apps/tablets-server/test/platform/security.test.ts.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { routes, type SessionView } from '@ebmr/api-contract';
import { EXAMPLES } from '@ebmr/api-contract/examples';

const holder = vi.hoisted(() => ({ key: null as null | { privateKey: CryptoKey; publicKeySpki: string; label: string } }));
vi.mock('../../src/device/keystore.ts', () => ({
  loadDeviceKey: () => Promise.resolve(holder.key),
  saveDeviceKey: () => Promise.resolve(),
  forgetDeviceKey: () => Promise.resolve(),
  importDemoKey: () => Promise.reject(new Error('not used in this test')),
}));

const { api, apiState, browserFetch, setTransport } = await import('../../src/api/client.ts');
const { bindPagePerson, pagePerson, terminalKeyOf } = await import('../../src/api/page-binding.ts');
const { BootProvider, useBoot } = await import('../../src/app/boot.tsx');
const { Gate } = await import('../../src/app/App.tsx');

const asha = EXAMPLES['session-office'].data as SessionView;
const meera: SessionView = { ...asha, person: { ...asha.person, personId: '8d3c1f2e-5b6a-4c7d-9e8f-0a1b2c3d4e5f', legalName: 'Meera Iyer', loginName: 'meera.iyer' } };
const envelope = (code: string) => ({ refusal: { code, kind: 'NOT_ALLOWED', whatHappened: code, why: '', controls: [], whatYouCanDo: [], whoCanHelp: [] }, correlationId: 'fake', retryable: false });

/**
 * A fake server behind window.fetch (the page's own transport, browserFetch, runs): the browser holds the session of
 * `person`, opened on the terminal of key `terminalKey`; it refuses a request whose page names another, as the server does.
 */
function fakeServer(state: { person: SessionView; terminalKey: string }) {
  const seen: Record<string, string>[] = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    const u = new URL(url, 'http://fake.local');
    const h = (init.headers ?? {}) as Record<string, string>;
    const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'x-ebmr-installation': 'GMP', 'content-type': 'application/json' } }));
    if (u.pathname === routes.meta.get.path) return json(200, EXAMPLES['meta-gmp'].data);
    if (u.pathname === routes.session.deviceNonce.path) return json(200, { nonce: 'fixture-nonce-0123456789', expiresInSeconds: 60 });
    if (u.pathname === routes.session.identify.path) return json(200, asha.device);
    if (u.pathname === routes.session.get.path) {
      seen.push(h);
      const key = h['x-ebmr-terminal-key'];
      if (key !== undefined && key !== state.terminalKey) return json(401, envelope('SESSION_OTHER_TERMINAL'));
      const person = h['x-ebmr-page-person'];
      if (person !== undefined && person !== state.person.person.personId) return json(401, envelope('SESSION_CHANGED'));
      return json(200, state.person);
    }
    return json(404, envelope('NOT_FOUND'));
  });
  setTransport(browserFetch);
  return seen;
}

function renderPage() {
  function Page() {
    const boot = useBoot();
    return boot.phase === 'ready' ? <p>{`Signed in as ${boot.session?.person.legalName ?? ''}`}</p> : <Gate />;
  }
  render(
    <BootProvider>
      <Page />
    </BootProvider>,
  );
}

let pageKey = '';

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const spki = Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64');
  holder.key = { privateKey: pair.privateKey, publicKeySpki: spki, label: 'PC-DESIGN-01' };
  pageKey = await terminalKeyOf(spki);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
  bindPagePerson(null);
  apiState.terminalKey = undefined;
});

describe('F41 round 4: the page works only in the sign-in it started with', () => {
  it('[DI-13][DI-20] the terminal key the page names is the kernel\'s device fingerprint of its key: the SHA-256 of the SPKI', async () => {
    const { createHash } = await import('node:crypto');
    const spki = holder.key?.publicKeySpki ?? '';
    expect(pageKey).toBe(createHash('sha256').update(Buffer.from(spki, 'base64')).digest('hex'));
    expect(pageKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('[DI-13][DI-14][DI-38] every request names the page\'s terminal key and the person its session started with; neither while unknown', async () => {
    const seen: Record<string, string>[] = [];
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      seen.push({ ...(init.headers as Record<string, string>) });
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    await browserFetch('/api/session', { method: 'GET', headers: { accept: 'application/json' } });
    apiState.terminalKey = pageKey;
    bindPagePerson(asha.person.personId);
    await browserFetch('/api/session', { method: 'GET', headers: { accept: 'application/json' } });
    expect(seen).toEqual([
      { accept: 'application/json' },
      { accept: 'application/json', 'x-ebmr-terminal-key': pageKey, 'x-ebmr-page-person': asha.person.personId },
    ]);
  });

  it('[DI-13][DI-14][DI-38] a browser that holds a sign-in opened on another terminal (set by another page of this computer) shows the sign-in form, never that person', async () => {
    fakeServer({ person: meera, terminalKey: 'f'.repeat(64) });
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(screen.queryByText(/Meera Iyer/)).toBeNull();
    expect(pagePerson()).toBeUndefined();
  });

  it('[DI-13][DI-14][DI-38] when the browser\'s sign-in becomes another person\'s while the page works, the page stops showing the session at once and says so; it shows who is signed in only when asked', async () => {
    const state = { person: asha, terminalKey: pageKey };
    const seen = fakeServer(state);
    renderPage();
    expect(await screen.findByText('Signed in as Asha Rao')).toBeTruthy();
    expect(pagePerson()).toBe(asha.person.personId);
    // Another tab signs in as Meera Iyer (or another page of this computer sets her sign-in): the page's next request.
    state.person = meera;
    await act(async () => {
      const r = await api.call(routes.session.get);
      expect(r.ok).toBe(false);
    });
    expect(await screen.findByText("This page's sign-in has changed")).toBeTruthy();
    expect(screen.queryByText('Signed in as Asha Rao')).toBeNull();
    expect(screen.queryByText(/Meera Iyer/)).toBeNull();
    expect(seen.at(-1)?.['x-ebmr-page-person']).toBe(asha.person.personId);
    // Asked: the page starts again with the browser's sign-in, and shows whose it is.
    await userEvent.click(screen.getByRole('button', { name: 'Show who is signed in now' }));
    expect(await screen.findByText('Signed in as Meera Iyer')).toBeTruthy();
    expect(pagePerson()).toBe(meera.person.personId);
  });

  it('[DI-13][DI-14][DI-38] a reload keeps the person the tab\'s session started with: another person\'s sign-in found at start-up is not shown', async () => {
    bindPagePerson(asha.person.personId);
    fakeServer({ person: meera, terminalKey: pageKey });
    renderPage();
    expect(await screen.findByText("This page's sign-in has changed")).toBeTruthy();
    expect(screen.queryByText(/Meera Iyer/)).toBeNull();
  });

  it('[DI-13][DI-38] a refusal that names the person this page held before it started another session itself (a switch whose answer came first) is not reported', async () => {
    const told: string[] = [];
    const listen = (code: string) => {
      told.push(code);
    };
    apiState.onForeignSession.add(listen);
    try {
      bindPagePerson(asha.person.personId);
      vi.stubGlobal('fetch', () => {
        // The switch's answer arrives meanwhile: the page now works in Meera's session.
        bindPagePerson(meera.person.personId);
        return Promise.resolve(new Response(JSON.stringify(envelope('SESSION_CHANGED')), { status: 401 }));
      });
      await browserFetch('/api/session', { method: 'GET', headers: {} });
      expect(told).toEqual([]);
      vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify(envelope('SESSION_CHANGED')), { status: 401 })));
      await browserFetch('/api/session', { method: 'GET', headers: {} });
      expect(told).toEqual(['SESSION_CHANGED']);
    } finally {
      apiState.onForeignSession.delete(listen);
    }
  });
});
