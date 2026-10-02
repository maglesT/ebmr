/**
 * The browser's API client (plan section 4): same-origin fetch, the session's CSRF token (kept in memory only),
 * an Idempotency-Key per mutating command, responses parsed with the contract's schemas, and a hard stop when a
 * response comes from the other installation (X-Ebmr-Installation).
 */
import { createApiClient, routes, type ApiClient, type DeviceProof, type FetchLike, type InstallationKind } from '@ebmr/api-contract';
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

/**
 * A device proof for an authentication call: a fresh nonce from the server, signed with the terminal key. The nonce
 * request names the terminal's public key (the nonce is bound to it) and the nonce of this terminal's last proof, which
 * the server takes as a proof ticket when that proof succeeded: the request then counts toward this terminal's own
 * rate limit, not the allowance its address shares with requests that show none.
 */
export async function deviceProof(key: StoredDeviceKey, method: string, path: string, body: Record<string, unknown>): Promise<DeviceProof> {
  const lastNonce = lastNonces.get(key.publicKeySpki);
  const nonce = await api.call(routes.session.deviceNonce, { body: { spki: key.publicKeySpki, ...(lastNonce !== undefined ? { lastNonce } : {}) } });
  if (!nonce.ok) throw new Error('The server did not issue a device nonce.');
  lastNonces.set(key.publicKeySpki, nonce.value.nonce);
  return signProof(key, nonce.value.nonce, method, path, body);
}
