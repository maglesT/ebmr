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
import { definitionFindings } from '../../src/features/designer/definition.ts';
import { expectedTabletCount } from '../../src/features/execution/issue-expectations.ts';
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
const SOLUTION_PRODUCT = 'DMT7JS';
const SOFTGEL_PRODUCT = 'DMT7JG';
/** C2: a hard capsule whose formula holds its empty shells (a COATING line per unit). */
const SHELLED_PRODUCT = 'DMT7JH';
const GEL_MASS_PRODUCT = 'DMT7JM';
const TWO_COAT_PRODUCT = 'DMT7JK';
const REASON = 'In-house development product';
const PRODUCT = { code: 'DMT7JF', name: 'Demotab 400 mg', strength: '400 mg' };
const LINES: FormulaLineInput[] = [
  { lineId: 'api', materialCode: 'RM-7JF-API', role: 'ACTIVE', basis: 'PER_UNIT', quantity: '400', overagePercent: '2', overageReason: 'Loss of assay over the shelf life', potencyAdjusted: true, compensating: false },
  { lineId: 'lac', materialCode: 'RM-7JF-LAC', role: 'EXCIPIENT', basis: 'PER_UNIT', quantity: '150', potencyAdjusted: false, compensating: true },
  { lineId: 'mgs', materialCode: 'RM-7JF-MGS', role: 'EXCIPIENT', basis: 'PER_UNIT', quantity: '6', potencyAdjusted: false, compensating: false },
  { lineId: 'ipa', materialCode: 'RM-7JF-IPA', role: 'PROCESSING_AID', basis: 'PER_BATCH', quantity: '12.5', potencyAdjusted: false, compensating: false },
];

type FlowLike = { header: { unitMassMg?: string; batchSizes: { id: string; quantity: { value: string; unit: string } }[] }; bom: { id: string }[] };

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
    ['RM-7JF-WAT', 'Purified water', 'EXCIPIENT'],
    ['RM-7JF-SHL', 'Empty hard gelatin capsule shells, size 0', 'EXCIPIENT'],
  ] as const) {
    valueOf(await steward.call(md.enterMaterial, { body: { materialCode: code, materialName: name, materialKind: kind, unit: 'kg', pharmacopoeia: 'IP', changeReason: REASON } }));
  }
  valueOf(await steward.call(md.enterProduct, { body: { productCode: PRODUCT.code, strength: PRODUCT.strength, productName: PRODUCT.name, dosageForm: 'Film-coated tablet', betaLactam: false, shelfLifeMonths: 24, changeReason: REASON } }));
  valueOf(await steward.call(md.enterProduct, { body: { productCode: CAPSULE_PRODUCT, strength: PRODUCT.strength, productName: 'A capsule', dosageForm: 'Hard capsule', betaLactam: false, shelfLifeMonths: 24, changeReason: REASON } }));
  valueOf(await steward.call(md.enterProduct, { body: { productCode: TWO_COAT_PRODUCT, strength: PRODUCT.strength, productName: 'A capsule with two per-unit coats', dosageForm: 'Hard gelatin capsule', betaLactam: false, shelfLifeMonths: 24, changeReason: REASON } }));
  valueOf(await steward.call(md.enterProduct, { body: { productCode: SHELLED_PRODUCT, strength: PRODUCT.strength, productName: 'A shelled capsule', dosageForm: 'Hard gelatin capsule', betaLactam: false, shelfLifeMonths: 24, changeReason: REASON } }));
  valueOf(await steward.call(md.enterProduct, { body: { productCode: GEL_MASS_PRODUCT, strength: PRODUCT.strength, productName: 'A soft gel', dosageForm: 'Soft gelatin capsule', betaLactam: false, shelfLifeMonths: 24, changeReason: REASON } }));
  valueOf(await steward.call(md.enterProduct, { body: { productCode: SOFTGEL_PRODUCT, strength: PRODUCT.strength, productName: 'A soft gel', dosageForm: 'Softgel', betaLactam: false, shelfLifeMonths: 24, changeReason: REASON } }));
  valueOf(await steward.call(md.enterProduct, { body: { productCode: SOLUTION_PRODUCT, strength: PRODUCT.strength, productName: 'An oral solution', dosageForm: 'Oral solution', betaLactam: false, shelfLifeMonths: 24, changeReason: REASON } }));
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
  it('[INV-25][PR-01][DI-05][INV-27] the skeleton takes its header, batch sizes and bill of materials from the formula (its unit mass, like the batch mass, leaves out processing aids, also per-unit ones, so the expected tablet count is the formula\'s units: R3-APP-1), pins it, blends with TB-07, runs the database-backed clearance and status steps, ends with QA\'s release for packing (H-PACK) and passes the validator gate and the simulation', async () => {
    const v = valueOf(await create('DMT7JF-SK', 'SKELETON'));
    const c = v.content as unknown as { header: { product: { dosageForm: string; name: string }; batchSizes: { id: string; quantity: { value: string } }[] }; bom: { id: string; quantity: { value: string } }[] };
    expect(c.header.product).toMatchObject({ name: 'Demotab 400 mg', dosageForm: 'Film-coated tablet' });
    // 408 + 150 + 6 mg per tablet x 1,00,000 = 56.4 kg; half the size, half the mass.
    expect(c.header.batchSizes.map((b) => [b.id, b.quantity.value])).toEqual([['BS-100000U', '56.4'], ['BS-50000U', '28.200']]);
    expect(c.bom.map((b) => [b.id, b.quantity.value])).toEqual([['BOM-API', '40.8'], ['BOM-LAC', '15'], ['BOM-MGS', '0.6'], ['BOM-IPA', '12.5']]);
    // S11b: the unit mass the sizes are computed from (408 + 150 + 6 mg), so each size's tablet count is exact at issue.
    expect((v.content as unknown as { header: { unitMassMg?: string } }).header.unitMassMg).toBe('564');
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

    // Decision 0026 S11b: the clearance and status steps are the database-backed versions a GMP batch runs, and the
    // blending stage ends with QA's release for packing (H-PACK).
    const steps: { id: string; kind: string; block?: { type: string; version: string } }[] = [];
    const visit = (n: unknown): void => {
      if (Array.isArray(n)) n.forEach(visit);
      else if (n && typeof n === 'object') {
        const o = n as { id?: string; kind?: string; block?: { type: string; version: string } };
        if (o.kind === 'phase' || o.kind === 'holdPoint') steps.push({ id: o.id ?? '', kind: o.kind, ...(o.block ? { block: o.block } : {}) });
        Object.values(o).forEach(visit);
      }
    };
    visit((v.content as unknown as { procedure: unknown }).procedure);
    const blockOf = (id: string): string => { const b = steps.find((x) => x.id === id)?.block; return b ? `${b.type}@${b.version}` : ''; };
    expect(['p-disp-clear', 'p-disp-bal', 'p-blend-clear', 'p-blend-status'].map(blockOf)).toEqual(['G-10@2', 'G-09@2', 'G-10@2', 'G-09@2']);
    expect(steps.some((x) => x.block && ['G-09@1', 'G-10@1'].includes(`${x.block.type}@${x.block.version}`))).toBe(false);
    // The weighings are the designated dispenser's, checked by a verifier (D-S11b-4).
    const signaturesOf = (id: string): unknown => { let out: unknown; const find = (n: unknown): void => { if (Array.isArray(n)) n.forEach(find); else if (n && typeof n === 'object') { const o = n as { id?: string; signatures?: unknown }; if (o.id === id) out = o.signatures; Object.values(o).forEach(find); } }; find((v.content as unknown as { procedure: unknown }).procedure); return out; };
    for (const id of ['p-disp-act', 'p-disp-exc']) expect(signaturesOf(id)).toEqual({ perform: { role: 'DISPENSER' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } });
    // The release for packing comes last, after the blend yield.
    expect(steps.map((x) => x.id).slice(-2)).toEqual(['p-blend-yield', 'H-PACK']);
    // A GMP batch defines on it: no step is one a GMP batch refuses (the designer's INFO findings), and the gate passes.
    expect(definitionFindings(v.content as never).filter((f) => f.rule === 'ENG-DEF-SANDBOX-ONLY')).toEqual([]);
    expect(report.findings.filter((f) => f.rule === 'ENG-DEF-SANDBOX-ONLY').map((f) => f.message)).toEqual([]);
    // R3-APP-1: a per-unit processing aid (100 mg of water, removed in drying) is in the bill of materials but not in
    // the unit mass or the batch mass, so the tablet count the issue expects is the formula's 1,25,000 (not 1,06,175).
    const water: FormulaLineInput = { lineId: 'wat', materialCode: 'RM-7JF-WAT', role: 'PROCESSING_AID', basis: 'PER_UNIT', quantity: '100', potencyAdjusted: false, compensating: false };
    const wet = valueOf(await create('DMT7JF-SKW', 'SKELETON', { formulaVersionId: await approvedFormula('125000', undefined, [...LINES, water]) }));
    const w = wet.content as unknown as FlowLike;
    expect(w.header.unitMassMg).toBe('564');
    expect(w.header.batchSizes.map((b) => [b.id, b.quantity.value])).toEqual([['BS-125000U', '70.5']]);
    expect(w.bom.map((b) => b.id)).toContain('BOM-WAT');
    expect(expectedTabletCount(w as never, 'BS-125000U')?.value).toBe('125000');
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

  it('[PR-01] a master from a formula takes the product name from the product master in effect and its dosage form, Tablet when the master has none; a form that is neither a tablet nor a capsule is refused (review P7J-2, D-7j-11; Capsules edition plan)', async () => {
    const erpFormula = await approvedFormula('100000', undefined, LINES, ERP_PRODUCT);
    const v = valueOf(await author.call(routes.designer.createFamily, { body: { familyCode: 'DMT7JE-SK', product: { code: ERP_PRODUCT, name: 'typed name', strength: PRODUCT.strength }, markets: ['IN'], formulaVersionId: erpFormula, start: 'SKELETON' } }));
    expect((v.content as unknown as { header: { product: { name: string; dosageForm: string } } }).header.product).toMatchObject({ name: 'ERP-only product', dosageForm: 'Tablet' });
    const solutionFormula = await approvedFormula('100000', undefined, LINES, SOLUTION_PRODUCT);
    const r = await author.call(routes.designer.createFamily, { body: { familyCode: 'DMT7JS-SK', product: { code: SOLUTION_PRODUCT, name: 'x', strength: PRODUCT.strength }, markets: ['IN'], formulaVersionId: solutionFormula, start: 'SKELETON' } });
    expect(refusalOf(r).code).toBe('DESIGNER_PRODUCT_MASTER');
  });

  it('[PR-01][INV-17] injectables plan I-0: the edition is data on the family; an injectables master starts blank from the formula of a product with an injectable dosage form, and the family list names each family\'s edition', async () => {
    const INJ = { code: 'DMT7JI', name: 'Demoject 400 mg', strength: PRODUCT.strength };
    valueOf(await steward.call(md.enterProduct, { body: { productCode: INJ.code, strength: INJ.strength, productName: INJ.name, dosageForm: 'Injection', betaLactam: false, shelfLifeMonths: 24, changeReason: REASON } }));
    await confirmErpPending(gmp);
    const injFormula = await approvedFormula('100000', undefined, LINES, INJ.code);
    const injCreate = (familyCode: string, extra: Record<string, unknown>) =>
      author.call(routes.designer.createFamily, { body: { familyCode, product: INJ, markets: ['IN'], formulaVersionId: injFormula, edition: 'injectables', ...extra } });
    const v = valueOf(await injCreate('DMT7JI-BL', { start: 'BLANK' }));
    expect((v.content as unknown as { header: { edition: string; product: { dosageForm: string } } }).header).toMatchObject({ edition: 'injectables', product: { dosageForm: 'Injection' } });
    // The tablet skeleton and the templates are tablet procedures: refused for an injectables family.
    expect(refusalOf(await injCreate('DMT7JI-SK', { start: 'SKELETON' })).code).toBe('DESIGNER_EDITION_START');
    expect(refusalOf(await injCreate('DMT7JI-T', { templateId: 'dc-mini', batchSizes: [{ quantity: '1', unit: 'kg' }] })).code).toBe('DESIGNER_EDITION_START');
    // A tablet product cannot become an injectables family, and an injectable product not a tablets one.
    const tablet = await author.call(routes.designer.createFamily, { body: { familyCode: 'DMT7JF-INJ', product: PRODUCT, markets: ['IN'], formulaVersionId: otherVersionId, start: 'BLANK', edition: 'injectables' } });
    expect(refusalOf(tablet).code).toBe('DESIGNER_PRODUCT_MASTER');
    expect(refusalOf(await injCreate('DMT7JI-TAB', { start: 'BLANK', edition: 'tablets' })).code).toBe('DESIGNER_PRODUCT_MASTER');
    const families = valueOf(await author.call(routes.designer.families)).families;
    expect(families.find((f) => f.familyCode === 'DMT7JI-BL')?.edition).toBe('injectables');
    expect(families.find((f) => f.familyCode === 'DMT7JF-BL')?.edition).toBe('tablets');
    const { rows } = await gmp.db.admin.query<{ edition: string }>("select edition from recipe.mbr_family where code = 'DMT7JI-BL'");
    expect(rows[0]?.edition).toBe('injectables');
  });

  it('[PR-01][INV-17] API edition plan A0: an API (substance) family starts blank from the formula of a product whose dosage form is API or Intermediate; a tablet product cannot become one, nor an API product a tablets family, and the family list and the database name the edition', async () => {
    const API = { code: 'DMT7JA', name: 'Demosubstance', strength: PRODUCT.strength };
    valueOf(await steward.call(md.enterProduct, { body: { productCode: API.code, strength: API.strength, productName: API.name, dosageForm: 'API', betaLactam: false, shelfLifeMonths: 24, changeReason: REASON } }));
    await confirmErpPending(gmp);
    const apiFormula = await approvedFormula('100000', undefined, LINES, API.code);
    const apiCreate = (familyCode: string, extra: Record<string, unknown>) =>
      author.call(routes.designer.createFamily, { body: { familyCode, product: API, markets: ['IN'], formulaVersionId: apiFormula, edition: 'substance', ...extra } });
    const v = valueOf(await apiCreate('DMT7JA-BL', { start: 'BLANK' }));
    expect((v.content as unknown as { header: { edition: string; product: { dosageForm: string } } }).header).toMatchObject({ edition: 'substance', product: { dosageForm: 'API' } });
    // The tablet skeleton, the templates and packaging copies are tablet procedures: refused for an API family.
    expect(refusalOf(await apiCreate('DMT7JA-SK', { start: 'SKELETON' })).code).toBe('DESIGNER_EDITION_START');
    expect(refusalOf(await apiCreate('DMT7JA-T', { templateId: 'dc-mini', batchSizes: [{ quantity: '1', unit: 'kg' }] })).code).toBe('DESIGNER_EDITION_START');
    // A tablet product is not an API, and an API product is not a tablet.
    const tablet = await author.call(routes.designer.createFamily, { body: { familyCode: 'DMT7JF-API', product: PRODUCT, markets: ['IN'], formulaVersionId: otherVersionId, start: 'BLANK', edition: 'substance' } });
    expect(refusalOf(tablet).code).toBe('DESIGNER_PRODUCT_MASTER');
    expect(refusalOf(tablet).why).toMatch(/neither API nor Intermediate/);
    expect(refusalOf(await apiCreate('DMT7JA-TAB', { start: 'BLANK', edition: 'tablets' })).code).toBe('DESIGNER_PRODUCT_MASTER');
    const families = valueOf(await author.call(routes.designer.families)).families;
    expect(families.find((f) => f.familyCode === 'DMT7JA-BL')?.edition).toBe('substance');
    const { rows } = await gmp.db.admin.query<{ edition: string }>("select edition from recipe.mbr_family where code = 'DMT7JA-BL'");
    expect(rows[0]?.edition).toBe('substance');
  });

  it('[PR-01][PR-37][INV-27] API plan A1a: an API processing master starts blank with QA\'s release for packing (H-PACK) in a last stage of its own, after which the author adds the synthesis stages; it is pinned to its formula', async () => {
    const API = { code: 'DMT7JB', name: 'Demosubstance B', strength: PRODUCT.strength };
    valueOf(await steward.call(md.enterProduct, { body: { productCode: API.code, strength: API.strength, productName: API.name, dosageForm: 'API', betaLactam: false, shelfLifeMonths: 24, changeReason: REASON } }));
    await confirmErpPending(gmp);
    const apiFormula = await approvedFormula('100000', undefined, LINES, API.code);
    type Node = { kind: string; id: string; body?: { children: Node[] } };
    const proc = valueOf(await author.call(routes.designer.createFamily, { body: { familyCode: 'DMT7JB-BL', product: API, markets: ['IN'], formulaVersionId: apiFormula, edition: 'substance', start: 'BLANK' } }));
    const children = (proc.content as unknown as { procedure: { body: { children: Node[] } } }).procedure.body.children;
    expect(children.map((n) => n.id)).toEqual(['S-DISP', 'S-RELEASE']);
    expect(children[1]?.body?.children.map((n) => [n.kind, n.id])).toEqual([['holdPoint', 'H-PACK']]);
    expect((await gmp.db.admin.query('select 1 from formulary.mbr_formula_pin where mbr_version_id = $1', [proc.versionId])).rowCount).toBe(1);
  });

  it('[PR-01][PR-03][INV-25] a hard-capsule product makes a master from its formula: the dosage form is the product master\'s, the dispensing targets are worded per capsule, and the validator passes; a dosage form counts as a capsule only when it says capsule, so a bare Softgel is refused (Capsules edition plan, slice C1)', async () => {
    const capsuleFormula = await approvedFormula('100000', undefined, LINES, CAPSULE_PRODUCT);
    const v = valueOf(await author.call(routes.designer.createFamily, { body: { familyCode: 'DMT7JC-SK', product: { code: CAPSULE_PRODUCT, name: 'x', strength: PRODUCT.strength }, markets: ['IN'], formulaVersionId: capsuleFormula, start: 'SKELETON' } }));
    const c = v.content as unknown as { header: { product: { name: string; dosageForm: string } }; calculations: { id: string; name: string }[]; goldenCases: { id: string; description: string }[] };
    expect(c.header.product).toMatchObject({ name: 'A capsule', dosageForm: 'Hard capsule' });
    expect(c.calculations.find((x) => x.id === 'actTarget')?.name).toMatch(/mg per capsule\)$/);
    expect(c.goldenCases.find((g) => g.id === 'G-TARGETS')?.description).toBe('Dispensing quantities for 100000 capsules');
    // C2: the batch-size input reads in capsules (its identifier is unchanged).
    expect((v.content as unknown as { inputs: { id: string; name: string }[] }).inputs.find((i) => i.id === 'tabletsPerBatch')?.name).toBe('Batch size in capsules');
    const report = valueOf(await author.call(routes.designer.validate, { body: { versionId: v.versionId, content: v.content } }));
    expect(report.findings.filter((f) => f.severity !== 'INFO').map((f) => `${f.rule}: ${f.message}`)).toEqual([]);
    // One rule everywhere (lead, 4 November): a product is a capsule only when its dosage form says "capsule". A soft gel
    // whose master says just "Softgel" is refused, and the refusal says to name it as a capsule form.
    const softgelFormula = await approvedFormula('100000', undefined, LINES, SOFTGEL_PRODUCT);
    const g = refusalOf(await author.call(routes.designer.createFamily, { body: { familyCode: 'DMT7JG-SK', product: { code: SOFTGEL_PRODUCT, name: 'x', strength: PRODUCT.strength }, markets: ['IN'], formulaVersionId: softgelFormula, start: 'SKELETON' } }));
    expect(g.code).toBe('DESIGNER_PRODUCT_MASTER');
    expect(g.why).toContain('Soft gelatin capsule');
  });

  it('[PR-03][INV-25] Capsules C6b: a soft gel\'s per-batch excipients (its gel mass: gelatin, glycerin) are taken from the formula as excipients and dispensed as "Gel mass components"; a tablet\'s per-batch processing aids keep their name (recipe-core 1875)', async () => {
    const gel: FormulaLineInput = { lineId: 'gel', materialCode: 'RM-7JF-IPA', role: 'EXCIPIENT', basis: 'PER_BATCH', quantity: '15', potencyAdjusted: false, compensating: false };
    const lines = [...LINES.filter((l) => l.basis === 'PER_UNIT'), gel];
    const f = await approvedFormula('120001', undefined, lines, GEL_MASS_PRODUCT);
    const v = valueOf(await author.call(routes.designer.createFamily, { body: { familyCode: 'DMT7JM-SK', product: { code: GEL_MASS_PRODUCT, name: 'x', strength: PRODUCT.strength }, markets: ['IN'], formulaVersionId: f, start: 'SKELETON' } }));
    const c = v.content as unknown as { bom: { id: string; role: string }[]; calculations: { id: string; name: string }[] };
    expect(c.bom.find((b) => b.id === 'BOM-GEL')?.role).toBe('EXCIPIENT');
    expect(c.calculations.find((x) => x.id === 'aidTarget')?.name).toBe('Gel mass components to dispense (per batch, scaled to the batch size)');
    // A tablet's per-batch line is still a processing aid, by name and role.
    const t = await approvedFormula('120002');
    const tv = valueOf(await author.call(routes.designer.createFamily, { body: { familyCode: 'DMT7JM-TB', product: { code: PRODUCT.code, name: 'x', strength: PRODUCT.strength }, markets: ['IN'], formulaVersionId: t, start: 'SKELETON' } }));
    const tc = tv.content as unknown as { bom: { id: string; role: string }[]; calculations: { id: string; name: string }[] };
    expect(tc.calculations.find((x) => x.id === 'aidTarget')?.name).toBe('Processing aids to dispense (per batch, scaled to the batch size)');
    expect(tc.bom.find((b) => b.id === 'BOM-IPA')?.role).toBe('PROCESSING_AID');
  }, 180_000);

  it('[PR-03][INV-25][PR-18] Capsules edition C2: a capsule\'s empty shells (its formula\'s COATING line per unit) are a bill-of-materials line of role OTHER in the unit and batch mass, not dispensed into the blend; the input reads in capsules; until a step consumes the shells line the validator names it', async () => {
    const lines: FormulaLineInput[] = [...LINES, { lineId: 'shl', materialCode: 'RM-7JF-SHL', role: 'COATING', basis: 'PER_UNIT', quantity: '96', potencyAdjusted: false, compensating: false }];
    const f = await approvedFormula('100000', undefined, lines, SHELLED_PRODUCT);
    const v = valueOf(await author.call(routes.designer.createFamily, { body: { familyCode: 'DMT7JH-SK', product: { code: SHELLED_PRODUCT, name: 'x', strength: PRODUCT.strength }, markets: ['IN'], formulaVersionId: f, start: 'SKELETON' } }));
    const c = v.content as unknown as { header: { unitMassMg: string }; bom: { id: string; role: string }[]; calculations: { id: string; name: string }[]; inputs: { id: string; name: string }[]; procedure: unknown };
    expect(c.bom.find((b) => b.id === 'BOM-SHL')?.role).toBe('OTHER');
    expect(c.bom.find((b) => b.id === 'BOM-LAC')?.role).toBe('EXCIPIENT');
    // The unit mass holds the shell (408 mg active with its overage, 150, 6 and 96 mg), as the batch mass does.
    expect(c.header.unitMassMg).toBe('660');
    // Dispensed into the blend: the excipients without the shells.
    expect(c.calculations.find((x) => x.id === 'excTarget')?.name).toBe('Other unit components to dispense (156 mg per capsule)');
    const consumed: string[] = [];
    const visit = (n: unknown): void => {
      if (Array.isArray(n)) n.forEach(visit);
      else if (n && typeof n === 'object') {
        const o = n as Record<string, unknown>;
        if (Array.isArray(o['consumes'])) consumed.push(...(o['consumes'] as string[]));
        Object.values(o).forEach(visit);
      }
    };
    visit(c.procedure);
    expect(consumed).toContain('BOM-LAC');
    expect(consumed).not.toContain('BOM-SHL');
    expect(c.inputs.find((i) => i.id === 'tabletsPerBatch')?.name).toBe('Batch size in capsules');
    const report = valueOf(await author.call(routes.designer.validate, { body: { versionId: v.versionId, content: v.content } }));
    expect(report.findings.filter((x) => x.severity === 'ERROR').map((x) => x.message)).toEqual(['BOM line BOM-SHL is never consumed by any step (GMP-BOM-CONSUMED; PR-03)']);
    // The lead's condition: the shells never collide with a coat. A second per-unit COATING line on a capsule is refused
    // (a coat on capsules is given per batch, C3).
    const twice = await approvedFormula('100000', undefined, [...lines, { lineId: 'coat', materialCode: 'RM-7JF-WAT', role: 'COATING', basis: 'PER_UNIT', quantity: '20', potencyAdjusted: false, compensating: false }], TWO_COAT_PRODUCT);
    const r = refusalOf(await author.call(routes.designer.createFamily, { body: { familyCode: 'DMT7JK-SK', product: { code: TWO_COAT_PRODUCT, name: 'x', strength: PRODUCT.strength }, markets: ['IN'], formulaVersionId: twice, start: 'SKELETON' } }));
    expect(r.code).toBe('DESIGNER_FORMULA');
    expect(r.whatHappened + r.why).toContain('2 COATING lines given per unit (shl, coat)');
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
