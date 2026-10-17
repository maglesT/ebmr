/**
 * The gateway feed signature, v1 (Phase 7 slice 7-0 section 2; 6jc-R9; DI-31).
 *
 * The site gateway signs every envelope of its OPC UA feed with its Ed25519 key. What it signs is built here and only
 * here (the database's verifier is tested against the vectors in fixtures/feed-signature-v1.json): the UTF-8 bytes of
 * eight lines joined by a line feed, with no line feed at the end:
 *
 *   ebmr-gateway-feed-v1
 *   <gatewayCode>
 *   <sourceSystem>
 *   <messageType>@<schemaVersion>
 *   <sequenceNo, decimal, no leading zeros>
 *   <idempotencyKey>
 *   <payloadHash, lowercase hex>
 *   <keyId>
 *
 * The domain line keeps these signatures apart from the reading and login proofs the gateway also signs. Sequence,
 * type and payload hash are inside the signature, so an envelope replayed with a new sequence number fails the check.
 * Every field is checked against its envelope rule first; none of those rules admits a line feed, so a field cannot
 * forge a line. The sequence number is handled as text or bigint throughout, never as a JavaScript number.
 */
import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { InboundError } from './errors.ts';
import { GatewayCode, IdempotencyKey, MessageType, SchemaVersionText, SequenceNoText, Sha256Hex, SourceSystem, type InboundEnvelope } from './envelope.ts';

/** The first line of every signed feed message (v1). */
export const FEED_SIGNATURE_DOMAIN = 'ebmr-gateway-feed-v1';

/** The envelope fields the signature covers; the sequence number may be given as its text or as a bigint. */
export type FeedSignedFields = Pick<InboundEnvelope, 'sourceSystem' | 'messageType' | 'schemaVersion' | 'idempotencyKey' | 'payloadHash'> & {
  sequenceNo: string | bigint;
};

export type FeedSignatureField = 'gatewayCode' | 'keyId' | 'sourceSystem' | 'messageType' | 'schemaVersion' | 'sequenceNo' | 'idempotencyKey' | 'payloadHash';

/** A field that cannot be signed as it stands (a MALFORMED inbound error naming the field). */
export class FeedSignatureError extends InboundError {
  readonly field: FeedSignatureField;
  constructor(field: FeedSignatureField, detail: string) {
    super('MALFORMED', `feed signature: ${field}: ${detail}`);
    this.name = 'FeedSignatureError';
    this.field = field;
  }
}

function checked(field: FeedSignatureField, rule: z.ZodType<string>, value: unknown): string {
  const r = rule.safeParse(value);
  if (!r.success) throw new FeedSignatureError(field, r.error.issues[0]?.message ?? 'not valid');
  return r.data;
}

function sequenceText(seq: unknown): string {
  if (typeof seq === 'bigint') return checked('sequenceNo', SequenceNoText, seq.toString(10));
  if (typeof seq === 'string') return checked('sequenceNo', SequenceNoText, seq);
  throw new FeedSignatureError('sequenceNo', 'a sequence number travels as text or bigint, never as a number');
}

/** The exact bytes the gateway signs for one envelope (v1). Throws FeedSignatureError for a field outside its rule. */
export function feedSignatureMessage(envelope: FeedSignedFields, gatewayCode: string, keyId: string): Uint8Array {
  const lines = [
    FEED_SIGNATURE_DOMAIN,
    checked('gatewayCode', GatewayCode, gatewayCode),
    checked('sourceSystem', SourceSystem, envelope.sourceSystem),
    `${checked('messageType', MessageType, envelope.messageType)}@${checked('schemaVersion', SchemaVersionText, envelope.schemaVersion)}`,
    sequenceText(envelope.sequenceNo),
    checked('idempotencyKey', IdempotencyKey, envelope.idempotencyKey),
    checked('payloadHash', Sha256Hex, envelope.payloadHash),
    checked('keyId', Sha256Hex, keyId),
  ];
  return new TextEncoder().encode(lines.join('\n'));
}

/** The key id of a gateway key: lowercase hex SHA-256 of its SPKI DER bytes. */
export function feedKeyId(spkiDer: Uint8Array): string {
  return createHash('sha256').update(spkiDer).digest('hex');
}
