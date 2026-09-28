/**
 * The scale reading (Phase 2 apps plan section 10; controls DI-20, DI-28, DI-31, DI-32).
 *
 * A reading is what the site gateway took from an instrument: the value exactly as the raw MT-SICS line states
 * it, the instrument's identity (device code and the serial the gateway verified with I4), the gateway's own
 * clock with its trust, and the installation kind. The gateway numbers its readings per chain (one chain per
 * gateway enrolment on a server), links each to the previous one by hash and signs the hash with its Ed25519
 * key. The server recomputes the hash (in TypeScript and SQL), verifies the signature against the enrolled key
 * and enforces sequence continuity, so a reading can be neither altered, dropped nor inserted unnoticed.
 *
 * Canonical text: the JSON array of the fields in a fixed order (no spaces), UTF-8. hash = SHA-256 hex of it.
 * Signature: Ed25519 over the UTF-8 text `ebmr.scale-reading.v1|<hash>`, base64. The first reading of a chain
 * links to genesisHash(chainId).
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { DECIMAL_TEXT } from './decimal.ts';
import { SERIAL_PATTERN, UNIT_PATTERN } from './mt-sics.ts';

export const READING_FORMAT = 'ebmr.scale-reading.v1';

export const Hex64 = z.string().regex(/^[0-9a-f]{64}$/, 'SHA-256 as 64 lower-case hex digits');
export const Base64 = z.string().regex(/^[A-Za-z0-9+/_-]+={0,2}$/, 'base64 text');
export const DeviceCode = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/, 'a registered device code');
export const DecimalText = z.string().regex(DECIMAL_TEXT, 'a decimal travels as plain decimal text');
/** Whole numbers as text (sequence numbers, epoch microseconds). */
export const IntegerText = z.string().regex(/^(0|[1-9][0-9]*)$/, 'a whole number as text');
export const EpochMicrosText = z.string().regex(/^-?(0|[1-9][0-9]*)$/, 'UTC epoch microseconds as text');
/** The raw instrument line: printable ASCII only. */
export const RawLine = z.string().min(1).max(128).regex(/^[\x20-\x7E]+$/, 'printable ASCII');

export const ReadingStatus = z.enum(['OK', 'UNSTABLE', 'OVERLOAD', 'UNDERLOAD', 'OFFLINE', 'ERROR']);
export type ReadingStatus = z.infer<typeof ReadingStatus>;
export const TimeTrust = z.enum(['DEVICE_SYNCED', 'DEVICE_UNSYNCED']);
export type TimeTrust = z.infer<typeof TimeTrust>;
export const CapturePurpose = z.enum(['TARE', 'GROSS', 'CHECK']);
export type CapturePurpose = z.infer<typeof CapturePurpose>;
export const InstallationKind = z.enum(['GMP', 'SANDBOX']);
export type InstallationKind = z.infer<typeof InstallationKind>;

/** A reading before the chain fields are added. */
export const ReadingBody = z.strictObject({
  format: z.literal(READING_FORMAT),
  readingId: z.uuid(),
  /** The chain: the gateway's enrolment on the server it uplinks to. */
  chainId: z.uuid(),
  gatewayCode: DeviceCode,
  deviceCode: DeviceCode,
  /** The instrument serial the gateway verified with I4 on this connection (DI-20). */
  serial: z.string().regex(SERIAL_PATTERN),
  seq: IntegerText,
  value: DecimalText.nullable(),
  unit: z.string().regex(UNIT_PATTERN).nullable(),
  stable: z.boolean(),
  status: ReadingStatus,
  raw: RawLine,
  /** The gateway's clock when the line arrived (clock.ts); trust says whether that clock is synchronised. */
  sourceTimeUs: EpochMicrosText,
  trust: TimeTrust,
  installation: InstallationKind,
  purpose: CapturePurpose.nullable(),
  prevHash: Hex64,
});
export type ReadingBody = z.infer<typeof ReadingBody>;

export const ScaleReading = z.strictObject({ ...ReadingBody.shape, hash: Hex64, signature: Base64 });
export type ScaleReading = z.infer<typeof ScaleReading>;

/** The canonical text of a reading (hash input). Field order is part of the format; never reorder. */
export function canonicalReadingText(r: ReadingBody): string {
  return JSON.stringify([
    r.format,
    r.readingId,
    r.chainId,
    r.gatewayCode,
    r.deviceCode,
    r.serial,
    r.seq,
    r.value,
    r.unit,
    r.stable,
    r.status,
    r.raw,
    r.sourceTimeUs,
    r.trust,
    r.installation,
    r.purpose,
    r.prevHash,
  ]);
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function readingHash(r: ReadingBody): string {
  return sha256Hex(canonicalReadingText(r));
}

/** The link the first reading of a chain carries. */
export function genesisHash(chainId: string): string {
  return sha256Hex(`${READING_FORMAT}.genesis|${chainId}`);
}

export function signatureMessage(hash: string): Buffer {
  return Buffer.from(`${READING_FORMAT}|${hash}`, 'utf8');
}

/** The Ed25519 private key from PKCS#8 DER (base64), as the DEMO-ONLY gateway key file holds it. */
export function ed25519PrivateKey(pkcs8Base64: string): KeyObject {
  const key = createPrivateKey({ key: Buffer.from(pkcs8Base64, 'base64'), format: 'der', type: 'pkcs8' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('the gateway key is not an Ed25519 key');
  return key;
}

export function ed25519PublicKey(spkiBase64: string): KeyObject {
  const key = createPublicKey({ key: Buffer.from(spkiBase64, 'base64'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('the gateway public key is not an Ed25519 key');
  return key;
}

/** SHA-256 of the SPKI DER, lower-case hex: the kernel's device fingerprint of the gateway's SERVER device. */
export function spkiFingerprint(spkiBase64: string): string {
  return createHash('sha256').update(Buffer.from(spkiBase64, 'base64')).digest('hex');
}

/** Seals a reading body: hash over the canonical text, Ed25519 signature over the hash. */
export function sealReading(body: ReadingBody, privateKey: KeyObject): ScaleReading {
  const parsed = ReadingBody.parse(body);
  const hash = readingHash(parsed);
  const signature = sign(null, signatureMessage(hash), privateKey).toString('base64');
  return { ...parsed, hash, signature };
}

export type ReadingProblem = 'SCHEMA' | 'HASH' | 'SIGNATURE' | 'RAW_MISMATCH';

/**
 * Checks a received reading on its own: schema, hash over the canonical text, Ed25519 signature with the given
 * public key. Chain continuity is the receiver's job (it knows the head). Returns null when sound.
 */
export function readingProblem(candidate: unknown, publicKey: KeyObject): { problem: ReadingProblem; detail: string } | null {
  const parsed = ScaleReading.safeParse(candidate);
  if (!parsed.success) return { problem: 'SCHEMA', detail: z.prettifyError(parsed.error) };
  const r = parsed.data;
  const { hash, signature, ...body } = r;
  if (readingHash(body) !== hash) return { problem: 'HASH', detail: 'the hash does not match the reading content' };
  let ok = false;
  try {
    ok = verify(null, signatureMessage(hash), publicKey, Buffer.from(signature, 'base64'));
  } catch {
    ok = false;
  }
  if (!ok) return { problem: 'SIGNATURE', detail: 'the signature does not verify with the enrolled gateway key' };
  return null;
}
