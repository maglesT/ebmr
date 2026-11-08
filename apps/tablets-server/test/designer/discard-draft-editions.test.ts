/**
 * Demo finding D-3 in every edition (recipe-core 1878): a blank tablets, injectables and API master, made from an
 * approved formula, is discarded with the author's reason and created again under the same code; the new draft is in
 * the same family and pinned to its formula. Its own server, so its formula approvals do not share the approver's
 * signing limit (DI-19) with the from-formula suite.
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

const md = routes.masterData;
const REASON = 'In-house development product';
const STRENGTH = '400 mg';
const LINES: FormulaLineInput[] = [
  { lineId: 'api', materialCode: 'RM-D3-API', role: 'ACTIVE', basis: 'PER_UNIT', quantity: '400', potencyAdjusted: false, compensating: false },
  { lineId: 'mgs', materialCode: 'RM-D3-MGS', role: 'EXCIPIENT', basis: 'PER_UNIT', quantity: '6', potencyAdjusted: false, compensating: false },
];

beforeAll(async () => {
  gmp = await startSigningServer('GMP', { stub: false });
  await seedReferenceDocuments(gmp.db.app, await stewardActor(gmp));
  await publishTables(gmp);
  [steward, approver, author] = await Promise.all([gmp.asPersona('steward'), gmp.asPersona('approver'), gmp.asPersona('author')]);
  for (const [code, name, kind] of [
    ['RM-D3-API', 'D-3 active', 'API'],
    ['RM-D3-MGS', 'Magnesium stearate', 'EXCIPIENT'],
  ] as const) {
    valueOf(await steward.call(md.enterMaterial, { body: { materialCode: code, materialName: name, materialKind: kind, unit: 'kg', pharmacopoeia: 'IP', changeReason: REASON } }));
  }
}, 300_000);
afterAll(async () => {
  await gmp?.close();
});

describe('a discarded draft and a new start in every edition (demo finding D-3, recipe-core 1878)', () => {
  it('[PR-01][PR-05][DI-24] a blank tablets, injectables and API master is discarded with a reason and created again under the same code: the new draft is in the same family, pinned to its formula; the discarded one stays WITHDRAWN', async () => {
    for (const [code, dosageForm, edition] of [
      ['DMT7KT', 'Film-coated tablet', 'tablets'],
      ['DMT7KI', 'Injection', 'injectables'],
      ['DMT7KA', 'API', 'substance'],
    ] as const) {
      valueOf(await steward.call(md.enterProduct, { body: { productCode: code, strength: STRENGTH, productName: `D-3 ${edition}`, dosageForm, betaLactam: false, shelfLifeMonths: 24, changeReason: REASON } }));
      await confirmErpPending(gmp);
      const { formulaId } = valueOf(await steward.call(md.createFormula, { body: { productCode: code, strength: STRENGTH, batchSizeUnits: '100000' } }));
      const fv = valueOf(await steward.call(md.addFormulaVersion, { params: { formulaId }, body: { changeReason: REASON, lines: LINES } }));
      const signed = await signAction(gmp, approver, 'approver', { kind: 'MASTER_DATA_APPROVE', masterKind: 'FORMULA', versionId: fv.versionId });
      if (!signed.ok) throw new Error(`SETUP: the formula was not approved: ${JSON.stringify(signed).slice(0, 300)}`);
      const make = () => author.call(routes.designer.createFamily, { body: { familyCode: `${code}-D3`, product: { code, name: `D-3 ${edition}`, strength: STRENGTH }, markets: ['IN'], formulaVersionId: fv.versionId, edition, start: 'BLANK' } });
      const first = valueOf(await make());
      expect(refusalOf(await make()).code).toBe('DESIGNER_FAMILY_EXISTS');
      const gone = valueOf(await author.call(routes.designer.discardDraft, { params: { versionId: first.versionId }, body: { reason: { code: 'DRAFT_DISCARDED', text: `Abandoned the first ${edition} draft` } } }));
      expect(gone.state).toBe('WITHDRAWN');
      const again = valueOf(await make());
      expect(again).toMatchObject({ familyId: first.familyId, state: 'DRAFT' });
      expect(again.versionId).not.toBe(first.versionId);
      expect((await gmp.db.admin.query('select 1 from formulary.mbr_formula_pin where mbr_version_id = $1', [again.versionId])).rowCount).toBe(1);
      const { rows } = await gmp.db.admin.query<{ edition: string; n: number }>('select f.edition, count(v.id)::int as n from recipe.mbr_family f join recipe.mbr_version v on v.family_id = f.id where f.id = $1 group by f.edition', [first.familyId]);
      expect(rows).toEqual([{ edition, n: 2 }]);
    }
  }, 240_000);
});
