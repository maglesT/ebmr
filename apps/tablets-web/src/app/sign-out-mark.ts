/**
 * The mark of a sign-out the server has not confirmed yet (DI-38, DI-14; review P5).
 *
 * While the mark is set, no start-up of this page shows a session: it first finishes the sign-out, so the next person
 * at the terminal never gets the previous person's session back by reloading. The mark is kept where only this
 * installation's own pages can read or write it, and in this page's memory:
 *  - site storage (localStorage, kept per origin, so per installation and port); the other tabs of this page are told
 *    when it changes (storage events);
 *  - the other tabs of this page that are open are also told over a broadcast channel of this origin (they learn of a
 *    sign-out at once even where site storage is switched off or throws), and told again when it is confirmed.
 * No cookie keeps it: cookies are shared by every port of the host, so a page of another installation (or any page on
 * the host) could write a mark that makes this page end the person's session, or delete one so that a pending
 * sign-out looked finished (review F42).
 * A start-up that cannot use site storage cannot know whether a sign-out is pending, so it assumes one is (fail closed):
 * it ends any session it finds instead of showing it.
 *
 * Each mark carries a random token. The server's confirmation clears only the marks this page knew of when it asked
 * (compare and clear); a mark set later by another tab stays until that tab, or the next start-up, has finished its
 * own sign-out. A page waiting on an unconfirmed sign-out whose mark is gone from site storage, or whose tokens another
 * tab has confirmed over the channel, knows that another tab (or a reload) has finished that sign-out: it must not end
 * whatever session the browser holds by now (another person may have signed in since). A mark kept in memory only can
 * never be seen as finished elsewhere.
 *
 * Every other page of this browser that shows a session or the sign-in form looks for a mark it has not joined
 * (signOutMarkedElsewhere: on a storage event or a channel message, when it becomes visible, and every
 * SIGN_OUT_MARK_CHECK_MS). A page that finds one joins that sign-out (joinSignOut): it blocks and ends the session
 * itself, so a sign-out never depends on the tab that started it staying open.
 */

/** The site storage key (site storage is per origin, so per installation). */
export const SIGN_OUT_MARK_KEY = 'ebmr.signOutPending';

/** How often a page that shows a session or the sign-in form reads the stores for a mark it has not joined. */
export const SIGN_OUT_MARK_CHECK_MS = 1_000;

/** The broadcast channel the tabs of this origin tell each other of sign-outs on (a channel is kept per origin). */
export const SIGN_OUT_CHANNEL = 'ebmr.signOut';

const PROBE = 'ebmr.storageProbe';

/** Where a mark was kept: site storage, or announced to the other tabs over the channel. */
type Store = 'local' | 'channel';

/** This page's pending sign-out: the tokens it set or found, and where they were kept. */
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
// The channel. A message is either a sign-out another tab started (its token) or the tokens of a sign-out another tab
// has finished (the server confirmed it).

type ChannelMessage = { kind: 'started'; token: string } | { kind: 'confirmed'; tokens: string[] };

/** Tokens other tabs announced and nobody has confirmed since. */
const heard = new Set<string>();
/** Tokens another tab has confirmed (finished elsewhere). */
const confirmedElsewhere = new Set<string>();
const listeners = new Set<() => void>();
let channel: BroadcastChannel | null = null;

const isToken = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v);

function onChannelMessage(e: MessageEvent): void {
  const m = e.data as Partial<ChannelMessage> | null;
  if (m?.kind === 'started' && isToken(m.token)) {
    if (!confirmedElsewhere.has(m.token)) heard.add(m.token);
  } else if (m?.kind === 'confirmed' && Array.isArray(m.tokens)) {
    for (const t of m.tokens) {
      if (!isToken(t)) continue;
      heard.delete(t);
      confirmedElsewhere.add(t);
    }
  } else {
    return;
  }
  for (const listener of listeners) listener();
}

/**
 * Listens on this origin's sign-out channel while the page runs: `onNews` is called after each message (another tab
 * started or confirmed a sign-out). The returned function stops listening; the channel closes with its last listener.
 */
export function listenForSignOuts(onNews: () => void): () => void {
  listeners.add(onNews);
  if (channel === null && typeof BroadcastChannel !== 'undefined') {
    try {
      channel = new BroadcastChannel(SIGN_OUT_CHANNEL);
      channel.onmessage = onChannelMessage;
    } catch {
      channel = null;
    }
  }
  return () => {
    listeners.delete(onNews);
    if (listeners.size === 0 && channel !== null) {
      channel.close();
      channel = null;
    }
  };
}

/** Tells the other tabs of this origin; false when no channel can be used. */
function announce(message: ChannelMessage): boolean {
  try {
    if (channel !== null) {
      channel.postMessage(message);
      return true;
    }
    if (typeof BroadcastChannel === 'undefined') return false;
    const once = new BroadcastChannel(SIGN_OUT_CHANNEL);
    once.postMessage(message);
    once.close();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Site storage. A read gives `undefined` when it cannot be used at all (it throws).

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

/** Adds what site storage holds now, and what other tabs announced, to this page's mark. */
function adoptStored(into: PageMark): void {
  const v = localRead();
  if (v) {
    into.tokens.add(v);
    into.keptIn.add('local');
  }
  for (const t of heard) {
    into.tokens.add(t);
    into.keptIn.add('channel');
  }
}

// ---------------------------------------------------------------------------------------------
// The mark

/** A sign-out this page starts: a new mark in memory, in site storage and told to the other tabs (and any mark already set). */
export function startSignOut(): void {
  const mark: PageMark = page ?? { tokens: new Set(), keptIn: new Set() };
  adoptStored(mark);
  const token = newToken();
  mark.tokens.add(token);
  if (localWrite(token)) mark.keptIn.add('local');
  if (announce({ kind: 'started', token })) mark.keptIn.add('channel');
  page = mark;
}

/**
 * At start-up: whether a sign-out must be finished before any session is shown. True for a mark in memory, in site
 * storage or announced by another tab, and when site storage cannot hold a mark (a mark set before may have been lost:
 * fail closed). A pending sign-out becomes this page's own, so the page keeps blocking and retrying even if site
 * storage loses the mark.
 */
export function signOutPendingAtStartUp(): boolean {
  const mark: PageMark = page ?? { tokens: new Set(), keptIn: new Set() };
  adoptStored(mark);
  if (mark.tokens.size === 0 && localRead() !== undefined && localUsable()) return false;
  page = mark;
  return true;
}

/**
 * Whether this page's sign-out is still wanted: false when this page has none, or when another tab or a reload has
 * finished it: site storage, where the mark was kept there and can be read now, holds no mark any more; else, where it
 * was told over the channel, another tab has confirmed every one of its tokens. True whenever that cannot be told: a
 * mark kept in memory only, or kept in site storage alone that cannot be read now.
 */
export function signOutStillPending(): boolean {
  if (!page) return false;
  if (page.keptIn.has('local')) {
    const v = localRead();
    if (v !== undefined) return v !== null;
  }
  if (page.keptIn.has('channel')) return [...page.tokens].some((t) => !confirmedElsewhere.has(t));
  return true;
}

/**
 * The server confirmed that this browser holds no session: this page's mark is cleared from memory and from site storage
 * if it still holds one of its tokens, and the other tabs are told those tokens are finished. A mark set since by
 * another tab stays.
 */
export function confirmSignedOut(): void {
  if (!page) return;
  const local = localRead();
  if (local && page.tokens.has(local)) localRemove();
  const tokens = [...page.tokens];
  for (const t of tokens) heard.delete(t);
  announce({ kind: 'confirmed', tokens });
  page = null;
}

/**
 * Whether this browser keeps the mark of a sign-out that this page has not joined: another tab started it (or a
 * start-up could not finish it) while this page shows a session or the sign-in form. False while this page has a
 * sign-out of its own pending (it already acts on every mark it found).
 */
export function signOutMarkedElsewhere(): boolean {
  if (page) return false;
  return Boolean(localRead()) || heard.size > 0;
}

/**
 * Joins the sign-out marked in this browser: its tokens, and where they were kept, become this page's own mark, so this
 * page ends the session itself (and clears exactly those marks once the server confirms). False when no mark is left
 * (it was finished meanwhile) and this page has none of its own.
 */
export function joinSignOut(): boolean {
  if (page) return true;
  const mark: PageMark = { tokens: new Set(), keptIn: new Set() };
  adoptStored(mark);
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
