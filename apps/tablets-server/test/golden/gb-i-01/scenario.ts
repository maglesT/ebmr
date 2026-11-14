/**
 * The GB-I-01 scenario (Injectables I-6; README.md): an invented aseptically filled vial (decision 0006 part 3) made from
 * the Injectables catalogue's blocks, over the routes, by the seed's personas with real signatures, on the frozen golden
 * clock (clock.ts): each act happens one second after the one before (tick), and the waits (the EM plates' incubation,
 * the sterility test by the rapid method) move the database's clock forward only.
 *
 * What is arranged outside the routes, as in the injectables chain tests (vial-chain.test.ts, aseptic-gate.test.ts): the
 * plant units the filling names (test arrangement of master data), the masters' plant-free shape, the ERP orders (fixed
 * numbers, so the normalised true copies are the same on every run) and the numbering rules.
 */
import { vi } from 'vitest';
import { routes, type ContainerView, type LotResultView } from '@ebmr/api-contract';
import { library, type flow } from '@ebmr/recipe-core/pure';
import { openServiceSession } from '@ebmr/test-kit';
import { postOrder } from '../../../../../packages/recipe-core/test/lifecycle/gmp-support.ts';
import { cell, reason, type World } from '../../../../../packages/recipe-core/test/lifecycle/support.ts';
import { INJECTABLE_SEEDS } from '../../../../../packages/recipe-core/src/library/seed/injectables.ts';
import { INJECTABLE_ASEPTIC_SEEDS } from '../../../../../packages/recipe-core/src/library/seed/injectables-aseptic.ts';
import { personaIn, refusalOf, tapFor, valueOf } from '../../esig/support.ts';
import type { ExecServer, RunDriver } from '../../execution/support.ts';
import { actorOf, gmpContent, gmpLifecycleWorld } from '../../support/gmp-world.ts';
import { confirmErpPending } from '../../support/signed-acts.ts';
import { driverOf, issueBatch, libraryEntry, phaseOf, signAs, stage, statusOf, type BatchRef, type Json } from '../../substance/support.ts';
import { advanceMinutes } from '../clock.ts';
import { tick } from '../gb-t-01/driver.ts';

export const SITE = 'SITE-1';
export const LINE = 'L1';
export const SIZE = 'BS-100K';
const REASON = 'GB-I-01 golden batch (invented injectable)';
export const PRODUCT = { code: 'GBI01-VIAL', name: 'Demoinj aseptic 10 mg/2 mL vials', strength: '10 mg/2 mL' };
const FILL_LINE = 'VIAL-LINE-GBI01';
const FILL_ROOM = 'ROOM-C-GBI01';

const seed = (code: string) => {
  const item = [...INJECTABLE_SEEDS, ...INJECTABLE_ASEPTIC_SEEDS].find((s) => s.definition.code === code);
  if (!item) throw new Error(`no injectables seed ${code}`);
  return item;
};
const FILL = seed('INJ-FILL');
const SAMPLING = seed('INJ-STERILITY-SAMPLE');
const COUNTS = seed('INJ-EM-COUNTS');
const EXAM = seed('INJ-PACK-EXAM');

/**
 * The worksheet's quantities (README.md): two filled loads of vials, the finished lot, the reserve sample (twice the
 * specification's full test plan, 2 x (20 + 3 + 10) vials; PR-44, IN-32).
 */
export const PLAN = { loads: ['4900', '4820'], lot: '9600', reserve: '66' } as const;
/** The waits (README.md): the EM plates' incubation, then the rapid sterility method's read, in whole minutes. */
export const WAITS = { emIncubation: 7 * 24 * 60, rapidSterility: 7 * 24 * 60 } as const;

/**
 * The finished product's specification. DEMO-ONLY: every method, limit and sample below is invented for the golden
 * batch, not a real product's or a pharmacopoeia's. The sterility method is the firm's entry ("Validated rapid microbial
 * method", the method the firm validated as an alternative to the compendial test), never a software default; each lot
 * result takes its method from this specification (site 0841, EBMR-SITE-412; IN-33).
 */
export const SPEC_TESTS = [
  { testCode: 'STERILITY', methodReference: 'Validated rapid microbial method', unit: '1', upperLimit: '0', pharmacopoeia: 'IN_HOUSE', edition: 'VAL-RMM-2026-1', sampleQuantity: '20', result: '0' },
  { testCode: 'ENDOTOXIN', methodReference: 'STP-GBI01-BET-01', unit: '[EU]/mL', upperLimit: '0.50', pharmacopoeia: 'IP', edition: '2022', sampleQuantity: '3', result: '0.10' },
  { testCode: 'PARTICULATE_MATTER', methodReference: 'STP-GBI01-PM-01', unit: '1', upperLimit: '6000', pharmacopoeia: 'IP', edition: '2022', sampleQuantity: '10', result: '850' },
] as const;

/** An injectables master of the product: the header, the stages given, no tablet calculations. */
function vialMaster(recordKind: 'PROCESSING' | 'PACKAGING', stages: (like: Json) => Json[], defs: library.BlockDefinition[]): flow.MbrContent {
  return gmpContent((m) => {
    const header = m['header'] as Json;
    header['family'] = `GBI01-${recordKind === 'PROCESSING' ? 'PR' : 'PK'}`;
    header['edition'] = 'injectables';
    header['recordKind'] = recordKind;
    header['title'] = `${PRODUCT.name}: ${recordKind === 'PROCESSING' ? 'aseptic filling to released bulk vials' : 'labelling and packing'}`;
    header['product'] = { code: PRODUCT.code, name: PRODUCT.name, strength: PRODUCT.strength, dosageForm: 'Injection' };
    delete header['unitMassMg'];
    if (recordKind === 'PACKAGING') header['packType'] = 'GLASS-VIAL-2ML';
    const body = (m['procedure'] as Json)['body'] as Json;
    const like = (body['children'] as Json[])[0] as Json;
    body['children'] = stages(like);
    for (const k of ['parameters', 'calculations', 'yieldCheckpoints', 'timeConstraints', 'goldenCases', 'intermediates', 'riskReductions', 'inputs']) m[k] = [];
    m['blockDefinitions'] = defs;
  });
}

/**
 * The processing master: the aseptic filling with its sterility sampling; the counts of the filling window's EM plates
 * after incubation, in a stage of their own; QA's release for packing (H-PACK) in a stage of its own.
 */
export const processing = vialMaster('PROCESSING', (like) => [
  stage(like, 'S-FILL', 'Aseptic filling', [phaseOf(FILL.definition, 'p-fill', FILL.exampleUse), phaseOf(SAMPLING.definition, 'p-sampling', SAMPLING.exampleUse)]),
  stage(like, 'S-EM', 'Environmental monitoring after incubation', [phaseOf(COUNTS.definition, 'p-counts', COUNTS.exampleUse)]),
  stage(like, 'S-RELEASE', 'Release for packing', [{ kind: 'holdPoint', id: 'H-PACK', name: 'Batch released for packing', role: 'QA', dispositions: ['APPROVED', 'NOT_APPROVED'] }]),
], [FILL.definition, SAMPLING.definition, COUNTS.definition]);
/** The packaging master: the finished-pack examination that closes an injectables packaging record. */
export const packaging = vialMaster('PACKAGING', (like) => [stage(like, 'S-PACK', 'Labelling and packing', [phaseOf(EXAM.definition, 'p-exam', EXAM.exampleUse)])], [EXAM.definition]);

export interface Masters { proc: { familyId: string; versionId: string }; pack: { familyId: string; versionId: string }; world: World }

/** A signed act on the golden clock (one second after the act before). */
async function sign(gmp: ExecServer, key: string, action: Parameters<typeof signAs>[3]): Promise<void> {
  tick();
  await signAs(gmp, await gmp.asPersona(key), key, action);
}
async function ok(d: RunDriver, persona: string, intent: Parameters<RunDriver['ok']>[1]): Promise<void> {
  tick();
  await d.ok(persona, intent);
}
async function signed(d: RunDriver, persona: string, intent: Parameters<RunDriver['signed']>[1]): Promise<void> {
  tick();
  await d.signed(persona, intent);
}

/** The plant units the filling names (test arrangement of master data, triggers off): qualified, of the formulation's classes. */
async function arrangeUnits(gmp: ExecServer): Promise<void> {
  const c = await gmp.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    for (const [cls, code, name] of [['VIAL-FILLING-LINE', FILL_LINE, 'Vial filling line'], ['ROOM-GRADE-C', FILL_ROOM, 'Grade C filling room']] as const) {
      await c.query(
        "insert into plant.equipment_class (code, kind, description, clean_hold, dirty_hold, calibration_required, recorded_by) values ($1, 'PROCESS', $2, interval '3 days', interval '2 days', false, gen_random_uuid()) on conflict do nothing",
        [cls, name],
      );
      const { rows } = await c.query<{ id: string }>("insert into plant.equipment (code, name, class_code, kind, recorded_by) values ($1, $2, $3, 'PROCESS', gen_random_uuid()) returning id", [code, name, cls]);
      await c.query("insert into plant.equipment_event (equipment_id, kind, reference, detail, person_id, account_id) values ($1, 'QUALIFIED', 'QUAL-INJ', 'IQ/OQ/PQ approved', gen_random_uuid(), gen_random_uuid())", [rows[0]?.id]);
    }
    await c.query('commit');
  } finally {
    c.release();
  }
}

/**
 * The master data on the real clock, before the scenario's start: the product, its manufacturing licence, the catalogue
 * blocks QA approved, the plant units, the approved and authorised master pair, the numbering rules and the finished
 * product's specification (QC drafts it, the head of QC approves it).
 */
export async function setUpGbi01(gmp: ExecServer): Promise<Masters> {
  const steward = await gmp.asPersona('steward');
  valueOf(await steward.call(routes.masterData.enterProduct, { body: { productCode: PRODUCT.code, strength: PRODUCT.strength, productName: PRODUCT.name, dosageForm: 'Injection', betaLactam: false, shelfLifeMonths: 24, changeReason: REASON } }));
  await confirmErpPending(gmp);
  const regulatory = await gmp.asPersona('regulatory');
  const licence = valueOf(await regulatory.call(routes.india.recordLicence, { body: {
    licenceKind: 'MANUFACTURING', form: '25', licenceNumber: 'MFG/INJ/GBI01', holderName: 'Demo Parenterals Pvt Ltd', holderAddress: 'Plot 9, Pharma City, Hyderabad 500078',
    validFrom: '2020-01-01T00:00:00+05:30', products: [{ productCode: PRODUCT.code, strength: PRODUCT.strength }],
  } }));
  await signAs(gmp, await gmp.asPersona('approver'), 'approver', { kind: 'INDIA_ACT', act: 'LICENCE_APPROVE', subjectId: licence.licenceId });
  const [author, approver] = await Promise.all([gmp.asPersona('author'), gmp.asPersona('approver')]);
  for (const def of [FILL.definition, SAMPLING.definition, COUNTS.definition, EXAM.definition]) {
    const { block } = valueOf(await author.call(routes.library.draft, { body: { definition: def as unknown as Json } }));
    await signAs(gmp, approver, 'approver', { kind: 'LIBRARY_ACT', act: 'BLOCK_APPROVE', subjectId: block.blockId });
  }
  await arrangeUnits(gmp);
  const world = await gmpLifecycleWorld(gmp);
  const stewardActor = await actorOf(gmp, 'steward');
  const versions: Record<string, { familyId: string; versionId: string }> = {};
  for (const [content, kind, format] of [[processing, 'PROCESSING', 'V{YY}{SEQ:5}'], [packaging, 'PACKAGING', '{PARENT}/P{SEQ:2}']] as const) {
    const v = await world.approvedVersion(content);
    await world.authorise({ versionId: v.versionId, market: 'IN', kind: 'CURRENT', cells: [cell(SITE, LINE, SIZE)], regulatoryBasis: 'IN: registration on file (invented injectable)' });
    versions[kind] = v;
    await world.run(stewardActor, (c) =>
      c.query('select site.define_batch_number_rule($1::jsonb)', [JSON.stringify({ rule_code: `GBI01-${kind.slice(0, 2)}`, site_code: SITE, product_code: PRODUCT.code, batch_kind: kind, format, site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3' })]),
      reason(`GB-I-01 numbering (${kind.toLowerCase()})`),
    );
  }
  const [qc, head] = await Promise.all([gmp.asPersona('qcAnalyst'), gmp.asPersona('qcApprover')]);
  const spec = valueOf(await qc.call(routes.specifications.draft, { body: {
    materialCode: PRODUCT.code, title: 'Finished product specification (DEMO-ONLY, invented)', monographReference: 'In-house monograph GBI01 (DEMO-ONLY)',
    tests: SPEC_TESTS.map((t) => ({ testCode: t.testCode, methodReference: t.methodReference, unit: t.unit, upperLimit: t.upperLimit, required: true, pharmacopoeia: t.pharmacopoeia, edition: t.edition, sampleQuantity: t.sampleQuantity, sampleUnit: '1' })),
  } }));
  await signAs(gmp, head, 'qcApprover', { kind: 'LIMS_ACT', act: 'SPECIFICATION_APPROVE', subjectId: spec.specificationId });
  const proc = versions['PROCESSING'];
  const pack = versions['PACKAGING'];
  if (!proc || !pack) throw new Error('the master pair was not approved');
  return { proc, pack, world };
}

/** The nominal entries of a library step at `stepKey` (the filling's units by their codes), signed as performed and verified. */
async function runLibrary(d: RunDriver, stepKey: string, item: { definition: library.BlockDefinition; exampleUse: unknown }, over: Json = {}): Promise<void> {
  await ok(d, 'operator1', { type: 'START_STEP', stepKey });
  const units: Json = { line: FILL_LINE, room: FILL_ROOM };
  let trays = 0;
  for (const e of library.nominalEntries(item.definition, item.exampleUse as never)) {
    const { kind, ...entry } = e;
    // The equipment facts are the server's (EBMR-API-SERVER-FILLED): the entry names the units by their codes only.
    const data: Json = Object.fromEntries(Object.entries(entry).filter(([k]) => k !== 'equipment' && k !== 'lots'));
    for (const k of Object.keys(data)) if (k in units) data[k] = units[k];
    if (kind === 'tray') data['trayOut'] = `TRAY-GBI01-${String((trays += 1))}`;
    await ok(d, 'operator1', libraryEntry(stepKey, kind, { ...data, ...(over[kind] as Json | undefined) }));
  }
  await signed(d, 'operator1', { type: 'SIGN_PERFORMED', stepKey });
  await signed(d, 'verifier1', { type: 'VERIFY', stepKey, meaning: 'VERIFIED' });
}

/** A filled load into an output container of the batch: the units typed by operator1, verified by verifier1; its label. */
async function closeLoad(gmp: ExecServer, d: RunDriver, batchId: string, units: string): Promise<string> {
  const operator = d.browser('operator1');
  const tap = (path: string, body: Json) => { vi.advanceTimersByTime(7_000); tick(); return tapFor(operator, personaIn(gmp, 'operator1'), 'POST', path, body); };
  const openBody = { batchId, stage: 'FILLED', unit: 'units' as const };
  const c: ContainerView = valueOf(await operator.call(routes.containers.open, { body: openBody, attribution: await tap('/api/containers', openBody) }));
  const closeBody = { expectedVersion: c.version, typed: { net: units } };
  valueOf(await operator.call(routes.containers.close, { params: { containerId: c.containerId }, body: closeBody, attribution: await tap(`/api/containers/${c.containerId}/close`, closeBody) }));
  tick();
  await signAs(gmp, d.browser('verifier1'), 'verifier1', { kind: 'CONTAINER_ACT', act: 'VERIFY_CLOSE', containerId: c.containerId });
  return c.label;
}

/** A driver whose taps also tick the golden clock (the RunDriver's own taps at a kiosk). */
async function goldenDriver(gmp: ExecServer, batchId: string): Promise<RunDriver> {
  const d = await driverOf(gmp, batchId);
  d.beforeTap = () => { vi.advanceTimersByTime(7_000); tick(); };
  return d;
}

/**
 * The processing batch: planned from its ERP order, issued, filled aseptically with its sterility samples taken and its
 * two loads closed into verified output containers; seven days later the EM plates of the filling window are counted;
 * QA releases the batch for packing (H-PACK).
 */
export async function runBatch(gmp: ExecServer, m: Masters): Promise<{ batch: BatchRef; loads: string[] }> {
  tick();
  await postOrder(gmp.db.app, await openServiceSession(gmp.db, gmp.seed, 'erpInterface'), processing, SIZE, { orderNo: 'PO-GBI01-001' });
  tick();
  const issuer = await gmp.asPersona('issuer');
  const planned = valueOf(await issuer.call(routes.execution.planBatch, { body: { familyId: m.proc.familyId, markets: ['IN'], site: SITE, line: LINE, batchSize: SIZE } }));
  tick();
  await issueBatch(gmp, planned.batchId, { code: 'PRODUCTION_PLAN', text: 'Issued for the plan' });
  const batch = { batchId: planned.batchId, batchNumber: planned.batchNumber };
  let d = await goldenDriver(gmp, batch.batchId);
  await runLibrary(d, 'p-fill@', FILL);
  await runLibrary(d, 'p-sampling@', SAMPLING);
  const loads: string[] = [];
  for (const units of PLAN.loads) loads.push(await closeLoad(gmp, d, batch.batchId, units));
  await signed(d, 'supervisor1', { type: 'SIGN_OFF_STAGE', stageKey: 'S-FILL@' });
  // The plates of the filling window incubate; their counts are read days later (new sessions after the wait).
  advanceMinutes(WAITS.emIncubation);
  d = await goldenDriver(gmp, batch.batchId);
  await runLibrary(d, 'p-counts@', COUNTS);
  await signed(d, 'supervisor1', { type: 'SIGN_OFF_STAGE', stageKey: 'S-EM@' });
  await signed(d, 'qa1', { type: 'DISPOSITION_HOLD_POINT', stepKey: 'H-PACK@', disposition: 'APPROVED', comment: 'Batch released for packing' });
  await signed(d, 'supervisor1', { type: 'SIGN_OFF_STAGE', stageKey: 'S-RELEASE@' });
  const status = await statusOf(gmp, batch.batchId);
  if (status !== 'EXECUTION_COMPLETE') throw new Error(`the processing batch ended ${String(status)}`);
  return { batch, loads };
}

export interface Gbi01Release {
  order: BatchRef;
  lotId: string;
  /** The refusal of a STERILITY result sent with a method other than the specification's. */
  otherMethod: { status: number; code: string };
  /** The lot's results as the API shows them (QC's screen), in recorded order. */
  results: Pick<LotResultView, 'testCode' | 'methodReference' | 'value' | 'unit' | 'verdict' | 'state'>[];
  /** Who recorded and who approved each result (persona keys). */
  approvals: { recordedBy: string; approvedBy: string }[];
  /** The release view before the AP signs: its state and the G-REL items' status (none RED). */
  ready: { state: string; items: Record<string, string> };
  decision: string;
  lotStatus: string;
}

/** Production approval, the register, the audit-trail review and QA's review of one record (outline 5.2.2, 5.4). */
async function review(gmp: ExecServer, b: BatchRef): Promise<void> {
  await sign(gmp, 'head1', { kind: 'REVIEW_ACT', act: 'PRODUCTION_APPROVE', batchId: b.batchId, input: {} });
  const qa2 = await gmp.asPersona('qaApprover2');
  tick();
  const register = valueOf(await qa2.call(routes.review.register, { params: { batchId: b.batchId }, body: {} }));
  for (const item of register.items.filter((i) => i.reviewStatus === 'OPEN')) {
    tick();
    if (item.critical) valueOf(await qa2.call(routes.review.openItem, { params: { batchId: b.batchId, exceptionId: item.exceptionId }, body: {} }));
    tick();
    await signAs(gmp, qa2, 'qaApprover2', { kind: 'REVIEW_ACT', act: 'DISPOSE_ITEM', batchId: b.batchId, input: { items: [item.exceptionId], disposition: 'ACCEPT', ...(item.critical ? { justification: 'Reviewed with its disposition: no impact on the batch' } : {}) } });
  }
  const qa = await gmp.asPersona('qaInvestigator');
  tick();
  const report = valueOf(await qa.call(routes.review.auditTrail, { params: { batchId: b.batchId }, query: {} }));
  tick();
  await signAs(gmp, qa, 'qaInvestigator', { kind: 'REVIEW_ACT', act: 'AUDIT_TRAIL_REVIEW', batchId: b.batchId, input: { reviewId: report.reviewId } });
  tick();
  const view = valueOf(await qa2.call(routes.review.batch, { params: { batchId: b.batchId } }));
  if (view.gates.qaReview.problems.length > 0) throw new Error(`the QA review of ${b.batchNumber} is not ready: ${view.gates.qaReview.problems.join('; ')}`);
  tick();
  await signAs(gmp, qa2, 'qaApprover2', { kind: 'REVIEW_ACT', act: 'QA_REVIEW', batchId: b.batchId, input: { expectedEpoch: view.epoch } });
}

/**
 * The packaging order takes the loads as its bulk and examines the finished packs; the stores post the finished lot in
 * quarantine. Seven days later QC records the release results (STERILITY by the rapid method, its method taken from the
 * specification), the head of QC approves each, QC pulls the reserve sample; both records are reviewed, and the
 * authorised person releases the lot for India with every G-REL item GREEN or NA.
 */
export async function packAndRelease(gmp: ExecServer, m: Masters, batch: BatchRef, loads: string[]): Promise<Gbi01Release> {
  tick();
  const orderNo = await postOrder(gmp.db.app, await openServiceSession(gmp.db, gmp.seed, 'erpInterface'), packaging, SIZE, { orderNo: 'PO-GBI01-002' });
  tick();
  const issuer = await gmp.asPersona('issuer');
  const planned = valueOf(await issuer.call(routes.planning.planPackagingOrder, { body: { familyId: m.pack.familyId, markets: ['IN'], site: SITE, line: LINE, batchSize: SIZE, erpOrder: orderNo, parentBatchId: batch.batchId } }));
  tick();
  await issueBatch(gmp, planned.batchId, { code: 'PACKING_PLAN', text: `Packaging order of batch ${batch.batchNumber}` });
  const order = { batchId: planned.batchId, batchNumber: planned.batchNumber };
  const d = await goldenDriver(gmp, order.batchId);
  const operator = d.browser('operator1');
  const bulkBody = { labels: loads };
  vi.advanceTimersByTime(7_000);
  tick();
  valueOf(await operator.call(routes.batches.issueBulk, { params: { batchId: order.batchId }, body: bulkBody, attribution: await tapFor(operator, personaIn(gmp, 'operator1'), 'POST', `/api/batches/${order.batchId}/bulk`, bulkBody) }));
  await runLibrary(d, 'p-exam@', EXAM, { exam: { printedBatch: batch.batchNumber, printedExpiry: '10/2028' } });
  await signed(d, 'supervisor1', { type: 'SIGN_OFF_STAGE', stageKey: 'S-PACK@' });
  const status = await statusOf(gmp, order.batchId);
  if (status !== 'EXECUTION_COMPLETE') throw new Error(`the packaging order ended ${String(status)}`);
  tick();
  const stores = await gmp.asPersona('stores');
  const lot = valueOf(await stores.call(routes.specifications.postFinishedLot, { body: { batchId: order.batchId, quantity: PLAN.lot, unit: '1' } }));
  const lotId = (lot as unknown as { lotId: string }).lotId;

  // The rapid sterility method reads after its incubation; the other release tests are in by then.
  advanceMinutes(WAITS.rapidSterility);
  const [qc, head] = await Promise.all([gmp.asPersona('qcAnalyst'), gmp.asPersona('qcApprover')]);
  // A method other than the specification's is refused (EBMR-SITE-412): the result takes its method from the specification.
  tick();
  const other = await qc.call(routes.quality.recordLotResult, { params: { lotId }, body: { testCode: 'STERILITY', methodReference: 'Compendial membrane filtration', purpose: 'RELEASE', value: '0', unit: '1' } });
  const refused = refusalOf(other);
  const approvals: { recordedBy: string; approvedBy: string }[] = [];
  for (const t of SPEC_TESTS) {
    tick();
    // As the results screen records it: the test, purpose and value; the method and the limits are the specification's.
    const r = valueOf(await qc.call(routes.quality.recordLotResult, { params: { lotId }, body: { testCode: t.testCode, purpose: 'RELEASE', value: t.result, unit: t.unit } }));
    tick();
    await signAs(gmp, head, 'qcApprover', { kind: 'QUALITY_ACT', act: 'LOT_RESULT_APPROVE', subjectId: r.resultId, input: {} });
    const who = (await gmp.db.admin.query<{ rec: string; app: string }>(
      'select r.recorded_by_person::text as rec, a.approved_by_person::text as app from site.lot_test_result r join site.lot_test_approval a on a.result_id = r.id where r.id = $1',
      [r.resultId],
    )).rows[0];
    const key = (person: string | undefined): string => gmp.seed.personas.find((p) => p.personId === person)?.key ?? `unknown ${String(person)}`;
    approvals.push({ recordedBy: key(who?.rec), approvedBy: key(who?.app) });
  }
  tick();
  valueOf(await qc.call(routes.samples.pull, { params: { lotId }, body: { kind: 'RESERVE', quantity: PLAN.reserve, container: 'Reserve sample tray', storageLocation: 'Reserve sample room RS-1' } }));
  tick();
  const shown = valueOf(await qc.call(routes.quality.lotResults, { params: { lotId } })).results;
  const results = shown.map((r) => ({ testCode: r.testCode, methodReference: r.methodReference, value: r.value, unit: r.unit, verdict: r.verdict, state: r.state }));

  for (const b of [batch, order]) await review(gmp, b);
  const ap = await gmp.asPersona('qcuAuthoriser');
  tick();
  const view = valueOf(await ap.call(routes.release.lot, { params: { lotId } }));
  const ready = { state: view.state, items: Object.fromEntries(view.grel.items.map((i) => [i.id, i.status])) };
  if (view.state !== 'READY') throw new Error(`the lot is not ready: ${view.grel.items.filter((i) => i.status === 'RED').map((i) => `${i.id}: ${i.problem ?? ''}`).join('; ')}`);
  tick();
  await signAs(gmp, ap, 'qcuAuthoriser', { kind: 'RELEASE_ACT', act: 'MANUFACTURER_RELEASE', lotId, input: { expectedEpoch: view.grel.epoch } });
  tick();
  const after = valueOf(await ap.call(routes.release.lot, { params: { lotId } }));
  return { order, lotId, otherMethod: { status: refused.status, code: refused.code }, results, approvals, ready, decision: after.state, lotStatus: String(after.lotStatus) };
}
