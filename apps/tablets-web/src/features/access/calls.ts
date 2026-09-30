/**
 * The calls of kiosk access and signing (module C1): attributions over the exact request (the spine's deviceProof,
 * so the proof matches the server's app.devices.identify), and the kiosk session calls. Secrets arrive as arguments,
 * go into one request body and are not kept anywhere.
 */
import { routes, type Attribution, type CallError, type SessionView, type SignableAction } from '@ebmr/api-contract';
import type { machines } from '@ebmr/ui-kit';
import { api, deviceProof } from '../../api/client.ts';
import type { SignRequest, TapRequest } from '../../app/ports.tsx';
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

/** UTF-8 bytes of `text` as unpadded base64url (what node's Buffer.from(x, 'base64url') reads back byte for byte). */
export function base64UrlOfUtf8(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The `intent` of the content preview (GET /api/esig/content) for a signing. It is the meaning code, except for a
 * decision, which is part of the signed content (C3), so the preview names it after the meaning, taken only from the
 * action that the challenge and the sign request also carry (never from dialog state), so the signer previews and
 * hashes exactly the decision the challenge binds:
 *  - an exception disposition: `<meaning>|<base64url of the UTF-8 JSON {outcome, justification}>` (the server reads
 *    those two members; the linked deviation comes from the record itself);
 *  - a hold-point decision: `<meaning>|<base64url of the UTF-8 JSON {disposition, comment}>`, the comment null when
 *    there is none (recipe-core 0295; review findings P26, P38).
 */
export function previewIntent(meaning: string, action: SignableAction): string {
  if (action.kind === 'ENGINE_COMMAND' && action.intent.type === 'DISPOSITION_EXCEPTION') {
    const { outcome, justification } = action.intent;
    return `${meaning}|${base64UrlOfUtf8(JSON.stringify({ outcome, justification }))}`;
  }
  if (action.kind === 'ENGINE_COMMAND' && action.intent.type === 'DISPOSITION_HOLD_POINT') {
    const { disposition, comment } = action.intent;
    return `${meaning}|${base64UrlOfUtf8(JSON.stringify({ disposition, comment: comment ?? null }))}`;
  }
  return meaning;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/**
 * A frozen copy of a signing request, taken once when the ceremony starts: the preview intent, the challenge and
 * the sign request all read this one copy, so a caller changing its own object meanwhile cannot make the signed
 * command differ from what was previewed (the server refuses that too: EBMR-ESIG-013 or EBMR-EXE-086).
 */
export function frozenRequest(request: SignRequest): SignRequest {
  return deepFreeze(structuredClone(request));
}
