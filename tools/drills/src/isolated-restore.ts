/**
 * The isolated environment of export-roundtrip.ts (DI-02 clause 1): started with an empty environment and given only
 * an evidence export file, it restores the record from the file alone and prints what it found as JSON. It opens no
 * connection: the kernel's offline verifiers and renderer need none.
 *
 *   node --import tsx tools/drills/src/isolated-restore.ts <export.json>
 */
import { readFileSync } from 'node:fs';
import { records } from '@ebmr/kernel';
import type { IsolatedRestore } from './export-roundtrip.ts';

async function main(file: string): Promise<IsolatedRestore> {
  const text = readFileSync(file, 'utf8');
  const problems: string[] = [];
  const exportCheck = await records.verifyEvidenceExportText(text);
  problems.push(...exportCheck.problems.map((p) => `export: ${p}`));
  const parsed = JSON.parse(text) as { manifest: string; sections: Record<string, string> };
  const manifest = JSON.parse(parsed.manifest) as records.EvidenceManifest;
  const bundleSection = manifest.sections.find((s) => s.kind === 'TRUE_COPY');
  const pdfSection = manifest.sections.find((s) => s.kind === 'PDF_TRUE_COPY');
  let chainKey: string | null = null;
  let contentSha256: string | null = null;
  let pdfContentSha256: string | null = null;
  let events = 0;
  let rows = 0;
  if (!bundleSection) problems.push('the export holds no true copy');
  else {
    const bundleText = parsed.sections[bundleSection.name] ?? '';
    const check = records.verifyTrueCopyBundleText(bundleText, bundleSection.manifestSha256 ? { manifestSha256: bundleSection.manifestSha256 } : undefined);
    problems.push(...check.problems.map((p) => `true copy: ${p}`));
    const bundle = JSON.parse(bundleText) as records.TrueCopyBundle;
    // The record restored from the export alone: rendered again from the bundle it carries.
    const again = await records.renderTrueCopyPdf(bundle, { title: `True copy of ${check.summary.chainKey ?? ''}`, label: manifest.subject.label });
    chainKey = again.chainKey;
    contentSha256 = again.contentSha256;
    events = check.summary.events;
    rows = check.summary.rows;
    if (check.summary.omittedTables.length > 0) problems.push(`tables left out of the copy: ${check.summary.omittedTables.join(', ')}`);
  }
  if (!pdfSection) problems.push('the export holds no PDF/A-3 true copy');
  else {
    const pdf = new Uint8Array(Buffer.from(parsed.sections[pdfSection.name] ?? '', 'base64'));
    const check = await records.verifyTrueCopyPdf(pdf);
    problems.push(...check.problems.map((p) => `pdf: ${p}`));
    pdfContentSha256 = check.contentSha256;
  }
  return { ok: problems.length === 0, problems, exportSha256: exportCheck.exportSha256, chainKey, contentSha256, pdfContentSha256, events, rows, environment: Object.keys(process.env).sort() };
}

const file = process.argv[2];
if (!file) {
  console.error('usage: isolated-restore.ts <export.json>');
  process.exit(2);
}
main(file).then(
  (r) => process.stdout.write(`${JSON.stringify(r)}\n`),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
