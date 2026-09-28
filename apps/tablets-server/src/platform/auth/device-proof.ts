/**
 * Device identity (DI-20; plan section 5). Each browser origin holds a non-extractable ECDSA P-256 key; the
 * fingerprint is kernel identity.deviceFingerprint(SPKI DER). Authentication calls carry
 * proof = {spki, nonce, sig}, where sig is over `nonce|METHOD|path|sha256hex(canonical JSON of the body without
 * its proof)`. The server verifies the proof and resolves the device through the kernel registry; it never
 * trusts what the browser reports. DeviceIdentityProvider is an interface so mTLS can replace this later.
 */
import { createPublicKey, verify } from 'node:crypto';
import type pg from 'pg';
import { canonicalJson, sha256Hex } from '@ebmr/expr';
import { identity } from '@ebmr/kernel';
import type { DeviceProof } from '@ebmr/api-contract';
import { refusal } from '../http/refusal.ts';
import { consumeNonce } from './nonces.ts';

export interface IdentifiedDevice {
  fingerprint: string;
  device: identity.DeviceInfo;
}

export interface ProofSubject {
  method: string;
  /** URL path without the query string. */
  path: string;
  /** The request body without the member that carries the proof. */
  body: unknown;
}

export interface DeviceIdentityProvider {
  identify(proof: DeviceProof | undefined, subject: ProofSubject): Promise<IdentifiedDevice>;
}

/** The text a device signs (the browser builds the same with expr's canonicalJson and sha256Hex). */
export function proofMessage(nonce: string, subject: ProofSubject): string {
  return `${nonce}|${subject.method.toUpperCase()}|${subject.path}|${sha256Hex(canonicalJson(subject.body ?? {}))}`;
}

/** The body without one member (the proof, or the attribution that carries its own proof). */
export function without(body: unknown, member: string): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return body;
  const { [member]: _removed, ...rest } = body as Record<string, unknown>;
  void _removed;
  return rest;
}

const proofRefused = (why: string, reason: string) =>
  refusal(403, {
    code: 'DEVICE_PROOF',
    kind: 'NOT_ALLOWED',
    whatHappened: 'This terminal could not prove which registered device it is.',
    why,
    controls: ['DI-20'],
    whatYouCanDo: ['Reload the page and try again. If it happens again, the terminal needs to be enrolled.'],
    whoCanHelp: ['The system administrator (device enrolment)'],
    details: { reason },
  });

/**
 * Proof of possession of a WebCrypto P-256 key, resolved through the kernel device registry. Nonces live in
 * the application pool; iam.resolve_device is granted to the authentication service only.
 */
export function webCryptoDeviceProvider(pool: pg.Pool, authnPool: pg.Pool, nonceKey: string): DeviceIdentityProvider {
  return {
    async identify(proof, subject) {
      if (!proof) throw proofRefused('The request carried no device proof.', 'MISSING');
      if (!(await consumeNonce(pool, nonceKey, proof.nonce))) {
        throw proofRefused('The device proof used a nonce that is unknown, already used or older than 60 seconds.', 'NONCE');
      }
      let spki: Buffer;
      let ok: boolean;
      try {
        spki = Buffer.from(proof.spki, 'base64');
        const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
        if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
          throw proofRefused('The device key is not an ECDSA P-256 key.', 'KEY_TYPE');
        }
        ok = verify('sha256', Buffer.from(proofMessage(proof.nonce, subject), 'utf8'), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(proof.sig, 'base64'));
      } catch (error) {
        if (error instanceof Error && error.name === 'HttpRefusal') throw error;
        throw proofRefused('The device key or signature could not be read.', 'MALFORMED');
      }
      if (!ok) throw proofRefused('The device signature does not match this request.', 'SIGNATURE');
      const fingerprint = identity.deviceFingerprint(spki);
      try {
        return { fingerprint, device: await identity.resolveDevice(authnPool, fingerprint) };
      } catch (error) {
        throw proofRefused(error instanceof Error ? error.message : String(error), 'UNREGISTERED');
      }
    },
  };
}
