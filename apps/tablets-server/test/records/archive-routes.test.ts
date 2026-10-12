/**
 * The archive feature over HTTP (Phase 4 slice 6b; contract ns/archive.ts; kernel 1170 to 1172): contingency packs and
 * their reconciliation, retention computed from the batch's record and logged deletion requests, the PDF/A-3 true copy,
 * the evidence export with the offline verifier, and the read-only inspection workspace. The rules themselves are proven
 * in the kernel's records tests; these prove the routes reach them as the application role.
 *
 * The signed acts (ARCHIVE_ACT: EVIDENCE_EXPORT_CERTIFIED, FORMS_RECONCILED) need the ceremony mapping of evidence_export
 * and form_reconciliation (tab.kernel_signing_meanings, re-created once by slice 6c in tablets 1198): they skip until it is
 * installed.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type SignableAction } from '@ebmr/api-contract';
import { records } from '@ebmr/kernel';
import { refusalOf, valueOf } from '../esig/support.ts';
import { startGmpBatchWorld, type GmpBatchWorld } from '../support/gmp-world.ts';
import type { TestBrowser } from '../support/harness.ts';
import { signAction } from '../support/signed-acts.ts';

let w: GmpBatchWorld;
let qa: TestBrowser;
let qa2: TestBrowser;
let issuer: TestBrowser;
let batchId: string;
let mapped = false;

beforeAll(async () => {
  w = await startGmpBatchWorld();
  issuer = await w.gmp.asPersona('issuer');
  [qa, qa2] = await Promise.all([w.gmp.asPersona('qaInvestigator'), w.gmp.asPersona('qaApprover2')]);
  batchId = await w.issued(issuer);
  mapped = (await w.gmp.db.admin.query<{ m: boolean }>(
    "select 'FORMS_RECONCILED' = any (tab.kernel_signing_meanings('form_reconciliation')) and 'EVIDENCE_EXPORT_CERTIFIED' = any (tab.kernel_signing_meanings('evidence_export')) as m",
  )).rows[0]!.m;
}, 600_000);
afterAll(async () => {
  await w?.close();
});

const view = async (b: TestBrowser = qa) => valueOf(await b.call(routes.archive.batch, { params: { batchId } }));

describe('archive over HTTP (slice 6b)', () => {
  it('[DI-43][PR-16] a contingency pack issued for a running batch blocks completion until every sheet is used and verified or voided; the transcriber does not verify', async () => {
    expect((await view()).forms).toMatchObject({ state: 'NONE', completionProblem: null, forms: [] });
    const issued = valueOf(await qa.call(routes.archive.issuePack, { params: { batchId }, body: { moment: 'ISSUE', templateRef: 'Downtime form DT-1 v2', destination: 'Granulation suite 1', pages: 3, reason: 'planned network outage' } }));
    expect(issued.forms.map((f) => [f.page, f.state])).toEqual([['1 of 3', 'ISSUED'], ['2 of 3', 'ISSUED'], ['3 of 3', 'ISSUED']]);
    expect(issued.completionProblem).toMatch(/^EBMR-REC-106 3 contingency form/);
    const [a, b, c] = issued.forms.map((f) => f.formId) as [string, string, string];
    const ev = (by: TestBrowser, formId: string, event: 'RETURNED' | 'TRANSCRIBED' | 'VERIFIED' | 'VOIDED' | 'REPORTED_MISSING', extra: { reason?: string; reference?: string } = {}) =>
      by.call(routes.archive.formEvent, { params: { formId }, body: { event, ...extra } });
    valueOf(await ev(qa, a, 'RETURNED'));
    valueOf(await ev(qa, a, 'TRANSCRIBED', { reference: 'Step S1.2 entries flagged transcribed from paper' }));
    expect(refusalOf(await ev(qa, a, 'VERIFIED')).code).toBe('EBMR-REC-103');
    valueOf(await ev(qa2, a, 'VERIFIED'));
    valueOf(await ev(qa, b, 'VOIDED', { reason: 'not needed' }));
    const twoBack = valueOf(await ev(qa, c, 'REPORTED_MISSING', { reason: 'not returned from the suite' }));
    expect(twoBack.state).toBe('OPEN');
    expect(twoBack.completionProblem).toContain(issued.forms[2]!.serial);
    expect(refusalOf(await ev(qa, c, 'VOIDED', { reason: 'lost' })).code).toBe('EBMR-REC-102');
    const done = valueOf(await ev(qa, c, 'VOIDED', { reason: 'lost in the suite', reference: 'DEV-2026-0042' }));
    expect(done.state).toBe('RECONCILED');
    expect(done.completionProblem).toMatch(/not signed/);
    const operator = await w.gmp.asPersona('steward');
    expect(refusalOf(await operator.call(routes.archive.issuePack, { params: { batchId }, body: { moment: 'ISSUE', templateRef: 'DT-1', destination: 'Suite', pages: 1, reason: 'planned network outage' } })).code).toBe('EBMR-IAM-040');
  });

  it('[DI-43][DI-35] QA signs the reconciliation (FORMS_RECONCILED); the batch may then complete as far as its paper forms go', async (ctx) => {
    if (!mapped) {
      ctx.skip();
      return;
    }
    const action: SignableAction = { kind: 'ARCHIVE_ACT', act: 'SIGN_FORMS', subjectId: batchId };
    valueOf(await signAction(w.gmp, qa2, 'qaApprover2', action));
    expect((await view()).forms).toMatchObject({ state: 'SIGNED', completionProblem: null });
  });

  it('[IN-08][PR-59] the retention of the batch is computed by the database from its record; a deletion request is refused and logged', async () => {
    const r = (await view()).retention;
    expect(r.inputs.markets).toContain('IN');
    expect(r.inputs.outcome).toBe('IN_PROGRESS');
    expect(r.scheduled).toBe(false);
    // No lot made yet: the expiry rules cannot be dated, the Form 25 five-year rule can.
    expect(r.governingRules.length + r.openBecause.length).toBeGreaterThan(0);
    const answer = valueOf(await qa.call(routes.archive.requestDisposal, { params: { batchId }, body: { reason: 'space on the archive server' } }));
    expect(answer.outcome).toBe('REFUSED');
    expect(answer.refusals[0]?.code).toBe('EBMR-REC-021');
    expect((await view()).retention.disposalRequests.map((d) => [d.outcome, d.reason])).toEqual([['REFUSED', 'space on the archive server']]);
    // Storing the schedule needs an approved batch-record type in the record register (DI-01): refused here, nothing stored.
    const refused = refusalOf(await qa.call(routes.archive.syncRetention, { params: { batchId }, body: { reason: 'retention of the batch record' } }));
    expect(refused.code).toBe('EBMR-API-ARCHIVE');
    expect(refusalOf(await issuer.call(routes.archive.requestDisposal, { params: { batchId }, body: { reason: 'space on the archive server' } })).code).toBe('EBMR-IAM-040');
  });

  it('[DI-41][IN-11] the PDF/A-3 true copy gives the same bytes twice; the export registers, verifies, and one altered byte fails the verification', async () => {
    const p1 = valueOf(await qa.call(routes.archive.pdf, { params: { batchId } }));
    const p2 = valueOf(await qa.call(routes.archive.pdf, { params: { batchId } }));
    expect(p1.pdfSha256).toBe(p2.pdfSha256);
    expect(Buffer.from(p1.pdfBase64, 'base64').subarray(0, 8).toString('latin1')).toBe('%PDF-1.7');
    expect((await records.verifyTrueCopyPdf(new Uint8Array(Buffer.from(p1.pdfBase64, 'base64')))).ok).toBe(true);
    const exp = valueOf(await qa.call(routes.archive.assembleExport, { params: { batchId } }));
    expect(exp.state).toBe('ASSEMBLED');
    expect(exp.pdfContentSha256).toBe(p1.contentSha256);
    expect(exp.sections.map((s) => s.kind)).toEqual(expect.arrayContaining(['TRUE_COPY', 'PDF_TRUE_COPY', 'DOCUMENT']));
    // Not certified: the inspection workspace does not serve it.
    expect(refusalOf(await qa.call(routes.archive.exportFile, { params: { exportId: exp.exportId } })).code).toBe('EBMR-REC-127');
    const text = (await w.gmp.db.admin.query<{ t: string }>('select content as t from records.evidence_export where id = $1', [exp.exportId])).rows[0]!.t + '\n';
    if (Buffer.byteLength(text) < 1_900_000) {
      const ok = valueOf(await qa.call(routes.archive.verify, { body: { text } }));
      expect(ok.problems).toEqual([]);
      expect(ok).toMatchObject({ ok: true, reference: 'MATCHED', registered: { exportId: exp.exportId, certified: false } });
      const at = Math.floor(text.length / 2);
      const altered = text.slice(0, at) + (text[at] === '0' ? '1' : '0') + text.slice(at + 1);
      expect(valueOf(await qa.call(routes.archive.verify, { body: { text: altered } })).ok).toBe(false);
    }
    expect(valueOf(await qa.call(routes.archive.verify, { body: { text: '{"format": "x"}' } })).ok).toBe(false);
  });

  it('[DI-40] the inspection workspace serves certified exports to a reader with ARCHIVE.INSPECT only, and logs each read', async (ctx) => {
    const issuerView = await issuer.call(routes.archive.inspection, {});
    expect(refusalOf(issuerView).code).toBe('EBMR-IAM-040');
    expect(valueOf(await qa.call(routes.archive.inspection, {})).exports.every((e) => e.state === 'CERTIFIED')).toBe(true);
    if (!mapped) {
      ctx.skip();
      return;
    }
    const exp = (await view()).exports[0]!;
    valueOf(await signAction(w.gmp, qa2, 'qaApprover2', { kind: 'ARCHIVE_ACT', act: 'CERTIFY_EXPORT', subjectId: exp.exportId }));
    const listed = valueOf(await qa.call(routes.archive.inspection, {})).exports.find((e) => e.exportId === exp.exportId);
    expect(listed?.state).toBe('CERTIFIED');
    const file = valueOf(await qa.call(routes.archive.exportFile, { params: { exportId: exp.exportId } }));
    expect((await records.verifyEvidenceExportText(file.text, { exportSha256: exp.exportSha256 })).ok).toBe(true);
    expect((await view()).exports[0]!.reads).toBe(1);
    expect(refusalOf(await qa.call(routes.archive.exportFile, { params: { exportId: randomUUID() } })).code).toBe('EBMR-REC-127');
  });
});
