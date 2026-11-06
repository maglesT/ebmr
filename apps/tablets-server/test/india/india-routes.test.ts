/**
 * Phase 4 slice 6a over HTTP (feature india, contract ns/india.ts): licences and export permissions recorded by the
 * regulatory signer and approved by QA (INDIA_ACT), the issue check, the allocation register with the use of every
 * number, the India-domestic label particulars and the H2 payload issued and verified, the stability basis and hazard
 * records. Every rule is the database's; the routes carry the person's own command.
 * Where a test needs an approved licence without the ceremony, QA signs through the kernel directly (as the database
 * tests do); the ceremony itself is proven once (INDIA_ACT; tablets 1200 maps both aggregates for the preview).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type Result } from '@ebmr/api-contract';
import { terminalOf } from '@ebmr/test-kit';
import type { TestServer } from '../support/harness.ts';
import { personaIn, refusalOf, tapFor, valueOf } from '../esig/support.ts';
import { actorOf, gmpLifecycleWorld, startGmpBatchWorld, type GmpBatchWorld } from '../support/gmp-world.ts';
import { confirmErpPending, signAction } from '../support/signed-acts.ts';

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

/** QA's approval through the kernel (the database decides as for any signature). */
async function approveDirect(aggregateType: 'manufacturing_licence' | 'export_permission', id: string): Promise<void> {
  const world = await gmpLifecycleWorld(gmp);
  const qa = await actorOf(gmp, 'approver');
  const meaning = aggregateType === 'manufacturing_licence' ? 'LICENCE_APPROVED' : 'EXPORT_PERMISSION_APPROVED';
  const sig = await world.sign(qa, aggregateType, id, meaning, 'DRAFT');
  const fn = aggregateType === 'manufacturing_licence' ? 'site.approve_manufacturing_licence' : 'site.approve_export_permission';
  await world.run(qa, (c) => c.query(`select ${fn}($1, $2)`, [id, sig]));
}

const code = () => `IN6A-${randomUUID().slice(0, 6).toUpperCase()}`;
const licenceBody = (productCode: string) => ({
  licenceKind: 'MANUFACTURING' as const, form: '25' as const, licenceNumber: `MH/25/${randomUUID().slice(0, 8)}`, holderName: 'Deccan Pharma Ltd',
  holderAddress: 'Plot 7, MIDC Bhosari, Pune 411026', validFrom: '2020-01-01T00:00:00+05:30', products: [{ productCode, strength: '500 mg' }],
});

describe('licences and export permissions over HTTP (Phase 4 slice 6a)', () => {
  it('[IN-30] the regulatory signer records a licence; it shows as DRAFT and the check refuses the product until QA approves it; the issuer may not record one', async () => {
    const reg = await gmp.asPersona('regulatory');
    const p = code();
    const issuer = await gmp.asPersona('issuer');
    expect((refusalOf(await issuer.call(I.recordLicence, { body: licenceBody(p) }))).code).toMatch(/EBMR-IAM/);
    const l = valueOf(await reg.call(I.recordLicence, { body: licenceBody(p) }));
    expect(l).toMatchObject({ state: 'DRAFT', current: false, products: [{ productCode: p, strength: '500 mg' }], approvedBy: null });
    const before = valueOf(await reg.call(I.check, { query: { productCode: p, strength: '500 mg', destinations: 'US' } }));
    expect(before.licenceProblem).toMatch(/not approved by QA/);
    expect(before.exportProblems[0]?.problem).toMatch(/no export permission/);
    await approveDirect('manufacturing_licence', l.licenceId);
    const after = valueOf(await reg.call(I.check, { query: { productCode: p, strength: '500 mg' } }));
    expect(after).toMatchObject({ licenceProblem: null, licenceNumber: l.licenceNumber, loanLicenceNumber: null });
    const list = valueOf(await reg.call(I.licences));
    expect(list.licences.find((x) => x.licenceId === l.licenceId)).toMatchObject({ state: 'APPROVED', current: true });
    const qa = await gmp.asPersona('approver');
    const suspended = valueOf(await qa.call(I.suspendLicence, { params: { licenceId: l.licenceId }, body: { reason: 'Suspended by order of the licensing authority' } }));
    expect(suspended).toMatchObject({ state: 'SUSPENDED', current: false, suspension: { reason: 'Suspended by order of the licensing authority' } });
  });

  it('[IN-30] the regulatory signer records a new holder telephone for a licence over HTTP; the licence shows the new one; the issuer may not, and a telephone with other characters is refused', async () => {
    const reg = await gmp.asPersona('regulatory');
    const l = valueOf(await reg.call(I.recordLicence, { body: { ...licenceBody(code()), holderTelephone: '+91 20 1111 2222' } }));
    expect(l.holderTelephone).toBe('+91 20 1111 2222');
    const issuer = await gmp.asPersona('issuer');
    expect(refusalOf(await issuer.call(I.recordLicenceTelephone, { params: { licenceId: l.licenceId }, body: { telephone: '+91 20 3333 4444' } })).code).toMatch(/EBMR-IAM/);
    expect((await reg.call(I.recordLicenceTelephone, { params: { licenceId: l.licenceId }, body: { telephone: '020 1111; x' } })).ok).toBe(false);
    const changed = valueOf(await reg.call(I.recordLicenceTelephone, { params: { licenceId: l.licenceId }, body: { telephone: '+91 20 3333 4444' } }));
    expect(changed).toMatchObject({ licenceId: l.licenceId, holderTelephone: '+91 20 3333 4444' });
  });

  it('[IN-30] INDIA_ACT: QA approves a licence and an export permission through the signing ceremony, never the recorder', async () => {
    const reg = await gmp.asPersona('regulatory');
    const qa = await gmp.asPersona('approver');
    const p = code();
    const l = valueOf(await reg.call(I.recordLicence, { body: licenceBody(p) }));
    const own = await signAction(gmp, reg, 'regulatory', { kind: 'INDIA_ACT', act: 'LICENCE_APPROVE', subjectId: l.licenceId });
    expect(own.ok).toBe(false);
    const ok: Result<unknown> = await signAction(gmp, qa, 'approver', { kind: 'INDIA_ACT', act: 'LICENCE_APPROVE', subjectId: l.licenceId });
    expect(ok.ok, ok.ok ? '' : JSON.stringify(ok.error)).toBe(true);
    const e = valueOf(await reg.call(I.recordExportPermission, { body: { productCode: p, strength: '500 mg', destination: 'US', permissionNumber: `NOC-${randomUUID().slice(0, 8)}`, issuingAuthority: 'SLA Maharashtra', validFrom: '2020-01-01T00:00:00+05:30', validUntil: '2035-01-01T00:00:00+05:30' } }));
    const ok2 = await signAction(gmp, qa, 'approver', { kind: 'INDIA_ACT', act: 'EXPORT_PERMISSION_APPROVE', subjectId: e.permissionId });
    expect(ok2.ok, ok2.ok ? '' : JSON.stringify(ok2.error)).toBe(true);
    expect(valueOf(await reg.call(I.check, { query: { productCode: p, strength: '500 mg', destinations: 'US' } }))).toMatchObject({ licenceProblem: null, exportProblems: [{ destination: 'US', problem: null }] });
  });

  it('[IN-30] an export permission recorded over HTTP counts once approved, until it is suspended; IN is never a destination', async () => {
    const reg = await gmp.asPersona('regulatory');
    const p = code();
    const body = { productCode: p, strength: '500 mg', destination: 'EU', permissionNumber: `NOC-${randomUUID().slice(0, 8)}`, issuingAuthority: 'SLA Maharashtra', validFrom: '2020-01-01T00:00:00+05:30', validUntil: '2035-01-01T00:00:00+05:30' };
    expect((refusalOf(await reg.call(I.recordExportPermission, { body: { ...body, destination: 'IN' } }))).code).toBe('SCHEMA');
    const e = valueOf(await reg.call(I.recordExportPermission, { body }));
    expect(e).toMatchObject({ state: 'DRAFT', current: false });
    await approveDirect('export_permission', e.permissionId);
    expect(valueOf(await reg.call(I.exportPermissions)).permissions.find((x) => x.permissionId === e.permissionId)).toMatchObject({ state: 'APPROVED', current: true });
    const qa = await gmp.asPersona('approver');
    expect(valueOf(await qa.call(I.suspendExportPermission, { params: { permissionId: e.permissionId }, body: { reason: 'Withdrawn' } }))).toMatchObject({ state: 'SUSPENDED', current: false });
  });
});

describe('the record side over HTTP (Phase 4 slice 6a)', () => {
  it('[IN-18][IN-31][PR-43] an issued batch is in the allocation register with its licence; its label particulars and H2 payload come from the record; a payload is issued on the batch and verified, another refused', async () => {
    const issuer = await gmp.asPersona('issuer');
    const batchId = await w.issued(issuer);
    const register = valueOf(await issuer.call(I.allocationRegister, { query: {} }));
    const entry = register.entries.find((e) => e.batchId === batchId);
    expect(entry).toMatchObject({ use: 'ISSUED', kind: 'PROCESSING', productCode: w.content.header.product.code });
    expect(entry?.licenceNumber).toBeTruthy();
    // Without the product master's shelf life the label says why; with it, the particulars and the payload.
    const first = valueOf(await issuer.call(I.label, { params: { batchId } }));
    if (first.particulars === null) {
      expect(first.problem).toMatch(/EBMR-IND-050/);
      const erp = gmp.seed.services.find((s) => s.key === 'erpInterface');
      if (!erp) throw new Error('no ERP interface in the GMP seed');
      const creds = { loginName: erp.loginName, serviceKey: erp.serviceKey, fingerprint: terminalOf(gmp.seed, erp.terminal).fingerprint };
      const product = { productCode: w.content.header.product.code, strength: w.content.header.product.strength, productName: 'dc-mini GMP product', reprocessingPermitted: false, betaLactam: false, shelfLifeMonths: 24, erpReference: `SAP-${randomUUID().slice(0, 6)}` };
      valueOf(await gmp.browser().call(routes.quality.erpImport, { body: { ...creds, catalogue: { products: [product], materials: [], orders: [] } } }));
      await confirmErpPending(gmp);
    }
    const label = valueOf(await issuer.call(I.label, { params: { batchId } }));
    expect(label.problem).toBeNull();
    expect(label.particulars).toMatchObject({ batchNumber: entry?.batchNumber, manufacturer: { licenceNumber: entry?.licenceNumber }, loanLicensee: null });
    expect(label.particulars?.expiryLabel).toMatch(/^\d{2}\/\d{4}$/);
    expect(label.h2).toMatchObject({ layoutVersion: 'H2-STUB-1', layoutStatus: 'U', issuedCount: 0 });
    const payload = label.h2.payload ?? '';
    expect(payload.startsWith('V=H2-STUB-1;UPIC=')).toBe(true);
    expect(valueOf(await issuer.call(I.verifyH2, { params: { batchId }, body: { payload } })).problem).toMatch(/never issued/);
    // The issuer holds no STEP.EXECUTE; the operator on the floor does.
    expect((refusalOf(await issuer.call(I.issueH2, { params: { batchId }, body: {} }))).code).toMatch(/EBMR-IAM/);
    // On the shared kiosk the release is confirmed by the operator's fresh badge tap (INV-40).
    const operator = await gmp.asPersona('operator1');
    const path = `/api/india/batches/${batchId}/h2-payload`;
    const attribution = await tapFor(operator, personaIn(gmp, 'operator1'), 'POST', path, {});
    const issued = valueOf(await operator.call(I.issueH2, { params: { batchId }, body: {}, attribution }));
    expect(issued).toMatchObject({ batchId, payload, layoutVersion: 'H2-STUB-1' });
    expect(valueOf(await issuer.call(I.verifyH2, { params: { batchId }, body: { payload } })).problem).toBeNull();
    expect(valueOf(await issuer.call(I.verifyH2, { params: { batchId }, body: { payload: payload.replace(/EXP=[0-9-]+/, 'EXP=2099-12') } })).problem).toMatch(/differs at EXP/);
  });

  it('[PR-43][IN-27] the head of QC records a stability basis; QA records a hazard class; an operator records neither', async () => {
    const head = await gmp.asPersona('qcApprover');
    const p = code();
    const b = valueOf(await head.call(I.recordShelfLifeBasis, { body: { productCode: p, strength: '500 mg', shelfLifeMonths: 36, stabilityReference: 'STAB-RPT-2026-11', tentative: true } }));
    expect(b).toMatchObject({ productCode: p, shelfLifeMonths: 36, tentative: true });
    expect(valueOf(await head.call(I.shelfLifeBases)).bases.some((x) => x.basisId === b.basisId)).toBe(true);
    const qa = await gmp.asPersona('approver');
    const h = valueOf(await qa.call(I.recordHazard, { body: { product: { productCode: p, hazardClass: 'STEROID', riskAssessmentRef: 'RA-STR-2026-01' } } }));
    expect(h.products[0]).toMatchObject({ productCode: p, hazardClass: 'STEROID' });
    const operator = await gmp.asPersona('operator1');
    expect((refusalOf(await operator.call(I.recordHazard, { body: { product: { productCode: p, hazardClass: 'NONE', riskAssessmentRef: 'x' } } }))).code).toMatch(/EBMR-IAM/);
    expect((refusalOf(await qa.call(I.recordHazard, { body: {} }))).code).toBe('EBMR-IND-037');
  });

  it('[IN-27] a recorded hazard class waits for a second QA person: the recorder\'s own approval signs nothing; another QA person approves it through the ceremony (INDIA_ACT HAZARD_APPROVE)', async () => {
    const qa = await gmp.asPersona('approver');
    const qa2 = await gmp.asPersona('qaInvestigator');
    const p = code();
    const h = valueOf(await qa.call(I.recordHazard, { body: { product: { productCode: p, hazardClass: 'NONE', riskAssessmentRef: 'RA-NONE-2026-02 (reassessed)' } } }));
    const rec = h.products.find((x) => x.productCode === p)!;
    expect(rec.state).toBe('RECORDED');
    expect((await signAction(gmp, qa, 'approver', { kind: 'INDIA_ACT', act: 'HAZARD_APPROVE', subjectId: rec.recordId })).ok).toBe(false);
    valueOf(await signAction(gmp, qa2, 'qaInvestigator', { kind: 'INDIA_ACT', act: 'HAZARD_APPROVE', subjectId: rec.recordId }));
    expect(valueOf(await qa.call(I.hazards)).products.find((x) => x.recordId === rec.recordId)?.state).toBe('APPROVED');
  });
});
