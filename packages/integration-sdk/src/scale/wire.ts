/**
 * Wire formats between the site gateway and the tablets server (Phase 2 apps plan section 10).
 *
 * Two channels, each authenticated in its own direction:
 *  - uplink (gateway -> server's gateway listener, /gw/v1): the gateway logs in as its INTEGRATION identity with
 *    its SERVICE_KEY and a proof of possession of its Ed25519 key (the key whose SHA-256 SPKI fingerprint is the
 *    registered SERVER device), then sends readings (idempotent by readingId, each with its wait signed against a
 *    challenge the database issued for the upload) and heartbeats with an opaque bearer token;
 *  - gateway API (server -> gateway, /v1): capture and live display, authorised by a random API token the
 *    gateway hands over in its login, so the server never holds the gateway's credential.
 */
import { z } from 'zod';
import { Base64, CapturePurpose, DecimalText, DeviceCode, EpochMicrosText, Hex64, InstallationKind, IntegerText, ReadingStatus, ScaleReading } from './reading.ts';
import { SERIAL_PATTERN, UNIT_PATTERN } from './mt-sics.ts';

export const GATEWAY_UPLINK_PREFIX = '/gw/v1';
export const GATEWAY_API_PREFIX = '/v1';
/** Opaque tokens (bearer and API token): 32 random bytes as base64url. */
export const OpaqueToken = z.string().regex(/^[A-Za-z0-9_-]{40,128}$/, 'an opaque token');

/** Why a capture produced no usable reading. */
export const ScaleErrorClass = z.enum([
  'DEVICE_OFFLINE',
  'NOT_STABLE_WITHIN_TIMEOUT',
  'OVERLOAD',
  'UNDERLOAD',
  'UNIT_MISMATCH',
  'SERIAL_MISMATCH',
  'PROTOCOL_ERROR',
  'UNKNOWN_DEVICE',
  /** The gateway has no chain yet (never logged in) or its journal refused the write. */
  'NOT_READY',
]);
export type ScaleErrorClass = z.infer<typeof ScaleErrorClass>;

// ---------------------------------------------------------------------------------------------
// Gateway API (the server calls the gateway)

export const CaptureRequest = z.strictObject({
  purpose: CapturePurpose,
  /** How long the gateway waits for a stable weight (default 10 s). */
  timeoutMs: z.number().int().min(500).max(30_000).optional(),
});
export type CaptureRequest = z.infer<typeof CaptureRequest>;

export const CaptureResponse = z.discriminatedUnion('outcome', [
  /** A stable reading, journalled (fsync) before this answer; `uplinked` when the server acknowledged it. */
  z.strictObject({ outcome: z.literal('CAPTURED'), reading: ScaleReading, uplinked: z.boolean() }),
  /** No usable reading. When the instrument answered, what it said is journalled and uplinked too (`reading`). */
  z.strictObject({ outcome: z.literal('FAILED'), error: ScaleErrorClass, message: z.string(), reading: ScaleReading.nullable(), uplinked: z.boolean() }),
]);
export type CaptureResponse = z.infer<typeof CaptureResponse>;

/** One live display sample (SSE `data:`); display only, never recorded. Same shape as the contract's LiveReadingEvent. */
export const LiveSample = z.strictObject({
  deviceCode: DeviceCode,
  value: DecimalText.nullable(),
  unit: z.string().regex(UNIT_PATTERN).nullable(),
  stable: z.boolean(),
  status: ReadingStatus,
});
export type LiveSample = z.infer<typeof LiveSample>;

export const DeviceState = z.enum(['CONNECTING', 'ONLINE', 'OFFLINE', 'SERIAL_MISMATCH']);
export type DeviceState = z.infer<typeof DeviceState>;

export const GatewayHealth = z.strictObject({
  gatewayCode: DeviceCode,
  loggedIn: z.boolean(),
  chainId: z.uuid().nullable(),
  journal: z.strictObject({ lastSeq: IntegerText, ackedSeq: IntegerText }),
  devices: z.array(
    z.strictObject({
      deviceCode: DeviceCode,
      /** The state the heartbeat reports: a connected instrument the gateway cannot capture from and deliver is OFFLINE. */
      state: DeviceState,
      serial: z.string().nullable(),
      /** Why a connected instrument is reported OFFLINE (the capture would answer NOT_READY); null otherwise. */
      notReady: z.string().nullable(),
    }),
  ),
});
export type GatewayHealth = z.infer<typeof GatewayHealth>;

// ---------------------------------------------------------------------------------------------
// Uplink (the gateway calls the server's gateway listener)

export const NonceResponse = z.strictObject({ nonce: z.string().min(16).max(128) });

/** The text the gateway signs with its Ed25519 key at login (proof of possession of the enrolled key). */
export function loginProofMessage(nonce: string, gatewayCode: string, loginName: string, spki: string): Buffer {
  return Buffer.from(`ebmr.gateway-login.v1|${nonce}|${gatewayCode}|${loginName}|${spki}`, 'utf8');
}

/**
 * U+0000, or a UTF-16 surrogate without its other half: PostgreSQL refuses U+0000, and UTF-8 encoding writes U+FFFD in
 * place of a lone surrogate, so the server would look up text the gateway never sent (review F30-F33). The login's
 * free text members refuse it; every other text member of the uplink is a pattern of printable characters.
 */
// eslint-disable-next-line no-control-regex -- U+0000 is looked for on purpose.
const UNSTORABLE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const storable = (s: z.ZodString) => s.refine((t) => !UNSTORABLE.test(t), 'holds U+0000 or a surrogate without its other half, which no record can hold');

export const LoginRequest = z.strictObject({
  gatewayCode: DeviceCode,
  loginName: storable(z.string().min(1).max(128)),
  serviceKey: storable(z.string().min(1).max(512)),
  /** The gateway's Ed25519 public key (SPKI DER, base64). */
  spki: Base64,
  nonce: storable(z.string().min(16).max(128)),
  /** Ed25519 over loginProofMessage(...). */
  sig: Base64,
  /** The token the server presents to the gateway API from now on. */
  apiToken: OpaqueToken,
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const ChainHead = z.strictObject({ seq: IntegerText, hash: Hex64 });
export type ChainHead = z.infer<typeof ChainHead>;

export const EnrolledInstrument = z.strictObject({
  deviceCode: DeviceCode,
  serial: z.string().regex(SERIAL_PATTERN),
  unit: z.string().regex(UNIT_PATTERN),
  resolution: DecimalText,
  roomCode: z.string().nullable(),
});

export const LoginResponse = z.strictObject({
  token: OpaqueToken,
  /** The chain this enrolment's readings belong to (the enrolment id). */
  chainId: z.uuid(),
  head: ChainHead,
  installation: InstallationKind,
  serverTimeUs: EpochMicrosText,
  /** Instruments the server has bound to this gateway (the gateway refuses captures for any other). */
  instruments: z.array(EnrolledInstrument),
});
export type LoginResponse = z.infer<typeof LoginResponse>;

/**
 * DI-28 (review finding P53): the challenge the server's database issues for one upload (POST /gw/v1/challenge, with
 * the bearer token). The database keeps when it issued it; the gateway signs each reading's wait against it.
 */
export const ChallengeResponse = z.strictObject({ challengeId: z.uuid() });
export type ChallengeResponse = z.infer<typeof ChallengeResponse>;

export const UPLOAD_WAIT_FORMAT = 'ebmr.upload-wait.v1';

/**
 * The text the gateway signs with its Ed25519 key for each reading of an upload: the upload's challenge, the reading
 * id and the reading's wait at the gateway, measured after the challenge arrived (ids as lower-case text, the wait in
 * plain decimal microseconds). The database verifies it (tab.ingest_reading) and counts the wait as this signed
 * value plus its own time from the challenge's issue to the insert, so no part of a reading's age is the server
 * application's word.
 */
export function uploadWaitMessage(challengeId: string, readingId: string, delayUs: string): Buffer {
  return Buffer.from(`${UPLOAD_WAIT_FORMAT}|${challengeId.toLowerCase()}|${readingId.toLowerCase()}|${delayUs}`, 'utf8');
}

export const UplinkItem = z.strictObject({
  reading: ScaleReading,
  /**
   * How long the reading had waited at the gateway when this item was signed (monotonic clock, microseconds), or null
   * when unknown (sent after a gateway restart). The database counts it, plus its own time since the upload's
   * challenge, into the reading's age: null means too old to claim, so a replayed reading is kept but never used for
   * a new entry.
   */
  delayUs: IntegerText.nullable(),
  /** Ed25519 over uploadWaitMessage(challengeId, reading.readingId, delayUs), base64; null when delayUs is null. */
  waitSig: Base64.nullable(),
});
export type UplinkItem = z.infer<typeof UplinkItem>;

export const UplinkRequest = z.strictObject({
  /** The challenge the waits of these items are signed against (ChallengeResponse). */
  challengeId: z.uuid(),
  items: z.array(UplinkItem).min(1).max(100),
});
export type UplinkRequest = z.infer<typeof UplinkRequest>;

export const UplinkResult = z.strictObject({ readingId: z.uuid(), seq: IntegerText, outcome: z.enum(['INGESTED', 'DUPLICATE']) });

export const UplinkResponse = z.strictObject({
  results: z.array(UplinkResult),
  head: ChainHead,
  /** The first reading the server refused (processing stops there; later items were not attempted). */
  refused: z.strictObject({ readingId: z.string(), code: z.string(), message: z.string() }).nullable(),
});
export type UplinkResponse = z.infer<typeof UplinkResponse>;

/** The longest reason a heartbeat gives for an instrument that is not ready (the server stores it). */
export const NOT_READY_MAX = 500;

export const HeartbeatRequest = z.strictObject({
  gatewayTimeUs: EpochMicrosText,
  devices: z.array(
    z.strictObject({
      deviceCode: DeviceCode,
      /** The state the server shows: a connected instrument the gateway cannot capture from and deliver is OFFLINE. */
      state: DeviceState,
      /** The serial read with I4 on the current connection (null while not connected). */
      serial: z.string().regex(SERIAL_PATTERN).nullable(),
      /**
       * Why a connected instrument is reported OFFLINE (a capture would answer NOT_READY), or null. The server stores
       * it and alarms each episode, so it holds a record of why (review finding P51). Optional for older gateways.
       */
      notReady: z.string().min(1).max(NOT_READY_MAX).nullable().optional(),
    }),
  ),
  journal: z.strictObject({
    lastSeq: IntegerText,
    /** The acknowledgement watermark written on the gateway's disk. */
    ackedSeq: IntegerText,
    /**
     * The last reading the server acknowledged, as the gateway holds it in memory: above ackedSeq while the watermark
     * cannot be written. The server's reconciliation by counts (DI-31) takes the higher of the two. Optional for older
     * gateways.
     */
    deliveredSeq: IntegerText.optional(),
  }),
});
export type HeartbeatRequest = z.infer<typeof HeartbeatRequest>;

export const HeartbeatResponse = z.strictObject({ serverTimeUs: EpochMicrosText, head: ChainHead });
export type HeartbeatResponse = z.infer<typeof HeartbeatResponse>;

export const GatewayWireError = z.strictObject({
  error: z.strictObject({
    code: z.string(),
    message: z.string(),
    /** The bearer token is unknown or expired: log in again. */
    relogin: z.boolean(),
  }),
});
export type GatewayWireError = z.infer<typeof GatewayWireError>;
