/**
 * Wire views of the e-signature ceremony (module C1; plan section 6; DI-35, DI-36).
 *
 * A manifestation is rendered only from the copy stored with the signature (kernel esig.signature.manifestation):
 * the printed name, user ID and role as at signing, the meaning, and the date and time with the UTC offset and
 * site zone that the database applied. Renaming a person later never changes a historic manifestation.
 */
import type pg from 'pg';
import { esig } from '@ebmr/kernel';
import type { Instant, ManifestationView } from '@ebmr/api-contract';
import { refusal } from '../../platform/http/refusal.ts';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** UTC epoch microseconds of the kernel's ISO text 'YYYY-MM-DDTHH:MM:SS[.ffffff]Z' (exact, no float rounding). */
export function isoUtcToMicros(text: string): bigint {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/.exec(text);
  if (!m) throw new Error(`not a UTC instant: ${text}`);
  const [, y, mo, d, h, mi, s, frac] = m;
  const seconds = BigInt(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))) / 1000n;
  return seconds * 1_000_000n + BigInt((frac ?? '').padEnd(6, '0'));
}

/**
 * The Instant of a stored manifestation: microseconds from the stored UTC time; the text from the stored site-local
 * time, offset and zone (e.g. "28-SEP-2026 14:05:03 +05:30 (Asia/Kolkata)"), never re-derived.
 */
export function storedInstant(signedAtUtc: string, signedAtLocal: string, utcOffset: string, zone: string): Instant {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(signedAtLocal);
  const text = m ? `${m[3]}-${MONTHS[Number(m[2]) - 1] ?? '???'}-${m[1]} ${m[4]} ${utcOffset} (${zone})` : `${signedAtLocal} ${utcOffset} (${zone})`;
  return { us: isoUtcToMicros(signedAtUtc).toString(), text };
}

/** "Performed by", "Verified by": the short phrase a manifestation shows beside the name. */
export const meaningPhrase = (title: string): string => `${title} by`;

/** ManifestationView from the stored manifestation (DI-36). */
export function manifestationView(m: esig.Manifestation, signerPersonId: string, valid: boolean): ManifestationView {
  return {
    signatureId: m.signatureId,
    signer: { personId: signerPersonId, legalName: m.printedName, loginName: m.userId, role: m.roleCode },
    meaning: m.meaningCode,
    meaningText: meaningPhrase(m.meaningTitle),
    signedAt: storedInstant(m.signedAtUtc, m.signedAtLocal, m.utcOffset, m.siteZone),
    zone: m.siteZone,
    valid,
    aggregateType: m.record.aggregateType,
    aggregateId: m.record.aggregateId,
    contentVersion: m.record.contentVersion,
    contentHash: m.record.contentHash,
  };
}

interface SignatureRow {
  signature_id: string;
  signer_person: string;
  manifestation: Record<string, unknown>;
  valid: boolean;
}

const viewsOf = (rows: SignatureRow[]): ManifestationView[] => rows.map((r) => manifestationView(esig.toManifestation(r.manifestation), r.signer_person, r.valid));

/**
 * The signatures of a record for the session bound to `tokenHash` (GET /api/esig/signatures): the database serves them
 * only when the session's role may read the record (tablets 0410, review F34; EBMR-TAB-018, EBMR-TAB-020).
 */
export async function recordSignaturesFor(db: pg.Pool | pg.PoolClient, tokenHash: string, aggregateType: string, aggregateId: string): Promise<ManifestationView[]> {
  const { rows } = await db.query<SignatureRow>('select * from tab.record_signatures($1, $2, $3)', [tokenHash, aggregateType, aggregateId]);
  return viewsOf(rows);
}

/**
 * The signatures of a RECORD-class record shown beside it (a run's steps and stages) or checked by a handler; the
 * database never serves a GOVERNANCE-class record's this way (tablets 0410, EBMR-TAB-020).
 */
export async function signaturesOf(db: pg.Pool | pg.PoolClient, aggregateType: string, aggregateId: string): Promise<ManifestationView[]> {
  const { rows } = await db.query<SignatureRow>('select * from tab.signatures_of($1, $2)', [aggregateType, aggregateId]);
  return viewsOf(rows);
}

export interface MeaningInfo {
  code: string;
  title: string;
  text: string;
}

/** The current, active catalogue entry of a meaning (DI-35: only catalogue types are signed). */
/** Phase B slice 2: the permissions any one of which signs this meaning (its latest version; esig.sign evaluates them). */
export async function meaningPermissions(db: pg.Pool | pg.PoolClient, code: string): Promise<string[]> {
  const { rows } = await db.query<{ permissions: string[] }>('select permissions from esig.meaning_type where code = $1 order by version desc limit 1', [code]);
  return rows[0]?.permissions ?? [];
}

export async function meaningInfo(db: pg.Pool | pg.PoolClient, code: string): Promise<MeaningInfo> {
  const { rows } = await db.query<{ code: string; title: string; meaning_text: string; status: string }>(
    'select code, title, meaning_text, status from esig.meaning_type where code = $1 order by version desc limit 1',
    [code],
  );
  const r = rows[0];
  if (!r || r.status !== 'ACTIVE') {
    throw refusal(422, {
      code: 'EBMR-ESIG-026',
      kind: 'NOT_ALLOWED',
      whatHappened: 'This is not a signature meaning of the catalogue.',
      why: `${code} is ${r ? 'retired' : 'not a signature type of the catalogue'}; only catalogue types can be signed.`,
      controls: ['DI-35'],
      whatYouCanDo: ['Reload the screen; if it happens again, report it.'],
      whoCanHelp: ['QA (signature catalogue)'],
    });
  }
  return { code: r.code, title: r.title, text: r.meaning_text };
}

/**
 * The challenge as the database stored it, for the session that made it (tablets 0610, HIGH-WATER: the application role
 * selects no row of esig.challenge; tab.session_challenge answers only for the active session bound to `tokenHash`).
 */
export interface StoredChallenge {
  challengeId: string;
  aggregateType: string;
  aggregateId: string;
  contentVersion: string;
  contentHash: string;
  meaning: string;
  signerPerson: string;
  signerAccount: string;
  sessionId: string;
  deviceId: string;
  expiresUs: string;
  /** Whole seconds until expiry at the database clock (0 when expired). */
  secondsLeft: number;
}

export async function readChallenge(db: pg.Pool | pg.PoolClient, tokenHash: string, challengeId: string): Promise<StoredChallenge | null> {
  const { rows } = await db.query<{
    id: string; aggregate_type: string; aggregate_id: string; content_version: string; content_hash: string; meaning_code: string;
    signer_person: string; signer_account: string; session_id: string; device_id: string; expires_us: string; seconds_left: number;
  }>(
    `select challenge_id as id, aggregate_type, aggregate_id, content_version::text as content_version, content_hash, meaning_code, signer_person,
            signer_account, session_id, device_id, (extract(epoch from expires_at) * 1000000)::bigint::text as expires_us,
            greatest(0, ceil(extract(epoch from expires_at - clock_timestamp())))::int as seconds_left
       from tab.session_challenge($1, $2)`,
    [tokenHash, challengeId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    challengeId: r.id, aggregateType: r.aggregate_type, aggregateId: r.aggregate_id, contentVersion: r.content_version, contentHash: r.content_hash,
    meaning: r.meaning_code, signerPerson: r.signer_person, signerAccount: r.signer_account, sessionId: r.session_id, deviceId: r.device_id,
    expiresUs: r.expires_us, secondsLeft: Number(r.seconds_left),
  };
}
