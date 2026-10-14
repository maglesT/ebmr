/**
 * The India routes at their edges (feature india; Phase 4 focused mutation, decision 0012, Stryker on
 * src/features/india/index.ts). These tests close the gaps the run found in india-routes.test.ts: every read needs a
 * session; the people a licence, a permission and a stability basis name, with their part; the issue check's
 * destinations; the register's period; the label particulars as the database gives them (a tentative shelf life
 * included) and an unknown batch; and a hazard record that names nothing.
 *
 * Controls: IN-30 (licences and export permissions), IN-31 (label particulars and H2 payload), IN-18 (allocation
 * register), PR-43 (stability basis), IN-27 (hazard records), DI-20 (no read without a session).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { withCommand } from '@ebmr/kernel';
import { openServiceSession } from '@ebmr/test-kit';
import type { TestServer } from '../support/harness.ts';
import { personaIn, refusalOf, valueOf } from '../esig/support.ts';
import { actorOf, gmpLifecycleWorld, startGmpBatchWorld, type GmpBatchWorld } from '../support/gmp-world.ts';
import { signAction } from '../support/signed-acts.ts';

let w: GmpBatchWorld;
let gmp: TestServer;
const I = routes.india;

beforeAll(async () => {
  w = await startGmpBatchWorld();
  gmp = w.gmp;
}, 600_000);
afterAll(async () => {
  await w?.close();
});

async function approveDirect(aggregateType: 'manufacturing_licence' | 'export_permission', id: string): Promise<void> {
  const world = await gmpLifecycleWorld(gmp);
  const qa = await actorOf(gmp, 'approver');
  const meaning = aggregateType === 'manufacturing_licence' ? 'LICENCE_APPROVED' : 'EXPORT_PERMISSION_APPROVED';
  const sig = await world.sign(qa, aggregateType, id, meaning, 'DRAFT');
  const fn = aggregateType === 'manufacturing_licence' ? 'site.approve_manufacturing_licence' : 'site.approve_export_permission';
  await world.run(qa, (c) => c.query(`select ${fn}($1, $2)`, [id, sig]));
}
const code = () => `IN6E-${randomUUID().slice(0, 6).toUpperCase()}`;
const who = (key: string) => ({ loginName: personaIn(gmp, key).loginName });

describe('the India routes at their edges (feature india)', () => {
  it('[DI-20] [IN-30] no India read answers without a session', async () => {
    const anonymous = gmp.browser();
    const batchId = randomUUID();
    const calls = [
      anonymous.call(I.licences),
      anonymous.call(I.exportPermissions),
      anonymous.call(I.check, { query: { productCode: 'PCM500', strength: '500 mg' } }),
      anonymous.call(I.allocationRegister, { query: {} }),
      anonymous.call(I.label, { params: { batchId } }),
      anonymous.call(I.verifyH2, { params: { batchId }, body: { payload: 'V=H2-STUB-1' } }),
      anonymous.call(I.shelfLifeBases),
      anonymous.call(I.hazards),
    ];
    for (const r of await Promise.all(calls)) expect(refusalOf(r).status).toBe(401);
  });

  it('[IN-30] a licence and an export permission name their recorder, their approver and who suspended them, each with the part played', async () => {
    const reg = await gmp.asPersona('regulatory');
    const qa = await gmp.asPersona('approver');
    const p = code();
    const l = valueOf(await reg.call(I.recordLicence, { body: {
      licenceKind: 'MANUFACTURING', form: '25', licenceNumber: `MH/25/${randomUUID().slice(0, 8)}`, holderName: 'Deccan Pharma Ltd',
      holderAddress: 'Plot 7, MIDC Bhosari, Pune 411026', validFrom: '2020-01-01T00:00:00+05:30', products: [{ productCode: p, strength: '500 mg' }],
    } }));
    expect(l.recordedBy).toMatchObject({ ...who('regulatory'), role: 'RECORDER' });
    await approveDirect('manufacturing_licence', l.licenceId);
    const suspended = valueOf(await qa.call(I.suspendLicence, { params: { licenceId: l.licenceId }, body: { reason: 'Suspended by order of the licensing authority' } }));
    expect(suspended).toMatchObject({
      state: 'SUSPENDED', recordedBy: { ...who('regulatory'), role: 'RECORDER' }, approvedBy: { ...who('approver'), role: 'APPROVER' },
      suspension: { reason: 'Suspended by order of the licensing authority', suspendedBy: { ...who('approver'), role: 'APPROVER' } },
    });
    const listed = valueOf(await reg.call(I.licences)).licences.find((x) => x.licenceId === l.licenceId);
    expect(listed).toMatchObject({ recordedBy: { ...who('regulatory'), role: 'RECORDER' }, suspension: { suspendedBy: { ...who('approver'), role: 'APPROVER' } } });

    const e = valueOf(await reg.call(I.recordExportPermission, { body: {
      productCode: p, strength: '500 mg', destination: 'US', permissionNumber: `NOC/${randomUUID().slice(0, 8)}`, issuingAuthority: 'State Licensing Authority, Maharashtra',
      validFrom: '2020-01-01T00:00:00+05:30', validUntil: '2099-01-01T00:00:00+05:30',
    } }));
    await approveDirect('export_permission', e.permissionId);
    const withdrawn = valueOf(await qa.call(I.suspendExportPermission, { params: { permissionId: e.permissionId }, body: { reason: 'Withdrawn by the authority' } }));
    expect(withdrawn).toMatchObject({
      recordedBy: { ...who('regulatory'), role: 'RECORDER' }, approvedBy: { ...who('approver'), role: 'APPROVER' },
      suspension: { reason: 'Withdrawn by the authority', suspendedBy: { ...who('approver'), role: 'APPROVER' } },
    });
    const listedPermission = valueOf(await reg.call(I.exportPermissions)).permissions.find((x) => x.permissionId === e.permissionId);
    expect(listedPermission).toMatchObject({ recordedBy: { ...who('regulatory'), role: 'RECORDER' }, approvedBy: { ...who('approver'), role: 'APPROVER' } });
  });

  it('[IN-30] the issue check asks for each export destination named, leaving out IN; with none named it asks for none', async () => {
    const reg = await gmp.asPersona('regulatory');
    const q = code();
    const l = valueOf(await reg.call(I.recordLicence, { body: {
      licenceKind: 'MANUFACTURING', form: '25', licenceNumber: `MH/25/${randomUUID().slice(0, 8)}`, holderName: 'Deccan Pharma Ltd',
      holderAddress: 'Plot 7, MIDC Bhosari, Pune 411026', validFrom: '2020-01-01T00:00:00+05:30', products: [{ productCode: q, strength: '500 mg' }],
    } }));
    await approveDirect('manufacturing_licence', l.licenceId);
    const checked = valueOf(await reg.call(I.check, { query: { productCode: q, strength: '500 mg', destinations: 'US,IN,EU' } }));
    expect(checked.exportProblems.map((x) => x.destination)).toEqual(['US', 'EU']);
    expect(checked.exportProblems.every((x) => /no export permission/.test(x.problem ?? ''))).toBe(true);
    expect(checked).toMatchObject({ licenceProblem: null, licenceNumber: l.licenceNumber, loanLicenceNumber: null });
    expect(valueOf(await reg.call(I.check, { query: { productCode: q, strength: '500 mg' } })).exportProblems).toEqual([]);
  });

  it('[PR-43] [IN-31] [IN-18] the label of a batch gives the database\'s particulars, a tentative shelf life as such; an unknown batch is not found; the register keeps to its period', async () => {
    const issuer = await gmp.asPersona('issuer');
    const qa = await gmp.asPersona('approver');
    const product = w.content.header.product;
    // A tentative stability basis for 12 months, then the product master with that shelf life (ERP, confirmed by QA).
    const basis = valueOf(await qa.call(I.recordShelfLifeBasis, { body: { productCode: product.code, strength: product.strength, shelfLifeMonths: 12, stabilityReference: 'STAB-ACC-6M (accelerated)', tentative: true } }));
    expect(basis).toMatchObject({ tentative: true, recordedBy: { ...who('approver'), role: 'RECORDER' } });
    expect(valueOf(await qa.call(I.shelfLifeBases)).bases.find((b) => b.basisId === basis.basisId)).toMatchObject({ recordedBy: { ...who('approver'), role: 'RECORDER' } });
    const world = await gmpLifecycleWorld(gmp);
    const erp = await openServiceSession(gmp.db, gmp.seed, 'erpInterface');
    const version = await withCommand(gmp.db.app, { ...erp, correlationId: randomUUID() }, async (c) =>
      (await c.query<{ id: string }>('select site.erp_receive_product($1::jsonb) as id', [
        JSON.stringify({ productCode: product.code, strength: product.strength, productName: `Product ${product.code}`, betaLactam: false, shelfLifeMonths: 12, erpReference: `ERP-${product.code}` }),
      ])).rows[0]!.id);
    const state = (await gmp.db.app.query<{ s: string }>("select site.erp_master_state('PRODUCT', $1) as s", [version])).rows[0]!.s;
    if (state === 'PENDING') {
      const sig = await world.sign(world.cast.qa, 'erp_master', `PRODUCT/${version}`, 'ERP_MASTER_CONFIRMED', 'PENDING');
      await world.run(world.cast.qa, (c) => c.query("select site.confirm_erp_master('PRODUCT', $1, $2)", [version, sig]));
    }
    const batchId = await w.issued(issuer);
    const view = valueOf(await issuer.call(I.label, { params: { batchId } }));
    const p = (await gmp.db.admin.query<{ p: Record<string, unknown> }>('select recipe.india_label_particulars($1) as p', [batchId])).rows[0]!.p;
    expect(view.problem).toBeNull();
    expect(view.particulars).toEqual({
      batchNumber: p['batchNumber'], productCode: p['productCode'], drugName: p['drugName'], strength: p['strength'], dosageForm: p['dosageForm'],
      manufactureDate: p['manufactureDate'], manufactureLabel: p['manufactureLabel'], expiryDate: p['expiryDate'], expiryLabel: p['expiryLabel'],
      shelfLifeMonths: 12, tentativeShelfLife: true, manufacturer: p['manufacturer'], loanLicensee: null,
    });
    expect(view.h2).toMatchObject({ layoutVersion: 'H2-STUB-1', layoutStatus: 'U', issuedCount: 0 });
    expect(view.h2.payload).toMatch(/^V=H2-STUB-1;UPIC=/);
    const unknown = refusalOf(await issuer.call(I.label, { params: { batchId: randomUUID() } }));
    expect(unknown).toMatchObject({ status: 404, code: 'EBMR-API-NOT-FOUND', kind: 'STALE', whatHappened: 'The batch was not found.', why: 'No such batch.', whatYouCanDo: ['Reload the list.'] });
    // A later, non-tentative basis for the same shelf life: the label no longer calls it tentative.
    valueOf(await qa.call(I.recordShelfLifeBasis, { body: { productCode: product.code, strength: product.strength, shelfLifeMonths: 12, stabilityReference: 'STAB-LT-12M (long term)', tentative: false } }));
    expect(valueOf(await issuer.call(I.label, { params: { batchId } })).particulars).toMatchObject({ shelfLifeMonths: 12, tentativeShelfLife: false });

    const entry = (await gmp.db.admin.query<{ t: string }>(
      'select a.recorded_at::text as t from site.batch_number_allocation a join recipe.batch_allocation_link l on l.allocation_id = a.id where l.batch_id = $1', [batchId])).rows[0]!.t;
    const at = new Date(entry.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')).toISOString();
    const ids = async (query: { from?: string; to?: string }) => valueOf(await qa.call(I.allocationRegister, { query })).entries.map((x) => x.batchId);
    expect(await ids({})).toContain(batchId);
    expect(await ids({ to: '2000-01-01T00:00:00Z' })).not.toContain(batchId);
    expect(await ids({ from: '2999-01-01T00:00:00Z' })).not.toContain(batchId);
    expect(await ids({ from: at.slice(0, 10) + 'T00:00:00Z' })).toContain(batchId);
  });

  it('[IN-27] a hazard record that names neither a product classification nor an area dedication is refused with what to do', async () => {
    const qa = await gmp.asPersona('approver');
    expect(refusalOf(await qa.call(I.recordHazard, { body: {} }))).toMatchObject({
      status: 422, code: 'EBMR-IND-037', kind: 'NOT_ALLOWED', whatHappened: 'Nothing was recorded.',
      why: 'A hazard record names a product classification or an area dedication.', whatYouCanDo: ['Fill in one of them.'],
    });
  });

  it('[IN-27] a product classification alone or an area dedication alone is recorded and listed with all it says', async () => {
    const qa = await gmp.asPersona('approver');
    const p = code();
    const afterProduct = valueOf(await qa.call(I.recordHazard, { body: { product: { productCode: p, hazardClass: 'STEROID', riskAssessmentRef: 'RA-STR-2026-09' } } }));
    expect(afterProduct.products.find((x) => x.productCode === p)).toMatchObject({ hazardClass: 'STEROID', riskAssessmentRef: 'RA-STR-2026-09', state: 'RECORDED' });
    const justification = `Contained line ${randomUUID().slice(0, 6)}`;
    // A line as plant master data (written as the superuser inside a command: the plant master-data route is not under test).
    const area = `L-${randomUUID().slice(0, 6).toUpperCase()}`;
    await withCommand(gmp.db.admin, { ...(await actorOf(gmp, 'steward')), correlationId: randomUUID() }, (c) =>
      c.query("insert into plant.area (code, kind, name, segregated, negative_pressure, recorded_by) values ($1, 'LINE', 'Hazard test line', false, true, gen_random_uuid())", [area]));
    const afterArea = valueOf(await qa.call(I.recordHazard, { body: { area: { areaCode: area, hazardClass: 'SEX_HORMONE', dedicated: true, breathingAir: 'BACKED_UP', justification } } }));
    expect(afterArea.areas.find((x) => x.justification === justification)).toMatchObject({ areaCode: area, hazardClass: 'SEX_HORMONE', dedicated: true, breathingAir: 'BACKED_UP', state: 'RECORDED' });
    expect(valueOf(await qa.call(I.hazards)).areas.some((x) => x.justification === justification)).toBe(true);
  });

  it('[IN-30] the signed approval (INDIA_ACT) answers with the act and the record it approved', async () => {
    const reg = await gmp.asPersona('regulatory');
    const qa = await gmp.asPersona('approver');
    const l = valueOf(await reg.call(I.recordLicence, { body: {
      licenceKind: 'MANUFACTURING', form: '25', licenceNumber: `MH/25/${randomUUID().slice(0, 8)}`, holderName: 'Deccan Pharma Ltd',
      holderAddress: 'Plot 7, MIDC Bhosari, Pune 411026', validFrom: '2020-01-01T00:00:00+05:30', products: [{ productCode: code(), strength: '500 mg' }],
    } }));
    const ok = await signAction(gmp, qa, 'approver', { kind: 'INDIA_ACT', act: 'LICENCE_APPROVE', subjectId: l.licenceId });
    expect(ok.ok, ok.ok ? '' : JSON.stringify(ok.error)).toBe(true);
    expect(JSON.stringify(ok.ok ? ok.value : null)).toContain(`"act":"LICENCE_APPROVE","subjectId":"${l.licenceId}"`);
  });
});
