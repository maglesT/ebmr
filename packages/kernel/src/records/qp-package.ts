/**
 * The EU QP batch package (Phase 4 slice 4b; outline 4.6 "EU importer / QP", 5.2.6; DI-41; kernel 1160).
 *
 * A package is a signed true-copy bundle of one lot for the importer's QP: true-copy bundles (true-copy.ts) of the
 * lot's chains, at least the processing and packaging records, and documents the edition writes (the audit-trail
 * review, the list of post-entry changes, the deviations with their per-market assessments, the manufacturer release
 * and its checklist, the CoA). The package manifest lists every section with its SHA-256 (and, for a true copy, its
 * chain and bundle manifest SHA-256); the package SHA-256 is the SHA-256 of the manifest text.
 *
 * The server computes the package SHA-256 here; records.register_qp_package computes it again, checks every section
 * against the manifest and every true copy against the true-copy register, and stores both. QA then signs the package
 * (TRUE_COPY_VERIFIED on qp_package <id>) and records.issue_qp_package issues it. The QP reads an issued package through
 * a read-only, time-boxed access to one lot (records.grant_qp_access, records.read_qp_package).
 *
 * verifyQpPackageText needs no database: it checks the canonical bytes, the manifest hash, every section hash, every
 * bundle with the true-copy verifier against the manifest SHA-256 the package names, and the required sections. Given
 * the package SHA-256 held outside the package (the register, the signed content), it proves the package is that one.
 */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { verifyTrueCopyBundleText, serializeBundle, type Manifest as BundleManifest, type TrueCopyBundle } from './true-copy.ts';

export const QP_PACKAGE_FORMAT = 'ebmr.qp-batch-package/1';
export const QP_PACKAGE_KIND = 'EU_QP_BATCH_PACKAGE';

export const QP_SECTION_ROLES = ['PROCESSING_RECORD', 'PACKAGING_RECORD', 'AUDIT_TRAIL_REVIEW', 'POST_ENTRY_CHANGES', 'DEVIATIONS', 'RELEASE', 'COA', 'OTHER'] as const;
export type QpSectionRole = (typeof QP_SECTION_ROLES)[number];
/** Every package holds these; the processing and packaging records as true copies (kernel 1160, EBMR-REC-083). */
export const QP_REQUIRED_ROLES: readonly QpSectionRole[] = ['PROCESSING_RECORD', 'PACKAGING_RECORD', 'AUDIT_TRAIL_REVIEW', 'POST_ENTRY_CHANGES', 'DEVIATIONS', 'RELEASE', 'COA'];
const TRUE_COPY_ROLES: readonly QpSectionRole[] = ['PROCESSING_RECORD', 'PACKAGING_RECORD'];
const NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/;

export interface QpSubject {
  /** The aggregate type of the subject (the Tablets edition: material_lot). */
  type: string;
  id: string;
  /** What the QP reads (lot number, product). */
  label: string;
}

export interface QpTrueCopySection {
  name: string;
  role: QpSectionRole;
  kind: 'TRUE_COPY';
  title: string;
  chainKey: string;
  manifestSha256: string;
  sha256: string;
  bytes: number;
}

export interface QpDocumentSection {
  name: string;
  role: QpSectionRole;
  kind: 'DOCUMENT';
  title: string;
  mediaType: string;
  sha256: string;
  bytes: number;
}

export type QpSection = QpTrueCopySection | QpDocumentSection;

export interface QpManifest {
  format: string;
  kind: string;
  subject: QpSubject;
  generatedAt: string;
  sections: QpSection[];
  hashAlgorithm: 'SHA-256';
  note: string;
}

export interface QpPackage {
  format: string;
  /** SHA-256 of `manifest` (the text, UTF-8). */
  packageSha256: string;
  manifest: string;
  /** Section name -> the serialised true-copy bundle (serializeBundle). */
  bundles: Record<string, string>;
  /** Section name -> the document text. */
  documents: Record<string, string>;
}

export interface QpBundleInput {
  name: string;
  role: QpSectionRole;
  title: string;
  bundle: TrueCopyBundle;
}

export interface QpDocumentInput {
  name: string;
  role: QpSectionRole;
  title: string;
  mediaType: 'application/json' | 'text/plain';
  text: string;
}

export interface QpVerificationReport {
  ok: boolean;
  problems: string[];
  packageSha256: string | null;
  sections: number;
  /** MATCHED: equal to the expected package SHA-256; NONE: none given (the package only agrees with itself). */
  reference: 'MATCHED' | 'MISMATCHED' | 'NONE';
}

const sha256Hex = (data: string): string => createHash('sha256').update(data, 'utf8').digest('hex');
const utf8Bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

/**
 * Assembles the package from bundles and documents. `generatedAt` comes from the database clock (the caller reads it),
 * never from the process clock. Throws on a duplicate or malformed section name, an unknown role, a missing required
 * role, or a processing or packaging record that is not a true copy.
 */
export function assembleQpPackage(input: { subject: QpSubject; generatedAt: string; bundles: QpBundleInput[]; documents: QpDocumentInput[] }): QpPackage {
  const sections: QpSection[] = [];
  const bundles: Record<string, string> = {};
  const documents: Record<string, string> = {};
  const seen = new Set<string>();
  const claim = (name: string, role: QpSectionRole): void => {
    if (!NAME.test(name)) throw new Error(`EBMR-REC-081 section name ${name} is not a package section name`);
    if (seen.has(name)) throw new Error(`EBMR-REC-081 section ${name} appears twice`);
    if (!QP_SECTION_ROLES.includes(role)) throw new Error(`EBMR-REC-081 ${String(role)} is no section role`);
    seen.add(name);
  };
  for (const b of input.bundles) {
    claim(b.name, b.role);
    const text = serializeBundle(b.bundle);
    const manifest = JSON.parse(b.bundle.manifest) as BundleManifest;
    bundles[b.name] = text;
    sections.push({ name: b.name, role: b.role, kind: 'TRUE_COPY', title: b.title, chainKey: manifest.chainKey, manifestSha256: b.bundle.manifestSha256, sha256: sha256Hex(text), bytes: utf8Bytes(text) });
  }
  for (const d of input.documents) {
    claim(d.name, d.role);
    if (TRUE_COPY_ROLES.includes(d.role)) throw new Error(`EBMR-REC-083 the ${d.role} section is a true-copy bundle, not a document`);
    documents[d.name] = d.text;
    sections.push({ name: d.name, role: d.role, kind: 'DOCUMENT', title: d.title, mediaType: d.mediaType, sha256: sha256Hex(d.text), bytes: utf8Bytes(d.text) });
  }
  for (const role of QP_REQUIRED_ROLES) {
    if (!sections.some((s) => s.role === role)) throw new Error(`EBMR-REC-083 the EU QP batch package has no ${role} section`);
  }
  const manifest: QpManifest = {
    format: QP_PACKAGE_FORMAT,
    kind: QP_PACKAGE_KIND,
    subject: input.subject,
    generatedAt: input.generatedAt,
    sections,
    hashAlgorithm: 'SHA-256',
    note: 'Package SHA-256 = SHA-256 of this manifest text (UTF-8). Each true copy verifies offline with the true-copy verifier against the manifest SHA-256 named here.',
  };
  const manifestText = JSON.stringify(manifest, null, 2);
  return { format: QP_PACKAGE_FORMAT, packageSha256: sha256Hex(manifestText), manifest: manifestText, bundles, documents };
}

/** The package file: one canonical JSON document and a final newline. */
export function serializeQpPackage(p: QpPackage): string {
  const bundles: Record<string, string> = {};
  for (const k of Object.keys(p.bundles)) bundles[k] = p.bundles[k] as string;
  const documents: Record<string, string> = {};
  for (const k of Object.keys(p.documents)) documents[k] = p.documents[k] as string;
  return `${JSON.stringify({ format: p.format, packageSha256: p.packageSha256, manifest: p.manifest, bundles, documents })}\n`;
}

function isRecordOfStrings(v: unknown): v is Record<string, string> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string');
}

/** Verifies a package file without any database (see the module comment). */
export function verifyQpPackageText(text: string, expected?: { packageSha256?: string }): QpVerificationReport {
  const problems: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, problems: ['the package is not JSON'], packageSha256: null, sections: 0, reference: 'NONE' };
  }
  const p = parsed as Partial<QpPackage>;
  if (typeof p !== 'object' || p === null || p.format !== QP_PACKAGE_FORMAT || typeof p.manifest !== 'string' || typeof p.packageSha256 !== 'string'
      || !isRecordOfStrings(p.bundles) || !isRecordOfStrings(p.documents)) {
    return { ok: false, problems: [`the file is no ${QP_PACKAGE_FORMAT} package`], packageSha256: null, sections: 0, reference: 'NONE' };
  }
  const pkg = p as QpPackage;
  if (serializeQpPackage(pkg) !== text) problems.push('the file is not the canonical serialisation of its content (bytes altered)');
  if (sha256Hex(pkg.manifest) !== pkg.packageSha256) problems.push('the package SHA-256 does not match the manifest');
  let manifest: QpManifest | null = null;
  try {
    manifest = JSON.parse(pkg.manifest) as QpManifest;
  } catch {
    problems.push('the manifest is not JSON');
  }
  const sections = manifest?.sections ?? [];
  if (manifest) {
    if (manifest.format !== QP_PACKAGE_FORMAT || manifest.kind !== QP_PACKAGE_KIND) problems.push('the manifest is no EU QP batch package manifest');
    const listed = new Set<string>();
    for (const s of sections) {
      if (listed.has(s.name)) problems.push(`section ${s.name} is listed twice`);
      listed.add(s.name);
      const body = s.kind === 'TRUE_COPY' ? pkg.bundles[s.name] : pkg.documents[s.name];
      if (body === undefined) {
        problems.push(`section ${s.name} is missing`);
        continue;
      }
      if (sha256Hex(body) !== s.sha256) problems.push(`section ${s.name} does not match its SHA-256`);
      if (s.kind === 'TRUE_COPY') {
        const r = verifyTrueCopyBundleText(body, { manifestSha256: s.manifestSha256 });
        if (!r.ok) problems.push(`section ${s.name}: ${r.problems.join('; ')}`);
        if (r.summary.reference !== 'MATCHED') problems.push(`section ${s.name} is not the true copy the manifest names`);
        if (r.summary.chainKey !== s.chainKey) problems.push(`section ${s.name} is a copy of ${String(r.summary.chainKey)}, not of ${s.chainKey}`);
      }
    }
    for (const k of Object.keys(pkg.bundles)) if (!sections.some((s) => s.kind === 'TRUE_COPY' && s.name === k)) problems.push(`bundle ${k} is not in the manifest`);
    for (const k of Object.keys(pkg.documents)) if (!sections.some((s) => s.kind === 'DOCUMENT' && s.name === k)) problems.push(`document ${k} is not in the manifest`);
    for (const role of QP_REQUIRED_ROLES) if (!sections.some((s) => s.role === role)) problems.push(`no ${role} section`);
    for (const role of TRUE_COPY_ROLES) if (sections.some((s) => s.role === role && s.kind !== 'TRUE_COPY')) problems.push(`the ${role} section is not a true copy`);
  }
  const reference = expected?.packageSha256 === undefined ? 'NONE' : expected.packageSha256 === pkg.packageSha256 ? 'MATCHED' : 'MISMATCHED';
  if (reference === 'MISMATCHED') problems.push('the package is not the one expected (package SHA-256 differs)');
  return { ok: problems.length === 0, problems, packageSha256: pkg.packageSha256, sections: sections.length, reference };
}

// ---------------------------------------------------------------------------------------------
// Database (call inside withCommand)
// ---------------------------------------------------------------------------------------------

/** Registers the package (records.register_qp_package): the database recomputes the hash and checks every section. */
export async function registerQpPackage(db: pg.Pool | pg.PoolClient, pkg: QpPackage): Promise<string> {
  const manifest = JSON.parse(pkg.manifest) as QpManifest;
  const { rows } = await db.query<{ id: string }>('select records.register_qp_package($1, $2, $3, $4, $5) as id', [
    manifest.subject.type,
    manifest.subject.id,
    pkg.manifest,
    pkg.packageSha256,
    serializeQpPackage(pkg),
  ]);
  return rows[0]?.id ?? '';
}

export async function issueQpPackage(db: pg.Pool | pg.PoolClient, packageId: string, signatureId: string): Promise<void> {
  await db.query('select records.issue_qp_package($1, $2)', [packageId, signatureId]);
}

export async function grantQpAccess(db: pg.Pool | pg.PoolClient, input: { packageId: string; accountId: string; validTo: string; reason: string }): Promise<string> {
  const { rows } = await db.query<{ id: string }>('select records.grant_qp_access($1, $2, $3::timestamptz, $4) as id', [input.packageId, input.accountId, input.validTo, input.reason]);
  return rows[0]?.id ?? '';
}

export async function revokeQpAccess(db: pg.Pool | pg.PoolClient, accessId: string, reason: string): Promise<void> {
  await db.query('select records.revoke_qp_access($1, $2)', [accessId, reason]);
}

export interface QpReaderPackage {
  packageId: string;
  subjectType: string;
  subjectId: string;
  subjectLabel: string;
  packageSha256: string;
  contentBytes: number;
  issuedAt: string;
  accessId: string;
  accessValidTo: string;
}

export async function qpReaderPackages(db: pg.Pool | pg.PoolClient): Promise<QpReaderPackage[]> {
  const { rows } = await db.query<{ r: QpReaderPackage[] }>('select records.qp_reader_packages() as r');
  return rows[0]?.r ?? [];
}

export async function readQpPackage(db: pg.Pool | pg.PoolClient, packageId: string): Promise<{ packageId: string; packageSha256: string; contentSha256: string; content: string }> {
  const { rows } = await db.query<{ r: { packageId: string; packageSha256: string; contentSha256: string; content: string } }>('select records.read_qp_package($1) as r', [packageId]);
  const r = rows[0]?.r;
  if (!r) throw new Error('EBMR-REC-090 no package');
  return r;
}
