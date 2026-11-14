/**
 * Injectables I-6.2: the release gate holds an aseptic lot while its environmental monitoring is not in (ST-24) and while
 * the deviation of an unlisted intervention is open (ST-36), over the routes with the seed's personas and real
 * signatures. A processing master of catalogue blocks: the filling (INJ-FILL, with its event section) and, in a stage of
 * its own, the counts of the EM plates after incubation (INJ-EM-COUNTS). The finished lot is posted on the processing
 * batch as the edition's definer posts it (as the release gate's own tests do), so the gate is evaluated on that record.
 * A second master of the same product holds the nitrogen overlay gas filter's post-use integrity test (INJ-GAS-FILTER,
 * ST-28), so a batch without that test is shown not certifiable. A third master binds the filling to the filling room,
 * made a controlled area, so only an operator authorised for that area signs it there (PR-15, kernel 1190).
 *
 * Arranged outside the routes, as the vial chain (vial-chain.test.ts): the product, the licence, the plant units the
 * filling names (test arrangement of master data), the ERP order and the numbering rule.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { identity, withCommand, type ActorContext } from '@ebmr/kernel';
import { library, type flow } from '@ebmr/recipe-core/pure';
import { openServiceSession, passwordActor } from '@ebmr/test-kit';
import { postOrder } from '../../../../packages/recipe-core/test/lifecycle/gmp-support.ts';
import { cell, reason, type World } from '../../../../packages/recipe-core/test/lifecycle/support.ts';
import { INJECTABLE_SEEDS } from '../../../../packages/recipe-core/src/library/seed/injectables.ts';
import { INJECTABLE_ASEPTIC_SEEDS } from '../../../../packages/recipe-core/src/library/seed/injectables-aseptic.ts';
import { actorOfBrowser, personaIn, refusalOf, startSigningServer, valueOf } from '../esig/support.ts';
import { RunDriver, type ExecServer } from '../execution/support.ts';
import { actorOf, gmpContent, gmpLifecycleWorld } from '../support/gmp-world.ts';
import { confirmErpPending } from '../support/signed-acts.ts';
import { driverOf, issueBatch, libraryEntry, phaseOf, signAs, stage, type BatchRef, type Json } from '../substance/support.ts';

const SITE = 'SITE-1';
const LINE = 'L1';
const SIZE = 'BS-100K';
const GAS_SIZE = 'BS-50K';
const TAG = randomUUID().slice(0, 6).toUpperCase();
const PRODUCT = { code: `INJAG-${TAG}`, name: 'Demoinj aseptic 10 mg/2 mL vials', strength: '10 mg/2 mL' };
const REASON = 'Injectables I-6.2 aseptic gate';
const FILL_LINE = `VIAL-LINE-${TAG}`;
const FILL_ROOM = `ROOM-C-${TAG}`;
/** A seeded shop-floor kiosk this file does not otherwise use, registered to the filling room for the PR-15 test. */
const FILL_KIOSK = 'KIOSK-PRINT-1';

const seed = (code: string) => {
  const item = [...INJECTABLE_SEEDS, ...INJECTABLE_ASEPTIC_SEEDS].find((s) => s.definition.code === code);
  if (!item) throw new Error(`no injectables seed ${code}`);
  return item;
};
const FILL = seed('INJ-FILL');
const COUNTS = seed('INJ-EM-COUNTS');
const ROOM = seed('INJ-ROOM-READY');
const GAS = seed('INJ-GAS-FILTER');

const processing: flow.MbrContent = gmpContent((m) => {
  const header = m['header'] as Json;
  header['family'] = `INJ-AG-${TAG}`;
  header['edition'] = 'injectables';
  header['recordKind'] = 'PROCESSING';
  header['title'] = `${PRODUCT.name}: aseptic filling`;
  header['product'] = { code: PRODUCT.code, name: PRODUCT.name, strength: PRODUCT.strength, dosageForm: 'Injection' };
  delete header['unitMassMg'];
  const body = (m['procedure'] as Json)['body'] as Json;
  const like = (body['children'] as Json[])[0] as Json;
  body['children'] = [
    stage(like, 'S-FILL', 'Aseptic filling', [phaseOf(FILL.definition, 'p-fill', FILL.exampleUse)]),
    // The plates of the filling window are read after their incubation, days later, in a stage of their own.
    stage(like, 'S-EM', 'Environmental monitoring after incubation', [phaseOf(COUNTS.definition, 'p-counts', COUNTS.exampleUse)]),
    // The filling room's readiness block, here read after the filling (a stage of its own): its pressure difference.
    stage(like, 'S-ROOM', 'Filling room check', [phaseOf(ROOM.definition, 'p-room', ROOM.exampleUse)]),
  ];
  for (const k of ['parameters', 'calculations', 'yieldCheckpoints', 'timeConstraints', 'goldenCases', 'intermediates', 'riskReductions', 'inputs']) m[k] = [];
  m['blockDefinitions'] = [FILL.definition, COUNTS.definition, ROOM.definition];
});

/**
 * A second processing master of the same product (ST-28): the compounding's nitrogen overlay and, as the step after it,
 * the overlay gas filter's integrity test after use (INJ-GAS-FILTER). Its own family, so its batches hold only these steps.
 */
const overlay: flow.MbrContent = gmpContent((m) => {
  const header = m['header'] as Json;
  header['family'] = `INJ-GAS-${TAG}`;
  header['edition'] = 'injectables';
  header['recordKind'] = 'PROCESSING';
  header['title'] = `${PRODUCT.name}: overlay gas filter`;
  // Another batch size than the first master's, so the family is another one (one family per product, form and sizes).
  header['batchSizes'] = (header['batchSizes'] as Json[]).filter((x) => x['id'] === GAS_SIZE);
  header['product'] = { code: PRODUCT.code, name: PRODUCT.name, strength: PRODUCT.strength, dosageForm: 'Injection' };
  delete header['unitMassMg'];
  const body = (m['procedure'] as Json)['body'] as Json;
  const like = (body['children'] as Json[])[0] as Json;
  body['children'] = [stage(like, 'S-GAS', 'Overlay gas filter after use', [phaseOf(GAS.definition, 'p-gas', GAS.exampleUse)])];
  for (const k of ['parameters', 'calculations', 'yieldCheckpoints', 'timeConstraints', 'goldenCases', 'intermediates', 'riskReductions', 'inputs']) m[k] = [];
  m['blockDefinitions'] = [GAS.definition];
});

/**
 * A third processing master of the product (PR-15): the aseptic filling in a stage bound to the filling room, so its
 * data is accepted only from a terminal of that room (DI-20). Its own family, of a batch size of its own.
 */
const SUITE_SIZE = 'BS-20K';
const suite: flow.MbrContent = gmpContent((m) => {
  const header = m['header'] as Json;
  header['family'] = `INJ-SUITE-${TAG}`;
  header['edition'] = 'injectables';
  header['recordKind'] = 'PROCESSING';
  header['title'] = `${PRODUCT.name}: aseptic filling in the filling suite`;
  header['batchSizes'] = [{ id: SUITE_SIZE, quantity: { value: '12.000', unit: 'kg' } }];
  header['product'] = { code: PRODUCT.code, name: PRODUCT.name, strength: PRODUCT.strength, dosageForm: 'Injection' };
  delete header['unitMassMg'];
  const body = (m['procedure'] as Json)['body'] as Json;
  const like = (body['children'] as Json[])[0] as Json;
  const filling = stage(like, 'S-FILL', 'Aseptic filling', [phaseOf(FILL.definition, 'p-fill', FILL.exampleUse)]);
  filling['binding'] = { ...(like['binding'] as Json), rooms: [FILL_ROOM] };
  body['children'] = [filling];
  for (const k of ['parameters', 'calculations', 'yieldCheckpoints', 'timeConstraints', 'goldenCases', 'intermediates', 'riskReductions', 'inputs']) m[k] = [];
  m['blockDefinitions'] = [FILL.definition];
});

let gmp: ExecServer;
let world: World;
let proc: { familyId: string; versionId: string };
let procGas: { familyId: string; versionId: string };
let procSuite: { familyId: string; versionId: string };
let n = 0;

/** The plant units the filling names (test arrangement of master data, triggers off): qualified, of the formulation's classes. */
async function arrangeUnits(): Promise<void> {
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

/** A processing batch of the master, planned from its ERP order and issued. */
async function issued(content: flow.MbrContent = processing, familyId: string = proc.familyId, size: string = SIZE): Promise<BatchRef> {
  const issuer = await gmp.asPersona('issuer');
  await postOrder(gmp.db.app, await openServiceSession(gmp.db, gmp.seed, 'erpInterface'), content, size);
  const planned = valueOf(await issuer.call(routes.execution.planBatch, { body: { familyId, markets: ['IN'], site: SITE, line: LINE, batchSize: size } }));
  await issueBatch(gmp, planned.batchId, { code: 'PRODUCTION_PLAN', text: 'Issued for the plan' });
  return { batchId: planned.batchId, batchNumber: planned.batchNumber };
}

/** The nominal entries of a library step at `stepKey` (some sections' data changed, or extra entries), recorded by operator1. */
async function record(d: RunDriver, stepKey: string, item: { definition: library.BlockDefinition; exampleUse: unknown }, over: Json = {}, extra: [string, Json][] = []): Promise<void> {
  await d.ok('operator1', { type: 'START_STEP', stepKey });
  const units: Json = { line: FILL_LINE, room: FILL_ROOM };
  for (const e of library.nominalEntries(item.definition, item.exampleUse as never)) {
    const { kind, ...entry } = e;
    // The equipment facts are the server's (EBMR-API-SERVER-FILLED): the entry names the units by their codes only.
    const data: Json = Object.fromEntries(Object.entries(entry).filter(([k]) => k !== 'equipment' && k !== 'lots'));
    for (const k of Object.keys(data)) if (k in units) data[k] = units[k];
    if (kind === 'tray') data['trayOut'] = `TRAY-${TAG}-${String((n += 1))}`;
    await d.ok('operator1', libraryEntry(stepKey, kind, { ...data, ...(over[kind] as Json | undefined) }));
  }
  for (const [kind, data] of extra) await d.ok('operator1', libraryEntry(stepKey, kind, data));
}

async function signed(d: RunDriver, stepKey: string): Promise<void> {
  await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey });
  await d.signed('verifier1', { type: 'VERIFY', stepKey, meaning: 'VERIFIED' });
}

/** The finished lot of the batch, posted as the edition's definer posts it (site.create_finished_lot is not granted). */
async function lotOf(b: BatchRef): Promise<string> {
  const stores = { ...(await actorOf(gmp, 'stores')), reasonCode: 'TEST_SETUP', reasonText: 'finished lot of the processing record', correlationId: randomUUID() };
  return withCommand(gmp.db.admin, stores, async (c) =>
    String((await c.query<{ id: string }>('select site.create_finished_lot($1::jsonb) as id', [
      JSON.stringify({ batchId: b.batchId, batchNumber: b.batchNumber, edition: 'INJECTABLES', siteCode: SITE, productCode: PRODUCT.code, productName: PRODUCT.name,
                       strength: PRODUCT.strength, markets: ['IN'], quantity: '9600', unit: 'units', expiresAt: '2028-10-31T23:59:59Z' }),
    ])).rows[0]?.id),
  );
}

/** The authorised person's release view of the lot: its state and the G-REL items with their status and problem. */
async function releaseView(lotId: string): Promise<{ state: string; items: Record<string, { status: string; problem: string | null }> }> {
  const ap = await gmp.asPersona('qcuAuthoriser');
  const view = valueOf(await ap.call(routes.release.lot, { params: { lotId } }));
  return { state: view.state, items: Object.fromEntries(view.grel.items.map((i) => [i.id, { status: i.status, problem: i.problem ?? null }])) };
}

beforeAll(async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), 'ebmr-inj-gate-'));
  gmp = Object.assign(await startSigningServer('GMP', { stub: false, env: { EBMR_NUMBER_LEDGER_FILE: join(ledgerDir, 'numbers.ledger.jsonl') } }), { exchangeDir: ledgerDir });
  vi.useFakeTimers({ toFake: ['performance'] });
  const steward = await gmp.asPersona('steward');
  valueOf(await steward.call(routes.masterData.enterProduct, { body: { productCode: PRODUCT.code, strength: PRODUCT.strength, productName: PRODUCT.name, dosageForm: 'Injection', betaLactam: false, shelfLifeMonths: 24, changeReason: REASON } }));
  await confirmErpPending(gmp);
  const regulatory = await gmp.asPersona('regulatory');
  const licence = valueOf(await regulatory.call(routes.india.recordLicence, { body: {
    licenceKind: 'MANUFACTURING', form: '25', licenceNumber: `MFG/INJ/${TAG}`, holderName: 'Demo Parenterals Pvt Ltd', holderAddress: 'Plot 9, Pharma City, Hyderabad 500078',
    validFrom: '2020-01-01T00:00:00+05:30', products: [{ productCode: PRODUCT.code, strength: PRODUCT.strength }],
  } }));
  await signAs(gmp, await gmp.asPersona('approver'), 'approver', { kind: 'INDIA_ACT', act: 'LICENCE_APPROVE', subjectId: licence.licenceId });
  const [author, approver] = await Promise.all([gmp.asPersona('author'), gmp.asPersona('approver')]);
  for (const def of [FILL.definition, COUNTS.definition, ROOM.definition, GAS.definition]) {
    const { block } = valueOf(await author.call(routes.library.draft, { body: { definition: def as unknown as Json } }));
    await signAs(gmp, approver, 'approver', { kind: 'LIBRARY_ACT', act: 'BLOCK_APPROVE', subjectId: block.blockId });
  }
  await arrangeUnits();
  world = await gmpLifecycleWorld(gmp);
  proc = await world.approvedVersion(processing);
  await world.authorise({ versionId: proc.versionId, market: 'IN', kind: 'CURRENT', cells: [cell(SITE, LINE, SIZE)], regulatoryBasis: 'IN: registration on file (invented injectable)' });
  procGas = await world.approvedVersion(overlay);
  await world.authorise({ versionId: procGas.versionId, market: 'IN', kind: 'CURRENT', cells: [cell(SITE, LINE, GAS_SIZE)], regulatoryBasis: 'IN: registration on file (invented injectable)' });
  await world.run(await actorOf(gmp, 'steward'), (c) =>
    c.query('select site.define_batch_number_rule($1::jsonb)', [JSON.stringify({ rule_code: `INJAG-${TAG}`, site_code: SITE, product_code: PRODUCT.code, batch_kind: 'PROCESSING', format: 'A{YY}{SEQ:5}', site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3' })]),
    reason('Injectables I-6.2 numbering'),
  );
}, 900_000);
afterAll(async () => {
  vi.useRealTimers();
  await gmp?.close();
});

describe('Injectables I-6.2: the release gate waits for the EM counts and for the deviation of an unlisted intervention', () => {
  it('[ST-24] a lot whose filling-window plates are still incubating (the EM counts step not done) is not ready: the record is not complete, so G-REL is RED and the release cannot be signed', async () => {
    const b = await issued();
    const d = await driverOf(gmp, b.batchId);
    await record(d, 'p-fill@', FILL);
    await signed(d, 'p-fill@');
    await d.signed('supervisor1', { type: 'SIGN_OFF_STAGE', stageKey: 'S-FILL@' });
    // The counts after incubation are not in: the EM stage is still open.
    const lotId = await lotOf(b);
    const view = await releaseView(lotId);
    expect(view.state).toBe('NOT_READY');
    expect(view.items['G1.REVIEW_1']).toMatchObject({ status: 'RED' });
    expect(view.items['G1.REVIEW_1']?.problem).toMatch(/IN_PROGRESS|ISSUED|not complete|completed QA review/);
  });

  it('[ST-36] an intervention not on the validated list raises an exception; QA dispositions it under a deviation linked to the batch, and while that deviation is open G2.DEVIATIONS is RED and the lot is not ready', async () => {
    const b = await issued();
    const d = await driverOf(gmp, b.batchId);
    await record(d, 'p-fill@', FILL, {}, [['event', { eventKind: 'Intervention', eventWhat: 'Unlisted: stopper chute cleared by hand', eventMinutes: '4', eventListed: false, eventCritical: false }]]);
    const state = (await gmp.db.admin.query<{ s: { exceptions: Record<string, { type: string }> } }>('select state as s from recipe.execution_state where batch_id = $1', [b.batchId])).rows[0]!.s;
    const unlisted = Object.entries(state.exceptions).filter(([, x]) => x.type === 'LIB_UNEXPECTED_ANSWER').map(([id]) => id);
    expect(unlisted).toHaveLength(1);
    // The step cannot be signed until the exception is handled.
    const refused = await d.sign('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-fill@' });
    expect(refused.result.ok).toBe(false);
    const qaInv = await gmp.asPersona('qaInvestigator');
    const dev = valueOf(await qaInv.call(routes.quality.raiseDeviation, { body: { kind: 'DEVIATION', title: `Unlisted intervention during the aseptic filling of ${b.batchNumber}`, classification: 'MAJOR', riskRationale: 'An intervention not qualified in the media fill; sterility assurance to be assessed.' } }));
    valueOf(await qaInv.call(routes.quality.linkDeviation, { params: { deviationId: dev.deviationId }, body: { subjectKind: 'BATCH', subjectId: b.batchId } }));
    await d.ok('supervisor1', { type: 'ATTACH_DEVIATION', exception: unlisted[0] ?? '', deviationRef: dev.ref });
    await d.signed('qa1', { type: 'DISPOSITION_EXCEPTION', exception: unlisted[0] ?? '', outcome: 'DEVIATION_RAISED', justification: `Deviation ${dev.ref}: the batch is held until the investigation concludes` });
    await signed(d, 'p-fill@');
    await d.signed('supervisor1', { type: 'SIGN_OFF_STAGE', stageKey: 'S-FILL@' });
    await record(d, 'p-counts@', COUNTS);
    await signed(d, 'p-counts@');
    await d.signed('supervisor1', { type: 'SIGN_OFF_STAGE', stageKey: 'S-EM@' });
    const lotId = await lotOf(b);
    const view = await releaseView(lotId);
    expect(view.state).toBe('NOT_READY');
    expect(view.items['G2.DEVIATIONS']).toMatchObject({ status: 'RED' });
    expect(view.items['G2.DEVIATIONS']?.problem).toContain(dev.ref);
  });

  it('[ST-28] a batch whose overlay gas filter has no post-use integrity test cannot be certified: the step cannot be signed without the result, so the record is not complete and the lot is not ready; with the result in, the record completes', async () => {
    const b = await issued(overlay, procGas.familyId, GAS_SIZE);
    const d = await driverOf(gmp, b.batchId);
    // The gas filter step is started, but its post-use test is not recorded: it cannot be signed.
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-gas@' });
    const refused = await d.sign('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-gas@' });
    expect(refused.result.ok).toBe(false);
    const lotId = await lotOf(b);
    const before = await releaseView(lotId);
    expect(before.state).toBe('NOT_READY');
    expect(before.items['G1.REVIEW_1']).toMatchObject({ status: 'RED' });
    expect(before.items['G1.REVIEW_1']?.problem).toMatch(/IN_PROGRESS/);
    // With the post-use test recorded and signed, the record completes: the missing test was the only thing holding it.
    for (const e of library.nominalEntries(GAS.definition, GAS.exampleUse as never)) {
      const { kind, ...data } = e;
      await d.ok('operator1', libraryEntry('p-gas@', kind, data));
    }
    await signed(d, 'p-gas@');
    await d.signed('supervisor1', { type: 'SIGN_OFF_STAGE', stageKey: 'S-GAS@' });
    const after = await releaseView(lotId);
    expect(after.items['G1.REVIEW_1']?.problem ?? '').not.toMatch(/IN_PROGRESS/);
  });

  it('[ST-17] a pressure difference typed below its limit is an exception on the batch: the step cannot be signed, and while the exception is not dispositioned the record is not complete and the lot is not ready', async () => {
    const b = await issued();
    const d = await driverOf(gmp, b.batchId);
    await record(d, 'p-fill@', FILL);
    await signed(d, 'p-fill@');
    await d.signed('supervisor1', { type: 'SIGN_OFF_STAGE', stageKey: 'S-FILL@' });
    await record(d, 'p-counts@', COUNTS);
    await signed(d, 'p-counts@');
    await d.signed('supervisor1', { type: 'SIGN_OFF_STAGE', stageKey: 'S-EM@' });
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-room@' });
    const entries = library.nominalEntries(ROOM.definition, ROOM.exampleUse as never);
    for (const kind of ['clearance', 'readings']) {
      const e = entries.find((x) => x.kind === kind);
      if (!e) throw new Error(`no nominal ${kind} entry`);
      const data: Json = Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'kind' && k !== 'equipment'));
      if (kind === 'clearance') data['room'] = FILL_ROOM;
      if (kind === 'readings') data['pressureDiff'] = '8';
      await d.ok('operator1', libraryEntry('p-room@', kind, data));
    }
    const state = (await gmp.db.admin.query<{ s: { exceptions: Record<string, { type: string; status?: string }> } }>('select state as s from recipe.execution_state where batch_id = $1', [b.batchId])).rows[0]!.s;
    expect(Object.values(state.exceptions).filter((x) => x.type === 'LIB_LIMIT_BREACH')).toHaveLength(1);
    const refused = await d.sign('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-room@' });
    expect(refused.result.ok).toBe(false);
    const lotId = await lotOf(b);
    const view = await releaseView(lotId);
    expect(view.state).toBe('NOT_READY');
    expect(view.items['G1.REVIEW_1']).toMatchObject({ status: 'RED' });
  });
});

describe('Injectables I-6: area authorisation in the filling suite (PR-15, kernel 1190)', () => {
  const why = <T extends ActorContext>(ctx: T): T => ({ ...ctx, reasonCode: 'TEST_SETUP', reasonText: 'filling suite area authorisation', correlationId: randomUUID() });

  /**
   * The filling room made a controlled area with a kiosk registered to it (test arrangement), the master whose filling
   * stage is bound to that room, and the room's authorisation type.
   */
  async function arrangeSuite(): Promise<{ coordinator: () => Promise<ActorContext>; code: string }> {
    await world.run(await actorOf(gmp, 'steward'), async (c) => {
      await c.query('select plant.define_area($1::jsonb)', [JSON.stringify({ code: FILL_ROOM, kind: 'ROOM', name: 'Grade C filling room' })]);
      await c.query("select plant.set_area_rule($1, true, null, 'Aseptic filling suite: authorised staff only')", [FILL_ROOM]);
    }, reason('filling suite made a controlled area'));
    procSuite = await world.approvedVersion(suite);
    await world.authorise({ versionId: procSuite.versionId, market: 'IN', kind: 'CURRENT', cells: [cell(SITE, LINE, SUITE_SIZE)], regulatoryBasis: 'IN: registration on file (invented injectable)' });
    // A seeded kiosk registered to the filling room (test arrangement of master data, triggers off): commands from it run there.
    const c = await gmp.db.admin.connect();
    try {
      await c.query('begin');
      await c.query('set local session_replication_role = replica');
      await c.query('update iam.device set room_code = $1 where code = $2', [FILL_ROOM, FILL_KIOSK]);
      await c.query('commit');
    } finally {
      c.release();
    }
    // The training coordinator: no persona holds the role, so qa1's account is granted it through the kernel's access
    // workflow (requested by the administrator, approved by the process owner).
    const qa = personaIn(gmp, 'qa1');
    const admin = why(await passwordActor(gmp.db, gmp.seed.bootstrap.admin, gmp.seed.bootstrap.admin.fingerprint));
    const owner = why(await passwordActor(gmp.db, gmp.seed.bootstrap.owner, gmp.seed.bootstrap.owner.fingerprint));
    const grantId = await withCommand(gmp.db.app, admin, (x) => identity.requestRoleGrant(x, { accountId: qa.accountId, roleCode: 'TRAINING_COORDINATOR', reason: 'test set-up: filling suite area authorisation' }));
    await withCommand(gmp.db.app, owner, (x) => identity.decideRoleGrant(x, grantId, true, 'test set-up: filling suite area authorisation'));
    // qa1 works at a shared kiosk: a fresh tap per command (INV-40).
    const qaBrowser = await gmp.asPersona('qa1');
    const coordinator = async (): Promise<ActorContext> => {
      vi.advanceTimersByTime(7_000);
      return why({ ...(await actorOfBrowser(gmp, qaBrowser, 'qa1')), roleCode: 'TRAINING_COORDINATOR' });
    };
    const code = await withCommand(gmp.db.app, await coordinator(), async (x) => String((await x.query<{ r: string }>('select iam.create_area_authorisation_type($1, $2) as r', [FILL_ROOM, 'Aseptic filling suite'])).rows[0]?.r));
    return { coordinator, code };
  }

  it('[PR-15] a user without area authorisation cannot sign the aseptic filling (INJ-FILL) of an injectables batch in the filling suite; once authorised the same operator signs', async () => {
    const { coordinator, code } = await arrangeSuite();
    const authorise = async (): Promise<string> =>
      withCommand(gmp.db.app, await coordinator(), async (x) =>
        String((await x.query<{ r: string }>("select iam.record_qualification($1, $2, clock_timestamp() - interval '1 hour', null) as r", [personaIn(gmp, 'operator1').personId, code])).rows[0]?.r));
    const b = await issued(suite, procSuite.familyId, SUITE_SIZE);
    const others = Object.fromEntries(await Promise.all((['verifier1', 'supervisor1'] as const).map(async (k) => [k, await gmp.asPersona(k)] as const)));
    const d = new RunDriver(gmp, b.batchId, { operator1: await gmp.asPersona('operator1', FILL_KIOSK), ...others });
    d.beforeTap = () => vi.advanceTimersByTime(7_000);
    // Without an authorisation for the filling suite the operator cannot even start the filling there.
    const start = await d.command('operator1', { type: 'START_STEP', stepKey: 'p-fill@' });
    expect(refusalOf(start)).toMatchObject({ status: 422, code: 'EBMR-PLANT-180' });
    // Authorised by the training coordinator: the filling is started and recorded.
    const qid = await authorise();
    await record(d, 'p-fill@', FILL);
    // The authorisation withdrawn: the signature is refused and nothing is signed.
    await withCommand(gmp.db.app, await coordinator(), (x) => x.query('select iam.withdraw_qualification($1, $2)', [qid, 'Aseptic qualification under review']));
    const before = d.signatures;
    const refused = await d.sign('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-fill@' });
    expect(refused.result.ok).toBe(false);
    expect(JSON.stringify(refused.result.ok ? null : refused.result.error)).toMatch(/EBMR-PLANT-180/);
    expect(d.signatures).toBe(before);
    expect((await d.stepView('operator1', 'p-fill@')).step.status).toBe('IN_PROGRESS');
    // Authorised again: the same operator signs the filling.
    await authorise();
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-fill@' });
    expect((await d.stepView('operator1', 'p-fill@')).step.status).toBe('AWAITING_VERIFICATION');
  });
});
