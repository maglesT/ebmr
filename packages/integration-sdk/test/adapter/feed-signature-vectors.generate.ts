/**
 * Writes packages/integration-sdk/fixtures/feed-signature-v1.json, the test vectors of the gateway feed signature v1
 * (slice 7-0 section 2). The tests verify the committed file; they never regenerate it.
 *
 *   node --import tsx packages/integration-sdk/test/adapter/feed-signature-vectors.generate.ts [--new-key]
 *
 * The key is a TEST-ONLY Ed25519 key made for these vectors; it is kept from the existing file unless --new-key is
 * given (Ed25519 signatures are deterministic, so the same key gives the same file). It signs nothing else, is
 * enrolled nowhere and must never be used by a gateway.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { feedKeyId, feedSignatureMessage, rawPayloadHash, type InboundEnvelope } from '@ebmr/integration-sdk/adapter';

const OUT = fileURLToPath(new URL('../../fixtures/feed-signature-v1.json', import.meta.url));
const GATEWAY_CODE = 'GW-TEST-ONLY-01';

function loadOrMakeKey(): KeyObject {
  if (!process.argv.includes('--new-key') && existsSync(OUT)) {
    const old = JSON.parse(readFileSync(OUT, 'utf8')) as { key: { privateKeyPkcs8Pem: string } };
    return createPrivateKey(old.key.privateKeyPkcs8Pem);
  }
  return generateKeyPairSync('ed25519').privateKey;
}

const privateKey = loadOrMakeKey();
const spkiDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
const keyId = feedKeyId(spkiDer);

/** Envelopes of the four feed message types; the payloads are illustrative, only their hash is signed. */
const cases: { name: string; messageType: string; sequenceNo: string; sourceRecordId: string; payload: Record<string, unknown> }[] = [
  { name: 'first series chunk', messageType: 'opcua.series_chunk', sequenceNo: '1', sourceRecordId: 'GRAN-01/inlet_temp/1', payload: { tag: 'inlet_temp', samples: [{ t: '1760000000000000', v: '61.25', unit: 'Cel', status: 'Good' }] } },
  { name: 'alarm at a four-digit sequence', messageType: 'opcua.alarm', sequenceNo: '4271', sourceRecordId: 'GRAN-01/alarm/77', payload: { alarm: 'HIGH_TEMP', state: 'RAISED' } },
  { name: 'equipment event above 2^53 (a float would round it)', messageType: 'opcua.equipment_event', sequenceNo: '9007199254740993', sourceRecordId: 'GRAN-01/event/9007199254740993', payload: { event: 'RECIPE_LOADED', recipe: 'R-1@3' } },
  { name: 'endpoint session at the largest 18-digit sequence', messageType: 'opcua.endpoint_session', sequenceNo: '999999999999999999', sourceRecordId: 'GRAN-01/session/1', payload: { endpoint: 'GRAN-01', securityPolicy: 'Basic256Sha256' } },
];

const vectors = cases.map((c) => {
  const raw = JSON.stringify(c.payload);
  const envelope: InboundEnvelope = {
    sourceSystem: 'OPCUA',
    messageType: c.messageType,
    sourceRecordId: c.sourceRecordId,
    sourceTimestamp: '1760000000000000',
    sequenceNo: c.sequenceNo,
    idempotencyKey: `${GATEWAY_CODE}-${rawPayloadHash(`${c.messageType}|${c.sourceRecordId}`).slice(0, 48)}`,
    schemaVersion: '1',
    payloadHash: rawPayloadHash(raw),
    payload: c.payload,
  };
  const message = feedSignatureMessage(envelope, GATEWAY_CODE, keyId);
  return {
    name: c.name,
    gatewayCode: GATEWAY_CODE,
    keyId,
    envelope,
    messageText: new TextDecoder().decode(message),
    messageHex: Buffer.from(message).toString('hex'),
    signature: sign(null, message, privateKey).toString('base64'),
  };
});

const file = {
  description: 'Gateway feed signature v1 test vectors (docs/build-plan/phase-7/slice-7-0-interfaces.md section 2). Regenerate with packages/integration-sdk/test/adapter/feed-signature-vectors.generate.ts.',
  version: 1,
  domain: 'ebmr-gateway-feed-v1',
  key: {
    label: 'TEST-ONLY Ed25519 key made for these vectors. It is enrolled nowhere and must never be used by a gateway.',
    privateKeyPkcs8Pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeySpkiDerHex: spkiDer.toString('hex'),
    keyId,
  },
  vectors,
};
writeFileSync(OUT, `${JSON.stringify(file, null, 2)}\n`);
console.log(`wrote ${vectors.length.toString()} vectors to ${OUT}`);
