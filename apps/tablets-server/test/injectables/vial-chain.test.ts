/**
 * Injectables I-1c2 (docs/build-plan/injectables/resume.md; lead rulings of 9 November 2026): the first injectables lot
 * through the release gate, over the routes, by the seed's personas with real signatures, before any E2E. A master pair of
 * the injectables edition built from catalogue blocks:
 *  - the processing master: the sterility sampling of the catalogue (INJ-STERILITY-SAMPLE), then QA's release for packing
 *    (H-PACK) in a stage of its own, as the designer's skeleton start writes it for the edition (from-formula.ts);
 *  - the packaging master: the finished-pack examination (INJ-PACK-EXAM), which closes a packaging record of the edition
 *    (editions/injectables/sql 3000).
 * The bulk link: the batch's sterilised loads are its output containers (units), closed and verified in its last stage;
 * the packaging order takes them after H-PACK, and the release gate's E.CONTAINER_RELEASE vouches for them. The gate is
 * green for India with the edition's own items, and the authorised person releases the lot.
 *
 * Arranged outside the routes, as the API chain (substance/api-chain.test.ts): the plant-free shape of the masters (the
 * screen-level acceptance runs the room, equipment and printed-material steps), the ERP order and the numbering rules.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { routes, type ContainerView } from '@ebmr/api-contract';
import { library, type flow } from '@ebmr/recipe-core/pure';
import { openServiceSession } from '@ebmr/test-kit';
import { postOrder } from '../../../../packages/recipe-core/test/lifecycle/gmp-support.ts';
import { cell, reason, type World } from '../../../../packages/recipe-core/test/lifecycle/support.ts';
import { INJECTABLE_SEEDS } from '../../../../packages/recipe-core/src/library/seed/injectables.ts';
import { personaIn, startSigningServer, tapFor, valueOf } from '../esig/support.ts';
import type { ExecServer, RunDriver } from '../execution/support.ts';
import { actorOf, gmpContent, gmpLifecycleWorld } from '../support/gmp-world.ts';
import { confirmErpPending } from '../support/signed-acts.ts';
import { driverOf, issueBatch, libraryEntry, phaseOf, releaseApiLot, signAs, stage, statusOf, type BatchRef, type Json } from '../substance/support.ts';

const SITE = 'SITE-1';
const LINE = 'L1';
const SIZE = 'BS-100K';
const TAG = randomUUID().slice(0, 6).toUpperCase();
const PRODUCT = { code: `INJC2-${TAG}`, name: 'Demoinj 10 mg/2 mL vials', strength: '10 mg/2 mL' };
const REASON = 'Injectables I-1c2 chain';

const seed = (code: string) => {
  const item = INJECTABLE_SEEDS.find((s) => s.definition.code === code);
  if (!item) throw new Error(`no injectables seed ${code}`);
  return item;
};
const SAMPLING = seed('INJ-STERILITY-SAMPLE');
const EXAM = seed('INJ-PACK-EXAM');

/** dc-mini reshaped as an injectables master: the product's header, the stages given, no tablet calculations. */
function vialMaster(recordKind: 'PROCESSING' | 'PACKAGING', stages: (like: Json) => Json[], defs: library.BlockDefinition[]): flow.MbrContent {
  return gmpContent((m) => {
    const header = m['header'] as Json;
    header['family'] = `INJ-${recordKind === 'PROCESSING' ? 'PR' : 'PK'}-${TAG}`;
    header['edition'] = 'injectables';
    header['recordKind'] = recordKind;
    header['title'] = `${PRODUCT.name}: ${recordKind === 'PROCESSING' ? 'compounding to sterilised vials' : 'labelling and packing'}`;
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

const processing = vialMaster('PROCESSING', (like) => [
  stage(like, 'S-FILL', 'Filling and terminal sterilisation', [phaseOf(SAMPLING.definition, 'p-sampling', SAMPLING.exampleUse)]),
  // As the designer's skeleton start of the edition writes it (from-formula.ts, releaseForPacking): H-PACK in a stage of
  // its own.
  stage(like, 'S-RELEASE', 'Release for packing', [{ kind: 'holdPoint', id: 'H-PACK', name: 'Batch released for packing', role: 'QA', dispositions: ['APPROVED', 'NOT_APPROVED'] }]),
], [SAMPLING.definition]);
const packaging = vialMaster('PACKAGING', (like) => [stage(like, 'S-PACK', 'Labelling and packing', [phaseOf(EXAM.definition, 'p-exam', EXAM.exampleUse)])], [EXAM.definition]);

let gmp: ExecServer;
let world: World;
let proc: { familyId: string; versionId: string };
let pack: { familyId: string; versionId: string };
let batch: BatchRef;
let order: BatchRef;
let loads: string[] = [];
let lotId = '';

/** The nominal entries of a library step, recorded at `stepKey` and signed as performed and verified. */
async function runLibrary(d: RunDriver, stepKey: string, item: { definition: library.BlockDefinition; exampleUse: unknown }, over: Json = {}): Promise<void> {
  await d.ok('operator1', { type: 'START_STEP', stepKey });
  for (const e of library.nominalEntries(item.definition, item.exampleUse as never)) {
    const { kind, ...data } = e;
    await d.ok('operator1', libraryEntry(stepKey, kind, { ...data, ...(over[kind] as Json | undefined) }));
  }
  await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey });
  await d.signed('verifier1', { type: 'VERIFY', stepKey, meaning: 'VERIFIED' });
}

/** A sterilised load into an output container of the batch at its last stage: the units typed by operator1, verified. */
async function closeLoad(d: RunDriver, batchId: string, units: string): Promise<string> {
  const operator = d.browser('operator1');
  const tap = (path: string, body: Json) => { vi.advanceTimersByTime(7_000); return tapFor(operator, personaIn(gmp, 'operator1'), 'POST', path, body); };
  const openBody = { batchId, stage: 'STERILISED', unit: 'units' as const };
  const c: ContainerView = valueOf(await operator.call(routes.containers.open, { body: openBody, attribution: await tap('/api/containers', openBody) }));
  const closeBody = { expectedVersion: c.version, typed: { net: units } };
  valueOf(await operator.call(routes.containers.close, { params: { containerId: c.containerId }, body: closeBody, attribution: await tap(`/api/containers/${c.containerId}/close`, closeBody) }));
  await signAs(gmp, d.browser('verifier1'), 'verifier1', { kind: 'CONTAINER_ACT', act: 'VERIFY_CLOSE', containerId: c.containerId });
  return c.label;
}

beforeAll(async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), 'ebmr-inj-chain-'));
  gmp = Object.assign(await startSigningServer('GMP', { stub: false, env: { EBMR_NUMBER_LEDGER_FILE: join(ledgerDir, 'numbers.ledger.jsonl') } }), { exchangeDir: ledgerDir });
  vi.useFakeTimers({ toFake: ['performance'] });
  const steward = await gmp.asPersona('steward');
  valueOf(await steward.call(routes.masterData.enterProduct, { body: { productCode: PRODUCT.code, strength: PRODUCT.strength, productName: PRODUCT.name, dosageForm: 'Injection', betaLactam: false, shelfLifeMonths: 24, changeReason: REASON } }));
  await confirmErpPending(gmp);
  // The site's manufacturing licence endorsing the product (regulatory records it, QA approves it; IN-30).
  const regulatory = await gmp.asPersona('regulatory');
  const licence = valueOf(await regulatory.call(routes.india.recordLicence, { body: {
    licenceKind: 'MANUFACTURING', form: '25', licenceNumber: `MFG/INJ/${TAG}`, holderName: 'Demo Parenterals Pvt Ltd', holderAddress: 'Plot 9, Pharma City, Hyderabad 500078',
    validFrom: '2020-01-01T00:00:00+05:30', products: [{ productCode: PRODUCT.code, strength: PRODUCT.strength }],
  } }));
  await signAs(gmp, await gmp.asPersona('approver'), 'approver', { kind: 'INDIA_ACT', act: 'LICENCE_APPROVE', subjectId: licence.licenceId });
  // QA approves the two catalogue blocks (drafted by the author).
  const [author, approver] = await Promise.all([gmp.asPersona('author'), gmp.asPersona('approver')]);
  for (const def of [SAMPLING.definition, EXAM.definition]) {
    const { block } = valueOf(await author.call(routes.library.draft, { body: { definition: def as unknown as Json } }));
    await signAs(gmp, approver, 'approver', { kind: 'LIBRARY_ACT', act: 'BLOCK_APPROVE', subjectId: block.blockId });
  }
  world = await gmpLifecycleWorld(gmp);
  const stewardActor = await actorOf(gmp, 'steward');
  for (const [content, kind, format] of [[processing, 'PROCESSING', 'V{YY}{SEQ:5}'], [packaging, 'PACKAGING', '{PARENT}/P{SEQ:2}']] as const) {
    const v = await world.approvedVersion(content);
    await world.authorise({ versionId: v.versionId, market: 'IN', kind: 'CURRENT', cells: [cell(SITE, LINE, SIZE)], regulatoryBasis: 'IN: registration on file (invented injectable)' });
    if (kind === 'PROCESSING') proc = v;
    else pack = v;
    await world.run(stewardActor, (c) =>
      c.query('select site.define_batch_number_rule($1::jsonb)', [JSON.stringify({ rule_code: `INJC2-${kind.slice(0, 2)}-${TAG}`, site_code: SITE, product_code: PRODUCT.code, batch_kind: kind, format, site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3' })]),
      reason(`Injectables I-1c2 numbering (${kind.toLowerCase()})`),
    );
  }
}, 900_000);
afterAll(async () => {
  vi.useRealTimers();
  await gmp?.close();
});

describe('Injectables I-1c2: one vial batch from catalogue blocks to a released lot, over the routes', () => {
  it('[PR-01][PR-05][PR-37] the vial master pair is approved: an injectables packaging master completes with the finished-pack examination (recipe.packaging_completion_block), the processing master does not, and a tablets one still needs TB-24', async () => {
    const problem = async (edition: string, content: flow.MbrContent) =>
      (await gmp.db.admin.query<{ p: string | null }>('select recipe.packaging_master_problem($1, $2::jsonb) as p', [edition, JSON.stringify(content)])).rows[0]?.p ?? null;
    expect(await problem('injectables', packaging)).toBeNull();
    expect(await problem('injectables', processing)).toMatch(/has no LIB-INJ-PACK-EXAM step/);
    expect(await problem('tablets', packaging)).toMatch(/has no TB-24 step/);
    const { rows } = await gmp.db.admin.query<{ e: string; k: string }>('select edition as e, record_kind as k from recipe.mbr_family where id = any ($1) order by record_kind desc', [[proc.familyId, pack.familyId]]);
    expect(rows).toEqual([{ e: 'injectables', k: 'PROCESSING' }, { e: 'injectables', k: 'PACKAGING' }]);
  });

  it('[INV-27][PR-37][IN-18][ST-66] the processing batch is planned from its ERP order, issued, runs the catalogue\'s sterility sampling, puts its sterilised loads into verified output containers (units) in its last stage and is released for packing by QA (H-PACK)', async () => {
    const issuer = await gmp.asPersona('issuer');
    await postOrder(gmp.db.app, await openServiceSession(gmp.db, gmp.seed, 'erpInterface'), processing, SIZE);
    const planned = valueOf(await issuer.call(routes.execution.planBatch, { body: { familyId: proc.familyId, markets: ['IN'], site: SITE, line: LINE, batchSize: SIZE } }));
    await issueBatch(gmp, planned.batchId, { code: 'PRODUCTION_PLAN', text: 'Issued for the plan' });
    batch = { batchId: planned.batchId, batchNumber: planned.batchNumber };
    const d = await driverOf(gmp, batch.batchId);
    await runLibrary(d, 'p-sampling@', SAMPLING);
    loads = [await closeLoad(d, batch.batchId, '4900'), await closeLoad(d, batch.batchId, '4820')];
    await d.signed('supervisor1', { type: 'SIGN_OFF_STAGE', stageKey: 'S-FILL@' });
    await d.signed('qa1', { type: 'DISPOSITION_HOLD_POINT', stepKey: 'H-PACK@', disposition: 'APPROVED', comment: 'Batch released for packing' });
    await d.signed('supervisor1', { type: 'SIGN_OFF_STAGE', stageKey: 'S-RELEASE@' });
    expect(await statusOf(gmp, batch.batchId)).toBe('EXECUTION_COMPLETE');
  });

  it('[INV-27][IN-18][PR-37][PR-45] the packaging order takes the sterilised loads as its bulk, examines the finished packs at completion, and the stores post the finished lot of the injectables edition in quarantine', async () => {
    const issuer = await gmp.asPersona('issuer');
    const orderNo = await postOrder(gmp.db.app, await openServiceSession(gmp.db, gmp.seed, 'erpInterface'), packaging, SIZE);
    const planned = valueOf(await issuer.call(routes.planning.planPackagingOrder, { body: { familyId: pack.familyId, markets: ['IN'], site: SITE, line: LINE, batchSize: SIZE, erpOrder: orderNo, parentBatchId: batch.batchId } }));
    await issueBatch(gmp, planned.batchId, { code: 'PACKING_PLAN', text: `Packaging order of batch ${batch.batchNumber}` });
    order = { batchId: planned.batchId, batchNumber: planned.batchNumber };
    expect(order.batchNumber).toBe(`${batch.batchNumber}/P01`);
    // The bulk the order may take is the loads, and only they.
    const offered = (await gmp.db.admin.query<{ label: string }>('select c.label_code as label from plant.output_container c where c.batch_id = $1 and recipe.packaging_bulk_problem(c.id) is null order by 1', [batch.batchId])).rows.map((r) => r.label);
    expect(offered).toEqual([...loads].sort());
    const d = await driverOf(gmp, order.batchId);
    const operator = d.browser('operator1');
    const bulkBody = { labels: loads };
    vi.advanceTimersByTime(7_000);
    valueOf(await operator.call(routes.batches.issueBulk, { params: { batchId: order.batchId }, body: bulkBody, attribution: await tapFor(operator, personaIn(gmp, 'operator1'), 'POST', `/api/batches/${order.batchId}/bulk`, bulkBody) }));
    await runLibrary(d, 'p-exam@', EXAM, { exam: { printedBatch: batch.batchNumber, printedExpiry: '10/2028' } });
    await d.signed('supervisor1', { type: 'SIGN_OFF_STAGE', stageKey: 'S-PACK@' });
    expect(await statusOf(gmp, order.batchId)).toBe('EXECUTION_COMPLETE');
    const stores = await gmp.asPersona('stores');
    const lot = valueOf(await stores.call(routes.specifications.postFinishedLot, { body: { batchId: order.batchId, quantity: '9600', unit: '1' } }));
    lotId = (lot as unknown as { lotId: string }).lotId;
    const { rows } = await gmp.db.admin.query<{ edition: string; status: string }>('select f.edition, site.lot_state(l.id) as status from site.finished_lot f join site.material_lot l on l.id = f.lot_id where f.lot_id = $1', [lotId]);
    expect(rows).toEqual([{ edition: 'INJECTABLES', status: 'QUARANTINE' }]);
  });

  it('[PR-37][IN-17] a finished-pack examination that finds wrong labels records the count as found (not refused); the step waits for QA\'s disposition, and E.PACK_EXAMINATION stays RED while the deviation QA raised for it is not closed', async () => {
    const issuer = await gmp.asPersona('issuer');
    const orderNo = await postOrder(gmp.db.app, await openServiceSession(gmp.db, gmp.seed, 'erpInterface'), packaging, SIZE);
    const planned = valueOf(await issuer.call(routes.planning.planPackagingOrder, { body: { familyId: pack.familyId, markets: ['IN'], site: SITE, line: LINE, batchSize: SIZE, erpOrder: orderNo, parentBatchId: batch.batchId } }));
    await issueBatch(gmp, planned.batchId, { code: 'PACKING_PLAN', text: `Second packaging order of batch ${batch.batchNumber}` });
    const exam = async () => (await gmp.db.admin.query<{ r: { status: string; problem: string | null } }>('select injectables.grel_pack_examination($1) as r', [planned.batchId])).rows[0]!.r;
    const d = await driverOf(gmp, planned.batchId);
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-exam@' });
    const [entry] = library.nominalEntries(EXAM.definition, EXAM.exampleUse as never);
    const { kind, ...data } = entry!;
    await d.ok('operator1', libraryEntry('p-exam@', kind, { ...data, wrongLabel: '2', printedBatch: batch.batchNumber, printedExpiry: '10/2028' }));
    const state = (await gmp.db.admin.query<{ s: { entries: Record<string, { data: Json }>; exceptions: Record<string, { type: string }> } }>('select state as s from recipe.execution_state where batch_id = $1', [planned.batchId])).rows[0]!.s;
    expect(Object.values(state.entries).map((e) => e.data['wrongLabel'])).toEqual(['2']);
    const breaches = Object.entries(state.exceptions).filter(([, x]) => x.type === 'LIB_LIMIT_BREACH').map(([id]) => id);
    expect(breaches).toHaveLength(1);
    const breach = breaches[0] ?? '';
    expect((await exam()).status).toBe('RED');
    // A critical breach needs a deviation (PR-49): QA raises one and dispositions the exception under it. The step then
    // completes, and the gate stays RED while the deviation is open.
    const qaInv = await gmp.asPersona('qaInvestigator');
    const dev = valueOf(await qaInv.call(routes.quality.raiseDeviation, { body: { kind: 'DEVIATION', title: `Wrong labels found at the finished-pack examination of ${planned.batchNumber}`, classification: 'MAJOR', riskRationale: 'Two units of the sample bore a wrong label; the order is held until the investigation concludes.' } }));
    valueOf(await qaInv.call(routes.quality.linkDeviation, { params: { deviationId: dev.deviationId }, body: { subjectKind: 'BATCH', subjectId: planned.batchId } }));
    await d.ok('supervisor1', { type: 'ATTACH_DEVIATION', exception: breach, deviationRef: dev.ref });
    await d.signed('qa1', { type: 'DISPOSITION_EXCEPTION', exception: breach, outcome: 'DEVIATION_RAISED', justification: `Deviation ${dev.ref}: the order is held until the investigation concludes` });
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-exam@' });
    await d.signed('verifier1', { type: 'VERIFY', stepKey: 'p-exam@', meaning: 'VERIFIED' });
    const after = await exam();
    expect(after.status).toBe('RED');
    expect(after.problem).toMatch(new RegExp(`found 2 unit\\(s\\) with a wrong or missing label, not resolved: the deviation ${dev.ref} of exception .+, not CLOSED$`));
  });

  it('[IN-05][INV-05][IN-17][PR-37] QC tests and samples the lot, QA reviews both records; G-REL for India is green with the injectables edition\'s items, the loads packed vouched for, and the authorised person releases the lot', async () => {
    const items = await releaseApiLot(gmp, lotId, PRODUCT.code, [batch, order], { quantity: '10', reserve: '20', unit: '1' });
    const edition = Object.fromEntries(items.filter((i) => i.id.startsWith('E.')).map((i) => [i.id, `${i.group} ${i.status}`]));
    expect(edition).toEqual({
      'E.RECONCILIATION_PRINTED': '4 NA', 'E.RECONCILIATION_YIELD': '4 GREEN', 'E.PACK_EXAMINATION': '9 GREEN',
      'E.HELD_CONTAINERS': '10 GREEN', 'E.CONTAINER_RELEASE': '10 GREEN', 'E.RULE_SETS_VERIFIED': '10 NA', 'E.WHOLE_BATCH_PARENTS': '10 NA',
    });
  });

  it('[IN-17][PR-37][INV-05] the injectables items fail closed: a record with no finished-pack examination is RED, a lot that is no injectables finished lot answers one RED item, and the hook is registered for the edition beside the others', async () => {
    const exam = (await gmp.db.admin.query<{ r: { status: string; problem: string | null } }>('select injectables.grel_pack_examination($1) as r', [batch.batchId])).rows[0]?.r;
    expect(exam?.status).toBe('RED');
    expect(exam?.problem).toMatch(/ran no finished-pack examination/);
    const other = (await gmp.db.admin.query<{ r: { id: string; status: string }[] }>('select injectables.grel_edition_items($1, $2) as r', [randomUUID(), 'IN'])).rows[0]!.r;
    expect(other.map((i) => [i.id, i.status])).toEqual([['E.EDITION', 'RED']]);
    const hooks = (await gmp.db.admin.query<{ edition: string; function_name: string }>('select edition, function_name from recipe.grel_edition_hook order by edition')).rows;
    expect(hooks).toEqual(expect.arrayContaining([
      { edition: 'INJECTABLES', function_name: 'injectables.grel_edition_items(uuid,text)' },
      { edition: 'SUBSTANCE', function_name: 'substance.grel_edition_items(uuid,text)' },
    ]));
  });
});
