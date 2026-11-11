/**
 * API plan A4a (ICH Q7 section 14; plan rows C4 and AS-08, AS-20): rework and reprocessing of an API batch, proven with
 * the mechanisms that already exist (recipe-core 0621, 0624, 0625, 0781; site-services 0711, 0730 to 0733). No new code:
 * these tests show that the API edition (family edition 'substance') reaches them.
 *
 *  - [AS-08] (Q7 14.10, 8.17): material that fails its specification is identified and quarantined, and is not used
 *    further until its disposition. Step A's intermediate lot fails its assay: QC records and approves the out-of-limit
 *    result, QA cannot release it for further processing, and rejects it with a reason through the material-lot decision.
 *    The next step's batch is refused at the reservation for the rejected lot and for a quarantined one.
 *  - [AS-20] (Q7 14.30, plan C4): before a batch is reworked (a process that is not part of the established one) the
 *    reason for the failure is investigated. A rework is its own master of record kind REPROCESSING, of the same product
 *    as the parent; planning a batch on it needs the quality unit's authorisation of a request whose investigation is a
 *    QA-concluded deviation-lite record linked to the parent, a stored risk evaluation and the product's reprocessing
 *    permission (0624, revised in 0625, EBMR-RPR-052). Each missing piece is refused in turn, over the routes.
 *  - [AS-20] (Q7 14.31): a reworked batch is evaluated and tested further before release. Proven at the release item's
 *    own check: recipe.reprocessing_release_problem, which G-REL item G3.EXTRA_TESTING reads (0781, 0932), holds the
 *    planned rework batch until QC records its signed decision on additional testing. Not driven here: the rework batch
 *    to a released finished lot (the G-REL run itself needs a finished lot of the batch).
 *
 * Arranged outside the routes, as in intermediate-lots.test.ts: the plant-free masters, the ERP orders and the numbering
 * rules. Every person's act (results, decisions, deviation path, request, authorisation, plan) goes through the routes.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '@ebmr/expr';
import { routes, type Result, type SignableAction } from '@ebmr/api-contract';
import type { flow } from '@ebmr/recipe-core/pure';
import { openServiceSession, personaOf } from '@ebmr/test-kit';
import { postOrder } from '../../../../packages/recipe-core/test/lifecycle/gmp-support.ts';
import { cell, reason, type World } from '../../../../packages/recipe-core/test/lifecycle/support.ts';
import { personaIn, refusalOf, startSigningServer, tapFor, valueOf } from '../esig/support.ts';
import type { ExecServer } from '../execution/support.ts';
import type { TestBrowser } from '../support/harness.ts';
import { actorOf, gmpLifecycleWorld } from '../support/gmp-world.ts';
import { grantedPerson, loginOf } from '../support/granted-person.ts';
import { confirmErpPending, credentialsOf } from '../support/signed-acts.ts';
import { apiContent, driverOf, issueBatch, libraryEntry, phaseOf, range, reactBlock, signAs, stage, statusOf, type BatchRef, type Json, type Product } from './support.ts';

const SITE = 'SITE-1';
const LINE = 'L1';
const SIZE = 'BS-100K';
const TAG = randomUUID().slice(0, 6).toUpperCase();
const INT_A = { code: `RWA-${TAG}`, name: 'Demo intermediate A (rework)', strength: 'Step 1' };
const INT_B = { code: `RWB-${TAG}`, name: 'Demo intermediate B (rework)', strength: 'Step 2' };
const REASON = 'API edition A4a rework';
const Q = routes.quality;
const REACT = reactBlock(`API-REACT-R${TAG}`);

/** A G-24@2 step of the approved master that adds unreacted or reprocessed material (Q7 14.22), with its limits. */
const G24_ADDITION: Json = {
  kind: 'phase', id: 'p-g24', name: 'Return of recovered unreacted material', block: { type: 'G-24', version: '2' }, config: {},
  records: [], computes: [], reads: [], consumes: [], produces: [], uses: [], equipment: [],
  signatures: { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } }, significant: true, riskClass: 'HIGH',
  reprocessing: { case: 'REPROCESSING_ADDITION', maxPercent: '3', maxAge: { value: '90', unit: 'd' }, maxSourceBatches: 2 },
};

/**
 * One master of product `p` from `input` (its BOM line): a synthesis step (PROCESSING) or its rework (REPROCESSING);
 * `addition` gives it a second stage with the G-24 addition step.
 */
function apiMaster(p: Product, input: { code: string; name: string }, recordKind: 'PROCESSING' | 'REPROCESSING', addition = false): flow.MbrContent {
  const rework = recordKind === 'REPROCESSING';
  return apiContent({
    family: rework ? `API-RW-${p.code}` : `API-${p.code}`,
    title: rework ? `${p.name}: rework by recrystallisation` : `${p.name}: synthesis step`,
    product: p, recordKind, defs: [REACT],
    materials: [{ code: input.code, title: input.name, role: 'ACTIVE', quantity: { value: '50', unit: 'kg' } }],
    stages: (like) => [
      stage(like, 'S-REACT', 'Reaction', [phaseOf(REACT, 'p-react', { limits: { temp: range('Cel', '55', '65', 'REF-A4') } })]),
      ...(addition ? [stage(like, 'S-RPR', 'Return of unreacted material', [G24_ADDITION])] : []),
    ],
  });
}

const masterA = apiMaster(INT_A, { code: `KSM-${TAG}`, name: 'Key starting material (invented)' }, 'PROCESSING');
const masterB = apiMaster(INT_B, INT_A, 'PROCESSING', true);
/** The rework master: the same product as step A, a process of its own (a recrystallisation from a solvent). */
const masterR = apiMaster(INT_A, { code: `SOLV-${TAG}`, name: 'Recrystallisation solvent (invented)' }, 'REPROCESSING');

let gmp: ExecServer;
let world: World;
const fam: Record<'A' | 'B' | 'R', string> = { A: '', B: '', R: '' };
let parentA: BatchRef = { batchId: '', batchNumber: '' };
let stepB: BatchRef = { batchId: '', batchNumber: '' };
let failedLot = '';
let requestId = '';
let reworkBatch = '';

/** The database's refusal as the server answers it: why, then its code. */
const refused = (r: Result<unknown>): string => `${refusalOf(r)?.why ?? ''} [${refusalOf(r)?.code ?? ''}]`;

/** The signing ceremony as signAs runs it, returning the raw result: for the signatures that must be refused. */
async function signed(b: TestBrowser, key: string, action: SignableAction): Promise<Result<unknown>> {
  const described = await b.call(routes.esig.describe, { body: { action } });
  if (!described.ok) return described;
  const d = described.value;
  const m = d.meaning ?? '';
  const shown = await b.call(routes.esig.content, { query: { aggregateType: d.aggregateType, aggregateId: d.aggregateId, intent: m } });
  if (!shown.ok) return shown;
  const body = { aggregateType: d.aggregateType, aggregateId: d.aggregateId, contentVersion: shown.value.contentVersion, meaning: m, clientContentHash: sha256Hex(shown.value.canonicalText), action };
  vi.advanceTimersByTime(7_000);
  const attribution = b.terminal.includes('KIOSK') ? { attribution: await tapFor(b, personaIn(gmp, key), 'POST', '/api/esig/challenges', body) } : {};
  const challenge = await b.call(routes.esig.createChallenge, { body, ...attribution });
  if (!challenge.ok) return challenge;
  const signBody = { challengeId: challenge.value.challengeId, credentials: credentialsOf(gmp, key), action };
  return b.call(routes.esig.sign, { body: { ...signBody, proof: await b.proof('POST', '/api/esig/sign', signBody) } });
}

const issue = (batchId: string, text: string): Promise<void> => issueBatch(gmp, batchId, { code: 'PRODUCTION_PLAN', text });

const order = async (content: flow.MbrContent): Promise<void> => {
  await postOrder(gmp.db.app, await openServiceSession(gmp.db, gmp.seed, 'erpInterface'), content, SIZE);
};

async function plannedAndIssued(step: 'A' | 'B', content: flow.MbrContent): Promise<BatchRef> {
  await order(content);
  const planned = valueOf(await (await gmp.asPersona('issuer')).call(routes.execution.planBatch, { body: { familyId: fam[step], markets: ['IN'], site: SITE, line: LINE, batchSize: SIZE } }));
  await issue(planned.batchId, `Step ${step}`);
  return { batchId: planned.batchId, batchNumber: planned.batchNumber };
}

/** The reaction step run, verified and its stage signed off: the batch's execution is complete. */
async function runToComplete(batchId: string): Promise<void> {
  const d = await driverOf(gmp, batchId);
  await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-react@' });
  await d.ok('operator1', libraryEntry('p-react@', 'run', { temp: '60.0', complete: true }));
  await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-react@' });
  await d.signed('verifier1', { type: 'VERIFY', stepKey: 'p-react@', meaning: 'VERIFIED' });
  await d.signed('supervisor1', { type: 'SIGN_OFF_STAGE', stageKey: 'S-REACT@' });
  expect(await statusOf(gmp, batchId)).toBe('EXECUTION_COMPLETE');
}

const lotState = async (lotId: string): Promise<string | undefined> => (await gmp.db.admin.query<{ s: string }>('select site.lot_state($1) as s', [lotId])).rows[0]?.s;
const releaseProblem = async (batchId: string): Promise<string | null> =>
  (await gmp.db.app.query<{ p: string | null }>('select recipe.reprocessing_release_problem($1) as p', [batchId])).rows[0]?.p ?? null;

beforeAll(async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), 'ebmr-api-a4-'));
  gmp = Object.assign(await startSigningServer('GMP', { stub: false, env: { EBMR_NUMBER_LEDGER_FILE: join(ledgerDir, 'numbers.ledger.jsonl') } }), { exchangeDir: ledgerDir });
  vi.useFakeTimers({ toFake: ['performance'] });
  const steward = await gmp.asPersona('steward');
  for (const p of [INT_A, INT_B]) {
    valueOf(await steward.call(routes.masterData.enterProduct, { body: { productCode: p.code, strength: p.strength, productName: p.name, dosageForm: 'API', betaLactam: false, shelfLifeMonths: 12, changeReason: REASON } }));
  }
  await confirmErpPending(gmp);
  const [author, approver] = await Promise.all([gmp.asPersona('author'), gmp.asPersona('approver')]);
  const { block } = valueOf(await author.call(routes.library.draft, { body: { definition: REACT as unknown as Json } }));
  await signAs(gmp, approver, 'approver', { kind: 'LIBRARY_ACT', act: 'BLOCK_APPROVE', subjectId: block.blockId });
  world = await gmpLifecycleWorld(gmp);
  for (const [step, content] of [['A', masterA], ['B', masterB], ['R', masterR]] as const) {
    const v = await world.approvedVersion(content);
    await world.authorise({ versionId: v.versionId, market: 'IN', kind: 'CURRENT', cells: [cell(SITE, LINE, SIZE)], regulatoryBasis: 'IN: registration on file (invented API)' });
    fam[step] = v.familyId;
  }
  // One PROCESSING number rule per product: the rework batch takes an ordinary PROCESSING number of its own (0603).
  const stewardActor = await actorOf(gmp, 'steward');
  for (const [step, p] of [['A', INT_A], ['B', INT_B]] as const) {
    await world.run(stewardActor, (c) =>
      c.query('select site.define_batch_number_rule($1::jsonb)', [JSON.stringify({ rule_code: `A4-${step}-${TAG}`, site_code: SITE, product_code: p.code, batch_kind: 'PROCESSING', format: `R${step}{YY}{SEQ:5}`, site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3' })]),
      reason(`API A4 numbering (step ${step})`),
    );
  }
}, 900_000);
afterAll(async () => {
  vi.useRealTimers();
  await gmp?.close();
});

describe('API plan A4a: rework and reprocessing of an API batch (ICH Q7 14.1 to 14.3)', () => {
  it('[AS-08][IN-18] an intermediate lot that fails its specification stays in quarantine: QC records and approves the out-of-limit assay, QA cannot release it for further processing and rejects it with a reason; the next step\'s batch is refused at the reservation for the rejected lot and for a quarantined one', async () => {
    parentA = await plannedAndIssued('A', masterA);
    await runToComplete(parentA.batchId);
    const stores = await gmp.asPersona('stores');
    const lot = valueOf(await stores.call(routes.specifications.postIntermediateLot, { body: { batchId: parentA.batchId, quantity: '50', unit: 'kg', dating: 'EXPIRY' as const } }));
    failedLot = lot.lotId;
    const quarantined = valueOf(await stores.call(routes.specifications.postIntermediateLot, { body: { batchId: parentA.batchId, quantity: '4', unit: 'kg', dating: 'EXPIRY' as const } }));
    expect([lot.status, quarantined.status]).toEqual(['QUARANTINE', 'QUARANTINE']);
    const [qc, head, qa] = await Promise.all([gmp.asPersona('qcAnalyst'), gmp.asPersona('qcApprover'), gmp.asPersona('qaInvestigator')]);
    const spec = valueOf(await qc.call(routes.specifications.draft, { body: {
      materialCode: INT_A.code, title: 'Intermediate A specification (invented)', monographReference: 'In-house',
      tests: [{ testCode: 'ASSAY', methodReference: 'STP-A4-01', unit: '%', lowerLimit: '97.0', upperLimit: '103.0', required: true, pharmacopoeia: 'IN_HOUSE' as const, edition: 'STP-2026-1', sampleQuantity: '0.1', sampleUnit: 'kg' }],
    } }));
    await signAs(gmp, head, 'qcApprover', { kind: 'LIMS_ACT', act: 'SPECIFICATION_APPROVE', subjectId: spec.specificationId });
    const r = valueOf(await qc.call(Q.recordLotResult, { params: { lotId: failedLot }, body: { testCode: 'ASSAY', methodReference: 'STP-A4-01', purpose: 'RELEASE', value: '92.4', unit: '%' } }));
    await signAs(gmp, head, 'qcApprover', { kind: 'QUALITY_ACT', act: 'LOT_RESULT_APPROVE', subjectId: r.resultId, input: {} });
    // The failing result stands: QA's release for further processing is refused, and the lot stays in quarantine.
    const proposed = await qa.call(routes.specifications.proposeLotDecision, { params: { lotId: failedLot }, body: { event: 'RELEASE_FOR_FURTHER_PROCESSING' } });
    if (proposed.ok) {
      const release = await signed(qa, 'qaInvestigator', { kind: 'LOT_DECISION', lotId: failedLot, decision: 'RELEASE_FOR_FURTHER_PROCESSING', reason: { code: 'QC_PASSED', text: 'Attempted release of a failing lot' } });
      expect(refused(release)).toMatch(/failed its limits|ASSAY/);
    } else {
      expect(refused(proposed)).toMatch(/failed its limits|ASSAY/);
    }
    expect(await lotState(failedLot)).toBe('QUARANTINE');
    // QA rejects it, with its own reason (the material-lot decision; DI-22).
    await signAs(gmp, qa, 'qaInvestigator', { kind: 'LOT_DECISION', lotId: failedLot, decision: 'REJECT', reason: { code: 'QC_FAILED', text: 'Assay 92.4 % below the 97.0 % limit; held for investigation and rework' } });
    expect(await lotState(failedLot)).toBe('REJECTED');
    // Step B, the next step of the route, cannot reserve the rejected lot, nor the second lot still in quarantine.
    const b = await plannedAndIssued('B', masterB);
    stepB = b;
    for (const lotId of [failedLot, quarantined.lotId]) {
      expect(refused(await stores.call(Q.reserveLot, { params: { lotId }, body: { batchNumber: b.batchNumber, quantity: '4' } }))).toMatch(/REJECTED|QUARANTINE|released|cannot be/i);
    }
    expect((await gmp.db.admin.query('select 1 from site.lot_reservation where batch_id = $1', [b.batchId])).rowCount).toBe(0);
  }, 600_000);

  it('[AS-20][IN-18][IN-19][PR-47] a rework of the failed step A batch is its own REPROCESSING master of the API edition; its batch is refused until the quality unit authorised a request, the product permits reprocessing, and the request\'s investigation is linked to the parent and concluded by QA; then it is planned and issued, linked to its parent', async () => {
    const [issuer, inv, qa2, qcu, steward] = await Promise.all([gmp.asPersona('issuer'), gmp.asPersona('qaInvestigator'), gmp.asPersona('qaApprover2'), gmp.asPersona('qcuAuthoriser'), gmp.asPersona('steward')]);
    expect((await gmp.db.admin.query<{ e: string; k: string; p: string }>('select edition as e, record_kind as k, product_code as p from recipe.mbr_family where id = $1', [fam.R])).rows[0]).toEqual({ e: 'substance', k: 'REPROCESSING', p: INT_A.code });
    // The investigation of the failure (deviation-lite, kind INVESTIGATION), not yet linked to the batch.
    const d = valueOf(await inv.call(Q.raiseDeviation, { body: { kind: 'INVESTIGATION', title: 'Intermediate A assay below specification', classification: 'MAJOR', riskRationale: 'Release specification failure of an intermediate' } }));
    const risk = valueOf(await inv.call(Q.registerEvidenceDocument, { body: { title: 'Risk evaluation of the rework of intermediate A', mediaType: 'text/plain', contentBase64: Buffer.from(`Rework risk evaluation ${TAG}: recrystallisation, impurity profile to be compared`).toString('base64') } }));
    const body = { familyId: fam.R, site: SITE, parentBatchIds: [parentA.batchId], investigationRef: d.ref, riskEvaluationId: risk.documentId };
    // The PROCESSING master of the same product is no rework master.
    expect(refused(await issuer.call(Q.proposeReprocessingRequest, { body: { ...body, familyId: fam.A } }))).toMatch(/EBMR-RPR-050/);
    ({ requestId } = valueOf(await issuer.call(Q.proposeReprocessingRequest, { body })));
    await order(masterR);
    const plan = { familyId: fam.R, markets: ['IN'], site: SITE, line: LINE, batchSize: SIZE, reprocessingRequest: requestId };
    const planned = async (): Promise<Result<{ batchId: string; batchNumber: string }>> => issuer.call(routes.execution.planBatch, { body: plan });
    expect(refused(await planned())).toMatch(/not authorised the reprocessing.*EBMR-RPR-052/s);
    // A QA reviewer is not the quality unit's authoriser; the authoriser signs it.
    expect(refused(await signed(inv, 'qaInvestigator', { kind: 'REPROCESSING_ACT', act: 'AUTHORISE_REQUEST', subjectId: requestId, input: {} }))).toMatch(/QA_REVIEWER may not sign REPROCESSING_AUTHORISED/);
    await signAs(gmp, qcu, 'qcuAuthoriser', { kind: 'REPROCESSING_ACT', act: 'AUTHORISE_REQUEST', subjectId: requestId, input: {} });
    expect(valueOf(await issuer.call(Q.reprocessingRequests)).requests.find((x) => x.requestId === requestId)).toMatchObject({ investigationRef: d.ref, parents: [{ batchId: parentA.batchId }], authorisedBy: { personId: personaOf(gmp.seed, 'qcuAuthoriser').personId } });
    // The product master does not permit reprocessing until QA confirms a version that does.
    expect(refused(await planned())).toMatch(/does not permit reprocessing.*EBMR-RPR-052/s);
    valueOf(await steward.call(routes.masterData.enterProduct, { body: { productCode: INT_A.code, strength: INT_A.strength, productName: INT_A.name, dosageForm: 'API', betaLactam: false, reprocessingPermitted: true, shelfLifeMonths: 12, changeReason: 'Rework by recrystallisation permitted (validated)' } }));
    expect(refused(await planned())).toMatch(/does not permit reprocessing.*EBMR-RPR-052/s);
    await confirmErpPending(gmp);
    // The investigation is not linked to the parent, then linked but not concluded.
    expect(refused(await planned())).toMatch(/not linked to batch.*EBMR-RPR-052/s);
    valueOf(await inv.call(Q.linkDeviation, { params: { deviationId: d.deviationId }, body: { subjectKind: 'BATCH', subjectId: parentA.batchId } }));
    expect(refused(await planned())).toMatch(/does not stand for parent.*no QA-signed conclusion.*EBMR-RPR-052/s);
    // The deviation path over the routes: QA's classification, the finding, the impact, QA's sign-off, the basis, the conclusion.
    const id = { deviationId: d.deviationId };
    const classifier = await loginOf(gmp, await grantedPerson(gmp, 'QA_SHOP_FLOOR', `Meera Pillai (QA classifier ${TAG})`));
    const due = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 28)).toISOString().slice(0, 10);
    valueOf(await classifier.call(Q.startInvestigation, { params: id, body: { classification: 'MAJOR', riskRationale: 'Release specification failure of an intermediate', ownerPersonId: personaOf(gmp.seed, 'qaInvestigator').personId, dueDate: due } }));
    valueOf(await inv.call(Q.recordFinding, { params: id, body: { assignableCause: true, cause: 'Crystallisation cooled too fast; impurity occluded', rootCauseCategory: 'PROCESS' } }));
    const [link] = valueOf(await inv.call(Q.deviationDetail, { params: id })).links;
    valueOf(await inv.call(Q.recordDeviationImpact, { params: id, body: { linkId: link!.linkId, market: 'IN', impact: 'CONFIRMED', rationale: 'The lot fails its assay and is rejected' } }));
    await signAs(gmp, qa2, 'qaApprover2', { kind: 'QUALITY_ACT', act: 'DEVIATION_IMPACT_ASSESS', subjectId: d.deviationId, input: {} });
    valueOf(await inv.call(Q.recordDeviationClosureBasis, { params: id, body: {
      rootCauseMethod: 'Five whys with production and QC', capaRefs: ['CAPA-A4-001'], notificationRequired: false, notificationRationale: 'No registered detail or licence condition is affected',
      otherBatches: [{ subjectKind: 'PRODUCT', ref: 'Intermediate A batches since the last cooling-rate check', included: false, reason: 'Assays passed on them' }],
    } }));
    await signAs(gmp, qa2, 'qaApprover2', { kind: 'QUALITY_ACT', act: 'DEVIATION_CONCLUDE', subjectId: d.deviationId, input: {} });
    expect(valueOf(await inv.call(Q.deviation, { params: id })).state).toBe('PENDING_CLOSURE');
    // Every check passes: the rework batch is planned on its own PROCESSING number, linked to its parent, and issued.
    const child = valueOf(await planned());
    reworkBatch = child.batchId;
    expect(child.batchNumber).not.toBe(parentA.batchNumber);
    expect((await gmp.db.admin.query<{ p: string; n: string }>('select parent_batch_id as p, parent_batch_number as n from recipe.batch_parent_link where child_batch_id = $1', [reworkBatch])).rows).toEqual([{ p: parentA.batchId, n: parentA.batchNumber }]);
    await issue(reworkBatch, 'Rework of intermediate A');
    // Each authorisation is used once.
    expect(refused(await planned())).toMatch(/used for a batch already.*EBMR-RPR-052/s);
  }, 600_000);

  it('[AS-20][PR-47] the reworked batch is held at release for its reprocessing basis until QC records its signed decision on additional testing (G-REL item G3.EXTRA_TESTING, recipe.reprocessing_release_problem); an ordinary step batch is not held by it', async () => {
    const [analyst, head] = await Promise.all([gmp.asPersona('qcAnalyst'), gmp.asPersona('qcApprover')]);
    expect((await gmp.db.app.query<{ b: string | null }>('select recipe.batch_reprocessing_basis($1) as b', [reworkBatch])).rows[0]?.b).toBe('WHOLE_BATCH');
    expect(await releaseProblem(reworkBatch)).toMatch(/whole-batch reprocessing and QC has recorded no decision on additional testing/);
    expect(await releaseProblem(parentA.batchId)).toBeNull();
    const act = { kind: 'QUALITY_ACT' as const, act: 'QC_EXTRA_TESTING_DECISION' as const, subjectId: reworkBatch, input: { decision: 'EXTRA_TESTS' as const, tests: ['ASSAY', 'IMPURITY-PROFILE'] } };
    // QC's analyst holds no right to decide it; the head of QC signs it.
    expect((await signed(analyst, 'qcAnalyst', act)).ok).toBe(false);
    expect(await releaseProblem(reworkBatch)).not.toBeNull();
    await signAs(gmp, head, 'qcApprover', act);
    expect(valueOf(await head.call(Q.extraTesting, { params: { batchId: reworkBatch } })).decision).toMatchObject({ decision: 'EXTRA_TESTS', tests: ['ASSAY', 'IMPURITY-PROFILE'] });
    expect(await releaseProblem(reworkBatch)).toBeNull();
  }, 300_000);

  it('[AS-19][IN-19][PR-47] a G-24 step of an API master that returns unreacted material (case REPROCESSING_ADDITION) is authorised by the quality unit before it is carried out, citing the investigation and the risk evaluation; a step that is no reprocessing step and a person without REPROCESSING.AUTHORISE are refused', async () => {
    const [issuer, qcu] = await Promise.all([gmp.asPersona('issuer'), gmp.asPersona('qcuAuthoriser')]);
    const body = { batchId: stepB.batchId, step: 'p-g24', investigationRef: `DEV-A4-${TAG}`, riskEvaluationRef: `RA-A4-${TAG}` };
    expect(refusalOf(await issuer.call(Q.proposeReprocessingAuthorisation, { body }))?.code).toBe('EBMR-IAM-040');
    expect(refused(await qcu.call(Q.proposeReprocessingAuthorisation, { body: { ...body, step: 'p-react' } }))).toMatch(/no reprocessing or recovery step.*EBMR-RPR-020/s);
    const { authorisationId } = valueOf(await qcu.call(Q.proposeReprocessingAuthorisation, { body }));
    const listed = async () => valueOf(await qcu.call(Q.reprocessingAuthorisations, { query: { batchId: stepB.batchId } })).authorisations.find((a) => a.authorisationId === authorisationId);
    expect(await listed()).toMatchObject({ stepId: 'p-g24', scope: 'STEP', caseCode: 'REPROCESSING_ADDITION', investigationRef: body.investigationRef, riskEvaluationRef: body.riskEvaluationRef, authorisedBy: null });
    // The issuer cannot sign it; the quality unit's authoriser does.
    expect(refused(await signed(issuer, 'issuer', { kind: 'REPROCESSING_ACT', act: 'AUTHORISE_ADDITION', subjectId: authorisationId, input: {} }))).toMatch(/may not sign REPROCESSING_AUTHORISED/);
    await signAs(gmp, qcu, 'qcuAuthoriser', { kind: 'REPROCESSING_ACT', act: 'AUTHORISE_ADDITION', subjectId: authorisationId, input: {} });
    expect(await listed()).toMatchObject({ authorisedBy: { personId: personaOf(gmp.seed, 'qcuAuthoriser').personId } });
  }, 300_000);
});
