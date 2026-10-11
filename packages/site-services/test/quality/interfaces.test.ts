/**
 * The other slice 5a-0 interfaces (site services 0731 to 0733; slice 5 plan D-S5-4, D-S5-5, D-S5-9): the
 * evidence-document store, the ERP product master and the QC decision on extra testing. Proven as the application
 * role, with its bypass attempts.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  erpReceiveProduct,
  evidenceDocumentProblem,
  productMasterOf,
  qcExtraTestingAggregateId,
  qcExtraTestingDecisionOf,
  recordQcExtraTestingDecision,
  registerEvidenceDocument,
  type ErpProduct,
} from '../../src/index.ts';
import { createTestDatabase, type TestDatabase } from '../helpers.ts';
import { QualityWorld, refusal, seedQualityCast, unique } from './support.ts';

let db: TestDatabase;
let w: QualityWorld;

beforeAll(async () => {
  db = await createTestDatabase();
  w = new QualityWorld(db, await seedQualityCast(db));
}, 300_000);
afterAll(async () => {
  await db.drop();
});

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

describe('evidence documents', () => {
  it('[DI-24] a stored document is named by its id at its site; an unknown id, another site or a malformed hash is refused; the app role cannot write the table', async () => {
    const id = await w.run(w.cast.qa, (c) =>
      registerEvidenceDocument(c, { sha256: sha('risk evaluation'), mediaType: 'application/pdf', sizeBytes: '20480', storageKey: `evidence/${unique('D')}.pdf`, title: 'Risk evaluation' }),
    );
    expect(await w.run(w.cast.qa, (c) => evidenceDocumentProblem(c, id, 'SITE-1'))).toBeNull();
    expect(await w.run(w.cast.qa, (c) => evidenceDocumentProblem(c, id, 'SITE-2'))).toMatch(/stored at site SITE-1, not at site SITE-2/);
    expect(await w.run(w.cast.qa, (c) => evidenceDocumentProblem(c, '00000000-0000-4000-8000-000000000009', 'SITE-1'))).toMatch(/is not a stored evidence document/);
    expect(
      await refusal(w.run(w.cast.qa, (c) => registerEvidenceDocument(c, { sha256: 'abc', mediaType: 'application/pdf', sizeBytes: '1', storageKey: 'evidence/x.pdf', title: 'x' }))),
    ).toMatch(/EBMR-SITE-331/);
    expect(
      await refusal(w.run(w.cast.erp, (c) => registerEvidenceDocument(c, { sha256: sha('x'), mediaType: 'application/pdf', sizeBytes: '1', storageKey: `evidence/${unique('D')}`, title: 'x' }))),
    ).toMatch(/EBMR-IAM/);
    for (const sql of [
      "insert into site.evidence_document (site_code, sha256, media_type, size_bytes, storage_key, title, uploaded_by_person, uploaded_by_account, correlation_id) values ('SITE-1', repeat('a', 64), 'application/pdf', 1, 'k', 't', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())",
      "update site.evidence_document set sha256 = repeat('b', 64)",
    ]) {
      expect(await refusal(db.app.query(sql))).toMatch(/permission denied/);
    }
  });
});

describe('ERP product master', () => {
  const product = (over: Partial<ErpProduct> = {}): ErpProduct => ({
    productCode: 'AMOX-250',
    strength: '250 mg',
    productName: 'Amoxicillin capsules',
    betaLactam: true,
    shelfLifeMonths: 24,
    erpReference: 'ERP-MAT-000123/1',
    ...over,
  });

  it('[PR-47] the ERP interface posts versions, the latest wins; reprocessing defaults to not permitted; unknown products read NULL; only the interface writes', async () => {
    expect(await w.run(w.cast.qa, (c) => productMasterOf(c, 'AMOX-250', '250 mg'))).toBeNull();
    await w.run(w.cast.erp, (c) => erpReceiveProduct(c, product()));
    expect(await w.run(w.cast.qa, (c) => productMasterOf(c, 'AMOX-250', '250 mg'))).toEqual({ reprocessingPermitted: false, betaLactam: true, shelfLifeMonths: 24 });
    await w.run(w.cast.erp, (c) => erpReceiveProduct(c, product({ reprocessingPermitted: true, shelfLifeMonths: 36, erpReference: 'ERP-MAT-000123/2' })));
    expect(await w.run(w.cast.qa, (c) => productMasterOf(c, 'AMOX-250', '250 mg'))).toEqual({ reprocessingPermitted: true, betaLactam: true, shelfLifeMonths: 36 });
    expect(await w.run(w.cast.qa, (c) => productMasterOf(c, 'AMOX-250', '500 mg'))).toBeNull();

    expect(await refusal(w.run(w.cast.qa, (c) => erpReceiveProduct(c, product())))).toMatch(/EBMR-IAM/);
    expect(await refusal(w.run(w.cast.erp, (c) => erpReceiveProduct(c, { ...product(), betaLactam: 'yes' as unknown as boolean })))).toMatch(/EBMR-SITE-340/);
    expect(await refusal(db.app.query("update site.erp_product set reprocessing_permitted = true"))).toMatch(/permission denied/);
    expect(
      await refusal(
        db.app.query(
          "insert into site.erp_product (product_code, strength, product_name, reprocessing_permitted, beta_lactam, shelf_life_months, erp_reference, received_by_person, received_by_account, correlation_id) values ('X', '1', 'x', true, false, 1, 'r', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())",
        ),
      ),
    ).toMatch(/permission denied/);
  });
});

describe('QC decision on extra testing (D-S5-9)', () => {
  it('[PR-47] the decision needs QC.RESULT_APPROVE and its own QC_EXTRA_TESTING_DECIDED signature binding the batch, decision and tests; the reader returns the latest', async () => {
    const b = await w.gmpBatch();
    expect(await w.run(w.cast.qa, (c) => qcExtraTestingDecisionOf(c, b.id))).toBeNull();
    const id = await w.run(w.cast.qcHead, (c) => qcExtraTestingAggregateId(c, b.id, 'EXTRA_TESTS', ['DISSOLUTION', 'ASSAY', 'ASSAY']));
    expect(id).toBe(`${b.id}/EXTRA_TESTS/ASSAY+DISSOLUTION`);
    const sig = await w.sign(w.cast.qcHead, { type: 'qc_extra_testing', id }, 'QC_EXTRA_TESTING_DECIDED', 'NONE');

    // The analyst holds no QC.RESULT_APPROVE: neither the signature nor the command.
    expect(await refusal(w.sign(w.cast.analyst, { type: 'qc_extra_testing', id }, 'QC_EXTRA_TESTING_DECIDED', 'NONE'))).not.toBe('');
    expect(await refusal(w.run(w.cast.analyst, (c) => recordQcExtraTestingDecision(c, b.id, 'EXTRA_TESTS', ['ASSAY', 'DISSOLUTION'], sig)))).toMatch(/EBMR-IAM/);
    // The signature covers exactly the decision signed: another decision or test set, or another signer, is refused.
    expect(await refusal(w.run(w.cast.qcHead, (c) => recordQcExtraTestingDecision(c, b.id, 'EXTRA_TESTS', ['ASSAY'], sig)))).toMatch(/EBMR-ESIG-070/);
    expect(await refusal(w.run(w.cast.qcHead, (c) => recordQcExtraTestingDecision(c, b.id, 'NONE_REQUIRED', [], sig)))).toMatch(/EBMR-ESIG-070/);
    expect(await refusal(w.run(w.cast.qcHead2, (c) => recordQcExtraTestingDecision(c, b.id, 'EXTRA_TESTS', ['DISSOLUTION', 'ASSAY'], sig)))).toMatch(/EBMR-SITE-347/);
    expect(await refusal(w.run(w.cast.qcHead, (c) => recordQcExtraTestingDecision(c, b.id, 'EXTRA_TESTS', [], sig)))).toMatch(/EBMR-SITE-346/);

    await w.run(w.cast.qcHead, (c) => recordQcExtraTestingDecision(c, b.id, 'EXTRA_TESTS', ['DISSOLUTION', 'ASSAY'], sig));
    const d = await w.run(w.cast.qa, (c) => qcExtraTestingDecisionOf(c, b.id));
    expect(d).toMatchObject({ decision: 'EXTRA_TESTS', tests: ['ASSAY', 'DISSOLUTION'], signatureId: sig });
    // The same signature is never used twice.
    expect(await refusal(w.run(w.cast.qcHead, (c) => recordQcExtraTestingDecision(c, b.id, 'EXTRA_TESTS', ['ASSAY', 'DISSOLUTION'], sig)))).toMatch(/EBMR-SITE-347|EBMR-ESIG/);

    // A later decision supersedes it.
    const noneId = await w.run(w.cast.qcHead2, (c) => qcExtraTestingAggregateId(c, b.id, 'NONE_REQUIRED', []));
    const latest = (await db.app.query<{ id: string }>('select id::text from site.qc_extra_testing_decision where batch_id = $1', [b.id])).rows[0]?.id ?? '';
    const sig2 = await w.sign(w.cast.qcHead2, { type: 'qc_extra_testing', id: noneId }, 'QC_EXTRA_TESTING_DECIDED', latest);
    await w.run(w.cast.qcHead2, (c) => recordQcExtraTestingDecision(c, b.id, 'NONE_REQUIRED', [], sig2));
    expect(await w.run(w.cast.qa, (c) => qcExtraTestingDecisionOf(c, b.id))).toMatchObject({ decision: 'NONE_REQUIRED', tests: [], signatureId: sig2 });

    // Not a GMP batch of this installation; and no direct write.
    expect(await refusal(w.run(w.cast.qcHead, (c) => recordQcExtraTestingDecision(c, '00000000-0000-4000-8000-000000000003', 'NONE_REQUIRED', [], sig2)))).toMatch(/EBMR-SITE-345/);
    expect(
      await refusal(
        db.app.query(
          "insert into site.qc_extra_testing_decision (batch_id, batch_number, edition, site_code, decision, signature_id, decided_by_person, decided_by_account) values ($1, 'B1', 'TABLETS', 'SITE-1', 'NONE_REQUIRED', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())",
          [b.id],
        ),
      ),
    ).toMatch(/permission denied/);
  });
});
