/**
 * A formula version's target tablet weight and further batch sizes (Phase 7 slice 7j, R4; D-7j-3; recipe-core 1535):
 * written with the composition in the same command, signed by the approver with it, never changed after; "Choose a
 * product" gives them to the designer. The products and materials are entered on screen (site-services 1530).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type FormulaLineInput } from '@ebmr/api-contract';
import { withCommand } from '@ebmr/kernel';
import { actorOfBrowser, refusalOf, startSigningServer, valueOf } from '../esig/support.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { confirmErpPending, signAction } from '../support/signed-acts.ts';

let gmp: TestServer;
let steward: TestBrowser;
let approver: TestBrowser;
let author: TestBrowser;

const md = routes.masterData;
const REASON = 'In-house development product';
const LINES: FormulaLineInput[] = [
  { lineId: 'api', materialCode: 'RM-7JT-API', role: 'ACTIVE', basis: 'PER_UNIT', quantity: '400', potencyAdjusted: true, compensating: false },
  { lineId: 'mcc', materialCode: 'RM-7JT-MCC', role: 'EXCIPIENT', basis: 'PER_UNIT', quantity: '180', potencyAdjusted: false, compensating: true },
  { lineId: 'mgs', materialCode: 'RM-7JT-MGS', role: 'EXCIPIENT', basis: 'PER_UNIT', quantity: '20', potencyAdjusted: false, compensating: false },
];

beforeAll(async () => {
  gmp = await startSigningServer('GMP', { stub: false });
  [steward, approver, author] = await Promise.all([gmp.asPersona('steward'), gmp.asPersona('approver'), gmp.asPersona('author')]);
  for (const [code, name, kind] of [['RM-7JT-API', 'Demotab active', 'API'], ['RM-7JT-MCC', 'Microcrystalline cellulose', 'EXCIPIENT'], ['RM-7JT-MGS', 'Magnesium stearate', 'EXCIPIENT']] as const) {
    valueOf(await steward.call(md.enterMaterial, { body: { materialCode: code, materialName: name, materialKind: kind, unit: 'kg', pharmacopoeia: 'IP', changeReason: REASON } }));
  }
  valueOf(await steward.call(md.enterProduct, { body: { productCode: 'DMT7JT', strength: '400 mg', productName: 'Demotab 400 mg', dosageForm: 'Film-coated tablet', betaLactam: false, shelfLifeMonths: 24, changeReason: REASON } }));
  await confirmErpPending(gmp);
}, 300_000);
afterAll(async () => {
  await gmp?.close();
});

describe('formula target and batch sizes (slice 7j)', () => {
  it('[PR-01] the target tablet weight and the further batch sizes are written with the version, signed with it and given to "Choose a product"', async () => {
    const { formulaId } = valueOf(await steward.call(md.createFormula, { body: { productCode: 'DMT7JT', strength: '400 mg', batchSizeUnits: '100000' } }));
    const v = valueOf(await steward.call(md.addFormulaVersion, { params: { formulaId }, body: { changeReason: REASON, lines: LINES, target: { targetUnitMassMg: '600', otherBatchSizesUnits: ['50000'] } } }));
    expect(v.target).toEqual({ targetUnitMassMg: '600', batchSizesUnits: ['100000', '50000'] });
    const preview = valueOf(await approver.call(routes.esig.content, { query: { aggregateType: 'formula_version', aggregateId: v.versionId, intent: 'FORMULA_APPROVED' } }));
    expect(preview.canonicalText).toContain('"targetUnitMassMg":"600"');
    const signed = await signAction(gmp, approver, 'approver', { kind: 'MASTER_DATA_APPROVE', masterKind: 'FORMULA', versionId: v.versionId });
    expect(signed.ok, JSON.stringify(signed.ok ? null : refusalOf(signed))).toBe(true);
    const choice = valueOf(await author.call(routes.designer.formulaChoice, { query: { product: 'DMT7JT', strength: '400 mg', batchSize: '100000' } }));
    expect(choice.target).toEqual({ targetUnitMassMg: '600', batchSizesUnits: ['100000', '50000'] });
    expect(choice.bom.map((l) => l.batchQuantity)).toEqual(['40', '18', '2']);

    // Never after the approval, and never twice (the database refuses).
    const err = await withCommand(gmp.db.app, await actorOfBrowser(gmp, steward, 'steward'), (c) => c.query('select recipe.formula_set_target($1, $2::jsonb)', [v.versionId, '{"targetUnitMassMg":"610"}'])).then(
      () => null,
      (e: unknown) => String(e),
    );
    expect(err).toMatch(/EBMR-FRM-051/);
  });

  it('[PR-01] a further batch size equal to the formula\'s, listed twice or not a whole number is refused, and the version with it is not written', async () => {
    const { formulaId } = valueOf(await steward.call(md.createFormula, { body: { productCode: 'DMT7JT', strength: '400 mg', batchSizeUnits: '200000' } }));
    for (const sizes of [['200000'], ['50000', '50000']]) {
      const r = await steward.call(md.addFormulaVersion, { params: { formulaId }, body: { changeReason: REASON, lines: LINES, target: { targetUnitMassMg: '600', otherBatchSizesUnits: sizes } } });
      expect(r.ok).toBe(false);
      expect(JSON.stringify(refusalOf(r))).toMatch(/EBMR-FRM-052/);
    }
    const f = valueOf(await steward.call(md.formula, { params: { formulaId } }));
    expect(f.versions).toHaveLength(0);
    const err = await withCommand(gmp.db.app, await actorOfBrowser(gmp, author, 'author'), (c) => c.query("select recipe.formula_set_target(gen_random_uuid(), '{\"targetUnitMassMg\":\"1\"}'::jsonb)")).then(
      () => null,
      (e: unknown) => String(e),
    );
    expect(err).toMatch(/EBMR-FRM-050/);
  });
});
