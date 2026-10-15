/**
 * India DSC second signature (IN-10; decision 0001 item 3; D-P6f-3, D-P6f-4; kernel 1203).
 *
 * For the signature meanings the company configures (default proposal: MBR approval and the AP's manufacturer release),
 * while the policy esig.india_dsc is TEST_CA (LICENSED stays refused until a licensed CA or eSign provider is configured
 * after the legal opinion), the password signature is accompanied by a second signature made with a Class 3 certificate
 * over the same content hash. The IT Act 2000 (section 3A with its Second Schedule, and section 5) gives legal
 * recognition to an electronic signature made with a reliable technique by a certificate from a licensed certifying
 * authority (paraphrased); the Controller of Certifying Authorities runs the root (the CCA root). In v1 the anchor is a
 * TEST CA standing for that root, shown with the banner TEST_CA_BANNER.
 *
 * The flow: the server takes the DSC statement from the database for the challenge (the challenge id, the content hash,
 * the meaning and the record); the signer's token signs the statement's UTF-8 through a local signing bridge on the
 * client; in the signing command, after esig.sign, the server verifies the chain up to the configured anchor and the
 * signature over the statement, then stores the row with esig.record_dsc_signature, which checks again what the
 * database can (the statement is the challenge's, the chain ends at the live anchor). A required DSC that is missing
 * when the command commits makes the commit fail (EBMR-ESIG-094), so nothing is signed without it.
 */
import { X509Certificate, createVerify } from 'node:crypto';
import type pg from 'pg';
import { EsigError } from './errors.ts';

type Db = Pick<pg.Pool | pg.PoolClient, 'query'>;

export type DscMode = 'OFF' | 'TEST_CA' | 'LICENSED';

export const TEST_CA_BANNER = 'Test certificate authority: not legally valid';

/** What the signer is asked for, at the challenge. */
export interface DscRequirement {
  required: boolean;
  mode: DscMode;
  /** The exact text the token signs (canonical JSON). */
  statement: string | null;
  /** Shown beside the DSC step while the anchor is a test CA. */
  banner: string | null;
}

/** The DSC the client sends with the signing request. */
export interface DscSubmission {
  /** Base64 of the RSA or ECDSA SHA-256 signature over the statement's UTF-8. */
  signature: string;
  /** Base64 DER certificates, the signer's first, then each issuer up to (and including) the root. */
  chain: string[];
}

export interface VerifiedDsc {
  leafSha256: string;
  leafSubject: string;
  leafSerial: string;
  leafValidFrom: string;
  leafValidTo: string;
  algorithm: string;
}

/** The DSC requirement of a challenge (esig.dsc_requirement). */
export async function dscRequirement(db: Db, challengeId: string): Promise<DscRequirement> {
  const { rows } = await db.query<{ r: { required: boolean; mode: DscMode; statement: string | null } }>('select esig.dsc_requirement($1) as r', [challengeId]);
  const r = rows[0]?.r ?? { required: false, mode: 'OFF' as const, statement: null };
  return { required: r.required, mode: r.mode, statement: r.required ? r.statement : null, banner: r.required && r.mode === 'TEST_CA' ? TEST_CA_BANNER : null };
}

const refuse = (why: string): never => {
  throw new EsigError('EBMR-ESIG-095', `the DSC signature does not verify: ${why}`);
};

const parse = (b64: string, what: string): X509Certificate => {
  try {
    return new X509Certificate(Buffer.from(b64, 'base64'));
  } catch {
    return refuse(`${what} is not an X.509 certificate`);
  }
};

/**
 * Verifies a DSC submission: every certificate valid at `at`, each issued and signed by the next, every issuer a CA,
 * the signer's certificate not a CA, the last one exactly the configured anchor (self-signed), and the signature over
 * the statement made with the signer's key. Throws EBMR-ESIG-095 with the reason otherwise.
 */
export function verifyDsc(statement: string, dsc: DscSubmission, anchorDer: Buffer, at: Date): VerifiedDsc {
  if (!Array.isArray(dsc.chain) || dsc.chain.length < 2 || dsc.chain.length > 6) refuse('the chain holds the signer certificate and its issuers up to the root (2 to 6 certificates)');
  const certs = dsc.chain.map((c, i) => parse(c, i === 0 ? 'the signer certificate' : `certificate ${i + 1}`));
  const leaf = certs[0] as X509Certificate;
  const root = certs[certs.length - 1] as X509Certificate;
  if (!root.raw.equals(anchorDer)) refuse('the chain does not end at the configured trust anchor');
  if (!root.verify(root.publicKey)) refuse('the trust anchor is not self-signed');
  for (const [i, c] of certs.entries()) {
    if (at.getTime() < Date.parse(c.validFrom) || at.getTime() > Date.parse(c.validTo)) refuse(`certificate ${i + 1} is not valid at the time of signing`);
    if (i > 0 && !c.ca) refuse(`certificate ${i + 1} is not a certification authority`);
    const issuer = certs[i + 1];
    if (issuer && (!c.checkIssued(issuer) || !c.verify(issuer.publicKey))) refuse(`certificate ${i + 1} is not issued by the next one (broken chain)`);
  }
  if (leaf.ca) refuse('the signer certificate is a certification authority');
  const v = createVerify('sha256');
  v.update(Buffer.from(statement, 'utf8'));
  let ok = false;
  try {
    ok = v.verify(leaf.publicKey, Buffer.from(dsc.signature, 'base64'));
  } catch {
    ok = false;
  }
  if (!ok) refuse('the signature is not over this content hash, or not made with the signer certificate');
  return {
    leafSha256: leaf.fingerprint256.replace(/:/g, '').toLowerCase(),
    leafSubject: leaf.subject.replace(/\n/g, ', '),
    leafSerial: leaf.serialNumber,
    leafValidFrom: new Date(Date.parse(leaf.validFrom)).toISOString(),
    leafValidTo: new Date(Date.parse(leaf.validTo)).toISOString(),
    algorithm: `${leaf.publicKey.asymmetricKeyType ?? 'unknown'}-sha256`,
  };
}

/**
 * In the signing command, after esig.sign: when the signature's meaning needs a DSC now, verifies the submission against
 * the live anchor at the database's time and records it (esig.record_dsc_signature). Returns false when none is needed.
 */
export async function recordDsc(client: pg.PoolClient, signatureId: string, dsc: DscSubmission | undefined): Promise<boolean> {
  const { rows } = await client.query<{ r: { required: boolean; statement: string | null; anchor: string | null; at: string } }>(
    'select esig.dsc_verification_input($1) as r',
    [signatureId],
  );
  const r = rows[0]?.r;
  if (!r?.required) return false;
  if (!dsc) throw new EsigError('EBMR-ESIG-094', 'this signature meaning needs a second signature with a Class 3 certificate (India DSC); none was given');
  if (!r.statement || !r.anchor) throw new EsigError('EBMR-ESIG-092', 'no live trust anchor is configured for the India DSC');
  const verified = verifyDsc(r.statement, dsc, Buffer.from(r.anchor, 'base64'), new Date(r.at));
  await client.query('select esig.record_dsc_signature($1, $2::jsonb)', [
    signatureId,
    JSON.stringify({ signature: dsc.signature, chain: dsc.chain, ...verified }),
  ]);
  return true;
}
