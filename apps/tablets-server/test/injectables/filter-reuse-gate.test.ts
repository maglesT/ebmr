/**
 * Injectables I-6 B4 (IN-48): a sterilising filter reused on a later day without validation (SM Part II 6.11.2.8, A1
 * 8.94), over the routes with the seed's personas and real signatures. A processing master of one catalogue step,
 * INJ-STERILE-FILTER. The answers "not first used today" and "longer use not validated" raise the critical
 * LIB_UNEXPECTED_ANSWER: the database registers it with its facts (recipe.exception_register, 0440), refuses the step's
 * completion while it blocks (recipe.blocking_exceptions_problem, 0308), and the release gate stays RED while its
 * deviation is open (G2.DEVIATIONS), so the manufacturer release is refused (EBMR-REL-020, 0781).
 *
 * Arranged outside the routes, as the aseptic gate (aseptic-gate.test.ts): the product, the licence, the released filter
 * lot (test arrangement of the lot register), the ERP order and the numbering rule.
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
import type { ExecServer } from '../execution/support.ts';
import { actorOf, gmpContent, gmpLifecycleWorld } from '../support/gmp-world.ts';
import { confirmErpPending, signAction } from '../support/signed-acts.ts';
import { driverOf, issueBatch, libraryEntry, phaseOf, signAs, stage, type BatchRef, type Json } from '../substance/support.ts';

const SITE = 'SITE-1';
const LINE = 'L1';
const SIZE = 'BS-100K';
const TAG = randomUUID().slice(0, 6).toUpperCase();
const PRODUCT = { code: `INJFR-${TAG}`, name: 'Demoinj filtered 10 mg/2 mL vials', strength: '10 mg/2 mL' };
const REASON = 'Injectables I-6 B4 filter reuse';
const FILTER_LOT = `FLT-${TAG}`;

const FILTER = (() => {
  const item = INJECTABLE_ASEPTIC_SEEDS.find((s) => s.definition.code === 'INJ-STERILE-FILTER');
  if (!item) throw new Error('no INJ-STERILE-FILTER seed');
  return item;
})();

const processing: flow.MbrContent = gmpContent((m) => {
  const header = m['header'] as Json;
  header['family'] = `INJ-FR-${TAG}`;
  header['edition'] = 'injectables';
  header['recordKind'] = 'PROCESSING';
  header['title'] = `${PRODUCT.name}: sterilising filtration`;
  header['product'] = { code: PRODUCT.code, name: PRODUCT.name, strength: PRODUCT.strength, dosageForm: 'Injection' };
  delete header['unitMassMg'];
  const body = (m['procedure'] as Json)['body'] as Json;
  const like = (body['children'] as Json[])[0] as Json;
  body['children'] = [stage(like, 'S-FILTER', 'Sterilising filtration', [phaseOf(FILTER.definition, 'p-filter', FILTER.exampleUse)])];
  for (const k of ['parameters', 'calculations', 'yieldCheckpoints', 'timeConstraints', 'goldenCases', 'intermediates', 'riskReductions', 'inputs']) m[k] = [];
  m['blockDefinitions'] = [FILTER.definition];
});

let gmp: ExecServer;
let world: World;
let proc: { familyId: string; versionId: string };

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
async function issued(): Promise<BatchRef> {
  const issuer = await gmp.asPersona('issuer');
  await postOrder(gmp.db.app, await openServiceSession(gmp.db, gmp.seed, 'erpInterface'), processing, SIZE);
  const planned = valueOf(await issuer.call(routes.execution.planBatch, { body: { familyId: proc.familyId, markets: ['IN'], site: SITE, line: LINE, batchSize: SIZE } }));
  await issueBatch(gmp, planned.batchId, { code: 'PRODUCTION_PLAN', text: 'Issued for the plan' });
  return { batchId: planned.batchId, batchNumber: planned.batchNumber };
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

beforeAll(async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), 'ebmr-inj-filter-'));
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
  const { block } = valueOf(await author.call(routes.library.draft, { body: { definition: FILTER.definition as unknown as Json } }));
  await signAs(gmp, approver, 'approver', { kind: 'LIBRARY_ACT', act: 'BLOCK_APPROVE', subjectId: block.blockId });
  await arrangeFilterLot();
  world = await gmpLifecycleWorld(gmp);
  proc = await world.approvedVersion(processing);
  await world.authorise({ versionId: proc.versionId, market: 'IN', kind: 'CURRENT', cells: [cell(SITE, LINE, SIZE)], regulatoryBasis: 'IN: registration on file (invented injectable)' });
  await world.run(await actorOf(gmp, 'steward'), (c) =>
    c.query('select site.define_batch_number_rule($1::jsonb)', [JSON.stringify({ rule_code: `INJFR-${TAG}`, site_code: SITE, product_code: PRODUCT.code, batch_kind: 'PROCESSING', format: 'A{YY}{SEQ:5}', site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3' })]),
    reason('Injectables I-6 B4 numbering'),
  );
}, 900_000);
afterAll(async () => {
  vi.useRealTimers();
  await gmp?.close();
});

describe('Injectables I-6 B4: the sterilising filtration holds the batch (IN-48)', () => {
  it('[IN-48] a failing post-use integrity result holds the batch: the database judges it against the formulation\'s limit and registers the breach with its deviation required; the step cannot be completed, the lot is NOT_READY and the manufacturer release is refused', async () => {
    const b = await issued();
    const d = await driverOf(gmp, b.batchId);
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-filter@' });
    for (const e of library.nominalEntries(FILTER.definition, FILTER.exampleUse as never)) {
      const { kind, ...entry } = e;
      const data: Json = Object.fromEntries(Object.entries(entry).filter(([k]) => k !== 'lots' && k !== 'extendedUseValidated' && k !== 'validationRef'));
      // First used today; after use the bubble point is below its 3.20 bar limit.
      const over: Json = kind === 'filter' ? { filterLot: FILTER_LOT, firstUseToday: true } : kind === 'postUse' ? { postBubblePoint: '3.10' } : {};
      await d.ok('operator1', libraryEntry('p-filter@', kind, { ...data, ...over }));
    }
    const { rows } = await gmp.db.admin.query<{ dev: boolean }>(
      "select deviation_required as dev from recipe.exception_register where batch_id = $1 and exception_type = 'LIB_LIMIT_BREACH'",
      [b.batchId],
    );
    expect(rows).toEqual([{ dev: true }]);
    const refused = await d.sign('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-filter@' });
    expect(refused.result.ok).toBe(false);
    const lotId = await lotOf(b);
    const ap = await gmp.asPersona('qcuAuthoriser');
    const view = valueOf(await ap.call(routes.release.lot, { params: { lotId } }));
    expect(view.state).toBe('NOT_READY');
    const release = await signAction(gmp, ap, 'qcuAuthoriser', { kind: 'RELEASE_ACT', act: 'MANUFACTURER_RELEASE', lotId, input: { expectedEpoch: view.grel.epoch } });
    expect(release.ok).toBe(false);
    expect(refusalOf(release)?.code ?? '').toMatch(/EBMR-REL-020/);
  });

  it('[IN-48] a filter not first used today whose longer use is not validated raises a critical exception the database registers; the step cannot be completed, and while its deviation is open the lot is NOT_READY and the manufacturer release is refused', async () => {
    const b = await issued();
    const d = await driverOf(gmp, b.batchId);
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-filter@' });
    const reuse: Json = { filterLot: FILTER_LOT, firstUseToday: false, extendedUseValidated: false };
    for (const e of library.nominalEntries(FILTER.definition, FILTER.exampleUse as never)) {
      const { kind, ...entry } = e;
      const data: Json = Object.fromEntries(Object.entries(entry).filter(([k]) => k !== 'lots' && k !== 'validationRef'));
      await d.ok('operator1', libraryEntry('p-filter@', kind, kind === 'filter' ? { ...data, ...reuse } : data));
    }
    // The database's register holds the exception with the facts it was raised with (0440).
    const { rows } = await gmp.db.admin.query<{ id: string; severity: string; qa: boolean; dev: boolean; rel: boolean }>(
      `select exception_id as id, severity, qa_only as qa, deviation_required as dev, release_blocking as rel
         from recipe.exception_register where batch_id = $1 and exception_type = 'LIB_UNEXPECTED_ANSWER'`,
      [b.batchId],
    );
    expect(rows.map(({ severity, qa, dev, rel }) => ({ severity, qa, dev, rel }))).toEqual([{ severity: 'CRITICAL', qa: true, dev: true, rel: true }]);
    const exceptionId = rows[0]?.id ?? '';
    // The step cannot be signed while the exception blocks it.
    const refused = await d.sign('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-filter@' });
    expect(refused.result.ok).toBe(false);
    const lotId = await lotOf(b);
    const ap = await gmp.asPersona('qcuAuthoriser');
    const before = valueOf(await ap.call(routes.release.lot, { params: { lotId } }));
    expect(before.state).toBe('NOT_READY');
    // QA links a deviation and dispositions the exception; the step completes, but the deviation stays open.
    const qaInv = await gmp.asPersona('qaInvestigator');
    const dev = valueOf(await qaInv.call(routes.quality.raiseDeviation, { body: { kind: 'DEVIATION', title: `Sterilising filter reused without validation in ${b.batchNumber}`, classification: 'CRITICAL', riskRationale: 'A filter used beyond one working day without validated extended use; sterility assurance to be assessed.' } }));
    valueOf(await qaInv.call(routes.quality.linkDeviation, { params: { deviationId: dev.deviationId }, body: { subjectKind: 'BATCH', subjectId: b.batchId } }));
    await d.ok('supervisor1', { type: 'ATTACH_DEVIATION', exception: exceptionId, deviationRef: dev.ref });
    await d.signed('qa1', { type: 'DISPOSITION_EXCEPTION', exception: exceptionId, outcome: 'DEVIATION_RAISED', justification: `Deviation ${dev.ref}: the batch is held until the investigation concludes` });
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-filter@' });
    await d.signed('verifier1', { type: 'VERIFY', stepKey: 'p-filter@', meaning: 'VERIFIED' });
    await d.signed('supervisor1', { type: 'SIGN_OFF_STAGE', stageKey: 'S-FILTER@' });
    const view = valueOf(await ap.call(routes.release.lot, { params: { lotId } }));
    const items = Object.fromEntries(view.grel.items.map((i) => [i.id, { status: i.status, problem: i.problem ?? null }]));
    expect(view.state).toBe('NOT_READY');
    expect(items['G2.DEVIATIONS']).toMatchObject({ status: 'RED' });
    expect(items['G2.DEVIATIONS']?.problem).toContain(dev.ref);
    // The authorised person's release is refused by the database's gate (0781, EBMR-REL-020).
    const release = await signAction(gmp, ap, 'qcuAuthoriser', { kind: 'RELEASE_ACT', act: 'MANUFACTURER_RELEASE', lotId, input: { expectedEpoch: view.grel.epoch } });
    expect(release.ok).toBe(false);
    expect(refusalOf(release)?.code ?? '').toMatch(/EBMR-REL-020/);
  });
});
