/**
 * Injectables I-6, INV-36 (lead rulings, 14 November 2026): a batch whose master has a sterilising filter integrity step
 * is not certified or released unless the step is completed with a passing integrity result before use and a passing one
 * after use, the post-use result recorded after the filtration (Schedule M Part II 6.11.2.7: verified before use,
 * confirmed immediately after use, the results in the batch record), on every market. The release item E.STERILE_FILTER
 * (editions/injectables/sql 3060) reads the role STERILE_FILTER_INTEGRITY and the marks preUseIntegrity and
 * postUseIntegrity from the master's snapshot, and the manufacturer release is refused with EBMR-REL-020 naming it
 * (recipe-core 0781). Over the routes with the seed's personas and real signatures, as the filter reuse gate
 * (filter-reuse-gate.test.ts).
 *
 * Three processing masters: the catalogue's INJ-STERILE-FILTER; the firm's own filter block (another product); and a
 * master with no filter step. Arranged outside the routes: the products, the licence, the released filter lot (test
 * arrangement of the lot register), the ERP order and the numbering rule.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { withCommand } from '@ebmr/kernel';
import { library, type flow } from '@ebmr/recipe-core/pure';
import { openServiceSession } from '@ebmr/test-kit';
import { postOrder } from '../../../../packages/recipe-core/test/lifecycle/gmp-support.ts';
import { cell, reason, type World } from '../../../../packages/recipe-core/test/lifecycle/support.ts';
import { INJECTABLE_ASEPTIC_SEEDS } from '../../../../packages/recipe-core/src/library/seed/injectables-aseptic.ts';
import { refusalOf, startSigningServer, valueOf } from '../esig/support.ts';
import type { ExecServer, RunDriver } from '../execution/support.ts';
import { actorOf, gmpContent, gmpLifecycleWorld } from '../support/gmp-world.ts';
import { confirmErpPending, signAction } from '../support/signed-acts.ts';
import { driverOf, issueBatch, libraryEntry, phaseOf, signAs, stage, type BatchRef, type Json } from '../substance/support.ts';

const SITE = 'SITE-1';
const LINE = 'L1';
const SIZE = 'BS-100K';
const TAG = randomUUID().slice(0, 6).toUpperCase();
const PRODUCT = { code: `INJSF-${TAG}`, name: 'Demoinj sterile-filtered 10 mg/2 mL vials', strength: '10 mg/2 mL' };
const REASON = 'Injectables I-6 INV-36 sterilising filter';
const FILTER_LOT = `FLT-${TAG}`;

const FILTER = (() => {
  const item = INJECTABLE_ASEPTIC_SEEDS.find((s) => s.definition.code === 'INJ-STERILE-FILTER');
  if (!item) throw new Error('no INJ-STERILE-FILTER seed');
  return item;
})();

const processing: flow.MbrContent = gmpContent((m) => {
  const header = m['header'] as Json;
  header['family'] = `INJ-SF-${TAG}`;
  header['edition'] = 'injectables';
  header['recordKind'] = 'PROCESSING';
  header['title'] = `${PRODUCT.name}: sterilising filtration`;
  header['batchSizes'] = (header['batchSizes'] as Json[]).filter((x) => x['id'] === SIZE);
  header['product'] = { code: PRODUCT.code, name: PRODUCT.name, strength: PRODUCT.strength, dosageForm: 'Injection' };
  delete header['unitMassMg'];
  const body = (m['procedure'] as Json)['body'] as Json;
  const like = (body['children'] as Json[])[0] as Json;
  body['children'] = [stage(like, 'S-FILTER', 'Sterilising filtration', [phaseOf(FILTER.definition, 'p-filter', FILTER.exampleUse)])];
  for (const k of ['parameters', 'calculations', 'yieldCheckpoints', 'timeConstraints', 'goldenCases', 'intermediates', 'riskReductions', 'inputs']) m[k] = [];
  m['blockDefinitions'] = [FILTER.definition];
});

/**
 * The firm's own blocks (decision 0026): a sterilising filter block with the role STERILE_FILTER_INTEGRITY and one
 * method, whose results are read by their marks, not by code or field id; and a plain check with no filter step.
 */
const SIG = [{ meaning: 'PERFORMED', role: 'PRODUCTION_OPERATOR' }, { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' }] as library.BlockDefinition['signatures'];
const OWN_FILTER: library.BlockDefinition = {
  code: `FIRMSTF-${TAG}`, version: 1, title: 'Our sterilising filtration', category: 'PROCESS', edition: 'injectables', roles: ['STERILE_FILTER_INTEGRITY'],
  description: 'Our 0.2 micrometre filtration of the bulk solution with its integrity tests.', instructions: 'Test the filter, filter, test it again in its housing.',
  sections: [
    { id: 'before', title: 'Before use', fields: [{ id: 'bpIn', label: 'Bubble point before use', type: 'NUMBER', unit: 'bar', decimals: 2, limitSlot: 'bpIn', critical: true, preUseIntegrity: true }] },
    { id: 'run', title: 'Filtration', fields: [{ id: 'filtered', label: 'Bulk filtered into the receiving vessel', type: 'YES_NO', expected: true }] },
    { id: 'after', title: 'After use', fields: [{ id: 'bpOut', label: 'Bubble point after use', type: 'NUMBER', unit: 'bar', decimals: 2, limitSlot: 'bpOut', critical: true, postUseIntegrity: true }] },
  ],
  signatures: SIG,
};
const OWN_FILTER_USE: Json = { limits: { bpIn: (FILTER.exampleUse.limits as Json)['bubblePointPre'] as Json, bpOut: (FILTER.exampleUse.limits as Json)['bubblePointPost'] as Json } };
const OWN_CHECK: library.BlockDefinition = {
  code: `FIRMCHK-${TAG}`, version: 1, title: 'Our line clearance', category: 'CONTROL', edition: 'injectables', roles: ['OBSERVATION'],
  description: 'The line cleared of the previous product.', instructions: 'Check the line.',
  sections: [{ id: 'check', title: 'Check', fields: [{ id: 'cleared', label: 'Line cleared', type: 'YES_NO', expected: true }] }],
  signatures: SIG,
};
const PRODUCT_OWN = { code: `INJSO-${TAG}`, name: 'Demoinj own-filter 5 mg/1 mL vials', strength: '5 mg/1 mL' };
const SIZE_OWN = 'BS-50K';
function ownMaster(family: string, title: string, phases: [string, string, Json][], defs: library.BlockDefinition[], product: typeof PRODUCT, size: string): flow.MbrContent {
  return gmpContent((m) => {
    const header = m['header'] as Json;
    header['family'] = family;
    header['edition'] = 'injectables';
    header['recordKind'] = 'PROCESSING';
    header['title'] = `${product.name}: ${title}`;
    // One family per product, form and sizes: each master has a batch size of its own.
    header['batchSizes'] = (header['batchSizes'] as Json[]).filter((x) => x['id'] === size);
    header['product'] = { code: product.code, name: product.name, strength: product.strength, dosageForm: 'Injection' };
    delete header['unitMassMg'];
    const body = (m['procedure'] as Json)['body'] as Json;
    const like = (body['children'] as Json[])[0] as Json;
    body['children'] = phases.map(([stageId, stageTitle, phase]) => stage(like, stageId, stageTitle, [phase]));
    for (const k of ['parameters', 'calculations', 'yieldCheckpoints', 'timeConstraints', 'goldenCases', 'intermediates', 'riskReductions', 'inputs']) m[k] = [];
    m['blockDefinitions'] = defs;
  });
}
const ownFiltered = ownMaster(`INJ-SFO-${TAG}`, 'own sterilising filtration', [['S-OWN', 'Sterilising filtration', phaseOf(OWN_FILTER, 'p-own', OWN_FILTER_USE)]], [OWN_FILTER], PRODUCT_OWN, SIZE_OWN);
/** The first product at its other batch size, with no filter step. */
const noFilter = ownMaster(`INJ-SFN-${TAG}`, 'line clearance only', [['S-CHK', 'Line clearance', phaseOf(OWN_CHECK, 'p-chk', {})]], [OWN_CHECK], PRODUCT, SIZE_OWN);

let gmp: ExecServer;
let world: World;
let proc: { familyId: string; versionId: string };
let procOwn: { familyId: string; versionId: string };
let procNone: { familyId: string; versionId: string };

/** The released sterilising filter lot the step names (test arrangement of the lot register, triggers off; a component, of kind PRIMARY_PACKAGING as the E2E receives it). */
async function arrangeFilterLot(): Promise<void> {
  const c = await gmp.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    const { rows } = await c.query<{ id: string }>(
      `insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, received_quantity, unit, expires_at,
                                      received_by_person, received_by_account, correlation_id)
       values (gen_random_uuid(), $1, $2, $3, 'Sterilising filter cartridge, 0.2 micrometre', 'PRIMARY_PACKAGING', 10, '1', clock_timestamp() + interval '1 year',
               gen_random_uuid(), gen_random_uuid(), gen_random_uuid()) returning id`,
      [SITE, FILTER_LOT, `MAT-FLT-${TAG}`],
    );
    const id = rows[0]?.id;
    await c.query("insert into platform.aggregate_state (aggregate_type, aggregate_id, machine_code, machine_version, state, version) values ('material_lot', $1, 'material_lot', 1, 'RELEASED', 2)", [id]);
    await c.query("insert into site.lot_identity_result (lot_id, result, method_reference, test_reference, recorded_by_person, recorded_by_account) values ($1, 'PASS', 'STP-ID', 'AR-1', gen_random_uuid(), gen_random_uuid())", [id]);
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

/** The finished lot of the batch, posted as the edition's definer posts it (site.create_finished_lot is not granted). */
async function lotOf(b: BatchRef, product: typeof PRODUCT = PRODUCT): Promise<string> {
  const stores = { ...(await actorOf(gmp, 'stores')), reasonCode: 'TEST_SETUP', reasonText: 'finished lot of the processing record', correlationId: randomUUID() };
  return withCommand(gmp.db.admin, stores, async (c) =>
    String((await c.query<{ id: string }>('select site.create_finished_lot($1::jsonb) as id', [
      JSON.stringify({ batchId: b.batchId, batchNumber: b.batchNumber, edition: 'INJECTABLES', siteCode: SITE, productCode: product.code, productName: product.name,
                       strength: product.strength, markets: ['IN'], quantity: '9600', unit: 'units', expiresAt: '2028-10-31T23:59:59Z' }),
    ])).rows[0]?.id),
  );
}

beforeAll(async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), 'ebmr-inj-sterile-'));
  gmp = Object.assign(await startSigningServer('GMP', { stub: false, env: { EBMR_NUMBER_LEDGER_FILE: join(ledgerDir, 'numbers.ledger.jsonl') } }), { exchangeDir: ledgerDir });
  vi.useFakeTimers({ toFake: ['performance'] });
  const steward = await gmp.asPersona('steward');
  for (const p of [PRODUCT, PRODUCT_OWN]) {
    valueOf(await steward.call(routes.masterData.enterProduct, { body: { productCode: p.code, strength: p.strength, productName: p.name, dosageForm: 'Injection', betaLactam: false, shelfLifeMonths: 24, changeReason: REASON } }));
  }
  await confirmErpPending(gmp);
  const regulatory = await gmp.asPersona('regulatory');
  const licence = valueOf(await regulatory.call(routes.india.recordLicence, { body: {
    licenceKind: 'MANUFACTURING', form: '25', licenceNumber: `MFG/INJ/${TAG}`, holderName: 'Demo Parenterals Pvt Ltd', holderAddress: 'Plot 9, Pharma City, Hyderabad 500078',
    validFrom: '2020-01-01T00:00:00+05:30', products: [PRODUCT, PRODUCT_OWN].map((p) => ({ productCode: p.code, strength: p.strength })),
  } }));
  await signAs(gmp, await gmp.asPersona('approver'), 'approver', { kind: 'INDIA_ACT', act: 'LICENCE_APPROVE', subjectId: licence.licenceId });
  const [author, approver] = await Promise.all([gmp.asPersona('author'), gmp.asPersona('approver')]);
  for (const def of [FILTER.definition, OWN_FILTER, OWN_CHECK]) {
    const { block } = valueOf(await author.call(routes.library.draft, { body: { definition: def as unknown as Json } }));
    await signAs(gmp, approver, 'approver', { kind: 'LIBRARY_ACT', act: 'BLOCK_APPROVE', subjectId: block.blockId });
  }
  await arrangeFilterLot();
  world = await gmpLifecycleWorld(gmp);
  proc = await world.approvedVersion(processing);
  await world.authorise({ versionId: proc.versionId, market: 'IN', kind: 'CURRENT', cells: [cell(SITE, LINE, SIZE)], regulatoryBasis: 'IN: registration on file (invented injectable)' });
  for (const content of [ownFiltered, noFilter]) {
    const v = await world.approvedVersion(content);
    await world.authorise({ versionId: v.versionId, market: 'IN', kind: 'CURRENT', cells: [cell(SITE, LINE, SIZE_OWN)], regulatoryBasis: 'IN: registration on file (invented injectable)' });
    if (content === ownFiltered) procOwn = v;
    else procNone = v;
  }
  for (const p of [PRODUCT, PRODUCT_OWN]) {
    await world.run(await actorOf(gmp, 'steward'), (c) =>
      c.query('select site.define_batch_number_rule($1::jsonb)', [JSON.stringify({ rule_code: `${p.code}-NUM`, site_code: SITE, product_code: p.code, batch_kind: 'PROCESSING', format: 'A{YY}{SEQ:5}', site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3' })]),
      reason('Injectables I-6 INV-36 numbering'),
    );
  }
}, 900_000);
afterAll(async () => {
  vi.useRealTimers();
  await gmp?.close();
});

/** The catalogue filter step's entries in the order given (the nominal values, changed per section), recorded by operator1. */
async function recordFilter(d: RunDriver, order: string[], over: Json = {}): Promise<void> {
  const nominal = library.nominalEntries(FILTER.definition, FILTER.exampleUse as never);
  const byKind = new Map(nominal.map((e) => [e.kind, e]));
  for (const kind of order) {
    const e = byKind.get(kind);
    if (!e) throw new Error(`no nominal entry ${kind}`);
    // First used today (so its longer use needs no validation): the hidden answers stay out of the entry.
    const data: Json = Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'kind' && k !== 'lots' && k !== 'extendedUseValidated' && k !== 'validationRef'));
    const fixed: Json = kind === 'filter' ? { filterLot: FILTER_LOT, firstUseToday: true } : {};
    await d.ok('operator1', libraryEntry('p-filter@', kind, { ...data, ...fixed, ...(over[kind] as Json | undefined) }));
  }
}
const NOMINAL = ['TIMER_START', 'filter', 'preUse', 'filtration', 'postUse', 'TIMER_STOP'];

async function signed(d: RunDriver, stepKey: string, stageKey: string): Promise<void> {
  await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey });
  await d.signed('verifier1', { type: 'VERIFY', stepKey, meaning: 'VERIFIED' });
  await d.signed('supervisor1', { type: 'SIGN_OFF_STAGE', stageKey });
}

/** The sterilising filter item of the lot's release view, and the authorised person's manufacturer release of the lot (its refusal, if any). */
async function gate(lotId: string): Promise<{ state: string; item: { status: string; problem: string | null } | undefined; refusal: string | null }> {
  const ap = await gmp.asPersona('qcuAuthoriser');
  const view = valueOf(await ap.call(routes.release.lot, { params: { lotId } }));
  const item = view.grel.items.find((i) => i.id === 'E.STERILE_FILTER');
  const release = await signAction(gmp, ap, 'qcuAuthoriser', { kind: 'RELEASE_ACT', act: 'MANUFACTURER_RELEASE', lotId, input: { expectedEpoch: view.grel.epoch } });
  const refusal = release.ok ? null : `${refusalOf(release).code ?? ''} ${refusalOf(release).why ?? ''}`;
  return { state: view.state, item: item && { status: item.status, problem: item.problem ?? null }, refusal };
}

/** The open critical breach of the batch, dispositioned by QA with a linked deviation (the deviation stays open). */
async function disposition(d: RunDriver, b: BatchRef): Promise<void> {
  const state = (await gmp.db.admin.query<{ s: { exceptions: Record<string, { type: string }> } }>('select state as s from recipe.execution_state where batch_id = $1', [b.batchId])).rows[0]!.s;
  const breach = Object.entries(state.exceptions).filter(([, x]) => x.type === 'LIB_LIMIT_BREACH').map(([id]) => id);
  expect(breach).toHaveLength(1);
  const qaInv = await gmp.asPersona('qaInvestigator');
  const dev = valueOf(await qaInv.call(routes.quality.raiseDeviation, { body: { kind: 'DEVIATION', title: `Sterilising filter failed its integrity test in ${b.batchNumber}`, classification: 'MAJOR', riskRationale: 'The filter may not have been integral; sterility assurance to be assessed.' } }));
  valueOf(await qaInv.call(routes.quality.linkDeviation, { params: { deviationId: dev.deviationId }, body: { subjectKind: 'BATCH', subjectId: b.batchId } }));
  await d.ok('supervisor1', { type: 'ATTACH_DEVIATION', exception: breach[0] ?? '', deviationRef: dev.ref });
  await d.signed('qa1', { type: 'DISPOSITION_EXCEPTION', exception: breach[0] ?? '', outcome: 'DEVIATION_RAISED', justification: `Deviation ${dev.ref}: the batch is held until the investigation concludes` });
}

describe('Injectables I-6: the sterilising filter is integrity tested before and after use for release (INV-36)', () => {
  it('[INV-36] a sterilising filtration step that is not completed keeps the batch from certification: E.STERILE_FILTER is RED and the manufacturer release is refused with EBMR-REL-020 naming it', async () => {
    const b = await issued();
    const d = await driverOf(gmp, b.batchId);
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-filter@' });
    await recordFilter(d, ['TIMER_START', 'filter', 'preUse']);
    const g = await gate(await lotOf(b));
    expect(g.state).toBe('NOT_READY');
    expect(g.item).toMatchObject({ status: 'RED' });
    expect(g.item?.problem).toMatch(/sterilising filter integrity test p-filter@ is IN_PROGRESS, not COMPLETED/);
    expect(g.refusal).toMatch(/EBMR-REL-020.*E\.STERILE_FILTER: the sterilising filter integrity test p-filter@ is IN_PROGRESS/);
  });

  it('[INV-36] a failing pre-use integrity result keeps the batch from certification even once QA has dispositioned its breach and the step is signed: E.STERILE_FILTER is RED and the release is refused', async () => {
    const b = await issued();
    const d = await driverOf(gmp, b.batchId);
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-filter@' });
    // Below its 3.20 bar minimum: the database registers the critical breach, and the step waits for QA.
    await recordFilter(d, NOMINAL, { preUse: { preBubblePoint: '3.05' } });
    await disposition(d, b);
    await signed(d, 'p-filter@', 'S-FILTER@');
    const g = await gate(await lotOf(b));
    expect(g.item).toMatchObject({ status: 'RED' });
    expect(g.item?.problem).toMatch(/pre-use integrity result 3\.05 bar of p-filter@ does not pass its limit/);
    expect(g.refusal).toMatch(/EBMR-REL-020.*E\.STERILE_FILTER/);
  });

  it('[INV-36] a post-use integrity result recorded before the filtration is not "immediately after use": E.STERILE_FILTER is RED and the release is refused, though every result passes', async () => {
    const b = await issued();
    const d = await driverOf(gmp, b.batchId);
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-filter@' });
    await recordFilter(d, ['TIMER_START', 'filter', 'preUse', 'postUse', 'filtration', 'TIMER_STOP']);
    await signed(d, 'p-filter@', 'S-FILTER@');
    const g = await gate(await lotOf(b));
    expect(g.item).toMatchObject({ status: 'RED' });
    expect(g.item?.problem).toMatch(/post-use integrity result of p-filter@ is recorded before the step's other entries/);
    expect(g.refusal).toMatch(/EBMR-REL-020.*E\.STERILE_FILTER/);
  });

  it('[INV-36] a completed sterilising filtration with passing results before and after use, the post-use one after the filtration, passes the item: E.STERILE_FILTER is GREEN, and the release is not refused for it', async () => {
    const b = await issued();
    const d = await driverOf(gmp, b.batchId);
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-filter@' });
    await recordFilter(d, NOMINAL);
    await signed(d, 'p-filter@', 'S-FILTER@');
    const g = await gate(await lotOf(b));
    expect(g.item).toMatchObject({ status: 'GREEN', problem: null });
    // The lot still waits for its QA review and its QC results (other items); none of the refusal is the filter's.
    expect(g.refusal ?? '').not.toMatch(/E\.STERILE_FILTER/);
  });

  it('[INV-36] the firm\'s own filter block gates release the same way, read by its role and marks, not by code: with passing results GREEN; with a failing post-use result, dispositioned, RED and refused; a master with no filter step is NA', async () => {
    const run = async (bpOut: string): Promise<Awaited<ReturnType<typeof gate>>> => {
      const b = await issued(ownFiltered, procOwn.familyId, SIZE_OWN);
      const d = await driverOf(gmp, b.batchId);
      await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-own@' });
      await d.ok('operator1', libraryEntry('p-own@', 'before', { bpIn: '3.60' }));
      await d.ok('operator1', libraryEntry('p-own@', 'run', { filtered: true }));
      await d.ok('operator1', libraryEntry('p-own@', 'after', { bpOut }));
      if (bpOut === '3.00') await disposition(d, b);
      await signed(d, 'p-own@', 'S-OWN@');
      return gate(await lotOf(b, PRODUCT_OWN));
    };
    const passing = await run('3.50');
    expect(passing.item).toMatchObject({ status: 'GREEN', problem: null });
    expect(passing.refusal ?? '').not.toMatch(/E\.STERILE_FILTER/);
    const failing = await run('3.00');
    expect(failing.item).toMatchObject({ status: 'RED' });
    expect(failing.item?.problem).toMatch(/post-use integrity result 3\.00 bar of p-own@ does not pass its limit/);
    expect(failing.refusal).toMatch(/EBMR-REL-020.*E\.STERILE_FILTER/);
    const b = await issued(noFilter, procNone.familyId, SIZE_OWN);
    const d = await driverOf(gmp, b.batchId);
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-chk@' });
    await d.ok('operator1', libraryEntry('p-chk@', 'check', { cleared: true }));
    await signed(d, 'p-chk@', 'S-CHK@');
    const none = await gate(await lotOf(b));
    expect(none.item).toMatchObject({ status: 'NA' });
    expect(none.refusal ?? '').not.toMatch(/E\.STERILE_FILTER/);
  });
});
