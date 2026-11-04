/**
 * Phase B slice 2, the platform build: the page side of core's sign-on (server: features/session/platform.ts).
 *
 * The server's GET /cb sends the browser to /platform-signon#proof=…&purpose=LOGIN|SIGNATURE (or #error=…). The fragment
 * never reaches a server or a log. On start-up (main.tsx) takeSignonFragment reads it once and clears the address:
 *  - LOGIN: the proof is kept in memory for the sign-in screen, which posts it with the device proof;
 *  - SIGNATURE: this page is the window the signature dialog opened; it hands the proof to the dialog over a
 *    BroadcastChannel (COOP same-origin cuts window.opener once the window has been at core) and closes.
 */

export const SIGNON_CHANNEL = 'ebmr-platform-signon';

export interface SignonOutcome {
  purpose: 'LOGIN' | 'SIGNATURE';
  proof: string | null;
  error: string | null;
}

let pendingLogin: SignonOutcome | null = null;

/** Reads the fragment of /platform-signon once. True when this window only relays a signing proof (nothing to render). */
export function takeSignonFragment(): boolean {
  if (window.location.pathname !== '/platform-signon') return false;
  const f = new URLSearchParams(window.location.hash.slice(1));
  const outcome: SignonOutcome = {
    purpose: f.get('purpose') === 'SIGNATURE' ? 'SIGNATURE' : 'LOGIN',
    proof: f.get('proof'),
    error: f.get('error'),
  };
  window.history.replaceState(null, '', '/');
  if (outcome.purpose === 'SIGNATURE' && typeof BroadcastChannel !== 'undefined') {
    const ch = new BroadcastChannel(SIGNON_CHANNEL);
    ch.postMessage(outcome);
    ch.close();
    window.close();
    return true;
  }
  pendingLogin = outcome;
  return false;
}

/** The sign-on that just came back from core, once. */
export function takePendingLogin(): SignonOutcome | null {
  const p = pendingLogin;
  pendingLogin = null;
  return p;
}

/** Sends the whole page to core to sign in. */
export function startPlatformSignIn(): void {
  window.location.assign('/signin');
}

/**
 * Opens core's re-authentication for these challenges in a window of its own and resolves with its outcome (or an
 * error when the window was closed without an answer within `timeoutMs`).
 */
export function reauthenticateAtCore(challengeIds: readonly string[], timeoutMs: number): Promise<SignonOutcome> {
  return new Promise((resolve) => {
    const ch = new BroadcastChannel(SIGNON_CHANNEL);
    const done = (o: SignonOutcome) => {
      clearTimeout(timer);
      ch.close();
      resolve(o);
    };
    const timer = setTimeout(() => done({ purpose: 'SIGNATURE', proof: null, error: 'TIMEOUT' }), timeoutMs);
    ch.onmessage = (e: MessageEvent<SignonOutcome>) => {
      if (e.data.purpose === 'SIGNATURE') done(e.data);
    };
    const q = challengeIds.map((id) => `challenge=${encodeURIComponent(id)}`).join('&');
    const w = window.open(`/sign?${q}`, 'ebmr-platform-sign', 'popup,width=520,height=680');
    if (!w) done({ purpose: 'SIGNATURE', proof: null, error: 'POPUP_BLOCKED' });
  });
}
