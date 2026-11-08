/**
 * D-5 (owner's MGL-SR-BL report, items 7 and 13): a master copied from an approved master tells its author, on the
 * draft's first revision, which names it renamed after this formula's materials and that every other name is the
 * source's, to check. Once approved, a master's intermediate is not renamed (a new version is the way to change it).
 * Its own server, so its formula approval does not share the approver's signing limit (DI-19) with other suites.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type FormulaLineInput, type VersionView } from '@ebmr/api-contract';
import type { flow } from '@ebmr/recipe-core/pure';
import { startSigningServer, valueOf } from '../esig/support.ts';
import type { TestServer } from '../support/harness.ts';
import { confirmErpPending, signAction } from '../support/signed-acts.ts';
import { gmpContent, gmpLifecycleWorld } from '../support/gmp-world.ts';
import { refusalOf } from './support.ts';

let gmp: TestServer;
const md = routes.masterData;
const REASON = 'In-house development product';
const STRENGTH = '500 mg';
// A bilayer of two actives, its line ids other than the source's (the dc-mini master's BOM-PCM).
const LINES: FormulaLineInput[] = [
  { lineId: 'met', materialCode: 'RM-D5-MET', role: 'ACTIVE', basis: 'PER_UNIT', quantity: '500', potencyAdjusted: false, compensating: false },
  { lineId: 'gli', materialCode: 'RM-D5-GLI', role: 'ACTIVE', basis: 'PER_UNIT', quantity: '2', potencyAdjusted: false, compensating: false },
  { lineId: 'mgs', materialCode: 'RM-D5-MGS', role: 'EXCIPIENT', basis: 'PER_UNIT', quantity: '6', potencyAdjusted: false, compensating: false },
];

beforeAll(async () => {
  gmp = await startSigningServer('GMP', { stub: false });
}, 600_000);
afterAll(async () => {
  await gmp?.close();
});

describe('a copied master names what it renamed, for its author to check (D-5)', () => {
  it('[PR-01][PR-03] the copy\'s first revision carries the note of what was renamed and what is the source\'s; the approved source\'s intermediate is not renamed (EBMR-RCP-021)', async () => {
    const world = await gmpLifecycleWorld(gmp);
    const source = await world.approvedVersion(gmpContent());
    const [steward, approver, author] = await Promise.all([gmp.asPersona('steward'), gmp.asPersona('approver'), gmp.asPersona('author')]);
    for (const [code, name, kind] of [
      ['RM-D5-MET', 'Metformin hydrochloride', 'API'],
      ['RM-D5-GLI', 'Glimepiride', 'API'],
      ['RM-D5-MGS', 'Magnesium stearate', 'EXCIPIENT'],
    ] as const) {
      valueOf(await steward.call(md.enterMaterial, { body: { materialCode: code, materialName: name, materialKind: kind, unit: 'kg', pharmacopoeia: 'IP', changeReason: REASON } }));
    }
    valueOf(await steward.call(md.enterProduct, { body: { productCode: 'MGL-D5', strength: STRENGTH, productName: 'Metformin and glimepiride bilayer', dosageForm: 'Film-coated tablet', betaLactam: false, shelfLifeMonths: 24, changeReason: REASON } }));
    await confirmErpPending(gmp);
    const { formulaId } = valueOf(await steward.call(md.createFormula, { body: { productCode: 'MGL-D5', strength: STRENGTH, batchSizeUnits: '100000' } }));
    const fv = valueOf(await steward.call(md.addFormulaVersion, { params: { formulaId }, body: { changeReason: REASON, lines: LINES } }));
    const signed = await signAction(gmp, approver, 'approver', { kind: 'MASTER_DATA_APPROVE', masterKind: 'FORMULA', versionId: fv.versionId });
    if (!signed.ok) throw new Error(`SETUP: the formula was not approved: ${JSON.stringify(signed).slice(0, 300)}`);

    const copy: VersionView = valueOf(
      await author.call(routes.designer.createFamily, {
        body: { familyCode: 'MGL-D5-01', product: { code: 'MGL-D5', name: 'x', strength: STRENGTH }, markets: ['IN'], formulaVersionId: fv.versionId, start: 'COPY', copyOfVersionId: source.versionId },
      }),
    );
    expect(copy.revision).toBe(1);
    expect(copy.savedNote).toMatch(/as a copy of master version .*, without a template\./);
    // The source names its active "Paracetamol" but its material document is "Paracetamol, direct-compression grade":
    // no name carries that, so nothing was renamed, and the note says every name is the source's.
    expect(copy.savedNote).toMatch(/No names were renamed: every name is the source's; check them in the draft\.$/);
    const again: VersionView = valueOf(await author.call(routes.designer.version, { params: { versionId: copy.versionId } }));
    expect(again.savedNote).toBe(copy.savedNote);

    const view: VersionView = valueOf(await author.call(routes.designer.version, { params: { versionId: source.versionId } }));
    const changed = structuredClone(view.content) as unknown as flow.MbrContent;
    const blend = changed.intermediates[0];
    if (!blend) throw new Error('SETUP: the source has no intermediate');
    blend.name = 'Renamed after approval';
    const r = await author.call(routes.designer.saveContent, { params: { versionId: source.versionId }, body: { baseRevision: view.revision, content: changed as unknown as VersionView['content'], note: 'after approval: UPDATE_INTERMEDIATE_NAME' } });
    expect(refusalOf(r).code).toBe('EBMR-RCP-021');
  }, 300_000);
});
