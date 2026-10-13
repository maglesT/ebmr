/**
 * The evidence export check, clause by clause (SQL mutation group "records-evidence-export": kernel 1171, 1174; decision
 * 0012). These tests close the gaps the Phase 4 focused mutation run found in test/records/evidence-export.test.ts: each
 * refusal of records.register_evidence_export on its own (the TypeScript assembler never builds a malformed package, so
 * these call the definer directly with packages altered one clause at a time, every other clause kept valid), each
 * refusal of records.true_copy_bundle_problem, the certification of an unknown export or with another export's signature,
 * and the state and signed content of one export among several.
 *
 * Controls: IN-11 (certified evidence export), DI-41 (true copy), DI-35 (signature bound to its record).
 */
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { assembleEvidenceExport, certifyEvidenceExport, registerEvidenceExport, type EvidenceExport } from '../../src/records/evidence-export.ts';
import { renderTrueCopyPdf, trueCopyContent } from '../../src/records/pdf-true-copy.ts';
import { renderPdfA3 } from '../../src/records/pdfa.ts';
import { trueCopyBundleFromSnapshot } from '../../src/records/qp-package.ts';
import { registerTrueCopy, type TrueCopyBundle } from '../../src/records/true-copy.ts';
import { seedActor, type SeededActor } from '../identity/seed.ts';
import { again, signFor } from '../records/helpers.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 });

let db: TestDatabase;
let operator: SeededActor;
let qa: SeededActor;
let qa2: SeededActor;

beforeAll(async () => {
  db = await createTestDatabase();
  await db.admin.query(`
    create schema stub_mx authorization ebmr_owner;
    set role ebmr_owner;
    grant usage on schema stub_mx to ebmr_app;
    create table stub_mx.entry (id uuid primary key default gen_random_uuid(), batch_id uuid not null, step_ref text not null, value text not null);
    grant select, insert on stub_mx.entry to ebmr_app;
    select kernel.register_audited_table('stub_mx.entry', 'batch', 'batch_id', true);
    reset role;
  `);
  operator = await seedActor(db, { roleCode: 'OPERATOR' });
  qa = await seedActor(db, { roleCode: 'QA_REVIEWER' });
  qa2 = await seedActor(db, { roleCode: 'QA_REVIEWER' });
}, 300_000);
afterAll(async () => {
  await db.drop();
});

const run = <T>(actor: ActorContext, work: (c: pg.PoolClient) => Promise<T>): Promise<T> => withCommand(db.app, again(actor), work);
const sha = (x: string | Uint8Array): string => createHash('sha256').update(x).digest('hex');
async function messageOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function recordedBatch(): Promise<string> {
  const batch = randomUUID();
  await run(operator, async (c) => {
    await c.query('insert into stub_mx.entry (batch_id, step_ref, value) values ($1, $2, $3)', [batch, 'S1', '12.50 kg']);
    await c.query('insert into stub_mx.entry (batch_id, step_ref, value) values ($1, $2, $3)', [batch, 'S2', 'blend complete']);
  });
  return batch;
}
const copyOf = (batch: string): Promise<TrueCopyBundle> => run(qa, (c) => trueCopyBundleFromSnapshot(c, `batch:${batch}`));

/** A valid export of a recorded batch with its registered true copy, its PDF/A-3 rendering and one document. */
async function exportOf(batch: string): Promise<{ exp: EvidenceExport; bundle: TrueCopyBundle }> {
  const bundle = await copyOf(batch);
  await run(qa, (c) => registerTrueCopy(c, bundle, 'evidence export'));
  const pdf = await renderTrueCopyPdf(bundle, { title: 'Batch record (true copy)', label: 'Batch' });
  const exp = assembleEvidenceExport({
    subject: { type: 'batch', id: batch, label: `Batch ${batch.slice(0, 8)}` },
    generatedAt: '2026-10-13T00:00:00.000000Z',
    bundles: [{ name: 'batch-record', title: 'Batch record', bundle }],
    pdfs: [{ name: 'batch-record-pdf', title: 'Batch record (PDF/A-3)', chainKey: `batch:${batch}`, pdf: pdf.pdf, contentSha256: pdf.contentSha256 }],
    documents: [{ name: 'summary', title: 'Summary', mediaType: 'application/json', text: JSON.stringify({ batch }) }],
  });
  return { exp, bundle };
}

type Json = Record<string, unknown>;
type Section = Json & { name: string; kind: string; sha256: string; encoding: string; chainKey: string | null };
type Manifest = Json & { subject: Json; sections: Section[] };
interface Forge {
  /** Edits the manifest (parsed) and the section texts (name -> text) before the package is built again. */
  edit?: (m: Manifest, s: Record<string, string>) => void;
  /** The manifest text instead of the edited manifest. */
  manifestText?: string | null;
  /** The package (parsed) edited after it is built, or its text replaced. */
  content?: (c: Json) => unknown;
  contentText?: string | null;
  sha256?: string;
  subjectType?: string | null;
  subjectId?: string | null;
}
/** Sets section `name`'s text and its SHA-256 and size in the manifest. */
function put(m: Manifest, s: Record<string, string>, name: string, text: string, bytes?: Buffer): void {
  s[name] = text;
  const sec = m.sections.find((x) => x.name === name);
  if (sec) {
    sec.sha256 = sha(bytes ?? text);
    sec['bytes'] = (bytes ?? Buffer.from(text)).length;
  }
}
/** Calls records.register_evidence_export with a package built again from `exp` after the edits; the refusal or 'ok'. */
async function register(exp: EvidenceExport, f: Forge = {}): Promise<string> {
  const m = JSON.parse(exp.manifest) as Manifest;
  const sections: Record<string, string> = { ...exp.sections };
  f.edit?.(m, sections);
  const manifestText = f.manifestText === undefined ? JSON.stringify(m) : f.manifestText;
  const exportSha = f.sha256 ?? (manifestText === null ? '0'.repeat(64) : sha(manifestText));
  const pkg: Json = { format: exp.format, exportSha256: exportSha, manifest: manifestText, sections };
  const contentText = f.contentText === undefined ? JSON.stringify(f.content ? f.content(pkg) : pkg) : f.contentText;
  const subject = (JSON.parse(exp.manifest) as Manifest).subject;
  return messageOf(run(qa, (c) => c.query('select records.register_evidence_export($1, $2, $3, $4, $5)', [
    f.subjectType === undefined ? subject['type'] : f.subjectType, f.subjectId === undefined ? subject['id'] : f.subjectId, manifestText, exportSha, contentText,
  ])));
}
const section = (m: Manifest, name: string): Section => m.sections.find((x) => x.name === name)!;

describe('what an evidence export package must be (kernel 1174, records.register_evidence_export)', () => {
  let exp: EvidenceExport;
  let bundle: TrueCopyBundle;
  let batch: string;
  beforeAll(async () => {
    batch = await recordedBatch();
    ({ exp, bundle } = await exportOf(batch));
  });

  it('[IN-11] the package as built registers (the baseline every case below alters in one clause)', async () => {
    expect(await register(exp)).toBe('ok');
  });

  it('[IN-11] an export names its subject type, subject id, manifest and content', async () => {
    const NAMES = /EBMR-REC-120 an evidence export names its subject, manifest and content/;
    expect(await register(exp, { manifestText: null })).toMatch(NAMES);
    expect(await register(exp, { contentText: null })).toMatch(NAMES);
    expect(await register(exp, { subjectType: '  ' })).toMatch(NAMES);
    expect(await register(exp, { subjectId: '' })).toMatch(NAMES);
  });

  it('[IN-11] the subject type is one that has an evidence export; the manifest and the package are JSON', async () => {
    expect(await register(exp, { subjectType: 'no_such_record' })).toMatch(/EBMR-REC-120 no_such_record records have no evidence export/);
    expect(await register(exp, { manifestText: 'not json' })).toMatch(/EBMR-REC-120 the manifest or the package is not JSON/);
    expect(await register(exp, { contentText: '{not json' })).toMatch(/EBMR-REC-120 the manifest or the package is not JSON/);
  });

  it('[IN-11] the manifest is an evidence-export manifest of the subject given, with a label and at least two sections', async () => {
    const NOT = /EBMR-REC-120 the manifest is no evidence-export manifest/;
    const m = JSON.parse(exp.manifest) as Manifest;
    expect(await register(exp, { manifestText: JSON.stringify([m]) })).toMatch(NOT);
    expect(await register(exp, { edit: (x) => { x['format'] = 'ebmr.evidence-export/2'; } })).toMatch(NOT);
    expect(await register(exp, { edit: (x) => { x['kind'] = 'OTHER_EXPORT'; } })).toMatch(NOT);
    expect(await register(exp, { edit: (x) => { (x as Json)['subject'] = `batch:${batch}`; } })).toMatch(NOT);
    expect(await register(exp, { edit: (x) => { x.subject['type'] = 'batch_review'; } })).toMatch(NOT);
    expect(await register(exp, { edit: (x) => { x.subject['id'] = randomUUID(); } })).toMatch(NOT);
    expect(await register(exp, { edit: (x) => { x.subject['label'] = '  '; } })).toMatch(NOT);
    expect(await register(exp, { edit: (x) => { (x as Json)['sections'] = { a: x.sections[0] }; } })).toMatch(NOT);
    expect(await register(exp, { edit: (x) => { x.sections = x.sections.slice(0, 1); } })).toMatch(NOT);
  });

  it('[IN-11] the package carries exactly this manifest and its SHA-256, and its sections by name', async () => {
    const NOT = /EBMR-REC-121 the package does not carry exactly this manifest and its SHA-256/;
    expect(await register(exp, { content: (c) => [c] })).toMatch(NOT);
    expect(await register(exp, { content: (c) => ({ ...c, format: 'other' }) })).toMatch(NOT);
    expect(await register(exp, { content: (c) => ({ ...c, manifest: `${String(c['manifest'])} ` }) })).toMatch(NOT);
    expect(await register(exp, { content: (c) => ({ ...c, exportSha256: 'f'.repeat(64) }) })).toMatch(NOT);
    expect(await register(exp, { content: (c) => ({ ...c, sections: Object.values(c['sections'] as Json) }) })).toMatch(NOT);
  });

  it('[IN-11] each section is an object with a unique name of the export form, a known kind, its encoding (base64 for the PDF only) and its SHA-256', async () => {
    const SHAPE = /EBMR-REC-121 section .* needs a unique name, a kind/;
    expect(await register(exp, { edit: (x) => { (x.sections as unknown[])[2] = 'summary'; } })).toMatch(SHAPE);
    expect(await register(exp, { edit: (x, s) => { section(x, 'summary').name = 'Summary Two'; s['Summary Two'] = s['summary']!; delete s['summary']; } })).toMatch(SHAPE);
    expect(await register(exp, { edit: (x) => { x.sections.push({ ...section(x, 'summary') }); } })).toMatch(SHAPE);
    expect(await register(exp, { edit: (x) => { section(x, 'summary').kind = 'NOTE'; } })).toMatch(SHAPE);
    expect(await register(exp, { edit: (x) => { section(x, 'summary').sha256 = 'abc'; } })).toMatch(SHAPE);
    expect(await register(exp, { edit: (x) => { section(x, 'summary').encoding = 'latin1'; } })).toMatch(SHAPE);
    expect(await register(exp, { edit: (x) => { section(x, 'summary').encoding = 'base64'; } })).toMatch(SHAPE);
    expect(await register(exp, { edit: (x) => { section(x, 'batch-record-pdf').encoding = 'utf-8'; } })).toMatch(SHAPE);
  });

  it('[IN-11] a section listed in the manifest is in the package and decodes to its SHA-256', async () => {
    const MISSING = /EBMR-REC-121 section .* is missing or does not match its SHA-256/;
    expect(await register(exp, { edit: (_x, s) => { delete s['summary']; } })).toMatch(MISSING);
    expect(await register(exp, { edit: (x, s) => { s['batch-record-pdf'] = '***not base64***'; section(x, 'batch-record-pdf').sha256 = sha('***not base64***'); } })).toMatch(MISSING);
  });

  it('[IN-11] [DI-41] a true-copy section is a bundle of its chain with the manifest SHA-256 the export names', async () => {
    const NOT = /EBMR-REC-123 section batch-record is no true-copy bundle of chain/;
    const text = exp.sections['batch-record']!;
    const b = JSON.parse(text) as Json;
    expect(await register(exp, { edit: (x, s) => put(x, s, 'batch-record', 'not json') })).toMatch(NOT);
    expect(await register(exp, { edit: (x, s) => put(x, s, 'batch-record', '[]') })).toMatch(NOT);
    expect(await register(exp, { edit: (x, s) => put(x, s, 'batch-record', JSON.stringify({ ...b, manifestSha256: 'f'.repeat(64) })) })).toMatch(NOT);
    // The bundle's manifest altered and both SHA-256 claims set to its new hash: its own text no longer hashes to them... it does, so the
    // chain it names decides: a manifest naming another chain of the same record type.
    const otherManifest = (b['manifest'] as string).replace(`batch:${batch}`, `batch:${randomUUID()}`);
    expect(await register(exp, { edit: (x, s) => {
      put(x, s, 'batch-record', JSON.stringify({ ...b, manifest: otherManifest, manifestSha256: sha(otherManifest) }));
      section(x, 'batch-record')['manifestSha256'] = sha(otherManifest);
    } })).toMatch(NOT);
    // A manifest SHA-256 claimed by both the section and the bundle that is not the hash of the bundle's manifest.
    expect(await register(exp, { edit: (x, s) => {
      put(x, s, 'batch-record', JSON.stringify({ ...b, manifestSha256: 'e'.repeat(64) }));
      section(x, 'batch-record')['manifestSha256'] = 'e'.repeat(64);
    } })).toMatch(NOT);
  });

  it('[IN-11] [DI-41] the true copy in the export is the one registered with its own manifest, not another registered copy of the same record', async () => {
    const later = await copyOf(batch);
    expect(later.manifestSha256).not.toBe(bundle.manifestSha256);
    const pdf = await renderTrueCopyPdf(later, { title: 't', label: 'l' });
    const unregistered = assembleEvidenceExport({
      subject: { type: 'batch', id: batch, label: 'Batch, copy not registered' },
      generatedAt: '2026-10-13T00:00:00.000000Z',
      bundles: [{ name: 'batch-record', title: 'Batch record', bundle: later }],
      pdfs: [{ name: 'batch-record-pdf', title: 'PDF', chainKey: `batch:${batch}`, pdf: pdf.pdf, contentSha256: pdf.contentSha256 }],
      documents: [],
    });
    expect(await register(unregistered)).toMatch(/EBMR-REC-123 the true copy of section batch-record .* is not in the true-copy register/);
  });

  it('[IN-11] [DI-41] a PDF renders a chain the export carries as a true-copy bundle', async () => {
    const reviewChain = `batch_review:${batch}`;
    const pdf = await renderTrueCopyPdf(bundle, { title: 't', label: 'l' });
    const pdfs = [
      { name: 'batch-record-pdf', title: 'PDF', chainKey: `batch:${batch}`, pdf: pdf.pdf, contentSha256: pdf.contentSha256 },
      { name: 'review-pdf', title: 'Review PDF', chainKey: reviewChain, pdf: pdf.pdf, contentSha256: pdf.contentSha256 },
    ];
    const withForeignPdf = assembleEvidenceExport({
      subject: { type: 'batch', id: batch, label: 'Batch, PDF without its bundle' },
      generatedAt: '2026-10-13T00:00:00.000000Z',
      bundles: [{ name: 'batch-record', title: 'Batch record', bundle }],
      pdfs,
      documents: [],
    });
    expect(await register(withForeignPdf)).toMatch(/EBMR-REC-124 a PDF true copy renders a chain that the export does not carry as a true-copy bundle/);
  });

  it('[IN-11] [DI-41] a PDF section carries its content SHA-256 in its metadata and is a PDF 1.7 file', async () => {
    const NOT = /EBMR-REC-124 section batch-record-pdf is no PDF true copy carrying its content SHA-256/;
    const contentSha = trueCopyContent(bundle).sha256;
    const fake = Buffer.from(`%PDF-1.4\n% ebmr-content-sha256:${contentSha}\n`, 'latin1');
    expect(await register(exp, { edit: (x, s) => put(x, s, 'batch-record-pdf', fake.toString('base64'), fake) })).toMatch(NOT);
    expect(await register(exp, { edit: (x) => { section(x, 'batch-record-pdf')['contentSha256'] = 'not-a-hash'; } })).toMatch(NOT);
  });

  it('[IN-11] [DI-41] a PDF embeds the record, its audit trail and its content descriptor, each as the true copy has it', async () => {
    const content = trueCopyContent(bundle);
    const pdfOf = (attachments: { name: string; text: string }[]) =>
      renderPdfA3({
        title: 't', subject: 's', recordDate: content.content.recordDate, contentSha256: content.sha256, integrityClause: 'c', sections: [],
        attachments: attachments.map((a) => ({ ...a, mediaType: 'application/json', relationship: 'Source' as const, description: 'd' })),
      });
    const assemble = (pdf: Uint8Array) =>
      assembleEvidenceExport({
        subject: { type: 'batch', id: batch, label: 'Batch PDF' },
        generatedAt: '2026-10-13T00:00:00.000000Z',
        bundles: [{ name: 'batch-record', title: 'Batch record', bundle }],
        pdfs: [{ name: 'batch-record-pdf', title: 'PDF', chainKey: `batch:${batch}`, pdf, contentSha256: content.sha256 }],
        documents: [],
      });
    const EMBED = /EBMR-REC-129 section batch-record-pdf does not embed the record, its audit trail and its content descriptor/;
    const chain = bundle.parts['audit-chain.json']!;
    const records = bundle.parts['records.json']!;
    expect(await register(assemble(await pdfOf([{ name: 'content.json', text: content.text }, { name: 'audit-chain.json', text: chain }])))).toMatch(EMBED);
    expect(await register(assemble(await pdfOf([{ name: 'records.json', text: records }, { name: 'audit-chain.json', text: chain }])))).toMatch(EMBED);
  });
});

describe('a true-copy bundle against the stored record (kernel 1174, records.true_copy_bundle_problem)', () => {
  let bundle: TrueCopyBundle;
  beforeAll(async () => {
    bundle = await copyOf(await recordedBatch());
  });
  const problem = async (b: unknown): Promise<string | null> =>
    (await db.admin.query<{ p: string | null }>('select records.true_copy_bundle_problem($1::jsonb) as p', [JSON.stringify(b)])).rows[0]?.p ?? null;
  /** The bundle with part `name` replaced and the manifest's SHA-256 and size of it made to match. */
  function resealed(name: string, text: string | undefined, editManifest?: (m: Json) => void): Json {
    const m = JSON.parse(bundle.manifest) as Json & { parts: { name: string; sha256: string; bytes: number }[] };
    const parts: Record<string, string> = { ...bundle.parts };
    if (text === undefined) delete parts[name];
    else {
      parts[name] = text;
      m.parts = m.parts.map((p) => (p.name === name ? { ...p, sha256: sha(text), bytes: Buffer.byteLength(text) } : p));
    }
    editManifest?.(m);
    return { ...bundle, manifest: JSON.stringify(m), parts };
  }
  const edited = (name: string, edit: (x: Json) => void): Json => {
    const x = JSON.parse(bundle.parts[name]!) as Json;
    edit(x);
    return resealed(name, JSON.stringify(x));
  };

  it('[DI-41] the bundle as copied is the record as stored', async () => {
    expect(await problem(bundle)).toBeNull();
  });

  it('[DI-41] a bundle has its manifest (with its list of parts), its records and its audit chain', async () => {
    const LACKS = /the bundle lacks its manifest, its records or its audit chain/;
    expect(await problem({ ...bundle, manifest: undefined })).toMatch(LACKS);
    expect(await problem({ ...bundle, parts: { ...bundle.parts, 'records.json': undefined } })).toMatch(LACKS);
    expect(await problem({ ...bundle, parts: { ...bundle.parts, 'audit-chain.json': undefined } })).toMatch(LACKS);
    expect(await problem(resealed('records.json', bundle.parts['records.json'], (m) => { m['parts'] = {}; }))).toMatch(LACKS);
  });

  it('[DI-41] the parts are exactly those the manifest lists', async () => {
    expect(await problem(resealed('verification.json', undefined))).toMatch(/the bundle's parts are not exactly records.json, audit-chain.json and verification.json/);
  });

  it('[DI-41] the parts are of the chain and head the manifest names', async () => {
    const NOT = /the parts are not of the chain and head the manifest names/;
    expect(await problem(edited('records.json', (r) => { r['chainKey'] = 'batch:other'; }))).toMatch(NOT);
    expect(await problem(edited('audit-chain.json', (c) => { c['chainKey'] = 'batch:other'; }))).toMatch(NOT);
    expect(await problem(edited('audit-chain.json', (c) => { c['genesisPrevHash'] = '0'.repeat(64); }))).toMatch(NOT);
    expect(await problem(edited('audit-chain.json', (c) => { c['head'] = { seq: '1', hash: '0'.repeat(64) }; }))).toMatch(NOT);
  });

  it('[DI-41] the audit trail in the copy, events and checkpoints, is the stored one', async () => {
    expect(await problem(edited('audit-chain.json', (c) => { c['checkpoints'] = [{ seq: '1', hash: '0'.repeat(64), eventCount: '1', sealedAt: 'x', reason: 'forged' }]; })))
      .toMatch(/the audit trail in the copy is not the audit trail of/);
  });

  it('[DI-41] the rows, the record type and the record id in the copy are the stored ones', async () => {
    const ROWS = /the rows in the copy are not the stored rows of/;
    expect(await problem(edited('records.json', (r) => { r['aggregateType'] = 'deviation'; }))).toMatch(ROWS);
    expect(await problem(edited('records.json', (r) => { r['aggregateId'] = randomUUID(); }))).toMatch(ROWS);
    expect(await problem(edited('records.json', (r) => { r['tables'] = []; }))).toMatch(ROWS);
  });

  it('[DI-41] the content descriptor of a bundle needs both its records and its audit chain', async () => {
    const text = async (b: unknown): Promise<string | null> => (await db.admin.query<{ t: string | null }>('select records.true_copy_content_text($1::jsonb) as t', [JSON.stringify(b)])).rows[0]?.t ?? null;
    expect(await text(bundle)).toBe(trueCopyContent(bundle).text);
    expect(await text({ ...bundle, parts: { 'audit-chain.json': bundle.parts['audit-chain.json'] } })).toBeNull();
    expect(await text({ ...bundle, parts: { 'records.json': bundle.parts['records.json'] } })).toBeNull();
  });
});

describe('the certification, the state and the signed content of one export among several (kernel 1171)', () => {
  it('[IN-11] [DI-35] an unknown export is not certified; a signature of another export is refused for its binding', async () => {
    const expA = (await exportOf(await recordedBatch())).exp;
    const expB = (await exportOf(await recordedBatch())).exp;
    const a = await run(qa, (c) => registerEvidenceExport(c, expA));
    const b = await run(qa, (c) => registerEvidenceExport(c, expB));
    const sigB = await signFor(db, qa2, { type: 'evidence_export', id: b }, 'EVIDENCE_EXPORT_CERTIFIED', 'ASSEMBLED');
    expect(await messageOf(run(qa2, (c) => certifyEvidenceExport(c, randomUUID(), sigB)))).toMatch(/EBMR-REC-125 .* is no evidence export/);
    const refused = await messageOf(run(qa2, (c) => certifyEvidenceExport(c, a, sigB)));
    expect(refused).toMatch(/EBMR-REC-126 .*\(DI-35, DI-37\)/);
    expect(refused).not.toMatch(/the signed content is not the export's/);
    const state = async (id: string): Promise<string | null> => (await db.app.query<{ s: string | null }>('select records.evidence_export_state($1) as s', [id])).rows[0]?.s ?? null;
    expect(await state(randomUUID())).toBeNull();
    expect(await state(a)).toBe('ASSEMBLED');
    const content = async (id: string): Promise<Json> => (await db.admin.query<{ c: Json }>('select records.evidence_export_content($1) as c', [id])).rows[0]!.c;
    expect(((await content(a))['content'] as Json)['export_id']).toBe(a);
    expect(((await content(b))['content'] as Json)['export_id']).toBe(b);
  });

  it('[IN-11] the batch status a contingency pack reads is NULL where the database holds no batch store', async () => {
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      expect((await c.query<{ s: string | null }>('select records.batch_status($1) as s', [randomUUID()])).rows[0]?.s).toBeNull();
      await c.query('alter table recipe.execution_state rename to execution_state_hidden');
      expect((await c.query<{ s: string | null }>('select records.batch_status($1) as s', [randomUUID()])).rows[0]?.s).toBeNull();
    } finally {
      await c.query('rollback');
      c.release();
    }
  });
});
