/**
 * Injectables I-6 B5 (ST-28; lead ruling on #245, 13 November 2026): a batch that applied a nitrogen overlay is not
 * certified or released without a passing post-use integrity result of the overlay's gas filter (Schedule M Part II
 * 6.11.2.7; EU GMP Annex 1 8.88), on every market. Whether the overlay is applied is the compounding's answer at run
 * time (INJ-COMPOUND, preparation.nitrogen), so the database reads it: the release item E.GAS_FILTER
 * (editions/injectables/sql 3040) is RED while the batch has no passing INJ-GAS-FILTER result, and the manufacturer
 * release is refused with EBMR-REL-020 naming it (recipe-core 0781). Over the routes with the seed's personas and real
 * signatures, as the aseptic gate (aseptic-gate.test.ts) and the filter reuse gate (filter-reuse-gate.test.ts).
 *
 * Two processing masters of the same product: compounding alone (no gas filter step), and compounding followed by the
 * gas filter's post-use test; and a master of the firm's own blocks (another product), read by the marks
 * gasOverlayApplied and postUseIntegrity and the role GAS_FILTER_INTEGRITY (3060; lead ruling on B5). The finished lot is posted on the processing batch as the edition's definer posts it.
 * Arranged outside the routes: the product, the licence, the compounding vessel and WFI point (test arrangement of
 * master data), the ERP order and the numbering rule.
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
import { INJECTABLE_SEEDS } from '../../../../packages/recipe-core/src/library/seed/injectables.ts';
import { refusalOf, startSigningServer, valueOf } from '../esig/support.ts';
import type { ExecServer, RunDriver } from '../execution/support.ts';
import { actorOf, gmpContent, gmpLifecycleWorld } from '../support/gmp-world.ts';
import { confirmErpPending, signAction } from '../support/signed-acts.ts';
import { driverOf, issueBatch, libraryEntry, phaseOf, signAs, stage, type BatchRef, type Json } from '../substance/support.ts';

const SITE = 'SITE-1';
const LINE = 'L1';
const SIZE_PLAIN = 'BS-100K';
const SIZE_GAS = 'BS-50K';
const TAG = randomUUID().slice(0, 6).toUpperCase();
const PRODUCT = { code: `INJGF-${TAG}`, name: 'Demoinj overlaid 10 mg/2 mL vials', strength: '10 mg/2 mL' };
/** A second product, whose master is made of the firm's own blocks (one family per product, form and sizes). */
const PRODUCT_OWN = { code: `INJGO-${TAG}`, name: 'Demoinj own-block overlaid 5 mg/1 mL vials', strength: '5 mg/1 mL' };
const REASON = 'Injectables I-6 B5 overlay gas filter';
const VESSEL = `VESSEL-${TAG}`;
const WFI_POINT = `WFI-POU-${TAG}`;

const seed = (code: string) => {
  const item = INJECTABLE_SEEDS.find((s) => s.definition.code === code);
  if (!item) throw new Error(`no injectables seed ${code}`);
  return item;
};
const COMPOUND = seed('INJ-COMPOUND');
const GAS = seed('INJ-GAS-FILTER');
/**
 * The compounding as the formulation sets it, but with a mixing time of at least 0 min: the test's timer runs for
 * milliseconds of trusted time, and the mixing time is not what is at issue here.
 */
const COMPOUND_USE: Json = (() => {
  const use = structuredClone(COMPOUND.exampleUse) as unknown as Json;
  const limits = use['limits'] as Json;
  const mixing = structuredClone(limits['mixingTime']) as Json;
  ((mixing['ranges'] as Json[])[0] as Json)['low'] = { value: '0', inclusive: true };
  limits['mixingTime'] = mixing;
  return use;
})();

/** A processing master of the product: its family, its batch size and its steps (one stage each). */
function master(family: string, size: string, title: string, phases: [string, string, Json][], defs: library.BlockDefinition[], product: typeof PRODUCT = PRODUCT): flow.MbrContent {
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

/** Compounding alone: the master has no gas filter step. */
const plain = master(`INJ-GFP-${TAG}`, SIZE_PLAIN, 'compounding', [['S-COMP', 'Compounding', phaseOf(COMPOUND.definition, 'p-comp', COMPOUND_USE)]], [COMPOUND.definition]);
/** Compounding, then the overlay gas filter's integrity test after use. */
const withFilter = master(`INJ-GFF-${TAG}`, SIZE_GAS, 'compounding and overlay gas filter', [
  ['S-COMP', 'Compounding', phaseOf(COMPOUND.definition, 'p-comp', COMPOUND_USE)],
  ['S-GAS', 'Overlay gas filter after use', phaseOf(GAS.definition, 'p-gas', GAS.exampleUse)],
], [COMPOUND.definition, GAS.definition]);

/**
 * The firm's own blocks (lead ruling on B5, as B3 (a)): a compounding block whose yes/no answer marks the overlay
 * applied, and a gas filter test with the role GAS_FILTER_INTEGRITY whose one critical result is marked. No catalogue
 * code, no catalogue field id: the database reads the marks and the role from the master's snapshot.
 */
const OWN_COMPOUND: library.BlockDefinition = {
  // A role of its own (not GAS_FILTER_INTEGRITY): only the role makes a step the overlay's filter test.
  code: `FIRMMIX-${TAG}`, version: 1, title: 'Our compounding', category: 'PROCESS', edition: 'injectables', roles: ['PARAMETER_RECORD'],
  description: 'Our compounding of the bulk solution, with or without the nitrogen blanket.', instructions: 'Compound as the formulation states.',
  sections: [{ id: 'mix', title: 'Mixing', fields: [
    { id: 'mixedPerSop', label: 'Mixed as the formulation states', type: 'YES_NO', expected: true },
    { id: 'blanket', label: 'Nitrogen blanket used', type: 'YES_NO', gasOverlayApplied: true },
  ] }],
  signatures: [{ meaning: 'PERFORMED', role: 'PRODUCTION_OPERATOR' }, { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' }],
};
const OWN_GAS: library.BlockDefinition = {
  code: `FIRMN2F-${TAG}`, version: 1, title: 'Our nitrogen filter test after use', category: 'CONTROL', edition: 'injectables', roles: ['GAS_FILTER_INTEGRITY'],
  description: 'The nitrogen blanket filter tested after use.', instructions: 'Test the filter in its housing after use.',
  // The test pressure comes first and is not the result: only the mark postUseIntegrity names the result.
  sections: [{ id: 'after', title: 'After use', fields: [
    { id: 'testPressure', label: 'Test pressure applied', type: 'NUMBER', unit: 'bar', decimals: 2 },
    { id: 'bp', label: 'Bubble point after use', type: 'NUMBER', unit: 'bar', decimals: 2, limitSlot: 'bpAfter', critical: true, postUseIntegrity: true },
  ] }],
  signatures: [{ meaning: 'PERFORMED', role: 'PRODUCTION_OPERATOR' }, { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' }],
};
const OWN_GAS_USE: Json = { limits: { bpAfter: (GAS.exampleUse.limits as Json)['gasFilterPost'] as Json } };
const own = master(`INJ-GFO-${TAG}`, SIZE_GAS, 'own compounding and gas filter test', [
  ['S-MIX', 'Compounding', phaseOf(OWN_COMPOUND, 'p-mix', {})],
  ['S-N2F', 'Nitrogen filter after use', phaseOf(OWN_GAS, 'p-n2f', OWN_GAS_USE)],
], [OWN_COMPOUND, OWN_GAS], PRODUCT_OWN);

let gmp: ExecServer;
let world: World;
let procPlain: { familyId: string; versionId: string };
let procGas: { familyId: string; versionId: string };
let procOwn: { familyId: string; versionId: string };

/** The compounding vessel and WFI point the compounding names (test arrangement of master data, triggers off): qualified, of the formulation's classes. */
async function arrangeUnits(): Promise<void> {
  const c = await gmp.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    for (const [cls, code, name] of [['SS-VESSEL-200L', VESSEL, 'Compounding vessel 200 L'], ['WFI-POINT-OF-USE', WFI_POINT, 'WFI point of use']] as const) {
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
async function issued(content: flow.MbrContent, familyId: string, size: string): Promise<BatchRef> {
  const issuer = await gmp.asPersona('issuer');
  await postOrder(gmp.db.app, await openServiceSession(gmp.db, gmp.seed, 'erpInterface'), content, size);
  const planned = valueOf(await issuer.call(routes.execution.planBatch, { body: { familyId, markets: ['IN'], site: SITE, line: LINE, batchSize: size } }));
  await issueBatch(gmp, planned.batchId, { code: 'PRODUCTION_PLAN', text: 'Issued for the plan' });
  return { batchId: planned.batchId, batchNumber: planned.batchNumber };
}

/** The nominal entries of a library step (some sections' data changed), recorded by operator1. */
async function record(d: RunDriver, stepKey: string, item: { definition: library.BlockDefinition }, use: Json, over: Json = {}): Promise<void> {
  await d.ok('operator1', { type: 'START_STEP', stepKey });
  const units: Json = { vessel: VESSEL, wfiPoint: WFI_POINT };
  for (const e of library.nominalEntries(item.definition, use as never)) {
    const { kind, ...entry } = e;
    // The equipment facts are the server's (EBMR-API-SERVER-FILLED): the entry names the units by their codes only.
    const data: Json = Object.fromEntries(Object.entries(entry).filter(([k]) => k !== 'equipment' && k !== 'lots'));
    for (const k of Object.keys(data)) if (k in units) data[k] = units[k];
    await d.ok('operator1', libraryEntry(stepKey, kind, { ...data, ...(over[kind] as Json | undefined) }));
  }
}

async function signed(d: RunDriver, stepKey: string, stageKey: string): Promise<void> {
  await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey });
  await d.signed('verifier1', { type: 'VERIFY', stepKey, meaning: 'VERIFIED' });
  await d.signed('supervisor1', { type: 'SIGN_OFF_STAGE', stageKey });
}

/** The compounding of the batch, recorded and signed, with the overlay answer given. */
async function compounded(b: BatchRef, nitrogen: 'Applied' | 'Not required by the product'): Promise<RunDriver> {
  const d = await driverOf(gmp, b.batchId);
  await record(d, 'p-comp@', COMPOUND, COMPOUND_USE, { preparation: { nitrogen } });
  await signed(d, 'p-comp@', 'S-COMP@');
  return d;
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

/** The gas filter item of the lot's release view, and the authorised person's manufacturer release of the lot (its refusal, if any). */
async function gate(lotId: string): Promise<{ state: string; item: { status: string; problem: string | null } | undefined; refusal: string | null }> {
  const ap = await gmp.asPersona('qcuAuthoriser');
  const view = valueOf(await ap.call(routes.release.lot, { params: { lotId } }));
  const item = view.grel.items.find((i) => i.id === 'E.GAS_FILTER');
  const release = await signAction(gmp, ap, 'qcuAuthoriser', { kind: 'RELEASE_ACT', act: 'MANUFACTURER_RELEASE', lotId, input: { expectedEpoch: view.grel.epoch } });
  const refusal = release.ok ? null : `${refusalOf(release).code ?? ''} ${refusalOf(release).why ?? ''}`;
  return { state: view.state, item: item && { status: item.status, problem: item.problem ?? null }, refusal };
}

beforeAll(async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), 'ebmr-inj-gas-'));
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
  for (const def of [COMPOUND.definition, GAS.definition, OWN_COMPOUND, OWN_GAS]) {
    const { block } = valueOf(await author.call(routes.library.draft, { body: { definition: def as unknown as Json } }));
    await signAs(gmp, approver, 'approver', { kind: 'LIBRARY_ACT', act: 'BLOCK_APPROVE', subjectId: block.blockId });
  }
  await arrangeUnits();
  world = await gmpLifecycleWorld(gmp);
  procPlain = await world.approvedVersion(plain);
  await world.authorise({ versionId: procPlain.versionId, market: 'IN', kind: 'CURRENT', cells: [cell(SITE, LINE, SIZE_PLAIN)], regulatoryBasis: 'IN: registration on file (invented injectable)' });
  procGas = await world.approvedVersion(withFilter);
  await world.authorise({ versionId: procGas.versionId, market: 'IN', kind: 'CURRENT', cells: [cell(SITE, LINE, SIZE_GAS)], regulatoryBasis: 'IN: registration on file (invented injectable)' });
  procOwn = await world.approvedVersion(own);
  await world.authorise({ versionId: procOwn.versionId, market: 'IN', kind: 'CURRENT', cells: [cell(SITE, LINE, SIZE_GAS)], regulatoryBasis: 'IN: registration on file (invented injectable)' });
  for (const p of [PRODUCT, PRODUCT_OWN]) {
    await world.run(await actorOf(gmp, 'steward'), (c) =>
      c.query('select site.define_batch_number_rule($1::jsonb)', [JSON.stringify({ rule_code: `${p.code}-NUM`, site_code: SITE, product_code: p.code, batch_kind: 'PROCESSING', format: 'A{YY}{SEQ:5}', site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3' })]),
      reason('Injectables I-6 B5 numbering'),
    );
  }
}, 900_000);
afterAll(async () => {
  vi.useRealTimers();
  await gmp?.close();
});

describe('Injectables I-6 B5: an applied overlay needs its gas filter\'s passing post-use result for release (ST-28)', () => {
  it('[ST-28] a batch that applied the nitrogen overlay on a master with no gas filter step is not certifiable: E.GAS_FILTER is RED and the manufacturer release is refused with EBMR-REL-020 naming it', async () => {
    const b = await issued(plain, procPlain.familyId, SIZE_PLAIN);
    await compounded(b, 'Applied');
    const g = await gate(await lotOf(b));
    expect(g.state).toBe('NOT_READY');
    expect(g.item).toMatchObject({ status: 'RED' });
    expect(g.item?.problem).toMatch(/nitrogen overlay was applied and no post-use integrity test of its gas filter/);
    expect(g.refusal).toMatch(/EBMR-REL-020.*E\.GAS_FILTER: a nitrogen overlay was applied/);
  });

  it('[ST-28] a batch that applied the overlay whose gas filter post-use test is missing (the step not completed, no result) is not certifiable: E.GAS_FILTER is RED and the release is refused', async () => {
    const b = await issued(withFilter, procGas.familyId, SIZE_GAS);
    const d = await compounded(b, 'Applied');
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-gas@' });
    const g = await gate(await lotOf(b));
    expect(g.item).toMatchObject({ status: 'RED' });
    expect(g.item?.problem).toMatch(/post-use integrity test p-gas@ is IN_PROGRESS, not COMPLETED/);
    expect(g.refusal).toMatch(/EBMR-REL-020.*E\.GAS_FILTER/);
  });

  it('[ST-28] a failing post-use result of the overlay gas filter keeps the batch from certification even once QA has dispositioned its breach and the step is signed: E.GAS_FILTER is RED and the release is refused', async () => {
    const b = await issued(withFilter, procGas.familyId, SIZE_GAS);
    const d = await compounded(b, 'Applied');
    // Below its 1.00 bar limit: the database registers the critical breach, and the step waits for QA.
    await record(d, 'p-gas@', GAS, GAS.exampleUse, { gasFilter: { gasFilterPost: '0.80' } });
    const state = (await gmp.db.admin.query<{ s: { exceptions: Record<string, { type: string }> } }>('select state as s from recipe.execution_state where batch_id = $1', [b.batchId])).rows[0]!.s;
    const breach = Object.entries(state.exceptions).filter(([, x]) => x.type === 'LIB_LIMIT_BREACH').map(([id]) => id);
    expect(breach).toHaveLength(1);
    const qaInv = await gmp.asPersona('qaInvestigator');
    const dev = valueOf(await qaInv.call(routes.quality.raiseDeviation, { body: { kind: 'DEVIATION', title: `Overlay gas filter failed its post-use test in ${b.batchNumber}`, classification: 'MAJOR', riskRationale: 'The overlay gas may not have been sterile-filtered; sterility assurance to be assessed.' } }));
    valueOf(await qaInv.call(routes.quality.linkDeviation, { params: { deviationId: dev.deviationId }, body: { subjectKind: 'BATCH', subjectId: b.batchId } }));
    await d.ok('supervisor1', { type: 'ATTACH_DEVIATION', exception: breach[0] ?? '', deviationRef: dev.ref });
    await d.signed('qa1', { type: 'DISPOSITION_EXCEPTION', exception: breach[0] ?? '', outcome: 'DEVIATION_RAISED', justification: `Deviation ${dev.ref}: the batch is held until the investigation concludes` });
    await signed(d, 'p-gas@', 'S-GAS@');
    const g = await gate(await lotOf(b));
    expect(g.item).toMatchObject({ status: 'RED' });
    expect(g.item?.problem).toMatch(/post-use integrity result 0\.80 bar of p-gas@ does not pass its limit/);
    expect(g.refusal).toMatch(/EBMR-REL-020.*E\.GAS_FILTER: the overlay gas filter's post-use integrity result 0\.80/);
  });

  it('[ST-28] a batch that applied the overlay with a passing post-use result of its gas filter passes the item: E.GAS_FILTER is GREEN, and the release is no longer refused for it', async () => {
    const b = await issued(withFilter, procGas.familyId, SIZE_GAS);
    const d = await compounded(b, 'Applied');
    await record(d, 'p-gas@', GAS, GAS.exampleUse);
    await signed(d, 'p-gas@', 'S-GAS@');
    const g = await gate(await lotOf(b));
    expect(g.item).toMatchObject({ status: 'GREEN', problem: null });
    // The lot still waits for its QA review and its QC results (other items); none of the refusal is the gas filter's.
    expect(g.refusal ?? '').not.toMatch(/E\.GAS_FILTER/);
  });

  it('[ST-28] a batch with no overlay is unaffected: E.GAS_FILTER is NA on a master without the gas filter step, and the release is not refused for it', async () => {
    const b = await issued(plain, procPlain.familyId, SIZE_PLAIN);
    await compounded(b, 'Not required by the product');
    const g = await gate(await lotOf(b));
    expect(g.item).toMatchObject({ status: 'NA' });
    expect(g.refusal ?? '').not.toMatch(/E\.GAS_FILTER/);
  });

  it('[ST-28] the firm\'s own blocks gate release the same way, read by their marks and role, not by code: an overlay its compounding marks applied with its own filter test missing is RED and refused; with a passing result GREEN; with the overlay not used NA', async () => {
    const run = async (blanket: boolean, filter: 'missing' | 'passing'): Promise<Awaited<ReturnType<typeof gate>>> => {
      const b = await issued(own, procOwn.familyId, SIZE_GAS);
      const d = await driverOf(gmp, b.batchId);
      await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-mix@' });
      await d.ok('operator1', libraryEntry('p-mix@', 'mix', { mixedPerSop: true, blanket }));
      await signed(d, 'p-mix@', 'S-MIX@');
      await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-n2f@' });
      if (filter === 'passing') {
        await d.ok('operator1', libraryEntry('p-n2f@', 'after', { testPressure: '0.50', bp: '1.20' }));
        await signed(d, 'p-n2f@', 'S-N2F@');
      }
      return gate(await lotOf(b, PRODUCT_OWN));
    };
    const missing = await run(true, 'missing');
    expect(missing.item).toMatchObject({ status: 'RED' });
    expect(missing.item?.problem).toMatch(/post-use integrity test p-n2f@ is IN_PROGRESS, not COMPLETED/);
    expect(missing.refusal).toMatch(/EBMR-REL-020.*E\.GAS_FILTER/);
    const passing = await run(true, 'passing');
    expect(passing.item).toMatchObject({ status: 'GREEN', problem: null });
    expect(passing.refusal ?? '').not.toMatch(/E\.GAS_FILTER/);
    expect((await run(false, 'missing')).item).toMatchObject({ status: 'NA' });
  });
});
