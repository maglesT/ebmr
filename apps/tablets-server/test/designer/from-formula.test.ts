/**
 * A new master record from an approved formula, without a template (Phase 7 slice 7j, R4; D-7j-5, D-7j-6): the
 * skeleton passes the validator gate with its materials pinned from the material master; the blank start keeps the
 * header and the bill of materials; a copy of an approved master takes this formula's bill; the database pins the
 * formula version; the template path still refuses a formula whose materials are not the template's.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type FormulaLineInput } from '@ebmr/api-contract';
import { terminalOf } from '@ebmr/test-kit';
import { refusalOf, startSigningServer, valueOf } from '../esig/support.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { confirmErpPending, signAction } from '../support/signed-acts.ts';
import { seedReferenceDocuments } from '../../src/features/designer/seed.ts';
import { publishTables, saveContent, stewardActor } from './support.ts';

let gmp: TestServer;
let steward: TestBrowser;
let approver: TestBrowser;
let author: TestBrowser;
let formulaVersionId = '';
let otherVersionId = '';

const md = routes.masterData;
const ERP_PRODUCT = 'DMT7JE';
const CAPSULE_PRODUCT = 'DMT7JC';
const REASON = 'In-house development product';
const PRODUCT = { code: 'DMT7JF', name: 'Demotab 400 mg', strength: '400 mg' };
const LINES: FormulaLineInput[] = [
  { lineId: 'api', materialCode: 'RM-7JF-API', role: 'ACTIVE', basis: 'PER_UNIT', quantity: '400', overagePercent: '2', overageReason: 'Loss of assay over the shelf life', potencyAdjusted: true, compensating: false },
  { lineId: 'lac', materialCode: 'RM-7JF-LAC', role: 'EXCIPIENT', basis: 'PER_UNIT', quantity: '150', potencyAdjusted: false, compensating: true },
  { lineId: 'mgs', materialCode: 'RM-7JF-MGS', role: 'EXCIPIENT', basis: 'PER_UNIT', quantity: '6', potencyAdjusted: false, compensating: false },
  { lineId: 'ipa', materialCode: 'RM-7JF-IPA', role: 'PROCESSING_AID', basis: 'PER_BATCH', quantity: '12.5', potencyAdjusted: false, compensating: false },
];

const create = (familyCode: string, start: 'SKELETON' | 'BLANK' | 'COPY', extra: Record<string, unknown> = {}) =>
  author.call(routes.designer.createFamily, { body: { familyCode, product: PRODUCT, markets: ['IN'], formulaVersionId, start, ...extra } });

async function approvedFormula(units: string, target?: { targetUnitMassMg: string; otherBatchSizesUnits: string[] }, lines = LINES, productCode = PRODUCT.code): Promise<string> {
  const { formulaId } = valueOf(await steward.call(md.createFormula, { body: { productCode, strength: PRODUCT.strength, batchSizeUnits: units } }));
  const v = valueOf(await steward.call(md.addFormulaVersion, { params: { formulaId }, body: { changeReason: REASON, lines, ...(target ? { target } : {}) } }));
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
  valueOf(await steward.call(md.enterProduct, { body: { productCode: CAPSULE_PRODUCT, strength: PRODUCT.strength, productName: 'A capsule', dosageForm: 'Hard capsule', betaLactam: false, shelfLifeMonths: 24, changeReason: REASON } }));
  // An ERP product (no dosage form: the ERP stub does not carry one) for review P7J-2.
  const erp = gmp.seed.services.find((x) => x.key === 'erpInterface');
  if (!erp) throw new Error('no ERP interface in the GMP seed');
  const creds = { loginName: erp.loginName, serviceKey: erp.serviceKey, fingerprint: terminalOf(gmp.seed, erp.terminal).fingerprint };
  const catalogue = { products: [{ productCode: ERP_PRODUCT, strength: PRODUCT.strength, productName: 'ERP-only product', betaLactam: false, shelfLifeMonths: 24, erpReference: 'SAP-FG-DMT7JE' }], materials: [], orders: [] };
  valueOf(await gmp.browser().call(routes.quality.erpImport, { body: { ...creds, catalogue } }));
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

  it('[INV-25][DI-35][PR-04] overages (slice 7q, C1): an excess per line in percent or as a quantity, always with its reason; the label claim stays; the batch quantity, the batch mass and the master\'s bill of materials include it; the approver signs it', async () => {
    const lines: FormulaLineInput[] = [
      LINES[0] as FormulaLineInput,
      LINES[1] as FormulaLineInput,
      { lineId: 'mgs', materialCode: 'RM-7JF-MGS', role: 'EXCIPIENT', basis: 'PER_UNIT', quantity: '6', overageQuantity: '0.3', overageReason: 'Loss on the blender walls', potencyAdjusted: false, compensating: false },
      { lineId: 'ipa', materialCode: 'RM-7JF-IPA', role: 'PROCESSING_AID', basis: 'PER_BATCH', quantity: '12.5', overageQuantity: '2.5', overageReason: 'Evaporation during granulation', potencyAdjusted: false, compensating: false },
    ];
    const { formulaId } = valueOf(await steward.call(md.createFormula, { body: { productCode: PRODUCT.code, strength: PRODUCT.strength, batchSizeUnits: '250000' } }));
    const refused = async (patch: Partial<FormulaLineInput>): Promise<string> => {
      const r = await steward.call(md.addFormulaVersion, { params: { formulaId }, body: { changeReason: REASON, lines: [{ ...(lines[2] as FormulaLineInput), ...patch }, LINES[0] as FormulaLineInput, LINES[1] as FormulaLineInput] } });
      return JSON.stringify(refusalOf(r));
    };
    expect(await refused({ overageReason: undefined })).toMatch(/EBMR-FRM-061.*an overage carries its reason/);
    expect(await refused({ overageQuantity: undefined })).toMatch(/EBMR-FRM-061.*an overage reason is written only with an overage above zero/);
    expect(await refused({ overagePercent: '1' })).toMatch(/EBMR-FRM-060.*in percent or as a quantity, not both/);
    expect(await refused({ overageQuantity: undefined, overagePercent: '0' })).toMatch(/EBMR-FRM-061/);
    const v = valueOf(await steward.call(md.addFormulaVersion, { params: { formulaId }, body: { changeReason: REASON, lines } }));
    // The label claim stays the quantity; the batch quantity includes the overage: (6 + 0.3) mg x 250000 = 1.575 kg;
    // 400 mg x 1.02 x 250000 = 102 kg; the processing aid 12.5 + 2.5 = 15 kg.
    expect(v.lines?.map((l) => [l.lineId, l.quantity, l.overagePercent, l.overageQuantity ?? null, l.overageReason ?? null, l.batchQuantity])).toEqual([
      ['api', '400', '2', null, 'Loss of assay over the shelf life', '102'],
      ['lac', '150', null, null, null, '37.5'],
      ['mgs', '6', null, '0.3', 'Loss on the blender walls', '1.575'],
      ['ipa', '12.5', null, '2.5', 'Evaporation during granulation', '15'],
    ]);
    // The approver signs the overage and its reason with the composition (DI-35).
    expect((await signAction(gmp, approver, 'approver', { kind: 'MASTER_DATA_APPROVE', masterKind: 'FORMULA', versionId: v.versionId })).ok).toBe(true);
    const signed = (await gmp.db.admin.query<{ c: { content: { lines: Record<string, unknown>[] } } }>('select recipe.formula_version_content($1) as c', [v.versionId])).rows[0]?.c;
    expect(signed?.content.lines.map((l) => [l['overageQuantity'] ?? null, l['overageReason'] ?? null])).toEqual([
      [null, 'Loss of assay over the shelf life'],
      [null, null],
      ['0.3', 'Loss on the blender walls'],
      ['2.5', 'Evaporation during granulation'],
    ]);
    // A line written before 1740 keeps its signed content: no new members on a line without an overage quantity or reason.
    expect(Object.keys(signed?.content.lines[1] ?? {})).not.toContain('overageReason');
    // The master from the formula: batch mass 102 + 37.5 + 1.575 = 141.075 kg; the BOM carries the overage and states it.
    const m = valueOf(await author.call(routes.designer.createFamily, { body: { familyCode: 'DMT7JF-OV', product: PRODUCT, markets: ['IN'], formulaVersionId: v.versionId, start: 'BLANK' } }));
    type Bom = { id: string; quantity: { value: string }; overage?: unknown };
    const content = m.content as unknown as { header: { batchSizes: { quantity: { value: string } }[] }; bom: Bom[] };
    expect(content.header.batchSizes[0]?.quantity.value).toBe('141.075');
    expect(content.bom.map((b) => [b.id, b.quantity.value, b.overage ?? null])).toEqual([
      ['BOM-API', '102', { reason: 'Loss of assay over the shelf life', percent: '2' }],
      ['BOM-LAC', '37.5', null],
      ['BOM-MGS', '1.575', { reason: 'Loss on the blender walls', quantity: { value: '0.3', unit: 'mg' } }],
      ['BOM-IPA', '15', { reason: 'Evaporation during granulation', quantity: { value: '2.5', unit: 'kg' } }],
    ]);
    const problem = async (versionId: string) =>
      (await gmp.db.admin.query<{ r: string | null }>('select recipe.formula_mbr_problem($1, $2) as r', [versionId, v.versionId])).rows[0]?.r ?? null;
    expect(await problem(m.versionId)).toBeNull();
    // The database refuses a master whose bill states another overage than the formula, or drops it (D-7q-2).
    const changed = structuredClone(m.content) as unknown as { bom: Bom[] };
    (changed.bom[2] as Bom).overage = { reason: 'Something else', quantity: { value: '0.3', unit: 'mg' } };
    const saved = valueOf(await saveContent(author, m, changed));
    expect(await problem(saved.versionId)).toMatch(/BOM line BOM-MGS \(RM-7JF-MGS\) states the overage .*Something else.*the formula line states .*Loss on the blender walls/);
    delete (changed.bom[0] as Bom).overage;
    (changed.bom[2] as Bom).overage = { reason: 'Loss on the blender walls', quantity: { value: '0.3', unit: 'mg' } };
    const second = valueOf(await saveContent(author, saved, changed));
    expect(await problem(m.versionId)).toMatch(/BOM line BOM-API \(RM-7JF-API\) states the overage none; the formula line states/);
    // Review P7Q-5: the decimals are compared as numbers: "2.0" states the formula's "2".
    const numeric = structuredClone(m.content) as unknown as { bom: Bom[]; references: { id: string; kind: string }[] };
    (numeric.bom[0] as Bom).overage = { reason: 'Loss of assay over the shelf life', percent: '2.0' };
    (numeric.bom[2] as Bom).overage = { reason: 'Loss on the blender walls', quantity: { value: '0.30', unit: 'mg' } };
    const third = valueOf(await saveContent(author, second, numeric));
    expect(await problem(third.versionId)).toBeNull();
    // Review P7Q-6: an overage on a BOM line that is not a formula line is refused, not skipped.
    const other = numeric.references.find((r) => r.kind !== 'MATERIAL');
    if (!other) throw new Error('no non-material reference');
    numeric.bom.push({ id: 'BOM-PK', material: other.id, role: 'OTHER', quantity: { value: '1', unit: 'kg' }, overage: { reason: 'Spare', percent: '1' } } as Bom & Record<string, unknown>);
    valueOf(await saveContent(author, third, numeric));
    expect(await problem(m.versionId)).toMatch(/BOM line BOM-PK .*states an overage but is not a line of the formula/);
    // A bypass: a line with an overage and no reason is refused by the table itself.
    await expect(gmp.db.admin.query("insert into formulary.formula_line (version_id, line_id, ordinal, material_code, material_name, role, basis, quantity, overage_quantity, potency_adjusted, compensating, batch_quantity_kg) values ($1, 'x', 9, 'RM-7JF-MGS', 'x', 'EXCIPIENT', 'PER_UNIT', 1, 1, false, false, 1)", [v.versionId])).rejects.toThrow(/formula_line_overage_reason/);
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

  it('[PR-01] a master from a formula takes the product name from the product master in effect and its dosage form, Tablet when the master has none; a non-tablet dosage form is refused (review P7J-2, D-7j-11)', async () => {
    const erpFormula = await approvedFormula('100000', undefined, LINES, ERP_PRODUCT);
    const v = valueOf(await author.call(routes.designer.createFamily, { body: { familyCode: 'DMT7JE-SK', product: { code: ERP_PRODUCT, name: 'typed name', strength: PRODUCT.strength }, markets: ['IN'], formulaVersionId: erpFormula, start: 'SKELETON' } }));
    expect((v.content as unknown as { header: { product: { name: string; dosageForm: string } } }).header.product).toMatchObject({ name: 'ERP-only product', dosageForm: 'Tablet' });
    const capsuleFormula = await approvedFormula('100000', undefined, LINES, CAPSULE_PRODUCT);
    const r = await author.call(routes.designer.createFamily, { body: { familyCode: 'DMT7JC-SK', product: { code: CAPSULE_PRODUCT, name: 'x', strength: PRODUCT.strength }, markets: ['IN'], formulaVersionId: capsuleFormula, start: 'SKELETON' } });
    expect(refusalOf(r).code).toBe('DESIGNER_PRODUCT_MASTER');
  });

  it('[INV-25][PR-01] with a salt factor and an overage on a potency-adjusted active the skeleton\'s quantities are the formula\'s computed ones, the database pins it and the validator passes (review P7J-3)', async () => {
    // 400 mg base x 1.1 salt x 1.02 overage = 448.8 mg per tablet; x 3,00,000 = 134.64 kg (the 0640 rule).
    const salted: FormulaLineInput[] = LINES.map((l) => (l.lineId === 'api' ? { ...l, saltFactor: '1.1' } : l));
    const fv = await approvedFormula('300000', undefined, salted);
    const v = valueOf(await create('DMT7JF-SALT', 'SKELETON', { formulaVersionId: fv }));
    const c = v.content as unknown as { bom: { id: string; quantity: { value: string } }[]; header: { batchSizes: { quantity: { value: string } }[] }; calculations: { id: string; expression: string }[]; goldenCases: { id: string; expected: Record<string, { value: string }> }[] };
    expect(c.bom.find((b) => b.id === 'BOM-API')?.quantity.value).toBe('134.64');
    // 448.8 + 150 + 6 = 604.8 mg per tablet: 181.44 kg, the formula's batch mass (the reference size the database checks).
    expect(c.header.batchSizes[0]?.quantity.value).toBe('181.44');
    expect(c.calculations.find((x) => x.id === 'actTarget')?.expression).toBe('448.8 [mg] * tabletsPerBatch');
    expect(c.goldenCases.find((g) => g.id === 'G-TARGETS')?.expected['actTarget']?.value).toBe('134.64');
    const report = valueOf(await author.call(routes.designer.validate, { body: { versionId: v.versionId, content: v.content } }));
    expect(report.findings.filter((f) => f.severity !== 'INFO').map((f) => `${f.rule}: ${f.message}`)).toEqual([]);
  });

  it('[PR-03][DI-04][INV-25] a formula material with a registered MATERIAL document is pinned to that document, the others to their material master version; the validator knows both (slice 7o, found by the R4 browser run)', async () => {
    const lines: FormulaLineInput[] = [LINES[0] as FormulaLineInput, LINES[1] as FormulaLineInput, { lineId: 'mgs', materialCode: 'MAT-MGS', role: 'EXCIPIENT', basis: 'PER_UNIT', quantity: '6', potencyAdjusted: false, compensating: false }];
    valueOf(await steward.call(md.enterMaterial, { body: { materialCode: 'MAT-MGS', materialName: 'Magnesium stearate', materialKind: 'EXCIPIENT', unit: 'kg', pharmacopoeia: 'IP', changeReason: REASON } }));
    await confirmErpPending(gmp);
    formulaVersionId = await approvedFormula('120000', undefined, lines);
    const v = valueOf(await create('DMT7JF-DOC', 'SKELETON'));
    const refs = (v.content as unknown as { references: { kind: string; code: string; version: string }[] }).references.filter((r) => r.kind === 'MATERIAL');
    expect(refs.find((r) => r.code === 'MAT-MGS')?.version).toBe('1');
    expect(refs.find((r) => r.code === 'RM-7JF-API')?.version).toMatch(/^ERP-/);
    const report = valueOf(await author.call(routes.designer.validate, { body: { versionId: v.versionId, content: v.content } }));
    expect(report.findings.filter((f) => f.rule === 'GMP-REFERENCES').map((f) => f.message)).toEqual([]);
  }, 120_000);
});
