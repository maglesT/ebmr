/**
 * The gateway feed signature v1 (Phase 7 slice 7-0 section 2; 6jc-R9): the signed message is built exactly as the
 * committed vectors say, and a signature stops verifying when any signed line changes. The vectors are verified, never
 * regenerated here (their generator is feed-signature-vectors.generate.ts beside this file).
 */
import { createHash, createPublicKey, generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import vectorsFile from '../../fixtures/feed-signature-v1.json' with { type: 'json' };
import { FEED_SIGNATURE_DOMAIN, FeedSignatureError, InboundEnvelope, feedKeyId, feedSignatureMessage, signFeedEnvelope, type FeedSignedFields } from '@ebmr/integration-sdk/adapter';

interface Vector {
  name: string;
  gatewayCode: string;
  keyId: string;
  envelope: InboundEnvelope;
  messageText: string;
  messageHex: string;
  signature: string;
}
const file = vectorsFile as unknown as { version: number; domain: string; key: { publicKeySpkiDerHex: string; keyId: string; label: string }; vectors: Vector[] };
const spkiDer = Buffer.from(file.key.publicKeySpkiDerHex, 'hex');
const publicKey: KeyObject = createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });

function verifies(message: Uint8Array, signature: string): boolean {
  return verify(null, message, publicKey, Buffer.from(signature, 'base64'));
}
function fieldOf(f: () => unknown): string | undefined {
  try {
    f();
  } catch (e) {
    if (e instanceof FeedSignatureError) {
      expect(e.errorClass).toBe('MALFORMED');
      return e.field;
    }
    throw e;
  }
  return undefined;
}

describe('the gateway feed signature v1 (DI-31; slice 7-0 section 2)', () => {
  it('[DI-31] the feed signature message is built exactly as the v1 vectors', () => {
    expect(file.version).toBe(1);
    expect(file.domain).toBe(FEED_SIGNATURE_DOMAIN);
    expect(file.key.label).toMatch(/^TEST-ONLY/);
    expect(file.vectors.length).toBeGreaterThanOrEqual(3);
    expect(new Set(file.vectors.map((v) => v.envelope.messageType)).size).toBe(file.vectors.length);
    // The key id is the lowercase hex SHA-256 of the key's SPKI DER.
    expect(feedKeyId(spkiDer)).toBe(createHash('sha256').update(spkiDer).digest('hex'));
    expect(file.key.keyId).toBe(feedKeyId(spkiDer));

    for (const v of file.vectors) {
      expect(v.keyId, v.name).toBe(file.key.keyId);
      const message = feedSignatureMessage(v.envelope, v.gatewayCode, v.keyId);
      expect(Buffer.from(message).toString('hex'), v.name).toBe(v.messageHex);
      const text = new TextDecoder().decode(message);
      expect(text, v.name).toBe(v.messageText);
      expect(text.split('\n'), v.name).toEqual([
        'ebmr-gateway-feed-v1',
        v.gatewayCode,
        v.envelope.sourceSystem,
        `${v.envelope.messageType}@${v.envelope.schemaVersion}`,
        v.envelope.sequenceNo,
        v.envelope.idempotencyKey,
        v.envelope.payloadHash,
        v.keyId,
      ]);
      expect(text.endsWith('\n'), v.name).toBe(false);
      // The same bytes when the sequence number is given as a bigint.
      expect(Buffer.from(feedSignatureMessage({ ...v.envelope, sequenceNo: BigInt(v.envelope.sequenceNo) }, v.gatewayCode, v.keyId)).toString('hex'), v.name).toBe(v.messageHex);
      expect(verifies(message, v.signature), v.name).toBe(true);
      // The signed envelope, signature attached, is a valid inbound envelope.
      expect(InboundEnvelope.safeParse({ ...v.envelope, gatewaySignature: { alg: 'Ed25519', gatewayCode: v.gatewayCode, keyId: v.keyId, sig: v.signature } }).success, v.name).toBe(true);
    }
    // A sequence above 2^53 keeps every digit (a JavaScript number would round it).
    const big = file.vectors.find((v) => BigInt(v.envelope.sequenceNo) > 2n ** 53n);
    expect(big).toBeDefined();
    expect(big?.messageText.split('\n')[4]).toBe(big?.envelope.sequenceNo);
    expect(String(Number(big?.envelope.sequenceNo))).not.toBe(big?.envelope.sequenceNo);
  });

  it('[DI-31] the feed signature no longer verifies when the sequence, the type, the payload hash or any other signed line changes', () => {
    const flipHex = (h: string): string => `${h.slice(0, -1)}${h.endsWith('0') ? '1' : '0'}`;
    for (const v of file.vectors) {
      const e = v.envelope;
      const seq = BigInt(e.sequenceNo);
      // A replay with a new sequence (the largest sequence an envelope holds is replayed one lower).
      const replayed = (seq >= 999_999_999_999_999_999n ? seq - 1n : seq + 1n).toString();
      const changes: [string, FeedSignedFields, string, string][] = [
        ['a new sequence', { ...e, sequenceNo: replayed }, v.gatewayCode, v.keyId],
        ['message type', { ...e, messageType: e.messageType === 'opcua.alarm' ? 'opcua.series_chunk' : 'opcua.alarm' }, v.gatewayCode, v.keyId],
        ['schema version', { ...e, schemaVersion: '2' }, v.gatewayCode, v.keyId],
        ['payload hash', { ...e, payloadHash: flipHex(e.payloadHash) }, v.gatewayCode, v.keyId],
        ['idempotency key', { ...e, idempotencyKey: `${e.idempotencyKey}x` }, v.gatewayCode, v.keyId],
        ['source system', { ...e, sourceSystem: 'EMS' }, v.gatewayCode, v.keyId],
        ['gateway code', e, 'GW-TEST-ONLY-02', v.keyId],
        ['key id', e, v.gatewayCode, flipHex(v.keyId)],
      ];
      for (const [what, env, gw, kid] of changes) {
        expect(verifies(feedSignatureMessage(env, gw, kid), v.signature), `${v.name}: ${what}`).toBe(false);
      }
      // Another vector's signature does not verify this vector's message either.
      const other = file.vectors.find((o) => o !== v);
      expect(verifies(Buffer.from(v.messageHex, 'hex'), other?.signature ?? '')).toBe(false);
    }
  });

  it('[DI-31] a gateway code, key id, payload hash or sequence outside its rule is refused before anything is signed', () => {
    const v = file.vectors[0] as Vector;
    const e = v.envelope;
    const bad: [string, () => unknown][] = [
      ['gatewayCode', () => feedSignatureMessage(e, 'GW\nTEST', v.keyId)],
      ['gatewayCode', () => feedSignatureMessage(e, '', v.keyId)],
      ['keyId', () => feedSignatureMessage(e, v.gatewayCode, v.keyId.toUpperCase())],
      ['keyId', () => feedSignatureMessage(e, v.gatewayCode, v.keyId.slice(1))],
      ['payloadHash', () => feedSignatureMessage({ ...e, payloadHash: e.payloadHash.toUpperCase() }, v.gatewayCode, v.keyId)],
      ['payloadHash', () => feedSignatureMessage({ ...e, payloadHash: `${e.payloadHash}\n` }, v.gatewayCode, v.keyId)],
      ['sequenceNo', () => feedSignatureMessage({ ...e, sequenceNo: '01' }, v.gatewayCode, v.keyId)],
      ['sequenceNo', () => feedSignatureMessage({ ...e, sequenceNo: '0' }, v.gatewayCode, v.keyId)],
      ['sequenceNo', () => feedSignatureMessage({ ...e, sequenceNo: 0n }, v.gatewayCode, v.keyId)],
      ['sequenceNo', () => feedSignatureMessage({ ...e, sequenceNo: -5n }, v.gatewayCode, v.keyId)],
      ['sequenceNo', () => feedSignatureMessage({ ...e, sequenceNo: 7 as unknown as string }, v.gatewayCode, v.keyId)],
      ['sequenceNo', () => feedSignatureMessage({ ...e, sequenceNo: '1e3' }, v.gatewayCode, v.keyId)],
      ['messageType', () => feedSignatureMessage({ ...e, messageType: 'opcua.alarm\nx' }, v.gatewayCode, v.keyId)],
      ['schemaVersion', () => feedSignatureMessage({ ...e, schemaVersion: '01' }, v.gatewayCode, v.keyId)],
      ['idempotencyKey', () => feedSignatureMessage({ ...e, idempotencyKey: 'has space' }, v.gatewayCode, v.keyId)],
      ['sourceSystem', () => feedSignatureMessage({ ...e, sourceSystem: 'SCADA' as unknown as 'OPCUA' }, v.gatewayCode, v.keyId)],
    ];
    for (const [field, f] of bad) expect(fieldOf(f), field).toBe(field);
  });

  it('[DI-31] an envelope may carry a gateway signature of the v1 shape only', () => {
    const v = file.vectors[0] as Vector;
    const sig = { alg: 'Ed25519', gatewayCode: v.gatewayCode, keyId: v.keyId, sig: v.signature };
    expect(InboundEnvelope.safeParse(v.envelope).success).toBe(true);
    expect(InboundEnvelope.safeParse({ ...v.envelope, gatewaySignature: sig }).success).toBe(true);
    for (const wrong of [{ ...sig, alg: 'ES256' }, { ...sig, sig: v.signature.slice(0, -2) }, { ...sig, keyId: v.keyId.toUpperCase() }, { ...sig, extra: 1 }, { alg: 'Ed25519', gatewayCode: v.gatewayCode, keyId: v.keyId }]) {
      expect(InboundEnvelope.safeParse({ ...v.envelope, gatewaySignature: wrong }).success, JSON.stringify(wrong)).toBe(false);
    }
  });

  // Mutation campaign at the Phase 7 exit (D-P7-1 item 4): the refusal names its field and the rule it broke, and the
  // gateway's own signing gives a v1 signature over exactly the message.
  it('[DI-31] a refused feed signature field is a FeedSignatureError naming the field and the rule it broke', () => {
    const v = file.vectors[0] as Vector;
    const errorOf = (f: () => unknown): FeedSignatureError => {
      try {
        f();
      } catch (e) {
        if (e instanceof FeedSignatureError) return e;
        throw e;
      }
      throw new Error('not refused');
    };
    const seq = errorOf(() => feedSignatureMessage({ ...v.envelope, sequenceNo: '01' }, v.gatewayCode, v.keyId));
    expect(seq.name).toBe('FeedSignatureError');
    expect(seq.message).toBe('feed signature: sequenceNo: a sequence number 1, 2, 3, ... as text');
    expect(errorOf(() => feedSignatureMessage(v.envelope, v.gatewayCode, 'ABC')).message).toBe('feed signature: keyId: SHA-256 as 64 lower-case hex digits');
    // A JavaScript number is refused as such, not as a text out of its rule.
    expect(errorOf(() => feedSignatureMessage({ ...v.envelope, sequenceNo: 7 as unknown as string }, v.gatewayCode, v.keyId)).message).toBe(
      'feed signature: sequenceNo: a sequence number travels as text or bigint, never as a number',
    );
  });

  it('[DI-31] the gateway signs a feed envelope as Ed25519 over the v1 message with its key', () => {
    const v = file.vectors[0] as Vector;
    const { privateKey, publicKey: pub } = generateKeyPairSync('ed25519');
    const keyId = feedKeyId(pub.export({ format: 'der', type: 'spki' }));
    const s = signFeedEnvelope(v.envelope, v.gatewayCode, keyId, privateKey);
    expect(Object.keys(s).sort()).toEqual(['alg', 'gatewayCode', 'keyId', 'sig']);
    expect(s).toMatchObject({ alg: 'Ed25519', gatewayCode: v.gatewayCode, keyId });
    expect(s.sig).toMatch(/^[A-Za-z0-9+/]{86}==$/);
    expect(verify(null, feedSignatureMessage(v.envelope, v.gatewayCode, keyId), pub, Buffer.from(s.sig, 'base64'))).toBe(true);
    expect(InboundEnvelope.safeParse({ ...v.envelope, gatewaySignature: s }).success).toBe(true);
  });
});
