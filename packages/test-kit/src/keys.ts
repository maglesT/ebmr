/**
 * Key material for demo and test terminals (DEMO-ONLY; never production keys).
 *
 * Browser terminals hold an ECDSA P-256 key (WebCrypto; plan section 5): the fingerprint the kernel registers
 * is SHA-256 of the SPKI DER (kernel identity.deviceFingerprint), so a key imported into the browser from these
 * files proves the same device. Service identities (gateway, sweeper) hold Ed25519 keys.
 */
import { createHash, createPrivateKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

export interface DeviceKey {
  /** PKCS#8 DER, base64. */
  privateKeyPkcs8: string;
  /** SPKI DER, base64. */
  publicKeySpki: string;
  /** SHA-256 of the SPKI DER, lower-case hex (the kernel device fingerprint). */
  fingerprint: string;
  algorithm: 'ECDSA_P256' | 'ED25519';
}

export function fingerprintOfSpki(spkiBase64: string): string {
  return createHash('sha256').update(Buffer.from(spkiBase64, 'base64')).digest('hex');
}

function exportPair(pair: { privateKey: KeyObject; publicKey: KeyObject }, algorithm: DeviceKey['algorithm']): DeviceKey {
  const privateKeyPkcs8 = pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
  const publicKeySpki = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return { privateKeyPkcs8, publicKeySpki, fingerprint: fingerprintOfSpki(publicKeySpki), algorithm };
}

/** A browser terminal key (ECDSA P-256), as WebCrypto can import it. */
export function generateDeviceKey(): DeviceKey {
  return exportPair(generateKeyPairSync('ec', { namedCurve: 'P-256' }), 'ECDSA_P256');
}

/** A service key (Ed25519): the gateway's reading signatures, the sweeper's server identity. */
export function generateServiceKey(): DeviceKey {
  return exportPair(generateKeyPairSync('ed25519'), 'ED25519');
}

/**
 * Signs a device proof exactly as the browser does: ECDSA P-256 with SHA-256, IEEE P1363 (r||s) encoding,
 * over the UTF-8 text `nonce|METHOD|path|bodyHash`. Returns base64.
 */
export function signDeviceProof(key: DeviceKey, message: string): string {
  const privateKey = createPrivateKey({ key: Buffer.from(key.privateKeyPkcs8, 'base64'), format: 'der', type: 'pkcs8' });
  return sign('sha256', Buffer.from(message, 'utf8'), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
}
