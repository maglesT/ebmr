/**
 * Signature manifestation (DI-36): printed name as at signing, user ID, role, meaning, and date and
 * time with UTC offset and site zone. It is stored with the signature when it is applied
 * (esig.signature.manifestation) and every renderer below reads only that stored copy, never the
 * user tables, so renaming a person later leaves historic manifestations unchanged.
 */
import type pg from 'pg';
import { EsigError } from './errors.ts';

type Db = pg.Pool | pg.PoolClient;

export interface Manifestation {
  signatureId: string;
  printedName: string;
  userId: string;
  roleCode: string;
  roleName: string;
  meaningCode: string;
  meaningTitle: string;
  meaningText: string;
  /** ISO 8601 UTC with microseconds. */
  signedAtUtc: string;
  /** Site-local wall-clock time, YYYY-MM-DD HH:MM:SS. */
  signedAtLocal: string;
  /** +HH:MM or -HH:MM. */
  utcOffset: string;
  siteZone: string;
  record: { aggregateType: string; aggregateId: string; contentVersion: string; contentHash: string };
  cosignature: boolean;
  delegationId: string | null;
}

export type SignatureStatus = 'VALID' | 'SUPERSEDED_BY_CHANGE' | 'CONTENT_MISMATCH' | 'UNSEALED' | 'UNKNOWN';

export interface StoredManifestation {
  manifestation: Manifestation;
  /** The one-line text stored with the signature. */
  text: string;
  status: SignatureStatus;
  valid: boolean;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : JSON.stringify(v));

/** Maps the stored JSON (snake_case, as in the database) to the typed form. */
export function toManifestation(raw: Record<string, unknown>): Manifestation {
  const record = (raw['record'] ?? {}) as Record<string, unknown>;
  return {
    signatureId: str(raw['signature_id']),
    printedName: str(raw['printed_name']),
    userId: str(raw['user_id']),
    roleCode: str(raw['role_code']),
    roleName: str(raw['role_name']),
    meaningCode: str(raw['meaning_code']),
    meaningTitle: str(raw['meaning_title']),
    meaningText: str(raw['meaning_text']),
    signedAtUtc: str(raw['signed_at_utc']),
    signedAtLocal: str(raw['signed_at_local']),
    utcOffset: str(raw['utc_offset']),
    siteZone: str(raw['site_zone']),
    record: {
      aggregateType: str(record['aggregate_type']),
      aggregateId: str(record['aggregate_id']),
      contentVersion: str(record['content_version']),
      contentHash: str(record['content_hash']),
    },
    cosignature: raw['cosignature'] === true,
    delegationId: typeof raw['delegation_id'] === 'string' ? raw['delegation_id'] : null,
  };
}

/** The manifestation stored with a signature, with the signature's current status. */
export async function getManifestation(db: Db, signatureId: string): Promise<StoredManifestation> {
  const { rows } = await db.query<{ m: { manifestation: Record<string, unknown>; text: string; status: SignatureStatus; valid: boolean } }>(
    'select esig.manifestation($1) as m',
    [signatureId],
  );
  const m = rows[0]?.m;
  if (!m) throw new EsigError('EBMR-ESIG-070', `signature ${signatureId} does not exist`);
  return { manifestation: toManifestation(m.manifestation), text: m.text, status: m.status, valid: m.valid };
}

export type ManifestationMedium = 'SCREEN' | 'PRINT' | 'PDF';

const statusNote = (status: SignatureStatus): string | null =>
  status === 'VALID' ? null : status === 'SUPERSEDED_BY_CHANGE' ? 'SUPERSEDED BY CHANGE - this element is unsigned; signing again is required' : `NOT VALID (${status})`;

/**
 * Human-readable lines for screen, print and PDF. Every medium shows all elements; a signature
 * that is no longer valid is shown as such, never as a valid signature.
 */
export function renderManifestation(stored: StoredManifestation, medium: ManifestationMedium): string[] {
  const m = stored.manifestation;
  const when = `${m.signedAtLocal} UTC${m.utcOffset} (${m.siteZone})`;
  const note = statusNote(stored.status);
  if (medium === 'SCREEN') {
    return [`${m.printedName} (${m.userId}, ${m.roleName}) - ${m.meaningTitle}: ${m.meaningText} - ${when}`, ...(note ? [note] : [])];
  }
  return [
    `Signed by: ${m.printedName}`,
    `User ID: ${m.userId}`,
    `Role: ${m.roleName} (${m.roleCode})`,
    `Meaning: ${m.meaningTitle} - ${m.meaningText}`,
    `Date and time: ${when}`,
    `Record: ${m.record.aggregateType} ${m.record.aggregateId}, content version ${m.record.contentVersion}, SHA-256 ${m.record.contentHash}`,
    `Signature ID: ${m.signatureId}${m.cosignature ? ' (co-signed at another person\'s terminal session)' : ''}`,
    ...(medium === 'PDF' ? [`Signed at (UTC): ${m.signedAtUtc}`] : []),
    ...(note ? [`Status: ${note}`] : []),
  ];
}

/** A flat export row (JSON, CSV) with every manifestation element and the status. */
export function manifestationExport(stored: StoredManifestation): Record<string, string | boolean | null> {
  const m = stored.manifestation;
  return {
    signature_id: m.signatureId,
    printed_name: m.printedName,
    user_id: m.userId,
    role_code: m.roleCode,
    role_name: m.roleName,
    meaning_code: m.meaningCode,
    meaning_title: m.meaningTitle,
    meaning_text: m.meaningText,
    signed_at_local: m.signedAtLocal,
    utc_offset: m.utcOffset,
    site_zone: m.siteZone,
    signed_at_utc: m.signedAtUtc,
    aggregate_type: m.record.aggregateType,
    aggregate_id: m.record.aggregateId,
    content_version: m.record.contentVersion,
    content_hash: m.record.contentHash,
    cosignature: m.cosignature,
    delegation_id: m.delegationId,
    status: stored.status,
    valid: stored.valid,
  };
}
