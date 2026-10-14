/**
 * Licences and export permissions at their boundaries (SQL mutation group "india-licences": site services 0885, 0886;
 * decision 0012). These tests close the gaps the Phase 4 focused mutation run found in test/india: the exact instants at
 * which a licence or an export permission starts and stops counting (approval, suspension, validity window), and the
 * answer for a licence that does not exist.
 *
 * Controls: IN-30 (licence basis of a batch), DI-22 (records insert-only).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SeededActor } from '../../../kernel/test/identity/seed.ts';
import {
  approveExportPermission,
  approveManufacturingLicence,
  recordExportPermission,
  recordManufacturingLicence,
  recordShelfLifeBasis,
  suspendExportPermission,
  suspendManufacturingLicence,
  type NewExportPermission,
  type NewManufacturingLicence,
} from '../../src/index.ts';
import { createTestDatabase, signerActor, signFor, type TestDatabase } from '../helpers.ts';
import { withSecondRole } from '../lots/support.ts';
import { QualityWorld, refusal, seedQualityCast, unique } from '../quality/support.ts';

let db: TestDatabase;
let w: QualityWorld;
let reg: SeededActor;
let qa: SeededActor;

beforeAll(async () => {
  db = await createTestDatabase();
  w = new QualityWorld(db, await seedQualityCast(db));
  reg = await signerActor(db, 'REGULATORY_SIGNER');
  qa = await signerActor(db, 'QA_MBR_APPROVER');
}, 300_000);
afterAll(async () => {
  await db.drop();
});

const SITE = 'SITE-1';
const licence = (productCode: string, over: Partial<NewManufacturingLicence> = {}): NewManufacturingLicence => ({
  licenceKind: 'MANUFACTURING', form: '25', licenceNumber: unique('MFG/25/'), holderName: 'Demo Pharma Ltd', holderAddress: 'Plot 7, MIDC, Pune 411019',
  validFrom: '2020-01-01T00:00:00Z', products: [{ productCode, strength: '500 mg' }], ...over,
});
async function approvedLicence(l: NewManufacturingLicence): Promise<string> {
  const id = await w.run(reg, (c) => recordManufacturingLicence(c, l));
  const sig = await signFor(db, qa, { type: 'manufacturing_licence', id }, 'LICENCE_APPROVED', 'DRAFT');
  await w.run(qa, (c) => approveManufacturingLicence(c, id, sig));
  return id;
}
const permission = (productCode: string, over: Partial<NewExportPermission> = {}): NewExportPermission => ({
  productCode, strength: '500 mg', destination: 'US', permissionNumber: unique('NOC/'), issuingAuthority: 'State Licensing Authority, Maharashtra',
  validFrom: '2020-01-01T00:00:00Z', validUntil: '2099-01-01T00:00:00Z', ...over,
});
async function approvedPermission(p: NewExportPermission): Promise<string> {
  const id = await w.run(reg, (c) => recordExportPermission(c, p));
  const sig = await signFor(db, qa, { type: 'export_permission', id }, 'EXPORT_PERMISSION_APPROVED', 'DRAFT');
  await w.run(qa, (c) => approveExportPermission(c, id, sig));
  return id;
}
/** An instant as PostgreSQL's text, moved by a number of microseconds. */
const shift = async (at: string, micros: number): Promise<string> =>
  (await db.app.query<{ t: string }>("select ($1::timestamptz + make_interval(secs => $2::double precision / 1000000))::text as t", [at, micros])).rows[0]!.t;
const current = async (id: string, at: string): Promise<boolean> =>
  (await db.app.query<{ c: boolean }>('select site.licence_current($1, $2::timestamptz) as c', [id, at])).rows[0]!.c;
const permissionAt = async (product: string, destination: string, at: string): Promise<string | null> =>
  (await db.app.query<{ id: string | null }>("select site.export_permission_current($1, $2, '500 mg', $3, $4::timestamptz) as id", [SITE, product, destination, at])).rows[0]?.id ?? null;
const instant = async (sql: string, id: string): Promise<string> => (await db.app.query<{ t: string }>(sql, [id])).rows[0]!.t;

describe('when a licence counts (site services 0885, site.licence_current)', () => {
  it('[IN-30] a licence counts from the instant of its QA approval, not a microsecond before', async () => {
    const id = await approvedLicence(licence(unique('P')));
    const approved = await instant('select approved_at::text as t from site.licence_approval where licence_id = $1', id);
    expect(await current(id, approved)).toBe(true);
    expect(await current(id, await shift(approved, -1))).toBe(false);
  });

  it('[IN-30] a suspended licence stops counting at the instant of the suspension, and counted until a microsecond before', async () => {
    const id = await approvedLicence(licence(unique('P')));
    await w.run(qa, (c) => suspendManufacturingLicence(c, id, 'Suspended by order of the licensing authority'));
    const suspended = await instant('select suspended_at::text as t from site.licence_suspension where licence_id = $1', id);
    expect(await current(id, suspended)).toBe(false);
    expect(await current(id, await shift(suspended, -1))).toBe(true);
  });

  it('[IN-30] a licence counts from the first instant of its validity and stops at the instant it lapses', async () => {
    const id = await approvedLicence(licence(unique('P'), { validFrom: '2099-01-01T00:00:00Z', validUntil: '2100-01-01T00:00:00Z' }));
    expect(await current(id, '2099-01-01T00:00:00Z')).toBe(true);
    expect(await current(id, '2098-12-31T23:59:59.999999Z')).toBe(false);
    expect(await current(id, '2099-12-31T23:59:59.999999Z')).toBe(true);
    expect(await current(id, '2100-01-01T00:00:00Z')).toBe(false);
  });

  it('[IN-30] a licence that does not exist never counts', async () => {
    expect(await current('00000000-0000-4000-8000-000000000000', '2026-01-01T00:00:00Z')).toBe(false);
  });
});

describe('when an export permission counts (site services 0885, site.export_permission_current)', () => {
  it('[IN-30] an export permission counts from its approval and from the first instant of its validity, and stops at the instant it lapses', async () => {
    const p = unique('P');
    const id = await approvedPermission(permission(p, { validFrom: '2099-01-01T00:00:00Z', validUntil: '2100-01-01T00:00:00Z' }));
    expect(await permissionAt(p, 'US', '2099-01-01T00:00:00Z')).toBe(id);
    expect(await permissionAt(p, 'US', '2098-12-31T23:59:59.999999Z')).toBeNull();
    expect(await permissionAt(p, 'US', '2099-12-31T23:59:59.999999Z')).toBe(id);
    expect(await permissionAt(p, 'US', '2100-01-01T00:00:00Z')).toBeNull();
    const q = unique('P');
    const id2 = await approvedPermission(permission(q));
    const approved = await instant('select approved_at::text as t from site.export_permission_approval where permission_id = $1', id2);
    expect(await permissionAt(q, 'US', approved)).toBe(id2);
    expect(await permissionAt(q, 'US', await shift(approved, -1))).toBeNull();
    await w.run(qa, (c) => suspendExportPermission(c, id2, 'Withdrawn by the authority'));
    const suspended = await instant('select suspended_at::text as t from site.export_permission_suspension where permission_id = $1', id2);
    expect(await permissionAt(q, 'US', suspended)).toBeNull();
    expect(await permissionAt(q, 'US', await shift(suspended, -1))).toBe(id2);
  });

  it('[IN-30] the approval and the suspension that count are the permission\'s own: another permission\'s approval does not make a draft count, another\'s suspension does not end one', async () => {
    const approved = unique('P');
    const approvedId = await approvedPermission(permission(approved));
    const suspended = unique('P');
    const suspendedId = await approvedPermission(permission(suspended));
    await w.run(qa, (c) => suspendExportPermission(c, suspendedId, 'Withdrawn by the authority'));
    const draft = unique('P');
    await w.run(reg, (c) => recordExportPermission(c, permission(draft)));
    expect(await permissionAt(draft, 'US', '2098-01-01T00:00:00Z')).toBeNull();
    expect(await permissionAt(suspended, 'US', '2098-01-01T00:00:00Z')).toBeNull();
    expect(await permissionAt(approved, 'US', '2098-01-01T00:00:00Z')).toBe(approvedId);
  });

  it('[IN-30] of two permissions in force for one product and destination, the one valid longest is the one named', async () => {
    const p = unique('P');
    await approvedPermission(permission(p, { validUntil: '2098-01-01T00:00:00Z' }));
    const longer = await approvedPermission(permission(p, { validUntil: '2099-06-01T00:00:00Z' }));
    expect(await permissionAt(p, 'US', '2097-01-01T00:00:00Z')).toBe(longer);
  });
});

describe('what a licence record must say (site services 0885, site.record_manufacturing_licence, site.india_instant)', () => {
  const rec = (p: unknown): Promise<string> =>
    refusal(w.run(reg, (c) => c.query('select site.record_manufacturing_licence($1::jsonb)', [p === null ? null : JSON.stringify(p)])));
  const base = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    licenceKind: 'MANUFACTURING', form: '25', licenceNumber: unique('MFG/25/'), holderName: 'Demo Pharma Ltd', holderAddress: 'Plot 7, MIDC, Pune 411019',
    validFrom: '2020-01-01T00:00:00Z', products: [{ productCode: unique('P'), strength: '500 mg' }], ...over,
  });
  const NAMES = /EBMR-IND-003 a licence names its kind, form, number, holder, validity and at least one endorsed product/;

  it('[IN-30] a licence record is an object naming at least one endorsed product', async () => {
    expect(await rec(null)).toMatch(NAMES);
    expect(await rec([base()])).toMatch(NAMES);
    expect(await rec(base({ products: { productCode: 'X', strength: '1 mg' } }))).toMatch(NAMES);
    expect(await rec(base({ products: [] }))).toMatch(NAMES);
  });

  it('[IN-30] a licence is of kind MANUFACTURING or LOAN', async () => {
    expect(await rec(base({ licenceKind: undefined }))).toMatch(/EBMR-IND-003 a licence is a MANUFACTURING licence/);
    expect(await rec(base({ licenceKind: 'OTHER' }))).toMatch(/EBMR-IND-003 a licence is a MANUFACTURING licence/);
  });

  it('[IN-30] each endorsed product is an object with a product code of the master\'s form and a strength', async () => {
    const PRODUCT = /EBMR-IND-006 each endorsed product names its product code and strength/;
    expect(await rec(base({ products: ['P-1'] }))).toMatch(PRODUCT);
    expect(await rec(base({ products: [{ productCode: 'lower case', strength: '500 mg' }] }))).toMatch(PRODUCT);
    expect(await rec(base({ products: [{ strength: '500 mg' }] }))).toMatch(PRODUCT);
    expect(await rec(base({ products: [{ productCode: unique('P'), strength: '  ' }] }))).toMatch(PRODUCT);
    expect(await rec(base({ products: [{ productCode: unique('P') }] }))).toMatch(PRODUCT);
  });

  it('[IN-30] the validity starts at a required ISO 8601 instant with its offset; an end, when given, is one too', async () => {
    expect(await rec(base({ validFrom: undefined }))).toMatch(/EBMR-IND-002 validFrom is required/);
    expect(await rec(base({ validFrom: 20200101 }))).toMatch(/EBMR-IND-002 validFrom is an ISO 8601 instant with its offset/);
    expect(await rec(base({ validFrom: '2020-01-01' }))).toMatch(/EBMR-IND-002 validFrom is an ISO 8601 instant with its offset/);
    expect(await rec(base({ validFrom: '2020-01-01T00:00:00' }))).toMatch(/EBMR-IND-002 validFrom is an ISO 8601 instant with its offset/);
    expect(await rec(base({ validUntil: '2030-01-01 00:00' }))).toMatch(/EBMR-IND-002 validUntil is an ISO 8601 instant with its offset/);
    const id = await w.run(reg, (c) => recordManufacturingLicence(c, licence(unique('P'), { validFrom: '2020-01-01T05:30:00+05:30' })));
    const row = (await db.app.query<{ f: string; u: string | null }>("select to_char(valid_from at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as f, valid_until::text as u from site.manufacturing_licence where id = $1", [id])).rows[0];
    expect(row).toEqual({ f: '2020-01-01 00:00', u: null });
  });

  it('[IN-30] a loan licence names both its host licence, by id, and its technical agreement', async () => {
    const host = await approvedLicence(licence(unique('H')));
    const loan = (over: Record<string, unknown>) => base({ licenceKind: 'LOAN', form: '25A', ...over });
    const BOTH = /EBMR-IND-005 a loan licence names the host manufacturing licence and the technical agreement/;
    expect(await rec(loan({ hostLicenceId: host }))).toMatch(BOTH);
    expect(await rec(loan({ hostLicenceId: host, technicalAgreement: '  ' }))).toMatch(BOTH);
    expect(await rec(loan({ technicalAgreement: 'TA-1' }))).toMatch(BOTH);
    expect(await rec(loan({ hostLicenceId: 'MFG/25/1', technicalAgreement: 'TA-1' }))).toMatch(/EBMR-IND-005 the host licence is named by its id/);
  });

  it('[IN-30] the host of a loan licence exists and is an approved, not suspended manufacturing licence', async () => {
    const HOST = /EBMR-IND-005 the host licence of a loan licence is an approved, not suspended manufacturing licence of the same site/;
    const loan = (hostLicenceId: string) => base({ licenceKind: 'LOAN', form: '25A', hostLicenceId, technicalAgreement: 'TA-1' });
    expect(await rec(loan('00000000-0000-4000-8000-000000000000'))).toMatch(HOST);
    const suspended = await approvedLicence(licence(unique('H')));
    await w.run(qa, (c) => suspendManufacturingLicence(c, suspended, 'Cancelled by the authority'));
    expect(await rec(loan(suspended))).toMatch(HOST);
    const host = await approvedLicence(licence(unique('H')));
    const loanId = await approvedLicence(licence(unique('L'), { licenceKind: 'LOAN', form: '25A', hostLicenceId: host, technicalAgreement: 'TA-1' }));
    expect(await rec(loan(loanId))).toMatch(HOST);
  });
});

describe('recording, approving and suspending a licence: the refusals (site services 0885)', () => {
  const rec = (p: unknown): Promise<string> => refusal(w.run(reg, (c) => c.query('select site.record_manufacturing_licence($1::jsonb)', [JSON.stringify(p)])));

  it('[IN-30] a licence number is recorded once; an incomplete licence or one that ends before it starts is refused with its reason', async () => {
    const l = licence(unique('P'));
    await w.run(reg, (c) => recordManufacturingLicence(c, l));
    const again = { ...l, products: l.products, licenceNumber: l.licenceNumber };
    expect(await rec(again)).toMatch(/EBMR-IND-007 licence number .* is recorded already/);
    const INCOMPLETE = /EBMR-IND-003 the licence is incomplete/;
    expect(await rec({ ...licence(unique('P')), holderName: undefined })).toMatch(INCOMPLETE);
    expect(await rec(licence(unique('P'), { validFrom: '2030-01-01T00:00:00Z', validUntil: '2029-01-01T00:00:00Z' }))).toMatch(INCOMPLETE);
  });

  it('[IN-30] an unknown licence is neither approved nor suspended', async () => {
    const none = '00000000-0000-4000-8000-000000000000';
    const sig = await signFor(db, qa, { type: 'manufacturing_licence', id: await w.run(reg, (c) => recordManufacturingLicence(c, licence(unique('P')))) }, 'LICENCE_APPROVED', 'DRAFT');
    expect(await refusal(w.run(qa, (c) => approveManufacturingLicence(c, none, sig)))).toMatch(/EBMR-IND-008 unknown licence/);
    expect(await refusal(w.run(qa, (c) => suspendManufacturingLicence(c, none, 'Cancelled')))).toMatch(/EBMR-IND-008 unknown licence/);
  });

  it('[IN-30] [DI-35] a person who recorded a licence does not approve it, even holding the approval right and another person\'s signature', async () => {
    const both = await withSecondRole(db, await signerActor(db, 'REGULATORY_SIGNER'), 'QA_REVIEWER');
    const id = await w.run({ ...both, roleCode: 'REGULATORY_SIGNER' }, (c) => recordManufacturingLicence(c, licence(unique('P'))));
    const sig = await signFor(db, qa, { type: 'manufacturing_licence', id }, 'LICENCE_APPROVED', 'DRAFT');
    expect(await refusal(w.run(both, (c) => approveManufacturingLicence(c, id, sig)))).toMatch(/EBMR-IND-010 a licence is approved by another person than its recorder/);
  });

  it('[IN-30] a loan licence whose host was suspended after it was recorded is not approved; a manufacturing licence needs no host', async () => {
    const host = await approvedLicence(licence(unique('H')));
    const loan = await w.run(reg, (c) => recordManufacturingLicence(c, licence(unique('L'), { licenceKind: 'LOAN', form: '25A', hostLicenceId: host, technicalAgreement: 'TA-3' })));
    await w.run(qa, (c) => suspendManufacturingLicence(c, host, 'Host cancelled'));
    const sig = await signFor(db, qa, { type: 'manufacturing_licence', id: loan }, 'LICENCE_APPROVED', 'DRAFT');
    expect(await refusal(w.run(qa, (c) => approveManufacturingLicence(c, loan, sig)))).toMatch(/EBMR-IND-005 the host licence of this loan licence is no longer approved/);
  });
});

describe('recording an export permission: the refusals (site services 0885, site.record_export_permission)', () => {
  const rec = (p: unknown): Promise<string> =>
    refusal(w.run(reg, (c) => c.query('select site.record_export_permission($1::jsonb)', [p === null ? null : JSON.stringify(p)])));

  it('[IN-30] an export permission is an object; its destination is a two-letter market or country code other than IN', async () => {
    const NAMES = /EBMR-IND-013 an export permission names its product, strength, destination, number, authority and validity/;
    expect(await rec(null)).toMatch(NAMES);
    expect(await rec([permission(unique('P'))])).toMatch(NAMES);
    const DEST = /EBMR-IND-013 the destination of an export permission is a market or country code other than IN/;
    expect(await rec(permission(unique('P'), { destination: 'IN' }))).toMatch(DEST);
    expect(await rec(permission(unique('P'), { destination: 'usa' }))).toMatch(DEST);
    expect(await rec({ ...permission(unique('P')), destination: undefined })).toMatch(DEST);
  });

  it('[IN-30] an export permission\'s validity has a required start and a required end, as ISO 8601 instants', async () => {
    expect(await rec({ ...permission(unique('P')), validFrom: undefined })).toMatch(/EBMR-IND-002 validFrom is required/);
    expect(await rec({ ...permission(unique('P')), validUntil: undefined })).toMatch(/EBMR-IND-002 validUntil is required/);
  });

  it('[IN-30] a permission number is recorded once; an incomplete permission is refused with its reason', async () => {
    const p = permission(unique('P'));
    await w.run(reg, (c) => recordExportPermission(c, p));
    expect(await rec(p)).toMatch(/EBMR-IND-014 export permission .* is recorded already/);
    expect(await rec({ ...permission(unique('P')), issuingAuthority: undefined })).toMatch(/EBMR-IND-013 the export permission is incomplete/);
  });
});

describe('approving and suspending an export permission: the refusals (site services 0885)', () => {
  const none = '00000000-0000-4000-8000-000000000000';

  it('[IN-30] an unknown permission is neither approved nor suspended; a permission is approved once, and only an approved one is suspended, with its reason', async () => {
    const id = await w.run(reg, (c) => recordExportPermission(c, permission(unique('P'))));
    const sig = await signFor(db, qa, { type: 'export_permission', id }, 'EXPORT_PERMISSION_APPROVED', 'DRAFT');
    expect(await refusal(w.run(qa, (c) => approveExportPermission(c, none, sig)))).toMatch(/EBMR-IND-015 unknown export permission/);
    expect(await refusal(w.run(qa, (c) => suspendExportPermission(c, none, 'Withdrawn')))).toMatch(/EBMR-IND-015 unknown export permission/);
    expect(await refusal(w.run(qa, (c) => suspendExportPermission(c, id, 'Withdrawn')))).toMatch(/EBMR-IND-019 export permission .* is DRAFT; only an approved permission is suspended/);
    await w.run(qa, (c) => approveExportPermission(c, id, sig));
    expect(await refusal(w.run(qa, (c) => approveExportPermission(c, id, sig)))).toMatch(/EBMR-IND-016 export permission .* is APPROVED; it is approved once/);
    expect(await refusal(w.run(qa, (c) => suspendExportPermission(c, id, '   ')))).toMatch(/EBMR-IND-019 a suspension states its reason/);
    await w.run(qa, (c) => suspendExportPermission(c, id, 'Withdrawn by the authority'));
    expect(await refusal(w.run(qa, (c) => suspendExportPermission(c, id, 'again')))).toMatch(/EBMR-IND-019 export permission .* is SUSPENDED/);
  });

  it('[IN-30] [DI-35] the recorder of a permission does not approve it, even holding the approval right; the approval is recorded by the person who signed it', async () => {
    const both = await withSecondRole(db, await signerActor(db, 'REGULATORY_SIGNER'), 'QA_REVIEWER');
    const id = await w.run({ ...both, roleCode: 'REGULATORY_SIGNER' }, (c) => recordExportPermission(c, permission(unique('P'))));
    const sig = await signFor(db, qa, { type: 'export_permission', id }, 'EXPORT_PERMISSION_APPROVED', 'DRAFT');
    expect(await refusal(w.run(both, (c) => approveExportPermission(c, id, sig)))).toMatch(/EBMR-IND-017 an export permission is approved by another person than its recorder/);
    const qa2 = await signerActor(db, 'QA_REVIEWER');
    expect(await refusal(w.run(qa2, (c) => approveExportPermission(c, id, sig)))).toMatch(/EBMR-IND-018 the approval is recorded by the person who signed it/);
  });
});

describe('the shelf life in effect and its stability basis (site services 0886)', () => {
  it('[PR-43] a product master version is in effect from the instant it took effect; the stability basis read is the one of that product, strength and shelf life', async () => {
    const p = unique('P');
    const other = unique('P');
    for (const code of [p, other]) {
      const v = await w.sql<string>(w.cast.erp, 'select site.erp_receive_product($1::jsonb) as r', [
        JSON.stringify({ productCode: code, strength: '500 mg', productName: `Product ${code}`, betaLactam: false, shelfLifeMonths: 24, erpReference: `ERP-${code}-24` }),
      ]);
      await w.confirm('PRODUCT', v);
    }
    const effective = (await db.admin.query<{ t: string }>(
      "select x.effective_at::text as t from site.erp_master_effect x join site.erp_product e on e.id = x.version_id where x.master_kind = 'PRODUCT' and e.product_code = $1", [p])).rows[0]!.t;
    const monthsAt = async (t: string): Promise<number | null> =>
      (await db.app.query<{ m: number | null }>("select (site.erp_product_effective_at($1, '500 mg', $2::timestamptz)).shelf_life_months as m", [p, t])).rows[0]?.m ?? null;
    expect(await monthsAt(effective)).toBe(24);
    expect(await monthsAt(await shift(effective, -1))).toBeNull();

    await w.run(w.cast.qcHead, (c) => recordShelfLifeBasis(c, { productCode: p, strength: '500 mg', shelfLifeMonths: 36, stabilityReference: 'STAB-36', tentative: false }));
    const basis = async (code: string, strength: string, months: number): Promise<string | null> =>
      (await db.app.query<{ r: string | null }>('select (site.shelf_life_basis_of($1, $2, $3)).stability_reference as r', [code, strength, months])).rows[0]?.r ?? null;
    expect(await basis(p, '500 mg', 36)).toBe('STAB-36');
    expect(await basis(other, '500 mg', 36)).toBeNull();
    expect(await basis(p, '250 mg', 36)).toBeNull();
    expect(await basis(p, '500 mg', 24)).toBeNull();
  });
});

describe('recording a stability basis: the refusals (site services 0886, site.record_shelf_life_basis)', () => {
  const rec = (p: unknown): Promise<string> =>
    refusal(w.run(w.cast.qcHead, (c) => c.query('select site.record_shelf_life_basis($1::jsonb)', [p === null ? null : JSON.stringify(p)])));
  const ok = (over: Record<string, unknown> = {}) => ({ productCode: unique('P'), strength: '500 mg', shelfLifeMonths: 36, stabilityReference: 'STAB-1', tentative: false, ...over });
  const NAMES = /EBMR-IND-030 a stability basis names the product, strength, the shelf life in whole months/;

  it('[PR-43] a stability basis is an object with a whole number of months, its study and whether it is tentative', async () => {
    expect(await rec(null)).toMatch(NAMES);
    expect(await rec([ok()])).toMatch(NAMES);
    expect(await rec(ok({ shelfLifeMonths: '36' }))).toMatch(NAMES);
    expect(await rec(ok({ shelfLifeMonths: 36.5 }))).toMatch(NAMES);
    expect(await rec(ok({ shelfLifeMonths: 1000 }))).toMatch(NAMES);
    expect(await rec(ok({ tentative: 'no' }))).toMatch(NAMES);
    expect(await rec(ok({ tentative: undefined }))).toMatch(NAMES);
    expect(await rec(ok({ stabilityReference: '  ' }))).toMatch(NAMES);
    expect(await rec(ok({ stabilityReference: undefined }))).toMatch(NAMES);
  });

  it('[PR-43] a stability basis without a product code or with a shelf life outside 1 to 120 months is incomplete', async () => {
    const INCOMPLETE = /EBMR-IND-030 the stability basis is incomplete/;
    expect(await rec(ok({ productCode: undefined }))).toMatch(INCOMPLETE);
    expect(await rec(ok({ shelfLifeMonths: 0 }))).toMatch(INCOMPLETE);
    expect(await rec(ok({ shelfLifeMonths: 121 }))).toMatch(INCOMPLETE);
  });
});

describe('the signed content of a licence (site services 0885, site.manufacturing_licence_content)', () => {
  it('[IN-30] the content names the licence\'s own host (none for a manufacturing licence) and only its own endorsed products', async () => {
    const product = unique('P');
    const host = await approvedLicence(licence(product));
    const hostNumber = (await db.app.query<{ n: string }>('select licence_number as n from site.manufacturing_licence where id = $1', [host])).rows[0]!.n;
    const loanProduct = unique('L');
    const loan = await approvedLicence(licence(loanProduct, { licenceKind: 'LOAN', form: '25A', hostLicenceId: host, technicalAgreement: 'TA-9' }));
    const content = async (id: string) =>
      (await db.admin.query<{ c: { content: { host_licence_number: string | null; products: unknown[] } } }>('select site.manufacturing_licence_content($1) as c', [id])).rows[0]!.c.content;
    expect(await content(host)).toMatchObject({ host_licence_number: null, products: [{ product_code: product, strength: '500 mg' }] });
    expect(await content(loan)).toMatchObject({ host_licence_number: hostNumber, products: [{ product_code: loanProduct, strength: '500 mg' }] });
    expect((await content(loan)).products).toHaveLength(1);
  });
});

describe('why an export permission does not count at an instant (site services 0903, site.export_permission_problem)', () => {
  const problemAt = async (product: string, at: string): Promise<string | null> =>
    (await db.app.query<{ p: string | null }>("select site.export_permission_problem($1, $2, '500 mg', 'US', $3::timestamptz) as p", [SITE, product, at])).rows[0]?.p ?? null;

  it('[IN-30] within its validity but before its approval a permission "is not current", not "lapsed"; before its validity it is "valid only from"; at its end it lapsed', async () => {
    const p = unique('P');
    await approvedPermission(permission(p, { validFrom: '2020-01-01T00:00:00Z', validUntil: '2099-01-01T00:00:00Z' }));
    expect(await problemAt(p, '2020-01-01T00:00:00Z')).toMatch(/does not count at .*: it is not current \(D-6-2\)/);
    expect(await problemAt(p, '2021-06-01T00:00:00Z')).toMatch(/: it is not current \(D-6-2\)/);
    expect(await problemAt(p, '2019-12-31T23:59:59.999999Z')).toMatch(/it is valid only from 2020-01-01/);
    expect(await problemAt(p, '2099-01-01T00:00:00Z')).toMatch(/it lapsed at 2099-01-01/);
    expect(await problemAt(p, '2098-12-31T23:59:59.999999Z')).toBeNull();
  });
});

describe('why a licence does not count at an instant (site services 0885, site.licence_problem)', () => {
  const problemAt = async (product: string, at: string): Promise<string | null> =>
    (await db.app.query<{ p: string | null }>("select site.licence_problem($1, $2, '500 mg', $3::timestamptz) as p", [SITE, product, at])).rows[0]?.p ?? null;

  it('[IN-30] at the first instant of its validity a licence is not "valid only from" then; before its approval it is "not current", not "lapsed"', async () => {
    const p = unique('P');
    // Valid from 2020 to 2099, approved now: in 2020 it was within its validity but not yet approved.
    await approvedLicence(licence(p, { validFrom: '2020-01-01T00:00:00Z', validUntil: '2099-01-01T00:00:00Z' }));
    expect(await problemAt(p, '2020-01-01T00:00:00Z')).toMatch(/does not count at .*: it is not current \(IN-30/);
    expect(await problemAt(p, '2019-12-31T23:59:59.999999Z')).toMatch(/it is valid only from 2020-01-01/);
  });

  it('[IN-30] at the instant its validity ends a licence has lapsed', async () => {
    const p = unique('P');
    await approvedLicence(licence(p, { validFrom: '2020-01-01T00:00:00Z', validUntil: '2099-01-01T00:00:00Z' }));
    expect(await problemAt(p, '2099-01-01T00:00:00Z')).toMatch(/it lapsed at 2099-01-01/);
    expect(await problemAt(p, '2098-12-31T23:59:59.999999Z')).toBeNull();
  });
});
