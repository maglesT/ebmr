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

/** window.fetch as the contract client's FetchLike. */
export const browserFetch: FetchLike = async (url, init) => {
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
    ...(init.signal ? { signal: init.signal } : {}),
    credentials: 'same-origin',
    cache: 'no-store',
  });
  return { status: res.status, headers: { get: (n: string) => res.headers.get(n) }, text: () => res.text() };
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

/** A device proof for an authentication call: a fresh nonce from the server, signed with the terminal key. */
export async function deviceProof(key: StoredDeviceKey, method: string, path: string, body: Record<string, unknown>): Promise<DeviceProof> {
  const nonce = await api.call(routes.session.deviceNonce, { body: {} });
  if (!nonce.ok) throw new Error('The server did not issue a device nonce.');
  return signProof(key, nonce.value.nonce, method, path, body);
}
