/**
 * Seal keys (ADR 0012 decision 3; outline 4.7 keys and secrets).
 *
 * The signing function returns a canonical seal payload; the application seals it with a key held
 * outside the database (KMS or HSM in production) and attaches the seal in the same transaction.
 * The seal records its key ID and algorithm, so keys rotate and algorithms change without
 * invalidating older seals (the verifier keeps an archive of retired keys).
 *
 * The verifier trusts only the keys in its own key ring (configured from the KMS or a sealed key
 * archive), never keys read from the database: a database superuser who registered a key could
 * otherwise re-seal a forged row.
 *
 * hmacSealKey and ed25519SealKey hold key material in process memory: demo and test use only.
 */
import { createHmac, createPublicKey, generateKeyPairSync, sign as edSign, timingSafeEqual, verify as edVerify, type KeyObject } from 'node:crypto';
import { EsigError } from './errors.ts';

export type SealAlgorithm = 'HMAC-SHA256' | 'ED25519';

/** Produces seals with one key (a KMS/HSM client implements the same interface). */
export interface SealKeyProvider {
  readonly keyId: string;
  readonly algorithm: SealAlgorithm;
  seal(message: Uint8Array): Promise<Uint8Array>;
}

export type SealCheck = 'VALID' | 'INVALID' | 'UNKNOWN_KEY';

/** Verifies seals against the trusted keys, current and retired. */
export interface SealKeyRing {
  verify(keyId: string, algorithm: SealAlgorithm, message: Uint8Array, seal: Uint8Array): Promise<SealCheck>;
}

/** The exact bytes a seal covers: a domain-separation line, the key ID, the algorithm and the payload. */
export function sealMessage(keyId: string, algorithm: SealAlgorithm, payload: string): Buffer {
  return Buffer.from(`ebmr-esig-seal-v1\n${keyId}\n${algorithm}\n${payload}`, 'utf8');
}

function checkKeyId(keyId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(keyId)) throw new EsigError('EBMR-ESIG-063', `invalid seal key id ${keyId}`);
}

/** HMAC-SHA256 with a secret of at least 32 bytes (demo and test only). */
export function hmacSealKey(keyId: string, secret: Uint8Array): SealKeyProvider {
  checkKeyId(keyId);
  if (secret.length < 32) throw new EsigError('EBMR-ESIG-063', 'an HMAC seal key needs at least 32 bytes');
  const key = Buffer.from(secret);
  return {
    keyId,
    algorithm: 'HMAC-SHA256',
    seal: (message) => Promise.resolve(createHmac('sha256', key).update(message).digest()),
  };
}

export interface Ed25519SealKey extends SealKeyProvider {
  /** SPKI PEM of the public key, for the database key registry and the verifier's archive. */
  readonly publicKeyPem: string;
}

/** Ed25519 with an in-memory private key (demo and test only). */
export function ed25519SealKey(keyId: string, privateKey: KeyObject): Ed25519SealKey {
  checkKeyId(keyId);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new EsigError('EBMR-ESIG-063', 'not an Ed25519 private key');
  const publicKeyPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
  return {
    keyId,
    algorithm: 'ED25519',
    publicKeyPem,
    seal: (message) => Promise.resolve(edSign(null, message, privateKey)),
  };
}

/** A fresh Ed25519 key pair (demo and test only). */
export function generateEd25519SealKey(keyId: string): Ed25519SealKey {
  const { privateKey } = generateKeyPairSync('ed25519');
  return ed25519SealKey(keyId, privateKey);
}

export interface TrustedSealKey {
  keyId: string;
  algorithm: SealAlgorithm;
  /** HMAC-SHA256: the shared secret. */
  secret?: Uint8Array;
  /** ED25519: the SPKI PEM public key. */
  publicKeyPem?: string;
}

export function createSealKeyRing(keys: readonly TrustedSealKey[]): SealKeyRing {
  const ring = new Map<string, TrustedSealKey>();
  for (const k of keys) {
    checkKeyId(k.keyId);
    if (k.algorithm === 'HMAC-SHA256' && (!k.secret || k.secret.length < 32)) throw new EsigError('EBMR-ESIG-063', `${k.keyId}: HMAC key without a secret`);
    if (k.algorithm === 'ED25519' && !k.publicKeyPem) throw new EsigError('EBMR-ESIG-063', `${k.keyId}: Ed25519 key without a public key`);
    ring.set(k.keyId, k);
  }
  return {
    verify(keyId, algorithm, message, seal) {
      const k = ring.get(keyId);
      if (!k || k.algorithm !== algorithm) return Promise.resolve('UNKNOWN_KEY');
      if (algorithm === 'HMAC-SHA256') {
        // Stryker disable next-line ArrayDeclaration: equivalent; the fallback key is only reached if the caller deletes the secret after the ring checked it, and ["Stryker was here"] becomes the single byte 00, which HMAC pads to the same all-zero block as an empty key, so every seal gets the same answer
        const expected = createHmac('sha256', Buffer.from(k.secret ?? [])).update(message).digest();
        const given = Buffer.from(seal);
        return Promise.resolve(given.length === expected.length && timingSafeEqual(given, expected) ? 'VALID' : 'INVALID');
      }
      // Stryker disable next-line StringLiteral: equivalent; the fallback is only reached if the caller deletes the public key after the ring checked it, and createPublicKey throws the same ERR_OSSL_UNSUPPORTED error for '' as for any other non-key text
      const ok = edVerify(null, message, createPublicKey(k.publicKeyPem ?? ''), seal);
      return Promise.resolve(ok ? 'VALID' : 'INVALID');
    },
  };
}
