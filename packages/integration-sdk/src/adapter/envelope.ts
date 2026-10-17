/**
 * The inbound envelope (Phase 6 slice 6a-0; DI-31, DI-20; plan docs/build-plan/phase-6/slice-6a-0-interfaces.md).
 *
 * Every message an adapter hands to the eBMR travels in this envelope, whatever the source system. The database
 * function `platform.accept_inbound(envelope jsonb)` (kernel 1180) validates the same shape again, so this schema is
 * the adapter's early check, never the only one:
 *
 *  - sourceSystem     the system of record the adapter speaks for; must equal the adapter's registered system.
 *  - messageType      `<system>.<name>`, for example `erp.production_order`; with schemaVersion it names the payload
 *                     schema (the system contract modules under ./systems).
 *  - sourceRecordId   the record's id in the source system (an order number, a CAPA id, a sample id).
 *  - sourceTimestamp  when the source system recorded the value: UTC epoch microseconds as text.
 *  - sequenceNo       the adapter instance's message counter, 1, 2, 3, ... as text; a gap or a late number raises an
 *                     integration alarm in the database.
 *  - idempotencyKey   the source's unique key for this message; the same key with the same payload hash is a
 *                     duplicate (de-duplicated, the first message's id returned), with another hash a refusal.
 *  - schemaVersion    the payload schema version, whole number as text.
 *  - payloadHash      SHA-256 (lower-case hex) of the raw bytes exactly as received from the source (rawPayloadHash).
 *  - payload          the parsed payload, a JSON object; it keeps raw values and their units as the source sent them.
 *  - gatewaySignature (optional; Phase 7 slice 7-0) the site gateway's Ed25519 signature over the envelope's
 *                     identity lines (feed-signature.ts); required for the OPCUA source from slice 7a on, checked in the
 *                     database (docs/build-plan/phase-7/slice-7-0-interfaces.md section 2).
 *
 * Numbers in payloads travel as decimal text (never JSON numbers), as in every other contract of this package.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

/** The external systems an adapter may speak for (outline 4.6; ems, opcua for 6b, l3 for 6c). */
export const SOURCE_SYSTEMS = ['ERP_WMS', 'QMS', 'LIMS', 'LMS', 'CMMS', 'EMS', 'OPCUA', 'L3'] as const;
export const SourceSystem = z.enum(SOURCE_SYSTEMS);
export type SourceSystem = z.infer<typeof SourceSystem>;

/** UTC epoch microseconds as whole decimal text. */
export const EpochMicrosText = z.string().regex(/^(0|[1-9][0-9]{0,17})$/, 'UTC epoch microseconds as text');
/** A positive whole number as text, at most 18 digits (fits a PostgreSQL bigint). */
export const SequenceNoText = z.string().regex(/^[1-9][0-9]{0,17}$/, 'a sequence number 1, 2, 3, ... as text');
export const SchemaVersionText = z.string().regex(/^[1-9][0-9]{0,3}$/, 'a schema version 1 to 9999 as text');
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'SHA-256 as 64 lower-case hex digits');
/** Printable ASCII without spaces, 1 to 128 characters. */
export const IdempotencyKey = z.string().regex(/^[\x21-\x7E]{1,128}$/, 'printable ASCII without spaces, at most 128');
export const SourceRecordId = z.string().regex(/^[\x20-\x7E]{1,128}$/, 'printable ASCII, at most 128').refine((s) => s.trim() === s, 'no leading or trailing blanks');
export const MessageType = z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*$/, 'a message type such as erp.production_order');

/** A gateway's code as `tab.gateway_key.gateway_code` holds it (the device code rule of the scale contract). */
export const GatewayCode = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/, 'a registered gateway code');
/** Standard base64 (padded) of a 64-byte Ed25519 signature. */
export const Ed25519SignatureBase64 = z.string().regex(/^[A-Za-z0-9+/]{86}==$/, 'standard base64 of a 64-byte signature');

/**
 * The gateway's signature of a feed envelope (slice 7-0 section 2). keyId is the lowercase hex SHA-256 of the key's
 * SPKI DER (feedKeyId); sig signs feedSignatureMessage(envelope, gatewayCode, keyId).
 */
export const GatewaySignature = z.strictObject({
  alg: z.literal('Ed25519'),
  gatewayCode: GatewayCode,
  keyId: Sha256Hex,
  sig: Ed25519SignatureBase64,
});
export type GatewaySignature = z.infer<typeof GatewaySignature>;

/** The most bytes one payload may hold once serialised (the database refuses more). */
export const PAYLOAD_MAX_BYTES = 1_048_576;

export const InboundEnvelope = z
  .strictObject({
    sourceSystem: SourceSystem,
    messageType: MessageType,
    sourceRecordId: SourceRecordId,
    sourceTimestamp: EpochMicrosText,
    sequenceNo: SequenceNoText,
    idempotencyKey: IdempotencyKey,
    schemaVersion: SchemaVersionText,
    payloadHash: Sha256Hex,
    payload: z.record(z.string(), z.unknown()),
    gatewaySignature: GatewaySignature.optional(),
  })
  .refine((e) => Buffer.byteLength(JSON.stringify(e.payload), 'utf8') <= PAYLOAD_MAX_BYTES, {
    message: `the payload exceeds ${PAYLOAD_MAX_BYTES.toString()} bytes`,
    path: ['payload'],
  });
export type InboundEnvelope = z.infer<typeof InboundEnvelope>;

/** SHA-256 (lower-case hex) of the raw bytes received from the source: the envelope's payloadHash. */
export function rawPayloadHash(raw: Uint8Array | string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Where a message stands in its adapter's sequence, as `platform.accept_inbound_detail` reports it. */
export const SequenceStatus = z.enum(['FIRST', 'IN_ORDER', 'GAP', 'LATE']);
export type SequenceStatus = z.infer<typeof SequenceStatus>;

/**
 * What `platform.accept_inbound_detail(envelope)` returns. ACCEPTED: a new message row (apply its payload in the same
 * transaction). DUPLICATE: the same idempotency key and payload hash were accepted before; messageId is the first
 * message's id and the payload must NOT be applied again.
 */
export const AcceptOutcome = z.strictObject({
  messageId: z.uuid(),
  outcome: z.enum(['ACCEPTED', 'DUPLICATE']),
  sequenceStatus: SequenceStatus,
  /** The alarm raised for a gap or a late message, else null. */
  alarmId: z.uuid().nullable(),
});
export type AcceptOutcome = z.infer<typeof AcceptOutcome>;
