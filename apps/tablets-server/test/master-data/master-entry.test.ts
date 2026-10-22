/**
 * Products and materials entered on screen (Phase 7 slice 7j, R4; D-7j-1; site-services 1530): the master-data steward
 * enters a version with its reason; it is in effect only once QA confirms it (ERP_MASTER_CONFIRMED, a second person);
 * its screen attributes (grade, pharmacopoeia, dosage form) are shown and signed; anyone without MASTER_DATA.ENTER is
 * refused by the database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { withCommand } from '@ebmr/kernel';
import { actorOfBrowser, refusalOf, startSigningServer, valueOf } from '../esig/support.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { signAction } from '../support/signed-acts.ts';

let gmp: TestServer;
let steward: TestBrowser;
let approver: TestBrowser;
let author: TestBrowser;

const md = routes.masterData;
const REASON = 'New product developed in house; the ERP item is not created yet';

beforeAll(async () => {
  gmp = await startSigningServer('GMP', { stub: false });
  [steward, approver, author] = await Promise.all([gmp.asPersona('steward'), gmp.asPersona('approver'), gmp.asPersona('author')]);
}, 300_000);
afterAll(async () => {
  await gmp?.close();
});

describe('masters entered on screen (slice 7j)', () => {
  it('[DI-17] a material entered by the steward waits for QA; the steward cannot confirm it; QA confirms it with its grade and pharmacopoeia', async () => {
    const entered = valueOf(
      await steward.call(md.enterMaterial, {
        body: { materialCode: 'RM-7J-API', materialName: 'Demotab active', materialKind: 'API', unit: 'kg', grade: 'Micronised', pharmacopoeia: 'IP', maxRetestMonths: 24, changeReason: REASON },
      }),
    );
    expect(entered.state).toBe('PENDING');
    const { materials } = valueOf(await approver.call(routes.quality.erpMaterials));
    expect(materials.find((m) => m.materialCode === 'RM-7J-API')).toBeUndefined();
    const { pending } = valueOf(await approver.call(routes.quality.erpPending));
    const p = pending.find((x) => x.versionId === entered.versionId);
    expect(p?.values).toMatchObject({ materialName: 'Demotab active', grade: 'Micronised', pharmacopoeia: 'IP' });
    expect(p?.erpReference).toBe('ENTERED ON SCREEN');

    const own = await signAction(gmp, steward, 'steward', { kind: 'MASTER_DATA_APPROVE', masterKind: 'ERP_MATERIAL', versionId: entered.versionId });
    expect(own.ok).toBe(false);
    const qa = await signAction(gmp, approver, 'approver', { kind: 'MASTER_DATA_APPROVE', masterKind: 'ERP_MATERIAL', versionId: entered.versionId });
    expect(qa.ok, JSON.stringify(qa.ok ? null : refusalOf(qa))).toBe(true);
    const after = valueOf(await approver.call(routes.quality.erpMaterials)).materials.find((m) => m.materialCode === 'RM-7J-API');
    expect(after).toMatchObject({ materialName: 'Demotab active', grade: 'Micronised', pharmacopoeia: 'IP', maxRetestMonths: 24, erpReference: 'ENTERED ON SCREEN' });
  });

  it('[DI-17] a person without MASTER_DATA.ENTER is refused the entry by route and in the database', async () => {
    const r = await author.call(md.enterMaterial, { body: { materialCode: 'RM-7J-X', materialName: 'X', materialKind: 'EXCIPIENT', unit: 'kg', changeReason: REASON } });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(refusalOf(r))).toMatch(/MASTER_DATA\.ENTER/);
    const err = await withCommand(gmp.db.app, await actorOfBrowser(gmp, author, 'author'), (c) =>
      c.query("select site.enter_product_master('{\"productCode\":\"X1\",\"strength\":\"1 mg\",\"productName\":\"X\",\"dosageForm\":\"Tablet\",\"betaLactam\":false,\"shelfLifeMonths\":24,\"changeReason\":\"r\"}'::jsonb)"),
    ).then(() => null, (e: unknown) => String(e));
    expect(err).toMatch(/MASTER_DATA\.ENTER/);
  });

  it('the database refuses an entry without a reason or with an unknown pharmacopoeia, and a product without its dosage form', async () => {
    const actor = await actorOfBrowser(gmp, steward, 'steward');
    const call = (sql: string, p: unknown) => withCommand(gmp.db.app, actor, (c) => c.query(sql, [JSON.stringify(p)])).then(() => null, (e: unknown) => String(e));
    expect(await call('select site.enter_material_master($1::jsonb)', { materialCode: 'RM-7J-Y', materialName: 'Y', materialKind: 'EXCIPIENT', unit: 'kg' })).toMatch(/EBMR-SITE-990/);
    expect(await call('select site.enter_material_master($1::jsonb)', { materialCode: 'RM-7J-Y', materialName: 'Y', materialKind: 'EXCIPIENT', unit: 'kg', pharmacopoeia: 'XX', changeReason: REASON })).toMatch(/EBMR-SITE-990/);
    expect(await call('select site.enter_material_master($1::jsonb)', { materialCode: 'rm lower', materialName: 'Y', materialKind: 'EXCIPIENT', unit: 'kg', changeReason: REASON })).toMatch(/EBMR-SITE-991/);
    expect(await call('select site.enter_product_master($1::jsonb)', { productCode: 'DMT1', strength: '1 mg', productName: 'Y', betaLactam: false, shelfLifeMonths: 24, changeReason: REASON })).toMatch(/EBMR-SITE-990/);
  });

  it('a product entered on screen takes effect with its dosage form once QA confirms it, and a formula can then be recorded for it', async () => {
    const entered = valueOf(
      await steward.call(md.enterProduct, {
        body: { productCode: 'DMT7J', strength: '400 mg', productName: 'Demotab 400 mg', dosageForm: 'Film-coated tablet', betaLactam: false, shelfLifeMonths: 24, changeReason: REASON },
      }),
    );
    expect(entered.key).toBe('DMT7J|400 mg');
    const before = await steward.call(md.createFormula, { body: { productCode: 'DMT7J', strength: '400 mg', batchSizeUnits: '100000' } });
    expect(before.ok).toBe(false);
    const qa = await signAction(gmp, approver, 'approver', { kind: 'MASTER_DATA_APPROVE', masterKind: 'ERP_PRODUCT', versionId: entered.versionId });
    expect(qa.ok).toBe(true);
    const product = valueOf(await steward.call(routes.quality.erpProducts)).products.find((p) => p.productCode === 'DMT7J');
    expect(product).toMatchObject({ productName: 'Demotab 400 mg', dosageForm: 'Film-coated tablet', shelfLifeMonths: 24, reprocessingPermitted: false });
    const f = valueOf(await steward.call(md.createFormula, { body: { productCode: 'DMT7J', strength: '400 mg', batchSizeUnits: '100000' } }));
    expect(f.productName).toBe('Demotab 400 mg');
  });

  it('[DI-17] a screen entry is insert-only: its update, delete and truncate are refused even to the database owner (review P7J-1)', async () => {
    valueOf(await steward.call(md.enterMaterial, { body: { materialCode: 'RM-7J-INS', materialName: 'Insert-only check', materialKind: 'EXCIPIENT', unit: 'kg', changeReason: REASON } }));
    const id = (await gmp.db.admin.query<{ id: string }>("select version_id::text as id from site.master_entry e join site.erp_material m on m.id = e.version_id where m.material_code = 'RM-7J-INS'")).rows[0]?.id;
    expect(id).toBeDefined();
    await expect(gmp.db.admin.query("update site.master_entry set change_reason = 'changed' where version_id = $1", [id])).rejects.toThrow(/EBMR-AUDIT|insert-only/i);
    await expect(gmp.db.admin.query('delete from site.master_entry where version_id = $1', [id])).rejects.toThrow(/EBMR-AUDIT|insert-only/i);
    await expect(gmp.db.admin.query('truncate site.master_entry')).rejects.toThrow(/EBMR-AUDIT|insert-only|truncate/i);
  });
});
