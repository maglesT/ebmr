/**
 * The calls of kiosk access and signing (module C1): attributions over the exact request (the spine's deviceProof,
 * so the proof matches the server's app.devices.identify), and the kiosk session calls. Secrets arrive as arguments,
 * go into one request body and are not kept anywhere.
 */
import { routes, type Attribution, type CallError, type SessionView } from '@ebmr/api-contract';
import type { machines } from '@ebmr/ui-kit';
import { api, deviceProof } from '../../api/client.ts';
import type { TapRequest } from '../../app/ports.tsx';
import type { StoredDeviceKey } from '../../device/keystore.ts';

/** The failure a machine actor throws for a call error (a lost answer is LOST: never re-send credentials). */
export function failureOf(error: CallError): machines.CeremonyFailure {
  switch (error.kind) {
    case 'REFUSAL':
      return { kind: 'REFUSAL', status: error.status, envelope: error.envelope };
    case 'NETWORK':
      return { kind: 'LOST', message: error.message };
    case 'PROTOCOL':
      return error.status >= 500 || error.status === 0 ? { kind: 'LOST', message: error.message } : { kind: 'ERROR', message: error.message };
    case 'INSTALLATION_MISMATCH':
      return { kind: 'ERROR', message: `the answer came from ${error.actual ?? 'an unknown installation'}` };
  }
}

/** A badge-tap attribution of the request, with a fresh single-use device proof over method, path and body. */
export async function buildAttribution(key: StoredDeviceKey, badgeUid: string, pin: string | undefined, request: TapRequest): Promise<Attribution> {
  const proof = await deviceProof(key, request.method, request.path, request.body);
  return { method: 'BADGE_TAP', badgeUid, ...(pin ? { pin } : {}), proof };
}

export type CallOutcome<T> = { ok: true; value: T } | { ok: false; failure: machines.CeremonyFailure };

const wrap = <T,>(r: { ok: true; value: T } | { ok: false; error: CallError }): CallOutcome<T> => (r.ok ? { ok: true, value: r.value } : { ok: false, failure: failureOf(r.error) });

export async function lockCall(): Promise<CallOutcome<SessionView>> {
  return wrap(await api.call(routes.access.lock, { body: {} }));
}

export async function unlockWithBadge(key: StoredDeviceKey, badgeUid: string, pin: string): Promise<CallOutcome<SessionView>> {
  const body = { method: 'BADGE_PIN' as const, identifier: badgeUid, secret: pin };
  const proof = await deviceProof(key, 'POST', '/api/session/unlock', body);
  return wrap(await api.call(routes.access.unlock, { body: { ...body, proof } }));
}

export async function unlockWithPassword(key: StoredDeviceKey, loginName: string, password: string): Promise<CallOutcome<SessionView>> {
  const body = { method: 'PASSWORD' as const, identifier: loginName, secret: password };
  const proof = await deviceProof(key, 'POST', '/api/session/unlock', body);
  return wrap(await api.call(routes.access.unlock, { body: { ...body, proof } }));
}

export async function switchCall(key: StoredDeviceKey, badgeUid: string, pin: string): Promise<CallOutcome<SessionView>> {
  const body = { badgeUid, pin };
  const proof = await deviceProof(key, 'POST', '/api/session/switch', body);
  return wrap(await api.call(routes.access.switchUser, { body: { ...body, proof } }));
}

export async function sessionCall(): Promise<CallOutcome<SessionView>> {
  return wrap(await api.call(routes.session.get));
}
