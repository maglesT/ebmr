/**
 * Signature integrity job and non-repudiation evidence (ADR 0012 decisions 3 and 8: a transplanted
 * or forged signature is detected; DI-37, DI-13).
 *
 * verifySignatures combines what the database can re-derive (esig.verify_signatures: seal payload
 * digest, manifestation, challenge, authentication event, authority evaluation, audit event,
 * register entry, current content hash) with the cryptographic check of every seal against the
 * trusted key ring. Production runs it on a schedule; any problem is a data-integrity incident.
 */
import type pg from 'pg';
import { EsigError } from './errors.ts';
import { sealMessage, type SealAlgorithm, type SealCheck, type SealKeyRing } from './keys.ts';

type Db = pg.Pool | pg.PoolClient;

export interface SignatureProblem {
  /** NULL for a problem of the mechanism itself (for example a missing invalidation trigger). */
  signatureId: string | null;
  problem: string;
}

export interface SealVerification {
  signatureId: string;
  keyId: string;
  algorithm: SealAlgorithm;
  result: SealCheck;
}

async function verifySeals(db: Db, keyRing: SealKeyRing, where: string, params: unknown[]): Promise<SealVerification[]> {
  const { rows } = await db.query<{ signature_id: string; key_id: string; algorithm: SealAlgorithm; seal: string; payload: string | null }>(
    `select x.signature_id, x.key_id, x.algorithm, x.seal, esig.seal_payload(x.signature_id) as payload
       from esig.signature_seal x join esig.signature g on g.id = x.signature_id ${where} order by g.recorded_at, g.id`,
    params,
  );
  const out: SealVerification[] = [];
  for (const r of rows) {
    const result = r.payload === null ? 'INVALID' : await keyRing.verify(r.key_id, r.algorithm, sealMessage(r.key_id, r.algorithm, r.payload), Buffer.from(r.seal, 'base64'));
    out.push({ signatureId: r.signature_id, keyId: r.key_id, algorithm: r.algorithm, result });
  }
  return out;
}

/** Every integrity problem of every signature (optionally only those signed since an ISO instant). */
export async function verifySignatures(db: Db, keyRing: SealKeyRing, opts: { since?: string } = {}): Promise<SignatureProblem[]> {
  const since = opts.since ?? null;
  const { rows } = await db.query<{ signature_id: string | null; problem: string }>('select signature_id, problem from esig.verify_signatures($1::timestamptz)', [since]);
  const problems: SignatureProblem[] = rows.map((r) => ({ signatureId: r.signature_id, problem: r.problem }));
  const seals = await verifySeals(db, keyRing, 'where $1::timestamptz is null or g.recorded_at >= $1::timestamptz', [since]);
  for (const s of seals) {
    if (s.result === 'INVALID') problems.push({ signatureId: s.signatureId, problem: `SEAL_INVALID: the ${s.algorithm} seal (key ${s.keyId}) does not verify` });
    if (s.result === 'UNKNOWN_KEY') problems.push({ signatureId: s.signatureId, problem: `SEAL_KEY_UNTRUSTED: key ${s.keyId} (${s.algorithm}) is not in the trusted key ring` });
  }
  return problems;
}

/** The cryptographic check of one signature's seal (null when it has none). */
export async function verifySeal(db: Db, keyRing: SealKeyRing, signatureId: string): Promise<SealVerification | null> {
  const [v] = await verifySeals(db, keyRing, 'where x.signature_id = $1', [signatureId]);
  return v ?? null;
}

export interface EvidencePackage {
  /** The database's package: signature row, manifestation, challenge, authentication event (no secrets), identity verification, authority and segregation evaluations, invalidation, seal, audit chains. */
  package: Record<string, unknown>;
  sealVerification: SealVerification | null;
  /** Integrity problems from the database plus a failed seal check; empty when the evidence holds. */
  problems: string[];
}

/** DI-13: the non-repudiation evidence package of one signature, with the seal verified. */
export async function evidencePackage(db: Db, signatureId: string, keyRing: SealKeyRing): Promise<EvidencePackage> {
  const { rows } = await db.query<{ p: Record<string, unknown> }>('select esig.evidence_package($1) as p', [signatureId]);
  const pkg = rows[0]?.p;
  if (!pkg) throw new EsigError('EBMR-ESIG-070', `signature ${signatureId} does not exist`);
  const sealVerification = await verifySeal(db, keyRing, signatureId);
  const problems = [...((pkg['integrity_problems'] as string[] | undefined) ?? [])];
  if (!sealVerification) problems.push('SEAL_MISSING');
  else if (sealVerification.result !== 'VALID') problems.push(`SEAL_${sealVerification.result}`);
  return { package: pkg, sealVerification, problems };
}
