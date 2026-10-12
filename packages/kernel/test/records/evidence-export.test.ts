/**
 * The PDF/A-3 true copy, the certified evidence export and the inspection workspace (Phase 4 slice 6b; kernel 1171;
 * D-6-4, D-P4-7; IN-11, DI-41, DI-40, DI-24 clause). Records come from stub tables of the batch aggregate; every act runs
 * as the application role through the records definers with real signatures.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import {
  assembleEvidenceExport,
  certifyEvidenceExport,
  readEvidenceExport,
  registerEvidenceExport,
  serializeEvidenceExport,
  verifyEvidenceExportText,
  type EvidenceExport,
} from '../../src/records/evidence-export.ts';
import { DI24_CLAUSE, renderTrueCopyPdf, trueCopyContent, trueCopySections, verifyTrueCopyPdf } from '../../src/records/pdf-true-copy.ts';
import { readPdfA3, srgbIccProfile } from '../../src/records/pdfa.ts';
import { trueCopyBundleFromSnapshot } from '../../src/records/qp-package.ts';
import { registerTrueCopy, type AuditChainPart, type RecordsPart, type TrueCopyBundle } from '../../src/records/true-copy.ts';
import { expectPermissionDenied, expectRefused } from '../identity/helpers.ts';
import { seedActor, type SeededActor } from '../identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { again, signFor } from './helpers.ts';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 });

let db: TestDatabase;
let operator: SeededActor;
let qa: SeededActor;
let qa2: SeededActor;
let inspector: SeededActor;

beforeAll(async () => {
  db = await createTestDatabase();
  await db.admin.query(`
    create schema stub_ev authorization ebmr_owner;
    set role ebmr_owner;
    grant usage on schema stub_ev to ebmr_app;
    create table stub_ev.entry (id uuid primary key default gen_random_uuid(), batch_id uuid not null, step_ref text not null, value text not null);
    grant select, insert on stub_ev.entry to ebmr_app;
    select kernel.register_audited_table('stub_ev.entry', 'batch', 'batch_id', true);
    -- A table whose rows change after entry (UPDATE events with the original value).
    create table stub_ev.setting (id uuid primary key default gen_random_uuid(), batch_id uuid not null, name text not null, value text not null);
    grant select, insert, update on stub_ev.setting to ebmr_app;
    select kernel.register_audited_table('stub_ev.setting', 'batch', 'batch_id', false);
    reset role;
  `);
  operator = await seedActor(db, { roleCode: 'OPERATOR' });
  qa = await seedActor(db, { roleCode: 'QA_REVIEWER' });
  qa2 = await seedActor(db, { roleCode: 'QA_REVIEWER' });
  inspector = await seedActor(db, { roleCode: 'INSPECTION_READER', legalName: 'Inspector A. Rao', acknowledgeEsig: false });
}, 300_000);
afterAll(async () => {
  await db.drop();
});

const run = <T>(actor: ActorContext, work: (c: pg.PoolClient) => Promise<T>): Promise<T> => withCommand(db.app, again(actor), work);

async function recordedBatch(): Promise<string> {
  const batch = randomUUID();
  await run(operator, async (c) => {
    await c.query('insert into stub_ev.entry (batch_id, step_ref, value) values ($1, $2, $3)', [batch, 'S1', '12.50 kg']);
    await c.query('insert into stub_ev.entry (batch_id, step_ref, value) values ($1, $2, $3)', [batch, 'S2', 'मिश्रण पूर्ण (blend complete)']);
    await c.query('insert into stub_ev.setting (batch_id, name, value) values ($1, $2, $3)', [batch, 'speed', '20 rpm']);
  });
  return batch;
}

async function copyOf(batch: string): Promise<TrueCopyBundle> {
  return run(qa, (c) => trueCopyBundleFromSnapshot(c, `batch:${batch}`));
}

async function dbNow(): Promise<string> {
  const { rows } = await db.app.query<{ t: string }>(`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as t`);
  return rows[0]?.t ?? '';
}

async function exportOf(batch: string, opts: { register?: boolean } = {}): Promise<{ exp: EvidenceExport; bundle: TrueCopyBundle }> {
  const bundle = await copyOf(batch);
  if (opts.register ?? true) await run(qa, (c) => registerTrueCopy(c, bundle, 'evidence export'));
  const pdf = await renderTrueCopyPdf(bundle, { title: `Batch record ${batch.slice(0, 8)} (true copy)`, label: `Batch ${batch.slice(0, 8)}` });
  const exp = assembleEvidenceExport({
    subject: { type: 'batch', id: batch, label: `Batch ${batch.slice(0, 8)}` },
    generatedAt: await dbNow(),
    bundles: [{ name: 'batch-record', title: 'Batch record', bundle }],
    pdfs: [{ name: 'batch-record-pdf', title: 'Batch record (PDF/A-3)', chainKey: `batch:${batch}`, pdf: pdf.pdf, contentSha256: pdf.contentSha256 }],
    documents: [{ name: 'summary', title: 'Summary', mediaType: 'application/json', text: JSON.stringify({ batch }) }],
  });
  return { exp, bundle };
}

describe('PDF/A-3 true copy (D-6-4, D-P4-7)', () => {
  it('[DI-41] the same record content renders to the same bytes whenever it is rendered; new content renders differently', async () => {
    const batch = await recordedBatch();
    const first = await copyOf(batch);
    const second = await copyOf(batch);
    expect(JSON.parse(first.manifest).generatedAt).not.toBe(JSON.parse(second.manifest).generatedAt);
    const a = await renderTrueCopyPdf(first, { title: 'Batch record (true copy)', label: 'Batch 1' });
    const b = await renderTrueCopyPdf(second, { title: 'Batch record (true copy)', label: 'Batch 1' });
    expect(Buffer.from(a.pdf).equals(Buffer.from(b.pdf))).toBe(true);
    expect(a.pdfSha256).toBe(b.pdfSha256);
    // No default (clock-stamped) metadata of the library is left in the file.
    expect(Buffer.from(a.pdf).toString('latin1')).not.toContain('pdf-lib (https');
    await run(operator, (c) => c.query('insert into stub_ev.entry (batch_id, step_ref, value) values ($1, $2, $3)', [batch, 'S3', '1.0']));
    const c = await renderTrueCopyPdf(await copyOf(batch), { title: 'Batch record (true copy)', label: 'Batch 1' });
    expect(c.contentSha256).not.toBe(a.contentSha256);
    expect(Buffer.from(c.pdf).equals(Buffer.from(a.pdf))).toBe(false);
  });

  it('[DI-41] the PDF carries the record as associated files, the content SHA-256 and the record date in its metadata, fonts embedded and an sRGB output intent', async () => {
    const batch = await recordedBatch();
    const bundle = await copyOf(batch);
    const out = await renderTrueCopyPdf(bundle, { title: 'Batch record (true copy)', label: 'Batch 2' });
    const text = Buffer.from(out.pdf).toString('latin1');
    expect(text.startsWith('%PDF-1.7')).toBe(true);
    expect(text).toContain('<pdfaid:part>3</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance>');
    expect(text).toContain(`ebmr-content-sha256:${out.contentSha256}`);
    const recordDate = trueCopyContent(bundle).content.recordDate;
    expect(text).toContain(`<xmp:CreateDate>${new Date(recordDate).toISOString().replace(/\.\d{3}Z$/, 'Z')}</xmp:CreateDate>`);
    expect(text).toMatch(/\/S \/GTS_PDFA1/);
    expect(text).toMatch(/\/FontFile2/);
    expect(text).toContain('/BaseFont /EBMRAA+NotoSans-Regular');
    expect(text).toContain('/BaseFont /EBMRAB+NotoSansDevanagari-Regular');
    expect(text).not.toMatch(/\/BaseFont \/(Helvetica|Times|Courier)/);
    expect(text).toMatch(/\/AFRelationship \/Source/);
    expect(text).toMatch(/\/ID \[/);
    const back = await readPdfA3(out.pdf);
    expect([...back.attachments.keys()].sort()).toEqual(['audit-chain.json', 'content.json', 'records.json']);
    expect(back.catalogAf).toBe(3);
    expect(back.attachments.get('records.json')).toBe(bundle.parts['records.json']);
    const icc = srgbIccProfile();
    expect(Buffer.from(icc.subarray(36, 40)).toString('latin1')).toBe('acsp');
    expect(Buffer.from(icc.subarray(12, 20)).toString('latin1')).toBe('mntrRGB ');
    expect(new DataView(icc.buffer).getUint32(0)).toBe(icc.length);
    expect((await verifyTrueCopyPdf(out.pdf, bundle)).ok).toBe(true);
  });

  it('[DI-41][DI-24] the rendering shows the DI-24 clause, every row as stored and each change after entry with its original value, person and reason', async () => {
    const batch = await recordedBatch();
    await withCommand(db.app, { ...again(operator), reasonCode: 'CORRECTION', reasonText: 'speed set on the wrong scale' }, (c) =>
      c.query("update stub_ev.setting set value = '25 rpm' where batch_id = $1", [batch]),
    );
    const bundle = await copyOf(batch);
    const sections = trueCopySections(JSON.parse(bundle.parts['records.json'] as string) as RecordsPart, JSON.parse(bundle.parts['audit-chain.json'] as string) as AuditChainPart);
    const changes = sections.find((s) => s.heading === 'Changes after entry (DI-24)');
    expect(changes?.lines.join('\n')).toMatch(/value: original 20 rpm {2}-> {2}new 25 rpm/);
    expect(changes?.lines.join('\n')).toMatch(/reason: CORRECTION speed set on the wrong scale/);
    expect(changes?.lines.join('\n')).toContain(operator.legalName);
    expect(sections.find((s) => s.heading === 'Audit trail')?.lines.length).toBeGreaterThanOrEqual(4);
    expect(DI24_CLAUSE).toMatch(/no entry of this record is ever overwritten or deleted/);
    const out = await renderTrueCopyPdf(bundle, { title: 'Batch record (true copy)', label: 'Batch 3' });
    expect((await verifyTrueCopyPdf(out.pdf, bundle)).ok).toBe(true);
  });

  it('[DI-41] the PDF verifier refuses a rendering whose embedded record was altered or that belongs to another record', async () => {
    const batch = await recordedBatch();
    const bundle = await copyOf(batch);
    const records = JSON.parse(bundle.parts['records.json'] as string) as RecordsPart;
    const row = records.tables.find((t) => t.table === 'stub_ev.entry')?.rows.find((r) => r.content.includes('12.50 kg'));
    if (!row) throw new Error('no row');
    row.content = row.content.replace('12.50 kg', '12.60 kg');
    const tamperedText = JSON.stringify(records, null, 2);
    const tampered: TrueCopyBundle = { ...bundle, parts: { ...bundle.parts, 'records.json': tamperedText } };
    const bad = await renderTrueCopyPdf(tampered, { title: 'Batch record (true copy)', label: 'Batch 4' });
    const report = await verifyTrueCopyPdf(bad.pdf);
    expect(report.ok).toBe(false);
    expect(report.problems.join('; ')).toMatch(/SHA-256|hash/i);
    const other = await copyOf(await recordedBatch());
    const good = await renderTrueCopyPdf(bundle, { title: 'Batch record (true copy)', label: 'Batch 4' });
    expect((await verifyTrueCopyPdf(good.pdf, other)).problems).toContain('the PDF is not a rendering of this bundle (content SHA-256 differs)');
    expect((await verifyTrueCopyPdf(new Uint8Array([1, 2, 3]))).ok).toBe(false);
  });
});

describe('certified evidence export (IN-11) and the inspection workspace (DI-40)', () => {
  it('[IN-11] export a batch; alter one byte; hash verification fails', async () => {
    const batch = await recordedBatch();
    const { exp } = await exportOf(batch);
    const id = await run(qa, (c) => registerEvidenceExport(c, exp));
    const text = serializeEvidenceExport(exp);
    const ok = await verifyEvidenceExportText(text, { exportSha256: exp.exportSha256 });
    expect(ok.problems).toEqual([]);
    expect(ok.reference).toBe('MATCHED');
    for (const at of [10, Math.floor(text.length / 3), Math.floor(text.length / 2), text.length - 40]) {
      const ch = text[at] === 'A' ? 'B' : 'A';
      const altered = text.slice(0, at) + ch + text.slice(at + 1);
      const r = await verifyEvidenceExportText(altered, { exportSha256: exp.exportSha256 });
      expect(r.ok, `byte ${at}`).toBe(false);
    }
    const { rows } = await db.app.query<{ s: string }>('select export_sha256 as s from records.evidence_export where id = $1', [id]);
    expect(rows[0]?.s).toBe(exp.exportSha256);
  });

  it('[IN-11] the database computes the export hash again and refuses a wrong hash, an altered section, a chain of another record, an unregistered copy or a missing PDF', async () => {
    const batch = await recordedBatch();
    const { exp } = await exportOf(batch);
    await expectRefused(run(qa, (c) => registerEvidenceExport(c, { ...exp, exportSha256: '0'.repeat(64) })), 'EBMR-REC-120');
    await expectRefused(run(qa, (c) => registerEvidenceExport(c, { ...exp, sections: { ...exp.sections, summary: '{"batch": "other"}' } })), 'EBMR-REC-121');
    await expectRefused(run(qa, (c) => registerEvidenceExport(c, { ...exp, sections: { ...exp.sections, extra: 'x' } })), 'EBMR-REC-121', /does not list/);
    const other = await recordedBatch();
    const foreign = await exportOf(other);
    const mixed = assembleEvidenceExport({
      subject: { type: 'batch', id: batch, label: 'Batch mixed' },
      generatedAt: await dbNow(),
      bundles: [{ name: 'batch-record', title: 'Batch record', bundle: foreign.bundle }],
      pdfs: [],
      documents: [{ name: 'summary', title: 'Summary', mediaType: 'application/json', text: '{}' }],
    });
    await expectRefused(run(qa, (c) => registerEvidenceExport(c, mixed)), 'EBMR-REC-122');
    const unregistered = await exportOf(await recordedBatch(), { register: false });
    await expectRefused(run(qa, (c) => registerEvidenceExport(c, unregistered.exp)), 'EBMR-REC-123');
    const bundle = await copyOf(batch);
    await run(qa, (c) => registerTrueCopy(c, bundle, 'evidence export'));
    const noPdf = assembleEvidenceExport({
      subject: { type: 'batch', id: batch, label: 'Batch no PDF' },
      generatedAt: await dbNow(),
      bundles: [{ name: 'batch-record', title: 'Batch record', bundle }],
      pdfs: [],
      documents: [{ name: 'summary', title: 'Summary', mediaType: 'application/json', text: '{}' }],
    });
    await expectRefused(run(qa, (c) => registerEvidenceExport(c, noPdf)), 'EBMR-REC-124');
    const wrongHash = assembleEvidenceExport({
      subject: { type: 'batch', id: batch, label: 'Batch wrong PDF hash' },
      generatedAt: await dbNow(),
      bundles: [{ name: 'batch-record', title: 'Batch record', bundle }],
      pdfs: [{ name: 'batch-record-pdf', title: 'PDF', chainKey: `batch:${batch}`, pdf: (await renderTrueCopyPdf(bundle, { title: 't', label: 'l' })).pdf, contentSha256: 'f'.repeat(64) }],
      documents: [],
    });
    await expectRefused(run(qa, (c) => registerEvidenceExport(c, wrongHash)), 'EBMR-REC-124');
    await expectRefused(run(operator, (c) => registerEvidenceExport(c, exp)), 'EBMR-IAM-040');
    await expectRefused(run(inspector, (c) => registerEvidenceExport(c, exp)), 'EBMR-IAM-040');
    await expectPermissionDenied(
      db.app.query(
        "insert into records.evidence_export (kind, subject_type, subject_id, subject_label, manifest, export_sha256, content, content_sha256, content_bytes, sections, true_copy_ids, pdf_content_sha256, assembled_by_person, assembled_by_account, correlation_id) values ('RECORD_EVIDENCE_EXPORT', 'batch', $1, 'x', '{}', $2, '{}', $2, 2, '[]', '{}', $2, $3, $3, $3)",
        [batch, '0'.repeat(64), randomUUID()],
      ),
    );
    await expectPermissionDenied(db.app.query("update records.evidence_export_subject set chain_prefixes = '{batch,deviation}'"));
  });

  it('[IN-11][DI-35] QA certifies the export with EVIDENCE_EXPORT_CERTIFIED of this export, made by the person who records it, once', async () => {
    const { exp } = await exportOf(await recordedBatch());
    const id = await run(qa, (c) => registerEvidenceExport(c, exp));
    const otherExp = (await exportOf(await recordedBatch())).exp;
    const other = await run(qa, (c) => registerEvidenceExport(c, otherExp));
    const sigOther = await signFor(db, qa2, { type: 'evidence_export', id: other }, 'EVIDENCE_EXPORT_CERTIFIED', 'ASSEMBLED');
    await expectRefused(run(qa2, (c) => certifyEvidenceExport(c, id, sigOther)), 'EBMR-REC-126');
    const sig = await signFor(db, qa2, { type: 'evidence_export', id }, 'EVIDENCE_EXPORT_CERTIFIED', 'ASSEMBLED');
    await expectRefused(run(qa, (c) => certifyEvidenceExport(c, id, sig)), 'EBMR-REC-126', /person who signed/);
    await expectRefused(run(operator, (c) => certifyEvidenceExport(c, id, sig)), 'EBMR-IAM-040');
    await run(qa2, (c) => certifyEvidenceExport(c, id, sig));
    await expectRefused(run(qa2, (c) => certifyEvidenceExport(c, id, sig)), 'EBMR-REC-125', /already certified/);
    const { rows } = await db.app.query<{ s: string }>('select records.evidence_export_state($1) as s', [id]);
    expect(rows[0]?.s).toBe('CERTIFIED');
  });

  it('[DI-40] the inspection workspace reads certified exports only, with a read-only account, and logs every read', async () => {
    const { exp } = await exportOf(await recordedBatch());
    const id = await run(qa, (c) => registerEvidenceExport(c, exp));
    await expectRefused(run(inspector, (c) => readEvidenceExport(c, id)), 'EBMR-REC-127');
    const sig = await signFor(db, qa2, { type: 'evidence_export', id }, 'EVIDENCE_EXPORT_CERTIFIED', 'ASSEMBLED');
    await run(qa2, (c) => certifyEvidenceExport(c, id, sig));
    const read = await run(inspector, (c) => readEvidenceExport(c, id));
    expect(read.text).toBe(serializeEvidenceExport(exp));
    expect((await verifyEvidenceExportText(read.text, { exportSha256: exp.exportSha256 })).ok).toBe(true);
    await expectRefused(run(operator, (c) => readEvidenceExport(c, id)), 'EBMR-IAM-040');
    const { rows } = await db.app.query<{ n: number; p: string }>('select count(*)::int as n, max(person_id::text) as p from records.evidence_export_read where export_id = $1', [id]);
    expect(rows[0]?.n).toBe(1);
    expect(rows[0]?.p).toBe(inspector.personId);
    const perms = await db.app.query<{ effect: string }>(
      "select distinct p.effect from iam.role_permission rp join iam.permission p on p.code = rp.permission_code where rp.role_code = 'INSPECTION_READER'",
    );
    expect(perms.rows.map((r) => r.effect)).toEqual(['READ']);
    await expectPermissionDenied(db.app.query('insert into records.evidence_export_read (export_id, person_id, account_id, correlation_id) values ($1, $2, $2, $2)', [id, randomUUID()]));
  });

  it('[DI-40][IN-11] a records package for 5 batches includes their audit trails, each export verifying against its registered hash', async () => {
    for (let i = 0; i < 5; i++) {
      const batch = await recordedBatch();
      const { exp } = await exportOf(batch);
      await run(qa, (c) => registerEvidenceExport(c, exp));
      const text = serializeEvidenceExport(exp);
      const r = await verifyEvidenceExportText(text, { exportSha256: exp.exportSha256 });
      expect(r.ok).toBe(true);
      const bundle = JSON.parse(exp.sections['batch-record'] as string) as TrueCopyBundle;
      const chain = JSON.parse(bundle.parts['audit-chain.json'] as string) as AuditChainPart;
      expect(chain.chainKey).toBe(`batch:${batch}`);
      expect(chain.events.length).toBeGreaterThanOrEqual(3);
    }
  });
});
