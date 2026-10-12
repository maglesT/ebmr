/**
 * After release in the database (Phase 4 slice 5a; recipe-core 0840, site services 0880 and 0881; outline 5.2.6 "After
 * release" and "Rejected lots"; L-19, IN-29, PR-46, IN-05 (e), INV-39, INV-05, INV-35; defaults D-5-1 to D-5-6, D-5a-1 to
 * D-5a-9): the automatic suspension of every decided market of a released lot and of the released lots downstream of it
 * (PR-57 genealogy) when a cause links after release, with the ERP stock block and the AP's recall-assessment task in the
 * same transaction; the AP's re-confirmation, recall and rejection after release; the disposal of a rejected or recalled
 * lot with its independent witness. Every act runs as the application role through the definers with real e-signatures
 * of seeded people, and each rule is also tried around (direct writes, another person's signature, the wrong role, a
 * stale evaluation).
 *
 * The evidence is built as in dispositions.test.ts: GMP batches issued from an effective master, reviewed through the
 * real review acts, the finished lot posted by the edition's definer, its release result approved by the head of QC and
 * its reserve sample; a test edition answers groups 4, 9 and 10. Lot consumption (the genealogy edge) is a fixture, as in
 * review.test.ts.
 */
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withProtectedNumbers } from '../../../kernel/src/continuity/numbers.ts';
import { tempDir, tempLedger } from '../../../kernel/test/continuity/helpers.ts';
import { withCommand } from '../../../kernel/src/db/command.ts';
import { createChallenge, contentForSigning, sign } from '../../../kernel/src/esig/signing.ts';
import { challengeFor, cmd, ensureSealKey, signatureAuth, signWith, testSealKey } from '../../../kernel/test/esig/helpers.ts';
import { signFor } from '../../../kernel/test/records/helpers.ts';
import { seedActor, seedAdministration, seedServiceActor, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import type { MbrContent } from '../../src/flow/model.ts';
import * as execution from '../../src/execution/index.ts';
import type * as lc from '../../src/lifecycle/index.ts';
import { define, FIXTURE_INPUTS, FIXTURE_JUSTIFICATIONS } from '../engine/support.ts';
import { gmpOrderFor } from '../lifecycle/gmp-support.ts';
import { cell, reason, seedCast, uniqueContent, World } from '../lifecycle/support.ts';
import { investigateDeviation } from '../../../site-services/test/quality/deviation-path.ts';
import { assessIncidentImpact, raiseIncident } from '../../../kernel/src/records/incidents.ts';

let db: TestDatabase;
let w: World;
let steward: SeededActor;
let operator: SeededActor;
let head: SeededActor;
let qaReviewer: SeededActor;
let qaReviewer2: SeededActor;
let qaReviewer3: SeededActor;
let ap: SeededActor;
let analyst: SeededActor;
let qcHead: SeededActor;
let warehouse: SeededActor;
let qcu: SeededActor;
let erp: SeededActor;
let qaFloor: SeededActor;
let admin: SeededActor;
type Master = { familyId: string; versionId: string; content: MbrContent };
let all: Master;
const dir = tempDir('after-release');
const ledger = tempLedger('after-release', dir.path);

const SITE = 'SITE-1';
const BS = 'BS-200K';
const FIXTURE = 'tablet-granulation-compression';
const ALL = ['EU', 'IN', 'US'];
type Market = 'IN' | 'US' | 'EU';
interface Item {
  id: string;
  group: string;
  status: 'GREEN' | 'RED' | 'NA';
  problem: string | null;
  since_review: boolean;
}
interface Grel {
  epoch: string;
  ready: boolean;
  items: Item[];
}
interface Lot {
  batchId: string;
  lotId: string;
  lotCode: string;
  batchNumber: string;
  productCode: string;
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    const m = /\b(EBMR-[A-Z]+-\d{3})\b/.exec(e instanceof Error ? e.message : String(e));
    return m?.[1] ?? (e instanceof Error ? e.message : String(e));
  }
}

function without(content: unknown, types: readonly string[]): unknown {
  if (Array.isArray(content)) {
    return content.filter((x) => !(x && typeof x === 'object' && types.includes(String(((x as Record<string, unknown>)['block'] as Record<string, unknown> | undefined)?.['type'])))).map((x) => without(x, types));
  }
  if (content && typeof content === 'object') return Object.fromEntries(Object.entries(content).map(([k, v]) => [k, without(v, types)]));
  return content;
}

async function effective(markets: Market[], dosageForm?: string): Promise<Master> {
  const m = uniqueContent(FIXTURE, ALL);
  m.header.product = { ...m.header.product, code: m.header.product.code.toUpperCase(), ...(dosageForm ? { dosageForm } : {}) };
  const content = without(m, ['G-09', 'G-10']) as MbrContent;
  const v = await w.approvedVersion(content);
  for (const market of markets) {
    const def: lc.MarketAuthorisationDefinition = { versionId: v.versionId, market, kind: 'CURRENT', cells: [cell(SITE, 'L1', BS)], regulatoryBasis: `${market}: registration on file` };
    await w.authorise(def);
  }
  await w.run(steward, (c) =>
    c.query('select site.define_batch_number_rule($1::jsonb)', [
      JSON.stringify({ rule_code: `R-${randomUUID().slice(0, 8).toUpperCase()}`, site_code: SITE, product_code: content.header.product.code, batch_kind: 'PROCESSING', format: 'R{YY}{SEQ:5}', site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3' }),
    ]),
  );
  return { familyId: v.familyId, versionId: v.versionId, content };
}

async function issuedBatch(m: Master, markets: string[]): Promise<string> {
  const batchId = randomUUID();
  const erpOrder = await gmpOrderFor(db, erp, m.content, BS);
  await cmd(db, w.cast.issuer).then((ctx) =>
    withProtectedNumbers(db.app, ctx, ledger, (c) => execution.prepareGmpIssue(c, batchId, { familyId: m.familyId, markets, site: SITE, line: 'L1', batchSize: BS, erpOrder })),
  );
  const signatureId = await w.sign(w.cast.issuer, 'batch_issue', batchId, 'ISSUED', 'PLANNED');
  await w.run(
    w.cast.issuer,
    (c) =>
      execution.issueGmpBatch(c, {
        batchId,
        signatureId,
        define: (x) => define(x, { installation: 'GMP', justifications: FIXTURE_JUSTIFICATIONS }),
        request: { inputs: FIXTURE_INPUTS[FIXTURE], issuedBy: { id: w.cast.issuer.personId, kind: 'PERSON', roles: [] } },
      }),
    reason('batch issued for the test'),
  );
  return batchId;
}

async function review(b: string): Promise<void> {
  await db.admin.query("update recipe.execution_state set status = 'EXECUTION_COMPLETE' where batch_id = $1", [b]);
  const approval = await w.sign(head, 'batch_review', b, 'PRODUCTION_APPROVED', 'EXECUTION_COMPLETE');
  await w.run(head, (c) => c.query('select recipe.record_production_approval($1, $2)', [b, approval]));
  const id = (await db.app.query<{ id: string }>('select recipe.audit_review_next_id($1) as id', [b])).rows[0]!.id;
  const at = await w.sign(qaReviewer, 'batch_audit_review', id, 'AUDIT_TRAIL_REVIEWED', 'PRODUCTION_APPROVED');
  await w.run(qaReviewer, (c) => c.query('select recipe.record_audit_trail_review($1, $2)', [id, at]));
  const qa = await w.sign(qaReviewer2, 'batch_review', b, 'QA_REVIEWED', 'PRODUCTION_APPROVED');
  const epoch = (await db.app.query<{ e: string }>("select recipe.epoch_of('BATCH', $1)::text as e", [b])).rows[0]!.e;
  await w.run(qaReviewer2, (c) => c.query('select recipe.record_qa_review($1, $2, $3)', [b, qa, epoch]));
}


async function finishedLot(b: string, m: Master, markets: string[]): Promise<string> {
  const number = (await db.app.query<{ n: string }>('select batch_number as n from recipe.batch_execution where id = $1', [b])).rows[0]!.n;
  return withCommand(db.admin, await cmd(db, warehouse), async (c) =>
    (await c.query<{ id: string }>('select site.create_finished_lot($1::jsonb) as id', [
      JSON.stringify({ batchId: b, batchNumber: number, edition: 'TABLETS', siteCode: SITE, productCode: m.content.header.product.code, productName: 'Disposition test product',
                       strength: '500 mg', markets, quantity: '1000', unit: 'units', expiresAt: '2029-06-30T23:59:59Z' }),
    ])).rows[0]!.id,
  );
}

async function sqlAs<T>(who: SeededActor, text: string, params: unknown[] = []): Promise<T> {
  return w.run(who, async (c) => ((await c.query(text, params)).rows[0] as { r: T } | undefined)?.r as T);
}

async function result(lotId: string, testCode: string, value: string): Promise<void> {
  const r = await sqlAs<{ resultId: string }>(analyst, 'select site.record_lot_test_result($1, $2::jsonb) as r', [lotId, JSON.stringify({ testCode, purpose: 'RELEASE', value })]);
  const sig = await signFor(db, qcHead, { type: 'lot_test_result', id: r.resultId }, 'QC_RESULT_APPROVED', 'RECORDED');
  await w.run(qcHead, (c) => c.query('select site.approve_lot_test_result($1, $2)', [r.resultId, sig]));
}

async function readyLot(m: Master = all, markets: string[] = ALL, lotMarkets: string[] = markets): Promise<Lot> {
  const batchId = await issuedBatch(m, markets);
  await review(batchId);
  const lotId = await finishedLot(batchId, m, lotMarkets);
  await result(lotId, 'ASSAY', '99.5');
  await w.run(analyst, (c) => c.query('select site.pull_lot_sample($1, $2::jsonb)', [lotId, JSON.stringify({ kind: 'RESERVE', quantity: '80', container: 'Marketed blister in carton', storageLocation: 'Reserve room R-2' })]));
  const { rows } = await db.app.query<{ c: string; n: string }>('select l.lot_code as c, b.batch_number as n from site.material_lot l, recipe.batch_execution b where l.id = $1 and b.id = $2', [lotId, batchId]);
  return { batchId, lotId, lotCode: rows[0]!.c, batchNumber: rows[0]!.n, productCode: m.content.header.product.code };
}

const grel = async (lotId: string, market: Market): Promise<Grel> => (await db.app.query<{ g: Grel }>('select recipe.grel_evaluate($1, $2) as g', [lotId, market])).rows[0]!.g;
const red = (g: Grel): string[] => g.items.filter((i) => i.status === 'RED').map((i) => i.id);
const state = async (lotId: string, market: Market): Promise<string | null> => (await db.app.query<{ s: string | null }>('select recipe.disposition_state($1, $2) as s', [lotId, market])).rows[0]!.s;

async function acknowledgeAll(who: SeededActor, lotId: string, market: Market, g: Grel): Promise<void> {
  for (const i of g.items.filter((x) => x.since_review)) {
    await w.run(who, (c) => c.query('select recipe.acknowledge_release_item($1, $2, $3, $4)', [lotId, market, i.id, g.epoch]));
  }
}

async function signAs(who: SeededActor, type: string, id: string, meaning: string, expectedState: string | null): Promise<string> {
  const ch = await challengeFor(db, who, id, { meaning, aggregateType: type });
  const ev = await signatureAuth(db, who, who, ch.challengeId);
  return (await signWith(db, who, ch.challengeId, ev, { expectedState })).signatureId;
}

async function manufacturerRelease(lot: Lot): Promise<void> {
  const g = await grel(lot.lotId, 'IN');
  expect(red(g)).toEqual([]);
  await acknowledgeAll(ap, lot.lotId, 'IN', g);
  const sig = await signAs(ap, 'manufacturer_release', `${lot.lotId}/RELEASE`, 'MANUFACTURER_RELEASE', 'READY');
  await w.run(ap, (c) => c.query("select recipe.record_manufacturer_release($1, 'RELEASE', $2, $3, null)", [lot.lotId, sig, g.epoch]));
}

/**
 * As the server's ceremony does it: the challenge and the authentication first, then one command that signs and runs the
 * act with the signature; a refused act rolls the signature back with it.
 */
async function signed<T = unknown>(who: SeededActor, type: string, id: string, meaning: string, expectedState: string | null, act: (c: pg.PoolClient, sig: string) => Promise<T>): Promise<T> {
  await ensureSealKey(db);
  const content = await contentForSigning(db.app, type, id);
  const ch = await withCommand(db.app, await cmd(db, who), (c) => createChallenge(c, { aggregateType: type, aggregateId: id, contentVersion: content.contentVersion ?? '1', meaning, clientContentHash: content.contentHash ?? '' }));
  const ev = await signatureAuth(db, who, who, ch.challengeId);
  return withCommand(db.app, await cmd(db, who), async (c) => act(c, (await sign(c, { challengeId: ch.challengeId, authEventId: ev, expectedState }, testSealKey)).signatureId));
}

const usAct = async (who: SeededActor, lotId: string, decision: 'RELEASE' | 'REJECT', epoch: string, why: string | null = null, deviation: string | null = null): Promise<unknown> =>
  signed(who, 'us_disposition', `${lotId}/${decision}`, 'US_DISPOSITION', await state(lotId, 'US'), (c, sig) =>
    c.query('select recipe.record_us_disposition($1, $2, $3, $4, $5, $6)', [lotId, decision, sig, epoch, why, deviation]));

async function productAndSpecification(content: MbrContent, extraTests: { testCode: string; lowerLimit: string; upperLimit: string }[] = []): Promise<void> {
  const product = content.header.product;
  const productVersion = await withCommand(db.app, { ...erp, correlationId: randomUUID() }, async (c) =>
    (await c.query<{ id: string }>('select site.erp_receive_product($1::jsonb) as id', [
      JSON.stringify({ productCode: product.code, strength: '500 mg', productName: 'Disposition test product', betaLactam: false, shelfLifeMonths: 24, erpReference: 'ERP-DSP' }),
    ])).rows[0]!.id,
  );
  const { rows } = await db.app.query<{ s: string }>("select site.erp_master_state('PRODUCT', $1) as s", [productVersion]);
  if (rows[0]?.s === 'PENDING') {
    const confirmation = await signFor(db, w.cast.qa, { type: 'erp_master', id: `PRODUCT/${productVersion}` }, 'ERP_MASTER_CONFIRMED', 'PENDING');
    await w.run(w.cast.qa, (c) => c.query("select site.confirm_erp_master('PRODUCT', $1, $2)", [productVersion, confirmation]));
  }
  const spec = await sqlAs<{ specificationId: string }>(analyst, 'select site.draft_specification($1::jsonb) as r', [
    JSON.stringify({ materialCode: product.code, title: 'Finished product specification', monographReference: 'IP 2022 monograph', tests: [
      { testCode: 'ASSAY', methodReference: 'STP-AS', unit: '%', lowerLimit: '95.0', upperLimit: '105.0', required: true, pharmacopoeia: 'IP', edition: '2022', sampleQuantity: '20', sampleUnit: 'units' },
      ...extraTests.map((t) => ({ ...t, methodReference: 'STP-RR', unit: '%', required: false, pharmacopoeia: 'USP', edition: '2025', sampleQuantity: '12', sampleUnit: 'units' })),
    ] }),
  ]);
  const specSig = await signFor(db, qcHead, { type: 'specification', id: spec.specificationId }, 'SPECIFICATION_APPROVED', 'DRAFT');
  await w.run(qcHead, (c) => c.query('select site.approve_specification($1, $2)', [spec.specificationId, specSig]));
}

beforeAll(async () => {
  db = await createTestDatabase();
  w = new World(db, await seedCast(db));
  ({ admin } = await seedAdministration(db));
  steward = await seedActor(db, { roleCode: 'MASTER_DATA_STEWARD', legalName: 'Mira Steward' });
  operator = await seedActor(db, { roleCode: 'OPERATOR', legalName: 'Om Operator', roomCode: 'DISP-01' });
  head = await seedActor(db, { roleCode: 'HEAD_OF_PRODUCTION', legalName: 'Hari Head' });
  qaReviewer = await seedActor(db, { roleCode: 'QA_REVIEWER', legalName: 'Rhea Reviewer' });
  qaReviewer2 = await seedActor(db, { roleCode: 'QA_REVIEWER', legalName: 'Ravi Reviewer' });
  qaReviewer3 = await seedActor(db, { roleCode: 'QA_REVIEWER', legalName: 'Rani Reviewer' });
  ap = await seedActor(db, { roleCode: 'AUTHORISED_PERSON', legalName: 'Anita Authorised' });
  analyst = await seedActor(db, { roleCode: 'QC_ANALYST', legalName: 'Asha Analyst' });
  qcHead = await seedActor(db, { roleCode: 'HEAD_OF_QC', legalName: 'Hema QC-Head' });
  warehouse = await seedActor(db, { roleCode: 'WAREHOUSE_LABELLING', legalName: 'Wasim Warehouse' });
  qcu = await seedActor(db, { roleCode: 'US_QCU_SIGNER', legalName: 'Quinn Quality-Unit' });
  qaFloor = await seedActor(db, { roleCode: 'QA_SHOP_FLOOR', legalName: 'Meera Floor' });
  erp = await seedServiceActor(db, { kind: 'INTEGRATION', source: 'INTEGRATION', roleCode: 'ERP_INTERFACE', name: 'ERP interface' });
  all = await effective(['IN', 'US', 'EU']);
  await productAndSpecification(all.content);

  // A test edition: it answers groups 4, 9 and 10 (the Tablets items are slice 3b's).
  const fx = await db.admin.connect();
  try {
    await fx.query('begin');
    await fx.query('select kernel.set_actor_context($1::jsonb)', [JSON.stringify({
      person_id: '00000000-0000-0000-0000-000000000000', account_id: '00000000-0000-0000-0000-000000000000', role_code: 'TEST_FIXTURE',
      session_id: '00000000-0000-0000-0000-000000000000', source: 'SYSTEM', site_zone: 'UTC', correlation_id: randomUUID(), legal_name: 'Test fixture',
      reason_code: 'TEST_FIXTURE', reason_text: 'a test edition of the release gate' })]);
    await fx.query('create schema test_edition');
    await fx.query(`create function test_edition.grel_items(p_lot uuid, p_market text) returns jsonb language sql stable as $$
      select jsonb_build_array(
        jsonb_build_object('id', 'E.RECONCILIATION', 'group', '4', 'title', 'Reconciliation within limits', 'status', 'GREEN', 'problem', null, 'evidence', '[]'::jsonb, 'since_review', false),
        jsonb_build_object('id', 'E.PACK_EXAMINATION', 'group', '9', 'title', 'Finished-pack examination', 'status', 'GREEN', 'problem', null, 'evidence', '[]'::jsonb, 'since_review', false))
    $$`);
    await fx.query('grant usage, create on schema test_edition to ebmr_owner');
    await fx.query('grant usage on schema test_edition to ebmr_app');
    await fx.query("select recipe.register_grel_edition_hook('TABLETS', 'test_edition.grel_items(uuid, text)')");
    await fx.query('commit');
  } catch (error) {
    await fx.query('rollback');
    throw error;
  } finally {
    fx.release();
  }
}, 900_000);

afterAll(async () => {
  await db.drop();
  dir.cleanup();
});


// ---------------------------------------------------------------------------------------------------------------------
// Slice 5a helpers
// ---------------------------------------------------------------------------------------------------------------------

const pathDriver = {
  run: <T>(who: SeededActor, work: (c: pg.PoolClient) => Promise<T>) => w.run(who, work),
  sign: (who: SeededActor, aggregate: { type: string; id: string }, meaning: string, expectedState: string) => signFor(db, who, aggregate, meaning, expectedState),
};

async function usRelease(lot: Lot): Promise<void> {
  const g = await grel(lot.lotId, 'US');
  expect(red(g)).toEqual([]);
  await acknowledgeAll(qcu, lot.lotId, 'US', g);
  await usAct(qcu, lot.lotId, 'RELEASE', g.epoch);
}

async function deviationOn(kind: 'LOT' | 'BATCH', id: string, title = 'Found after release'): Promise<string> {
  const d = await sqlAs<{ deviationId: string }>(operator, 'select site.raise_deviation($1::jsonb) as r', [
    JSON.stringify({ kind: 'DEVIATION', title, classification: 'MAJOR', riskRationale: 'Assessed for every market of the lot' }),
  ]);
  await w.run(operator, (c) => c.query('select site.link_deviation($1, $2, $3)', [d.deviationId, kind, id]));
  return d.deviationId;
}

async function closeDeviation(deviationId: string, markets: Market[], impact: 'NONE' | 'CONFIRMED' = 'NONE'): Promise<void> {
  await investigateDeviation(pathDriver, deviationId, { classifier: qaReviewer, owner: qaReviewer, assessor: qaReviewer2, concluder: qaReviewer2, closer: qaReviewer3 }, {
    finding: { assignableCause: true, cause: 'A gasket wore out between two maintenance checks', rootCauseCategory: 'EQUIPMENT' },
    markets,
    impact,
    close: true,
  });
}

/** TEST FIXTURE (as in review.test.ts): a lot consumed by a batch, as the guarded consumption records it (proven in site services). */
async function consumed(lotId: string, batchId: string, material: string): Promise<void> {
  const resId = randomUUID();
  const fx = await db.admin.connect();
  try {
    await fx.query('begin');
    await fx.query("set local session_replication_role = 'replica'");
    await fx.query(`insert into site.lot_reservation (id, lot_id, batch_id, batch_number, edition, quantity, unit, expires_at, lot_state_version, reserved_by_person, reserved_by_account)
                    select $1, $2, b.id, b.batch_number, 'TABLETS', 1, 'kg', now() + interval '1 day', 2, $3, $3 from recipe.batch_execution b where b.id = $4`,
                   [resId, lotId, randomUUID(), batchId]);
    await fx.query(`insert into site.lot_consumption (lot_id, reservation_id, batch_id, batch_number, edition, material_code, quantity, unit, quantity_before, quantity_after, market_set,
                                                      identity_basis, consumed_by_person, consumed_by_account, xact_id)
                    select $1, $2, b.id, b.batch_number, 'TABLETS', $3, 1, 'kg', 10, 9, b.market_set, 'IDENTITY_RESULT', $4, $4, txid_current() from recipe.batch_execution b where b.id = $5`,
                   [lotId, resId, material, randomUUID(), batchId]);
    await fx.query('commit');
  } finally {
    fx.release();
  }
}

/** TEST FIXTURE: a received API lot (site services' receipt is proven there). */
async function apiLot(): Promise<string> {
  const lotId = randomUUID();
  const fx = await db.admin.connect();
  try {
    await fx.query('begin');
    await fx.query("set local session_replication_role = 'replica'");
    await fx.query(`insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, received_quantity, unit, expires_at,
                                                   received_by_person, received_by_account, correlation_id)
                    values ($1, 'SITE-1', $2, 'API-FX', 'Fixture API', 'API', 10, 'kg', '2030-01-01T00:00:00Z', $3, $3, $3)`,
                   [lotId, `L-${lotId.slice(0, 8).toUpperCase()}`, randomUUID()]);
    await fx.query('commit');
  } finally {
    fx.release();
  }
  return lotId;
}

const nextId = async (lotId: string, market: Market, act: string): Promise<string> =>
  (await db.app.query<{ a: string }>('select recipe.release_suspension_next_id($1, $2, $3) as a', [lotId, market, act])).rows[0]!.a;
const marketState = async (lotId: string, market: Market): Promise<string | null> =>
  market === 'IN' ? (await db.app.query<{ s: string }>('select recipe.manufacturer_release_state($1) as s', [lotId])).rows[0]!.s : state(lotId, market);
const lotRegister = async (lotId: string): Promise<string> => (await db.admin.query<{ s: string }>("select state as s from platform.aggregate_state where aggregate_type = 'material_lot' and aggregate_id = $1", [lotId])).rows[0]!.s;

/** An after-release act as the server's ceremony runs it: sign the record now, run the act with the signature. */
async function afterAct(who: SeededActor, lotId: string, market: Market, act: 'RECONFIRM' | 'RECALL' | 'REJECT_AFTER_RELEASE', text: string | null, epoch: string | null = null): Promise<string> {
  const aid = await nextId(lotId, market, act);
  const meaning = act === 'RECONFIRM' ? 'RELEASE_RECONFIRMED' : act === 'RECALL' ? 'RECALLED' : 'REJECTED_AFTER_RELEASE';
  return signed(who, 'release_suspension', aid, meaning, await marketState(lotId, market), async (c, sig) =>
    (await c.query<{ id: string }>('select recipe.record_after_release_decision($1, $2, $3, $4, $5, $6) as id', [lotId, market, act, sig, epoch, text])).rows[0]!.id);
}

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
interface Disposal { route: string; quantity: string; returnTo?: string; reference?: string; reprocessing?: string; text?: string }
const disposalId = (lotId: string, d: Disposal): string =>
  `${lotId}/${sha([d.route, d.quantity, d.returnTo ?? '', d.reference ?? '', d.reprocessing ?? '', d.text ?? ''].map((x) => x.trim()).join('\n'))}`;

async function dispose(who: SeededActor, lotId: string, d: Disposal): Promise<string> {
  const aid = disposalId(lotId, d);
  const st = (await db.app.query<{ s: string }>("select case when recipe.disposal_problem($1) is null then 'DISPOSABLE' else recipe.manufacturer_release_state($1) end as s", [lotId])).rows[0]!.s;
  return signed(who, 'disposal', aid, 'DISPOSAL_RECORDED', st, async (c, sig) =>
    (await c.query<{ id: string }>('select recipe.record_disposal($1, $2, $3, $4, $5, $6, $7, $8) as id', [
      lotId, d.route, d.quantity, d.returnTo ?? null, d.reference ?? null, d.reprocessing ?? null, d.text ?? null, sig,
    ])).rows[0]!.id);
}

async function witness(who: SeededActor, disposal: string): Promise<void> {
  const aid = (await db.app.query<{ a: string }>('select aggregate_id as a from recipe.lot_disposal where id = $1', [disposal])).rows[0]!.a;
  await signed(who, 'disposal', aid, 'DESTRUCTION_WITNESSED', 'AWAITING_WITNESS', (c, sig) => c.query('select recipe.witness_disposal($1, $2)', [disposal, sig]));
}

const suspensions = async (lotId: string) =>
  (await db.app.query<{ market: string; cause_kind: string; via_kind: string; prior_state: string }>(
    'select market, cause_kind, via_kind, prior_state from recipe.release_suspension where lot_id = $1 order by market collate "C", cause_kind', [lotId])).rows;
const openTasks = async (lotId: string, kind = 'RECALL_ASSESSMENT') =>
  (await db.app.query<{ owner_role: string }>(
    'select t.owner_role from recipe.release_task t where t.lot_id = $1 and t.kind = $2 and not exists (select 1 from recipe.release_task_closure c where c.task_id = t.id)', [lotId, kind])).rows;
const blocks = async (lotId: string) =>
  (await db.app.query<{ kind: string; cause_key: string }>('select kind, cause_key from site.erp_stock_block_request where lot_id = $1 order by requested_at, kind', [lotId])).rows;

// ---------------------------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------------------------

describe('suspension after release (outline 5.2.6; L-19, IN-29, INV-39; D-5-1 to D-5-3)', () => {
  it('[L-19][IN-29][INV-39] a deviation linked upstream of released lots suspends every decided market of each, in the linking transaction, with the ERP block and the AP\'s task; a lot not yet released only gets the link', async () => {
    const released = await readyLot(all, ['IN', 'US']);
    await manufacturerRelease(released);
    await usRelease(released);
    const unreleased = await readyLot(all, ['IN', 'US']);
    expect(await marketState(unreleased.lotId, 'IN')).toBe('READY');
    const api = await apiLot();
    await consumed(api, released.batchId, 'API-FX');
    await consumed(api, unreleased.batchId, 'API-FX');
    expect(await suspensions(released.lotId)).toEqual([]);

    // The deviation on the API lot (two levels upstream of the finished lot) suspends IN and US of the released lot.
    await deviationOn('LOT', api, 'API lot contaminated');
    expect(await marketState(released.lotId, 'IN')).toBe('RELEASE_SUSPENDED');
    expect(await marketState(released.lotId, 'US')).toBe('RELEASE_SUSPENDED');
    expect(await suspensions(released.lotId)).toEqual([
      { market: 'IN', cause_kind: 'DEVIATION', via_kind: 'LOT', prior_state: 'RELEASED' },
      { market: 'US', cause_kind: 'DEVIATION', via_kind: 'LOT', prior_state: 'RELEASED' },
    ]);
    // The decisions stay as signed (D-5-2); the lot register still says RELEASED, but the shipping interlock reads the states.
    expect((await db.app.query<{ d: string }>('select decision as d from recipe.manufacturer_release_decision where lot_id = $1', [released.lotId])).rows[0]!.d).toBe('RELEASED');
    expect((await db.app.query<{ p: string[] }>("select site.shipment_problems($1, 'IN', 'CUST-1', false, 1, 'units') as p", [released.lotId])).rows[0]!.p.join(' ')).toMatch(/RELEASE_SUSPENDED|current manufacturer release/);
    // IN-29: one AP-owned recall-assessment task; D-5-3: one ERP stock-block message; INV-39: the US event recorded.
    expect(await openTasks(released.lotId)).toEqual([{ owner_role: 'AUTHORISED_PERSON' }]);
    expect((await blocks(released.lotId)).map((b) => b.kind)).toEqual(['BLOCK']);
    expect((await db.app.query<{ s: string }>("select to_state as s from recipe.market_disposition_event where lot_id = $1 and market = 'US' order by recorded_at desc limit 1", [released.lotId])).rows[0]!.s).toBe('RELEASE_SUSPENDED');
    // D-5-2: the lot not yet released only has the cause linked; its release gate blocks it.
    expect(await suspensions(unreleased.lotId)).toEqual([]);
    expect(await openTasks(unreleased.lotId)).toEqual([]);
    expect(await blocks(unreleased.lotId)).toEqual([]);

    // A second cause on the lot adds its rows, but no second task (one open task per lot).
    await deviationOn('BATCH', released.batchId, 'Second finding on the batch record');
    expect((await suspensions(released.lotId)).length).toBe(4);
    expect(await openTasks(released.lotId)).toHaveLength(1);
    expect((await blocks(released.lotId)).map((b) => b.kind)).toEqual(['BLOCK', 'BLOCK']);

    // Bypass attempts as the application role: no direct writes, no direct call of the owner-only definers.
    expect(await codeOf(db.app.query("insert into recipe.release_suspension (lot_id, market, cause_kind, cause_ref, via_kind, via_id, label, cause, prior_state) values ($1, 'IN', 'DEVIATION', 'x', 'LOT', $1, 'x', '{}', 'RELEASED')", [released.lotId]))).toMatch(/permission denied/);
    expect(await codeOf(db.app.query('delete from recipe.release_suspension where lot_id = $1', [released.lotId]))).toMatch(/permission denied/);
    expect(await codeOf(db.app.query('delete from recipe.release_task where lot_id = $1', [released.lotId]))).toMatch(/permission denied/);
    expect(await codeOf(db.app.query('delete from site.erp_stock_block_request where lot_id = $1', [released.lotId]))).toMatch(/permission denied/);
    expect(await codeOf(db.app.query("select recipe.suspend_release($1, '{\"kind\": \"DEVIATION\", \"ref\": \"x\"}')", [unreleased.lotId]))).toMatch(/permission denied/);
    expect(await codeOf(db.app.query("select site.request_erp_stock_block($1, 'UNBLOCK', 'RECONFIRM/x', '{}')", [released.lotId]))).toMatch(/permission denied/);
    // The owner's interface refuses a cause it cannot name.
    expect(await codeOf(db.admin.query("select recipe.suspend_release($1, '{\"kind\": \"RUMOUR\", \"ref\": \"x\"}')", [released.lotId]))).toBe('EBMR-ARL-001');
  });

  it('[L-19][IN-29][PR-57] a revised LIMS result suspends the lot and every released lot downstream of it through the genealogy; the suspension of 0820\'s interface does the same', async () => {
    const upstream = await readyLot(all, ['IN']);
    await manufacturerRelease(upstream);
    const downstream = await readyLot(all, ['IN']);
    await manufacturerRelease(downstream);
    // The rework batch of the downstream lot consumed the upstream lot (the genealogy edge).
    await consumed(upstream.lotId, downstream.batchId, upstream.productCode);
    expect((await db.app.query<{ l: string[] }>("select recipe.genealogy_downstream_lots('LOT', $1) as l", [upstream.lotId])).rows[0]!.l).toEqual([downstream.lotId]);

    const retest = await sqlAs<{ resultId: string }>(analyst, 'select site.record_lot_test_result($1, $2::jsonb) as r', [upstream.lotId, JSON.stringify({ testCode: 'ASSAY', purpose: 'RETEST', value: '99.1' })]);
    expect(await suspensions(upstream.lotId)).toEqual([]);
    await w.run(analyst, (c) => c.query('select site.record_lot_test_result($1, $2::jsonb)', [upstream.lotId, JSON.stringify({
      testCode: 'ASSAY', purpose: 'RETEST', value: '99.3', revises: retest.resultId, revisionReason: 'Wrong dilution factor entered; the worksheet shows 1:50' })]));
    expect(await suspensions(upstream.lotId)).toEqual([{ market: 'IN', cause_kind: 'LIMS_REVISION', via_kind: 'LOT', prior_state: 'RELEASED' }]);
    expect(await suspensions(downstream.lotId)).toEqual([{ market: 'IN', cause_kind: 'LIMS_REVISION', via_kind: 'LOT', prior_state: 'RELEASED' }]);
    expect(await marketState(downstream.lotId, 'IN')).toBe('RELEASE_SUSPENDED');
    expect(await openTasks(downstream.lotId)).toHaveLength(1);
    // The revised result is within its limits: that cause is resolved (D-5-4).
    const ids = (await db.app.query<{ id: string }>('select id from recipe.release_suspension where lot_id = $1', [upstream.lotId])).rows;
    expect((await db.app.query<{ p: string | null }>('select recipe.suspension_cause_problem($1) as p', [ids[0]!.id])).rows[0]!.p).toBeNull();

    // recipe.suspend_release (owner only; slice 5b's amendment) suspends the lot and what is downstream of it, once per cause.
    const amend = async () => {
      const fx = await db.admin.connect();
      try {
        await fx.query('begin');
        await fx.query('select kernel.set_actor_context($1::jsonb)', [JSON.stringify({ person_id: '00000000-0000-0000-0000-000000000000', account_id: '00000000-0000-0000-0000-000000000000', role_code: 'TEST_FIXTURE', session_id: '00000000-0000-0000-0000-000000000000', source: 'SYSTEM', site_zone: 'UTC', correlation_id: randomUUID(), legal_name: 'Test fixture', reason_code: 'TEST_FIXTURE', reason_text: 'the amendment interface (slice 5b calls it)' })]);
        await fx.query("select recipe.suspend_release($1, $2::jsonb)", [upstream.lotId, JSON.stringify({ kind: 'RECORD_AMENDMENT', ref: 'AMEND-1', label: 'record amendment AMEND-1' })]);
        await fx.query('commit');
      } finally {
        fx.release();
      }
    };
    await amend();
    await amend();
    expect((await suspensions(downstream.lotId)).map((s) => s.cause_kind)).toEqual(['LIMS_REVISION', 'RECORD_AMENDMENT']);
    // An amendment cause is resolved only by its own record (5b): it fails closed until then.
    const amendment = (await db.app.query<{ id: string }>("select id from recipe.release_suspension where lot_id = $1 and cause_kind = 'RECORD_AMENDMENT'", [upstream.lotId])).rows[0]!.id;
    expect((await db.app.query<{ p: string | null }>('select recipe.suspension_cause_problem($1) as p', [amendment])).rows[0]!.p).toMatch(/not resolved/);
  });
});

describe('suspension by a kernel incident (L-19, DI-12; D-5-1)', () => {
  it('[L-19][DI-12] an incident linked to a released lot\'s batch suspends it; the cause is resolved once the incident is assessed for that batch', async () => {
    const lot = await readyLot(all, ['IN']);
    await manufacturerRelease(lot);
    const incident = await withCommand(db.app, await cmd(db, operator), (c) =>
      raiseIncident(c, { source: 'INTERFACE_FAILURE', type: 'BALANCE_INTERFACE_LOST', severity: 'MAJOR', title: 'Balance interface lost', links: [{ aggregateType: 'batch', aggregateId: lot.batchId }] }));
    expect(await suspensions(lot.lotId)).toEqual([{ market: 'IN', cause_kind: 'INCIDENT', via_kind: 'BATCH', prior_state: 'RELEASED' }]);
    expect(await marketState(lot.lotId, 'IN')).toBe('RELEASE_SUSPENDED');
    const id = (await db.app.query<{ id: string }>('select id from recipe.release_suspension where lot_id = $1', [lot.lotId])).rows[0]!.id;
    expect((await db.app.query<{ p: string | null }>('select recipe.suspension_cause_problem($1) as p', [id])).rows[0]!.p).toMatch(/still blocks batch/);
    await withCommand(db.app, await cmd(db, qaReviewer3), (c) => assessIncidentImpact(c, incident, { aggregateType: 'batch', aggregateId: lot.batchId }, 'NO_IMPACT', 'The weighing was repeated on a calibrated balance'));
    expect((await db.app.query<{ p: string | null }>('select recipe.suspension_cause_problem($1) as p', [id])).rows[0]!.p).toBeNull();
  });
});

describe('re-confirmation (outline 5.2.6; L-19, INV-05, INV-35, INV-39; D-5-4)', () => {
  it('[L-19][INV-05][INV-35][INV-39][IN-29] the AP re-confirms each market once every cause is resolved, at the evaluated epoch; the market returns to its state, the task closes and the ERP unblocks', async () => {
    const lot = await readyLot(all, ['IN', 'US']);
    await manufacturerRelease(lot);
    await usRelease(lot);
    const dev = await deviationOn('LOT', lot.lotId);
    expect(await marketState(lot.lotId, 'IN')).toBe('RELEASE_SUSPENDED');
    const why = (market: Market, act = 'RECONFIRM') => db.app.query<{ p: string[] }>('select recipe.after_release_problems($1, $2, $3) as p', [lot.lotId, market, act]).then((r) => r.rows[0]!.p);
    expect((await why('IN')).join(' ')).toMatch(/is (OPEN|UNDER_INVESTIGATION|RAISED|[A-Z_]+): a cause is resolved once its deviation is closed/);

    // Refused: the cause not resolved (the deviation still open).
    let g = await grel(lot.lotId, 'IN');
    expect(await codeOf(afterAct(ap, lot.lotId, 'IN', 'RECONFIRM', 'Impact assessed: no effect on the lot', g.epoch))).toBe('EBMR-ARL-012');
    await closeDeviation(dev, ['IN', 'US']);
    expect(await why('IN')).toEqual([]);
    // Refused: US before IN (INV-39), whatever the US causes.
    expect((await why('US')).join(' ')).toMatch(/IN is re-confirmed before US/);
    g = await grel(lot.lotId, 'IN');
    expect(red(g)).toEqual([]);
    // Refused: not the AP (QA, the QCU, an administrator); a blank impact assessment; a stale evaluation (INV-05).
    for (const who of [qaReviewer3, qcu, admin]) {
      expect(await codeOf(afterAct(who, lot.lotId, 'IN', 'RECONFIRM', 'Impact assessed', g.epoch))).toMatch(/EBMR-(ESIG|IAM)-\d{3}/);
    }
    expect(await codeOf(afterAct(ap, lot.lotId, 'IN', 'RECONFIRM', '   ', g.epoch))).toBe('EBMR-ARL-013');
    // Write after evaluation: a new reserve sample moves the lot's evidence after the AP evaluated it.
    await w.run(analyst, (c) => c.query('select site.pull_lot_sample($1, $2::jsonb)', [lot.lotId, JSON.stringify({ kind: 'RESERVE', quantity: '20', container: 'Marketed blister in carton', storageLocation: 'Reserve room R-2' })]));
    expect(await codeOf(afterAct(ap, lot.lotId, 'IN', 'RECONFIRM', 'Impact assessed', g.epoch))).toBe('EBMR-ARL-014');
    // Bypass: the AP's valid signature does not let QA record the act; a recall signature never re-confirms.
    g = await grel(lot.lotId, 'IN');
    const recallSig = await signAs(ap, 'release_suspension', await nextId(lot.lotId, 'IN', 'RECALL'), 'RECALLED', 'RELEASE_SUSPENDED');
    expect(await codeOf(w.run(qaReviewer3, (c) => c.query("select recipe.record_after_release_decision($1, 'IN', 'RECALL', $2, null, 'x')", [lot.lotId, recallSig])))).toMatch(/EBMR-IAM-\d{3}/);
    expect(await codeOf(w.run(ap, (c) => c.query("select recipe.record_after_release_decision($1, 'IN', 'RECONFIRM', $2, $3, 'Impact assessed')", [lot.lotId, recallSig, g.epoch])))).toBe('EBMR-REL-013');

    await afterAct(ap, lot.lotId, 'IN', 'RECONFIRM', 'Gasket wear has no effect on the sealed packs: no impact on the lot', g.epoch);
    expect(await marketState(lot.lotId, 'IN')).toBe('RELEASED');
    expect(await marketState(lot.lotId, 'US')).toBe('RELEASE_SUSPENDED');
    expect(await openTasks(lot.lotId)).toHaveLength(1);
    // Nothing more to re-confirm for IN.
    expect((await why('IN')).join(' ')).toMatch(/the market is RELEASED/);

    const gu = await grel(lot.lotId, 'US');
    expect(red(gu)).toEqual([]);
    await afterAct(ap, lot.lotId, 'US', 'RECONFIRM', 'No impact for the US market either', gu.epoch);
    expect(await marketState(lot.lotId, 'US')).toBe('RELEASED');
    expect(await openTasks(lot.lotId)).toEqual([]);
    expect((await blocks(lot.lotId)).map((b) => b.kind)).toEqual(['BLOCK', 'UNBLOCK']);
    const { rows } = await db.app.query<{ market: string; act: string; to_state: string; n: number; person_id: string }>(
      'select market, act, to_state, cardinality(suspension_ids) as n, person_id from recipe.after_release_decision where lot_id = $1 order by recorded_at', [lot.lotId]);
    expect(rows).toEqual([
      { market: 'IN', act: 'RECONFIRM', to_state: 'RELEASED', n: 1, person_id: ap.personId },
      { market: 'US', act: 'RECONFIRM', to_state: 'RELEASED', n: 1, person_id: ap.personId },
    ]);
    expect(await codeOf(db.app.query("update recipe.after_release_decision set act = 'RECALL' where lot_id = $1", [lot.lotId]))).toMatch(/permission denied/);

    // The ERP stub applies each message at least once, idempotently; only its interface account may.
    expect(await codeOf(w.run(ap, (c) => c.query('select site.erp_stub_deliver_stock_blocks(10)')))).toMatch(/EBMR-IAM-\d{3}/);
    await withCommand(db.app, { ...erp, correlationId: randomUUID() }, (c) => c.query('select site.erp_stub_deliver_stock_blocks(1000)'));
    const req = (await db.app.query<{ id: string }>("select id from site.erp_stock_block_request where lot_id = $1 and kind = 'BLOCK'", [lot.lotId])).rows[0]!.id;
    expect((await withCommand(db.app, { ...erp, correlationId: randomUUID() }, (c) => c.query<{ a: boolean }>('select site.erp_stub_apply_stock_block($1) as a', [req]))).rows[0]!.a).toBe(false);
    expect((await db.app.query<{ s: string }>('select site.erp_stock_state($1) as s', [lot.lotId])).rows[0]!.s).toBe('FREE');
  });

  it('[L-19][PR-49] a deviation closed with a CONFIRMED impact for the market keeps it suspended (D-2a-9)', async () => {
    const lot = await readyLot(all, ['IN']);
    await manufacturerRelease(lot);
    const dev = await deviationOn('LOT', lot.lotId);
    await closeDeviation(dev, ['IN'], 'CONFIRMED');
    const p = (await db.app.query<{ p: string[] }>("select recipe.after_release_problems($1, 'IN', 'RECONFIRM') as p", [lot.lotId])).rows[0]!.p;
    expect(p.join(' ')).toMatch(/CONFIRMED impact for IN/);
    const g = await grel(lot.lotId, 'IN');
    expect(await codeOf(afterAct(ap, lot.lotId, 'IN', 'RECONFIRM', 'Impact assessed', g.epoch))).toBe('EBMR-ARL-012');
    expect(await marketState(lot.lotId, 'IN')).toBe('RELEASE_SUSPENDED');
  });
});

describe('recall, rejection after release and disposal (outline 5.2.6; L-19, PR-46, IN-05 (e); D-5-5, D-5-6)', () => {
  it('[L-19][PR-46][IN-05] the AP recalls or rejects a market after release (terminal, with a reason); for IN the lot register moves in the same transaction; the rejected lot is disposed of once, a destruction completed by an independent witness', async () => {
    const recalled = await readyLot(all, ['IN', 'US']);
    await manufacturerRelease(recalled);
    await usRelease(recalled);
    const rejected = await readyLot(all, ['IN']);
    await manufacturerRelease(rejected);
    // Refused: disposal of a released lot (PR-46: a disposal follows a rejection or a recall).
    expect(await codeOf(dispose(qaReviewer3, rejected.lotId, { route: 'WITNESSED_DESTRUCTION', quantity: '1000' }))).toMatch(/EBMR-(ESIG-039|ARL-030)/);
    expect((await db.app.query<{ p: string }>('select recipe.disposal_problem($1) as p', [rejected.lotId])).rows[0]!.p).toMatch(/is RELEASED for IN/);

    // RECALL from a decided state (D-5-5): refused without a reason, by the QCU, by an administrator.
    expect(await codeOf(afterAct(ap, recalled.lotId, 'IN', 'RECALL', null))).toBe('EBMR-ARL-013');
    for (const who of [qcu, admin]) {
      expect(await codeOf(afterAct(who, recalled.lotId, 'IN', 'RECALL', 'Complaint cluster'))).toMatch(/EBMR-(ESIG|IAM)-\d{3}/);
    }
    // A re-confirmation needs a suspension; an epoch is only for a re-confirmation.
    expect(await codeOf(afterAct(ap, recalled.lotId, 'IN', 'RECONFIRM', 'x', (await grel(recalled.lotId, 'IN')).epoch))).toBe('EBMR-ARL-012');
    await afterAct(ap, recalled.lotId, 'IN', 'RECALL', 'Complaint cluster: tablets crumbling in the blister');
    expect(await marketState(recalled.lotId, 'IN')).toBe('RECALLED');
    expect(await lotRegister(recalled.lotId)).toBe('RECALLED');
    // INV-39: the US market reads RELEASE_SUSPENDED until the AP decides it too; terminal decisions are once per market.
    expect(await marketState(recalled.lotId, 'US')).toBe('RELEASE_SUSPENDED');
    expect(await codeOf(afterAct(ap, recalled.lotId, 'IN', 'REJECT_AFTER_RELEASE', 'again'))).toBe('EBMR-ARL-012');
    await afterAct(ap, recalled.lotId, 'US', 'RECALL', 'Same complaint cluster for the US market');
    expect(await marketState(recalled.lotId, 'US')).toBe('RECALLED');
    expect((await db.app.query<{ e: string }>("select event as e from platform.state_history where aggregate_type = 'material_lot' and aggregate_id = $1 order by id desc limit 1", [recalled.lotId])).rows[0]!.e).toBe('RELEASE_RECALL');

    // REJECT_AFTER_RELEASE from RELEASE_SUSPENDED.
    await deviationOn('LOT', rejected.lotId);
    expect(await marketState(rejected.lotId, 'IN')).toBe('RELEASE_SUSPENDED');
    await afterAct(ap, rejected.lotId, 'IN', 'REJECT_AFTER_RELEASE', 'The investigation confirmed contamination');
    expect(await marketState(rejected.lotId, 'IN')).toBe('REJECTED_AFTER_RELEASE');
    expect(await lotRegister(rejected.lotId)).toBe('REJECTED');
    // The task closes: no market is suspended any more; the ERP keeps the block (nothing is RELEASED).
    expect(await openTasks(rejected.lotId)).toEqual([]);
    expect((await blocks(rejected.lotId)).map((b) => b.kind)).toEqual(['BLOCK']);

    // PR-46 disposal: refused routes and quantities; the AP's QCU colleague holds no disposal permission.
    expect(await codeOf(dispose(qaReviewer3, rejected.lotId, { route: 'RETURN', quantity: '1000', returnTo: 'SUPPLIER' }))).toBe('EBMR-ARL-033');
    expect(await codeOf(dispose(qaReviewer3, rejected.lotId, { route: 'WITNESSED_DESTRUCTION', quantity: '1000000' }))).toBe('EBMR-ARL-032');
    expect(await codeOf(dispose(qaReviewer3, rejected.lotId, { route: 'REPROCESSING', quantity: '1000', reprocessing: randomUUID() }))).toBe('EBMR-ARL-035');
    expect(await codeOf(dispose(qcu, rejected.lotId, { route: 'WITNESSED_DESTRUCTION', quantity: '1000' }))).toMatch(/EBMR-(ESIG|IAM)-\d{3}/);
    const d = await dispose(qaReviewer3, rejected.lotId, { route: 'WITNESSED_DESTRUCTION', quantity: '1000', reference: 'DR-2026-0007', text: 'Incinerated by the licensed contractor' });
    expect(await lotRegister(rejected.lotId)).toBe('REJECTED');
    // Once per lot; the performer never witnesses; a person without the witness permission cannot.
    expect(await codeOf(dispose(ap, rejected.lotId, { route: 'RETURN', quantity: '1000', returnTo: 'SUPPLIER', reference: 'RT-1' }))).toMatch(/EBMR-(ESIG-011|ESIG-039|ARL-030)/);
    expect(await codeOf(witness(qaReviewer3, d))).toMatch(/EBMR-(ESIG-04[34]|ARL-043)/);
    expect(await codeOf(witness(qcu, d))).toMatch(/EBMR-(ESIG|IAM)-\d{3}/);
    await witness(qaFloor, d);
    expect(await lotRegister(rejected.lotId)).toBe('DESTROYED');
    expect(await codeOf(witness(qaFloor, d))).toMatch(/EBMR-(ESIG-039|ARL-042)/);
    expect(await codeOf(db.app.query('delete from recipe.lot_disposal where id = $1', [d]))).toMatch(/permission denied/);

    // A recalled lot is returned to the customer (D-5a-4): RETURNED, with its reference.
    await dispose(ap, recalled.lotId, { route: 'RETURN', quantity: '1000', returnTo: 'CUSTOMER', reference: 'RET-2026-0042' });
    expect(await lotRegister(recalled.lotId)).toBe('RETURNED');
  });
});
