// @vitest-environment happy-dom
/**
 * Review P5 (DI-38, DI-14, DI-22): the SPA's sign-out (apps/tablets-web/src/app/boot.tsx, BootProvider.signOut) never
 * shows the signed-out screen while the server session is still alive, and a reload never brings the previous
 * person's session back.
 *
 * The real SPA boot code runs in happy-dom against the real GMP server (app.inject through the test harness; one
 * cookie jar = one browser on PC-DESIGN-01). Asha Rao (MBR_AUTHOR) is signed in; her sign-out request is lost on the
 * network or refused by a failing server. If the page shows the sign-in form, the session must really be gone; if the
 * server did not confirm the sign-out, the page stays on "sign-out not confirmed", the session is locked (it needs
 * credentials again), and the next person's reload at the same PC does not come back signed in as Asha.
 *
 * A reload here is a real one: the SPA's modules are evaluated afresh (vi.resetModules), so nothing the previous page
 * kept in memory survives; only what the browser keeps does (its cookies, site storage and the page-readable cookies of
 * document.cookie). A second tab is a second, separate evaluation of the modules in the same browser. The tabs share
 * one happy-dom window, which raises no storage events between them: another tab learns of a sign-out only by reading
 * the stores itself (as it must when only the cookie keeps the mark).
 */
import { createElement, type ComponentType, type ReactNode } from 'react';
import type { webcrypto } from 'node:crypto';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { routes, type FetchLike, type SessionView } from '@ebmr/api-contract';
import { terminalOf } from '@ebmr/test-kit';
import { cookieHeader, ORIGINS, startServer, type TestBrowser, type TestServer } from '../support/harness.ts';

// The terminal key normally lives in IndexedDB (not available in happy-dom): hand the SPA PC-DESIGN-01's seeded key.
const holder = vi.hoisted(() => ({ key: null as null | { privateKey: webcrypto.CryptoKey; publicKeySpki: string; label: string } }));
vi.mock('../../../tablets-web/src/device/keystore.ts', () => ({
  loadDeviceKey: () => Promise.resolve(holder.key),
  saveDeviceKey: () => Promise.resolve(),
  forgetDeviceKey: () => Promise.resolve(),
  importDemoKey: () => Promise.reject(new Error('not used in this test')),
}));

/** What this test uses of the SPA's boot state (apps/tablets-web/src/app/boot.tsx). */
interface Boot {
  phase: string;
  session: SessionView | null;
  problem: string | null;
  signOut(): Promise<void>;
}
/** One evaluation of the SPA's modules: one page load. */
interface Web {
  setTransport: (f: FetchLike) => void;
  BootProvider: ComponentType<{ children?: ReactNode }>;
  useBoot: () => Boot;
}
// The SPA's own modules, loaded at run time: the server project's typecheck has no DOM library or JSX, so the web
// sources are typechecked by apps/tablets-web/tsconfig.json, and here only through the shapes above.
const WEB = '../../../tablets-web/src';

/** A page load: the SPA's modules evaluated afresh (nothing of an earlier page's memory survives). */
async function loadPage(): Promise<Web> {
  vi.resetModules();
  const client = (await import(/* @vite-ignore */ `${WEB}/api/client.ts`)) as { setTransport: (f: FetchLike) => void };
  const boot = (await import(/* @vite-ignore */ `${WEB}/app/boot.tsx`)) as { BootProvider: Web['BootProvider']; useBoot: Web['useBoot'] };
  return { setTransport: client.setTransport, BootProvider: boot.BootProvider, useBoot: boot.useBoot };
}

let server: TestServer;
/** The browser at PC-DESIGN-01: its HttpOnly cookies (the session), shared by all its tabs. */
let jar = new Map<string, string>();

function absorbSetCookie(header: string | string[] | undefined, into: Map<string, string>): void {
  const list = header === undefined ? [] : Array.isArray(header) ? header : [header];
  for (const line of list) {
    const [pair = ''] = line.split(';');
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (value === '' || /expires=Thu, 01 Jan 1970/i.test(line) || /max-age=0/i.test(line)) into.delete(name);
    else into.set(name, value);
  }
}

/**
 * The network between this browser and the server: it can drop logout requests, hold them, drop everything, or lose
 * every request of one tab (`lostFrom`, by the tab's name).
 */
const network = {
  dropLogouts: 0,
  logoutAnswers503: false,
  down: false,
  lostFrom: new Set<string>(),
  droppedLogouts: 0,
  hold: null as Promise<void> | null,
  sent: [] as string[],
};
function resetNetwork(): void {
  Object.assign(network, { dropLogouts: 0, logoutAnswers503: false, down: false, lostFrom: new Set<string>(), droppedLogouts: 0, hold: null, sent: [] });
}

/** The transport of one tab of this browser: same origin, the browser's cookie jar. */
function browserTransport(tab: string): FetchLike {
  return async (url, init) => {
    if (network.down || network.lostFrom.has(tab)) throw new TypeError('Failed to fetch');
    const logout = init.method === 'POST' && url.startsWith('/api/session/logout');
    if (logout && network.hold) await network.hold;
    if (logout && network.dropLogouts > 0) {
      network.dropLogouts -= 1;
      network.droppedLogouts += 1;
      throw new TypeError('Failed to fetch');
    }
    if (logout && network.logoutAnswers503) {
      const envelope = { refusal: { code: 'INTERNAL', kind: 'SERVER_ERROR', whatHappened: 'The server could not finish the request.', why: '', controls: [], whatYouCanDo: [], whoCanHelp: [] }, correlationId: 'proxy', retryable: true };
      return { status: 503, headers: { get: (n: string) => (n.toLowerCase() === 'x-ebmr-installation' ? 'GMP' : null) }, text: () => Promise.resolve(JSON.stringify(envelope)) };
    }
    network.sent.push(`${init.method} ${url}`);
    const res = await server.app.inject({
      method: init.method as 'GET',
      url,
      headers: { ...init.headers, origin: ORIGINS.GMP, 'sec-fetch-site': 'same-origin', ...(jar.size ? { cookie: cookieHeader(jar) } : {}) },
      ...(init.body !== undefined ? { payload: init.body } : {}),
    });
    absorbSetCookie(res.headers['set-cookie'], jar);
    return {
      status: res.statusCode,
      headers: { get: (name: string) => (res.headers[name.toLowerCase()] as string | undefined) ?? null },
      text: () => Promise.resolve(res.body),
    };
  };
}

interface Page {
  current: () => Boot;
  /** Unmounts this tab only. */
  close: () => void;
}

/** Opens the page in a tab of this browser (a fresh page load) and waits for its start-up. */
async function openPage(tab = 'tab'): Promise<Page> {
  const web = await loadPage();
  web.setTransport(browserTransport(tab));
  const seen: { boot: Boot | null } = { boot: null };
  function Probe() {
    seen.boot = web.useBoot();
    return null;
  }
  const view = render(createElement(web.BootProvider, null, createElement(Probe)));
  await waitFor(
    () => {
      expect(seen.boot?.phase).not.toBe('loading');
    },
    { timeout: 20_000 },
  );
  return {
    current: () => {
      if (!seen.boot) throw new Error('no boot');
      return seen.boot;
    },
    close: () => view.unmount(),
  };
}

/** The next person reloads the page at the same PC: every tab closes, a fresh page loads in the same browser. */
async function reload(): Promise<{ phase: string; who: string | null }> {
  cleanup();
  const page = await openPage();
  return { phase: page.current().phase, who: page.current().session?.person.legalName ?? null };
}

/** Asha signed in on PC-DESIGN-01; this browser's cookie jar holds her session. */
async function ashaAtHerPc(): Promise<TestBrowser> {
  const asha = await server.asPersona('author', 'PC-DESIGN-01');
  jar = asha.cookies;
  return asha;
}

/** The kernel state of a person's newest session. */
async function kernelSession(loginName = 'asha.rao'): Promise<{ ended: boolean; locked: boolean }> {
  const { rows } = await server.db.admin.query<{ ended: boolean; locked: boolean }>(
    `select s.ended_at is not null as ended, s.locked_at is not null as locked
       from iam.session s join iam.account a on a.id = s.account_id
      where a.login_name = $1 order by s.opened_at desc limit 1`,
    [loginName],
  );
  if (!rows[0]) throw new Error(`no session of ${loginName}`);
  return rows[0];
}

// ---------------------------------------------------------------------------------------------
// What the browser can keep across a reload: site storage and page-readable cookies, each of which can be unusable.

/** The happy-dom page globals this test touches (the server project's typecheck has no DOM library). */
const dom = globalThis as unknown as { window: { localStorage: { clear(): void } }; document: { cookie: string } };

const storage = {
  /** Site storage switched off (e.g. blocked site data): every access throws. */
  breakSiteStorage(): void {
    Object.defineProperty(dom.window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
  },
  /** Page-readable cookies unusable: every access to document.cookie throws. */
  breakPageCookies(): void {
    Object.defineProperty(dom.document, 'cookie', {
      configurable: true,
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
      set() {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
  },
  restore(): void {
    if (localStorageDescriptor) Object.defineProperty(dom.window, 'localStorage', localStorageDescriptor);
    Reflect.deleteProperty(dom.document, 'cookie');
  },
  /** Empties both (a browser with nothing kept). */
  clear(): void {
    dom.window.localStorage.clear();
    for (const part of dom.document.cookie.split(';')) {
      const name = part.split('=')[0]?.trim();
      if (name) dom.document.cookie = `${name}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/`;
    }
  },
};
const localStorageDescriptor = Object.getOwnPropertyDescriptor(dom.window, 'localStorage');

beforeAll(async () => {
  server = await startServer('GMP');
  const k = terminalOf(server.seed, 'PC-DESIGN-01').key;
  if (!k) throw new Error('PC-DESIGN-01 has no browser key');
  const privateKey = await crypto.subtle.importKey('pkcs8', Uint8Array.from(Buffer.from(k.privateKeyPkcs8, 'base64')), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  holder.key = { privateKey, publicKeySpki: k.publicKeySpki, label: 'PC-DESIGN-01' };
});

afterEach(async () => {
  // A test that stopped half-way may leave a sign-out pending: a page load on a working network finishes it.
  storage.restore();
  resetNetwork();
  await reload();
  cleanup();
  storage.clear();
});

afterAll(async () => {
  await server?.close();
});

describe('P5: a sign-out the server did not confirm', () => {
  it('[DI-38][DI-14] the SPA never shows the sign-in form while the previous user is still signed in; a reload does not bring that user back (logout lost once)', async () => {
    const asha = await ashaAtHerPc();
    const page = await openPage();
    expect(page.current().phase).toBe('ready');
    expect(page.current().session?.person.legalName).toBe('Asha Rao');

    // She clicks Sign out; the request is lost on the network once.
    network.dropLogouts = 1;
    await act(async () => {
      await page.current().signOut();
    });
    expect(network.droppedLogouts).toBe(1);
    const shown = page.current().phase;
    const serverSessionAlive = (await asha.call(routes.session.get)).ok;
    const afterReload = await reload();

    // The page may say "signed out" only when that is true; it is true here because the SPA asked the server again.
    expect(shown).toBe('signed-out');
    expect(serverSessionAlive, 'the page shows the sign-in form, but the server session of Asha Rao is still alive').toBe(false);
    expect(await kernelSession()).toMatchObject({ ended: true });
    expect(afterReload, 'a reload after the "signed out" screen came back signed in as the previous user').toEqual({ phase: 'signed-out', who: null });
  });

  it('[DI-38][DI-14] when every logout fails, the page stays on "sign-out not confirmed", the session is locked, and a real reload retries the sign-out instead of showing the session', async () => {
    const asha = await ashaAtHerPc();
    const page = await openPage();
    expect(page.current().phase).toBe('ready');

    network.logoutAnswers503 = true;
    await act(async () => {
      await page.current().signOut();
    });
    expect(page.current().phase).toBe('sign-out-unconfirmed');
    expect(page.current().session).toBeNull();
    // The fallback reached the server: the session now needs Asha's credentials again (DI-38).
    expect(await kernelSession()).toEqual({ ended: false, locked: true });
    const view = await asha.call(routes.session.get);
    expect(view.ok && view.value.locked).toBe(true);

    // The next person reloads while the server still fails the logout: still not signed in as Asha.
    expect(await reload()).toEqual({ phase: 'sign-out-unconfirmed', who: null });

    // The server recovers: the next reload finishes the sign-out, and only then shows the sign-in form.
    network.logoutAnswers503 = false;
    expect(await reload()).toEqual({ phase: 'signed-out', who: null });
    expect(await kernelSession()).toMatchObject({ ended: true });
    expect((await asha.call(routes.session.get)).ok).toBe(false);
    // Signed out for good: the mark is cleared, the next reload is an ordinary signed-out start.
    network.sent = [];
    expect(await reload()).toEqual({ phase: 'signed-out', who: null });
    expect(network.sent.filter((r) => r.startsWith('POST /api/session/logout'))).toEqual([]);
  });

  it('[DI-38][DI-14] with the network down during sign-out, the retry on the screen signs out once the server is reachable again', async () => {
    const asha = await ashaAtHerPc();
    const page = await openPage();
    expect(page.current().phase).toBe('ready');

    network.down = true;
    await act(async () => {
      await page.current().signOut();
    });
    expect(page.current().phase).toBe('sign-out-unconfirmed');
    expect(page.current().problem).toBe('The server cannot be reached.');
    expect(await kernelSession()).toEqual({ ended: false, locked: false });

    network.down = false;
    await act(async () => {
      await page.current().signOut();
    });
    expect(page.current().phase).toBe('signed-out');
    expect(await kernelSession()).toMatchObject({ ended: true });
    expect((await asha.call(routes.session.get)).ok).toBe(false);
    expect(await reload()).toEqual({ phase: 'signed-out', who: null });
  });

  it('[DI-38] a sign-out that reaches the server ends the session and shows the sign-in form at once', async () => {
    const asha = await ashaAtHerPc();
    const page = await openPage();
    network.sent = [];
    await act(async () => {
      await page.current().signOut();
    });
    expect(page.current().phase).toBe('signed-out');
    expect(network.sent).toEqual(['POST /api/session/logout']);
    expect((await asha.call(routes.session.get)).ok).toBe(false);
  });
});

describe('P5: the mark of an unconfirmed sign-out across a real reload', () => {
  /**
   * Asha signs out while the network is down: nothing reaches the server, nothing is locked. The network comes back,
   * and the next person reloads the page (fresh modules). Only what the browser kept can say a sign-out is pending.
   */
  async function signOutOfflineThenReload(breakStores: () => void): Promise<{ shown: string; afterReload: { phase: string; who: string | null }; asha: TestBrowser }> {
    const asha = await ashaAtHerPc();
    const page = await openPage();
    expect(page.current().phase).toBe('ready');
    breakStores();
    network.down = true;
    await act(async () => {
      await page.current().signOut();
    });
    const shown = page.current().phase;
    expect(await kernelSession()).toEqual({ ended: false, locked: false });
    network.down = false;
    const afterReload = await reload();
    return { shown, afterReload, asha };
  }

  it('[DI-38][DI-14] the mark survives a real reload in site storage alone (page-readable cookies unusable)', async () => {
    const { shown, afterReload, asha } = await signOutOfflineThenReload(() => storage.breakPageCookies());
    expect(shown).toBe('sign-out-unconfirmed');
    expect(afterReload, 'a real reload came back signed in as the previous user').toEqual({ phase: 'signed-out', who: null });
    expect(await kernelSession()).toMatchObject({ ended: true });
    expect((await asha.call(routes.session.get)).ok).toBe(false);
  });

  it('[DI-38][DI-14] the mark survives a real reload in a page-readable cookie when site storage throws (e.g. site data blocked)', async () => {
    const { shown, afterReload, asha } = await signOutOfflineThenReload(() => storage.breakSiteStorage());
    expect(shown).toBe('sign-out-unconfirmed');
    expect(afterReload, 'a real reload came back signed in as the previous user').toEqual({ phase: 'signed-out', who: null });
    expect(await kernelSession()).toMatchObject({ ended: true });
    expect((await asha.call(routes.session.get)).ok).toBe(false);
    // The mark is gone once the sign-out is confirmed: the next page load is an ordinary signed-out start.
    expect(dom.document.cookie).not.toMatch(/ebmr_gmp_signout=\w/);
  });

  it('[DI-38][DI-14] a browser that can keep no mark at all fails closed: a page load ends any session it finds instead of showing it', async () => {
    // Both stores stop working while Asha is signed in: the mark of her sign-out can be kept nowhere.
    const { shown, afterReload, asha } = await signOutOfflineThenReload(() => {
      storage.breakSiteStorage();
      storage.breakPageCookies();
    });
    expect(shown).toBe('sign-out-unconfirmed');
    expect(afterReload, 'a real reload came back signed in as the previous user').toEqual({ phase: 'signed-out', who: null });
    expect(await kernelSession()).toMatchObject({ ended: true });
    expect((await asha.call(routes.session.get)).ok).toBe(false);

    // The price of failing closed, in such a browser: every page load ends the session it finds.
    const again = await ashaAtHerPc();
    expect(await reload()).toEqual({ phase: 'signed-out', who: null });
    expect((await again.call(routes.session.get)).ok).toBe(false);
  });
});

describe('P5: while the sign-out is in progress, and in other tabs', () => {
  it('[DI-38][DI-14] from the moment Sign out is pressed the page is blocked: not usable as the person signing out, and not shown as signed out', async () => {
    await ashaAtHerPc();
    const page = await openPage();
    expect(page.current().phase).toBe('ready');

    let release: () => void = () => undefined;
    network.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let done: Promise<void> = Promise.resolve();
    act(() => {
      done = page.current().signOut();
    });
    await waitFor(() => {
      expect(network.hold).not.toBeNull();
      expect(page.current().phase).toBe('signing-out');
    });
    // The server has not answered yet: no session on show, no sign-in form either.
    expect(page.current().session).toBeNull();
    network.hold = null;
    release();
    await act(async () => {
      await done;
    });
    expect(page.current().phase).toBe('signed-out');
    expect(await kernelSession()).toMatchObject({ ended: true });
  });

  it('[DI-38][DI-14] a tab left on "sign-out not confirmed" never ends the session of the next person, after another tab has finished the sign-out', async () => {
    await ashaAtHerPc();
    const tab1 = await openPage();
    network.logoutAnswers503 = true;
    await act(async () => {
      await tab1.current().signOut();
    });
    expect(tab1.current().phase).toBe('sign-out-unconfirmed');

    // The server recovers. The next person opens the page in another tab: it finishes the sign-out.
    network.logoutAnswers503 = false;
    const tab2 = await openPage();
    expect(tab2.current().phase).toBe('signed-out');
    expect(await kernelSession()).toMatchObject({ ended: true });

    // Vikram Shah signs in in this browser (his session cookie replaces the ended one).
    const vikram = await server.asPersona('checker', 'PC-DESIGN-01');
    jar.clear();
    for (const [k, v] of vikram.cookies) jar.set(k, v);
    tab2.close();

    // The first tab's next retry: the sign-out it waited on is finished, so it ends nothing and starts again.
    network.sent = [];
    await act(async () => {
      await tab1.current().signOut();
    });
    await waitFor(() => {
      expect(tab1.current().phase).toBe('ready');
    });
    expect(tab1.current().session?.person.legalName).toBe('Vikram Shah');
    expect(network.sent.filter((r) => r.startsWith('POST /api/session/logout') || r.startsWith('POST /api/access/lock'))).toEqual([]);
    expect(await kernelSession('vikram.shah')).toEqual({ ended: false, locked: false });
    expect((await vikram.call(routes.session.get)).ok).toBe(true);
  });
});

describe('P5: the other tabs of the browser join a sign-out the server did not confirm', () => {
  it('[DI-38][DI-14] a tab that shows the session joins at once, even while the server cannot be reached: it blocks, and it ends the session after the first tab was closed', async () => {
    await ashaAtHerPc();
    const tabA = await openPage('A');
    const tabB = await openPage('B');
    expect(tabB.current().phase).toBe('ready');

    network.down = true;
    await act(async () => {
      await tabA.current().signOut();
    });
    expect(tabA.current().phase).toBe('sign-out-unconfirmed');
    // Tab B finds the mark and joins the sign-out: it cannot reach the server either, so it blocks on "sign-out not
    // confirmed" (with its own retries) instead of staying usable as Asha.
    await waitFor(
      () => {
        expect(tabB.current().phase).toBe('sign-out-unconfirmed');
      },
      { timeout: 5_000 },
    );
    expect(tabB.current().session).toBeNull();
    expect(await kernelSession()).toEqual({ ended: false, locked: false });

    // Asha closes the first tab and leaves; the network comes back. Tab B's screen retries (SignOutUnconfirmed does so
    // every 10 s) and ends the session.
    tabA.close();
    network.down = false;
    await act(async () => {
      await tabB.current().signOut();
    });
    expect(tabB.current().phase).toBe('signed-out');
    expect(await kernelSession()).toMatchObject({ ended: true });
    expect(await reload()).toEqual({ phase: 'signed-out', who: null });
  });

  for (const [kept, breakStores] of [
    ['site storage and the cookie', () => undefined],
    ['the cookie alone (site storage throws)', () => storage.breakSiteStorage()],
  ] as const) {
    it(`[DI-38][DI-14] a sign-out that never reached the server leaves no tab usable as the person once its tab is closed: another tab that shows the session ends it (mark kept in ${kept})`, async () => {
      const asha = await ashaAtHerPc();
      const tabA = await openPage('A');
      const tabB = await openPage('B');
      expect(tabB.current().phase).toBe('ready');
      breakStores();

      // Every request of tab A is lost: nothing of its sign-out reaches the server, nothing is locked; then it is closed.
      network.lostFrom.add('A');
      await act(async () => {
        await tabA.current().signOut();
      });
      expect(tabA.current().session).toBeNull();
      expect(tabA.current().phase).not.toBe('ready');
      tabA.close();

      await waitFor(
        () => {
          expect(tabB.current().phase).toBe('signed-out');
        },
        { timeout: 5_000 },
      );
      expect(tabB.current().session).toBeNull();
      expect(await kernelSession()).toMatchObject({ ended: true });
      expect((await asha.call(routes.session.get)).ok).toBe(false);
      expect(await reload()).toEqual({ phase: 'signed-out', who: null });
    });
  }

  it('[DI-38][DI-14] a tab on the sign-in form joins too: the session is ended there before the next person can sign in', async () => {
    const before = await openPage('B');
    expect(before.current().phase).toBe('signed-out');
    await ashaAtHerPc();
    const tabA = await openPage('A');
    expect(tabA.current().phase).toBe('ready');

    network.lostFrom.add('A');
    await act(async () => {
      await tabA.current().signOut();
    });
    tabA.close();

    await waitFor(
      async () => {
        expect(await kernelSession()).toMatchObject({ ended: true });
      },
      { timeout: 5_000 },
    );
    await waitFor(() => {
      expect(before.current().phase).toBe('signed-out');
    });
    expect(network.sent).toContain('POST /api/session/logout');
    expect(await reload()).toEqual({ phase: 'signed-out', who: null });
  });
});
