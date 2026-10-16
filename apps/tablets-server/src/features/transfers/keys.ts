/**
 * The installation key (Phase 6 slice 6i; D-P6i-0-8): this server holds the private Ed25519 key of its installation and
 * seals what the database built (a lot-transfer package, a federation request or answer); the database holds the public
 * keys and verifies every seal itself (kernel 1220). DEMO-ONLY as a file: {installationCode, privateKeyPkcs8 (base64
 * DER)}; production keeps the key in a KMS or HSM behind the same two functions.
 *
 * What is signed is the kernel's platform.seal_message: `ebmr.<purpose>.v1|<SHA-256 hex of the payload's UTF-8>`, so a
 * seal of one purpose never verifies as another.
 */
import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

export type SealPurpose = 'transfer-package' | 'federation-request' | 'federation-answer';

const KeyFile = z.strictObject({ installationCode: z.string().regex(/^[A-Z0-9][A-Z0-9-]{1,31}$/), privateKeyPkcs8: z.string().min(1), label: z.string().optional() });

export interface InstallationKey {
  installationCode: string;
  /** The raw 32-byte public key, standard base64 (what platform.installation_identity holds). */
  publicKey: string;
  seal(purpose: SealPurpose, payload: string): string;
}

export function sealMessage(purpose: SealPurpose, payload: string): Buffer {
  return Buffer.from(`ebmr.${purpose}.v1|${createHash('sha256').update(payload, 'utf8').digest('hex')}`, 'utf8');
}

export function rawPublicKeyOf(key: KeyObject): string {
  const x = createPublicKey(key).export({ format: 'jwk' }).x;
  if (!x) throw new Error('the installation key is not an Ed25519 key');
  return Buffer.from(x, 'base64url').toString('base64');
}

export function installationKeyOf(privateKey: KeyObject, installationCode: string): InstallationKey {
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('the installation key is not an Ed25519 key');
  return {
    installationCode,
    publicKey: rawPublicKeyOf(privateKey),
    seal: (purpose, payload) => sign(null, sealMessage(purpose, payload), privateKey).toString('base64'),
  };
}

/** Reads the DEMO-ONLY key file; null when none is configured. */
export function loadInstallationKey(file: string | null): InstallationKey | null {
  if (!file) return null;
  const k = KeyFile.parse(JSON.parse(readFileSync(file, 'utf8')));
  const privateKey = createPrivateKey({ key: Buffer.from(k.privateKeyPkcs8, 'base64'), format: 'der', type: 'pkcs8' });
  return installationKeyOf(privateKey, k.installationCode);
}
