/**
 * The validation pack (Phase 7 slice 7c; IN-12; D-P7-0-1, D-P7-13): bundle in, documents out. Pure: it reads only the
 * bundle (and, for the release notes, the previous release's bundle), touches no database, file system or clock, and
 * gives the same bytes for the same bundle. Every document is written as Markdown and as self-contained HTML (PDF is
 * printed from the HTML by a browser: slice 7e/7f), and `manifest.json` lists each file with its SHA-256 and size and
 * the bundle's SHA-256.
 */
import { createHash } from 'node:crypto';
import { bundleSha256, canonicalJson, parseBundle } from '../bundle/validate.ts';
import type { Bundle } from '../bundle/types.ts';
import { renderHtml, renderMarkdown, type Doc, type Footer } from './doc.ts';
import { iq, oq, periodicReviewTemplate, pqTemplate } from './qualification.ts';
import { aiInventory, knownIssues, releaseNotes, sbomReference, smfParagraph, validationSummary } from './release.ts';
import { riskAssessment, urs } from './requirements.ts';
import { designSpec, functionalSpec } from './specs.ts';
import { traceMatrix } from './trace.ts';

/** The artefacts of the validation package, in order (IN-12 behaviour; plan slice 7c "Documents"). */
export const PACK_ARTEFACTS = [
  'urs',
  'risk-assessment',
  'functional-spec',
  'design-spec',
  'trace-matrix',
  'iq',
  'oq',
  'pq-template',
  'periodic-review-template',
  'validation-summary',
  'release-notes',
  'sbom',
  'known-issues',
  'smf-paragraph',
  'ai-inventory',
] as const;
export type PackArtefact = (typeof PACK_ARTEFACTS)[number];

export interface PackFile {
  /** Relative path in the pack, e.g. `urs.md`. */
  path: string;
  content: string;
}

export interface ManifestEntry {
  id: PackArtefact;
  title: string;
  status: Doc['status'];
  files: { path: string; sha256: string; bytes: number }[];
}

export interface Manifest {
  packVersion: 1;
  product: string;
  version: string;
  edition: string;
  commit: string;
  schemaRelease: string;
  bundleSha256: string;
  previousBundleSha256: string | null;
  documents: ManifestEntry[];
}

export interface Pack {
  files: PackFile[];
  manifest: Manifest;
}

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** Every document of the pack, in PACK_ARTEFACTS order. */
export function packDocuments(b: Bundle, previous?: Bundle): Doc[] {
  const docs: Record<PackArtefact, () => Doc> = {
    urs: () => urs(b),
    'risk-assessment': () => riskAssessment(b),
    'functional-spec': () => functionalSpec(b),
    'design-spec': () => designSpec(b),
    'trace-matrix': () => traceMatrix(b),
    iq: () => iq(b),
    oq: () => oq(b),
    'pq-template': () => pqTemplate(b),
    'periodic-review-template': () => periodicReviewTemplate(b),
    'validation-summary': () => validationSummary(b),
    'release-notes': () => releaseNotes(b, previous),
    sbom: () => sbomReference(b),
    'known-issues': () => knownIssues(b),
    'smf-paragraph': () => smfParagraph(b),
    'ai-inventory': () => aiInventory(b),
  };
  return PACK_ARTEFACTS.map((id) => docs[id]());
}

/**
 * Generates the pack from a bundle (checked with parseBundle first: EBMR-VAL-002, -007, -008), and from the previous
 * release's bundle for the release notes' delta. Throws EBMR-VAL-009 when the AI feature inventory refuses a method.
 */
export function generatePack(bundleJson: unknown, previousJson?: unknown): Pack {
  const b = parseBundle(bundleJson);
  const previous = previousJson === undefined ? undefined : parseBundle(previousJson);
  const footer: Footer = {
    product: b.release.product,
    version: b.release.version,
    edition: b.edition,
    commit: b.release.commit,
    schemaRelease: b.release.schemaRelease,
    bundleSha256: bundleSha256(b),
  };
  const files: PackFile[] = [];
  const documents: ManifestEntry[] = [];
  for (const doc of packDocuments(b, previous)) {
    const own: PackFile[] = [
      { path: `${doc.id}.md`, content: renderMarkdown(doc, footer) },
      { path: `${doc.id}.html`, content: renderHtml(doc, footer) },
    ];
    files.push(...own);
    documents.push({
      id: doc.id as PackArtefact,
      title: doc.title,
      status: doc.status,
      files: own.map((f) => ({ path: f.path, sha256: sha(f.content), bytes: Buffer.byteLength(f.content, 'utf8') })),
    });
  }
  const manifest: Manifest = {
    packVersion: 1,
    product: b.release.product,
    version: b.release.version,
    edition: b.edition,
    commit: b.release.commit,
    schemaRelease: b.release.schemaRelease,
    bundleSha256: footer.bundleSha256,
    previousBundleSha256: previous ? bundleSha256(previous) : null,
    documents,
  };
  files.push({ path: 'manifest.json', content: `${canonicalJson(manifest)}\n` });
  return { files, manifest };
}
