/**
 * The browser's API client (plan section 4): same-origin fetch, the session's CSRF token (kept in memory only),
 * an Idempotency-Key per mutating command, responses parsed with the contract's schemas, and a hard stop when a
 * response comes from the other installation (X-Ebmr-Installation).
 */
import { createApiClient, describeCallError, routes, type ApiClient, type CallError, type DeviceProof, type FetchLike, type InstallationKind } from '@ebmr/api-contract';
import { signProof } from '../device/proof.ts';
import type { StoredDeviceKey } from '../device/keystore.ts';

export interface ApiState {
  installation: InstallationKind | undefined;
  csrfToken: string | undefined;
  mismatch: { expected: InstallationKind; actual: string | null } | null;
  onMismatch: Set<() => void>;
}

export const apiState: ApiState = { installation: undefined, csrfToken: undefined, mismatch: null, onMismatch: new Set() };

/** The refusal of a request that carried this installation's cookie twice (review F41). */
const isCookieDuplicated = (status: number, text: string): boolean => {
  if (status !== 401) return false;
  try {
    return (JSON.parse(text) as { refusal?: { code?: unknown } }).refusal?.code === 'COOKIE_DUPLICATED';
  } catch {
    return false;
  }
};

/**
 * window.fetch as the contract client's FetchLike. A request refused as COOKIE_DUPLICATED (another page of this
 * computer set a copy of this installation's cookie; the server ran nothing and removed the copy) is sent once more.
 */
export const browserFetch: FetchLike = async (url, init) => {
  const send = () =>
    fetch(url, {
      method: init.method,
      headers: init.headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
      credentials: 'same-origin',
      cache: 'no-store',
    });
  let res = await send();
  let text = await res.text();
  if (isCookieDuplicated(res.status, text)) {
    res = await send();
    text = await res.text();
  }
  const answer = res;
  return { status: answer.status, headers: { get: (n: string) => answer.headers.get(n) }, text: () => Promise.resolve(text) };
};

let fetchImpl: FetchLike = browserFetch;

/** Replaces the transport (fixture mode for C4, tests). */
export function setTransport(f: FetchLike): void {
  fetchImpl = f;
}

export const api: ApiClient = createApiClient({
  fetch: (url, init) => fetchImpl(url, init),
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
 * A device proof for an authentication call: a fresh nonce from the server, signed with the terminal key. The nonce
 * request names the terminal's public key (the nonce is bound to it) and the nonce of this terminal's last proof, which
 * the server takes as a proof ticket when that proof succeeded: the request then counts toward this terminal's own
 * rate limit, not the allowance its address shares with requests that show none. When no nonce is issued the answer
 * is a refusal (notProven) that the caller shows like any other: it is never thrown (review F08: a thrown failure left
 * the sign-in and the first-login change without a word, the secrets already cleared).
 */
export async function deviceProof(key: StoredDeviceKey, method: string, path: string, body: Record<string, unknown>): Promise<ProofResult> {
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
