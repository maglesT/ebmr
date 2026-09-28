/**
 * Device proofs (plan section 5): ECDSA P-256 with SHA-256 over `nonce|METHOD|path|sha256hex(canonical JSON of
 * the body without its proof)`. WebCrypto signs in IEEE P1363 form, which the server verifies as is.
 */
import { canonicalJson, sha256Hex } from '@ebmr/expr';
import type { DeviceProof } from '@ebmr/api-contract';
import { bytesToBase64 } from './base64.ts';
import type { StoredDeviceKey } from './keystore.ts';

export function proofMessage(nonce: string, method: string, path: string, body: unknown): string {
  return `${nonce}|${method.toUpperCase()}|${path}|${sha256Hex(canonicalJson(body ?? {}))}`;
}

export async function signProof(key: StoredDeviceKey, nonce: string, method: string, path: string, body: unknown): Promise<DeviceProof> {
  const data = new TextEncoder().encode(proofMessage(nonce, method, path, body));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, data);
  return { spki: key.publicKeySpki, nonce, sig: bytesToBase64(sig) };
}
