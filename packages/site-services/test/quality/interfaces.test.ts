/**
 * The other slice 5a-0 interfaces (site services 0731 to 0733; slice 5 plan D-S5-4, D-S5-5, D-S5-9): the
 * evidence-document store, the ERP product master and the QC decision on extra testing. Proven as the application
 * role, with its bypass attempts.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  confirmErpMaster,
  erpMasterPending,
  erpReceiveProduct,
  evidenceDocumentProblem,
  productMasterOf,
  qcExtraTestingAggregateId,
  qcExtraTestingDecisionOf,
  recordQcExtraTestingDecision,
  storeEvidenceDocument,
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
  it('[DI-24] a stored document is named by its id at its site; an unknown id, another site or the self-attested form is refused; the app role cannot write the table', async () => {
    const id = await w.run(w.cast.qa, (c) => storeEvidenceDocument(c, { mediaType: 'application/pdf', title: 'Risk evaluation', bytes: Buffer.from(`risk evaluation ${unique('D')}`) }));
    expect(await w.run(w.cast.qa, (c) => evidenceDocumentProblem(c, id, 'SITE-1'))).toBeNull();
    expect(await w.run(w.cast.qa, (c) => evidenceDocumentProblem(c, id, 'SITE-2'))).toMatch(/stored at site SITE-1, not at site SITE-2/);
    expect(await w.run(w.cast.qa, (c) => evidenceDocumentProblem(c, '00000000-0000-4000-8000-000000000009', 'SITE-1'))).toMatch(/is not a stored evidence document/);
    // 0731's self-attested form (the storer types the hash and size) is no longer the application role's (site services 0823).
    expect(
      await refusal(w.run(w.cast.qa, (c) => c.query('select site.register_evidence_document($1::jsonb)', [JSON.stringify({ sha256: sha('x'), mediaType: 'application/pdf', sizeBytes: '1', storageKey: `evidence/${unique('D')}`, title: 'x' })]))),
    ).toMatch(/permission denied/);
    expect(await refusal(w.run(w.cast.erp, (c) => storeEvidenceDocument(c, { mediaType: 'application/pdf', title: 'x', bytes: Buffer.from('x') })))).toMatch(/EBMR-IAM/);
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

  const masterOf = (code = 'AMOX-250', strength = '250 mg') => w.run(w.cast.qa, (c) => productMasterOf(c, code, strength));

  it('[PR-47][IN-19] a new product is unknown until QA confirms it; a version that keeps the reprocessing permission and shelf life takes effect at once; one that changes them waits for QA\'s ERP_MASTER_CONFIRMED signature', async () => {
    expect(await masterOf()).toBeNull();
    const v1 = await w.run(w.cast.erp, (c) => erpReceiveProduct(c, product()));
    expect(await masterOf()).toBeNull();
    expect(await w.masterState('PRODUCT', v1)).toBe('PENDING');
    await w.confirm('PRODUCT', v1);
    expect(await masterOf()).toEqual({ reprocessingPermitted: false, betaLactam: true, shelfLifeMonths: 24 });
    // A new name and reference only: in effect on receipt.
    const v2 = await w.run(w.cast.erp, (c) => erpReceiveProduct(c, product({ productName: 'Amoxicillin capsules IP', erpReference: 'ERP-MAT-000123/2' })));
    expect(await w.masterState('PRODUCT', v2)).toBe('EFFECTIVE');
    // D-S5-5 and the IN-19 cap: reprocessing permitted and a longer shelf life wait for QA; the values in effect apply meanwhile.
    const v3 = await w.run(w.cast.erp, (c) => erpReceiveProduct(c, product({ reprocessingPermitted: true, shelfLifeMonths: 36, erpReference: 'ERP-MAT-000123/3' })));
    expect(await masterOf()).toEqual({ reprocessingPermitted: false, betaLactam: true, shelfLifeMonths: 24 });
    const pending = (await w.run(w.cast.qa, (c) => erpMasterPending(c))).find((p) => p.versionId === v3);
    expect([pending?.masterKind, pending?.values['shelfLifeMonths'], pending?.inEffect?.['shelfLifeMonths']]).toEqual(['PRODUCT', 36, 24]);
    await w.confirm('PRODUCT', v3);
    expect(await masterOf()).toEqual({ reprocessingPermitted: true, betaLactam: true, shelfLifeMonths: 36 });
    expect(await masterOf('AMOX-250', '500 mg')).toBeNull();

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
    expect(await refusal(db.app.query("insert into site.erp_master_effect (master_kind, master_key, version_id, basis, person_id, account_id) values ('PRODUCT', 'AMOX-250|250 mg', $1, 'UNCHANGED', gen_random_uuid(), gen_random_uuid())", [v3]))).toMatch(/permission denied/);
  });

  it('[PR-47][IN-38] a change of the beta-lactam flag (it drives the isolation of the packing line) takes effect only once QA confirms it (site-services 0803)', async () => {
    const code = unique('PRD-');
    await w.confirm('PRODUCT', await w.run(w.cast.erp, (c) => erpReceiveProduct(c, product({ productCode: code }))));
    expect(await masterOf(code)).toMatchObject({ betaLactam: true });
    const v2 = await w.run(w.cast.erp, (c) => erpReceiveProduct(c, product({ productCode: code, betaLactam: false, erpReference: 'ERP-BL-2' })));
    expect(await w.masterState('PRODUCT', v2)).toBe('PENDING');
    expect(await masterOf(code)).toMatchObject({ betaLactam: true });
    await w.confirm('PRODUCT', v2);
    expect(await masterOf(code)).toMatchObject({ betaLactam: false });
  });

  it('[PR-47][DI-35] the confirmation is a second person\'s: never the ERP interface\'s own person, only with ERP.MASTER_CONFIRM, by the person who signed, of the latest version only, once', async () => {
    const code = unique('PRD-');
    const v1 = await w.run(w.cast.erp, (c) => erpReceiveProduct(c, product({ productCode: code })));
    // The ERP interface's person entered the record: the approver of it is always another person (INV-03), and the interface holds no confirmation permission.
    expect(await refusal(w.sign(w.cast.erp, { type: 'erp_master', id: `PRODUCT/${v1}` }, 'ERP_MASTER_CONFIRMED', 'PENDING'))).not.toBe('');
    // QA reviewers hold no ERP.MASTER_CONFIRM.
    expect(await refusal(w.sign(w.cast.qa, { type: 'erp_master', id: `PRODUCT/${v1}` }, 'ERP_MASTER_CONFIRMED', 'PENDING'))).not.toBe('');
    const sig = await w.sign(w.cast.qaMaster, { type: 'erp_master', id: `PRODUCT/${v1}` }, 'ERP_MASTER_CONFIRMED', 'PENDING');
    expect(await refusal(w.run(w.cast.qaMaster2, (c) => confirmErpMaster(c, 'PRODUCT', v1, sig)))).toMatch(/EBMR-SITE-352/);
    expect(await refusal(w.run(w.cast.qa, (c) => confirmErpMaster(c, 'PRODUCT', v1, sig)))).toMatch(/EBMR-IAM/);
    // A later version supersedes the pending one: its signature confirms nothing.
    const v2 = await w.run(w.cast.erp, (c) => erpReceiveProduct(c, product({ productCode: code, shelfLifeMonths: 30, erpReference: 'ERP-2' })));
    expect(await refusal(w.run(w.cast.qaMaster, (c) => confirmErpMaster(c, 'PRODUCT', v1, sig)))).toMatch(/EBMR-SITE-351 .*SUPERSEDED/);
    // A signature on another version does not confirm this one.
    expect(await refusal(w.run(w.cast.qaMaster, (c) => confirmErpMaster(c, 'PRODUCT', v2, sig)))).toMatch(/EBMR-ESIG-070/);
    await w.confirm('PRODUCT', v2);
    expect(await masterOf(code)).toMatchObject({ shelfLifeMonths: 30 });
    expect(await refusal(w.confirm('PRODUCT', v2))).not.toBe('');
  });

  it('[DI-17][PR-17][IN-24] masters and orders come from the ERP interface only: an identity holding INTERFACE.WRITE (SERVICE_ACCOUNT) is refused for a product, a material and an order', async () => {
    const svc = w.cast.service;
    expect(await refusal(w.run(svc, (c) => erpReceiveProduct(c, product({ productCode: unique('PRD-'), reprocessingPermitted: true }))))).toMatch(/EBMR-IAM.*ERP\.MASTER_WRITE/);
    expect(
      await refusal(w.sql(svc, 'select site.erp_receive_material($1::jsonb) as r', [JSON.stringify({ materialCode: unique('M'), materialName: 'x', materialKind: 'INTERMEDIATE', unit: 'kg', erpReference: 'R' })])),
    ).toMatch(/EBMR-IAM.*ERP\.MASTER_WRITE/);
    expect(
      await refusal(
        w.sql(svc, 'select site.erp_receive_order($1::jsonb) as r', [
          JSON.stringify({ orderNo: unique('PO-'), siteCode: 'SITE-1', productCode: 'AMOX-250', strength: '250 mg', batchSize: '100', batchSizeUnit: 'kg', bom: [{ materialCode: 'M1', quantity: '1', unit: 'kg' }], erpReference: 'R' }),
        ]),
      ),
    ).toMatch(/EBMR-IAM.*ERP\.MASTER_WRITE/);
  });

  it('[IN-24][PR-17] a material\'s kind and maximum retest interval change only once QA confirms; a new material, even one posted INTERMEDIATE, cannot be received until then', async () => {
    const code = unique('M');
    const post = (kind: string, retest: number | null, name = `Material ${code}`) =>
      w.sql<string>(w.cast.erp, 'select site.erp_receive_material($1::jsonb) as r', [JSON.stringify({ materialCode: code, materialName: name, materialKind: kind, unit: 'kg', ...(retest ? { maxRetestMonths: retest } : {}), erpReference: `ERP-${code}` })]);
    const receive = () => w.sql(w.cast.warehouse, 'select site.receive_lot($1::jsonb) as r', [JSON.stringify({ lotCode: unique('L'), materialCode: code, quantity: '1', expiresAt: '2030-01-01T00:00:00Z' })]);
    const kindNow = async () => (await w.run(w.cast.qa, (c) => c.query<{ m: { materialKind: string; maxRetestMonths: number | null } | null }>('select site.material_master_of($1) as m', [code]))).rows[0]?.m;
    const v1 = await post('INTERMEDIATE', 24);
    expect(await kindNow()).toBeNull();
    expect(await refusal(receive())).toMatch(/EBMR-SITE-171/);
    await w.confirm('MATERIAL', v1);
    expect(await kindNow()).toEqual({ materialName: `Material ${code}`, materialKind: 'INTERMEDIATE', unit: 'kg', maxRetestMonths: 24 });
    // Kind and retest interval: pending; the receipt takes the kind in effect.
    const v2 = await post('API', 36);
    expect(await kindNow()).toMatchObject({ materialKind: 'INTERMEDIATE', maxRetestMonths: 24 });
    expect(await receive()).toMatchObject({ state: 'QUARANTINE' });
    expect((await db.app.query<{ k: string }>('select material_kind as k from site.material_lot where material_code = $1', [code])).rows.map((r) => r.k)).toEqual(['INTERMEDIATE']);
    await w.confirm('MATERIAL', v2);
    expect(await kindNow()).toMatchObject({ materialKind: 'API', maxRetestMonths: 36 });
    // Name only: in effect on receipt.
    const v3 = await post('API', 36, 'Renamed');
    expect(await w.masterState('MATERIAL', v3)).toBe('EFFECTIVE');
    expect(await kindNow()).toMatchObject({ materialName: 'Renamed' });
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

  it('[PR-47] the tests are ordered by code point whatever collation they arrive in, so the signed id matches the server\'s on any database (site-services 0810)', async () => {
    // An ICU collation sorts '_' and '-' apart from their code points; the canonical order ignores it, as the server's sort does.
    const tests = ['A_B', 'AB', 'A-C', 'AA', 'AA'];
    const { rows } = await db.app.query<{ c: string[] }>('select site.qc_test_codes($1::text[] collate "en-US-x-icu") as c', [tests]);
    expect(rows[0]?.c).toEqual([...new Set(tests)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(rows[0]?.c).toEqual(['A-C', 'AA', 'AB', 'A_B']);
    const b = await w.gmpBatch();
    const id = await w.run(w.cast.qcHead, (c) => qcExtraTestingAggregateId(c, b.id, 'EXTRA_TESTS', ['A_B', 'A-C']));
    expect(id).toBe(`${b.id}/EXTRA_TESTS/A-C+A_B`);
  });
});
