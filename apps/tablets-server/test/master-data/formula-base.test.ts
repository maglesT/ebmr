/**
 * Phase 3 slice 6d (GB-T-01; recipe-core 0690, designer formula-choice.ts): an active given in the formula as its base
 * with a salt-to-base factor stands in the MBR's BOM on its base when a TB-01 step states its standard on the base (TB-01
 * converts the base to the salt at dispensing); the batch mass still counts the salt (the reference batch size). The
 * quantity is computed, never typed: a BOM line with any other quantity is refused, and a TB-01 step on the form keeps
 * the salt quantity.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { terminalOf } from '@ebmr/test-kit';
import { withCommand } from '@ebmr/kernel';
import { flow, lifecycle } from '@ebmr/recipe-core';
import { GBT01_MATERIALS, GBT01_PRODUCT } from '../../src/features/execution/seed-gb-t-01.ts';
import { actorOfBrowser, refusalOf, startSigningServer, valueOf } from '../esig/support.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { signAction } from '../support/signed-acts.ts';
import { GBT01_FORMULA_LINES } from '../golden/gb-t-01/world.ts';

let gmp: TestServer;
let steward: TestBrowser;
let approver: TestBrowser;
let author: TestBrowser;
let versionId: string;
let mbr: { versionId: string; content: unknown };

beforeAll(async () => {
  gmp = await startSigningServer('GMP', { stub: false });
  [steward, approver, author] = await Promise.all([gmp.asPersona('steward'), gmp.asPersona('approver'), gmp.asPersona('author')]);
  const erp = gmp.seed.services.find((s) => s.key === 'erpInterface');
  if (!erp) throw new Error('no ERP interface in the GMP seed');
  const creds = { loginName: erp.loginName, serviceKey: erp.serviceKey, fingerprint: terminalOf(gmp.seed, erp.terminal).fingerprint };
  valueOf(await gmp.browser().call(routes.quality.erpImport, { body: { ...creds, catalogue: { products: [GBT01_PRODUCT], materials: GBT01_MATERIALS, orders: [] } } }));
  const formulaId = valueOf(await steward.call(routes.masterData.createFormula, { body: { productCode: GBT01_PRODUCT.productCode, strength: GBT01_PRODUCT.strength, batchSizeUnits: '200000' } })).formulaId;
  versionId = valueOf(await steward.call(routes.masterData.addFormulaVersion, { params: { formulaId }, body: { changeReason: 'GB-T-01', lines: GBT01_FORMULA_LINES } })).versionId;
  const signed = await signAction(gmp, approver, 'approver', { kind: 'MASTER_DATA_APPROVE', masterKind: 'FORMULA', versionId });
  if (!signed.ok) throw new Error(`SETUP: approval refused ${JSON.stringify(refusalOf(signed))}`);
}, 300_000);
afterAll(async () => {
  await gmp?.close();
});

const family = (code: string) => ({
  templateId: 'gb-t-01',
  familyCode: code,
  product: { code: GBT01_PRODUCT.productCode, name: 'Exemplazine tablets', strength: GBT01_PRODUCT.strength },
  batchSizes: [{ quantity: '81.659', unit: 'kg' }],
  markets: ['IN'],
  formulaVersionId: versionId,
});

async function problem(mbr: string, content: unknown): Promise<string | null> {
  await withCommand(gmp.db.app, await actorOfBrowser(gmp, author, 'author', { reasonCode: 'TEST', reasonText: 'content of the test' }), async (c) => {
    const parsed = flow.parseMbr(content);
    if (!parsed.ok) throw new Error('the edited content does not parse');
    await lifecycle.saveContent(c, mbr, parsed.mbr, 'edited for the test');
  });
  // The check the pin and the approval run (recipe.formula_mbr_problem executes for the owner only), read as the superuser.
  return (await gmp.db.admin.query<{ r: string | null }>('select recipe.formula_mbr_problem($1, $2) as r', [mbr, versionId])).rows[0]?.r ?? null;
}

describe('a salt-factor active on the base of a base-stated TB-01 step (recipe-core 0690)', () => {
  it('[INV-25] "Choose a product" writes the base (50 kg) into the BOM of the active a TB-01 step dispenses on the base, the formula\'s computed batch quantities elsewhere, and the database pins it; the batch mass counts the salt', async () => {
    const v = valueOf(await author.call(routes.designer.createFamily, { body: family('GBT01-F-BASE') }));
    mbr = v;
    const bom = Object.fromEntries((v.content as unknown as { bom: { material: string; quantity: { value: string } }[] }).bom.map((b) => [b.material, b.quantity.value]));
    expect(bom).toEqual({ 'MAT-EXZ-NA': '50', 'MAT-MCC-101': '8', 'MAT-LAC-MH': '14', 'MAT-PVP-K30': '2.4', 'MAT-IPA': '2.4', 'MAT-CCS': '2.4', 'MAT-SIO2': '0.4', 'MAT-MGST': '0.8', 'MAT-FCS-W': '2.45' });
    const { rows } = await gmp.db.admin.query<{ f: string }>('select formula_version_id::text as f from formulary.mbr_formula_pin where mbr_version_id = $1', [v.versionId]);
    expect(rows[0]?.f).toBe(versionId);
    const mass = (await gmp.db.admin.query<{ m: string }>('select trim_scale(recipe.formula_batch_mass($1))::text as m', [versionId])).rows[0]?.m;
    expect(mass).toBe('81.659');
    expect(await problem(v.versionId, v.content)).toBeNull();
  });

  it('[INV-25] the database refuses the active with a typed quantity, and with the base when the TB-01 step states its standard on the form', async () => {
    const v = mbr;
    const typed = JSON.parse(JSON.stringify(v.content)) as { bom: { material: string; quantity: { value: string } }[] };
    for (const b of typed.bom) if (b.material === 'MAT-EXZ-NA') b.quantity.value = '50.100';
    expect(await problem(v.versionId, typed)).toMatch(/BOM line BOM-API \(MAT-EXZ-NA\) is 50.100 kg; the formula computes 50 kg \(INV-25\)/);
    const onForm = JSON.parse(JSON.stringify(v.content).replace('"standardIs":"BASE"', '"standardIs":"FORM"')) as unknown;
    expect(await problem(v.versionId, onForm)).toMatch(/BOM line BOM-API \(MAT-EXZ-NA\) is 50 kg; the formula computes 53.659 kg \(INV-25\)/);
  });
});
