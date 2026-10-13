/**
 * Contingency packs and their reconciliation in the database (Phase 4 slice 6b; kernel 1170; DI-43, PR-16, D-6-6).
 * Every act runs as the application role through the records definers with real signatures; each rule is also tried
 * around (direct writes, a wrong step, the transcriber verifying, another person's signature, a pack after signing).
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import {
  formReconciliationProblem,
  formReconciliationState,
  issueContingencyPack,
  recordContingencyFormEvent,
  signFormReconciliation,
  type IssuedForm,
} from '../../src/records/contingency.ts';
import { trueCopyBundleFromSnapshot } from '../../src/records/qp-package.ts';
import { verifyTrueCopyBundle } from '../../src/records/true-copy.ts';
import { expectPermissionDenied, expectRefused } from '../identity/helpers.ts';
import { seedActor, type SeededActor } from '../identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { again, signFor } from './helpers.ts';

let db: TestDatabase;
let operator: SeededActor;
let operator2: SeededActor;
let supervisor: SeededActor;
let qa: SeededActor;
let qa2: SeededActor;

beforeAll(async () => {
  db = await createTestDatabase();
  operator = await seedActor(db, { roleCode: 'OPERATOR' });
  operator2 = await seedActor(db, { roleCode: 'OPERATOR' });
  supervisor = await seedActor(db, { roleCode: 'SHIFT_SUPERVISOR' });
  qa = await seedActor(db, { roleCode: 'QA_SHOP_FLOOR' });
  qa2 = await seedActor(db, { roleCode: 'QA_SHOP_FLOOR' });
}, 300_000);
afterAll(async () => {
  await db.drop();
});

const run = <T>(actor: ActorContext, work: (c: pg.PoolClient) => Promise<T>): Promise<T> => withCommand(db.app, again(actor), work);

async function pack(batch: string, pages: number, moment: 'ISSUE' | 'STAGE_START' = 'ISSUE'): Promise<IssuedForm[]> {
  return run(supervisor, (c) =>
    issueContingencyPack(c, {
      batchId: batch, batchLabel: `B-${batch.slice(0, 6)}`, moment, stageRef: moment === 'STAGE_START' ? 'S2 granulation' : null,
      templateRef: 'MBR TAB-10 v3, downtime form DT-1 v2', destination: 'Granulation suite 2', pages, reason: 'planned network outage',
    }),
  );
}

/** Returned, transcribed by one operator and verified by another: reconciled. */
async function useAndVerify(form: IssuedForm): Promise<void> {
  await run(operator, (c) => recordContingencyFormEvent(c, form.formId, 'RETURNED'));
  await run(operator, (c) => recordContingencyFormEvent(c, form.formId, 'TRANSCRIBED', null, 'entries of step S2.3 flagged transcribed from paper'));
  await run(operator2, (c) => recordContingencyFormEvent(c, form.formId, 'VERIFIED'));
}

describe('contingency packs (kernel 1170)', () => {
  it('[DI-43] a batch with no contingency form issued reconciles trivially: nothing blocks its completion', async () => {
    const batch = randomUUID();
    expect(await formReconciliationState(db.app, batch)).toBe('NONE');
    expect(await formReconciliationProblem(db.app, batch)).toBeNull();
    await expectRefused(
      run(qa, async (c) => signFormReconciliation(c, batch, randomUUID())),
      'EBMR-REC-104',
      /nothing to reconcile/,
    );
  });

  it('[DI-43][PR-16][PR-11] issue 3 contingency sheets and return 2: completion is blocked and the message names the sheet not reconciled', async () => {
    const batch = randomUUID();
    const forms = await pack(batch, 3);
    expect(forms.map((f) => `${f.pageNo}/${f.pageCount}`)).toEqual(['1/3', '2/3', '3/3']);
    expect(new Set(forms.map((f) => f.serial)).size).toBe(3);
    for (const f of forms) expect(f.serial).toMatch(/^CF-\d{6,}$/);
    await useAndVerify(forms[0] as IssuedForm);
    await useAndVerify(forms[1] as IssuedForm);
    expect(await formReconciliationState(db.app, batch)).toBe('OPEN');
    const problem = await formReconciliationProblem(db.app, batch);
    expect(problem).toMatch(/^EBMR-REC-106 1 contingency form/);
    expect(problem).toContain((forms[2] as IssuedForm).serial);
    expect(problem).not.toContain((forms[0] as IssuedForm).serial);
    // The reconciliation cannot be signed while a sheet is open.
    await expectRefused(run(qa, (c) => signFormReconciliation(c, batch, randomUUID())), 'EBMR-REC-106');
  });

  it('[DI-43][PR-16] every sheet used and verified or voided, then the signed reconciliation: the batch may complete', async () => {
    const batch = randomUUID();
    const forms = await pack(batch, 2, 'STAGE_START');
    await useAndVerify(forms[0] as IssuedForm);
    await run(operator, (c) => recordContingencyFormEvent(c, (forms[1] as IssuedForm).formId, 'VOIDED', 'not needed: the system came back before use'));
    expect(await formReconciliationState(db.app, batch)).toBe('RECONCILED');
    expect(await formReconciliationProblem(db.app, batch)).toMatch(/^EBMR-REC-106 .*not signed/);
    const sig = await signFor(db, qa, { type: 'form_reconciliation', id: batch }, 'FORMS_RECONCILED', 'RECONCILED');
    await run(qa, (c) => signFormReconciliation(c, batch, sig));
    expect(await formReconciliationState(db.app, batch)).toBe('SIGNED');
    expect(await formReconciliationProblem(db.app, batch)).toBeNull();
    // Signed: no further pack and no further event.
    await expectRefused(pack(batch, 1), 'EBMR-REC-100', /reconciled and signed/);
    await expectRefused(run(operator, (c) => recordContingencyFormEvent(c, (forms[0] as IssuedForm).formId, 'RETURNED')), 'EBMR-REC-101');
    await expectRefused(run(qa, (c) => signFormReconciliation(c, batch, sig)), 'EBMR-REC-104', /already signed/);
  });

  it('[DI-43] a sheet reported missing blocks completion and is voided only with the reference of the deviation raised for it', async () => {
    const batch = randomUUID();
    const [form] = await pack(batch, 1);
    const f = form as IssuedForm;
    await expectRefused(run(operator, (c) => recordContingencyFormEvent(c, f.formId, 'REPORTED_MISSING')), 'EBMR-REC-102', /reason/);
    await run(operator, (c) => recordContingencyFormEvent(c, f.formId, 'REPORTED_MISSING', 'not returned from the suite'));
    expect(await formReconciliationProblem(db.app, batch)).toContain(f.serial);
    await expectRefused(run(supervisor, (c) => recordContingencyFormEvent(c, f.formId, 'VOIDED', 'lost')), 'EBMR-REC-102', /deviation/);
    await run(supervisor, (c) => recordContingencyFormEvent(c, f.formId, 'VOIDED', 'lost in the suite', 'DEV-2026-0042'));
    expect(await formReconciliationState(db.app, batch)).toBe('RECONCILED');
  });

  it('[DI-43] the life cycle is enforced: no transcription without a reference, the transcriber does not verify, a used sheet is not voided', async () => {
    const batch = randomUUID();
    const [form] = await pack(batch, 1);
    const f = form as IssuedForm;
    await expectRefused(run(operator, (c) => recordContingencyFormEvent(c, f.formId, 'TRANSCRIBED', null, 'x')), 'EBMR-REC-101', /ISSUED/);
    await run(operator, (c) => recordContingencyFormEvent(c, f.formId, 'RETURNED'));
    await expectRefused(run(operator, (c) => recordContingencyFormEvent(c, f.formId, 'VOIDED', 'spoilt')), 'EBMR-REC-101');
    await expectRefused(run(operator, (c) => recordContingencyFormEvent(c, f.formId, 'TRANSCRIBED')), 'EBMR-REC-102', /back-entered/);
    await run(operator, (c) => recordContingencyFormEvent(c, f.formId, 'TRANSCRIBED', null, 'entries of step S1.2'));
    await expectRefused(run(operator, (c) => recordContingencyFormEvent(c, f.formId, 'VERIFIED')), 'EBMR-REC-103', /second person/);
    await run(operator2, (c) => recordContingencyFormEvent(c, f.formId, 'VERIFIED'));
    await expectRefused(run(operator, (c) => recordContingencyFormEvent(c, randomUUID(), 'RETURNED')), 'EBMR-REC-101');
  });

  it('[DI-43] a pack is issued only with the permission, its batch, template, destination and reason, 1 to 50 pages, and the stage at a stage start', async () => {
    const batch = randomUUID();
    const base = { batchId: batch, batchLabel: 'B-1', moment: 'ISSUE' as const, templateRef: 'DT-1 v2', destination: 'Suite 1', pages: 2, reason: 'drill' };
    await expectRefused(run(operator, (c) => issueContingencyPack(c, base)), 'EBMR-IAM-040');
    await expectRefused(run(supervisor, (c) => issueContingencyPack(c, { ...base, pages: 0 })), 'EBMR-REC-100');
    await expectRefused(run(supervisor, (c) => issueContingencyPack(c, { ...base, pages: 51 })), 'EBMR-REC-100');
    await expectRefused(run(supervisor, (c) => issueContingencyPack(c, { ...base, destination: ' ' })), 'EBMR-REC-100');
    await expectRefused(run(supervisor, (c) => issueContingencyPack(c, { ...base, moment: 'STAGE_START' })), 'EBMR-REC-100', /stage/);
    await expectRefused(run(supervisor, (c) => issueContingencyPack(c, { ...base, stageRef: 'S1' })), 'EBMR-REC-100', /stage/);
    expect(await run(supervisor, (c) => issueContingencyPack(c, base))).toHaveLength(2);
  });

  it('[DI-43][DI-35] the reconciliation is signed with FORMS_RECONCILED of the current forms by the person who records it', async () => {
    const batch = randomUUID();
    const [form] = await pack(batch, 1);
    await run(operator, (c) => recordContingencyFormEvent(c, (form as IssuedForm).formId, 'VOIDED', 'unused'));
    const other = randomUUID();
    const [otherForm] = await pack(other, 1);
    await run(operator, (c) => recordContingencyFormEvent(c, (otherForm as IssuedForm).formId, 'VOIDED', 'unused'));
    const sigOther = await signFor(db, qa, { type: 'form_reconciliation', id: other }, 'FORMS_RECONCILED', 'RECONCILED');
    await expectRefused(run(qa, (c) => signFormReconciliation(c, batch, sigOther)), 'EBMR-REC-105');
    const sig2 = await signFor(db, qa2, { type: 'form_reconciliation', id: batch }, 'FORMS_RECONCILED', 'RECONCILED');
    await expectRefused(run(qa, (c) => signFormReconciliation(c, batch, sig2)), 'EBMR-REC-105', /person who signed/);
    await run(qa2, (c) => signFormReconciliation(c, batch, sig2));
    expect(await formReconciliationState(db.app, batch)).toBe('SIGNED');
  });

  it('[DI-43][DI-41] the contingency forms of a batch are copied as a true copy that verifies offline (records-schema tables named as the audit trail names them)', async () => {
    const batch = randomUUID();
    const [form] = await pack(batch, 2);
    await useAndVerify(form as IssuedForm);
    const qaReviewer = await seedActor(db, { roleCode: 'QA_REVIEWER' });
    const bundle = await run(qaReviewer, (c) => trueCopyBundleFromSnapshot(c, `form_reconciliation:${batch}`));
    const report = verifyTrueCopyBundle(bundle);
    expect(report.problems).toEqual([]);
    expect((JSON.parse(bundle.manifest) as { tables: string[] }).tables).toEqual(expect.arrayContaining(['records.contingency_form', 'records.contingency_form_event']));
  });

  it('[DI-43][INV-27] the tables are written only by the definers and the serial sequence is protected', async () => {
    const batch = randomUUID();
    const [form] = await pack(batch, 1);
    const f = form as IssuedForm;
    await expectPermissionDenied(
      db.app.query(
        "insert into records.contingency_form (serial, batch_id, batch_label, pack_id, moment, template_ref, destination, page_no, page_count, reason, person_id, account_id, correlation_id) values ('CF-999999', $1, 'B', $1, 'ISSUE', 't', 'd', 1, 1, 'r', $1, $1, $1)",
        [batch],
      ),
    );
    await expectPermissionDenied(db.app.query("insert into records.contingency_form_event (form_id, batch_id, event, person_id, account_id, correlation_id) values ($1, $2, 'VOIDED', $2, $2, $2)", [f.formId, batch]));
    await expectPermissionDenied(db.app.query("insert into records.form_reconciliation (batch_id, signature_id, form_count, person_id, account_id, correlation_id) values ($1, $1, 1, $1, $1, $1)", [batch]));
    await expectPermissionDenied(db.app.query("update records.contingency_form set destination = 'elsewhere' where id = $1", [f.formId]));
    await expectPermissionDenied(db.app.query('delete from records.contingency_form where id = $1', [f.formId]));
    await expectPermissionDenied(db.app.query("select nextval('records.contingency_form_serial')"));
    const { rows } = await db.admin.query<{ n: number }>("select count(*)::int as n from continuity.protected_sequence where sequence_key = 'records.contingency_form_serial'");
    expect(rows[0]?.n).toBe(1);
  });
});
