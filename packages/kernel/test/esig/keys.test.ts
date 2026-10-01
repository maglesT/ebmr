/**
 * Seal keys and the verifier's key ring (esig/keys.ts; ADR 0012 decision 3). A seal covers a fixed
 * message (domain line, key ID, algorithm, payload); the providers refuse malformed key IDs and weak
 * or wrong-type keys; the key ring trusts only the keys it was built with and answers VALID,
 * INVALID or UNKNOWN_KEY for every seal it is shown, never an exception for a malformed seal.
 * integrity.test.ts shows the ring at work on sealed signature rows; these tests pin each rule.
 * No database.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EsigError } from '../../src/esig/errors.ts';
import { createSealKeyRing, ed25519SealKey, generateEd25519SealKey, hmacSealKey, sealMessage, type TrustedSealKey } from '../../src/esig/keys.ts';

const SECRET = randomBytes(32);
const message = sealMessage('site1-hmac-1', 'HMAC-SHA256', '{"signature_id":"s-1"}');

/** A copy of `bytes` with one bit of the byte at `index` flipped (negative counts from the end). */
function flipped(bytes: Uint8Array, index: number): Buffer {
  const copy = Buffer.from(bytes);
  const at = index < 0 ? copy.length + index : index;
  copy.writeUInt8(copy.readUInt8(at) ^ 0x01, at);
  return copy;
}

/** The refusal a provider or the ring throws: an EsigError with code EBMR-ESIG-063 and this message. */
function refusal(run: () => unknown): string {
  try {
    run();
  } catch (e) {
    expect(e).toBeInstanceOf(EsigError);
    expect((e as EsigError).code).toBe('EBMR-ESIG-063');
    return (e as EsigError).message;
  }
  throw new Error('expected a refusal');
}

describe('seal message', () => {
  it('[DI-37] a seal covers the domain line, the key ID, the algorithm and the payload, one per line, in UTF-8', () => {
    const m = sealMessage('site1-ed25519-2026', 'ED25519', '{"meaning":"VERIFIED","by":"Ánima"}');
    expect(m.toString('utf8')).toBe('ebmr-esig-seal-v1\nsite1-ed25519-2026\nED25519\n{"meaning":"VERIFIED","by":"Ánima"}');
    expect(m.subarray(-8).toString('hex')).toBe(Buffer.from('"Ánima"}', 'utf8').subarray(-8).toString('hex'));
    expect(m.length).toBe(Buffer.byteLength('ebmr-esig-seal-v1\nsite1-ed25519-2026\nED25519\n{"meaning":"VERIFIED","by":"Ánima"}', 'utf8'));
  });
});

describe('seal key IDs', () => {
  const ids = {
    accepted: ['abc', 'A1.b_2:c-3', '9zz', `k${'x'.repeat(127)}`],
    refused: ['', 'ab', '-abc', '.abc', '_abc', ':abc', 'abc def', 'abc/1', 'abc\n', 'clé-1', `k${'x'.repeat(128)}`],
  };

  it('[INV-10] an HMAC provider takes only a well-formed key ID: 3 to 128 characters, letters, digits and . _ : -, starting with a letter or digit', () => {
    for (const id of ids.accepted) expect(hmacSealKey(id, SECRET).keyId).toBe(id);
    for (const id of ids.refused) expect(refusal(() => hmacSealKey(id, SECRET))).toBe(`EBMR-ESIG-063 invalid seal key id ${id}`);
  });

  it('[INV-10] an Ed25519 provider and the key ring refuse a malformed key ID the same way', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    for (const id of ids.accepted) expect(ed25519SealKey(id, privateKey).keyId).toBe(id);
    for (const id of ids.refused) {
      expect(refusal(() => ed25519SealKey(id, privateKey))).toBe(`EBMR-ESIG-063 invalid seal key id ${id}`);
      expect(refusal(() => generateEd25519SealKey(id))).toBe(`EBMR-ESIG-063 invalid seal key id ${id}`);
      expect(refusal(() => createSealKeyRing([{ keyId: id, algorithm: 'HMAC-SHA256', secret: SECRET }]))).toBe(`EBMR-ESIG-063 invalid seal key id ${id}`);
    }
  });
});

describe('seal key providers (demo and test only)', () => {
  it('[INV-10] an HMAC seal key needs a secret of at least 32 bytes', () => {
    expect(refusal(() => hmacSealKey('site1-hmac-1', randomBytes(31)))).toBe('EBMR-ESIG-063 an HMAC seal key needs at least 32 bytes');
    expect(refusal(() => hmacSealKey('site1-hmac-1', new Uint8Array(0)))).toBe('EBMR-ESIG-063 an HMAC seal key needs at least 32 bytes');
    const key = hmacSealKey('site1-hmac-1', randomBytes(32));
    expect({ keyId: key.keyId, algorithm: key.algorithm }).toEqual({ keyId: 'site1-hmac-1', algorithm: 'HMAC-SHA256' });
  });

  it('[INV-10] an HMAC seal is deterministic for its key and message, and changes with either', async () => {
    const key = hmacSealKey('site1-hmac-1', SECRET);
    const seal = await key.seal(message);
    expect(seal).toHaveLength(32);
    expect(Buffer.from(await key.seal(message)).equals(seal)).toBe(true);
    expect(Buffer.from(await key.seal(sealMessage('site1-hmac-1', 'HMAC-SHA256', '{"signature_id":"s-2"}'))).equals(seal)).toBe(false);
    expect(Buffer.from(await hmacSealKey('site1-hmac-1', randomBytes(32)).seal(message)).equals(seal)).toBe(false);
  });

  it('[INV-10] the HMAC provider keeps its own copy of the secret: changing the caller\'s buffer afterwards changes no seal', async () => {
    const secret = randomBytes(32);
    const key = hmacSealKey('site1-hmac-1', secret);
    const before = Buffer.from(await key.seal(message));
    secret.fill(0);
    expect(Buffer.from(await key.seal(message)).equals(before)).toBe(true);
  });

  it('[INV-10] an Ed25519 provider takes only an Ed25519 private key and publishes its SPKI public key', () => {
    for (const other of [generateKeyPairSync('x25519').privateKey, generateKeyPairSync('ed448').privateKey, generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey]) {
      expect(refusal(() => ed25519SealKey('site1-ed25519-1', other))).toBe('EBMR-ESIG-063 not an Ed25519 private key');
    }
    const key = generateEd25519SealKey('site1-ed25519-1');
    expect({ keyId: key.keyId, algorithm: key.algorithm }).toEqual({ keyId: 'site1-ed25519-1', algorithm: 'ED25519' });
    expect(key.publicKeyPem).toMatch(/^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+-----END PUBLIC KEY-----\n$/);
  });
});

describe('seal key ring (the verifier trusts only its own keys)', () => {
  it('[INV-10] a trusted HMAC key needs a secret of at least 32 bytes; a trusted Ed25519 key needs a public key', () => {
    expect(refusal(() => createSealKeyRing([{ keyId: 'site1-hmac-1', algorithm: 'HMAC-SHA256' }]))).toBe('EBMR-ESIG-063 site1-hmac-1: HMAC key without a secret');
    expect(refusal(() => createSealKeyRing([{ keyId: 'site1-hmac-1', algorithm: 'HMAC-SHA256', secret: randomBytes(31) }]))).toBe(
      'EBMR-ESIG-063 site1-hmac-1: HMAC key without a secret',
    );
    expect(refusal(() => createSealKeyRing([{ keyId: 'site1-ed-1', algorithm: 'ED25519' }]))).toBe('EBMR-ESIG-063 site1-ed-1: Ed25519 key without a public key');
    expect(refusal(() => createSealKeyRing([{ keyId: 'site1-ed-1', algorithm: 'ED25519', publicKeyPem: '' }]))).toBe(
      'EBMR-ESIG-063 site1-ed-1: Ed25519 key without a public key',
    );
    // One bad key refuses the whole ring, wherever it stands.
    const ed = generateEd25519SealKey('site1-ed-1');
    expect(refusal(() => createSealKeyRing([{ keyId: 'site1-ed-1', algorithm: 'ED25519', publicKeyPem: ed.publicKeyPem }, { keyId: 'site1-hmac-1', algorithm: 'HMAC-SHA256' }]))).toBe(
      'EBMR-ESIG-063 site1-hmac-1: HMAC key without a secret',
    );
  });

  it('[INV-10] each algorithm asks only for its own material: an HMAC key needs no public key, an Ed25519 key no secret', async () => {
    const hmac = hmacSealKey('site1-hmac-1', SECRET);
    const ed = generateEd25519SealKey('site1-ed-1');
    const ring = createSealKeyRing([
      { keyId: 'site1-hmac-1', algorithm: 'HMAC-SHA256', secret: SECRET },
      { keyId: 'site1-ed-1', algorithm: 'ED25519', publicKeyPem: ed.publicKeyPem },
    ]);
    expect(await ring.verify('site1-hmac-1', 'HMAC-SHA256', message, await hmac.seal(message))).toBe('VALID');
    expect(await ring.verify('site1-ed-1', 'ED25519', message, await ed.seal(message))).toBe('VALID');
    await expect(createSealKeyRing([]).verify('site1-hmac-1', 'HMAC-SHA256', message, await hmac.seal(message))).resolves.toBe('UNKNOWN_KEY');
  });

  it('[INV-10] an HMAC seal is VALID only for the same key and the same message; a short, long or empty seal is INVALID, not an error', async () => {
    const key = hmacSealKey('site1-hmac-1', SECRET);
    const ring = createSealKeyRing([{ keyId: 'site1-hmac-1', algorithm: 'HMAC-SHA256', secret: SECRET }]);
    const seal = await key.seal(message);
    expect(await ring.verify('site1-hmac-1', 'HMAC-SHA256', message, seal)).toBe('VALID');
    expect(await ring.verify('site1-hmac-1', 'HMAC-SHA256', flipped(message, -2), seal)).toBe('INVALID');
    expect(await ring.verify('site1-hmac-1', 'HMAC-SHA256', message, flipped(seal, 0))).toBe('INVALID');
    expect(await ring.verify('site1-hmac-1', 'HMAC-SHA256', message, seal.subarray(0, 31))).toBe('INVALID');
    expect(await ring.verify('site1-hmac-1', 'HMAC-SHA256', message, Buffer.concat([seal, Buffer.from([0])]))).toBe('INVALID');
    expect(await ring.verify('site1-hmac-1', 'HMAC-SHA256', message, new Uint8Array(0))).toBe('INVALID');
    // The same key ID with another secret (a re-registered or forged key) does not verify.
    const forged = await hmacSealKey('site1-hmac-1', randomBytes(32)).seal(message);
    expect(await ring.verify('site1-hmac-1', 'HMAC-SHA256', message, forged)).toBe('INVALID');
  });

  it('[INV-10] an Ed25519 seal is VALID only under the trusted public key and the same message', async () => {
    const key = generateEd25519SealKey('site1-ed-1');
    const ring = createSealKeyRing([{ keyId: 'site1-ed-1', algorithm: 'ED25519', publicKeyPem: key.publicKeyPem }]);
    const seal = await key.seal(message);
    expect(seal).toHaveLength(64);
    expect(await ring.verify('site1-ed-1', 'ED25519', message, seal)).toBe('VALID');
    expect(await ring.verify('site1-ed-1', 'ED25519', flipped(message, 0), seal)).toBe('INVALID');
    expect(await ring.verify('site1-ed-1', 'ED25519', message, flipped(seal, -1))).toBe('INVALID');
    expect(await ring.verify('site1-ed-1', 'ED25519', message, seal.subarray(0, 63))).toBe('INVALID');
    expect(await ring.verify('site1-ed-1', 'ED25519', message, new Uint8Array(0))).toBe('INVALID');
    // A rogue key that took the trusted key's ID is not trusted.
    const rogue = generateEd25519SealKey('site1-ed-1');
    expect(await ring.verify('site1-ed-1', 'ED25519', message, await rogue.seal(message))).toBe('INVALID');
  });

  it('[INV-10] a key ID outside the ring, or a trusted key ID with another algorithm, is UNKNOWN_KEY', async () => {
    const hmac = hmacSealKey('site1-hmac-1', SECRET);
    const ed = generateEd25519SealKey('site1-ed-1');
    const trusted: TrustedSealKey[] = [
      { keyId: 'site1-hmac-1', algorithm: 'HMAC-SHA256', secret: SECRET },
      { keyId: 'site1-ed-1', algorithm: 'ED25519', publicKeyPem: ed.publicKeyPem },
    ];
    const ring = createSealKeyRing(trusted);
    expect(await ring.verify('site9-hmac-1', 'HMAC-SHA256', message, await hmac.seal(message))).toBe('UNKNOWN_KEY');
    expect(await ring.verify('site9-ed-1', 'ED25519', message, await ed.seal(message))).toBe('UNKNOWN_KEY');
    // An Ed25519 seal presented under the HMAC key's ID, and the other way round.
    expect(await ring.verify('site1-hmac-1', 'ED25519', message, await ed.seal(message))).toBe('UNKNOWN_KEY');
    expect(await ring.verify('site1-ed-1', 'HMAC-SHA256', message, await hmac.seal(message))).toBe('UNKNOWN_KEY');
  });
});
