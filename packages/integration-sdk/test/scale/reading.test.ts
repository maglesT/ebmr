import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CaptureResponse,
  LoginRequest,
  READING_FORMAT,
  ScaleReading,
  canonicalReadingText,
  ed25519PrivateKey,
  ed25519PublicKey,
  genesisHash,
  readingHash,
  readingProblem,
  sealReading,
  spkiFingerprint,
  type ReadingBody,
} from '../../src/scale/index.ts';

function keys() {
  const pair = generateKeyPairSync('ed25519');
  const pkcs8 = pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
  const spki = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return { privateKey: ed25519PrivateKey(pkcs8), publicKey: ed25519PublicKey(spki), spki };
}

const CHAIN = '7a3e1c52-0f5b-4c8e-9d11-2b6f3a4c5d6e';

function body(overrides: Partial<ReadingBody> = {}): ReadingBody {
  return {
    format: READING_FORMAT,
    readingId: 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e01',
    chainId: CHAIN,
    gatewayCode: 'TEST-GW-01',
    deviceCode: 'TEST-BAL-01',
    serial: 'SIM-0001',
    seq: '1',
    value: '1.250',
    unit: 'kg',
    stable: true,
    status: 'OK',
    raw: 'S S      1.250 kg',
    sourceTimeUs: '1790584618000000',
    trust: 'DEVICE_UNSYNCED',
    installation: 'SANDBOX',
    purpose: 'TARE',
    prevHash: genesisHash(CHAIN),
    ...overrides,
  };
}

describe('scale reading seal', () => {
  it('[DI-31] the canonical text is a fixed-order JSON array (golden vector)', () => {
    expect(canonicalReadingText(body())).toBe(
      `["ebmr.scale-reading.v1","c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e01","${CHAIN}","TEST-GW-01","TEST-BAL-01","SIM-0001","1","1.250","kg",true,"OK","S S      1.250 kg","1790584618000000","DEVICE_UNSYNCED","SANDBOX","TARE","${genesisHash(CHAIN)}"]`,
    );
    expect(readingHash(body())).toMatch(/^[0-9a-f]{64}$/);
    expect(genesisHash(CHAIN)).not.toBe(genesisHash('00000000-0000-4000-8000-000000000000'));
  });

  it('[DI-31] a sealed reading verifies; any altered field, hash or signature is refused', () => {
    const k = keys();
    const sealed = sealReading(body(), k.privateKey);
    expect(readingProblem(sealed, k.publicKey)).toBeNull();
    expect(ScaleReading.parse(sealed)).toEqual(sealed);

    const tampered = { ...sealed, value: '1.260' };
    expect(readingProblem(tampered, k.publicKey)?.problem).toBe('HASH');
    const rehashed = { ...tampered, hash: readingHash({ ...body(), value: '1.260' }) };
    expect(readingProblem(rehashed, k.publicKey)?.problem).toBe('SIGNATURE');
    const otherKey = keys();
    expect(readingProblem(sealed, otherKey.publicKey)?.problem).toBe('SIGNATURE');
    const unsigned = { ...sealed, signature: undefined };
    expect(readingProblem(unsigned, k.publicKey)?.problem).toBe('SCHEMA');
  });

  it('[DI-32] a reading value is decimal text; a JSON number or an extra member is refused by the schema', () => {
    const k = keys();
    const sealed = sealReading(body(), k.privateKey);
    expect(ScaleReading.safeParse({ ...sealed, value: 1.25 }).success).toBe(false);
    expect(ScaleReading.safeParse({ ...sealed, value: '1.25e0' }).success).toBe(false);
    expect(ScaleReading.safeParse({ ...sealed, deviceTrusted: true }).success).toBe(false);
    expect(ScaleReading.safeParse({ ...sealed, raw: 'S S 1.250 kg\u0007' }).success).toBe(false);
  });

  it('the SPKI fingerprint is SHA-256 of the DER (the kernel device fingerprint)', () => {
    const k = keys();
    expect(spkiFingerprint(k.spki)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('wire schemas are strict', () => {
    expect(CaptureResponse.safeParse({ outcome: 'CAPTURED', reading: null, uplinked: true }).success).toBe(false);
    expect(
      LoginRequest.safeParse({ gatewayCode: 'TEST-GW-01', loginName: 'x', serviceKey: 'k', spki: 'AA', nonce: 'n'.repeat(16), sig: 'AA', apiToken: 'a'.repeat(43), extra: 1 }).success,
    ).toBe(false);
  });
});
