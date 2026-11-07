/**
 * API plan A4b (ICH Q7 14.4; control AS-21): recovery of materials and solvents in the API edition, proven with the
 * mechanisms that already exist (site-services 1732 to 1734 and substance 5004 for the intermediate lot, the material-lot
 * release of A2, the G-07 weighing that consumes a reserved lot, the genealogy of recipe-core 1010 and 1090). No new code.
 *
 *  - Q7 14.40, 14.43: material may be recovered from mother liquor or filtrates when an approved procedure covers it and
 *    the recovered material meets a specification fit for its use; the use is "adequately documented". Here, a second
 *    crop of the same batch: the approved master has a second crystallisation step, the stores post the second lot as
 *    `<batch>-2` in quarantine, and it is used only once QC tested it and QA released it for further processing.
 *  - Q7 14.41, 14.42, 14.43: a solvent may be recovered and reused when the recovery is controlled and monitored so the
 *    solvent meets its standard before reuse or mixing with fresh solvent. Here, a recovery master of the API edition
 *    whose product is the recovered solvent: its output is posted as a lot in quarantine, refused at the next step's
 *    reservation until QC tests it and QA releases it; the next step's master names it as a BOM line beside fresh
 *    solvent, and the mix is two G-07 weighings, one per lot, each consumed in its own command; the genealogy shows both
 *    lots CONSUMED into that batch.
 *
 *  - Q7 14.40, 14.43 (A4c, recipe-core 1881): mother liquor of batch N carried into batch N+1 of the same master. The
 *    mother liquor is a closed output container of batch N; QA holds it of its own decision (plant.hold_container,
 *    QA_HOLD of machine output_container v2), releases it under its signature once tested, and authorises batch N+1's
 *    G-24@2 RECOVERY step; the step adds part of it, and the genealogy shows the RECOVERY_ADDITION edge N -> N+1.
 *
 * Not here: the OUTPUT edges of an intermediate lot on the genealogy, which are recipe-core 1879 on another branch.
 *
 * Arranged outside the routes, as in intermediate-lots.test.ts: the plant-free masters (the dispensing step excepted),
 * the ERP orders, the numbering rules and the dispensing balance of the plant (support.ts); and, as a TEST FIXTURE with
 * triggers off, the fresh solvent's complete receipt record (receipt-fixture.ts; PR-17 is proven elsewhere).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { routes } from '@ebmr/api-contract';
import type { flow } from '@ebmr/recipe-core/pure';
import { openServiceSession, terminalOf } from '@ebmr/test-kit';
import { postOrder } from '../../../../packages/recipe-core/test/lifecycle/gmp-support.ts';
import { cell, reason, type World } from '../../../../packages/recipe-core/test/lifecycle/support.ts';
import { personaIn, refusalOf, startSigningServer, tapFor, valueOf } from '../esig/support.ts';
import type { ExecServer, RunDriver } from '../execution/support.ts';
import { actorOf, gmpLifecycleWorld } from '../support/gmp-world.ts';
import { arrangeCompleteReceipt } from '../support/receipt-fixture.ts';
import { confirmErpPending } from '../support/signed-acts.ts';
import {
  apiContent, arrangeBalance, bookBalance, closeBulk, driverOf, g07Phase, issueBatch, libraryEntry, phaseOf, range, reactBlock, signAs, stage, statusOf,
  type BatchRef, type Json, type Product, type StepInput,
} from './support.ts';

const SITE = 'SITE-1';
const LINE = 'L1';
const SIZE = 'BS-100K';
const TAG = randomUUID().slice(0, 6).toUpperCase();
const BALANCE = 'BAL-A4B';
const INT_A = { code: `RCA-${TAG}`, name: 'Demo intermediate A (second crop)', strength: 'Step 1' };
const SOLV = { code: `RTOL-${TAG}`, name: 'Recovered toluene', strength: 'Recovered' };
const INT_B = { code: `RCB-${TAG}`, name: 'Demo intermediate B (recovered solvent)', strength: 'Step 2' };
const FRESH = { code: `TOL-${TAG}`, name: 'Toluene (fresh, invented)' };
const INT_M = { code: `RCM-${TAG}`, name: 'Demo intermediate M (mother-liquor recovery)', strength: 'Step 1' };
const IN_R: StepInput = { code: SOLV.code, name: SOLV.name, quantity: '30', item: 'dispRecovered' };
const IN_F: StepInput = { code: FRESH.code, name: FRESH.name, quantity: '20', item: 'dispFresh' };
const REASON = 'API edition A4b recovery';
const Q = routes.quality;

const REACT = reactBlock(`API-REACT-C${TAG}`);
const unit = (like: Json, stageId: string, name: string, phase: string): Json => stage(like, stageId, name, [phaseOf(REACT, phase, { limits: { temp: range('Cel', '55', '65', 'REF-A4B') } })]);

const master = (p: Product, title: string, stages: (like: Json) => Json[], o: { input?: StepInput; materials?: { code: string; title: string; role: string; quantity: { value: string; unit: string } }[] }): flow.MbrContent =>
  apiContent({ family: `API-${p.code}`, title, product: p, recordKind: 'PROCESSING', defs: [REACT], stages, ...o });

/** Step A: the reaction, then a second crystallisation of the mother liquor (the second crop) in the approved master. */
const masterA = master(INT_A, `${INT_A.name}: synthesis with a second crop`, (like) => [unit(like, 'S-REACT', 'Reaction', 'p-react'), unit(like, 'S-CROP2', 'Second crystallisation from the mother liquor', 'p-crop2')],
  { materials: [{ code: `KSM-${TAG}`, title: 'Key starting material (invented)', role: 'ACTIVE', quantity: { value: '50', unit: 'kg' } }] });
/** The recovery master: spent toluene of step A distilled into recovered toluene, the product of its own record. */
const masterS = master(SOLV, 'Recovered toluene: distillation of spent toluene', (like) => [unit(like, 'S-DISTIL', 'Distillation', 'p-distil')],
  { materials: [{ code: `SPENT-${TAG}`, title: 'Spent toluene from step A (invented)', role: 'ACTIVE', quantity: { value: '35', unit: 'kg' } }] });
/** Step B: recovered toluene (BOM-IN) and fresh toluene, each weighed at its own G-07 step, then the reaction. */
const masterB = ((): flow.MbrContent => {
  const fresh = { ...g07Phase('p-disp-fresh', IN_F), consumes: [`BOM-${FRESH.code}`] };
  const content = master(INT_B, `${INT_B.name}: synthesis step`, (like) => [stage(like, 'S-DISP', 'Dispensing', [g07Phase('p-disp', IN_R), fresh]), unit(like, 'S-REACT', 'Reaction', 'p-react')],
    { input: IN_R, materials: [{ code: FRESH.code, title: FRESH.name, role: 'ACTIVE', quantity: { value: IN_F.quantity, unit: 'kg' } }] });
  (content as unknown as { parameters: Json[] }).parameters.push({ id: IN_F.item, name: `${IN_F.name} dispensed (G-07)`, valueType: 'DECIMAL', unit: 'kg', precision: { kind: 'DECIMALS', digits: 3 }, role: 'QUANTITY', criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'DEVICE' });
  return content;
})();

/**
 * Master M: the reaction, then a G-24@2 step that adds QA-released material recovered from an earlier batch's mother
 * liquor (case RECOVERY, Q7 14.40), within its limits (3 % of the standard batch, 90 days from manufacture, 1 source).
 */
const G24_RECOVERY: Json = {
  kind: 'phase', id: 'p-g24', name: 'Addition of material recovered from mother liquor', block: { type: 'G-24', version: '2' }, config: {},
  records: [], computes: [], reads: [], consumes: [], produces: [], uses: [], equipment: [],
  signatures: { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } }, significant: true, riskClass: 'HIGH',
  reprocessing: { case: 'RECOVERY', maxPercent: '3', maxAge: { value: '90', unit: 'd' }, maxSourceBatches: 1 },
};
const masterM = master(INT_M, `${INT_M.name}: synthesis with recovery from mother liquor`, (like) => [unit(like, 'S-REACT', 'Reaction', 'p-react'), stage(like, 'S-RCV', 'Recovery from mother liquor', [G24_RECOVERY])],
  { materials: [{ code: `KSM-M-${TAG}`, title: 'Key starting material M (invented)', role: 'ACTIVE', quantity: { value: '50', unit: 'kg' } }] });

type Step = 'A' | 'S' | 'B' | 'M';
let gmp: ExecServer;
let world: World;
const fam: Record<Step, string> = { A: '', S: '', B: '', M: '' };
const empty = (): BatchRef => ({ batchId: '', batchNumber: '' });
const batch: Record<Step, BatchRef> = { A: empty(), S: empty(), B: empty(), M: empty() };
let recovered = '';
let freshLot = { lotId: '', lotCode: '' };

async function plannedAndIssued(s: Step, content: flow.MbrContent): Promise<BatchRef> {
  await postOrder(gmp.db.app, await openServiceSession(gmp.db, gmp.seed, 'erpInterface'), content, SIZE);
  const planned = valueOf(await (await gmp.asPersona('issuer')).call(routes.execution.planBatch, { body: { familyId: fam[s], markets: ['IN'], site: SITE, line: LINE, batchSize: SIZE } }));
  await issueBatch(gmp, planned.batchId, { code: 'PRODUCTION_PLAN', text: `Step ${s}` });
  return { batchId: planned.batchId, batchNumber: planned.batchNumber };
}

/** One library step run, verified and its stage signed off. */
async function runUnit(d: RunDriver, phase: string, stageId: string): Promise<void> {
  await d.ok('operator1', { type: 'START_STEP', stepKey: `${phase}@` });
  await d.ok('operator1', libraryEntry(`${phase}@`, 'run', { temp: '60.0', complete: true }));
  await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: `${phase}@` });
  await d.signed('verifier1', { type: 'VERIFY', stepKey: `${phase}@`, meaning: 'VERIFIED' });
  await d.signed('supervisor1', { type: 'SIGN_OFF_STAGE', stageKey: `${stageId}@` });
}

/** The dispenser's G-07 weighing of `lotCode` at `step` for `bomLine`, keyed by hand on the booked balance (tare 1 kg). */
const weighing = (step: string, lotCode: string, input: StepInput, bomLine: string, gross: string) => ({
  type: 'RECORD_ENTRY' as const, stepKey: `${step}@`,
  entry: { kind: 'CONTAINER_WEIGHING' as const, item: input.item, bomLine, lotCode, manual: { gross, tare: '1.000', unit: 'kg', deviceCode: BALANCE } },
});

/** A dispensing step performed by the dispenser and verified by a second person. */
async function performedAndVerified(d: RunDriver, step: string): Promise<void> {
  await d.signed('dispenser1', { type: 'SIGN_PERFORMED', stepKey: `${step}@` });
  await d.signed('verifier1', { type: 'VERIFY', stepKey: `${step}@`, meaning: 'VERIFIED' });
}

/** site.lot_consumption of the batch: lot code, quantity, unit, stock before and after. */
const consumptions = async (batchId: string): Promise<string[][]> =>
  (await gmp.db.admin.query<{ lot: string; q: string; unit: string; before: string; after: string }>(
    `select l.lot_code as lot, trim_scale(c.quantity)::text as q, c.unit, trim_scale(c.quantity_before)::text as before, trim_scale(c.quantity_after)::text as after
       from site.lot_consumption c join site.material_lot l on l.id = c.lot_id where c.batch_id = $1 order by c.consumed_at, l.lot_code`, [batchId],
  )).rows.map((r) => [r.lot, r.q, r.unit, r.before, r.after]);

const lotState = async (lotId: string): Promise<string | undefined> => (await gmp.db.admin.query<{ s: string }>('select site.lot_state($1) as s', [lotId])).rows[0]?.s;

/** QC's approved specification of `materialCode` (an assay, as the recovered material's standard). */
async function specification(materialCode: string, title: string): Promise<void> {
  const [qc, head] = await Promise.all([gmp.asPersona('qcAnalyst'), gmp.asPersona('qcApprover')]);
  const spec = valueOf(await qc.call(routes.specifications.draft, { body: {
    materialCode, title, monographReference: 'In-house',
    tests: [{ testCode: 'ASSAY', methodReference: 'STP-A4B-01', unit: '%', lowerLimit: '97.0', upperLimit: '103.0', required: true, pharmacopoeia: 'IN_HOUSE' as const, edition: 'STP-2026-1', sampleQuantity: '0.1', sampleUnit: 'kg' }],
  } }));
  await signAs(gmp, head, 'qcApprover', { kind: 'LIMS_ACT', act: 'SPECIFICATION_APPROVE', subjectId: spec.specificationId });
}

/** QC's approved passing result on the lot. */
async function passed(lotId: string, value: string): Promise<void> {
  const [qc, head] = await Promise.all([gmp.asPersona('qcAnalyst'), gmp.asPersona('qcApprover')]);
  const r = valueOf(await qc.call(Q.recordLotResult, { params: { lotId }, body: { testCode: 'ASSAY', methodReference: 'STP-A4B-01', purpose: 'RELEASE', value, unit: '%' } }));
  await signAs(gmp, head, 'qcApprover', { kind: 'QUALITY_ACT', act: 'LOT_RESULT_APPROVE', subjectId: r.resultId, input: {} });
}

/** QC tested the lot against its specification; QA releases it for further processing. */
async function releaseForFurtherProcessing(lotId: string, value: string): Promise<void> {
  await passed(lotId, value);
  const qa = await gmp.asPersona('qaInvestigator');
  expect(valueOf(await qa.call(routes.specifications.proposeLotDecision, { params: { lotId }, body: { event: 'RELEASE_FOR_FURTHER_PROCESSING' } }))).toMatchObject({ fromState: 'QUARANTINE' });
  await signAs(gmp, qa, 'qaInvestigator', { kind: 'LOT_DECISION', lotId, decision: 'RELEASE_FOR_FURTHER_PROCESSING', reason: { code: 'QC_PASSED', text: 'Recovered material meets its specification' } });
  expect(await lotState(lotId)).toBe('RELEASED_FOR_FURTHER_PROCESSING');
}

beforeAll(async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), 'ebmr-api-a4b-'));
  gmp = Object.assign(await startSigningServer('GMP', { stub: false, env: { EBMR_NUMBER_LEDGER_FILE: join(ledgerDir, 'numbers.ledger.jsonl') } }), { exchangeDir: ledgerDir });
  vi.useFakeTimers({ toFake: ['performance'] });
  const steward = await gmp.asPersona('steward');
  for (const p of [INT_A, SOLV, INT_B, INT_M]) {
    valueOf(await steward.call(routes.masterData.enterProduct, { body: { productCode: p.code, strength: p.strength, productName: p.name, dosageForm: 'API', betaLactam: false, shelfLifeMonths: 12, changeReason: REASON } }));
  }
  // The fresh solvent is a material of the ERP master, received from a supplier.
  const erp = gmp.seed.services.find((s) => s.key === 'erpInterface');
  if (!erp) throw new Error('no ERP interface in the GMP seed');
  const creds = { loginName: erp.loginName, serviceKey: erp.serviceKey, fingerprint: terminalOf(gmp.seed, erp.terminal).fingerprint };
  valueOf(await gmp.browser().call(Q.erpImport, { body: { ...creds, catalogue: { products: [], materials: [{ materialCode: FRESH.code, materialName: FRESH.name, materialKind: 'EXCIPIENT' as const, unit: 'kg', maxRetestMonths: 24, erpReference: `SAP-${FRESH.code}` }], orders: [] } } }));
  await confirmErpPending(gmp);
  const [author, approver] = await Promise.all([gmp.asPersona('author'), gmp.asPersona('approver')]);
  const { block } = valueOf(await author.call(routes.library.draft, { body: { definition: REACT as unknown as Json } }));
  await signAs(gmp, approver, 'approver', { kind: 'LIBRARY_ACT', act: 'BLOCK_APPROVE', subjectId: block.blockId });
  world = await gmpLifecycleWorld(gmp);
  const stewardActor = await actorOf(gmp, 'steward');
  for (const [s, content, p] of [['A', masterA, INT_A], ['S', masterS, SOLV], ['B', masterB, INT_B], ['M', masterM, INT_M]] as const) {
    const v = await world.approvedVersion(content);
    await world.authorise({ versionId: v.versionId, market: 'IN', kind: 'CURRENT', cells: [cell(SITE, LINE, SIZE)], regulatoryBasis: 'IN: registration on file (invented API)' });
    fam[s] = v.familyId;
    await world.run(stewardActor, (c) =>
      c.query('select site.define_batch_number_rule($1::jsonb)', [JSON.stringify({ rule_code: `A4B-${s}-${TAG}`, site_code: SITE, product_code: p.code, batch_kind: 'PROCESSING', format: `Q${s}{YY}{SEQ:5}`, site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3' })]),
      reason(`API A4b numbering (step ${s})`),
    );
  }
  await arrangeBalance(gmp, BALANCE, [INT_B.code]);
}, 900_000);
afterAll(async () => {
  vi.useRealTimers();
  await gmp?.close();
});

describe('API plan A4b: recovery of materials and solvents (ICH Q7 14.4)', () => {
  it('[AS-21][IN-05][PR-45] a second crop of the same batch: the approved master crystallises the mother liquor a second time; the stores post the second crop as lot <batch>-2 in quarantine, beside the first; it is used only once QC tested it against its specification and QA released it for further processing', async () => {
    batch.A = await plannedAndIssued('A', masterA);
    const d = await driverOf(gmp, batch.A.batchId);
    await runUnit(d, 'p-react', 'S-REACT');
    await runUnit(d, 'p-crop2', 'S-CROP2');
    expect(await statusOf(gmp, batch.A.batchId)).toBe('EXECUTION_COMPLETE');
    const stores = await gmp.asPersona('stores');
    const first = valueOf(await stores.call(routes.specifications.postIntermediateLot, { body: { batchId: batch.A.batchId, quantity: '42', unit: 'kg' } }));
    const crop2 = valueOf(await stores.call(routes.specifications.postIntermediateLot, { body: { batchId: batch.A.batchId, quantity: '5.5', unit: 'kg' } }));
    expect([first, crop2]).toMatchObject([
      { lotCode: batch.A.batchNumber, materialCode: INT_A.code, status: 'QUARANTINE', quantity: '42' },
      { lotCode: `${batch.A.batchNumber}-2`, batchId: batch.A.batchId, materialCode: INT_A.code, status: 'QUARANTINE', quantity: '5.5' },
    ]);
    // Both lots are documented as the batch's own output, in posting order.
    expect((await gmp.db.app.query<{ l: string }>('select l from site.intermediate_lots_of($1) as l', [batch.A.batchId])).rows.map((r) => r.l)).toEqual([first.lotId, crop2.lotId]);
    // In quarantine the second crop cannot be released for further processing without QC's approved result.
    const qa = await gmp.asPersona('qaInvestigator');
    const early = await qa.call(routes.specifications.proposeLotDecision, { params: { lotId: crop2.lotId }, body: { event: 'RELEASE_FOR_FURTHER_PROCESSING' } });
    if (early.ok) {
      await expect(signAs(gmp, qa, 'qaInvestigator', { kind: 'LOT_DECISION', lotId: crop2.lotId, decision: 'RELEASE_FOR_FURTHER_PROCESSING', reason: { code: 'QC_PASSED', text: 'Attempt before QC tested it' } })).rejects.toThrow(/result|specification|approved|ASSAY/i);
    } else {
      expect(refusalOf(early)?.why).toMatch(/result|specification|approved|ASSAY/i);
    }
    expect(await lotState(crop2.lotId)).toBe('QUARANTINE');
    await specification(INT_A.code, 'Intermediate A specification (invented; both crops)');
    await releaseForFurtherProcessing(crop2.lotId, '98.6');
    expect(await lotState(first.lotId)).toBe('QUARANTINE');
  });

  it('[AS-21][IN-05][PR-18][IN-18] solvent recovery: the recovery master of the API edition posts recovered toluene as a lot in quarantine; the next step cannot reserve it until QC tested it against its specification and QA released it for further processing', async () => {
    batch.S = await plannedAndIssued('S', masterS);
    await runUnit(await driverOf(gmp, batch.S.batchId), 'p-distil', 'S-DISTIL');
    expect(await statusOf(gmp, batch.S.batchId)).toBe('EXECUTION_COMPLETE');
    const stores = await gmp.asPersona('stores');
    const lot = valueOf(await stores.call(routes.specifications.postIntermediateLot, { body: { batchId: batch.S.batchId, quantity: '30', unit: 'kg' } }));
    recovered = lot.lotId;
    expect(lot).toMatchObject({ lotCode: batch.S.batchNumber, materialCode: SOLV.code, status: 'QUARANTINE', quantity: '30', unit: 'kg' });
    batch.B = await plannedAndIssued('B', masterB);
    const reserve = { batchNumber: batch.B.batchNumber, quantity: '30' };
    expect(refusalOf(await stores.call(Q.reserveLot, { params: { lotId: recovered }, body: reserve }))?.why).toMatch(/QUARANTINE|released|cannot be/i);
    await specification(SOLV.code, 'Recovered toluene specification (invented)');
    await releaseForFurtherProcessing(recovered, '99.2');
    valueOf(await stores.call(Q.reserveLot, { params: { lotId: recovered }, body: reserve }));
  });

  it('[AS-21][AS-04][INV-13][PR-57][IN-07] fresh and recovered toluene are mixed in step B as two G-07 weighings on the booked balance, each consuming its own reserved, released lot in the same command; the genealogy shows both lots CONSUMED into step B and the recovered lot forward to it', async () => {
    const stores = await gmp.asPersona('stores');
    // The fresh solvent: received from the supplier, tested (identity and assay) and released by QA.
    freshLot = valueOf(await stores.call(Q.receiveLot, { body: { materialCode: FRESH.code, lotCode: `FT-${TAG}`, supplier: 'Demo Solvents', supplierLot: `S-${TAG}`, quantity: '50.000', expiresAt: '2029-09-30T00:00:00+05:30' } }));
    const c = await gmp.db.admin.connect();
    try {
      await c.query('begin');
      await c.query('set local session_replication_role = replica');
      await arrangeCompleteReceipt(c, { id: freshLot.lotId, site: SITE, material: FRESH.code, quantity: '50' });
      await c.query('commit');
    } finally {
      c.release();
    }
    await specification(FRESH.code, 'Toluene specification (invented)');
    await passed(freshLot.lotId, '99.8');
    const [qc, qa] = await Promise.all([gmp.asPersona('qcAnalyst'), gmp.asPersona('qaInvestigator')]);
    valueOf(await qc.call(Q.recordIdentityResult, { params: { lotId: freshLot.lotId }, body: { result: 'PASS', methodReference: 'IR-TOL', testReference: `T-${TAG}` } }));
    await signAs(gmp, qa, 'qaInvestigator', { kind: 'LOT_DECISION', lotId: freshLot.lotId, decision: 'RELEASE', route: 'IDENTITY_TESTED' });
    valueOf(await stores.call(Q.reserveLot, { params: { lotId: freshLot.lotId }, body: { batchNumber: batch.B.batchNumber, quantity: '20' } }));
    await bookBalance(gmp, BALANCE, batch.B.batchId);
    const d = await driverOf(gmp, batch.B.batchId);
    await d.ok('dispenser1', { type: 'START_STEP', stepKey: 'p-disp@' });
    await d.ok('dispenser1', weighing('p-disp', batch.S.batchNumber, IN_R, 'BOM-IN', '31.000'));
    await performedAndVerified(d, 'p-disp');
    await d.ok('dispenser1', { type: 'START_STEP', stepKey: 'p-disp-fresh@' });
    await d.ok('dispenser1', weighing('p-disp-fresh', `FT-${TAG}`, IN_F, `BOM-${FRESH.code}`, '21.000'));
    await performedAndVerified(d, 'p-disp-fresh');
    for (const e of (await d.runView('qa1')).exceptions.filter((x) => x.status === 'OPEN')) {
      await d.signed('qa1', { type: 'DISPOSITION_EXCEPTION', exception: e.exceptionId, outcome: 'NO_IMPACT', justification: 'Second person checked the weight keyed by hand at the time; no impact on the batch.' });
    }
    await d.signed('supervisor1', { type: 'SIGN_OFF_STAGE', stageKey: 'S-DISP@' });
    expect(await consumptions(batch.B.batchId)).toEqual(expect.arrayContaining([[batch.S.batchNumber, '30', 'kg', '30', '0'], [`FT-${TAG}`, '20', 'kg', '50', '30']]));
    expect(await consumptions(batch.B.batchId)).toHaveLength(2);
    const trace = async (kind: 'LOT' | 'BATCH', id: string, direction: 'FORWARD' | 'BACKWARD'): Promise<(string | null)[][]> => {
      const t = valueOf(await qa.call(routes.genealogy.trace, { query: { kind, id, direction } }));
      return t.edges.map((e) => [e.node.kind, t.nodes.find((n) => n.kind === e.node.kind && n.id === e.node.id)?.label ?? null, e.edgeKind]);
    };
    expect(await trace('BATCH', batch.B.batchId, 'BACKWARD')).toEqual(expect.arrayContaining([['LOT', batch.S.batchNumber, 'CONSUMED'], ['LOT', `FT-${TAG}`, 'CONSUMED']]));
    expect(await trace('LOT', recovered, 'FORWARD')).toEqual(expect.arrayContaining([['BATCH', batch.B.batchNumber, 'CONSUMED']]));
  });

  it('[AS-21][PR-47][IN-19][PR-57][DI-22] mother liquor of batch N is a closed output container; QA holds it with its reason and releases it under its signature; batch N+1 of the same master adds part of it at its G-24@2 RECOVERY step after the quality unit\'s signed authorisation of the step; the genealogy shows the RECOVERY_ADDITION edge N -> N+1', async () => {
    const n = await plannedAndIssued('M', masterM);
    const dn = await driverOf(gmp, n.batchId);
    await runUnit(dn, 'p-react', 'S-REACT');
    // The mother liquor of batch N: its own container, the net typed and verified by a second person.
    const label = await closeBulk(gmp, dn, n.batchId, '5.000');
    const qa = await gmp.asPersona('qa1');
    const mother = valueOf(await qa.call(routes.containers.list, { query: { batchId: n.batchId } })).containers.find((c) => c.label === label);
    expect(mother).toMatchObject({ state: 'CLOSED', qaHoldable: true });
    if (!mother) throw new Error('no mother-liquor container');
    // Batch N+1 cannot take it while it is only closed: RECOVERY is QA-released material.
    const n1 = await plannedAndIssued('M', masterM);
    const factsOf = async () => (await gmp.db.app.query<{ r: Json | null }>('select recipe.source_container_facts($1, $2) as r', [mother.containerId, n1.batchId])).rows[0]?.r;
    expect((await factsOf())?.['case']).toBeUndefined();
    // QA holds it of its own decision (quarantine until tested), then releases it under its signature.
    const path = `/api/containers/${mother.containerId}/hold`;
    const body = { expectedVersion: mother.version, reason: { code: 'MOTHER_LIQUOR', text: 'Mother liquor kept in quarantine until QC tests it for recovery' } };
    vi.advanceTimersByTime(7_000);
    expect(valueOf(await qa.call(routes.containers.hold, { params: { containerId: mother.containerId }, body, attribution: await tapFor(qa, personaIn(gmp, 'qa1'), 'POST', path, body) }))).toMatchObject({ state: 'HELD', qaHolds: [{ reasonCode: 'MOTHER_LIQUOR' }] });
    await signAs(gmp, qa, 'qa1', { kind: 'CONTAINER_ACT', act: 'RELEASE', containerId: mother.containerId, reason: { code: 'QC_PASSED', text: 'Mother liquor tested; fit for recovery' } });
    expect((await factsOf())?.['case']).toBe('RECOVERY');
    // Batch N+1: the reaction, then the quality unit's signed authorisation of its recovery step, then the addition.
    const d = await driverOf(gmp, n1.batchId);
    await runUnit(d, 'p-react', 'S-REACT');
    const qcu = await gmp.asPersona('qcuAuthoriser');
    // The step's authorisation (its start) and the authorisation of this use of the container (the addition entry).
    const authorised = async (containerId?: string): Promise<string> => {
      const { authorisationId } = valueOf(await qcu.call(Q.proposeReprocessingAuthorisation, { body: { batchId: n1.batchId, step: 'p-g24', ...(containerId ? { containerId } : {}), investigationRef: `DEV-A4C-${TAG}`, riskEvaluationRef: `RA-A4C-${TAG}` } }));
      await signAs(gmp, qcu, 'qcuAuthoriser', { kind: 'REPROCESSING_ACT', act: 'AUTHORISE_ADDITION', subjectId: authorisationId, input: {} });
      return authorisationId;
    };
    await authorised();
    const use = await authorised(mother.containerId);
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-g24@' });
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: 'p-g24@', entry: { kind: 'BLOCK_ENTRY', entryKind: 'ADDITION', data: { container: mother.containerId, authorisation: use, quantity: { value: '1.000', unit: 'kg' } } } } as never);
    const added = (await gmp.db.admin.query<{ case_code: string; block: string; q: string; source: string }>(
      'select case_code, block, trim_scale(net_quantity)::text as q, source_batch_number as source from recipe.source_addition where batch_id = $1', [n1.batchId])).rows;
    expect(added).toEqual([{ case_code: 'RECOVERY', block: 'G-24@2', q: '1', source: n.batchNumber }]);
    // driverOf signed qa1 in again on its terminal (one shop-floor session at a time): read through that session.
    const t = valueOf(await d.browser('qa1').call(routes.genealogy.trace, { query: { kind: 'BATCH', id: n.batchId, direction: 'FORWARD' } }));
    const edges = t.edges.map((e) => [e.node.kind, t.nodes.find((x) => x.kind === e.node.kind && x.id === e.node.id)?.label ?? null, e.edgeKind]);
    expect(edges).toEqual(expect.arrayContaining([['BATCH', n1.batchNumber, 'RECOVERY_ADDITION']]));
  });
});
