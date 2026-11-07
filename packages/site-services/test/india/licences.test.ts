/**
 * Phase 4 slice 6a in the database (site services 0885, 0886): manufacturing and loan licences, export permissions and
 * the stability basis of a shelf life. Proven as the application role, with its bypass attempts.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SeededActor } from '../../../kernel/test/identity/seed.ts';
import {
  approveExportPermission,
  approveManufacturingLicence,
  licenceBasis,
  licenceProblem,
  recordExportPermission,
  recordManufacturingLicence,
  recordShelfLifeBasis,
  suspendExportPermission,
  suspendManufacturingLicence,
  type NewExportPermission,
  type NewManufacturingLicence,
} from '../../src/index.ts';
import { createTestDatabase, signerActor, signFor, type TestDatabase } from '../helpers.ts';
import { QualityWorld, refusal, seedQualityCast, unique } from '../quality/support.ts';

let db: TestDatabase;
let w: QualityWorld;
let reg: SeededActor;
let qa: SeededActor;
let qa2: SeededActor;

beforeAll(async () => {
  db = await createTestDatabase();
  w = new QualityWorld(db, await seedQualityCast(db));
  reg = await signerActor(db, 'REGULATORY_SIGNER');
  qa = await signerActor(db, 'QA_MBR_APPROVER');
  qa2 = await signerActor(db, 'QA_REVIEWER');
}, 300_000);
afterAll(async () => {
  await db.drop();
});

const SITE = 'SITE-1';
const licence = (productCode: string, over: Partial<NewManufacturingLicence> = {}): NewManufacturingLicence => ({
  licenceKind: 'MANUFACTURING', form: '25', licenceNumber: unique('MFG/25/'), holderName: 'Demo Pharma Ltd', holderAddress: 'Plot 7, MIDC, Pune 411019',
  validFrom: '2020-01-01T00:00:00Z', products: [{ productCode, strength: '500 mg' }], ...over,
});
const record = (l: NewManufacturingLicence, by: SeededActor = reg) => w.run(by, (c) => recordManufacturingLicence(c, l));
async function approve(id: string, by: SeededActor = qa): Promise<void> {
  const sig = await signFor(db, by, { type: 'manufacturing_licence', id }, 'LICENCE_APPROVED', 'DRAFT');
  await w.run(by, (c) => approveManufacturingLicence(c, id, sig));
}
const problem = (product: string, strength = '500 mg') => licenceProblem(db.app, SITE, product, strength);
const permission = (productCode: string, over: Partial<NewExportPermission> = {}): NewExportPermission => ({
  productCode, strength: '500 mg', destination: 'US', permissionNumber: unique('NOC/'), issuingAuthority: 'State Licensing Authority, Maharashtra',
  validFrom: '2020-01-01T00:00:00Z', validUntil: '2099-01-01T00:00:00Z', ...over,
});
async function approvePermission(id: string, by: SeededActor = qa): Promise<void> {
  const sig = await signFor(db, by, { type: 'export_permission', id }, 'EXPORT_PERMISSION_APPROVED', 'DRAFT');
  await w.run(by, (c) => approveExportPermission(c, id, sig));
}
const exportProblem = async (product: string, destination: string): Promise<string | null> =>
  (await db.app.query<{ p: string | null }>("select site.export_permission_problem($1, $2, '500 mg', $3, clock_timestamp()) as p", [SITE, product, destination])).rows[0]?.p ?? null;

describe('manufacturing and loan licences (site services 0885)', () => {
  it('[IN-30] a manufacturing licence counts only once QA approved it under its own LICENCE_APPROVED signature; the approval is given once and recorded by its signer', async () => {
    const p = unique('P');
    expect(await problem(p)).toMatch(/no manufacturing licence .* endorses/);
    const id = await record(licence(p));
    expect(await problem(p)).toMatch(/is not approved by QA/);
    // Another QA person's signature, recorded by QA: refused.
    const sig = await signFor(db, qa2, { type: 'manufacturing_licence', id }, 'LICENCE_APPROVED', 'DRAFT');
    expect(await refusal(w.run(qa, (c) => approveManufacturingLicence(c, id, sig)))).toMatch(/EBMR-IND-011/);
    // The recorder holds no approval right; the meaning excludes the recorder in any case.
    expect(await refusal(w.run(reg, (c) => approveManufacturingLicence(c, id, sig)))).toMatch(/LICENCE\.APPROVE|EBMR-IAM/);
    await w.run(qa2, (c) => approveManufacturingLicence(c, id, sig));
    expect(await problem(p)).toBeNull();
    expect(await licenceBasis(db.app, SITE, p, '500 mg')).toMatchObject({ licenceId: id, form: '25', holderName: 'Demo Pharma Ltd' });
    const again = await signFor(db, qa, { type: 'manufacturing_licence', id }, 'LICENCE_APPROVED', 'APPROVED').catch(() => null);
    if (again) expect(await refusal(w.run(qa, (c) => approveManufacturingLicence(c, id, again)))).toMatch(/EBMR-IND-009/);
  });

  it('[IN-30] a licence does not count before its validity, after it lapsed, once suspended, nor for a product or strength it does not endorse', async () => {
    const p = unique('P');
    await approve(await record(licence(p, { validFrom: '2099-01-01T00:00:00Z' })));
    expect(await problem(p)).toMatch(/valid only from 2099-01-01/);
    const lapsed = unique('P');
    await approve(await record(licence(lapsed, { validFrom: '2019-01-01T00:00:00Z', validUntil: '2021-01-01T00:00:00Z' })));
    expect(await problem(lapsed)).toMatch(/lapsed at 2021-01-01/);
    const s = unique('P');
    const id = await record(licence(s));
    await approve(id);
    expect(await problem(s)).toBeNull();
    expect(await problem(s, '250 mg')).toMatch(/no manufacturing licence .* endorses/);
    expect(await refusal(w.run(qa, (c) => suspendManufacturingLicence(c, id, '  ')))).toMatch(/EBMR-IND-012/);
    await w.run(qa, (c) => suspendManufacturingLicence(c, id, 'Suspended by order of the licensing authority, 2026-10-01'));
    expect(await problem(s)).toMatch(/suspended or cancelled/);
    expect(await refusal(w.run(qa, (c) => suspendManufacturingLicence(c, id, 'again')))).toMatch(/EBMR-IND-012/);
  });

  it('[IN-30] a loan licence names an approved host manufacturing licence of the site and its technical agreement; a batch under it carries both licence numbers, and it stops counting with its host', async () => {
    const p = unique('P');
    const draftHost = await record(licence(unique('H')));
    const loan = (over: Partial<NewManufacturingLicence>) =>
      licence(p, { licenceKind: 'LOAN', form: '25A', holderName: 'Loan Licensee Pvt Ltd', holderAddress: '12 Ring Road, Delhi 110001', ...over });
    expect(await refusal(record(loan({ hostLicenceId: draftHost })))).toMatch(/EBMR-IND-005/);
    expect(await refusal(record(loan({ hostLicenceId: draftHost, technicalAgreement: 'TA-2026-04' })))).toMatch(/EBMR-IND-005.*approved/);
    const hostId = await record(licence(unique('H')));
    await approve(hostId);
    expect(await refusal(record(loan({ form: '25', hostLicenceId: hostId, technicalAgreement: 'TA-2026-04' })))).toMatch(/EBMR-IND-004/);
    expect(await refusal(record(licence(p, { technicalAgreement: 'TA-1' })))).toMatch(/EBMR-IND-005/);
    const loanId = await record(loan({ hostLicenceId: hostId, technicalAgreement: 'TA-2026-04' }));
    await approve(loanId);
    const basis = await licenceBasis(db.app, SITE, p, '500 mg');
    expect(basis).toMatchObject({ licenceId: hostId, loanLicenceId: loanId, loanForm: '25A', technicalAgreement: 'TA-2026-04', loanHolderName: 'Loan Licensee Pvt Ltd' });
    expect(basis?.licenceNumber).toBeTruthy();
    expect(basis?.loanLicenceNumber).toBeTruthy();
    await w.run(qa, (c) => suspendManufacturingLicence(c, hostId, 'Host licence cancelled'));
    expect(await problem(p)).toMatch(/host manufacturing licence does not count/);
  });

  it('[IN-30] the application role cannot write, change or remove a licence, an endorsement, an approval or a suspension directly; not even the owner changes one; an administrator records nothing', async () => {
    const p = unique('P');
    const id = await record(licence(p));
    for (const sql of [
      `insert into site.manufacturing_licence (site_code, licence_kind, form, licence_number, holder_name, holder_address, valid_from, recorded_by_person, recorded_by_account, correlation_id)
       values ('SITE-1', 'MANUFACTURING', '25', 'X-1', 'x', 'y', now(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
      `insert into site.licence_product values ('${id}', 'OTHER', '1 mg')`,
      `insert into site.licence_approval values ('${id}', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), now())`,
      `update site.manufacturing_licence set valid_until = null where id = '${id}'`,
      `delete from site.licence_product where licence_id = '${id}'`,
    ]) {
      expect(await refusal(db.app.query(sql))).toMatch(/permission denied/);
    }
    expect(await refusal(db.admin.query(`update site.manufacturing_licence set valid_from = '2000-01-01' where id = '${id}'`))).toMatch(/EBMR-AUDIT-004|EBMR-IND-001/);
    expect(await refusal(db.admin.query(`delete from site.licence_product where licence_id = '${id}'`))).toMatch(/EBMR-AUDIT-004|EBMR-IND-001/);
    expect(await refusal(w.run(w.cast.admin, (c) => recordManufacturingLicence(c, licence(unique('P')))))).toMatch(/administrator|EBMR-IAM/i);
    expect(await problem(p)).toMatch(/not approved/);
  });
  it('[IN-30] the licence holder\'s telephone is kept as history: a new entry supersedes the earlier one for the CoA and the basis, the earlier one stays, and the signed licence content keeps the telephone recorded with the licence', async () => {
    const p = unique('P');
    const id = await record(licence(p, { holderTelephone: '+91 20 1111 2222' }));
    await approve(id);
    const tel = (by: SeededActor, licenceId: string, t: string) =>
      w.run(by, (c) => c.query('select site.record_licence_holder_telephone($1, $2) as id', [licenceId, t]));
    // A telephone with ; or =, and an unknown licence, are refused; QA without LICENCE.RECORD is refused.
    expect(await refusal(tel(reg, id, '020 1111; x'))).toMatch(/EBMR-IND-003/);
    expect(await refusal(tel(reg, randomUUID(), '+91 20 3333 4444'))).toMatch(/EBMR-IND-008/);
    expect(await refusal(tel(qa, id, '+91 20 3333 4444'))).toMatch(/LICENCE\.RECORD|EBMR-IAM/);
    const content = async () => (await db.admin.query<{ c: { content: Record<string, unknown> } }>('select site.manufacturing_licence_content($1) as c', [id])).rows[0]!.c.content;
    const signed = await content();
    await tel(reg, id, '+91 20 3333 4444');
    expect(await licenceBasis(db.app, SITE, p, '500 mg')).toMatchObject({ licenceId: id, holderTelephone: '+91 20 3333 4444' });
    expect(await content()).toEqual(signed);
    expect(signed).toMatchObject({ holder_telephone: '+91 20 1111 2222' });
    const rows = (await db.admin.query<{ telephone: string; by: string }>(
      'select telephone, recorded_by_person::text as by from site.licence_holder_telephone where licence_id = $1 order by recorded_at, id', [id])).rows;
    expect(rows.map((r) => r.telephone)).toEqual(['+91 20 1111 2222', '+91 20 3333 4444']);
    expect(new Set(rows.map((r) => r.by))).toEqual(new Set([reg.personId]));
    // The entries are insert-only.
    expect(await refusal(db.admin.query("update site.licence_holder_telephone set telephone = '+91 20 0000 0000' where licence_id = $1", [id]))).toMatch(/EBMR-AUDIT-004|EBMR-IND-001/);
    expect(await refusal(db.admin.query('delete from site.licence_holder_telephone where licence_id = $1', [id]))).toMatch(/EBMR-AUDIT-004|EBMR-IND-001/);
    // Any way of writing the number is accepted: no format beyond the text rule of the licence content.
    await tel(reg, id, 'Tel. 020 1111 2222 ext. 12 / Fax 020 1111 2223');
    expect(await licenceBasis(db.app, SITE, p, '500 mg')).toMatchObject({ holderTelephone: 'Tel. 020 1111 2222 ext. 12 / Fax 020 1111 2223' });
  });
});

describe('export permissions (site services 0885; D-6-2)', () => {
  it('[IN-30] an export permission counts for its product, strength and destination within its validity once approved by another person than its recorder; IN needs none; suspension ends it', async () => {
    const p = unique('P');
    expect(await exportProblem(p, 'IN')).toBeNull();
    expect(await exportProblem(p, 'US')).toMatch(/no export permission .* covers/);
    expect(await refusal(w.run(reg, (c) => recordExportPermission(c, permission(p, { destination: 'IN' }))))).toMatch(/EBMR-IND-013/);
    expect(await refusal(w.run(reg, (c) => recordExportPermission(c, permission(p, { validUntil: '2019-01-01T00:00:00Z' }))))).toMatch(/EBMR-IND-013/);
    const id = await w.run(reg, (c) => recordExportPermission(c, permission(p)));
    expect(await exportProblem(p, 'US')).toMatch(/not approved by QA/);
    await approvePermission(id);
    expect(await exportProblem(p, 'US')).toBeNull();
    expect(await exportProblem(p, 'EU')).toMatch(/no export permission/);
    const lapsed = await w.run(reg, (c) => recordExportPermission(c, permission(p, { destination: 'EU', validFrom: '2019-01-01T00:00:00Z', validUntil: '2021-01-01T00:00:00Z' })));
    await approvePermission(lapsed);
    expect(await exportProblem(p, 'EU')).toMatch(/lapsed at 2021-01-01/);
    await w.run(qa, (c) => suspendExportPermission(c, id, 'Withdrawn by the authority'));
    expect(await exportProblem(p, 'US')).toMatch(/suspended or withdrawn/);
    expect(await refusal(db.app.query(`update site.export_permission set valid_until = '2100-01-01' where id = '${id}'`))).toMatch(/permission denied/);
    expect(await refusal(db.app.query(`insert into site.export_permission_approval values ('${lapsed}', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), now())`))).toMatch(/permission denied/);
  });
});

describe('the stability basis of a shelf life (site services 0886)', () => {
  it('[PR-43] a product master version that changes the shelf life takes effect only on a recorded stability basis; the version in effect at an instant is kept', async () => {
    const p = unique('P');
    const post = (months: number) =>
      w.sql<string>(w.cast.erp, 'select site.erp_receive_product($1::jsonb) as r', [
        JSON.stringify({ productCode: p, strength: '500 mg', productName: `Product ${p}`, betaLactam: false, shelfLifeMonths: months, erpReference: `ERP-${p}-${months}` }),
      ]);
    const v1 = await post(24);
    await w.confirm('PRODUCT', v1);
    const before = (await db.app.query<{ t: string }>('select clock_timestamp()::text as t')).rows[0]!.t;
    const v2 = await post(36);
    expect(await refusal(w.confirm('PRODUCT', v2))).toMatch(/EBMR-IND-031/);
    expect(await refusal(w.run(reg, (c) => recordShelfLifeBasis(c, { productCode: p, strength: '500 mg', shelfLifeMonths: 36, stabilityReference: 'STAB-1', tentative: false })))).toMatch(/SHELF_LIFE\.RECORD|EBMR-IAM/);
    expect(await refusal(w.run(w.cast.qcHead, (c) => recordShelfLifeBasis(c, { productCode: p, strength: '500 mg', shelfLifeMonths: 36, stabilityReference: ' ', tentative: false })))).toMatch(/EBMR-IND-030/);
    await w.run(w.cast.qcHead, (c) => recordShelfLifeBasis(c, { productCode: p, strength: '500 mg', shelfLifeMonths: 36, stabilityReference: 'STAB-RPT-2026-11 (long term, 25 C / 60 % RH)', tentative: false }));
    await w.confirm('PRODUCT', v2, w.cast.qaMaster2);
    const at = async (t: string): Promise<number | null> =>
      (await db.app.query<{ m: number | null }>("select (site.erp_product_effective_at($1, '500 mg', $2::timestamptz)).shelf_life_months as m", [p, t])).rows[0]?.m ?? null;
    expect(await at(before)).toBe(24);
    expect(await at('2999-01-01T00:00:00Z')).toBe(36);
    expect(await refusal(db.app.query(`insert into site.shelf_life_stability (product_code, strength, shelf_life_months, stability_reference, tentative, recorded_by_person, recorded_by_account, correlation_id)
                                       values ('${p}', '500 mg', 48, 'x', false, '${randomUUID()}', '${randomUUID()}', '${randomUUID()}')`))).toMatch(/permission denied/);
  });
});
