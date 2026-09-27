/**
 * Challenge, authenticate, sign (outline 5.5; ADR 0006 decision 3, ADR 0012 decision 3; DI-35..38,
 * INV-03, INV-09, INV-10).
 *
 *   const content = await contentForSigning(db, 'esig_stub', id);             // what the UI renders
 *   const ch = await createChallenge(client, { ..., clientContentHash: contentHash(content.canonical) });
 *   const ev = await authenticate(authnDb, { ..., purpose: 'SIGNATURE', challengeId: ch.challengeId });
 *   const sig = await sign(client, { challengeId: ch.challengeId, authEventId: ev.authEventId }, sealKey);
 *
 * createChallenge and sign run inside a command (withCommand); on SHARED and GRADE_A_B terminals the
 * command carries a fresh authentication event of the session owner (INV-40). sign() calls the
 * database signing function, seals the returned payload with the key provider and attaches the
 * seal in the same transaction; the database refuses to commit an unsealed signature.
 * signCommand() runs its own command and logs a refusal after the rollback.
 */
import type pg from 'pg';
import type { ActorContext } from '../db/command.ts';
import { withGuardedCommand } from '../identity/authority.ts';
import { ebmrCode, errorDetail, EsigError } from './errors.ts';
import { sealMessage, type SealAlgorithm, type SealKeyProvider } from './keys.ts';
import { toManifestation, type Manifestation, type SignatureStatus } from './manifestation.ts';

type Db = pg.Pool | pg.PoolClient;

export interface ContentForSigning {
  exists: boolean;
  aggregateType: string;
  aggregateId: string;
  contentVersion?: string;
  state?: string | null;
  /** The canonical text to render and hash. */
  canonical?: string;
  contentHash?: string;
}

/** The server's canonical content of a record: the UI renders it and hashes exactly this text. */
export async function contentForSigning(db: Db, aggregateType: string, aggregateId: string): Promise<ContentForSigning> {
  const { rows } = await db.query<{ r: Record<string, unknown> }>('select esig.content_for_signing($1, $2) as r', [aggregateType, aggregateId]);
  const r = rows[0]?.r ?? {};
  const out: ContentForSigning = { exists: r['exists'] === true, aggregateType, aggregateId };
  if (out.exists) {
    out.contentVersion = String(r['content_version']);
    out.state = typeof r['state'] === 'string' ? r['state'] : null;
    out.canonical = String(r['canonical']);
    out.contentHash = String(r['content_hash']);
  }
  return out;
}

export interface ChallengeRequest {
  aggregateType: string;
  aggregateId: string;
  /** The content version the signer reviewed (decimal string). */
  contentVersion: string;
  /** Catalogue code of the signature meaning. */
  meaning: string;
  /** SHA-256 (hex) of the canonical content the client displayed. */
  clientContentHash: string;
  /** Another person's account signing at this session's terminal (co-signature); default: the session owner. */
  signerAccountId?: string;
}

export interface Challenge {
  challengeId: string;
  expiresAt: string;
  contentHash: string;
  contentVersion: string;
  canonicalContent: string;
  meaning: { code: string; version: number; title: string; text: string };
  cosignature: boolean;
  /** ALL: every component; PRIVATE: at least the password or PIN (DI-38 relaxation). */
  requiredComponents: 'ALL' | 'PRIVATE';
  requiredComponentsReason: string;
  manifestationPreview: Record<string, unknown>;
}

export async function createChallenge(client: pg.PoolClient, req: ChallengeRequest): Promise<Challenge> {
  const { rows } = await client.query<{ r: Record<string, unknown> }>('select esig.create_challenge($1, $2, $3::bigint, $4, $5, $6) as r', [
    req.aggregateType,
    req.aggregateId,
    req.contentVersion,
    req.meaning,
    req.clientContentHash,
    req.signerAccountId ?? null,
  ]);
  const r = rows[0]?.r;
  if (!r) throw new EsigError('EBMR-ESIG-031', 'no challenge was returned');
  const meaning = r['meaning'] as Challenge['meaning'];
  return {
    challengeId: String(r['challenge_id']),
    expiresAt: String(r['expires_at']),
    contentHash: String(r['content_hash']),
    contentVersion: String(r['content_version']),
    canonicalContent: String(r['canonical_content']),
    meaning,
    cosignature: r['cosignature'] === true,
    requiredComponents: r['required_components'] === 'PRIVATE' ? 'PRIVATE' : 'ALL',
    requiredComponentsReason: String(r['required_components_reason']),
    manifestationPreview: (r['manifestation_preview'] ?? {}) as Record<string, unknown>,
  };
}

export interface SignRequest {
  challengeId: string;
  /** The signer's authentication event, made for this challenge (purpose SIGNATURE). */
  authEventId: string;
  /** The record state the caller saw; must equal the provider's state (null when the record has none). */
  expectedState?: string | null;
  /** A cited delegation, for delegable meanings (outline 7.1). */
  delegationId?: string;
  /** WITNESSED: whether the next step has already started (then witnessing is refused). */
  nextStepStarted?: boolean;
}

export interface SignatureResult {
  signatureId: string;
  recordedAt: string;
  manifestation: Manifestation;
  manifestationText: string;
  componentsRequired: 'ALL' | 'PRIVATE';
  componentsReason: string;
  cosignature: boolean;
  authorityEvaluationId: string;
  sealKeyId: string;
  sealAlgorithm: SealAlgorithm;
}

/** Inside a command: sign, seal and attach the seal (one transaction with the caller's work). */
export async function sign(client: pg.PoolClient, req: SignRequest, key: SealKeyProvider): Promise<SignatureResult> {
  const { rows } = await client.query<{ r: Record<string, unknown> }>('select esig.sign($1, $2, $3, $4, $5) as r', [
    req.challengeId,
    req.authEventId,
    req.expectedState ?? null,
    req.delegationId ?? null,
    req.nextStepStarted ?? false,
  ]);
  const r = rows[0]?.r;
  if (!r) throw new EsigError('EBMR-ESIG-030', 'no signature was returned');
  const signatureId = String(r['signature_id']);
  const seal = await key.seal(sealMessage(key.keyId, key.algorithm, String(r['seal_payload'])));
  await client.query('select esig.seal_signature($1, $2, $3, $4)', [signatureId, key.keyId, key.algorithm, Buffer.from(seal).toString('base64')]);
  return {
    signatureId,
    recordedAt: String(r['recorded_at']),
    manifestation: toManifestation((r['manifestation'] ?? {}) as Record<string, unknown>),
    manifestationText: String(r['manifestation_text']),
    componentsRequired: r['components_required'] === 'PRIVATE' ? 'PRIVATE' : 'ALL',
    componentsReason: String(r['components_reason']),
    cosignature: r['cosignature'] === true,
    authorityEvaluationId: String(r['authority_evaluation_id']),
    sealKeyId: key.keyId,
    sealAlgorithm: key.algorithm,
  };
}

/**
 * Logs a refused signing after its command rolled back: the failure itself (esig.signing_failure,
 * with a security alert for misuse patterns) and, for authority and independence refusals, the
 * stored evaluation that the rollback removed (INV-26, DI-17: a failed check is logged).
 */
export async function logSigningFailure(pool: pg.Pool, challengeId: string, error: unknown): Promise<void> {
  const code = ebmrCode(error) ?? 'UNKNOWN';
  const message = error instanceof Error ? error.message : String(error);
  try {
    await pool.query('select esig.record_signing_failure($1, $2, $3)', [challengeId, code, message]);
    const d = errorDetail(error);
    if (!d) return;
    if (code === 'EBMR-ESIG-040') {
      const perms = Array.isArray(d['permissions']) ? (d['permissions'] as string[]) : [];
      for (const p of perms) {
        await pool.query('select iam.evaluate_authority($1, $2, $3, $4::jsonb, null, $5)', [
          d['person_id'],
          d['account_id'],
          p,
          JSON.stringify(d['scope'] ?? {}),
          d['role_code'] ?? null,
        ]);
      }
    } else if (code === 'EBMR-ESIG-043' || code === 'EBMR-ESIG-044' || code === 'EBMR-ESIG-045') {
      await pool.query('select iam.evaluate_segregation($1, $2, $3::uuid[], $4)', [d['rule'], d['person_id'], d['excluded'], d['subject'] ?? null]);
    }
  } catch {
    // Logging never hides the original refusal.
  }
}

/** sign() in its own command; a refusal is logged after the rollback and then rethrown. */
export async function signCommand(pool: pg.Pool, ctx: ActorContext, req: SignRequest, key: SealKeyProvider): Promise<SignatureResult> {
  try {
    return await withGuardedCommand(pool, ctx, (client) => sign(client, req, key));
  } catch (error) {
    await logSigningFailure(pool, req.challengeId, error);
    throw error;
  }
}

export interface SignatureState {
  signatureId: string;
  exists: boolean;
  valid: boolean;
  status: SignatureStatus;
  aggregateType?: string;
  aggregateId?: string;
  meaningCode?: string;
  signerPerson?: string;
  invalidation?: Record<string, unknown> | null;
}

export async function signatureState(db: Db, signatureId: string): Promise<SignatureState> {
  const { rows } = await db.query<{ r: Record<string, unknown> }>('select esig.signature_state($1) as r', [signatureId]);
  const r = rows[0]?.r ?? {};
  const state: SignatureState = {
    signatureId,
    exists: r['exists'] === true,
    valid: r['valid'] === true,
    status: (r['status'] as SignatureStatus | undefined) ?? 'UNKNOWN',
  };
  if (state.exists) {
    state.aggregateType = String(r['aggregate_type']);
    state.aggregateId = String(r['aggregate_id']);
    state.meaningCode = String(r['meaning_code']);
    state.signerPerson = String(r['signer_person']);
    state.invalidation = (r['invalidation'] ?? null) as Record<string, unknown> | null;
  }
  return state;
}

/** Raises EBMR-ESIG-070 unless the signature is valid, has the meaning and belongs to the record. */
export async function assertSignature(db: Db, signatureId: string, meaning: string, aggregateType: string, aggregateId: string): Promise<void> {
  await db.query('select esig.assert_signature($1, $2, $3, $4)', [signatureId, meaning, aggregateType, aggregateId]);
}

export interface RecordSignature {
  signatureId: string;
  meaningCode: string;
  signerPerson: string;
  printedName: string;
  status: SignatureStatus;
  valid: boolean;
  manifestationText: string;
}

/** Every signature of a record with its current status (a superseded one shows the element unsigned). */
export async function recordSignatures(db: Db, aggregateType: string, aggregateId: string): Promise<RecordSignature[]> {
  const { rows } = await db.query<{
    signature_id: string; meaning_code: string; signer_person: string; printed_name: string; status: SignatureStatus; valid: boolean; manifestation_text: string;
  }>('select * from esig.record_signatures($1, $2)', [aggregateType, aggregateId]);
  return rows.map((r) => ({
    signatureId: r.signature_id, meaningCode: r.meaning_code, signerPerson: r.signer_person, printedName: r.printed_name, status: r.status, valid: r.valid,
    manifestationText: r.manifestation_text,
  }));
}

/** Meanings whose signature was superseded by a change and must be signed again. */
export async function resigningRequired(db: Db, aggregateType: string, aggregateId: string): Promise<{ meaningCode: string; supersededSignatureId: string; previousSigner: string }[]> {
  const { rows } = await db.query<{ meaning_code: string; superseded_signature_id: string; previous_signer: string }>(
    'select * from esig.resigning_required($1, $2)',
    [aggregateType, aggregateId],
  );
  return rows.map((r) => ({ meaningCode: r.meaning_code, supersededSignatureId: r.superseded_signature_id, previousSigner: r.previous_signer }));
}
