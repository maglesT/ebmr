/**
 * The quality feature on the GMP server (Phase 3 slice 5a step 5): deviation-lite and LIMS-lite routes run the person's
 * own command, and the ERP stub's import runs as the ERP interface's service identity; every rule is the database's.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';

const quality = routes.quality;
import { passwordActor, personaOf, terminalOf } from '@ebmr/test-kit';
import { randomUUID } from 'node:crypto';
import { identity, withCommand } from '@ebmr/kernel';
import type { Result, SignatureCredentials } from '@ebmr/api-contract';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { actorOfBrowser, personaIn, refusalOf, tapFor, valueOf } from '../esig/support.ts';
import { grantedPerson, loginOf, type GrantedPerson } from '../support/granted-person.ts';
import { actorOf, gmpLifecycleWorld, startGmpBatchWorld, type GmpBatchWorld } from '../support/gmp-world.ts';
import { reason } from '../../../../packages/recipe-core/test/lifecycle/support.ts';
import { confirmErpPending, signAction } from '../support/signed-acts.ts';

let w: GmpBatchWorld;
let gmp: TestServer;

/** A due date a month ahead (YYYY-MM-DD), for QA's classification. */
const dueDate = (): string => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 28)).toISOString().slice(0, 10);

/** The shape apps/simulators/src/erp posts (apps never import each other): one product, one material, `orders` orders. */
function erpCatalogue(opts: { orders: number; firstOrder?: number }) {
  return {
    products: [{ productCode: 'PCM500', strength: '500 mg', productName: 'Paracetamol tablets IP 500 mg', betaLactam: false, shelfLifeMonths: 36, erpReference: 'SAP-MM-FG-PCM500' }],
    materials: [{ materialCode: 'MAT-PCM', materialName: 'Paracetamol IP', materialKind: 'API' as const, unit: 'kg', maxRetestMonths: 24, erpReference: 'SAP-MM-RM-PCM' }],
    orders: Array.from({ length: opts.orders }, (_, i) => ({
      orderNo: `PO-DEMO-${String((opts.firstOrder ?? 1) + i)}`, siteCode: 'SITE-1', productCode: 'PCM500', strength: '500 mg', batchSize: '60.000', batchSizeUnit: 'kg',
      bom: [{ materialCode: 'MAT-PCM', quantity: '50.000', unit: 'kg' }], erpReference: `SAP-PP-${String(i)}`,
    })),
  };
}

beforeAll(async () => {
  w = await startGmpBatchWorld();
  gmp = w.gmp;
}, 600_000);
afterAll(async () => {
  await w?.close();
});

describe('quality routes (GMP)', () => {
  it('[PR-49][PR-17] a QA person raises and investigates a deviation-lite record with a generated reference; the ERP interface imports its catalogue and nobody else can', async () => {
    const qa = await gmp.asPersona('qaInvestigator');
    const d = valueOf(await qa.call(quality.raiseDeviation, { body: { kind: 'DEVIATION', title: 'Label roll mix-up', classification: 'MINOR', riskRationale: 'Caught at line clearance; no product affected' } }));
    expect(d.ref).toMatch(/^DEV-SITE-1-\d{4}-\d{5}$/);
    expect(d.state).toBe('OPEN');
    // The initiator cannot cancel their own record (S7): the database refuses it.
    expect(refusalOf(await qa.call(quality.cancelDeviation, { params: { deviationId: d.deviationId }, body: { reason: 'raised in error' } }))?.why).toMatch(/EBMR-SITE-307|other than the initiator/);
    // QA other than the initiator classifies it and starts the investigation (IN-02; Phase 4 slice 2a).
    const classification = { classification: 'MINOR' as const, riskRationale: 'Caught at line clearance; no product affected', ownerPersonId: personaOf(gmp.seed, 'qaInvestigator').personId, dueDate: dueDate() };
    expect(refusalOf(await qa.call(quality.startInvestigation, { params: { deviationId: d.deviationId }, body: classification }))?.why).toMatch(/was raised by this person; QA other than the initiator classifies it/);
    const qa2 = await gmp.asPersona('qaApprover2');
    const started = valueOf(await qa2.call(quality.startInvestigation, { params: { deviationId: d.deviationId }, body: classification }));
    expect(started.state).toBe('UNDER_INVESTIGATION');

    const erp = gmp.seed.services.find((s) => s.key === 'erpInterface');
    if (!erp) throw new Error('no ERP interface in the GMP seed');
    const creds = { loginName: erp.loginName, serviceKey: erp.serviceKey, fingerprint: terminalOf(gmp.seed, erp.terminal).fingerprint };
    const browser = gmp.browser();
    const out = valueOf(await browser.call(quality.erpImport, { body: { ...creds, catalogue: erpCatalogue({ orders: 2, firstOrder: 9001 }) } }));
    expect(out).toEqual({ products: 1, materials: 1, orders: 2 });
    const { rows } = await gmp.db.admin.query<{ n: string }>("select count(*)::text as n from site.erp_production_order where order_no in ('PO-DEMO-9001', 'PO-DEMO-9002')");
    expect(rows[0]?.n).toBe('2');
    // A wrong key is refused, and a person's credentials never write the ERP stub.
    expect((await browser.call(quality.erpImport, { body: { ...creds, serviceKey: `${creds.serviceKey}x`, catalogue: erpCatalogue({ orders: 0 }) } })).ok).toBe(false);
  });

  it('[PR-47][IN-24] a new or changed ERP master waits for QA: listed as pending beside the values in effect, confirmed by the QA MBR approver\'s signature over HTTP (MASTER_DATA_APPROVE), never by the QA investigator; the masters in effect list it afterwards (exit review HIGH-1)', async () => {
    const erp = gmp.seed.services.find((s) => s.key === 'erpInterface');
    if (!erp) throw new Error('no ERP interface in the GMP seed');
    const creds = { loginName: erp.loginName, serviceKey: erp.serviceKey, fingerprint: terminalOf(gmp.seed, erp.terminal).fingerprint };
    const qa = await gmp.asPersona('qaInvestigator');
    const code = `MAT-H1-${randomUUID().slice(0, 6).toUpperCase()}`;
    const material = { materialCode: code, materialName: 'Exit review excipient', materialKind: 'EXCIPIENT' as const, unit: 'kg', maxRetestMonths: 24, erpReference: `SAP-${code}` };
    valueOf(await gmp.browser().call(quality.erpImport, { body: { ...creds, catalogue: { products: [], materials: [material], orders: [] } } }));
    const pendingOf = async () => valueOf(await qa.call(quality.erpPending)).pending.filter((p) => p.key === code);
    const [p] = await pendingOf();
    expect(p).toMatchObject({ masterKind: 'MATERIAL', values: { materialKind: 'EXCIPIENT', maxRetestMonths: 24 }, inEffect: null });
    expect(valueOf(await qa.call(quality.erpMaterials)).materials.map((m) => m.materialCode)).not.toContain(code);
    const action = { kind: 'MASTER_DATA_APPROVE' as const, masterKind: 'ERP_MATERIAL' as const, versionId: p?.versionId ?? '' };
    expect(valueOf(await qa.call(routes.esig.describe, { body: { action } }))).toMatchObject({ aggregateType: 'erp_master', aggregateId: `MATERIAL/${p?.versionId}`, meaning: 'ERP_MASTER_CONFIRMED' });
    expect((await signAction(gmp, qa, 'qaInvestigator', action)).ok).toBe(false);
    expect(await confirmErpPending(gmp)).toBeGreaterThanOrEqual(1);
    expect(await pendingOf()).toEqual([]);
    expect(valueOf(await qa.call(quality.erpMaterials)).materials.find((m) => m.materialCode === code)).toMatchObject({ materialKind: 'EXCIPIENT' });
    // The ERP makes it an intermediate: pending again, and the material stays an excipient until QA confirms.
    valueOf(await gmp.browser().call(quality.erpImport, { body: { ...creds, catalogue: { products: [], materials: [{ ...material, materialKind: 'INTERMEDIATE', erpReference: `SAP-${code}/2` }], orders: [] } } }));
    const [again] = await pendingOf();
    expect([again?.values['materialKind'], again?.inEffect?.['materialKind']]).toEqual(['INTERMEDIATE', 'EXCIPIENT']);
    expect(valueOf(await qa.call(quality.erpMaterials)).materials.find((m) => m.materialCode === code)).toMatchObject({ materialKind: 'EXCIPIENT' });
  });

  it('[DI-22][DI-24][INV-09] an ERP master confirmation keeps its signed content after it takes effect: the values in effect and the changes are those before it (issue #95)', async () => {
    // The material of the test above, now with a pending change: confirm it, then nothing about either signature changed.
    expect(await confirmErpPending(gmp)).toBeGreaterThanOrEqual(1);
    const { rows } = await gmp.db.admin.query<{ id: string; problem: string }>(
      `select v.signature_id::text as id, v.problem from esig.verify_signatures() v join esig.signature s on s.id = v.signature_id
        where s.aggregate_type = 'erp_master'`);
    expect(rows).toEqual([]);
    const { rows: signed } = await gmp.db.admin.query<{ n: string }>("select count(*)::text as n from esig.signature where aggregate_type = 'erp_master'");
    expect(Number(signed[0]?.n)).toBeGreaterThanOrEqual(2);
  });

  it('the reprocessing registers are listed read-only (requests, authorisations, reservable residue), and the server describes what a signable action signs', async () => {
    const qa = await gmp.asPersona('qaInvestigator');
    expect(valueOf(await qa.call(quality.reprocessingRequests)).requests).toEqual(expect.any(Array));
    expect(valueOf(await qa.call(quality.reprocessingAuthorisations, { query: {} })).authorisations).toEqual(expect.any(Array));
    expect(valueOf(await qa.call(quality.residues, { query: {} })).containers).toEqual(expect.any(Array));
    const batchId = '6b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e';
    const issuer = await gmp.asPersona('issuer');
    const d = valueOf(await issuer.call(routes.esig.describe, { body: { action: { kind: 'GMP_BATCH_ISSUE', batchId, reason: { code: 'PLAN', text: 'Plan' }, variants: {}, inputs: {} } } }));
    expect(d).toEqual({ kind: 'GMP_BATCH_ISSUE', aggregateType: 'batch_issue', aggregateId: batchId, meaning: 'ISSUED', expectedState: 'PLANNED' });
  });

});

const password = (p: GrantedPerson): SignatureCredentials => ({ kind: 'PASSWORD', loginName: p.loginName, password: p.password });

/** A person holding `role` who has acknowledged the e-signature policy (as the seed's personas have), signed in on the QA office PC. */
async function signer(role: string, name: string): Promise<{ person: GrantedPerson; browser: TestBrowser }> {
  const person = await grantedPerson(gmp, role, name);
  const ctx = await passwordActor(gmp.db, person, terminalOf(gmp.seed, 'PC-QA-01').fingerprint);
  await withCommand(gmp.db.app, ctx, (c) => identity.acknowledgeEsigPolicy(c));
  await identity.endSession(gmp.db.app, ctx.sessionId);
  return { person, browser: await loginOf(gmp, person) };
}

/** A signed act that must succeed (the refusal shown when it does not). */
async function signedOk(r: Promise<Result<unknown>>): Promise<void> {
  const out = await r;
  expect(out.ok, out.ok ? '' : JSON.stringify(out.error)).toBe(true);
}

/** A DB call as the application role in the persona's own session; the error text, or null when it passed. */
async function asApp(b: TestBrowser, key: string, sql: string, params: unknown[]): Promise<string | null> {
  try {
    await withCommand(gmp.db.app, { ...(await actorOfBrowser(gmp, b, key)), correlationId: randomUUID() }, (c) => c.query(sql, params));
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

describe('signed quality, lot, reprocessing and plant acts over HTTP (slice 6a)', () => {
  it('[IN-02] a deviation classified MINOR without a rationale is refused by the route and by the database', async () => {
    const qa = await gmp.asPersona('qaInvestigator');
    for (const riskRationale of ['', '   ', 'too short']) {
      const r = await qa.call(quality.raiseDeviation, { body: { kind: 'DEVIATION', title: 'Label roll mix-up', classification: 'MINOR', riskRationale } });
      expect(r.ok, JSON.stringify(riskRationale)).toBe(false);
    }
    // The database refuses it as the application role in the person's own session, and nobody writes the table directly.
    const p = { kind: 'DEVIATION', title: 'Label roll mix-up', classification: 'MINOR' };
    expect(await asApp(qa, 'qaInvestigator', 'select site.raise_deviation($1::jsonb)', [JSON.stringify(p)])).toMatch(/EBMR-SITE-301.*risk rationale/);
    expect(await asApp(qa, 'qaInvestigator', 'select site.raise_deviation($1::jsonb)', [JSON.stringify({ ...p, riskRationale: '         ' })])).toMatch(/EBMR-SITE-301/);
    expect(
      await asApp(qa, 'qaInvestigator', "insert into site.deviation (ref, site_code, ref_year, ref_serial, kind, title, classification, risk_rationale, raised_by_person, raised_by_account, correlation_id) values ('DEV-X', 'SITE-1', 2026, 99999, 'DEVIATION', 't', 'MINOR', '', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())", []),
    ).toMatch(/permission denied/);
    expect(valueOf(await qa.call(quality.raiseDeviation, { body: { kind: 'DEVIATION', title: 'Label roll mix-up', classification: 'MINOR', riskRationale: 'Caught at line clearance; no product affected' } })).classification).toBe('MINOR');
  });

  it('[PR-50] the impact sign-off, the conclusion and the closure succeed through the ceremony and are refused for the initiator, the owner or changed content; the closure basis and the detail over HTTP (slice 2a)', async () => {
    const [inv, qa2] = await Promise.all([gmp.asPersona('qaInvestigator'), gmp.asPersona('qaApprover2')]);
    const d = valueOf(await inv.call(quality.raiseDeviation, { body: { kind: 'DEVIATION', title: 'Granulation end point late', classification: 'MAJOR', riskRationale: 'End point reached after the validated time' } }));
    const id = { deviationId: d.deviationId };
    const owner = personaOf(gmp.seed, 'qaInvestigator').personId;
    const qaFloor = await loginOf(gmp, await grantedPerson(gmp, 'QA_SHOP_FLOOR', 'Meera Pillai (QA classifier)'));
    // QA who classifies enters data in the record: a performer, so neither concludes nor closes it (INV-03).
    valueOf(await qaFloor.call(quality.startInvestigation, { params: id, body: { classification: 'MAJOR', riskRationale: 'End point outside the validated time; density at risk', ownerPersonId: owner, dueDate: dueDate() } }));
    expect(valueOf(await qaFloor.call(quality.reclassifyDeviation, { params: id, body: { classification: 'CRITICAL', riskRationale: 'Dissolution failure possible on the retained samples', ownerPersonId: owner, dueDate: dueDate() } })).qaClassification).toMatchObject({ classification: 'CRITICAL', ownerPersonId: owner });
    valueOf(await inv.call(quality.recordFinding, { params: id, body: { assignableCause: true, cause: 'Binder added slowly by a worn pump', rootCauseCategory: 'EQUIPMENT' } }));
    expect(refusalOf(await inv.call(quality.recordDeviationImpact, { params: id, body: { linkId: randomUUID(), market: 'IN', impact: 'NONE', rationale: 'No subject of this record' } }))?.why).toMatch(/the impact names a subject linked to/);
    const assess = { kind: 'QUALITY_ACT' as const, act: 'DEVIATION_IMPACT_ASSESS' as const, subjectId: d.deviationId, input: {} };
    // The initiator is also the owner here: the database refuses the sign-off, and the record stays under investigation.
    expect((await signAction(gmp, inv, 'qaInvestigator', assess)).ok).toBe(false);
    await signedOk(signAction(gmp, qa2, 'qaApprover2', assess));
    expect(valueOf(await inv.call(quality.deviation, { params: id })).state).toBe('IMPACT_ASSESSED');
    const basis = valueOf(await inv.call(quality.recordDeviationClosureBasis, {
      params: id,
      body: { rootCauseMethod: 'Fishbone with production and engineering', capaRefs: ['CAPA-26-021'], notificationRequired: false, notificationRationale: 'No registered detail or licence condition is affected', otherBatches: [{ subjectKind: 'PRODUCT', ref: 'Paracetamol 500 mg since the pump service', included: false, reason: 'Pump replaced before them' }] },
    }));
    expect(basis.closureBasis).toMatchObject({ capaRefs: ['CAPA-26-021'], recordedBy: owner });
    const conclude = { kind: 'QUALITY_ACT' as const, act: 'DEVIATION_CONCLUDE' as const, subjectId: d.deviationId, input: {} };
    expect((await signAction(gmp, inv, 'qaInvestigator', conclude)).ok).toBe(false);
    expect((await signAction(gmp, qa2, 'qaApprover2', conclude, { tamper: true })).ok).toBe(false);
    expect(valueOf(await inv.call(quality.deviation, { params: { deviationId: d.deviationId } })).state).toBe('IMPACT_ASSESSED');
    await signedOk(signAction(gmp, qa2, 'qaApprover2', conclude));
    expect(valueOf(await inv.call(quality.deviation, { params: id })).state).toBe('PENDING_CLOSURE');
    const close = { kind: 'QUALITY_ACT' as const, act: 'DEVIATION_CLOSE' as const, subjectId: d.deviationId, input: {} };
    expect((await signAction(gmp, inv, 'qaInvestigator', close)).ok).toBe(false);
    await signedOk(signAction(gmp, qa2, 'qaApprover2', close));
    expect(valueOf(await inv.call(quality.deviation, { params: { deviationId: d.deviationId } })).state).toBe('CLOSED');
    expect(valueOf(await inv.call(quality.deviationDetail, { params: id }))).toMatchObject({ state: 'CLOSED', impactCurrent: true, finding: { rootCauseCategory: 'EQUIPMENT' }, cancelReason: null });
    expect(valueOf(await inv.call(quality.deviationRelease, { query: { subjectKind: 'LOT', subjectId: randomUUID() } }))).toEqual({ items: [], problem: null });
    // An act that carries what another act takes is refused before anything is signed.
    expect(refusalOf(await signAction(gmp, qa2, 'qaApprover2', { ...conclude, input: { decision: 'EXTRA_TESTS' } }))?.code).toBe('EBMR-API-ACT-INPUT');
  }, 180_000);

  it('a lot test result approval, the retest, and the lot release and rejection succeed through the ceremony and are refused for the wrong person or changed content', async () => {
    const [analyst, head, qaRel] = await Promise.all([gmp.asPersona('qcAnalyst'), gmp.asPersona('qcApprover'), gmp.asPersona('qaInvestigator')]);
    const erp = gmp.seed.services.find((s) => s.key === 'erpInterface');
    if (!erp) throw new Error('no ERP interface');
    const creds = { loginName: erp.loginName, serviceKey: erp.serviceKey, fingerprint: terminalOf(gmp.seed, erp.terminal).fingerprint };
    const material = { materialCode: 'MAT-S6', materialName: 'Slice 6 excipient', materialKind: 'EXCIPIENT' as const, unit: 'kg', maxRetestMonths: 24, erpReference: 'SAP-MAT-S6' };
    valueOf(await gmp.browser().call(quality.erpImport, { body: { ...creds, catalogue: { products: [], materials: [material], orders: [] } } }));
    await confirmErpPending(gmp);
    // The material's specification (Phase 4 slice 2b): drafted by the analyst, approved by the head of QC; results take their limits from it.
    const spec = valueOf(await analyst.call(routes.specifications.draft, {
      body: {
        materialCode: 'MAT-S6', title: 'Slice 6 excipient', monographReference: 'In-house STP-S6',
        tests: [{ testCode: 'ASSAY', methodReference: 'STP-S6-01', unit: '%', lowerLimit: '98.0', upperLimit: '102.0', required: true, pharmacopoeia: 'IP', edition: '2022', sampleQuantity: '0.010', sampleUnit: 'kg' }],
      },
    }));
    await signedOk(signAction(gmp, head, 'qcApprover', { kind: 'LIMS_ACT', act: 'SPECIFICATION_APPROVE', subjectId: spec.specificationId }));
    const warehouse = await loginOf(gmp, await grantedPerson(gmp, 'WAREHOUSE_LABELLING', 'Ramesh Iyer (warehouse)'));
    const receive = async (lotCode: string) =>
      valueOf(await warehouse.call(quality.receiveLot, {
        body: { materialCode: 'MAT-S6', lotCode, supplier: 'Demo Excipients', supplierLot: `S-${lotCode}`, quantity: '100.000', expiresAt: '2029-09-30T00:00:00+05:30', retestAt: '2027-03-31T00:00:00+05:30' },
      }));
    const lot = await receive(`L6-${randomUUID().slice(0, 6).toUpperCase()}`);
    expect(lot).toMatchObject({ status: 'QUARANTINE', material: { code: 'MAT-S6', kind: 'EXCIPIENT' }, quantity: '100' });
    expect(valueOf(await warehouse.call(quality.lots, { query: { materialCode: 'MAT-S6' } })).lots.map((l) => l.lotId)).toContain(lot.lotId);

    // A release result, approved by the head of QC (never its analyst, never on other content than shown).
    const result = valueOf(await analyst.call(quality.recordLotResult, {
      params: { lotId: lot.lotId },
      body: { testCode: 'ASSAY', methodReference: 'STP-S6-01', purpose: 'RELEASE', value: '99.5', unit: '%' },
    }));
    const approve = { kind: 'QUALITY_ACT' as const, act: 'LOT_RESULT_APPROVE' as const, subjectId: result.resultId, input: {} };
    expect((await signAction(gmp, analyst, 'qcAnalyst', approve)).ok).toBe(false);
    expect((await signAction(gmp, head, 'qcApprover', approve, { tamper: true })).ok).toBe(false);
    await signedOk(signAction(gmp, head, 'qcApprover', approve));
    expect(valueOf(await analyst.call(quality.lotResults, { params: { lotId: lot.lotId } })).results[0]?.state).toBe('APPROVED');

    // The retest: an approved retest result, then QC's signed decision of the new date.
    const retestResult = valueOf(await analyst.call(quality.recordLotResult, {
      params: { lotId: lot.lotId },
      body: { testCode: 'ASSAY', methodReference: 'STP-S6-01', purpose: 'RETEST', value: '99.1', unit: '%' },
    }));
    await signedOk(signAction(gmp, head, 'qcApprover', { ...approve, subjectId: retestResult.resultId }));
    const retest = { kind: 'QUALITY_ACT' as const, act: 'LOT_RETEST' as const, subjectId: lot.lotId, input: { retestAt: '2027-09-30T00:00:00+05:30', results: [retestResult.resultId] } };
    expect((await signAction(gmp, analyst, 'qcAnalyst', retest)).ok).toBe(false);
    expect((await signAction(gmp, head, 'qcApprover', retest, { tamper: true })).ok).toBe(false);
    await signedOk(signAction(gmp, head, 'qcApprover', retest));
    expect(valueOf(await analyst.call(quality.lots, { query: { materialCode: 'MAT-S6' } })).lots.find((l) => l.lotId === lot.lotId)?.retest?.text).toMatch(/30-SEP-2027/);
    // Bypass: the signed retest writer refuses a call without the person's own signature.
    expect(await asApp(head, 'qcApprover', 'select site.record_signed_lot_retest($1, $2::timestamptz, $3::uuid[], null)', [lot.lotId, '2027-10-31T00:00:00+05:30', [retestResult.resultId]])).toMatch(/EBMR-SITE-190/);

    // The release on the identity route (QA), refused for QC's analyst and for other content.
    expect(await asApp(analyst, 'qcAnalyst', "select site.record_identity_result($1, 'PASS', 'STP-S6-ID', 'IR-S6-1')", [lot.lotId])).toBeNull();
    const release = { kind: 'LOT_DECISION' as const, lotId: lot.lotId, decision: 'RELEASE' as const, route: 'IDENTITY_TESTED' as const };
    expect((await signAction(gmp, analyst, 'qcAnalyst', release)).ok).toBe(false);
    expect((await signAction(gmp, qaRel, 'qaInvestigator', release, { tamper: true })).ok).toBe(false);
    const released = await signAction(gmp, qaRel, 'qaInvestigator', release);
    expect(released.ok, released.ok ? '' : JSON.stringify(released.error)).toBe(true);
    expect(valueOf(await analyst.call(quality.lots, { query: { materialCode: 'MAT-S6' } })).lots.find((l) => l.lotId === lot.lotId)?.status).toBe('RELEASED');

    // The rejection of a quarantined lot: the server names its meaning from the lot's state.
    const other = await receive(`L6-${randomUUID().slice(0, 6).toUpperCase()}`);
    const reject = { kind: 'LOT_DECISION' as const, lotId: other.lotId, decision: 'REJECT' as const, reason: { code: 'QC_FAILURE', text: 'Supplier certificate does not match the lot' } };
    expect(valueOf(await head.call(routes.esig.describe, { body: { action: reject } }))).toMatchObject({ meaning: 'MATERIAL_LOT_REJECTED', expectedState: 'QUARANTINE' });
    expect((await signAction(gmp, analyst, 'qcAnalyst', reject)).ok).toBe(false);
    expect((await signAction(gmp, head, 'qcApprover', reject, { meaning: 'MATERIAL_LOT_STATUS_DECIDED' })).ok).toBe(false);
    await signedOk(signAction(gmp, head, 'qcApprover', reject));
    expect(valueOf(await head.call(quality.lots, { query: { materialCode: 'MAT-S6' } })).lots.find((l) => l.lotId === other.lotId)?.status).toBe('REJECTED');

    // [DI-35] A lot on hold is rejected with the meaning the lot's machine requires from every state, MATERIAL_LOT_REJECTED:
    // the server names it, and the status meaning is refused. The hold itself is QA's signed decision in the database.
    const world = await gmpLifecycleWorld(gmp);
    const qaHold = await actorOf(gmp, 'qaApprover2');
    // The decision is proposed first, so the signed content names it (site-services 0800).
    await world.run(qaHold, (c) => c.query("select site.propose_lot_decision($1, 'HOLD')", [lot.lotId]));
    const holdSig = await world.sign(qaHold, 'material_lot', lot.lotId, 'MATERIAL_LOT_STATUS_DECIDED', 'RELEASED');
    const lotVersion = (await gmp.db.admin.query<{ v: string }>("select version::text as v from platform.aggregate_state where aggregate_type = 'material_lot' and aggregate_id = $1", [lot.lotId])).rows[0]?.v;
    await world.run(qaHold, (c) => c.query("select site.change_lot_status($1, 'HOLD', $2::bigint, $3)", [lot.lotId, lotVersion, holdSig]), reason('Customer complaint on the supplier lot under investigation'));
    const rejectHeld = { kind: 'LOT_DECISION' as const, lotId: lot.lotId, decision: 'REJECT' as const, reason: { code: 'QC_FAILURE', text: 'Complaint investigation confirmed the supplier lot is out of specification' } };
    expect(valueOf(await qaRel.call(routes.esig.describe, { body: { action: rejectHeld } }))).toMatchObject({ meaning: 'MATERIAL_LOT_REJECTED', expectedState: 'ON_HOLD' });
    expect((await signAction(gmp, qaRel, 'qaInvestigator', rejectHeld, { meaning: 'MATERIAL_LOT_STATUS_DECIDED' })).ok).toBe(false);
    // From hold the decision is QA's (MATERIAL.QA_DISPOSITION): the head of QC is refused by the database, QA signs it.
    expect((await signAction(gmp, head, 'qcApprover', rejectHeld)).ok).toBe(false);
    await signedOk(signAction(gmp, qaRel, 'qaInvestigator', rejectHeld));
    expect(valueOf(await head.call(quality.lots, { query: { materialCode: 'MAT-S6' } })).lots.find((l) => l.lotId === lot.lotId)?.status).toBe('REJECTED');
  }, 300_000);

  it('[INV-40] a lot receipt from a shared kiosk without a fresh badge tap is refused with 428 and records nothing; with the tap it reaches the database', async () => {
    const kiosk = await gmp.asPersona('operator1');
    const lotCode = `L6K-${randomUUID().slice(0, 6).toUpperCase()}`;
    const body = { materialCode: 'MAT-S6', lotCode, supplier: 'Demo Excipients', supplierLot: `S-${lotCode}`, quantity: '10.000', expiresAt: '2029-09-30T00:00:00+05:30' };
    expect(refusalOf(await kiosk.call(quality.receiveLot, { body }))).toMatchObject({ status: 428, code: 'TAP_REQUIRED' });
    const count = async () => (await gmp.db.admin.query<{ n: string }>('select count(*)::text as n from site.material_lot where lot_code = $1', [lotCode])).rows[0]?.n;
    expect(await count()).toBe('0');
    // With the operator's tap the request is the operator's: the database decides it by the operator's own role.
    const tapped = await kiosk.call(quality.receiveLot, { body, attribution: await tapFor(kiosk, personaIn(gmp, 'operator1'), 'POST', '/api/lots', body) });
    expect(refusalOf(tapped)?.status).not.toBe(428);
  }, 180_000);

  it('the QC decision on extra testing of a batch succeeds through the ceremony and is refused for the wrong person or changed content', async () => {
    const [analyst, head, issuer] = await Promise.all([gmp.asPersona('qcAnalyst'), gmp.asPersona('qcApprover'), gmp.asPersona('issuer')]);
    const batchId = await w.issued(issuer);
    const act = { kind: 'QUALITY_ACT' as const, act: 'QC_EXTRA_TESTING_DECISION' as const, subjectId: batchId, input: { decision: 'EXTRA_TESTS' as const, tests: ['IMPURITIES', 'DISSOLUTION'] } };
    const d = valueOf(await head.call(routes.esig.describe, { body: { action: act } }));
    const { rows } = await gmp.db.admin.query<{ id: string }>("select site.qc_extra_testing_aggregate_id($1, 'EXTRA_TESTS', array['IMPURITIES', 'DISSOLUTION']) as id", [batchId]);
    expect(d).toMatchObject({ aggregateType: 'qc_extra_testing', aggregateId: rows[0]?.id, meaning: 'QC_EXTRA_TESTING_DECIDED' });
    expect((await signAction(gmp, analyst, 'qcAnalyst', act)).ok).toBe(false);
    expect((await signAction(gmp, head, 'qcApprover', act, { tamper: true })).ok).toBe(false);
    expect(valueOf(await head.call(quality.extraTesting, { params: { batchId } })).decision).toBeNull();
    await signedOk(signAction(gmp, head, 'qcApprover', act));
    expect(valueOf(await head.call(quality.extraTesting, { params: { batchId } })).decision).toMatchObject({ decision: 'EXTRA_TESTS', tests: ['DISSOLUTION', 'IMPURITIES'] });
  }, 300_000);

  it('the reprocessing acts sign nothing for a person without the quality unit\'s authority, for changed content, or when the database refuses the record', async () => {
    const [analyst, issuer] = await Promise.all([gmp.asPersona('qcAnalyst'), gmp.asPersona('issuer')]);
    const { person: qaFloor, browser: qaBrowser } = await signer('QA_SHOP_FLOOR', 'Farah Ali (QA shop floor)');
    const batchId = await w.issued(issuer);
    // A container of the batch that no inspection step put reusable residue into (written as the owner for the test).
    const container = randomUUID();
    await withCommand(gmp.db.admin, { ...(await actorOfBrowser(gmp, issuer, 'issuer')), correlationId: randomUUID() }, async (c) => {
      await c.query(
        "insert into plant.output_container (id, label_code, batch_id, batch_number, product_code, strength, stage, quantity_unit, opened_by_person, opened_by_account) select $1, 'OC-' || b.batch_number || '-9001', b.id, b.batch_number, $3, $4, 'BLEND', 'kg', gen_random_uuid(), gen_random_uuid() from recipe.batch_execution b where b.id = $2",
        [container, batchId, w.content.header.product.code, w.content.header.product.strength],
      );
    });
    const reserve = { kind: 'REPROCESSING_ACT' as const, act: 'RESERVE_RESIDUE' as const, subjectId: container, input: {} };
    expect((await signAction(gmp, analyst, 'qcAnalyst', reserve)).ok).toBe(false);
    expect((await signAction(gmp, qaBrowser, 'x', reserve, { tamper: true, credentials: password(qaFloor) })).ok).toBe(false);
    const refused = await signAction(gmp, qaBrowser, 'x', reserve, { credentials: password(qaFloor) });
    expect(refusalOf(refused)?.code).toBe('EBMR-RPR-010');
    const { rows } = await gmp.db.admin.query<{ n: string }>("select count(*)::text as n from esig.signature where aggregate_type = 'output_container' and aggregate_id = $1", [container]);
    expect(rows[0]?.n).toBe('0');
    const authorise = { kind: 'REPROCESSING_ACT' as const, act: 'AUTHORISE_ADDITION' as const, subjectId: randomUUID(), input: {} };
    expect(refusalOf(await signAction(gmp, qaBrowser, 'x', authorise, { credentials: password(qaFloor) }))?.status ?? 404).toBeGreaterThanOrEqual(400);
  }, 300_000);

  it('plant verifications (cleaning, clearance, repair) succeed through the ceremony and are refused for the performer or changed content', async () => {
    const [steward, issuer] = await Promise.all([gmp.asPersona('steward'), gmp.asPersona('issuer')]);
    const { person: tech1, browser: b1 } = await signer('MAINTENANCE_TECHNICIAN', 'Suresh Pillai (maintenance)');
    const { person: tech2, browser: b2 } = await signer('MAINTENANCE_TECHNICIAN', 'Anand Rao (maintenance)');
    const tag = randomUUID().slice(0, 4).toUpperCase();
    valueOf(await steward.call(routes.plant.defineEquipmentClass, { body: { code: `BLD${tag}`, kind: 'PROCESS', description: 'Bin blender', cleanHold: '72 hours', dirtyHold: '24 hours' } }));
    valueOf(await steward.call(routes.plant.defineArea, { body: { code: `RM${tag}`, kind: 'ROOM', name: 'Blending room' } }));
    const eq = valueOf(await steward.call(routes.plant.defineEquipment, { body: { code: `BLD-${tag}`, name: 'Bin blender 200 L', classCode: `BLD${tag}`, areaCode: `RM${tag}` } }));
    expect(eq).toMatchObject({ kind: 'PROCESS', areaCode: `RM${tag}` });
    const started = valueOf(await b1.call(routes.plant.startCleaning, { body: { target: 'EQUIPMENT', code: eq.code, level: 'MAJOR' } }));
    valueOf(await b1.call(routes.plant.completeCleaning, { params: { id: started.cleaningId }, body: {} }));
    expect(valueOf(await b2.call(routes.plant.pendingVerifications)).items.map((i) => i.id)).toContain(started.cleaningId);
    const verify = { kind: 'PLANT_VERIFY' as const, act: 'CLEANING' as const, id: started.cleaningId };
    expect((await signAction(gmp, b1, 'x', verify, { credentials: password(tech1) })).ok).toBe(false);
    expect((await signAction(gmp, b2, 'x', verify, { tamper: true, credentials: password(tech2) })).ok).toBe(false);
    const ok = await signAction(gmp, b2, 'x', verify, { credentials: password(tech2) });
    expect(ok.ok, ok.ok ? '' : JSON.stringify(ok.error)).toBe(true);

    // A repair of the unit's open failure, verified by another technician.
    // The failure is signalled by the operator at the unit (STEP.EXECUTE), with a badge tap on the kiosk.
    const operatorAtUnit = await gmp.asPersona('operator1');
    const batchNumber = valueOf(await issuer.call(routes.batches.batch, { params: { batchId: await w.issued(issuer) } })).header.batchNumber;
    const failure = { event: 'EVENT' as const, kind: 'FAILURE_SIGNALLED' as const, detail: 'Drive belt slipping', batchNumber };
    valueOf(await operatorAtUnit.call(routes.plant.equipmentEvent, { params: { code: eq.code }, body: failure, attribution: await tapFor(operatorAtUnit, personaIn(gmp, 'operator1'), 'POST', `/api/plant/equipment/${eq.code}/events`, failure) }));
    const repair = valueOf(await b1.call(routes.plant.equipmentEvent, { params: { code: eq.code }, body: { event: 'REPAIR', detail: 'Belt replaced', reference: 'WO-2026-0101' } }));
    const verifyRepair = { kind: 'PLANT_VERIFY' as const, act: 'REPAIR' as const, id: repair.id };
    expect((await signAction(gmp, b1, 'x', verifyRepair, { credentials: password(tech1) })).ok).toBe(false);
    await signedOk(signAction(gmp, b2, 'x', verifyRepair, { credentials: password(tech2) }));

    // A clearance of the room for a GMP batch, recorded by an operator on the room's kiosk and verified by a verifier.
    // The room is cleaned (and the cleaning verified) before it is cleared.
    const roomCleaning = valueOf(await b1.call(routes.plant.startCleaning, { body: { target: 'AREA', code: `RM${tag}`, level: 'MAJOR' } }));
    valueOf(await b1.call(routes.plant.completeCleaning, { params: { id: roomCleaning.cleaningId }, body: {} }));
    await signedOk(signAction(gmp, b2, 'x', { kind: 'PLANT_VERIFY', act: 'CLEANING', id: roomCleaning.cleaningId }, { credentials: password(tech2) }));
    const batchId = await w.issued(issuer);
    const operator = await gmp.asPersona('operator1');
    // The plant's product list names the batch's product (master data; no screen of slice 6 writes it).
    expect(await asApp(steward, 'steward', "select plant.define_product(jsonb_build_object('code', $1::text, 'name', $2::text, 'highlyPotent', false))", [w.content.header.product.code, w.content.header.product.name])).toBeNull();
    const body = { areaCode: `RM${tag}`, type: 'PRODUCT_CHANGE' as const, batchId, result: 'PASSED' as const };
    const clearance = await operator.call(routes.plant.recordClearance, { body, attribution: await tapFor(operator, personaIn(gmp, 'operator1'), 'POST', '/api/plant/clearances', body) });
    if (!clearance.ok) throw new Error(`the clearance was refused: ${JSON.stringify(clearance.error)}`);
    const { person: verifier, browser: vb } = await signer('VERIFIER', 'Kavya Reddy (verifier)');
    const verifyClearance = { kind: 'PLANT_VERIFY' as const, act: 'CLEARANCE' as const, id: clearance.value.clearanceId };
    expect((await signAction(gmp, operator, 'operator1', verifyClearance)).ok).toBe(false);
    expect((await signAction(gmp, vb, 'x', verifyClearance, { tamper: true, credentials: password(verifier) })).ok).toBe(false);
    await signedOk(signAction(gmp, vb, 'x', verifyClearance, { credentials: password(verifier) }));
  }, 300_000);
});
