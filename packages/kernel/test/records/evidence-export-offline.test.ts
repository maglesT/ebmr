/**
 * The evidence export and the PDF/A-3 true copy verified offline, without a database (Phase 4 focused mutation, decision
 * 0012; kernel src/records/evidence-export.ts, pdf-true-copy.ts, pdfa.ts). The bundles follow the format
 * buildTrueCopyBundle writes, as in true-copy-verifier.test.ts; each case alters one thing in a correct export or PDF and
 * asserts the exact report, so every refusal of verifyEvidenceExportText and verifyTrueCopyPdf is shown on its own.
 *
 * Controls: IN-11 (certified evidence export verifies offline), DI-41 (true copy).
 */
import { createHash } from 'node:crypto';
import { AFRelationship, PDFArray, PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import {
  assembleEvidenceExport,
  EVIDENCE_EXPORT_FORMAT,
  serializeEvidenceExport,
  verifyEvidenceExportText,
  type EvidenceExport,
} from '../../src/records/evidence-export.ts';
import { renderTrueCopyPdf, trueCopyContent, verifyTrueCopyPdf } from '../../src/records/pdf-true-copy.ts';
import { readPdfA3, renderPdfA3 } from '../../src/records/pdfa.ts';
import { BUNDLE_FORMAT, type AuditChainPart, type BundleEvent, type Manifest, type RecordsPart, type TrueCopyBundle } from '../../src/records/true-copy.ts';

const sha = (text: string | Uint8Array): string => createHash('sha256').update(text).digest('hex');
const AT = '2026-09-30T10:00:00.123456Z';
const CORRELATION = '6f1c3c1e-0000-4000-8000-000000000001';

/** A one-event chain of `chainKey` whose genesis, link, hash and head are correct (as true-copy-verifier.test.ts). */
function chainOf(chainKey: string): AuditChainPart {
  const genesis = sha(`genesis:${chainKey}`);
  const payload = `{"seq": 1, "body": {"message": "weighing recorded"}, "table": null, "action": "BUSINESS", "chain_key": ${JSON.stringify(chainKey)}, "record_id": null, "recorded_at": ${JSON.stringify(AT)}, "correlation_id": ${JSON.stringify(CORRELATION)}}`;
  const hash = createHash('sha256').update(Buffer.from(genesis, 'hex')).update(payload, 'utf8').digest('hex');
  const e: BundleEvent = { seq: '1', prevHash: genesis, hash, recordedAt: AT, correlationId: CORRELATION, action: 'BUSINESS', tableName: null, recordId: null, payload };
  return { chainKey, genesisPrevHash: genesis, events: [e], head: { seq: '1', hash }, checkpoints: [] };
}
function bundleOf(id: string): TrueCopyBundle {
  const chainKey = `batch:${id}`;
  const records: RecordsPart = { chainKey, aggregateType: 'batch', aggregateId: id, tables: [] };
  const chain = chainOf(chainKey);
  const parts: Record<string, string> = {
    'records.json': JSON.stringify(records, null, 2),
    'audit-chain.json': JSON.stringify(chain, null, 2),
    'verification.json': JSON.stringify({ verifiedAt: AT, database: [], offline: { ok: true, problems: [] } }, null, 2),
  };
  const manifest: Manifest = {
    format: BUNDLE_FORMAT, chainKey, aggregateType: 'batch', aggregateId: id, generatedAt: AT, head: chain.head, tables: [],
    parts: Object.entries(parts).map(([name, text]) => ({ name, mediaType: 'application/json', bytes: Buffer.byteLength(text, 'utf8'), sha256: sha(text) })),
    hashAlgorithm: 'SHA-256', canonicalForm: 'PostgreSQL jsonb text output, UTF-8; event hash = SHA-256(previous hash bytes || payload bytes)',
    rendering: 'JSON only; the PDF/A-3 rendering is added in Phase 4',
  };
  const text = JSON.stringify(manifest, null, 2);
  return { format: BUNDLE_FORMAT, manifestSha256: sha(text), manifest: text, parts };
}

const B1 = bundleOf('B1');
const B2 = bundleOf('B2');

async function exportOf(opts: { pdfChain?: string; pdfBundle?: TrueCopyBundle } = {}): Promise<EvidenceExport> {
  const pdf = await renderTrueCopyPdf(opts.pdfBundle ?? B1, { title: 'Batch record (true copy)', label: 'Batch B1' });
  return assembleEvidenceExport({
    subject: { type: 'batch', id: 'B1', label: 'Batch B1' },
    generatedAt: AT,
    bundles: [{ name: 'batch-record', title: 'Batch record', bundle: B1 }],
    pdfs: [{ name: 'batch-record-pdf', title: 'Batch record (PDF/A-3)', chainKey: opts.pdfChain ?? 'batch:B1', pdf: pdf.pdf, contentSha256: pdf.contentSha256 }],
    documents: [{ name: 'summary', title: 'Summary', mediaType: 'application/json', text: '{"batch": "B1"}' }],
  });
}

type Json = Record<string, unknown>;
type Section = Json & { name: string; sha256: string; encoding: string };
/** The export text after `edit` changed its manifest (parsed) and sections; canonical, with the export SHA-256 of the new manifest. */
function rebuilt(exp: EvidenceExport, edit: (m: Json & { sections: Section[] }, s: Record<string, string>) => void): string {
  const m = JSON.parse(exp.manifest) as Json & { sections: Section[] };
  const sections = { ...exp.sections };
  edit(m, sections);
  const manifest = JSON.stringify(m, null, 2);
  return serializeEvidenceExport({ format: exp.format, exportSha256: sha(manifest), manifest, sections });
}
const sectionOf = (m: { sections: Section[] }, name: string): Section => m.sections.find((s) => s.name === name)!;
const problemsOf = async (text: string): Promise<string[]> => (await verifyEvidenceExportText(text)).problems;

describe('the evidence export verified offline (kernel src/records/evidence-export.ts)', () => {
  it('[IN-11] a correct export verifies: every section, the export SHA-256 and the reference it is checked against', async () => {
    const exp = await exportOf();
    const text = serializeEvidenceExport(exp);
    expect(await verifyEvidenceExportText(text, { exportSha256: exp.exportSha256 })).toEqual({ ok: true, problems: [], exportSha256: exp.exportSha256, sections: 3, reference: 'MATCHED' });
    expect(await verifyEvidenceExportText(text)).toMatchObject({ ok: true, reference: 'NONE' });
    expect(await verifyEvidenceExportText(text, { exportSha256: 'f'.repeat(64) })).toEqual({
      ok: false, problems: ['the export is not the one expected (export SHA-256 differs)'], exportSha256: exp.exportSha256, sections: 3, reference: 'MISMATCHED',
    });
  });

  it('[IN-11] the assembler writes each section with its kind, media type, encoding, chain, SHA-256 and size, and refuses a section name that is not one or is used twice', async () => {
    const exp = await exportOf();
    const m = JSON.parse(exp.manifest) as Json & { sections: Json[] };
    expect(m).toMatchObject({ format: EVIDENCE_EXPORT_FORMAT, kind: 'RECORD_EVIDENCE_EXPORT', subject: { type: 'batch', id: 'B1', label: 'Batch B1' }, generatedAt: AT, hashAlgorithm: 'SHA-256' });
    expect(m['note']).toMatch(/^Export SHA-256 = SHA-256 of this manifest text \(UTF-8\)\. /);
    const pdfBytes = Buffer.from(exp.sections['batch-record-pdf']!, 'base64');
    expect(m.sections).toEqual([
      { name: 'batch-record', kind: 'TRUE_COPY', title: 'Batch record', mediaType: 'application/json', encoding: 'utf-8', chainKey: 'batch:B1',
        sha256: sha(exp.sections['batch-record']!), bytes: Buffer.byteLength(exp.sections['batch-record']!), manifestSha256: B1.manifestSha256 },
      { name: 'batch-record-pdf', kind: 'PDF_TRUE_COPY', title: 'Batch record (PDF/A-3)', mediaType: 'application/pdf', encoding: 'base64', chainKey: 'batch:B1',
        sha256: sha(pdfBytes), bytes: pdfBytes.length, contentSha256: trueCopyContent(B1).sha256 },
      { name: 'summary', kind: 'DOCUMENT', title: 'Summary', mediaType: 'application/json', encoding: 'utf-8', chainKey: null, sha256: sha('{"batch": "B1"}'), bytes: 15 },
    ]);
    expect(exp.exportSha256).toBe(sha(exp.manifest));
    const assemble = (names: [string, string, string]) =>
      assembleEvidenceExport({
        subject: { type: 'batch', id: 'B1', label: 'Batch B1' }, generatedAt: AT,
        bundles: [{ name: names[0], title: 't', bundle: B1 }],
        pdfs: [{ name: names[1], title: 't', chainKey: 'batch:B1', pdf: new Uint8Array([1]), contentSha256: 'a'.repeat(64) }],
        documents: [{ name: names[2], title: 't', mediaType: 'text/plain', text: 'x' }],
      });
    expect(() => assemble(['Bad Name', 'p', 'd'])).toThrow('EBMR-REC-121 section name Bad Name is not an export section name');
    expect(() => assemble(['b', 'p d', 'd'])).toThrow('EBMR-REC-121 section name p d is not an export section name');
    expect(() => assemble(['b', 'p', '-d'])).toThrow('EBMR-REC-121 section name -d is not an export section name');
    expect(() => assemble(['b', 'b', 'd'])).toThrow('EBMR-REC-121 section b appears twice');
    expect(() => assemble(['b', 'p', 'p'])).toThrow('EBMR-REC-121 section p appears twice');
  });

  it('[IN-11] a file that is not JSON, or no export of this format, is refused before anything else is read', async () => {
    expect(await verifyEvidenceExportText('{not json')).toEqual({ ok: false, problems: ['the export is not JSON'], exportSha256: null, sections: 0, reference: 'NONE' });
    const exp = await exportOf();
    const NOT = { ok: false, problems: [`the file is no ${EVIDENCE_EXPORT_FORMAT} export`], exportSha256: null, sections: 0, reference: 'NONE' };
    const base = JSON.parse(serializeEvidenceExport(exp)) as Json;
    for (const bad of [null, 'text', [base], { ...base, format: 'other' }, { ...base, manifest: 5 }, { ...base, exportSha256: null }, { ...base, sections: null },
                       { ...base, sections: 'x' }, { ...base, sections: { ...(base['sections'] as Json), extra: 5 } }]) {
      expect(await verifyEvidenceExportText(JSON.stringify(bad)), JSON.stringify(bad)?.slice(0, 60)).toEqual(NOT);
    }
  });

  it('[IN-11] bytes altered, an export SHA-256 that is not its manifest\'s, a manifest that is not JSON or no evidence-export manifest are each reported', async () => {
    const exp = await exportOf();
    const text = serializeEvidenceExport(exp);
    expect(await problemsOf(`${text.trimEnd()} \n`)).toEqual(['the file is not the canonical serialisation of its content (bytes altered)']);
    expect(await problemsOf(serializeEvidenceExport({ ...exp, exportSha256: 'f'.repeat(64) }))).toEqual(['the export SHA-256 does not match the manifest']);
    const notJson = serializeEvidenceExport({ ...exp, manifest: 'not json', exportSha256: sha('not json') });
    expect(await verifyEvidenceExportText(notJson)).toEqual({ ok: false, problems: ['the manifest is not JSON'], exportSha256: sha('not json'), sections: 0, reference: 'NONE' });
    expect(await problemsOf(rebuilt(exp, (m) => { m['format'] = 'other'; }))).toEqual(['the manifest is no evidence-export manifest']);
    expect(await problemsOf(rebuilt(exp, (m) => { m['kind'] = 'OTHER'; }))).toEqual(['the manifest is no evidence-export manifest']);
  });

  it('[IN-11] a section missing, not canonical base64, not matching its SHA-256, or a part the manifest does not list is reported', async () => {
    const exp = await exportOf();
    expect(await problemsOf(rebuilt(exp, (_m, s) => { delete s['summary']; }))).toEqual(['section summary is missing']);
    expect(await problemsOf(rebuilt(exp, (_m, s) => { delete s['batch-record-pdf']; }))).toEqual(['section batch-record-pdf is missing']);
    expect(await problemsOf(rebuilt(exp, (m, s) => { s['summary'] = '{"batch": "B2"}'; void m; }))).toEqual(['section summary does not match its SHA-256']);
    expect(await problemsOf(rebuilt(exp, (_m, s) => { s['extra'] = 'x'; }))).toEqual(['part extra is not in the manifest']);
    const pdf = exp.sections['batch-record-pdf']!;
    expect(await problemsOf(rebuilt(exp, (_m, s) => { s['batch-record-pdf'] = `${pdf.slice(0, 40)}\n${pdf.slice(40)}`; }))).toEqual(['section batch-record-pdf is not canonical base64']);
  });

  it('[IN-11] [DI-41] a true-copy section that does not verify, is not the copy the manifest names or is a copy of another record is reported', async () => {
    const exp = await exportOf();
    const put = (m: { sections: Section[] }, s: Record<string, string>, text: string) => {
      s['batch-record'] = text;
      sectionOf(m, 'batch-record').sha256 = sha(text);
    };
    const bundle = JSON.parse(exp.sections['batch-record']!) as TrueCopyBundle;
    const altered = JSON.stringify({ ...bundle, manifestSha256: 'e'.repeat(64) });
    expect(await problemsOf(rebuilt(exp, (m, s) => put(m, s, altered)))).toEqual([
      'section batch-record: bundle bytes differ from its canonical serialisation (the file was altered); manifest SHA-256 does not match the manifest (manifest or its hash altered)',
    ]);
    expect(await problemsOf(rebuilt(exp, (m) => { sectionOf(m, 'batch-record')['manifestSha256'] = 'd'.repeat(64); })))
      .toEqual(['section batch-record: manifest SHA-256 differs from the expected reference (this is not the registered copy)', 'section batch-record is not the true copy the manifest names']);
    expect(await problemsOf(rebuilt(exp, (m) => { sectionOf(m, 'batch-record')['chainKey'] = 'batch:B9'; })))
      .toEqual(['section batch-record is a copy of batch:B1, not of batch:B9', 'section batch-record-pdf renders batch:B1, which the export does not carry as a true copy']);
    // No manifest SHA-256 named: the copy cannot be matched to a reference.
    expect(await problemsOf(rebuilt(exp, (m) => { delete sectionOf(m, 'batch-record')['manifestSha256']; })))
      .toEqual(['section batch-record is not the true copy the manifest names']);
  });

  it('[IN-11] [DI-41] a PDF of a chain the export does not carry, of another bundle, or not carrying the content SHA-256 the manifest names is reported', async () => {
    expect(await problemsOf(serializeEvidenceExport(await exportOf({ pdfChain: 'batch:B2' })))).toEqual(['section batch-record-pdf renders batch:B2, which the export does not carry as a true copy']);
    const other = await exportOf({ pdfBundle: B2 });
    const p = await problemsOf(serializeEvidenceExport(other));
    expect(p).toEqual(['section batch-record-pdf: the PDF is not a rendering of this bundle (content SHA-256 differs)']);
    const exp = await exportOf();
    expect(await problemsOf(rebuilt(exp, (m) => { sectionOf(m, 'batch-record-pdf')['contentSha256'] = 'c'.repeat(64); })))
      .toEqual(['section batch-record-pdf does not carry the content SHA-256 the manifest names']);
    // A PDF with two problems: both are named, in order, joined by "; ".
    const c2 = trueCopyContent(B2);
    const twice = await renderPdfA3({
      title: 't', subject: 's', recordDate: AT, contentSha256: 'b'.repeat(64), integrityClause: 'c', sections: [],
      attachments: [{ name: 'content.json', text: c2.text }, { name: 'records.json', text: c2.records }, { name: 'audit-chain.json', text: c2.chain }]
        .map((a) => ({ ...a, mediaType: 'application/json', relationship: 'Source' as const, description: 'd' })),
    });
    expect(await problemsOf(rebuilt(exp, (m, s) => {
      s['batch-record-pdf'] = Buffer.from(twice).toString('base64');
      sectionOf(m, 'batch-record-pdf').sha256 = sha(twice);
      sectionOf(m, 'batch-record-pdf')['contentSha256'] = c2.sha256;
    }))).toEqual(['section batch-record-pdf: the content SHA-256 in the metadata is not the SHA-256 of content.json; the PDF is not a rendering of this bundle (content SHA-256 differs)']);
    const junk = Buffer.from('%PDF-1.7 not a pdf');
    expect((await problemsOf(rebuilt(exp, (m, s) => { s['batch-record-pdf'] = junk.toString('base64'); sectionOf(m, 'batch-record-pdf').sha256 = sha(junk); })))[0])
      .toMatch(/^section batch-record-pdf: the file is no readable PDF/);
  });
});

describe('the PDF/A-3 true copy verified offline (kernel src/records/pdf-true-copy.ts, pdfa.ts)', () => {
  const content = trueCopyContent(B1);
  const pdfOf = (attachments: { name: string; text: string }[], contentSha256 = content.sha256) =>
    renderPdfA3({
      title: 't', subject: 's', recordDate: content.content.recordDate, contentSha256, integrityClause: 'c', sections: [],
      attachments: attachments.map((a) => ({ ...a, mediaType: 'application/json', relationship: 'Source' as const, description: 'd' })),
    });
  const all = [{ name: 'content.json', text: content.text }, { name: 'records.json', text: content.records }, { name: 'audit-chain.json', text: content.chain }];

  it('[DI-41] the content descriptor names the record, its head, its date and both parts with their SHA-256 and size', () => {
    expect(content.content).toEqual({
      format: 'ebmr.true-copy-content/1', chainKey: 'batch:B1', aggregateType: 'batch', aggregateId: 'B1', head: chainOf('batch:B1').head, recordDate: AT,
      parts: [
        { name: 'records.json', sha256: sha(B1.parts['records.json']!), bytes: Buffer.byteLength(B1.parts['records.json']!) },
        { name: 'audit-chain.json', sha256: sha(B1.parts['audit-chain.json']!), bytes: Buffer.byteLength(B1.parts['audit-chain.json']!) },
      ],
    });
    expect(content.sha256).toBe(sha(content.text));
    expect(() => trueCopyContent({ ...B1, parts: { 'records.json': B1.parts['records.json']! } })).toThrow(/EBMR-REC-111 the bundle has no records or audit-chain part/);
    expect(() => trueCopyContent({ ...B1, parts: { 'audit-chain.json': B1.parts['audit-chain.json']! } })).toThrow(/EBMR-REC-111 the bundle has no records or audit-chain part/);
    const empty = { ...chainOf('batch:B1'), events: [] };
    expect(() => trueCopyContent({ ...B1, parts: { ...B1.parts, 'audit-chain.json': JSON.stringify(empty) } })).toThrow(/EBMR-REC-111 batch:B1 has no audit event/);
  });

  it('[DI-41] a PDF made of the three parts verifies; one that lacks a part, misstates its content SHA-256 or carries altered parts is reported', async () => {
    expect(await verifyTrueCopyPdf(await pdfOf(all), B1)).toEqual({ ok: true, contentSha256: content.sha256, chainKey: 'batch:B1', problems: [] });
    const LACKS = 'the PDF does not carry content.json, records.json and audit-chain.json';
    for (const missing of ['content.json', 'records.json', 'audit-chain.json']) {
      expect(await verifyTrueCopyPdf(await pdfOf(all.filter((a) => a.name !== missing)))).toEqual({ ok: false, contentSha256: null, chainKey: null, problems: [LACKS] });
    }
    expect((await verifyTrueCopyPdf(await pdfOf(all, 'b'.repeat(64)))).problems).toEqual(['the content SHA-256 in the metadata is not the SHA-256 of content.json']);
    const notJson = await pdfOf([{ name: 'content.json', text: 'not json' }, ...all.slice(1)], sha('not json'));
    expect(await verifyTrueCopyPdf(notJson)).toEqual({ ok: false, contentSha256: sha('not json'), chainKey: null, problems: ['content.json is not JSON'] });
    const otherRecords = { ...JSON.parse(content.records) as Json, aggregateId: 'B1 ' };
    const r2 = await pdfOf([all[0]!, { name: 'records.json', text: JSON.stringify(otherRecords) }, all[2]!]);
    expect((await verifyTrueCopyPdf(r2)).problems).toContain('records.json does not match its SHA-256 in content.json');
    const otherChain = JSON.stringify({ ...(JSON.parse(content.chain) as Json), checkpoints: [] }, null, 1);
    const c2 = await pdfOf([all[0]!, all[1]!, { name: 'audit-chain.json', text: otherChain }]);
    expect((await verifyTrueCopyPdf(c2)).problems).toEqual(['audit-chain.json does not match its SHA-256 in content.json']);
    const brokenChain = await pdfOf([all[0]!, all[1]!, { name: 'audit-chain.json', text: 'not json' }]);
    const broken = (await verifyTrueCopyPdf(brokenChain)).problems;
    expect(broken).toContain('audit-chain.json does not match its SHA-256 in content.json');
    expect(broken.some((p) => p.startsWith('the record parts cannot be read: '))).toBe(true);
    expect((await verifyTrueCopyPdf(await pdfOf(all), B2)).problems).toEqual(['the PDF is not a rendering of this bundle (content SHA-256 differs)']);
    expect((await verifyTrueCopyPdf(new Uint8Array([1, 2, 3]))).problems[0]).toMatch(/^the file is no readable PDF: /);
  });

  it('[DI-41] a PDF without XMP metadata or an output intent, or with an embedded file that is no associated file, is reported', async () => {
    const d = await PDFDocument.create();
    d.addPage();
    d.setKeywords([`ebmr-content-sha256:${content.sha256}`]);
    await d.attach(Buffer.from(content.text), 'content.json', { mimeType: 'application/json', afRelationship: AFRelationship.Data });
    await d.attach(Buffer.from(content.records), 'records.json', { mimeType: 'application/json', afRelationship: AFRelationship.Source });
    await d.attach(Buffer.from(content.chain), 'audit-chain.json', { mimeType: 'application/json', afRelationship: AFRelationship.Source });
    // The third file taken out of the document's associated files again.
    const again = await PDFDocument.load(await d.save(), { updateMetadata: false });
    const af = again.catalog.lookup(PDFName.of('AF'), PDFArray);
    af.remove(af.size() - 1);
    const bytes = await again.save();
    const r = await verifyTrueCopyPdf(bytes, B1);
    expect(r.problems).toEqual(expect.arrayContaining(['the PDF has no XMP metadata', 'the PDF has no output intent']));
    const back = await readPdfA3(bytes);
    expect([back.catalogAf, back.attachments.size]).toEqual([2, 3]);
    expect(r.problems).toContain('not every embedded file is an associated file of the document');
    expect(r.problems.filter((p) => !['the PDF has no XMP metadata', 'the PDF has no output intent', 'not every embedded file is an associated file of the document'].includes(p))).toEqual([]);
  });

  it('[DI-41] a PDF whose audit chain does not verify is reported, though its content descriptor matches its parts', async () => {
    const chain = JSON.parse(B1.parts['audit-chain.json']!) as AuditChainPart;
    const forged: TrueCopyBundle = { ...B1, parts: { ...B1.parts, 'audit-chain.json': JSON.stringify({ ...chain, head: { seq: '1', hash: '0'.repeat(64) } }, null, 2) } };
    const c = trueCopyContent(forged);
    const pdf = await pdfOf([{ name: 'content.json', text: c.text }, { name: 'records.json', text: c.records }, { name: 'audit-chain.json', text: c.chain }], c.sha256);
    const r = await verifyTrueCopyPdf(pdf);
    expect(r.ok).toBe(false);
    expect(r.problems.length).toBeGreaterThan(0);
    expect(r.problems.every((p) => !/content\.json|SHA-256 in content/.test(p))).toBe(true);
  });

  it('[DI-41] the reader reads a PDF with no embedded files and no associated files', async () => {
    const d = await PDFDocument.create();
    d.addPage();
    const back = await readPdfA3(await d.save());
    expect(back).toMatchObject({ catalogAf: 0, hasOutputIntent: false, hasXmp: false });
    expect(back.attachments.size).toBe(0);
  });

  it('[DI-41] the reader names an embedded file without its own file name by its place in the list', async () => {
    const doc = await PDFDocument.load(await pdfOf(all), { updateMetadata: false });
    const list = doc.catalog.lookup(PDFName.of('Names'), PDFDict).lookup(PDFName.of('EmbeddedFiles'), PDFDict).lookup(PDFName.of('Names'), PDFArray);
    for (let i = 1; i < list.size(); i += 2) list.lookup(i, PDFDict).delete(PDFName.of('UF'));
    const back = await readPdfA3(await doc.save());
    expect([...back.attachments.keys()].sort()).toEqual(['0', '1', '2']);
  });

  it('[DI-41] the reader gives back every associated file by name, the content keyword, the output intent, the XMP metadata and the AF count', async () => {
    const back = await readPdfA3(await pdfOf(all));
    expect(Object.fromEntries(back.attachments)).toEqual(Object.fromEntries(all.map((a) => [a.name, a.text])));
    expect(back.catalogAf).toBe(3);
    expect(back.hasOutputIntent).toBe(true);
    expect(back.hasXmp).toBe(true);
    expect(back.keywords).toContain(`ebmr-content-sha256:${content.sha256}`);
    const none = await readPdfA3(await pdfOf([]));
    expect(none.attachments.size).toBe(0);
    expect(none.catalogAf).toBe(0);
  });
});
