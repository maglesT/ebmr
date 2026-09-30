/**
 * The mark of a sign-out the server has not confirmed yet (DI-38, DI-14; review P5).
 *
 * While the mark is set, no start-up of this page shows a session: it first finishes the sign-out, so the next person
 * at the terminal never gets the previous person's session back by reloading. The mark is kept wherever this browser
 * can keep something across a reload, and in this page's memory:
 *  - site storage (localStorage); the other tabs of this page are told when it changes (storage events);
 *  - a same-site cookie of this installation that the page itself writes and reads. It holds only a random token, no
 *    secret. It works where site storage is switched off or throws; the session itself lives in a cookie, so a
 *    browser that can hold a session can hold this mark. One name per installation, because cookies, unlike site
 *    storage, are not kept apart by port.
 * A start-up that can use neither store cannot know whether a sign-out is pending, so it assumes one is (fail closed):
 * it ends any session it finds instead of showing it.
 *
 * Each mark carries a random token. The server's confirmation clears only the marks this page knew of when it asked
 * (compare and clear); a mark set later by another tab stays until that tab, or the next start-up, has finished its
 * own sign-out. A page waiting on an unconfirmed sign-out whose mark is gone from every store it was kept in knows
 * that another tab (or a reload) has finished that sign-out: it must not end whatever session the browser holds by
 * now (another person may have signed in since). A mark kept in memory only can never be seen as finished elsewhere.
 *
 * Every other page of this browser that shows a session or the sign-in form looks for a mark it has not joined
 * (signOutMarkedElsewhere: on a storage event, when it becomes visible, and every SIGN_OUT_MARK_CHECK_MS; site storage
 * tells other tabs at once, the cookie only when read). A page that finds one joins that sign-out (joinSignOut): it
 * blocks and ends the session itself, so a sign-out never depends on the tab that started it staying open.
 */
import type { InstallationKind } from '@ebmr/api-contract';

/** The site storage key (site storage is per origin, so per installation). */
export const SIGN_OUT_MARK_KEY = 'ebmr.signOutPending';

/** How often a page that shows a session or the sign-in form reads the stores for a mark it has not joined. */
export const SIGN_OUT_MARK_CHECK_MS = 1_000;

/**
 * The cookie name for an installation (cookies are shared by every port of a host). Before the installation is known
 * (no start-up has read /api/meta yet) there is no cookie name, and only site storage and memory keep the mark.
 */
export const signOutMarkCookie = (installation: InstallationKind | undefined): string | null =>
  installation === undefined ? null : `ebmr_${installation === 'GMP' ? 'gmp' : 'sbx'}_signout`;

/** Longer than any session can live, so the mark never ends before the session it guards. */
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 3600;
const PROBE = 'ebmr.storageProbe';

type Store = 'local' | 'cookie';

/** This page's pending sign-out: the tokens it set or found, and the stores they were kept in. */
interface PageMark {
  tokens: Set<string>;
  keptIn: Set<Store>;
}

let page: PageMark | null = null;

function newToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------------------------
// The two stores. A read gives `undefined` when the store cannot be used at all (it throws).

function localRead(): string | null | undefined {
  try {
    const v = window.localStorage.getItem(SIGN_OUT_MARK_KEY);
    return v === null || v === '' ? null : v;
  } catch {
    return undefined;
  }
}

function localWrite(token: string): boolean {
  try {
    window.localStorage.setItem(SIGN_OUT_MARK_KEY, token);
    return window.localStorage.getItem(SIGN_OUT_MARK_KEY) === token;
  } catch {
    return false;
  }
}

function localRemove(): void {
  try {
    window.localStorage.removeItem(SIGN_OUT_MARK_KEY);
  } catch {
    // A store that cannot be used holds nothing to remove.
  }
}

function localUsable(): boolean {
  try {
    window.localStorage.setItem(PROBE, '1');
    const ok = window.localStorage.getItem(PROBE) === '1';
    window.localStorage.removeItem(PROBE);
    return ok;
  } catch {
    return false;
  }
}

function cookieRead(name: string | null): string | null | undefined {
  if (name === null) return undefined;
  try {
    for (const part of document.cookie.split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === name) {
        const v = part.slice(i + 1).trim();
        if (v !== '') return v;
      }
    }
    return null;
  } catch {
    return undefined;
  }
}

const cookieAttributes = (): string => `; Path=/; SameSite=Strict${window.location.protocol === 'https:' ? '; Secure' : ''}`;

function cookieWrite(name: string | null, token: string): boolean {
  if (name === null) return false;
  try {
    document.cookie = `${name}=${token}; Max-Age=${COOKIE_MAX_AGE_SECONDS}${cookieAttributes()}`;
    return cookieRead(name) === token;
  } catch {
    return false;
  }
}

function cookieRemove(name: string | null): void {
  if (name === null) return;
  try {
    document.cookie = `${name}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${cookieAttributes()}`;
  } catch {
    // A store that cannot be used holds nothing to remove.
  }
}

function cookieUsable(): boolean {
  const name = `ebmr_storage_probe_${newToken().slice(0, 8)}`;
  const ok = cookieWrite(name, '1');
  cookieRemove(name);
  return ok;
}

const read = (store: Store, installation: InstallationKind | undefined): string | null | undefined =>
  store === 'local' ? localRead() : cookieRead(signOutMarkCookie(installation));

/** Adds what the stores hold now to this page's mark. */
function adoptStored(installation: InstallationKind | undefined, into: PageMark): void {
  for (const store of ['local', 'cookie'] as const) {
    const v = read(store, installation);
    if (v) {
      into.tokens.add(v);
      into.keptIn.add(store);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The mark

/** A sign-out this page starts: a new mark in memory and in every store that keeps it (and any mark already set). */
export function startSignOut(installation: InstallationKind | undefined): void {
  const mark: PageMark = page ?? { tokens: new Set(), keptIn: new Set() };
  adoptStored(installation, mark);
  const token = newToken();
  mark.tokens.add(token);
  if (localWrite(token)) mark.keptIn.add('local');
  if (cookieWrite(signOutMarkCookie(installation), token)) mark.keptIn.add('cookie');
  page = mark;
}

/**
 * At start-up: whether a sign-out must be finished before any session is shown. True for a mark in memory or in
 * either store, and when neither store can hold a mark (a mark set before may have been lost: fail closed). A pending
 * sign-out becomes this page's own, so the page keeps blocking and retrying even if the stores lose the mark.
 */
export function signOutPendingAtStartUp(installation: InstallationKind | undefined): boolean {
  const mark: PageMark = page ?? { tokens: new Set(), keptIn: new Set() };
  adoptStored(installation, mark);
  if (mark.tokens.size === 0) {
    const local = localRead();
    const cookie = cookieRead(signOutMarkCookie(installation));
    const canHoldMark = (local !== undefined && localUsable()) || (cookie !== undefined && cookieUsable());
    if (canHoldMark) return false;
  }
  page = mark;
  return true;
}

/**
 * Whether this page's sign-out is still wanted: false when this page has none, or when every store its mark was kept
 * in can be read and holds no mark any more (another tab or a reload has finished it). True whenever that cannot be
 * told: a mark kept in memory only, or a store that cannot be read now.
 */
export function signOutStillPending(installation: InstallationKind | undefined): boolean {
  if (!page) return false;
  if (page.keptIn.size === 0) return true;
  for (const store of page.keptIn) {
    if (read(store, installation) !== null) return true;
  }
  return false;
}

/**
 * The server confirmed that this browser holds no session: this page's mark is cleared from memory, and from each store
 * that still holds one of its tokens. A mark set since by another tab stays.
 */
export function confirmSignedOut(installation: InstallationKind | undefined): void {
  if (!page) return;
  const local = localRead();
  if (local && page.tokens.has(local)) localRemove();
  const name = signOutMarkCookie(installation);
  const cookie = cookieRead(name);
  if (cookie && page.tokens.has(cookie)) cookieRemove(name);
  page = null;
}

/**
 * Whether this browser keeps the mark of a sign-out that this page has not joined: another tab started it (or a
 * start-up could not finish it) while this page shows a session or the sign-in form. False while this page has a
 * sign-out of its own pending (it already acts on every mark it found).
 */
export function signOutMarkedElsewhere(installation: InstallationKind | undefined): boolean {
  if (page) return false;
  return Boolean(read('local', installation)) || Boolean(read('cookie', installation));
}

/**
 * Joins the sign-out marked in this browser: its tokens, and the stores that keep them, become this page's own mark,
 * so this page ends the session itself (and clears exactly those marks once the server confirms). False when no store
 * holds a mark any more (it was finished meanwhile) and this page has none of its own.
 */
export function joinSignOut(installation: InstallationKind | undefined): boolean {
  if (page) return true;
  const mark: PageMark = { tokens: new Set(), keptIn: new Set() };
  adoptStored(installation, mark);
  if (mark.tokens.size === 0) return false;
  page = mark;
  return true;
}

/** Another tab or a reload finished this page's sign-out: this page forgets it (the stores hold nothing of it). */
export function forgetSignOut(): void {
  page = null;
}

/** Whether this page has a sign-out pending. */
export function signOutPendingHere(): boolean {
  return page !== null;
}
