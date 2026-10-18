/**
 * The browser's API client (plan section 4): same-origin fetch, the session's CSRF token (kept in memory only),
 * an Idempotency-Key per mutating command, responses parsed with the contract's schemas, and a hard stop when a
 * response comes from the other installation (X-Ebmr-Installation).
 */
import { createApiClient, describeCallError, routes, unstorableTextIssues, type ApiClient, type CallError, type DeviceProof, type FetchLike, type InstallationKind } from '@ebmr/api-contract';
import { signProof } from '../device/proof.ts';
import type { StoredDeviceKey } from '../device/keystore.ts';
import { pagePerson } from './page-binding.ts';

/** A session the server served as nobody because it is not this page's (review F41, round 4; page-binding.ts). */
export type ForeignSessionCode = 'SESSION_CHANGED' | 'SESSION_OTHER_TERMINAL';

export interface ApiState {
  installation: InstallationKind | undefined;
  csrfToken: string | undefined;
  mismatch: { expected: InstallationKind; actual: string | null } | null;
  onMismatch: Set<() => void>;
  /** This terminal's key (the SHA-256 hex of its device key's SPKI), named on every request once known (F41). */
  terminalKey: string | undefined;
  /** Told when a request of the session this page works in was served as nobody: the browser's sign-in is not its own. */
  onForeignSession: Set<(code: ForeignSessionCode) => void>;
  /** Told after a request other than GET succeeded: the server counts it as the session's activity (A11Y-1). */
  onWrite: Set<() => void>;
}

export const apiState: ApiState = { installation: undefined, csrfToken: undefined, mismatch: null, onMismatch: new Set(), terminalKey: undefined, onForeignSession: new Set(), onWrite: new Set() };

/** The refusal code of an answer, when it is a refusal of status 401. */
const refusalCode401 = (status: number, text: string): string | null => {
  if (status !== 401) return null;
  try {
    const code = (JSON.parse(text) as { refusal?: { code?: unknown } }).refusal?.code;
    return typeof code === 'string' ? code : null;
  } catch {
    return null;
  }
};

/** Whether a call error is the server's refusal of a session that is not this page's (F41, round 4). */
export const isForeignSession = (e: CallError): boolean =>
  e.kind === 'REFUSAL' && e.status === 401 && (e.envelope.refusal.code === 'SESSION_CHANGED' || e.envelope.refusal.code === 'SESSION_OTHER_TERMINAL');

/**
 * window.fetch as the contract client's FetchLike. Every request names this terminal's key and the person this page's
 * session started with, when known (page-binding.ts): the server serves a session that is not the page's as nobody, and
 * the page is told (apiState.onForeignSession), unless the page has meanwhile started another session itself (a switch
 * of person whose answer came first). A request refused as COOKIE_DUPLICATED (another page of this computer set a copy
 * of this installation's cookie; the server ran nothing and removed the copy) is sent once more.
 */
export const browserFetch: FetchLike = async (url, init) => {
  const person = pagePerson();
  const headers = {
    ...init.headers,
    ...(apiState.terminalKey !== undefined ? { 'x-ebmr-terminal-key': apiState.terminalKey } : {}),
    ...(person !== undefined ? { 'x-ebmr-page-person': person } : {}),
  };
  const send = () =>
    fetch(url, {
      method: init.method,
      headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
      credentials: 'same-origin',
      cache: 'no-store',
    });
  let res = await send();
  let text = await res.text();
  if (refusalCode401(res.status, text) === 'COOKIE_DUPLICATED') {
    res = await send();
    text = await res.text();
  }
  const answer = res;
  const code = refusalCode401(answer.status, text);
  if ((code === 'SESSION_CHANGED' && pagePerson() === person) || code === 'SESSION_OTHER_TERMINAL') {
    for (const tell of apiState.onForeignSession) tell(code);
  }
  return { status: answer.status, headers: { get: (n: string) => answer.headers.get(n) }, text: () => Promise.resolve(text) };
};

let fetchImpl: FetchLike = browserFetch;

/** Replaces the transport (fixture mode for C4, tests). */
export function setTransport(f: FetchLike): void {
  fetchImpl = f;
}

export const api: ApiClient = createApiClient({
  fetch: async (url, init) => {
    const r = await fetchImpl(url, init);
    if (init.method !== 'GET' && r.status >= 200 && r.status < 300) for (const f of apiState.onWrite) f();
    return r;
  },
  installation: () => apiState.installation,
  csrfToken: () => apiState.csrfToken,
  onInstallationMismatch: (expected, actual) => {
    apiState.mismatch = { expected, actual };
    for (const f of apiState.onMismatch) f();
  },
});

/** The nonce of each terminal key's latest device proof in this page (the proof ticket of its next nonce request). */
const lastNonces = new Map<string, string>();

/** A device proof, or why none could be had (then nothing was sent). */
export type ProofResult = { ok: true; proof: DeviceProof } | { ok: false; error: CallError };

/**
 * The refusal a screen shows when no device proof could be had (review F08): the request it was for was never sent.
 * The cause (the server could not be reached, refused or rate-limited the nonce request) is named; its kind is
 * NOT_SAVED whatever the cause, so no caller takes it for a wrong secret, a lost answer or a switch of person.
 */
export function notProven(cause: CallError | { local: string }): CallError {
  const call = 'local' in cause ? null : cause;
  const r = call?.kind === 'REFUSAL' ? call.envelope.refusal : null;
  const why = 'local' in cause ? cause.local : `The server did not issue a device nonce. ${describeCallError(cause)}${r?.why ? ` ${r.why}` : ''}`;
  return {
    kind: 'REFUSAL',
    status: call?.kind === 'REFUSAL' ? call.status : 0,
    envelope: {
      refusal: {
        code: 'NO_DEVICE_PROOF',
        kind: 'NOT_SAVED',
        whatHappened: 'Nothing was sent: this terminal could not prove itself to the server.',
        why,
        controls: ['DI-20'],
        whatYouCanDo: r?.whatYouCanDo.length ? r.whatYouCanDo : ['Try again in a moment.'],
        whoCanHelp: r?.whoCanHelp.length ? r.whoCanHelp : ['The system administrator, if it keeps happening'],
      },
      correlationId: call?.kind === 'REFUSAL' ? call.envelope.correlationId : 'client',
      retryable: true,
    },
  };
}

/**
 * The refusal of a request whose body holds text no record can hold (U+0000, a UTF-16 surrogate without its other half;
 * review F30, F31), or null: nothing is sent and no nonce is asked for. Canonical JSON has no form for such text, so the
 * proof could not hash it; the server would refuse it as this does (400 INVALID_INPUT naming the field).
 */
export function unstorableBody(body: Record<string, unknown>): CallError | null {
  const issues = unstorableTextIssues(body);
  if (issues.length === 0) return null;
  return {
    kind: 'REFUSAL',
    status: 0,
    envelope: {
      refusal: {
        code: 'SCHEMA',
        kind: 'INVALID_INPUT',
        whatHappened: 'Nothing was sent: the text entered holds a character no record can hold.',
        why: issues.map((i) => `/${i.path.join('/')} ${i.message}`).join('; '),
        controls: ['DI-37'],
        whatYouCanDo: ['Enter the text again without it.'],
        whoCanHelp: [],
      },
      correlationId: 'client',
      retryable: false,
    },
  };
}

/**
 * A device proof for an authentication call: a fresh nonce from the server, signed with the terminal key. The nonce
 * request names the terminal's public key (the nonce is bound to it) and the nonce of this terminal's last proof, which
 * the server takes as a proof ticket when that proof succeeded: the request then counts toward this terminal's own
 * rate limit, not the allowance its address shares with requests that show none. When no nonce is issued the answer
 * is a refusal (notProven) that the caller shows like any other: it is never thrown (review F08: a thrown failure left
 * the sign-in and the first-login change without a word, the secrets already cleared). A body holding text no record can
 * hold is refused first (unstorableBody), before any nonce is asked for.
 */
export async function deviceProof(key: StoredDeviceKey, method: string, path: string, body: Record<string, unknown>): Promise<ProofResult> {
  const unstorable = unstorableBody(body);
  if (unstorable) return { ok: false, error: unstorable };
  const lastNonce = lastNonces.get(key.publicKeySpki);
  const nonce = await api.call(routes.session.deviceNonce, { body: { spki: key.publicKeySpki, ...(lastNonce !== undefined ? { lastNonce } : {}) } });
  if (!nonce.ok) return { ok: false, error: notProven(nonce.error) };
  lastNonces.set(key.publicKeySpki, nonce.value.nonce);
  try {
    return { ok: true, proof: await signProof(key, nonce.value.nonce, method, path, body) };
  } catch (e) {
    return { ok: false, error: notProven({ local: `The terminal key could not sign the proof (${e instanceof Error ? e.message : String(e)}).` }) };
  }
}
