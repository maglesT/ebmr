/**
 * Certified evidence export of a record (Phase 4 slice 6b; IN-11, DI-40, DI-41; kernel 1171).
 *
 * One file holds, for one subject (a batch): the true-copy bundles of its chains (the batch record, its review and its
 * contingency forms), the PDF/A-3 rendering of the main record (pdf-true-copy.ts, base64) and documents, with a manifest
 * listing every section, its kind, encoding and the SHA-256 of its bytes. Export SHA-256 = SHA-256 of the manifest text.
 *
 * verifyEvidenceExportText checks a file without any database, through the kernel verifier: the file is its own canonical
 * serialisation (a change to any single byte is reported), every section matches its SHA-256, every true copy verifies
 * (verifyTrueCopyBundleText against the manifest SHA-256 named), every PDF verifies (verifyTrueCopyPdf) and renders a
 * copied bundle, and, when given, the export SHA-256 is the one expected (held outside the file: the register, the
 * certification signature).
 */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { verifyTrueCopyPdf } from './pdf-true-copy.ts';
import { serializeBundle, verifyTrueCopyBundleText, type Manifest as BundleManifest, type TrueCopyBundle } from './true-copy.ts';

export const EVIDENCE_EXPORT_FORMAT = 'ebmr.evidence-export/1';
export const EVIDENCE_EXPORT_KIND = 'RECORD_EVIDENCE_EXPORT';
const NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/;

export interface EvidenceSubject {
  type: string;
  id: string;
  label: string;
}

export interface EvidenceSection {
  name: string;
  kind: 'TRUE_COPY' | 'PDF_TRUE_COPY' | 'DOCUMENT';
  title: string;
  mediaType: string;
  encoding: 'utf-8' | 'base64';
  chainKey: string | null;
  /** SHA-256 of the section's bytes (base64 decoded first). */
  sha256: string;
  bytes: number;
  manifestSha256?: string;
  contentSha256?: string;
}

export interface EvidenceManifest {
  format: string;
  kind: string;
  subject: EvidenceSubject;
  generatedAt: string;
  sections: EvidenceSection[];
  hashAlgorithm: 'SHA-256';
  note: string;
}

export interface EvidenceExport {
  format: string;
  exportSha256: string;
  manifest: string;
  /** Section name -> text (base64 for the PDF). */
  sections: Record<string, string>;
}

export interface EvidenceExportInput {
  subject: EvidenceSubject;
  /** From the database clock (the caller reads it), never the process clock. */
  generatedAt: string;
  bundles: { name: string; title: string; bundle: TrueCopyBundle }[];
  pdfs: { name: string; title: string; chainKey: string; pdf: Uint8Array; contentSha256: string }[];
  documents: { name: string; title: string; mediaType: 'application/json' | 'text/plain'; text: string }[];
}

export interface EvidenceVerificationReport {
  ok: boolean;
  problems: string[];
  exportSha256: string | null;
  sections: number;
  reference: 'MATCHED' | 'MISMATCHED' | 'NONE';
}

const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
const utf8Bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

export function assembleEvidenceExport(input: EvidenceExportInput): EvidenceExport {
  const sections: EvidenceSection[] = [];
  const bodies: Record<string, string> = {};
  const claim = (name: string): void => {
    if (!NAME.test(name)) throw new Error(`EBMR-REC-121 section name ${name} is not an export section name`);
    if (name in bodies) throw new Error(`EBMR-REC-121 section ${name} appears twice`);
  };
  for (const b of input.bundles) {
    claim(b.name);
    const text = serializeBundle(b.bundle);
    const m = JSON.parse(b.bundle.manifest) as BundleManifest;
    bodies[b.name] = text;
    sections.push({ name: b.name, kind: 'TRUE_COPY', title: b.title, mediaType: 'application/json', encoding: 'utf-8', chainKey: m.chainKey, sha256: sha256(text), bytes: utf8Bytes(text), manifestSha256: b.bundle.manifestSha256 });
  }
  for (const p of input.pdfs) {
    claim(p.name);
    bodies[p.name] = Buffer.from(p.pdf).toString('base64');
    sections.push({ name: p.name, kind: 'PDF_TRUE_COPY', title: p.title, mediaType: 'application/pdf', encoding: 'base64', chainKey: p.chainKey, sha256: sha256(p.pdf), bytes: p.pdf.length, contentSha256: p.contentSha256 });
  }
  for (const d of input.documents) {
    claim(d.name);
    bodies[d.name] = d.text;
    sections.push({ name: d.name, kind: 'DOCUMENT', title: d.title, mediaType: d.mediaType, encoding: 'utf-8', chainKey: null, sha256: sha256(d.text), bytes: utf8Bytes(d.text) });
  }
  const manifest: EvidenceManifest = {
    format: EVIDENCE_EXPORT_FORMAT,
    kind: EVIDENCE_EXPORT_KIND,
    subject: input.subject,
    generatedAt: input.generatedAt,
    sections,
    hashAlgorithm: 'SHA-256',
    note: 'Export SHA-256 = SHA-256 of this manifest text (UTF-8). Each true copy verifies offline with the true-copy verifier against the manifest SHA-256 named here; each PDF/A-3 true copy carries the record parts as associated files and its content SHA-256 in its metadata.',
  };
  const text = JSON.stringify(manifest, null, 2);
  return { format: EVIDENCE_EXPORT_FORMAT, exportSha256: sha256(text), manifest: text, sections: bodies };
}

/** The export file: one canonical JSON document and a final newline. */
export function serializeEvidenceExport(e: EvidenceExport): string {
  const sections: Record<string, string> = {};
  for (const k of Object.keys(e.sections)) sections[k] = e.sections[k] as string;
  return `${JSON.stringify({ format: e.format, exportSha256: e.exportSha256, manifest: e.manifest, sections })}\n`;
}

/** Verifies an export file without any database (see the module comment). */
export async function verifyEvidenceExportText(text: string, expected?: { exportSha256?: string }): Promise<EvidenceVerificationReport> {
  const problems: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, problems: ['the export is not JSON'], exportSha256: null, sections: 0, reference: 'NONE' };
  }
  const e = parsed as Partial<EvidenceExport>;
  if (typeof e !== 'object' || e === null || e.format !== EVIDENCE_EXPORT_FORMAT || typeof e.manifest !== 'string' || typeof e.exportSha256 !== 'string'
      || typeof e.sections !== 'object' || e.sections === null || Object.values(e.sections).some((v) => typeof v !== 'string')) {
    return { ok: false, problems: [`the file is no ${EVIDENCE_EXPORT_FORMAT} export`], exportSha256: null, sections: 0, reference: 'NONE' };
  }
  const exp = e as EvidenceExport;
  if (serializeEvidenceExport(exp) !== text) problems.push('the file is not the canonical serialisation of its content (bytes altered)');
  if (sha256(exp.manifest) !== exp.exportSha256) problems.push('the export SHA-256 does not match the manifest');
  let manifest: EvidenceManifest | null = null;
  try {
    manifest = JSON.parse(exp.manifest) as EvidenceManifest;
  } catch {
    problems.push('the manifest is not JSON');
  }
  const sections = manifest?.sections ?? [];
  if (manifest) {
    if (manifest.format !== EVIDENCE_EXPORT_FORMAT || manifest.kind !== EVIDENCE_EXPORT_KIND) problems.push('the manifest is no evidence-export manifest');
    const bundles = new Map<string, TrueCopyBundle>();
    for (const s of sections) {
      const body = exp.sections[s.name];
      if (body === undefined) {
        problems.push(`section ${s.name} is missing`);
        continue;
      }
      const bytes = s.encoding === 'base64' ? Buffer.from(body, 'base64') : Buffer.from(body, 'utf8');
      if (s.encoding === 'base64' && bytes.toString('base64') !== body) problems.push(`section ${s.name} is not canonical base64`);
      if (sha256(bytes) !== s.sha256) problems.push(`section ${s.name} does not match its SHA-256`);
      if (s.kind === 'TRUE_COPY') {
        const r = verifyTrueCopyBundleText(body, s.manifestSha256 ? { manifestSha256: s.manifestSha256 } : undefined);
        if (!r.ok) problems.push(`section ${s.name}: ${r.problems.join('; ')}`);
        if (r.summary.reference !== 'MATCHED') problems.push(`section ${s.name} is not the true copy the manifest names`);
        if (r.summary.chainKey !== s.chainKey) problems.push(`section ${s.name} is a copy of ${String(r.summary.chainKey)}, not of ${String(s.chainKey)}`);
        try {
          bundles.set(String(s.chainKey), JSON.parse(body) as TrueCopyBundle);
        } catch {
          /* reported above */
        }
      }
    }
    for (const s of sections) {
      if (s.kind !== 'PDF_TRUE_COPY') continue;
      const body = exp.sections[s.name];
      if (body === undefined) continue;
      const bundle = bundles.get(String(s.chainKey));
      if (!bundle) problems.push(`section ${s.name} renders ${String(s.chainKey)}, which the export does not carry as a true copy`);
      const r = await verifyTrueCopyPdf(new Uint8Array(Buffer.from(body, 'base64')), bundle);
      if (!r.ok) problems.push(`section ${s.name}: ${r.problems.join('; ')}`);
      if (r.contentSha256 !== s.contentSha256) problems.push(`section ${s.name} does not carry the content SHA-256 the manifest names`);
    }
    for (const k of Object.keys(exp.sections)) if (!sections.some((s) => s.name === k)) problems.push(`part ${k} is not in the manifest`);
  }
  const reference = expected?.exportSha256 === undefined ? 'NONE' : expected.exportSha256 === exp.exportSha256 ? 'MATCHED' : 'MISMATCHED';
  if (reference === 'MISMATCHED') problems.push('the export is not the one expected (export SHA-256 differs)');
  return { ok: problems.length === 0, problems, exportSha256: exp.exportSha256, sections: sections.length, reference };
}

// ---------------------------------------------------------------------------------------------
// Database (call inside withCommand)
// ---------------------------------------------------------------------------------------------

type Db = pg.Pool | pg.PoolClient;

/** Registers the export (records.register_evidence_export): the database recomputes the hash and checks every section. */
export async function registerEvidenceExport(db: Db, e: EvidenceExport): Promise<string> {
  const m = JSON.parse(e.manifest) as EvidenceManifest;
  const { rows } = await db.query<{ id: string }>('select records.register_evidence_export($1, $2, $3, $4, $5) as id', [
    m.subject.type,
    m.subject.id,
    e.manifest,
    e.exportSha256,
    serializeEvidenceExport(e).replace(/\n$/, ''),
  ]);
  const id = rows[0]?.id;
  if (!id) throw new Error('EBMR-REC-120 the export was not registered');
  return id;
}

export async function certifyEvidenceExport(db: Db, exportId: string, signatureId: string): Promise<void> {
  await db.query('select records.certify_evidence_export($1, $2)', [exportId, signatureId]);
}

/** The inspection workspace's logged read of a certified export: the file text as registered. */
export async function readEvidenceExport(db: Db, exportId: string): Promise<{ exportId: string; exportSha256: string; contentSha256: string; text: string }> {
  const { rows } = await db.query<{ r: { exportId: string; exportSha256: string; contentSha256: string; content: string } }>('select records.read_evidence_export($1) as r', [exportId]);
  const r = rows[0]?.r;
  if (!r) throw new Error('EBMR-REC-127 no export');
  return { exportId: r.exportId, exportSha256: r.exportSha256, contentSha256: r.contentSha256, text: `${r.content}\n` };
}
