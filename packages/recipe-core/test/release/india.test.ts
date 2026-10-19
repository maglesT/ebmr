/**
 * Phase 4 slice 6a in the database (recipe-core 0890 to 0895, site services 0885, 0886): the India gates of the GMP issue
 * (licence, export permission, hazard dedication), G-REL item 6, expiry dating, the India-domestic label particulars and
 * the Schedule H2 payload stub bound to the record, and the allocation register with the use of every number. Every act
 * runs as the application role through the definers with real e-signatures of seeded people, and each rule is tried
 * around (direct writes, an administrator, another batch's data).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withProtectedNumbers } from '../../../kernel/src/continuity/numbers.ts';
import { tempDir, tempLedger } from '../../../kernel/test/continuity/helpers.ts';
import { withCommand } from '../../../kernel/src/db/command.ts';
import { cmd } from '../../../kernel/test/esig/helpers.ts';
import { activateAccount, createAccount, createPerson, decideRoleGrant, recordIdentityVerification, requestRoleGrant } from '../../../kernel/src/identity/admin.ts';
import { seedActor, seedAdministration, seedServiceActor, withReason, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { approveTestRelease } from '../../../kernel/test/support/validation.ts';
import { withChangeRecord } from '../../../kernel/test/support/change-record.ts';
import type { MbrContent } from '../../src/flow/model.ts';
import * as execution from '../../src/execution/index.ts';
import type * as lc from '../../src/lifecycle/index.ts';
import { define, FIXTURE_INPUTS, FIXTURE_JUSTIFICATIONS } from '../engine/support.ts';
import { gmpOrderFor } from '../lifecycle/gmp-support.ts';
import { cell, reason, seedCast, uniqueContent, World } from '../lifecycle/support.ts';

let db: TestDatabase;
let w: World;
let steward: SeededActor;
let operator: SeededActor;
let warehouse: SeededActor;
let erp: SeededActor;
let admin: SeededActor;
let qcHead: SeededActor;
const dir = tempDir('india');
const ledger = tempLedger('india', dir.path);

const SITE = 'SITE-1';
const BS = 'BS-200K';
const FIXTURE = 'tablet-granulation-compression';
type Master = { familyId: string; versionId: string; content: MbrContent; product: string; strength: string };
interface Item {
  id: string;
  status: 'GREEN' | 'RED' | 'NA';
  problem: string | null;
  evidence: { kind: string; ref: string; label: string }[];
}

async function messageOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

function without(content: unknown, types: readonly string[]): unknown {
  if (Array.isArray(content)) {
    return content.filter((x) => !(x && typeof x === 'object' && types.includes(String(((x as Record<string, unknown>)['block'] as Record<string, unknown> | undefined)?.['type'])))).map((x) => without(x, types));
  }
  if (content && typeof content === 'object') return Object.fromEntries(Object.entries(content).map(([k, v]) => [k, without(v, types)]));
  return content;
}

/** An effective master authorised for `markets`, with (licensed) or without its licence and export permissions. */
async function effective(markets: string[], licensed: boolean): Promise<Master> {
  const m = uniqueContent(FIXTURE, ['EU', 'IN', 'US']);
  m.header.product = { ...m.header.product, code: m.header.product.code.toUpperCase() };
  const content = without(m, ['G-09', 'G-10']) as MbrContent;
  const v = await w.approvedVersion(content);
  w.autoLicence = licensed;
  try {
    for (const market of markets) {
      const def: lc.MarketAuthorisationDefinition = { versionId: v.versionId, market, kind: 'CURRENT', cells: [cell(SITE, 'L1', BS)], regulatoryBasis: `${market}: registration on file` };
      await w.authorise(def);
    }
  } finally {
    w.autoLicence = true;
  }
  await w.run(steward, (c) =>
    c.query('select site.define_batch_number_rule($1::jsonb)', [
      JSON.stringify({ rule_code: `R-${randomUUID().slice(0, 8).toUpperCase()}`, site_code: SITE, product_code: content.header.product.code, batch_kind: 'PROCESSING', format: 'N{YY}{SEQ:5}', site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3' }),
    ]),
  );
  const f = (await db.app.query<{ s: string }>('select strength as s from recipe.mbr_family where id = $1', [v.familyId])).rows[0]!.s;
  return { familyId: v.familyId, versionId: v.versionId, content, product: content.header.product.code, strength: f };
}

/** Records the licence holder's US e-signature certification letter for `m` (DI-15; recipe-core 1260). */
async function recordUsCertification(m: Master): Promise<void> {
  const holder = (await db.app.query<{ h: string | null }>("select site.licence_basis($1, $2, $3, clock_timestamp()) ->> 'holderName' as h", [SITE, m.product, m.strength])).rows[0]?.h;
  if (!holder) throw new Error('the licence of the test master names no holder');
  const { owner } = await seedAdministration(db);
  await withCommand(db.app, withReason(owner), (c) => c.query("select iam.record_us_esig_certification($1, 'LTR-TEST-11.100C', date '2026-03-01')", [holder]));
}

/** Plans batch `batchId` of `m` for `markets` (number from the register). */
async function plan(m: Master, markets: string[]): Promise<string> {
  const batchId = randomUUID();
  const erpOrder = await gmpOrderFor(db, erp, m.content, BS);
  await cmd(db, w.cast.issuer).then((ctx) =>
    withProtectedNumbers(db.app, ctx, ledger, (c) => execution.prepareGmpIssue(c, batchId, { familyId: m.familyId, markets, site: SITE, line: 'L1', batchSize: BS, erpOrder })),
  );
  return batchId;
}

const issueSignatures = new Map<string, string>();
/** Issues planned batch `batchId`; a refused attempt keeps the issuer's ISSUED signature for the next one. */
async function issue(batchId: string): Promise<string> {
  const signatureId = issueSignatures.get(batchId) ?? (await w.sign(w.cast.issuer, 'batch_issue', batchId, 'ISSUED', 'PLANNED'));
  issueSignatures.set(batchId, signatureId);
  await w.run(
    w.cast.issuer,
    (c) =>
      execution.issueGmpBatch(c, {
        batchId,
        signatureId,
        define: (x) => define(x, { installation: 'GMP', justifications: FIXTURE_JUSTIFICATIONS }),
        request: { inputs: FIXTURE_INPUTS[FIXTURE], issuedBy: { id: w.cast.issuer.personId, kind: 'PERSON', roles: [] } },
      }),
    reason('batch issued for the test'),
  );
  return batchId;
}

async function finishedLot(b: string, m: Master, markets: string[]): Promise<string> {
  const number = (await db.app.query<{ n: string }>('select batch_number as n from recipe.batch_execution where id = $1', [b])).rows[0]!.n;
  return withCommand(db.admin, await cmd(db, warehouse), async (c) =>
    (await c.query<{ id: string }>('select site.create_finished_lot($1::jsonb) as id', [
      JSON.stringify({ batchId: b, batchNumber: number, edition: 'TABLETS', siteCode: SITE, productCode: m.product, productName: 'India test product',
                       strength: m.strength, markets, quantity: '1000', unit: 'units', expiresAt: '2029-06-30T23:59:59Z' }),
    ])).rows[0]!.id,
  );
}

const sqlAs = async <T>(who: SeededActor, text: string, params: unknown[] = []): Promise<T> =>
  w.run(who, async (c) => ((await c.query(text, params)).rows[0] as { r: T } | undefined)?.r as T);

/** QA (the first approver of the cast) records a product's hazard class; the record id. */
const classify = (product: string, hazardClass: string, ref: string): Promise<string> =>
  sqlAs<string>(w.cast.qa, 'select plant.record_product_hazard($1::jsonb) as r', [JSON.stringify({ productCode: product, hazardClass, riskAssessmentRef: ref })]);
/** QA records a dedication (or its withdrawal) of line L1; the record id. */
const dedicate = (dedicated: boolean, hazardClass = 'CYTOTOXIC'): Promise<string> =>
  sqlAs<string>(w.cast.qa, 'select plant.record_area_dedication($1::jsonb) as r', [JSON.stringify({ areaCode: 'L1', hazardClass, dedicated, breathingAir: 'BACKED_UP', justification: 'Contained line, isolator and 100 % breathing-air back-up' })]);
/** A second QA person (by default) approves a hazard record under its own signature (recipe-core 0912). */
async function approve(type: 'hazard_classification' | 'area_dedication', id: string, who: SeededActor = w.cast.qa2): Promise<void> {
  const meaning = type === 'hazard_classification' ? 'HAZARD_CLASSIFICATION_APPROVED' : 'AREA_DEDICATION_APPROVED';
  const sig = await w.sign(who, type, id, meaning, 'RECORDED');
  await w.run(who, (c) => c.query(type === 'hazard_classification' ? 'select plant.approve_product_hazard($1, $2)' : 'select plant.approve_area_dedication($1, $2)', [id, sig]));
}
/** Line L1 as plant master data (written as the superuser inside a command: the plant master-data route is not under test). */
async function line(): Promise<void> {
  await withCommand(db.admin, await cmd(db, steward), (c) =>
    c.query("insert into plant.area (code, kind, name, segregated, negative_pressure, recorded_by) values ('L1', 'LINE', 'Line 1', false, true, gen_random_uuid()) on conflict (code) do nothing"));
}
const recordLicence = (p: Record<string, unknown>): Promise<string> => sqlAs(w.cast.regulatory, 'select site.record_manufacturing_licence($1::jsonb) as r', [JSON.stringify(p)]);
async function approveLicence(id: string): Promise<void> {
  const sig = await w.sign(w.cast.qa, 'manufacturing_licence', id, 'LICENCE_APPROVED', 'DRAFT');
  await w.run(w.cast.qa, (c) => c.query('select site.approve_manufacturing_licence($1, $2)', [id, sig]));
}
const licence = (m: Master, over: Record<string, unknown> = {}) => ({
  licenceKind: 'MANUFACTURING', form: '25', licenceNumber: `MFG-${randomUUID().slice(0, 8).toUpperCase()}`, holderName: 'Deccan Pharma Ltd',
  holderAddress: 'Plot 7, MIDC Bhosari, Pune 411026', validFrom: '2020-01-01T00:00:00Z', products: [{ productCode: m.product, strength: m.strength }], ...over,
});
const grelItem = async (lotId: string, market: string): Promise<Item> =>
  (await db.app.query<{ g: { items: Item[] } }>('select recipe.grel_evaluate($1, $2) as g', [lotId, market])).rows[0]!.g.items.find((i) => i.id === 'G6.LICENCE')!;

/** Posts the product master of `m` with `months` of shelf life as the ERP and confirms it as QA (site services 0802). */
async function productMaster(m: Master, months: number): Promise<void> {
  const id = await sqlAs<string>(erp, 'select site.erp_receive_product($1::jsonb) as r', [
    JSON.stringify({ productCode: m.product, strength: m.strength, productName: `Product ${m.product}`, betaLactam: false, shelfLifeMonths: months, erpReference: `ERP-${m.product}-${months}` }),
  ]);
  const state = (await db.app.query<{ s: string }>("select site.erp_master_state('PRODUCT', $1) as s", [id])).rows[0]!.s;
  if (state === 'PENDING') {
    const sig = await w.sign(w.cast.qa2, 'erp_master', `PRODUCT/${id}`, 'ERP_MASTER_CONFIRMED', 'PENDING');
    await w.run(w.cast.qa2, (c) => c.query("select site.confirm_erp_master('PRODUCT', $1, $2)", [id, sig]));
  }
}

beforeAll(async () => {
  db = await createTestDatabase();
  // Slice 7c (DI-03, recipe-core 1250): a GMP batch is issued only on a release with an approved validation summary.
  await approveTestRelease(db);
  w = new World(db, await seedCast(db));
  ({ admin } = await seedAdministration(db));
  steward = await seedActor(db, { roleCode: 'MASTER_DATA_STEWARD', legalName: 'Mira Steward' });
  operator = await seedActor(db, { roleCode: 'OPERATOR', legalName: 'Om Operator', roomCode: 'DISP-01' });
  warehouse = await seedActor(db, { roleCode: 'WAREHOUSE_LABELLING', legalName: 'Wasim Warehouse' });
  qcHead = await seedActor(db, { roleCode: 'HEAD_OF_QC', legalName: 'Hema QC-Head' });
  erp = await seedServiceActor(db, { kind: 'INTEGRATION', source: 'INTEGRATION', roleCode: 'ERP_INTERFACE', name: 'ERP interface' });
}, 600_000);
afterAll(async () => {
  await db.drop();
  dir.cleanup();
});

describe('the India gates of the GMP issue (recipe-core 0891; D-6-1, D-6-2)', () => {
  it('[IN-30] a GMP batch is issued only under a current licence endorsing its product and strength; the licence basis is recorded with the batch in the issue transaction; a later suspension blocks the next issue only', async () => {
    const m = await effective(['IN'], false);
    const first = await plan(m, ['IN']);
    expect(await messageOf(issue(first))).toMatch(/no manufacturing licence .* endorses.*EBMR-IND-040/);
    // A licence of another strength does not cover it; a lapsed one neither.
    await approveLicence(await recordLicence(licence(m, { products: [{ productCode: m.product, strength: '1 mg' }] })));
    await approveLicence(await recordLicence(licence(m, { validFrom: '2019-01-01T00:00:00Z', validUntil: '2021-01-01T00:00:00Z' })));
    expect(await messageOf(issue(first))).toMatch(/lapsed at 2021-01-01.*EBMR-IND-040/);
    const id = await recordLicence(licence(m));
    expect(await messageOf(issue(first))).toMatch(/EBMR-IND-040/);
    await approveLicence(id);
    await issue(first);
    const basis = (await db.app.query<{ licence_id: string; loan_licence_id: string | null }>('select licence_id, loan_licence_id from recipe.batch_licence_basis where batch_id = $1', [first])).rows[0];
    expect(basis).toEqual({ licence_id: id, loan_licence_id: null });
    const next = await plan(m, ['IN']);
    await w.run(w.cast.qa, (c) => c.query("select site.suspend_manufacturing_licence($1, 'Suspended by order of the licensing authority')", [id]));
    expect(await messageOf(issue(next))).toMatch(/suspended or cancelled.*EBMR-IND-040/);
    // The batch issued before the suspension keeps its basis and its G-REL item for IN stays green (D-6-1).
    const lot = await finishedLot(first, m, ['IN']);
    expect(await grelItem(lot, 'IN')).toMatchObject({ status: 'GREEN' });
    // The application role cannot write or change a licence basis.
    expect(await messageOf(db.app.query(`insert into recipe.batch_licence_basis (batch_id, licence_id, licence_number, basis) values ('${next}', '${id}', 'X', '{}')`))).toMatch(/permission denied/);
    expect(await messageOf(db.app.query(`update recipe.batch_licence_basis set licence_number = 'X' where batch_id = '${first}'`))).toMatch(/permission denied/);
  });

  it('[IN-30] a loan-licence batch is issued under the loan licence naming its product and the host licence of the site; its record carries both licence numbers and the technical agreement', async () => {
    const m = await effective(['IN'], false);
    const hostId = await recordLicence(licence(m, { products: [{ productCode: 'HOST-OTHER', strength: '10 mg' }] }));
    await approveLicence(hostId);
    const loanId = await recordLicence(licence(m, { licenceKind: 'LOAN', form: '25A', holderName: 'Loan Licensee Pvt Ltd', holderAddress: '12 Ring Road, New Delhi 110001',
                                                    hostLicenceId: hostId, technicalAgreement: 'TA-2026-07 rev 1' }));
    const b = await plan(m, ['IN']);
    expect(await messageOf(issue(b))).toMatch(/not approved.*EBMR-IND-040/);
    await approveLicence(loanId);
    await issue(b);
    const { rows } = await db.app.query<{ licence_id: string; loan_licence_id: string; basis: Record<string, string> }>('select licence_id, loan_licence_id, basis from recipe.batch_licence_basis where batch_id = $1', [b]);
    expect(rows[0]).toMatchObject({ licence_id: hostId, loan_licence_id: loanId, basis: { technicalAgreement: 'TA-2026-07 rev 1', loanForm: '25A', form: '25' } });
    const register = (await w.run(w.cast.qa, (c) => c.query<{ r: Record<string, unknown>[] }>('select recipe.allocation_register($1) as r', [SITE]))).rows[0]!.r;
    const entry = register.find((e) => e['batchId'] === b)!;
    expect(entry['licenceNumber']).toBe(rows[0]!.basis['licenceNumber']);
    expect(entry['loanLicenceNumber']).toBe(rows[0]!.basis['loanLicenceNumber']);
  });

  it('[IN-30] an export market needs a current export permission of the product and strength for it at issue and in G-REL item 6; IN needs none', async () => {
    const m = await effective(['IN', 'US'], false);
    await approveLicence(await recordLicence(licence(m)));
    // The US e-signature certification of the licence holder is on file (recipe-core 1260, DI-15), so that the export
    // permission is the only US gate this test meets.
    await recordUsCertification(m);
    const b = await plan(m, ['IN', 'US']);
    expect(await messageOf(issue(b))).toMatch(/market US.*no export permission.*EBMR-IND-041/);
    const permission = await sqlAs<string>(w.cast.regulatory, 'select site.record_export_permission($1::jsonb) as r', [JSON.stringify({
      productCode: m.product, strength: m.strength, destination: 'US', permissionNumber: `NOC-${randomUUID().slice(0, 8)}`, issuingAuthority: 'State Licensing Authority, Maharashtra',
      validFrom: '2020-01-01T00:00:00Z', validUntil: '2099-01-01T00:00:00Z' })]);
    expect(await messageOf(issue(b))).toMatch(/not approved.*EBMR-IND-041/);
    const sig = await w.sign(w.cast.qa, 'export_permission', permission, 'EXPORT_PERMISSION_APPROVED', 'DRAFT');
    await w.run(w.cast.qa, (c) => c.query('select site.approve_export_permission($1, $2)', [permission, sig]));
    await issue(b);
    const lot = await finishedLot(b, m, ['IN', 'US']);
    expect(await grelItem(lot, 'IN')).toMatchObject({ status: 'GREEN' });
    const us = await grelItem(lot, 'US');
    expect(us.status).toBe('GREEN');
    expect(us.evidence.map((e) => e.kind)).toEqual(['LICENCE', 'EXPORT_PERMISSION']);
    await w.run(w.cast.qa, (c) => c.query("select site.suspend_export_permission($1, 'Withdrawn by the authority')", [permission]));
    const red = await grelItem(lot, 'US');
    expect(red.status).toBe('RED');
    expect(red.problem).toMatch(/suspended or withdrawn/);
    expect(await grelItem(lot, 'IN')).toMatchObject({ status: 'GREEN' });
  });

  it('[IN-30] G-REL item 6 is red for a batch of the evidence set without a licence basis recorded at its issue', async () => {
    const m = await effective(['IN'], true);
    const b = await issue(await plan(m, ['IN']));
    const lot = await finishedLot(b, m, ['IN']);
    expect(await grelItem(lot, 'IN')).toMatchObject({ status: 'GREEN' });
    // A batch from before 6a, or written around the issue, has no basis (superuser, triggers off: the time-traveller pattern).
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      await c.query('set local session_replication_role = replica');
      await c.query('delete from recipe.batch_licence_basis where batch_id = $1', [b]);
      await c.query('commit');
    } finally {
      c.release();
    }
    const missing = await grelItem(lot, 'IN');
    expect(missing.status).toBe('RED');
    expect(missing.problem).toMatch(/no manufacturing or loan licence recorded at its issue/);
  });

  it('[IN-27][PR-27] a hazardous product is issued only on a line dedicated and contained for its hazard class; QA records both from the risk assessment, never an administrator, and a second QA person approves each', async () => {
    const m = await effective(['IN'], true);
    expect(await messageOf(sqlAs(admin, 'select plant.record_product_hazard($1::jsonb) as r', [JSON.stringify({ productCode: m.product, hazardClass: 'CYTOTOXIC', riskAssessmentRef: 'RA-1' })]))).toMatch(/administrator|EBMR-IAM/i);
    expect(await messageOf(sqlAs(w.cast.qa, 'select plant.record_product_hazard($1::jsonb) as r', [JSON.stringify({ productCode: m.product, hazardClass: 'RADIOACTIVE', riskAssessmentRef: 'RA-1' })]))).toMatch(/EBMR-IND-035/);
    // A pending upgrade counts at once (fail-safe), before its approval.
    const cyto = await classify(m.product, 'CYTOTOXIC', 'RA-ONC-2026-03 (OEB 4)');
    const b = await plan(m, ['IN']);
    expect(await messageOf(issue(b))).toMatch(/CYTOTOXIC.*pending approval.*L1 is not a room or line dedicated.*EBMR-IND-042/);
    await approve('hazard_classification', cyto);
    expect(await messageOf(issue(b))).toMatch(/CYTOTOXIC \(risk assessment RA-ONC-2026-03 \(OEB 4\)\) and L1 is not a room or line dedicated.*EBMR-IND-042/);
    await line();
    await approve('area_dedication', await dedicate(true, 'STEROID'));
    expect(await messageOf(issue(b))).toMatch(/EBMR-IND-042/);
    await approve('area_dedication', await dedicate(true));
    await issue(b);
    // A withdrawal counts at once, before its approval.
    await dedicate(false);
    expect(await messageOf(issue(await plan(m, ['IN'])))).toMatch(/EBMR-IND-042/);
    expect(await messageOf(db.app.query(`insert into plant.product_hazard (product_code, hazard_class, risk_assessment_ref, recorded_by_person, recorded_by_account, correlation_id)
                                          values ('${m.product}', 'NONE', 'x', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`))).toMatch(/permission denied/);
  });

  it('[IN-27] an unsigned downgrade or dedication does not take effect; the recorder cannot approve their own record; the approved change does', async () => {
    // After the test above, line L1's CYTOTOXIC dedication is withdrawn (pending): the line is shared.
    const m = await effective(['IN'], true);
    await approve('hazard_classification', await classify(m.product, 'CYTOTOXIC', 'RA-ONC-2026-04'));
    // One QA person marks the shared line dedicated and reclassifies the product NONE: neither counts unsigned.
    const dedication = await dedicate(true);
    const b = await plan(m, ['IN']);
    expect(await messageOf(issue(b))).toMatch(/CYTOTOXIC.*L1 is not a room or line dedicated.*EBMR-IND-042/);
    const downgrade = await classify(m.product, 'NONE', 'RA-ONC-2026-05 (reassessed)');
    expect(await messageOf(issue(b))).toMatch(/CYTOTOXIC.*EBMR-IND-042/);
    expect((await db.app.query<{ c: string[] }>('select plant.product_hazard_classes($1) as c', [m.product])).rows[0]!.c).toEqual(['CYTOTOXIC']);
    // The recorder's own approval is refused (by the kernel at signing, or by the command).
    expect(await messageOf(approve('hazard_classification', downgrade, w.cast.qa))).toMatch(/EBMR-(ESIG-\d{3}|IND-062)/);
    expect(await messageOf(approve('area_dedication', dedication, w.cast.qa))).toMatch(/EBMR-(ESIG-\d{3}|IND-062)/);
    // The command refuses the recorder with any signature, a role without HAZARD.APPROVE, and an administrator.
    expect(await messageOf(w.run(w.cast.qa, (c) => c.query('select plant.approve_product_hazard($1, $2)', [downgrade, randomUUID()])))).toMatch(/EBMR-IND-062/);
    expect(await messageOf(w.run(steward, (c) => c.query('select plant.approve_product_hazard($1, $2)', [downgrade, randomUUID()])))).toMatch(/EBMR-IAM-040/);
    expect(await messageOf(w.run(admin, (c) => c.query('select plant.approve_area_dedication($1, $2)', [dedication, randomUUID()])))).toMatch(/administrator|EBMR-IAM/i);
    // The application role writes no approval directly.
    expect(await messageOf(db.app.query('insert into plant.product_hazard_approval (hazard_id, signature_id, approved_by_person, approved_by_account) values ($1, gen_random_uuid(), gen_random_uuid(), gen_random_uuid())', [downgrade]))).toMatch(/permission denied/);
    expect(await messageOf(db.app.query('insert into plant.area_dedication_approval (dedication_id, signature_id, approved_by_person, approved_by_account) values ($1, gen_random_uuid(), gen_random_uuid(), gen_random_uuid())', [dedication]))).toMatch(/permission denied/);
    // The second person approves the dedication: the batch issues on the dedicated line.
    await approve('area_dedication', dedication);
    await issue(b);
    // The second person approves the downgrade: the product is no longer hazardous; an older record is never approved.
    await approve('hazard_classification', downgrade);
    expect((await db.app.query<{ c: string[] }>('select plant.product_hazard_classes($1) as c', [m.product])).rows[0]!.c).toEqual([]);
    const older = await classify(m.product, 'STEROID', 'RA-X');
    await classify(m.product, 'NONE', 'RA-Y');
    expect(await messageOf(approve('hazard_classification', older))).toMatch(/EBMR-IND-061|EBMR-ESIG-\d{3}/);
  });
});

describe('expiry dating (recipe-core 0893; PR-43, D-6-3)', () => {
  it('[PR-43] the expiry is the manufacture date plus the shelf life rounded down to a month end, computed by the database', async () => {
    const end = async (d: string, months: number): Promise<string | null> =>
      (await db.app.query<{ e: string | null }>('select recipe.expiry_month_end($1::date, $2)::text as e', [d, months])).rows[0]!.e;
    expect(await end('2026-03-15', 24)).toBe('2028-02-29');
    expect(await end('2026-01-31', 24)).toBe('2027-12-31');
    expect(await end('2026-01-01', 1)).toBe('2026-01-31');
    expect(await end('2026-12-31', 36)).toBe('2029-11-30');
    expect(await end('2026-03-15', 0)).toBeNull();
  });

  it('[PR-43] a batch takes the shelf life in effect when it was made: a later change, made on its stability basis, applies only to batches made after it; a tentative basis is shown', async () => {
    const m = await effective(['IN'], true);
    await productMaster(m, 24);
    const b = await issue(await plan(m, ['IN']));
    const e1 = (await db.app.query<{ e: Record<string, unknown> }>('select recipe.batch_expiry($1) as e', [b])).rows[0]!.e;
    expect(e1).toMatchObject({ shelfLifeMonths: 24, capped: false, stabilityReference: null, tentative: false });
    const mfg = String(e1['manufactureDate']);
    const expected = (await db.app.query<{ e: string }>('select recipe.expiry_month_end($1::date, 24)::text as e', [mfg])).rows[0]!.e;
    expect(e1['expiryDate']).toBe(expected);
    expect(e1['expiryMonth']).toBe(expected.slice(0, 7));
    await w.run(qcHead, (c) => c.query('select site.record_shelf_life_basis($1::jsonb)', [JSON.stringify({ productCode: m.product, strength: m.strength, shelfLifeMonths: 36, stabilityReference: 'STAB-ACC-2026-02 (6 months accelerated)', tentative: true })]));
    await productMaster(m, 36);
    expect((await db.app.query<{ e: Record<string, unknown> }>('select recipe.batch_expiry($1) as e', [b])).rows[0]!.e).toMatchObject({ shelfLifeMonths: 24 });
    const b2 = await issue(await plan(m, ['IN']));
    expect((await db.app.query<{ e: Record<string, unknown> }>('select recipe.batch_expiry($1) as e', [b2])).rows[0]!.e).toMatchObject({
      shelfLifeMonths: 36, stabilityReference: 'STAB-ACC-2026-02 (6 months accelerated)', tentative: true,
    });
    // The finished-lot expiry of the first batch (recipe.source_batch_expiry) keeps its own shelf life too.
    const src = (await db.admin.query<{ d: string }>('select recipe.source_batch_expiry($1)::text as d', [b])).rows[0]!.d;
    expect(src.slice(0, 7)).toBe(expected.slice(0, 7));
  });
});

describe('India-domestic label particulars and the Schedule H2 payload stub (recipe-core 0894; IN-31, D-P4-14)', () => {
  it('[IN-31] the label particulars and the H2 payload come from the record: plain manufacture and expiry dates, the manufacturer and its licence; refused without a licence basis or a shelf life', async () => {
    const m = await effective(['IN'], true);
    const b = await issue(await plan(m, ['IN']));
    expect(await messageOf(db.app.query('select recipe.india_label_particulars($1)', [b]))).toMatch(/EBMR-IND-050.*shelf life/);
    await productMaster(m, 24);
    const p = (await db.app.query<{ p: Record<string, unknown> }>('select recipe.india_label_particulars($1) as p', [b])).rows[0]!.p;
    const basis = (await db.app.query<{ n: string }>('select licence_number as n from recipe.batch_licence_basis where batch_id = $1', [b])).rows[0]!.n;
    const exp = (await db.app.query<{ e: Record<string, string> }>('select recipe.batch_expiry($1) as e', [b])).rows[0]!.e;
    expect(p).toMatchObject({
      batchId: b, productCode: m.product, strength: m.strength, manufactureDate: exp['manufactureDate'], expiryDate: exp['expiryDate'],
      manufacturer: { name: 'Test Pharma Ltd', licenceNumber: basis }, loanLicensee: null,
    });
    expect(p['manufactureLabel']).toMatch(/^\d{2}\/\d{4}$/);
    expect(p['expiryLabel']).toBe(`${String(exp['expiryDate']).slice(5, 7)}/${String(exp['expiryDate']).slice(0, 4)}`);
    const payload = (await db.app.query<{ p: string }>('select recipe.h2_payload($1) as p', [b])).rows[0]!.p;
    expect(payload).toBe([
      'V=H2-STUB-1', `UPIC=${m.product}`, `GENERIC=${String(p['drugName'])} ${m.strength}`, `BRAND=${String(p['drugName'])}`,
      'MFR=Test Pharma Ltd, Plot 1, Test Industrial Area, Pune 411019', `BATCH=${String(p['batchNumber'])}`,
      `MFG=${String(exp['manufactureDate']).slice(0, 7)}`, `EXP=${String(exp['expiryDate']).slice(0, 7)}`, `LIC=${basis}`,
    ].join(';'));
    expect((await db.app.query<{ l: { version: string; status: string } }>('select recipe.h2_layout() as l')).rows[0]!.l).toMatchObject({ version: 'H2-STUB-1', status: 'U' });
  });

  it('[IN-31] H2 payload binding: only the payload computed from the batch record and issued for printing on that batch passes; another batch\'s, an altered or a never-issued payload is refused; an administrator issues none', async () => {
    const m = await effective(['IN'], true);
    await productMaster(m, 24);
    const b = await issue(await plan(m, ['IN']));
    const other = await issue(await plan(m, ['IN']));
    const problem = async (batch: string, payload: string): Promise<string | null> =>
      (await db.app.query<{ p: string | null }>('select recipe.h2_payload_problem($1, $2) as p', [batch, payload])).rows[0]!.p;
    const computed = (await db.app.query<{ p: string }>('select recipe.h2_payload($1) as p', [b])).rows[0]!.p;
    expect(await problem(b, computed)).toMatch(/never issued for printing/);
    expect(await messageOf(sqlAs(admin, 'select recipe.issue_h2_payload($1) as r', [b]))).toMatch(/administrator|EBMR-IAM/i);
    expect(await messageOf(sqlAs(w.cast.qa, 'select recipe.issue_h2_payload($1) as r', [b]))).toMatch(/STEP\.EXECUTE|EBMR-IAM/);
    const issued = await sqlAs<{ payload: string; payloadHash: string; layoutVersion: string }>(operator, 'select recipe.issue_h2_payload($1) as r', [b]);
    expect(issued.payload).toBe(computed);
    expect(issued.layoutVersion).toBe('H2-STUB-1');
    expect(await problem(b, computed)).toBeNull();
    const otherPayload = await sqlAs<{ payload: string }>(operator, 'select recipe.issue_h2_payload($1) as r', [other]);
    expect(await problem(b, otherPayload.payload)).toMatch(/differs at BATCH/);
    expect(await problem(b, computed.replace(/EXP=\d{4}-\d{2}/, 'EXP=2099-12'))).toMatch(/differs at EXP/);
    expect(await problem(b, `${computed};X=1`)).toMatch(/differs at X/);
    expect(await messageOf(db.app.query(`insert into recipe.h2_payload_issue (batch_id, layout_version, payload, payload_hash, issued_by_person, issued_by_account, correlation_id)
                                          values ('${b}', 'H2-STUB-1', 'x', repeat('a', 64), gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`))).toMatch(/permission denied/);
    expect(await messageOf(db.admin.query(`update recipe.h2_payload_issue set payload = 'x' where batch_id = '${b}'`))).toMatch(/EBMR-AUDIT-004|EBMR-IND-001/);
  });
});

describe('the allocation register with the use of every number (recipe-core 0895)', () => {
  it('[IN-18] export the register: every number with its allocation date, product identity, batch size and its use (issued with its licence, planned, voided with the reason, unused)', async () => {
    const m = await effective(['IN'], true);
    const issued = await issue(await plan(m, ['IN']));
    const planned = await plan(m, ['IN']);
    const allocate = async (): Promise<string> =>
      withProtectedNumbers(db.app, await cmd(db, w.cast.issuer), ledger, async (c) =>
        (await c.query<{ id: string }>('select allocation_id::text as id from site.allocate_batch_number($1::jsonb)', [
          JSON.stringify({ site_code: SITE, product_code: m.product, product_name: 'India test product', edition: 'TABLETS', batch_kind: 'PROCESSING', batch_size: '200', batch_size_unit: 'kg' }),
        ])).rows[0]!.id);
    const voided = await allocate();
    await w.run(w.cast.issuer, (c) => c.query("select site.void_batch_number($1, 'ORDER_CANCELLED', 'ERP order cancelled before issue')", [voided]));
    const unused = await allocate();
    const register = (await w.run(w.cast.qa, (c) => c.query<{ r: Record<string, unknown>[] }>('select recipe.allocation_register($1) as r', [SITE]))).rows[0]!.r;
    const of = (pred: (e: Record<string, unknown>) => boolean) => register.find(pred)!;
    const basis = (await db.app.query<{ n: string }>('select licence_number as n from recipe.batch_licence_basis where batch_id = $1', [issued])).rows[0]!.n;
    expect(of((e) => e['batchId'] === issued)).toMatchObject({ use: 'ISSUED', productCode: m.product, strength: m.strength, kind: 'PROCESSING', licenceNumber: basis });
    expect(of((e) => e['batchId'] === planned)).toMatchObject({ use: 'PLANNED', licenceNumber: null });
    expect(of((e) => e['allocationId'] === voided)).toMatchObject({ use: 'VOIDED', voidReason: 'ORDER_CANCELLED: ERP order cancelled before issue', batchSize: '200', batchSizeUnit: 'kg' });
    expect(of((e) => e['allocationId'] === unused)).toMatchObject({ use: 'UNUSED', productName: 'India test product' });
    for (const e of register) {
      expect(e['allocationDate']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e['productCode']).toBeTruthy();
      expect(e['batchSize']).toBeTruthy();
    }
    expect(new Set(register.map((e) => e['batchNumber'])).size).toBe(register.length);
    const later = (await w.run(w.cast.qa, (c) => c.query<{ r: unknown[] }>("select recipe.allocation_register($1, '2999-01-01T00:00:00Z') as r", [SITE]))).rows[0]!.r;
    expect(later).toEqual([]);
  });

  it('[IN-18][DI-17] the register is read only by a person holding RECORD.READ for the site: no actor, or the ERP interface, is refused (recipe-core 0913)', async () => {
    expect(await messageOf(db.app.query('select recipe.allocation_register($1) as r', [SITE]))).toMatch(/EBMR-IAM|actor/i);
    expect(await messageOf(withCommand(db.app, { ...erp, correlationId: randomUUID() }, (c) => c.query('select recipe.allocation_register($1) as r', [SITE])))).toMatch(/EBMR-IAM-040/);
  });
});

describe('the contract giver reviewer (recipe-core 1060, kernel 1204; IN-30)', () => {
  it('[IN-30] a contract-giver reviewer cannot edit: read-only, scoped to the loan licence\'s batches, every write path refused', async () => {
    const m = await effective(['IN'], false);
    const hostId = await recordLicence(licence(m, { products: [{ productCode: 'HOST-CG', strength: '10 mg' }] }));
    await approveLicence(hostId);
    const loanId = await recordLicence(licence(m, { licenceKind: 'LOAN', form: '25A', holderName: 'Contract Giver Pvt Ltd', holderAddress: '4 Park Street, Kolkata 700016',
                                                    hostLicenceId: hostId, technicalAgreement: 'TA-CG-2026 rev 2' }));
    await approveLicence(loanId);
    const own = await issue(await plan(m, ['IN']));
    const reviewer = await seedActor(db, { roleCode: 'CONTRACT_GIVER_REVIEWER', legalName: 'Contract Giver Reviewer', acknowledgeEsig: false });
    const qaReviewer = await seedActor(db, { roleCode: 'QA_REVIEWER', legalName: 'QA Reviewer CG' });
    const validTo = new Date(Date.UTC(2099, 0, 1)).toISOString();
    const grant = (licenceId: string, account: string, until = (async () => (await db.app.query<{ t: string }>("select (clock_timestamp() + interval '30 days')::text as t")).rows[0]!.t)()) =>
      until.then((u) => sqlAs<string>(qaReviewer, 'select recipe.grant_contract_giver_access($1, $2, $3, $4) as r', [licenceId, account, u, 'Technical agreement TA-CG-2026, clause 9']));
    // Refusals: a manufacturing licence, an account that can write, a window too long, the reviewer granting itself.
    expect(await messageOf(grant(hostId, reviewer.accountId))).toMatch(/EBMR-CGA-001/);
    expect(await messageOf(grant(loanId, operator.accountId))).toMatch(/EBMR-CGA-003/);
    expect(await messageOf(grant(loanId, reviewer.accountId, Promise.resolve(validTo)))).toMatch(/EBMR-CGA-005/);
    expect(await messageOf(sqlAs(reviewer, 'select recipe.grant_contract_giver_access($1, $2, now() + interval \'1 day\', $3) as r', [loanId, reviewer.accountId, 'x']))).toMatch(/EBMR-IAM-040/);
    // Before any access the reviewer reads nothing.
    expect(await sqlAs<unknown[]>(reviewer, 'select recipe.contract_giver_batches() as r')).toEqual([]);
    const access = await grant(loanId, reviewer.accountId);
    const list = await sqlAs<{ batchId: string; loanLicenceNumber: string }[]>(reviewer, 'select recipe.contract_giver_batches() as r');
    expect(list.map((b) => b.batchId)).toEqual([own]);
    const record = await sqlAs<Record<string, unknown>>(reviewer, 'select recipe.read_contract_giver_batch($1) as r', [own]);
    expect(record).toMatchObject({ batchId: own, technicalAgreement: 'TA-CG-2026 rev 2', loanHolderName: 'Contract Giver Pvt Ltd' });
    expect((await db.app.query('select 1 from recipe.contract_giver_read where access_id = $1 and batch_id = $2', [access, own])).rowCount).toBe(1);
    // Another batch (not made under the loan licence) stays closed.
    const other = await issue(await plan(await effective(['IN'], true), ['IN']));
    expect(await messageOf(sqlAs(reviewer, 'select recipe.read_contract_giver_batch($1) as r', [other]))).toMatch(/EBMR-CGA-004/);
    // The record read is that batch's own execution state, with other batches' states in the database.
    const again = await sqlAs<Record<string, unknown>>(reviewer, 'select recipe.read_contract_giver_batch($1) as r', [own]);
    const ownState = (await db.admin.query<{ status: string; stages: unknown; steps: unknown }>(
      "select status, coalesce(state -> 'stages', '{}'::jsonb) as stages, coalesce(state -> 'steps', '{}'::jsonb) as steps from recipe.execution_state where batch_id = $1", [own])).rows[0]!;
    expect({ status: again['status'], stages: again['stages'], steps: again['steps'] }).toEqual(ownState);
    // A role permission that writes can never be added to the reviewer role (kernel 1204), even by the owner.
    const { owner } = await seedAdministration(db);
    const request = await withCommand(db.app, { ...(await cmd(db, admin)), reasonCode: 'TEST', reasonText: 'bypass attempt' }, (c) =>
      c.query<{ id: string }>("select iam.add_role_permission('CONTRACT_GIVER_REVIEWER', 'VALIDATION.MANAGE', 'widen the reviewer') as id"));
    expect(await messageOf(withCommand(db.app, await withChangeRecord(db, { ...(await cmd(db, owner)), reasonCode: 'TEST', reasonText: 'bypass attempt' }), (c) =>
      c.query("select iam.decide_role_permission($1, true, 'approved')", [request.rows[0]!.id])))).toMatch(/EBMR-IAM-190/);
    // Every function the application role may call, in the reviewer's command with every argument NULL: none records a
    // change attributed to the reviewer, apart from the logged reads of its own access chain and the person's own
    // acknowledgement of the e-signature policy (an identity record about the person, not GMP content; it gives no
    // signing authority: the account holds no SIGN permission).
    const fns = (await db.admin.query<{ call: string }>(
      `select format('select %s(%s)', p.oid::regproc, coalesce(string_agg('null::' || format_type(t.typ, null), ', ' order by t.ord), '')) as call
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         left join lateral unnest(p.proargtypes::oid[]) with ordinality t(typ, ord) on true
        where n.nspname in ('recipe', 'site', 'plant', 'esig', 'iam', 'records', 'platform', 'kernel') and p.prokind = 'f' and p.provolatile = 'v'
          and p.prorettype <> 'trigger'::regtype and has_function_privilege('ebmr_app', p.oid, 'execute')
        group by p.oid order by 1`)).rows.map((r) => r.call);
    expect(fns.length).toBeGreaterThan(200);
    const correlationId = randomUUID();
    let succeeded = 0;
    await withCommand(db.app, { ...(await cmd(db, reviewer)), correlationId }, async (c) => {
      await c.query("set local statement_timeout = '5s'");
      for (const call of fns) {
        await c.query('savepoint s');
        try {
          await c.query(call);
          succeeded += 1;
          await c.query('release savepoint s');
        } catch {
          await c.query('rollback to savepoint s');
        }
      }
    });
    expect(succeeded).toBeGreaterThan(0);
    const written = await db.admin.query<{ chain_key: string; table_name: string | null }>(
      "select chain_key, table_name from kernel.audit_event where correlation_id = $1 and chain_key not like 'contract_giver_access:%' and table_name is distinct from 'iam.esig_acknowledgement'", [correlationId]);
    expect(written.rows).toEqual([]);
    // Direct writes as the application role are refused too.
    expect(await messageOf(db.app.query('insert into recipe.contract_giver_read (access_id, batch_id, person_id, account_id, correlation_id) values ($1, $2, gen_random_uuid(), gen_random_uuid(), gen_random_uuid())', [access, other]))).toMatch(/permission denied/);
    expect(await messageOf(db.app.query("update recipe.contract_giver_access set valid_to = valid_to + interval '1 year' where id = $1", [access]))).toMatch(/permission denied/);
    // Revoked, the access reads nothing more.
    await sqlAs(qaReviewer, "select recipe.revoke_contract_giver_access($1, 'Agreement ended') as r", [access]);
    expect(await sqlAs<unknown[]>(reviewer, 'select recipe.contract_giver_batches() as r')).toEqual([]);
    // The reviewer's account later given a role that writes: no new access is granted to it, and it reads nothing, even
    // under a live access, while it holds that role (the read-only check at grant time and at every read).
    const live = await grant(loanId, reviewer.accountId);
    const { owner: approver } = await seedAdministration(db);
    const writes = await withCommand(db.app, withReason(admin), (c) =>
      requestRoleGrant(c, { accountId: reviewer.accountId, roleCode: 'OPERATOR', reason: 'moved to production' }));
    await withCommand(db.app, withReason(approver), (c) => decideRoleGrant(c, writes, true, 'production role'));
    expect(await messageOf(grant(loanId, reviewer.accountId))).toMatch(/EBMR-CGA-003/);
    expect(await messageOf(sqlAs(reviewer, 'select recipe.contract_giver_batches() as r'))).toMatch(/EBMR-CGA-003/);
    expect(await messageOf(sqlAs(reviewer, 'select recipe.read_contract_giver_batch($1) as r', [own]))).toMatch(/EBMR-CGA-003/);
    expect((await db.app.query('select 1 from recipe.contract_giver_read where access_id = $1', [live])).rowCount).toBe(0);
    // A shared (generic) account is never a contract giver's reviewer, even holding the reviewer role (DI-14).
    const shared = await withCommand(db.app, withReason(admin), async (c) => {
      const personId = await createPerson(c, 'NATURAL', `Contract Giver Desk ${randomUUID().slice(0, 4)}`);
      await recordIdentityVerification(c, { personId, purpose: 'INITIAL', method: 'IN_PERSON_DOCUMENT', documentType: 'ID card', evidenceRef: 'HR-CG', occurredAt: '2026-01-05T09:00:00Z' });
      const accountId = await createAccount(c, { personId, loginName: `cg-desk-${randomUUID().slice(0, 8)}`, kind: 'HUMAN', generic: true });
      await activateAccount(c, accountId);
      const grantId = await requestRoleGrant(c, { accountId, roleCode: 'CONTRACT_GIVER_REVIEWER', reason: 'shared contract giver desk' });
      return { accountId, grantId };
    });
    await withCommand(db.app, withReason(approver), (c) => decideRoleGrant(c, shared.grantId, true, 'read-only role'));
    expect(await messageOf(grant(loanId, shared.accountId))).toMatch(/EBMR-CGA-002/);
  });
});
