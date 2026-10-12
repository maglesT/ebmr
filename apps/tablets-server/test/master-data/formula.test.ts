/**
 * The company formulation library on the GMP server (Phase 3 slice 6a; decision 0006 part 1; D-S6-3, D-S6-4; recipe-core
 * 0640): formulas per product, strength and batch size, versions written by the steward with every batch quantity
 * computed by the database, approved by a second person through the ceremony; the composition read only with
 * FORMULA.READ, by route and in the database; "Choose a product" writes an MBR's BOM from an approved version and the
 * database pins it; the MBR's approval refuses a pinned formula version that is not APPROVED. Each database rule is
 * tried as the application role, with the person's own session, and bypassed directly where the privileges allow.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type FormulaLineInput } from '@ebmr/api-contract';
import { terminalOf } from '@ebmr/test-kit';
import { withCommand } from '@ebmr/kernel';
import { lifecycle } from '@ebmr/recipe-core';
import { actorOfBrowser, refusalOf, sessionOfBrowser, startSigningServer, valueOf } from '../esig/support.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { grantedPerson, loginOf } from '../support/granted-person.ts';
import { gmpLifecycleWorld } from '../support/gmp-world.ts';
import { confirmErpPending, signAction } from '../support/signed-acts.ts';

let gmp: TestServer;
let steward: TestBrowser;
let approver: TestBrowser;
let author: TestBrowser;
/** A person without FORMULA.READ on an office PC: the batch issuer (D-S6-4). */
let outsider: TestBrowser;

const md = routes.masterData;
/** One product per test (an MBR family is unique per product, strength and batch sizes). */
const prod = (tag: string) => ({ code: `PCM500${tag}`, name: `Paracetamol tablets IP 500 mg (${tag})`, strength: '500 mg' });
const PRODUCT = prod('A');

/** The dc-mini template's materials, per unit, for 100000 tablets: 50 kg + 9.4 kg + 0.6 kg = 60 kg (its reference batch size). */
const LINES: FormulaLineInput[] = [
  { lineId: 'api', materialCode: 'MAT-PCM', role: 'ACTIVE', basis: 'PER_UNIT', quantity: '500', potencyAdjusted: false, compensating: false },
  { lineId: 'mcc', materialCode: 'MAT-MCC', role: 'EXCIPIENT', basis: 'PER_UNIT', quantity: '94', potencyAdjusted: false, compensating: false },
  { lineId: 'mgs', materialCode: 'MAT-MGS', role: 'EXCIPIENT', basis: 'PER_UNIT', quantity: '6', potencyAdjusted: false, compensating: false },
];

async function importMasters(): Promise<void> {
  const erp = gmp.seed.services.find((s) => s.key === 'erpInterface');
  if (!erp) throw new Error('no ERP interface in the GMP seed');
  const material = (code: string, name: string, kind: 'API' | 'EXCIPIENT') => ({ materialCode: code, materialName: name, materialKind: kind, unit: 'kg', maxRetestMonths: 24, erpReference: `SAP-${code}` });
  const catalogue = {
    products: [
      ...['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((t) => ({ productCode: prod(t).code, strength: prod(t).strength, productName: prod(t).name, betaLactam: false, shelfLifeMonths: 36, erpReference: `SAP-FG-${prod(t).code}` })),
      { productCode: 'IBU400', strength: '400 mg', productName: 'Ibuprofen tablets IP 400 mg', betaLactam: false, shelfLifeMonths: 36, erpReference: 'SAP-FG-IBU400' },
    ],
    materials: [material('MAT-PCM', 'Paracetamol IP', 'API'), material('MAT-MCC', 'Microcrystalline cellulose', 'EXCIPIENT'), material('MAT-MGS', 'Magnesium stearate', 'EXCIPIENT'),
      material('MAT-SALT', 'Active as hydrochloride', 'API')],
    orders: [],
  };
  const creds = { loginName: erp.loginName, serviceKey: erp.serviceKey, fingerprint: terminalOf(gmp.seed, erp.terminal).fingerprint };
  valueOf(await gmp.browser().call(routes.quality.erpImport, { body: { ...creds, catalogue } }));
  await confirmErpPending(gmp);
}

async function newFormula(units: string, product = PRODUCT): Promise<string> {
  return valueOf(await steward.call(md.createFormula, { body: { productCode: product.code, strength: product.strength, batchSizeUnits: units } })).formulaId;
}

async function approvedVersion(formulaId: string, lines = LINES): Promise<string> {
  const v = valueOf(await steward.call(md.addFormulaVersion, { params: { formulaId }, body: { changeReason: 'From the registered dossier', lines } }));
  const signed = await signAction(gmp, approver, 'approver', { kind: 'MASTER_DATA_APPROVE', masterKind: 'FORMULA', versionId: v.versionId });
  if (!signed.ok) throw new Error(`SETUP: approval refused ${JSON.stringify(refusalOf(signed))}`);
  return v.versionId;
}

/** A DB call in the person's own session as the application role; the refusal text, or null when it passed. */
async function asApp(b: TestBrowser, key: string, sql: string, params: unknown[]): Promise<string | null> {
  try {
    await withCommand(gmp.db.app, await actorOfBrowser(gmp, b, key), (c) => c.query(sql, params));
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

beforeAll(async () => {
  gmp = await startSigningServer('GMP', { stub: false });
  [steward, approver, author, outsider] = await Promise.all([gmp.asPersona('steward'), gmp.asPersona('approver'), gmp.asPersona('author'), gmp.asPersona('issuer')]);
  await importMasters();
}, 300_000);
afterAll(async () => {
  await gmp?.close();
});

describe('formulation library (slice 6a)', () => {
  it('[INV-25] formula quantities are computed from the composition and the batch size, never typed', async () => {
    const formulaId = await newFormula('100000', prod('D'));
    const salted: FormulaLineInput[] = [
      { lineId: 'api', materialCode: 'MAT-SALT', role: 'ACTIVE', basis: 'PER_UNIT', quantity: '250', overagePercent: '2', saltFactor: '1.0812', potencyAdjusted: true, compensating: false },
      { lineId: 'mcc', materialCode: 'MAT-MCC', role: 'EXCIPIENT', basis: 'PER_UNIT', quantity: '94.5', potencyAdjusted: false, compensating: true },
    ];
    const v = valueOf(await steward.call(md.addFormulaVersion, { params: { formulaId }, body: { changeReason: 'Salt form, 2 % overage', lines: salted } }));
    // 250 mg x 100000 x 1.02 x 1.0812 / 10^6 = 27.5706 kg; 94.5 mg x 100000 / 10^6 = 9.45 kg.
    expect(v.lines?.map((l) => [l.lineId, l.batchQuantity, l.batchUnit])).toEqual([
      ['api', '27.5706', 'kg'],
      ['mcc', '9.45', 'kg'],
    ]);
    expect(v.state).toBe('DRAFT');
    // A typed batch quantity is no member of a line (the contract refuses it), and the database computes the rest: a
    // processing aid alone is given per batch.
    const typed = await steward.call(md.addFormulaVersion, { params: { formulaId }, body: { changeReason: 'x', lines: [{ ...LINES[0], batchQuantity: '99' } as unknown as FormulaLineInput] } });
    expect(typed.ok).toBe(false);
    const other = await newFormula('50000');
    expect(await asApp(steward, 'steward', 'select recipe.formula_add_version($1, $2::jsonb)', [other, JSON.stringify({ changeReason: 'per batch', lines: [{ ...LINES[1], basis: 'PER_BATCH', quantity: '9.4' }] })])).toMatch(/EBMR-FRM-009/);
    // Bypass: the application role writes no formula line itself.
    expect(await asApp(steward, 'steward', "insert into formulary.formula_line (version_id, line_id, ordinal, material_code, material_name, role, basis, quantity, potency_adjusted, compensating, batch_quantity_kg) values ($1, 'x', 9, 'MAT-MCC', 'x', 'EXCIPIENT', 'PER_UNIT', 1, false, false, 99)", [v.versionId])).toMatch(/permission denied/);
    expect(await asApp(steward, 'steward', 'update formulary.formula_line set batch_quantity_kg = 1 where version_id = $1', [v.versionId])).toMatch(/permission denied/);
  }, 120_000);

  it('a formula version approved by its author is refused; a second person approves it through the ceremony, and changed content signs nothing', async () => {
    const formulaId = await newFormula('200000');
    const v = valueOf(await steward.call(md.addFormulaVersion, { params: { formulaId }, body: { changeReason: 'From the dossier', lines: LINES } }));
    const own = await signAction(gmp, steward, 'steward', { kind: 'MASTER_DATA_APPROVE', masterKind: 'FORMULA', versionId: v.versionId });
    // The author is refused at signing by the database's e-signature rule (INV-03: the approver is never who entered the
    // content, EBMR-ESIG-044); recipe.formula_approve refuses the author again (EBMR-FRM-013).
    expect(refusalOf(own)?.code).toMatch(/^EBMR-(ESIG-044|FRM-013)$/);
    const tampered = await signAction(gmp, approver, 'approver', { kind: 'MASTER_DATA_APPROVE', masterKind: 'FORMULA', versionId: v.versionId }, { tamper: true });
    expect(tampered.ok).toBe(false);
    expect(valueOf(await steward.call(md.formula, { params: { formulaId } })).versions[0]?.state).toBe('DRAFT');
    expect((await signAction(gmp, approver, 'approver', { kind: 'MASTER_DATA_APPROVE', masterKind: 'FORMULA', versionId: v.versionId })).ok).toBe(true);
    const after = valueOf(await steward.call(md.formula, { params: { formulaId } }));
    expect(after.versions[0]).toMatchObject({ state: 'APPROVED', approvedBy: { loginName: 'meera.iyer' } });
    expect(after.formula.approvedVersion).toBe(1);
    // Bypass: the author's own signature handed to the database directly is refused there too, and nobody writes an approval row.
    expect(await asApp(steward, 'steward', "insert into formulary.formula_approval (version_id, signature_id, approved_by_person, approved_by_account, correlation_id) values ($1, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid())", [v.versionId])).toMatch(/permission denied/);
  }, 120_000);

  it('[DI-13] a user without FORMULA.READ cannot open a formula or the composition of an MBR, by route or in the database', async () => {
    const formulaId = await newFormula('100000');
    const versionId = await approvedVersion(formulaId);
    // The batch issuer holds no FORMULA.READ (D-S6-4): the formula's identity, never its composition.
    const seen = valueOf(await outsider.call(md.formula, { params: { formulaId } }));
    expect(seen.compositionReadable).toBe(false);
    expect(seen.versions.map((v) => v.lines)).toEqual([null]);
    expect(valueOf(await author.call(md.formula, { params: { formulaId } })).versions[0]?.lines).toHaveLength(3);
    const choice = await outsider.call(routes.designer.formulaChoice, { query: { product: PRODUCT.code, strength: PRODUCT.strength, batchSize: '100000' } });
    expect(refusalOf(choice)?.code).toBe('EBMR-IAM-040');
    expect(valueOf(await author.call(routes.designer.formulaChoice, { query: { product: PRODUCT.code, strength: PRODUCT.strength, batchSize: '100000' } })).bom).toHaveLength(3);
    // On a shop-floor kiosk the read needs no badge tap (it is no command): an operator without FORMULA.READ is refused
    // for that (EBMR-IAM-040) or shown the identity only, never asked to tap.
    const kiosk = await gmp.asPersona('operator1');
    const onKiosk = valueOf(await kiosk.call(md.formula, { params: { formulaId } }));
    expect(onKiosk.compositionReadable).toBe(false);
    expect(onKiosk.versions.map((v) => v.lines)).toEqual([null]);
    expect(valueOf(await kiosk.call(md.formulas)).formulas.map((f) => f.formulaId)).toContain(formulaId);
    expect(refusalOf(await kiosk.call(routes.designer.formulaChoice, { query: { product: PRODUCT.code, strength: PRODUCT.strength, batchSize: '100000' } }))?.code).toBe('EBMR-IAM-040');

    // The MBR taken from it: the author opens it; the batch issuer does not.
    const family = valueOf(await author.call(routes.designer.createFamily, {
      body: { templateId: 'dc-mini', familyCode: `PCM-F-${formulaId.slice(0, 6)}`, product: PRODUCT, batchSizes: [{ quantity: '60.000', unit: 'kg' }], markets: ['IN'], formulaVersionId: versionId },
    }));
    expect(valueOf(await author.call(routes.designer.version, { params: { versionId: family.versionId } })).versionId).toBe(family.versionId);
    expect(refusalOf(await outsider.call(routes.designer.version, { params: { versionId: family.versionId } }))?.code).toBe('EBMR-IAM-040');

    // In the database, as the application role in the batch issuer's own session: the readers refuse, and the
    // tables are not readable at all.
    expect(await asApp(outsider, 'issuer', 'select recipe.formula_choice($1, $2, 100000)', [PRODUCT.code, PRODUCT.strength])).toMatch(/EBMR-IAM-040.*FORMULA\.READ/);
    expect(await asApp(outsider, 'issuer', 'select recipe.mbr_composition($1)', [family.versionId])).toMatch(/EBMR-IAM-040.*FORMULA\.READ/);
    expect(await asApp(outsider, 'issuer', 'select recipe.formula_version_for_mbr($1)', [versionId])).toMatch(/EBMR-IAM-040.*FORMULA\.READ/);
    // The session's read (no command, tablets 1041) serves the identity only to a reader without FORMULA.READ.
    const { rows } = await gmp.db.app.query<{ l: unknown }>("select tab.formula_read($1, $2) -> 0 -> 'versions' -> 0 -> 'lines' as l", [(await sessionOfBrowser(gmp, outsider)).tokenHash, formulaId]);
    expect(rows[0]?.l).toBeNull();
    expect(await asApp(outsider, 'issuer', 'select recipe.formula_read($1)', [formulaId])).toMatch(/permission denied/);
    expect(await asApp(outsider, 'issuer', 'select * from formulary.formula_line', [])).toMatch(/permission denied/);
    expect(await asApp(author, 'author', 'select * from formulary.formula_line', [])).toMatch(/permission denied/);
  }, 180_000);

  it('"Choose a product" refuses a DRAFT formula version, a version of another product and a caller without FORMULA.READ', async () => {
    const P = prod('B');
    const draftFormula = await newFormula('300000', P);
    const draft = valueOf(await steward.call(md.addFormulaVersion, { params: { formulaId: draftFormula }, body: { changeReason: 'Draft', lines: LINES } })).versionId;
    const body = (formulaVersionId: string, code: string) => ({ templateId: 'dc-mini', familyCode: code, product: P, batchSizes: [{ quantity: '60.000', unit: 'kg' }], markets: ['IN'], formulaVersionId });
    expect(refusalOf(await author.call(routes.designer.createFamily, { body: body(draft, 'PCM-DRAFT') }))?.code).toBe('EBMR-FRM-016');
    const other = await approvedVersion(await newFormula('100000', { code: 'IBU400', name: 'Ibuprofen tablets IP 400 mg', strength: '400 mg' }));
    expect(refusalOf(await author.call(routes.designer.createFamily, { body: body(other, 'PCM-OTHER') }))?.code).toBe('DESIGNER_FORMULA_TEMPLATE');
    // Nothing was created by the refused requests.
    const { rows } = await gmp.db.admin.query<{ n: string }>("select count(*)::text as n from recipe.mbr_family where code in ('PCM-DRAFT', 'PCM-OTHER')");
    expect(rows[0]?.n).toBe('0');
    // A caller without FORMULA.READ: refused by the database's own check (MBR authors hold it, D-S6-4).
    expect(await asApp(outsider, 'issuer', 'select recipe.formula_version_for_mbr($1)', [other])).toMatch(/EBMR-IAM-040.*FORMULA\.READ/);
  }, 180_000);

  it('an MBR pinning a DRAFT formula cannot be approved', async () => {
    const P = prod('C');
    const formulaId = await newFormula('100000', P);
    const v1 = await approvedVersion(formulaId);
    const family = valueOf(await author.call(routes.designer.createFamily, {
      body: { templateId: 'dc-mini', familyCode: `PCM-P-${formulaId.slice(0, 6)}`, product: P, batchSizes: [{ quantity: '60.000', unit: 'kg' }], markets: ['IN'], formulaVersionId: v1 },
    }));
    const guard = async (mbr: string) =>
      (await gmp.db.admin.query<{ r: string | null }>("select recipe.guard_registered_ranges_kept('mbr_version', $1, '{}', '{}', '{}') as r", [mbr])).rows[0]?.r ?? null;
    expect(await guard(family.versionId)).toBeNull();
    // The guard is one of the MBR's APPROVE transition (registered on the machine).
    const { rows: g } = await gmp.db.admin.query<{ n: string }>("select count(*)::text as n from platform.state_guard where code = 'mbr_version.registered_ranges_kept'");
    expect(g[0]?.n).toBe('1');
    // A DRAFT pinned (only the owner can write a pin directly; the application role cannot): the approval guard refuses it.
    const draft = valueOf(await steward.call(md.addFormulaVersion, { params: { formulaId }, body: { changeReason: 'Second', lines: LINES } })).versionId;
    expect(await asApp(author, 'author', 'select recipe.formula_pin_mbr($1, $2)', [family.versionId, draft])).toMatch(/EBMR-FRM-016|EBMR-FRM-018/);
    expect(await asApp(author, 'author', "insert into formulary.mbr_formula_pin (mbr_version_id, formula_version_id, pinned_by_person, pinned_by_account, correlation_id) values ($1, $2, gen_random_uuid(), gen_random_uuid(), gen_random_uuid())", [family.versionId, draft])).toMatch(/permission denied/);
    const second = valueOf(await author.call(routes.designer.createFamily, {
      body: { templateId: 'dc-mini', familyCode: `PCM-Q-${formulaId.slice(0, 6)}`, product: P, batchSizes: [{ quantity: '30.000', unit: 'kg' }], markets: ['IN'] },
    }));
    // The owner's forged pin (superuser connection, in the author's session so the audit trail records it).
    await withCommand(gmp.db.admin, await actorOfBrowser(gmp, author, 'author'), (c) =>
      c.query(
        "insert into formulary.mbr_formula_pin (mbr_version_id, formula_version_id, pinned_by_person, pinned_by_account, correlation_id) values ($1, $2, gen_random_uuid(), gen_random_uuid(), gen_random_uuid())",
        [second.versionId, draft],
      ),
    );
    expect(await guard(second.versionId)).toMatch(/formula version this MBR pins is DRAFT, not APPROVED.*EBMR-FRM-020/);
    // Approving the second version supersedes the first: the MBR pinning version 1 is no longer approvable.
    expect((await signAction(gmp, approver, 'approver', { kind: 'MASTER_DATA_APPROVE', masterKind: 'FORMULA', versionId: draft })).ok).toBe(true);
    expect(await guard(family.versionId)).toMatch(/is SUPERSEDED, not APPROVED.*EBMR-FRM-020/);
  }, 180_000);

  it('[DI-13] the e-signature preview of a formula version, or of an MBR version pinning one, is refused to a session without FORMULA.READ, even on a shop-floor kiosk', async () => {
    const P = prod('E');
    const formulaId = await newFormula('100000', P);
    const versionId = await approvedVersion(formulaId);
    const family = valueOf(await author.call(routes.designer.createFamily, {
      body: { templateId: 'dc-mini', familyCode: `PCM-E-${formulaId.slice(0, 6)}`, product: P, batchSizes: [{ quantity: '60.000', unit: 'kg' }], markets: ['IN'], formulaVersionId: versionId },
    }));
    const kiosk = await gmp.asPersona('operator1');
    // On the kiosk the meaning is the tapping person's to hold, so only the record rule stands between the operator and the
    // composition: refused (EBMR-TAB-020, answered ESIG_PREVIEW_NOT_ALLOWED), for the formula version and for the MBR that pins it.
    const formulaPreview = await kiosk.call(routes.esig.content, { query: { aggregateType: 'formula_version', aggregateId: versionId, intent: 'FORMULA_APPROVED' } });
    expect(refusalOf(formulaPreview)?.code).toBe('ESIG_PREVIEW_NOT_ALLOWED');
    expect(JSON.stringify(refusalOf(formulaPreview))).toMatch(/FORMULA\.READ/);
    const mbrPreview = await kiosk.call(routes.esig.content, { query: { aggregateType: 'mbr_version', aggregateId: family.versionId, intent: 'APPROVED' } });
    expect(refusalOf(mbrPreview)?.code).toBe('ESIG_PREVIEW_NOT_ALLOWED');
    expect(JSON.stringify(refusalOf(mbrPreview))).toMatch(/FORMULA\.READ/);
    // The signatures of the formula version are refused the same way; the QA approver (FORMULA.READ) previews it.
    expect(refusalOf(await kiosk.call(routes.esig.signatures, { query: { aggregateType: 'formula_version', aggregateId: versionId } }))?.code).toBe('EBMR-TAB-020');
    expect(valueOf(await approver.call(routes.esig.content, { query: { aggregateType: 'formula_version', aggregateId: versionId, intent: 'FORMULA_APPROVED' } })).canonicalText).toContain('MAT-PCM');
    // In the database, as the application role, with the kiosk session's token: the preview rule names FORMULA.READ.
    const token = (await sessionOfBrowser(gmp, kiosk)).tokenHash;
    const { rows } = await gmp.db.app.query<{ p: string | null }>("select tab.signing_preview_problem($1, 'formula_version', $2, 'FORMULA_APPROVED') as p", [token, versionId]);
    expect(rows[0]?.p).toMatch(/FORMULA\.READ/);
    const problem = async (tokenHash: string, type: string, id: string, meaning: string) =>
      (await gmp.db.app.query<{ p: string | null }>('select tab.signing_preview_problem($1, $2, $3, $4) as p', [tokenHash, type, id, meaning])).rows[0]?.p ?? null;
    expect(await problem(token, 'mbr_version', family.versionId, 'APPROVED')).toMatch(/FORMULA\.READ/);
    // The QA approver (FORMULA.READ, MBR.APPROVE) passes the same rule for both records.
    const approverToken = (await sessionOfBrowser(gmp, approver)).tokenHash;
    expect(await problem(approverToken, 'formula_version', versionId, 'FORMULA_APPROVED')).toBeNull();
    expect(await problem(approverToken, 'mbr_version', family.versionId, 'APPROVED')).toBeNull();
  }, 180_000);

  it('[DI-13] FORMULA.READ is judged in the grant\'s product scope: an MBR author granted for one product reads that product\'s composition only', async () => {
    const P = prod('F');
    const ownFormula = await newFormula('100000', P);
    await approvedVersion(ownFormula);
    const otherFormula = await newFormula('400000');
    await approvedVersion(otherFormula);
    const scoped = await loginOf(gmp, await grantedPerson(gmp, 'MBR_AUTHOR', 'Scoped Author', undefined, { product: P.code }));
    const own = valueOf(await scoped.call(md.formula, { params: { formulaId: ownFormula } }));
    expect(own.compositionReadable).toBe(true);
    expect(own.versions[0]?.lines).toHaveLength(3);
    const other = valueOf(await scoped.call(md.formula, { params: { formulaId: otherFormula } }));
    expect(other.compositionReadable).toBe(false);
    expect(other.versions.map((v) => v.lines)).toEqual([null]);
    expect(valueOf(await scoped.call(routes.designer.formulaChoice, { query: { product: P.code, strength: P.strength, batchSize: '100000' } })).bom).toHaveLength(3);
    expect(refusalOf(await scoped.call(routes.designer.formulaChoice, { query: { product: PRODUCT.code, strength: PRODUCT.strength, batchSize: '100000' } }))?.code).toBe('EBMR-IAM-040');
    // The session reads in the database, as the application role: the same answers.
    const token = (await sessionOfBrowser(gmp, scoped)).tokenHash;
    const lines = async (id: string) => (await gmp.db.app.query<{ l: unknown }>("select tab.formula_read($1, $2) -> 0 -> 'versions' -> 0 -> 'lines' as l", [token, id])).rows[0]?.l;
    expect(await lines(ownFormula)).toHaveLength(3);
    expect(await lines(otherFormula)).toBeNull();
    await expect(gmp.db.app.query('select tab.formula_choice($1, $2, $3, 100000)', [token, PRODUCT.code, PRODUCT.strength])).rejects.toThrow(/EBMR-IAM-040.*FORMULA\.READ/);
  }, 180_000);

  it('[PR-06] an MBR pinning an APPROVED formula version is approved through its whole life cycle as the application role, and one whose version was superseded is not', async () => {
    // Two MBRs, each pinning the APPROVED version 1 of its own product's formula.
    const pinned = async (tag: string) => {
      const P = prod(tag);
      const formulaId = await newFormula('100000', P);
      const v1 = await approvedVersion(formulaId);
      const versionId = valueOf(await author.call(routes.designer.createFamily, {
        body: { templateId: 'dc-mini', familyCode: `PCM-${tag}-${formulaId.slice(0, 6)}`, product: P, batchSizes: [{ quantity: '60.000', unit: 'kg' }], markets: ['IN'], formulaVersionId: v1 },
      })).versionId;
      return { formulaId, versionId };
    };
    const first = (await pinned('G')).versionId;
    const h = await pinned('H');
    const second = h.versionId;
    const world = await gmpLifecycleWorld(gmp);
    const toChecked = async (versionId: string) => {
      const { content } = await lifecycle.loadContent(gmp.db.admin, versionId);
      await world.prepare(versionId, content);
      await world.startVerification(versionId);
      await world.submit(versionId);
      await world.check(versionId);
    };
    // The approval runs the guard inside the definer transition, as the application role: approved.
    await toChecked(first);
    await world.approve(first);
    expect((await world.state(first)).state).toBe('APPROVED');
    // A second formula version supersedes the first: the MBR still pinning it is refused at approval.
    await toChecked(second);
    await approvedVersion(h.formulaId);
    await expect(world.approve(second)).rejects.toThrow(/SUPERSEDED.*EBMR-FRM-020/);
    expect((await world.state(second)).state).toBe('CHECKED');
  }, 300_000);
});
