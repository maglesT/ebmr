/**
 * GB-T-01 continued from the release for packing to the release (Phase 4 slice 7b; D-P4-15): the happy variant's
 * accepted tablets in four drums, two blister orders from that bulk with a full line clearance between them, the
 * records reviewed, the finished lots tested and sampled, G-REL green through real signed acts and the manufacturer
 * release. The quantities are the hand worksheet's (README.md, expected-release.json).
 */
import { routes, type SignableAction } from '@ebmr/api-contract';
import { valueOf } from '../../esig/support.ts';
import { advanceMinutes } from '../clock.ts';
import type { TestBrowser } from '../../support/harness.ts';
import { dbAs, type GoldenBatch, ok, signAct } from './driver.ts';
import { approveBlisterMaster, blisterOrder, cleanLine, containerise, postPackOrder, setUpPackLine, type BlisterRun } from './packing.ts';
import type { GoldenWorld } from './world.ts';

type Json = Record<string, unknown>;

/** The worksheet of one blister order (README.md "Packaging"). */
export const ORDER_PLAN: Omit<BlisterRun, 'labels'> = {
  foil: { issued: '10000', used: '9840', setupWaste: '30', uncodedReturned: '130' },
  carton: { issued: '990', used: '980', codedDestroyed: '6', uncodedReturned: '2', specimens: '2' },
  blisters: { formed: '9840', good: '9800', setupWaste: '12', samples: '20', rejects: { emptyPocket: '5', brokenPocket: '2', vision: '1' } },
  packs: '980',
  tabletsIssued: '98402',
  tabletsPacked: '98000',
};
/** The accepted tablets of the happy variant (196,804) in four drums. */
export const DRUMS = ['49201', '49201', '49201', '49201'];
/** The finished-product specification of GB-T-01 (invented limits) and each lot's results. */
export const PRODUCT_TESTS = [
  { testCode: 'ASSAY', methodReference: 'STP-GBT01-AS-01', unit: '%', lowerLimit: '95.0', upperLimit: '105.0', result: '99.6' },
  { testCode: 'DISSOLUTION', methodReference: 'STP-GBT01-DS-01', unit: '%', lowerLimit: '80', result: '93' },
];
/** Reserve samples: twice the packs the specification's tests take (one pack each). */
export const RESERVE_PACKS = '4';

export interface Continuation {
  drums: string[];
  orders: GoldenBatch[];
  lots: { lotId: string; lotCode: string }[];
  grel: Json[];
  decisions: string[];
}

/** A signed act that must succeed. */
async function signed(w: GoldenWorld, b: TestBrowser, key: string, action: SignableAction, what: string): Promise<void> {
  ok(await signAct(w, b, key, action), what);
}

/** Production approval, the audit-trail review and the QA review of one record (outline 5.2.2, 5.4). */
export async function reviewRecord(w: GoldenWorld, batchId: string): Promise<void> {
  const head = await w.server.asPersona('head1');
  const qa = await w.server.asPersona('qaInvestigator');
  const qa2 = await w.server.asPersona('qaApprover2');
  await signed(w, head, 'head1', { kind: 'REVIEW_ACT', act: 'PRODUCTION_APPROVE', batchId, input: {} }, 'the production approval');
  // QA concludes every register item in review (PR-52, DI-26): one by one (no two share a deviation here); a critical
  // item after its detail was opened, with a justification. Signing attempts are rate-limited per person: a human pace.
  const register = ok(await qa2.call(routes.review.register, { params: { batchId }, body: {} }), 'the register');
  let n = 0;
  for (const item of register.items.filter((i) => i.reviewStatus === 'OPEN')) {
    if (n > 0 && n % 4 === 0) advanceMinutes(1);
    n += 1;
    if (item.critical) ok(await qa2.call(routes.review.openItem, { params: { batchId, exceptionId: item.exceptionId }, body: {} }), 'the item detail');
    const justification = item.critical ? `Reviewed with its disposition (${item.engineDisposition?.outcome ?? 'none'}): no impact on the batch` : undefined;
    await signed(w, qa2, 'qaApprover2', { kind: 'REVIEW_ACT', act: 'DISPOSE_ITEM', batchId, input: { items: [item.exceptionId], disposition: 'ACCEPT', ...(justification ? { justification } : {}) } }, `the acceptance of ${item.exceptionId}`);
  }
  const report = ok(await qa.call(routes.review.auditTrail, { params: { batchId }, query: {} }), 'the audit-trail report');
  await signed(w, qa, 'qaInvestigator', { kind: 'REVIEW_ACT', act: 'AUDIT_TRAIL_REVIEW', batchId, input: { reviewId: report.reviewId } }, 'the audit-trail review');
  const view = ok(await qa2.call(routes.review.batch, { params: { batchId } }), 'the review view');
  if (!view.gates.qaReview.ready) throw new Error(`the QA review of ${batchId} is not ready: ${view.gates.qaReview.problems.join('; ')}`);
  await signed(w, qa2, 'qaApprover2', { kind: 'REVIEW_ACT', act: 'QA_REVIEW', batchId, input: { expectedEpoch: view.epoch } }, 'the QA review');
}

/** QC drafts the finished-product specification; the head of QC approves it. */
export async function productSpecification(w: GoldenWorld, materialCode: string): Promise<void> {
  const qc = await w.server.asPersona('qcAnalyst');
  const head = await w.server.asPersona('qcApprover');
  const spec = ok(
    await qc.call(routes.specifications.draft, {
      body: {
        materialCode, title: `Finished product specification of ${materialCode} (invented)`, monographReference: `In-house monograph of ${materialCode}`,
        tests: PRODUCT_TESTS.map((t) => ({
          testCode: t.testCode, methodReference: t.methodReference, unit: t.unit, ...(t.lowerLimit ? { lowerLimit: t.lowerLimit } : {}), ...('upperLimit' in t && t.upperLimit ? { upperLimit: t.upperLimit } : {}),
          required: true, pharmacopoeia: 'IN_HOUSE' as const, edition: 'STP-2026-1', sampleQuantity: '1', sampleUnit: 'packs',
        })),
      },
    }),
    'the finished-product specification',
  );
  await signed(w, head, 'qcApprover', { kind: 'LIMS_ACT', act: 'SPECIFICATION_APPROVE', subjectId: spec.specificationId }, 'the specification approval');
}

/** The warehouse posts the order's finished lot; QC tests it (head of QC approves) and pulls its reserve samples. */
export async function finishedLot(w: GoldenWorld, order: GoldenBatch, packs: string): Promise<{ lotId: string; lotCode: string }> {
  const stores = await w.server.asPersona('stores');
  const lotId = await dbAs<string>(w, stores, 'stores', 'select tab.post_finished_lot($1, $2, $3) as r', [order.batchId, packs, 'packs'], { reasonCode: 'PACKING_COMPLETE', reasonText: 'Finished packs of the packaging order posted' });
  const lotCode = (await w.server.db.app.query<{ c: string }>('select lot_code as c from site.material_lot where id = $1', [lotId])).rows[0]?.c ?? '';
  const qc = await w.server.asPersona('qcAnalyst');
  const head = await w.server.asPersona('qcApprover');
  for (const t of PRODUCT_TESTS) {
    const r = ok(await qc.call(routes.quality.recordLotResult, { params: { lotId }, body: { testCode: t.testCode, methodReference: t.methodReference, purpose: 'RELEASE', value: t.result, unit: t.unit } }), `the ${t.testCode} result`);
    await signed(w, head, 'qcApprover', { kind: 'QUALITY_ACT', act: 'LOT_RESULT_APPROVE', subjectId: (r as { resultId: string }).resultId, input: {} }, `the approval of ${t.testCode}`);
  }
  const body = { kind: 'RESERVE' as const, quantity: RESERVE_PACKS, container: `Reserve sample box of ${lotCode}`, storageLocation: 'Reserve sample room RS-1, shelf 3' };
  ok(await qc.call(routes.samples.pull, { params: { lotId }, body }), 'the reserve samples');
  return { lotId, lotCode };
}

/** The AP evaluates G-REL for India and releases the lot (MANUFACTURER_RELEASE with the epoch evaluated). */
export async function manufacturerRelease(w: GoldenWorld, lotId: string): Promise<{ grel: Json; decision: string }> {
  const ap = await w.server.asPersona('qcuAuthoriser');
  const view = ok(await ap.call(routes.release.lot, { params: { lotId } }), 'the release view');
  const red = view.grel.items.filter((i) => i.status === 'RED');
  if (red.length > 0 || !view.gates.release.ready) throw new Error(`G-REL is not green for ${lotId}: ${JSON.stringify(red.map((i) => [i.id, (i as unknown as Json)['problem']]))} ${view.gates.release.problems.join('; ')}`);
  await signed(w, ap, 'qcuAuthoriser', { kind: 'RELEASE_ACT', act: 'MANUFACTURER_RELEASE', lotId, input: { expectedEpoch: view.grel.epoch } }, 'the manufacturer release');
  const after = valueOf(await ap.call(routes.release.lot, { params: { lotId } }));
  return { grel: { epoch: view.grel.epoch, items: view.grel.items.map((i) => `${i.id} ${i.status}`) }, decision: after.decision?.decision ?? 'NONE' };
}

export interface Packed {
  drums: string[];
  orders: GoldenBatch[];
}

/** The bulk in drums and the two blister orders, with the full line clearance between them. */
export async function runPackaging(w: GoldenWorld, happy: GoldenBatch): Promise<Packed> {
  await setUpPackLine(w);
  const master = await approveBlisterMaster(w);
  const drums = await containerise(happy, DRUMS);
  await postPackOrder(w, 'PO-GBT01-PK-0001');
  await postPackOrder(w, 'PO-GBT01-PK-0002');
  const first = await blisterOrder(w, master, happy, 'PO-GBT01-PK-0001', { ...ORDER_PLAN, labels: drums.slice(0, 2).map((d) => d.label) });
  // The full line clearance between the orders: the line and its units cleaned again and verified; the second order's
  // own PACKAGING_ORDER clearance with its artwork set (in blisterOrder).
  await cleanLine(w);
  const second = await blisterOrder(w, master, happy, 'PO-GBT01-PK-0002', { ...ORDER_PLAN, labels: drums.slice(2).map((d) => d.label) });
  return { drums: drums.map((d) => d.label), orders: [first, second] };
}

/** The records reviewed, the finished lots posted, tested and sampled, and released by the AP for India. */
export async function runRelease(w: GoldenWorld, happy: GoldenBatch, packed: Packed): Promise<Continuation> {
  for (const b of [happy, ...packed.orders]) await reviewRecord(w, b.batchId);
  await productSpecification(w, 'GBT01-250');
  const lots = [];
  for (const o of packed.orders) lots.push(await finishedLot(w, o, ORDER_PLAN.packs));
  const grel: Json[] = [];
  const decisions: string[] = [];
  for (const l of lots) {
    const r = await manufacturerRelease(w, l.lotId);
    grel.push(r.grel);
    decisions.push(r.decision);
  }
  return { ...packed, lots, grel, decisions };
}

export async function runContinuation(w: GoldenWorld, happy: GoldenBatch): Promise<Continuation> {
  return runRelease(w, happy, await runPackaging(w, happy));
}
