/**
 * Demo finding D-2 (recipe-core 1877): the same material on several formula lines makes a master in each edition. Its
 * own server, so its formula approvals do not share the approver's signing limit (DI-19) with the from-formula suite.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type FormulaLineInput } from '@ebmr/api-contract';
import { startSigningServer, valueOf } from '../esig/support.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { confirmErpPending, signAction } from '../support/signed-acts.ts';
import { seedReferenceDocuments } from '../../src/features/designer/seed.ts';
import { publishTables, stewardActor } from './support.ts';

let gmp: TestServer;
let steward: TestBrowser;
let approver: TestBrowser;
let author: TestBrowser;

const md = routes.masterData;
const REASON = 'In-house development product';
const PRODUCT = { code: 'DMT7JF', name: 'Demotab 400 mg', strength: '400 mg' };
const LINES: FormulaLineInput[] = [
  { lineId: 'api', materialCode: 'RM-7JF-API', role: 'ACTIVE', basis: 'PER_UNIT', quantity: '400', overagePercent: '2', overageReason: 'Loss of assay over the shelf life', potencyAdjusted: true, compensating: false },
  { lineId: 'lac', materialCode: 'RM-7JF-LAC', role: 'EXCIPIENT', basis: 'PER_UNIT', quantity: '150', potencyAdjusted: false, compensating: true },
  { lineId: 'mgs', materialCode: 'RM-7JF-MGS', role: 'EXCIPIENT', basis: 'PER_UNIT', quantity: '6', potencyAdjusted: false, compensating: false },
  { lineId: 'ipa', materialCode: 'RM-7JF-IPA', role: 'PROCESSING_AID', basis: 'PER_BATCH', quantity: '12.5', potencyAdjusted: false, compensating: false },
];

async function approvedFormula(units: string, lines: FormulaLineInput[], productCode = PRODUCT.code): Promise<string> {
  const { formulaId } = valueOf(await steward.call(md.createFormula, { body: { productCode, strength: PRODUCT.strength, batchSizeUnits: units } }));
  const v = valueOf(await steward.call(md.addFormulaVersion, { params: { formulaId }, body: { changeReason: REASON, lines } }));
  const signed = await signAction(gmp, approver, 'approver', { kind: 'MASTER_DATA_APPROVE', masterKind: 'FORMULA', versionId: v.versionId });
  if (!signed.ok) throw new Error(`SETUP: the formula was not approved: ${JSON.stringify(signed).slice(0, 300)}`);
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
  ] as const) {
    valueOf(await steward.call(md.enterMaterial, { body: { materialCode: code, materialName: name, materialKind: kind, unit: 'kg', pharmacopoeia: 'IP', changeReason: REASON } }));
  }
  valueOf(await steward.call(md.enterProduct, { body: { productCode: PRODUCT.code, strength: PRODUCT.strength, productName: PRODUCT.name, dosageForm: 'Film-coated tablet', betaLactam: false, shelfLifeMonths: 24, changeReason: REASON } }));
  await confirmErpPending(gmp);
}, 300_000);
afterAll(async () => {
  await gmp?.close();
});

describe('a new master from an approved formula (slice 7j)', () => {
  it('[PR-03][INV-25] demo finding D-2: the same material on several formula lines (a bilayer tablet\'s two layers, an injectable\'s water for the solution and the rinse, an API\'s solvent in two stages) makes a master in each edition: one BOM line per formula line, one material reference, pinned', async () => {
    const twice = (lines: FormulaLineInput[], dup: FormulaLineInput): FormulaLineInput[] => [...lines, { ...dup, lineId: `${dup.lineId}2`, compensating: false, quantity: '20', overagePercent: undefined, overageReason: undefined }];
    const bilayer = twice(LINES, LINES[1] as FormulaLineInput);
    const tf = await approvedFormula('130001', bilayer);
    const t = valueOf(await author.call(routes.designer.createFamily, { body: { familyCode: 'DMT7JF-BL2', product: PRODUCT, markets: ['IN'], formulaVersionId: tf, start: 'SKELETON' } }));
    type Bom = { bom: { id: string; material: string }[]; references: { id: string; kind: string; code?: string }[] };
    const tc = t.content as unknown as Bom;
    expect(tc.bom.filter((b) => b.material === tc.bom.find((x) => x.id === 'BOM-LAC')?.material).map((b) => b.id)).toEqual(['BOM-LAC', 'BOM-LAC2']);
    expect(tc.references.filter((r) => r.kind === 'MATERIAL' && r.code === 'RM-7JF-LAC')).toHaveLength(1);
    expect((await gmp.db.admin.query('select 1 from formulary.mbr_formula_pin where mbr_version_id = $1', [t.versionId])).rowCount).toBe(1);
    const report = valueOf(await author.call(routes.designer.validate, { body: { versionId: t.versionId, content: t.content } }));
    expect(report.findings.filter((f) => f.severity === 'ERROR').map((f) => `${f.rule}: ${f.message}`)).toEqual([]);
    // Injectables and API: the blank start from such a formula, pinned the same way.
    for (const [code, dosageForm, edition, dup] of [
      ['DMT7JW', 'Injection', 'injectables', { lineId: 'wat', materialCode: 'RM-7JF-WAT', role: 'EXCIPIENT', basis: 'PER_UNIT', quantity: '100', potencyAdjusted: false, compensating: false }],
      ['DMT7JX', 'API', 'substance', LINES[3] as FormulaLineInput],
    ] as const) {
      valueOf(await steward.call(md.enterProduct, { body: { productCode: code, strength: PRODUCT.strength, productName: `D-2 ${edition}`, dosageForm, betaLactam: false, shelfLifeMonths: 24, changeReason: REASON } }));
      await confirmErpPending(gmp);
      const lines = dup.lineId === 'wat' ? twice([...LINES, dup], dup) : twice(LINES, dup);
      const f = await approvedFormula('100000', lines, code);
      const v = valueOf(await author.call(routes.designer.createFamily, { body: { familyCode: `${code}-BL`, product: { code, name: 'x', strength: PRODUCT.strength }, markets: ['IN'], formulaVersionId: f, edition, start: 'BLANK' } }));
      const c = v.content as unknown as Bom;
      expect(c.bom.map((b) => b.id)).toEqual(expect.arrayContaining([`BOM-${dup.lineId.toUpperCase()}`, `BOM-${dup.lineId.toUpperCase()}2`]));
      expect(c.references.filter((r) => r.kind === 'MATERIAL' && r.code === dup.materialCode)).toHaveLength(1);
      expect((await gmp.db.admin.query('select 1 from formulary.mbr_formula_pin where mbr_version_id = $1', [v.versionId])).rowCount).toBe(1);
    }
  }, 240_000);
});
