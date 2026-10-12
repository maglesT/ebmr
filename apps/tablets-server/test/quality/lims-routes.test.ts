/**
 * Phase 4 slice 2b over HTTP (feature lims, contract ns/specifications.ts and ns/samples.ts): a specification drafted by
 * QC and approved by another person (LIMS_ACT), results recorded against it, the lot status events HOLD, UNHOLD, RETURN
 * and RECALL proposed by QA and then signed (LOT_DECISION, D-P4-3), the finished lot of a packaging order, returned goods
 * with QC's signed assessment, and samples. Every rule is the database's; the routes carry the person's own command.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type Result, type SignableAction } from '@ebmr/api-contract';
import { withCommand } from '@ebmr/kernel';
import { terminalOf } from '@ebmr/test-kit';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { actorOfBrowser, refusalOf, valueOf } from '../esig/support.ts';
import { startGmpBatchWorld, type GmpBatchWorld } from '../support/gmp-world.ts';
import { confirmErpPending, signAction } from '../support/signed-acts.ts';

let w: GmpBatchWorld;
let gmp: TestServer;
const S = routes.specifications;
const Q = routes.quality;

beforeAll(async () => {
  w = await startGmpBatchWorld();
  gmp = w.gmp;
}, 600_000);
afterAll(async () => {
  await w?.close();
});

async function signedOk(r: Promise<Result<unknown>>): Promise<void> {
  const out = await r;
  expect(out.ok, out.ok ? '' : JSON.stringify(out.error)).toBe(true);
}

const assay = { testCode: 'ASSAY', methodReference: 'STP-L2B-01', unit: '%', lowerLimit: '98.0', upperLimit: '102.0', required: true, pharmacopoeia: 'IP' as const, edition: '2022', sampleQuantity: '0.020', sampleUnit: 'kg' };

/** A material of the ERP master (in effect), its approved specification and a lot of it received into quarantine. */
async function materialWithLot(kind: 'API' | 'EXCIPIENT' = 'EXCIPIENT'): Promise<{ code: string; lotId: string; specificationId: string }> {
  const erp = gmp.seed.services.find((s) => s.key === 'erpInterface');
  if (!erp) throw new Error('no ERP interface in the GMP seed');
  const code = `MAT-L2B-${randomUUID().slice(0, 6).toUpperCase()}`;
  const creds = { loginName: erp.loginName, serviceKey: erp.serviceKey, fingerprint: terminalOf(gmp.seed, erp.terminal).fingerprint };
  valueOf(await gmp.browser().call(Q.erpImport, { body: { ...creds, catalogue: { products: [], materials: [{ materialCode: code, materialName: `Material ${code}`, materialKind: kind, unit: 'kg', maxRetestMonths: 24, erpReference: `SAP-${code}` }], orders: [] } } }));
  await confirmErpPending(gmp);
  const [analyst, head] = await Promise.all([gmp.asPersona('qcAnalyst'), gmp.asPersona('qcApprover')]);
  const spec = valueOf(await analyst.call(S.draft, { body: { materialCode: code, title: `Specification of ${code}`, monographReference: 'IP 2022', tests: [assay] } }));
  await signedOk(signAction(gmp, head, 'qcApprover', { kind: 'LIMS_ACT', act: 'SPECIFICATION_APPROVE', subjectId: spec.specificationId }));
  const stores = await gmp.asPersona('stores');
  const lot = valueOf(await stores.call(Q.receiveLot, { body: { materialCode: code, lotCode: `L2B-${randomUUID().slice(0, 6).toUpperCase()}`, supplier: 'Demo supplier', supplierLot: 'S-1', quantity: '50.000', expiresAt: '2029-09-30T00:00:00+05:30' } }));
  return { code, lotId: lot.lotId, specificationId: spec.specificationId };
}

/** Records, approves and identity-tests the lot, then QA releases it (LOT_DECISION RELEASE). */
async function releasedLot(): Promise<string> {
  const m = await materialWithLot();
  const [analyst, head, qa] = await Promise.all([gmp.asPersona('qcAnalyst'), gmp.asPersona('qcApprover'), gmp.asPersona('qaInvestigator')]);
  const r = valueOf(await analyst.call(Q.recordLotResult, { params: { lotId: m.lotId }, body: { testCode: 'ASSAY', purpose: 'RELEASE', value: '99.4' } }));
  await signedOk(signAction(gmp, head, 'qcApprover', { kind: 'QUALITY_ACT', act: 'LOT_RESULT_APPROVE', subjectId: r.resultId, input: {} }));
  await withCommand(gmp.db.app, { ...(await actorOfBrowser(gmp, analyst, 'qcAnalyst')), correlationId: randomUUID() }, (c) =>
    c.query("select site.record_identity_result($1, 'PASS', 'IR-L2B', 'T-L2B')", [m.lotId]));
  await signedOk(signAction(gmp, qa, 'qaInvestigator', { kind: 'LOT_DECISION', lotId: m.lotId, decision: 'RELEASE', route: 'IDENTITY_TESTED' }));
  return m.lotId;
}

const statusOf = async (b: TestBrowser, lotId: string): Promise<string | undefined> => valueOf(await b.call(Q.lots, { query: {} })).lots.find((l) => l.lotId === lotId)?.status;

describe('specifications and results over HTTP (IN-33, PR-45)', () => {
  it('[IN-33][PR-45] QC drafts a specification citing the pharmacopoeia and edition of every limit; only another person approves it (LIMS_ACT); a result takes its limits from it and the release check names the required test', async () => {
    const [analyst, head] = await Promise.all([gmp.asPersona('qcAnalyst'), gmp.asPersona('qcApprover')]);
    const m = await materialWithLot();
    const views = valueOf(await analyst.call(S.list, { query: { materialCode: m.code } })).specifications;
    expect(views).toEqual([expect.objectContaining({ specificationId: m.specificationId, version: 1, state: 'APPROVED', tests: [expect.objectContaining({ testCode: 'ASSAY', pharmacopoeia: 'IP', edition: '2022', lowerLimit: '98.0' })] })]);
    // The contract has no place for a pharmacopoeia-free limit; the drafter's own approval is refused.
    expect(S.draft.body?.safeParse({ materialCode: m.code, title: 't', monographReference: 'm', tests: [{ ...assay, pharmacopoeia: undefined }] }).success).toBe(false);
    const v2 = valueOf(await analyst.call(S.draft, { body: { materialCode: m.code, title: 'v2', monographReference: 'IP 2026', tests: [{ ...assay, edition: '2026' }] } }));
    expect(v2).toMatchObject({ version: 2, state: 'DRAFT' });
    const approve: SignableAction = { kind: 'LIMS_ACT', act: 'SPECIFICATION_APPROVE', subjectId: v2.specificationId };
    expect(valueOf(await head.call(routes.esig.describe, { body: { action: approve } }))).toMatchObject({ aggregateType: 'specification', meaning: 'SPECIFICATION_APPROVED' });
    expect((await signAction(gmp, analyst, 'qcAnalyst', approve)).ok).toBe(false);
    expect((await signAction(gmp, head, 'qcApprover', approve, { tamper: true })).ok).toBe(false);
    // Limits are never typed: the route takes none, and the release check names the missing required test.
    expect(Q.recordLotResult.body?.safeParse({ testCode: 'ASSAY', purpose: 'RELEASE', value: '99.0', lowerLimit: '1' }).success).toBe(false);
    const check = valueOf(await analyst.call(S.lotReleaseCheck, { params: { lotId: m.lotId } }));
    expect(check.specificationId).toBe(m.specificationId);
    expect(check.limsProblem).toMatch(/required test ASSAY/);
    const r = valueOf(await analyst.call(Q.recordLotResult, { params: { lotId: m.lotId }, body: { testCode: 'ASSAY', purpose: 'RELEASE', value: '97.0' } }));
    expect(r).toMatchObject({ lowerLimit: '98.0', upperLimit: '102.0', verdict: 'FAIL' });
    expect(refusalOf(await analyst.call(Q.recordLotResult, { params: { lotId: m.lotId }, body: { testCode: 'ASSAY', purpose: 'RELEASE', value: '99.0', revises: r.resultId, revisionReason: 'Typo' } }))?.why).toMatch(/cites the OOS record of lot/);
    // QA marks IP 2026 effective: the specification in effect citing IP 2022 is listed for review.
    const qa = await gmp.asPersona('qaInvestigator');
    valueOf(await qa.call(S.markEdition, { body: { pharmacopoeia: 'IP', edition: '2022', effectiveFrom: '2022-12-01T00:00:00+05:30' } }));
    expect(valueOf(await qa.call(S.editionReview)).items.filter((i) => i.materialCode === m.code)).toEqual([]);
    valueOf(await qa.call(S.markEdition, { body: { pharmacopoeia: 'IP', edition: '2026', effectiveFrom: '2026-07-01T00:00:00+05:30' } }));
    expect(valueOf(await qa.call(S.editionReview)).items).toEqual(expect.arrayContaining([expect.objectContaining({ materialCode: m.code, cited: '2022', effective: '2026' })]));
    await signedOk(signAction(gmp, head, 'qcApprover', approve));
    expect(valueOf(await qa.call(S.editionReview)).items.filter((i) => i.materialCode === m.code)).toEqual([]);
  }, 300_000);
});

describe('lot status events over HTTP (D-P4-3)', () => {
  it('[DI-37][IN-24] HOLD, UNHOLD, RETURN and RECALL are proposed by QA, then signed as LOT_DECISION over the content that names the proposal; a decision not proposed, another than the one proposed, or a proposal by the QC analyst is refused', async () => {
    const lotId = await releasedLot();
    const qa = await gmp.asPersona('qaInvestigator');
    const reason = { code: 'COMPLAINT', text: 'Customer complaint under investigation' };
    const hold: SignableAction = { kind: 'LOT_DECISION', lotId, decision: 'HOLD', reason };
    expect(valueOf(await qa.call(routes.esig.describe, { body: { action: hold } }))).toMatchObject({ meaning: 'MATERIAL_LOT_STATUS_DECIDED', expectedState: 'RELEASED' });
    // Not proposed yet: the database refuses the signed act and nothing is signed.
    expect((await signAction(gmp, qa, 'qaInvestigator', hold)).ok).toBe(false);
    expect(refusalOf(await (await gmp.asPersona('qcAnalyst')).call(S.proposeLotDecision, { params: { lotId }, body: { event: 'HOLD' } })).code).toMatch(/^EBMR-IAM/);
    expect(refusalOf(await qa.call(S.proposeLotDecision, { params: { lotId }, body: { event: 'UNHOLD' } }))?.why).toMatch(/no QA status decision on lot/);
    expect(valueOf(await qa.call(S.proposeLotDecision, { params: { lotId }, body: { event: 'HOLD' } }))).toMatchObject({ lotId, event: 'HOLD', fromState: 'RELEASED' });
    // A RETURN signed over the HOLD proposal is refused; the HOLD is applied.
    expect((await signAction(gmp, qa, 'qaInvestigator', { ...hold, decision: 'RETURN' })).ok).toBe(false);
    await signedOk(signAction(gmp, qa, 'qaInvestigator', hold));
    expect(await statusOf(qa, lotId)).toBe('ON_HOLD');
    for (const event of ['UNHOLD', 'HOLD', 'RETURN'] as const) {
      valueOf(await qa.call(S.proposeLotDecision, { params: { lotId }, body: { event } }));
      await signedOk(signAction(gmp, qa, 'qaInvestigator', { kind: 'LOT_DECISION', lotId, decision: event, reason }));
    }
    expect(await statusOf(qa, lotId)).toBe('RETURNED');
    const other = await releasedLot();
    valueOf(await qa.call(S.proposeLotDecision, { params: { lotId: other }, body: { event: 'RECALL' } }));
    await signedOk(signAction(gmp, qa, 'qaInvestigator', { kind: 'LOT_DECISION', lotId: other, decision: 'RECALL', reason: { code: 'RECALL', text: 'Supplier recall notice' } }));
    expect(await statusOf(qa, other)).toBe('RECALLED');
  }, 300_000);
});

describe('finished lots, returned goods and samples over HTTP (IN-05 (a), PR-45, PR-48, PR-44, IN-32)', () => {
  it('[IN-05][PR-45] a finished lot is posted only from a packaging order whose execution is complete', async () => {
    const [issuer, stores] = await Promise.all([gmp.asPersona('issuer'), gmp.asPersona('stores')]);
    const batchId = await w.issued(issuer);
    expect(refusalOf(await stores.call(S.postFinishedLot, { body: { batchId, quantity: '1000', unit: 'units' } }))?.why).toMatch(/is PROCESSING ISSUED: a finished lot is posted from a packaging order/);
    expect(refusalOf(await (await gmp.asPersona('qcAnalyst')).call(S.postFinishedLot, { body: { batchId, quantity: '1000', unit: 'units' } })).code).toMatch(/^EBMR-IAM/);
  }, 300_000);

  it('[PR-48] returned goods are booked in quarantine, assessed and signed by QC (LIMS_ACT), and with doubt leave only by rejection; [PR-44][IN-32] a retention sample is pulled with its computed quantity and kept until expiry + 1 year', async () => {
    const [stores, head, qa, analyst] = await Promise.all([gmp.asPersona('stores'), gmp.asPersona('qcApprover'), gmp.asPersona('qaInvestigator'), gmp.asPersona('qcAnalyst')]);
    // A finished lot as the edition's definer posts it (its packaging-order path is proven in the database tests).
    const finished = await withCommand(gmp.db.admin, { ...(await actorOfBrowser(gmp, stores, 'stores')), correlationId: randomUUID() }, async (c) =>
      (await c.query<{ id: string }>('select site.create_finished_lot($1::jsonb) as id', [
        JSON.stringify({ batchId: randomUUID(), batchNumber: `F2B${randomUUID().slice(0, 6).toUpperCase()}`, edition: 'TABLETS', siteCode: 'SITE-1', productCode: 'PCM500', productName: 'Paracetamol tablets IP 500 mg',
                         strength: '500 mg', markets: ['IN'], quantity: '5000', unit: 'units', expiresAt: '2029-06-30T23:59:59Z' }),
      ])).rows[0]?.id ?? '',
    );
    const ret = valueOf(await stores.call(routes.samples.receiveReturn, { body: { originalLotId: finished, quantity: '200', reason: 'Wet cartons at the stockist', returnedFrom: 'Stockist Nagpur' } }));
    expect(ret).toMatchObject({ status: 'QUARANTINE', originalLotId: finished, assessment: null });
    const assessment = { nature: 'Uncoated tablets in blisters', storage: 'Below 30 C, dry', conditionHistory: 'Cartons wet; blisters intact', timeSinceIssue: '2 months', doubt: true, implicatesOtherBatches: false };
    expect(refusalOf(await head.call(routes.samples.assessReturn, { params: { lotId: ret.lotId }, body: { ...assessment, disposition: 'RETURN_TO_STOCK' } }))?.why).toMatch(/with any doubt about the returned goods/);
    const assessed = valueOf(await head.call(routes.samples.assessReturn, { params: { lotId: ret.lotId }, body: assessment }));
    expect(assessed.assessment).toMatchObject({ disposition: 'DESTROY', doubt: true, signed: false });
    const sign: SignableAction = { kind: 'LIMS_ACT', act: 'RETURN_ASSESSMENT_SIGN', subjectId: ret.lotId };
    expect((await signAction(gmp, analyst, 'qcAnalyst', sign)).ok).toBe(false);
    const reject: SignableAction = { kind: 'LOT_DECISION', lotId: ret.lotId, decision: 'REJECT', reason: { code: 'RETURN', text: 'Returned goods for destruction' } };
    expect((await signAction(gmp, qa, 'qaInvestigator', reject)).ok).toBe(false);
    await signedOk(signAction(gmp, head, 'qcApprover', sign));
    expect(valueOf(await head.call(routes.samples.returns)).returns.find((r) => r.lotId === ret.lotId)?.assessment?.signed).toBe(true);
    expect((await signAction(gmp, qa, 'qaInvestigator', { kind: 'LOT_DECISION', lotId: ret.lotId, decision: 'RELEASE', route: 'IDENTITY_TESTED' })).ok).toBe(false);
    await signedOk(signAction(gmp, qa, 'qaInvestigator', reject));
    expect(valueOf(await head.call(routes.samples.returns)).returns.find((r) => r.lotId === ret.lotId)?.status).toBe('REJECTED');

    // A retention sample of a starting material: required quantity twice the specification's, kept until expiry + 1 year.
    const m = await materialWithLot('API');
    const pulled = valueOf(await analyst.call(routes.samples.pull, { params: { lotId: m.lotId }, body: { kind: 'RETENTION', quantity: '0.050', container: 'Amber jar', storageLocation: 'Retention room' } }));
    expect(pulled).toMatchObject({ kind: 'RETENTION', requiredQuantity: '0.040', unit: 'kg' });
    expect(pulled.retainUntil.text).toMatch(/2030/);
    expect(valueOf(await analyst.call(routes.samples.list, { params: { lotId: m.lotId } })).samples.map((s) => s.sampleId)).toEqual([pulled.sampleId]);
    expect(refusalOf(await qa.call(routes.samples.dispose, { params: { sampleId: pulled.sampleId }, body: { reason: 'space' } }))?.why).toMatch(/is kept until/);
  }, 300_000);
});
