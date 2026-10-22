/**
 * A new master record from an approved formula, without a template (Phase 7 slice 7j, R4; D-7j-5, D-7j-6): the
 * skeleton passes the validator gate with its materials pinned from the material master; the blank start keeps the
 * header and the bill of materials; a copy of an approved master takes this formula's bill; the database pins the
 * formula version; the template path still refuses a formula whose materials are not the template's.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type FormulaLineInput } from '@ebmr/api-contract';
import { refusalOf, startSigningServer, valueOf } from '../esig/support.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { confirmErpPending, signAction } from '../support/signed-acts.ts';
import { seedReferenceDocuments } from '../../src/features/designer/seed.ts';
import { publishTables, stewardActor } from './support.ts';

let gmp: TestServer;
let steward: TestBrowser;
let approver: TestBrowser;
let author: TestBrowser;
let formulaVersionId = '';
let otherVersionId = '';

const md = routes.masterData;
const REASON = 'In-house development product';
const PRODUCT = { code: 'DMT7JF', name: 'Demotab 400 mg', strength: '400 mg' };
const LINES: FormulaLineInput[] = [
  { lineId: 'api', materialCode: 'RM-7JF-API', role: 'ACTIVE', basis: 'PER_UNIT', quantity: '400', overagePercent: '2', potencyAdjusted: true, compensating: false },
  { lineId: 'lac', materialCode: 'RM-7JF-LAC', role: 'EXCIPIENT', basis: 'PER_UNIT', quantity: '150', potencyAdjusted: false, compensating: true },
  { lineId: 'mgs', materialCode: 'RM-7JF-MGS', role: 'EXCIPIENT', basis: 'PER_UNIT', quantity: '6', potencyAdjusted: false, compensating: false },
  { lineId: 'ipa', materialCode: 'RM-7JF-IPA', role: 'PROCESSING_AID', basis: 'PER_BATCH', quantity: '12.5', potencyAdjusted: false, compensating: false },
];

const create = (familyCode: string, start: 'SKELETON' | 'BLANK' | 'COPY', extra: Record<string, unknown> = {}) =>
  author.call(routes.designer.createFamily, { body: { familyCode, product: PRODUCT, markets: ['IN'], formulaVersionId, start, ...extra } });

async function approvedFormula(units: string, target?: { targetUnitMassMg: string; otherBatchSizesUnits: string[] }): Promise<string> {
  const { formulaId } = valueOf(await steward.call(md.createFormula, { body: { productCode: PRODUCT.code, strength: PRODUCT.strength, batchSizeUnits: units } }));
  const v = valueOf(await steward.call(md.addFormulaVersion, { params: { formulaId }, body: { changeReason: REASON, lines: LINES, ...(target ? { target } : {}) } }));
  const signed = await signAction(gmp, approver, 'approver', { kind: 'MASTER_DATA_APPROVE', masterKind: 'FORMULA', versionId: v.versionId });
  if (!signed.ok) throw new Error('SETUP: the formula was not approved');
  return v.versionId;
}

beforeAll(async () => {
  gmp = await startSigningServer('GMP', { stub: false });
  await seedReferenceDocuments(gmp.db.app, await stewardActor(gmp));
  await publishTables(gmp);
  [steward, approver, author] = await Promise.all([gmp.asPersona('steward'), gmp.asPersona('approver'), gmp.asPersona('author')]);
  for (const [code, name, kind] of [
    ['RM-7JF-API', 'Demotab active', 'API'],
    ['RM-7JF-LAC', 'Lactose monohydrate', 'EXCIPIENT'],
    ['RM-7JF-MGS', 'Magnesium stearate', 'EXCIPIENT'],
    ['RM-7JF-IPA', 'Isopropyl alcohol', 'EXCIPIENT'],
  ] as const) {
    valueOf(await steward.call(md.enterMaterial, { body: { materialCode: code, materialName: name, materialKind: kind, unit: 'kg', pharmacopoeia: 'IP', changeReason: REASON } }));
  }
  valueOf(await steward.call(md.enterProduct, { body: { productCode: PRODUCT.code, strength: PRODUCT.strength, productName: PRODUCT.name, dosageForm: 'Film-coated tablet', betaLactam: false, shelfLifeMonths: 24, changeReason: REASON } }));
  await confirmErpPending(gmp);
  formulaVersionId = await approvedFormula('100000', { targetUnitMassMg: '564', otherBatchSizesUnits: ['50000'] });
  otherVersionId = await approvedFormula('200000');
}, 300_000);
afterAll(async () => {
  await gmp?.close();
});

describe('a new master from an approved formula (slice 7j)', () => {
  it('[INV-25][PR-01] the skeleton takes its header, batch sizes and bill of materials from the formula, pins it, blends with TB-07 and passes the validator gate and the simulation', async () => {
    const v = valueOf(await create('DMT7JF-SK', 'SKELETON'));
    const c = v.content as unknown as { header: { product: { dosageForm: string; name: string }; batchSizes: { id: string; quantity: { value: string } }[] }; bom: { id: string; quantity: { value: string } }[] };
    expect(c.header.product).toMatchObject({ name: 'Demotab 400 mg', dosageForm: 'Film-coated tablet' });
    // 408 + 150 + 6 mg per tablet x 1,00,000 = 56.4 kg; half the size, half the mass.
    expect(c.header.batchSizes.map((b) => [b.id, b.quantity.value])).toEqual([['BS-100000U', '56.4'], ['BS-50000U', '28.200']]);
    expect(c.bom.map((b) => [b.id, b.quantity.value])).toEqual([['BOM-API', '40.8'], ['BOM-LAC', '15'], ['BOM-MGS', '0.6'], ['BOM-IPA', '12.5']]);
    const report = valueOf(await author.call(routes.designer.validate, { body: { versionId: v.versionId, content: v.content } }));
    const errors = report.findings.filter((f) => f.severity === 'ERROR');
    expect(errors.map((f) => `${f.rule}: ${f.message}`)).toEqual([]);
    expect(report.gate.errors).toBe(0);
    expect(report.findings.filter((f) => f.severity === 'WARNING').map((f) => `${f.rule}: ${f.message}`)).toEqual([]);
    expect(report.gate.passed).toBe(true);
    expect(JSON.stringify(v.content)).toContain('"type":"TB-07"');
    const sim = valueOf(await author.call(routes.designer.simulate, { params: { versionId: v.versionId }, body: {} }));
    expect(sim.problems.map((p) => p.message)).toEqual([]);
    expect(sim.passed).toBe(true);
  }, 120_000);

  it('[PR-01] a blank start keeps the header and the bill of materials and leaves the steps to the author; the template path still refuses a formula that is not the template\'s', async () => {
    const v = valueOf(await create('DMT7JF-BL', 'BLANK', { formulaVersionId: otherVersionId }));
    const report = valueOf(await author.call(routes.designer.validate, { body: { versionId: v.versionId, content: v.content } }));
    expect(report.gate.passed).toBe(false);
    expect((v.content as unknown as { bom: unknown[] }).bom).toHaveLength(4);
    const t = await author.call(routes.designer.createFamily, { body: { templateId: 'dc-mini', familyCode: 'DMT7JF-T', product: PRODUCT, batchSizes: [{ quantity: '56.4', unit: 'kg' }], markets: ['IN'], formulaVersionId } });
    expect(refusalOf(t).code).toBe('DESIGNER_FORMULA_TEMPLATE');
    const none = await author.call(routes.designer.createFamily, { body: { familyCode: 'DMT7JF-N', product: PRODUCT, batchSizes: [{ quantity: '1', unit: 'kg' }], markets: ['IN'] } });
    expect(refusalOf(none).code).toBe('DESIGNER_FORMULA_REQUIRED');
  });

  it('a copy needs an approved master version: a draft is refused', async () => {
    const draft = valueOf(await author.call(routes.designer.families)).families.find((f) => f.familyCode === 'DMT7JF-BL')?.versions[0]?.versionId ?? '';
    expect(refusalOf(await create('DMT7JF-CP', 'COPY', { copyOfVersionId: draft, formulaVersionId: otherVersionId })).code).toBe('DESIGNER_COPY_NOT_APPROVED');
  });
});
