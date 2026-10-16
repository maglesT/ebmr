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
import { toDbContext, withCommand } from '../../../kernel/src/db/command.ts';
import { createChallenge, contentForSigning, sign } from '../../../kernel/src/esig/signing.ts';
import { challengeFor, cmd, ensureSealKey, signatureAuth, signWith, testSealKey } from '../../../kernel/test/esig/helpers.ts';
import { signFor } from '../../../kernel/test/records/helpers.ts';
import { seedActor, seedAdministration, seedServiceActor, withReason, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { ensureFixtureChangeRecord, underChange } from '../../../kernel/test/support/change-record.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import type { MbrContent } from '../../src/flow/model.ts';
import * as execution from '../../src/execution/index.ts';
import type * as lc from '../../src/lifecycle/index.ts';
import { define, FIXTURE_INPUTS, FIXTURE_JUSTIFICATIONS } from '../engine/support.ts';
import { gmpOrderFor } from '../lifecycle/gmp-support.ts';
import { cell, reason, seedCast, uniqueContent, World } from '../lifecycle/support.ts';
import { investigateDeviation } from './deviation-path.ts';
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
let owner: SeededActor;
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
  await ensureFixtureChangeRecord(db);
  w = new World(db, await seedCast(db));
  ({ admin, owner } = await seedAdministration(db));
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
    // The owner's interface refuses a lot that is no finished lot, or none, and a cause it cannot name.
    expect(await codeOf(db.admin.query("select recipe.suspend_release($1, '{\"kind\": \"DEVIATION\", \"ref\": \"x\"}')", [randomUUID()]))).toBe('EBMR-ARL-002');
    expect(await codeOf(db.admin.query("select recipe.suspend_release(null, '{\"kind\": \"DEVIATION\", \"ref\": \"x\"}')"))).toBe('EBMR-ARL-002');
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
    // An amendment cause is resolved only by its own record: once that amendment is closed (5b, D-5b-9); open (here no
    // such amendment exists at all) it fails closed.
    const amendment = (await db.app.query<{ id: string }>("select id from recipe.release_suspension where lot_id = $1 and cause_kind = 'RECORD_AMENDMENT'", [upstream.lotId])).rows[0]!.id;
    expect((await db.app.query<{ p: string | null }>('select recipe.suspension_cause_problem($1) as p', [amendment])).rows[0]!.p).toMatch(/record amendment AMEND-1 is still open: a record amendment is resolved once QA closes it/);
  });
});

describe('a revised result as the cause (L-19; D-5-4)', () => {
  it('[L-19][PR-57] a revised result resolves its cause only through its own latest revision: out of its limits it is a problem; revised again within them it is resolved', async () => {
    const lot = await readyLot(all, ['IN']);
    await manufacturerRelease(lot);
    const revise = async (revises: string, value: string): Promise<string> =>
      (await sqlAs<{ resultId: string }>(analyst, 'select site.record_lot_test_result($1, $2::jsonb) as r', [lot.lotId, JSON.stringify({
        testCode: 'ASSAY', purpose: 'RETEST', value, revises, revisionReason: 'Wrong dilution factor entered; the worksheet shows 1:50' })])).resultId;
    const first = await sqlAs<{ resultId: string }>(analyst, 'select site.record_lot_test_result($1, $2::jsonb) as r', [lot.lotId, JSON.stringify({ testCode: 'ASSAY', purpose: 'RETEST', value: '99.1' })]);
    const out = await revise(first.resultId, '90.0');
    const problem = async (ref: string) => {
      const id = (await db.app.query<{ id: string }>("select id from recipe.release_suspension where lot_id = $1 and cause_kind = 'LIMS_REVISION' and cause_ref = $2", [lot.lotId, ref])).rows[0]!.id;
      return (await db.app.query<{ p: string | null }>('select recipe.suspension_cause_problem($1) as p', [id])).rows[0]!.p;
    };
    expect(await problem(out)).toMatch(/the revised ASSAY result is FAIL: a cause is resolved once the result is within its limits/);
    const back = await revise(out, '99.4');
    expect(await problem(out)).toBeNull();
    expect(await problem(back)).toBeNull();
    // Revised once more, out of its limits: every cause on that chain is a problem again.
    await revise(back, '89.5');
    expect(await problem(out)).toMatch(/the revised ASSAY result is FAIL/);
    expect(await problem(back)).toMatch(/the revised ASSAY result is FAIL/);
  }, 180_000);
});

describe('the genealogy of a suspension (L-19, PR-57; recipe-core 0840)', () => {
  it('[L-19][PR-57] every edge of the genealogy leads from its own source only: bulk issued, packaging orders, reprocessing children, source additions, lot consumption, returned goods; only finished lots are named, never the node itself', async () => {
    // TEST FIXTURE, rolled back: each edge as its guarded writer records it (proven in the lifecycle, reprocessing and
    // site-services tests), on its own pair of nodes, so one edge followed from the wrong node shows.
    const fx = await db.admin.connect();
    const id = (): string => randomUUID();
    try {
      await fx.query('begin');
      await fx.query("set local session_replication_role = 'replica'");
      const who = id();
      const finished = async (lot: string, batch: string): Promise<void> => {
        await fx.query(`insert into site.finished_lot (lot_id, batch_id, batch_number, edition, product_code, strength, markets, posted_by_person, posted_by_account)
                        values ($1, $2, 'P-FIXTURE', 'TABLETS', 'FX', '500 mg', '{IN}', $3, $3)`, [lot, batch, who]);
      };
      // A: the bulk of pA issued to packaging order oA.
      const [pA, oA, lA] = [id(), id(), id()];
      await fx.query(`insert into recipe.packaging_bulk_issue (order_batch_id, parent_batch_id, container_id, charge_id, quantity, unit, person_id, account_id)
                      values ($1, $2, gen_random_uuid(), gen_random_uuid(), 1, 'kg', $3, $3)`, [oA, pA, who]);
      await finished(lA, oA);
      // B: packaging order oB allocated under the processing batch pB.
      const [pB, oB, lB, aP, aO] = [id(), id(), id(), id(), id()];
      for (const [a, parent, batch, kind] of [[aP, null, pB, 'PROCESSING'], [aO, aP, oB, 'PACKAGING']] as [string, string | null, string, string][]) {
        const number = `FX-${a.slice(0, 8).toUpperCase()}`;
        await fx.query(`insert into site.batch_number_allocation (id, batch_number, site_code, site_zone, product_code, product_name, edition, batch_kind, parent_allocation_id,
                                                                  batch_size, batch_size_unit, source, allocated_by_person_id, allocated_by_account_id, correlation_id)
                        values ($1, $2, 'SITE-1', 'UTC', 'FX', 'Fixture', 'TABLETS', $3, $4, 1, 'kg', 'EXTERNAL', $5, $5, $5)`, [a, number, kind, parent, who]);
        await fx.query('insert into recipe.batch_allocation_link (batch_id, allocation_id, batch_number, person_id, account_id, correlation_id) values ($1, $2, $3, $4, $4, $4)', [batch, a, number, who]);
      }
      await finished(lB, oB);
      // C: a reprocessing child of pC.
      const [pC, cC, lC] = [id(), id(), id()];
      await fx.query("insert into recipe.batch_parent_link (child_batch_id, parent_batch_id, parent_batch_number, parent_containers, request_id) values ($1, $2, 'P-C', '{}', $3)", [cC, pC, who]);
      await finished(lC, cC);
      // D: material of pD added to batch cD.
      const [pD, cD, lD] = [id(), id(), id()];
      await fx.query(`insert into recipe.source_addition (batch_id, batch_number, step_key, entry_id, block, container_id, case_code, net_quantity, unit, source_batch_id, source_batch_number,
                                                          product_code, strength, source_generated_at, source_manufactured_at, added_by_person)
                      values ($1, 'C-D', 'S1@', 'EN-1', 'G-24@2', gen_random_uuid(), 'REPROCESSING_ADDITION', 1, 'kg', $2, 'P-D', 'FX', '500 mg', now(), now(), $3)`, [cD, pD, who]);
      await finished(lD, cD);
      // E: lot xE consumed by batch bE, whose finished lot lE came back as returned goods rE (a finished lot again) and nE (not one).
      const [xE, bE, lE, rE, nE] = [id(), id(), id(), id(), id()];
      await fx.query(`insert into site.lot_consumption (lot_id, reservation_id, batch_id, batch_number, edition, material_code, quantity, unit, quantity_before, quantity_after, market_set,
                                                        identity_basis, consumed_by_person, consumed_by_account, xact_id)
                      values ($1, gen_random_uuid(), $2, 'B-E', 'TABLETS', 'API-FX', 1, 'kg', 10, 9, '{IN}', 'IDENTITY_RESULT', $3, $3, txid_current())`, [xE, bE, who]);
      await finished(lE, bE);
      for (const r of [rE, nE]) {
        await fx.query("insert into site.returned_goods (lot_id, original_lot_id, quantity, unit, reason, returned_from, received_by_person, received_by_account) values ($1, $2, 1, 'units', 'Returned', 'CUSTOMER', $3, $3)", [r, lE, who]);
      }
      await finished(rE, id());

      const down = async (kind: string, node: string): Promise<string[]> =>
        (await fx.query<{ l: string[] }>('select recipe.genealogy_downstream_lots($1, $2) as l', [kind, node])).rows[0]!.l;
      const sorted = (xs: string[]): string[] => [...xs].sort();
      expect(await down('BATCH', pA)).toEqual([lA]);
      expect(await down('BATCH', pB)).toEqual([lB]);
      expect(await down('BATCH', pC)).toEqual([lC]);
      expect(await down('BATCH', pD)).toEqual([lD]);
      expect(await down('BATCH', oA)).toEqual([lA]);
      expect(await down('LOT', xE)).toEqual(sorted([lE, rE]));
      expect(await down('BATCH', bE)).toEqual(sorted([lE, rE]));
      // The node itself is never its own downstream lot; a lot that is no finished lot is never named.
      expect(await down('LOT', lE)).toEqual([rE]);
      expect(await down('LOT', rE)).toEqual([]);
      // Nothing leads from an unrelated node, nor from no node.
      expect(await down('BATCH', id())).toEqual([]);
      expect(await down('LOT', id())).toEqual([]);
      expect(await down('BATCH', lA)).toEqual([]);
      expect(await down('PRODUCT', pA)).toEqual([]);
      expect((await fx.query<{ l: string[] }>("select recipe.genealogy_downstream_lots('BATCH', null) as l")).rows[0]!.l).toEqual([]);
    } finally {
      await fx.query('rollback');
      fx.release();
    }
  });
});

/**
 * A rolled-back transaction as the database owner, with the given release-model reads replaced by stand-ins (DDL is
 * transactional): the state functions are then asked directly for each answer of what they read.
 */
async function withStandIns<T>(standIns: string[], work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const fx = await db.admin.connect();
  try {
    await fx.query('begin');
    await fx.query('set local role ebmr_owner');
    for (const s of standIns) await fx.query(s);
    await fx.query('reset role');
    return await work(fx);
  } finally {
    await fx.query('rollback');
    fx.release();
  }
}

describe('the decided release of each market (L-19, INV-39; recipe-core 0840)', () => {
  it('[L-19][INV-39] a market counts as decided released only on its own decision: IN and US RELEASED, EU CERTIFIED; any other outcome, no decision or another market does not', async () => {
    const lot = randomUUID();
    const decided = async (c: pg.PoolClient, market: string): Promise<boolean> => (await c.query<{ d: boolean }>('select recipe.market_decided_released($1, $2) as d', [lot, market])).rows[0]!.d;
    const eu = (outcome: string | null) => `create or replace function recipe.eu_outcome(p_lot uuid) returns text language sql stable as $$ select ${outcome === null ? 'null' : `'${outcome}'`}::text $$`;
    expect(await withStandIns([eu('CERTIFIED')], (c) => decided(c, 'EU'))).toBe(true);
    expect(await withStandIns([eu('REJECTED_BY_QP')], (c) => decided(c, 'EU'))).toBe(false);
    expect(await withStandIns([eu(null)], (c) => decided(c, 'EU'))).toBe(false);
    // No decision for IN and US; a market the release model does not know is never decided.
    expect(await withStandIns([], async (c) => [await decided(c, 'IN'), await decided(c, 'US'), await decided(c, 'JP')])).toEqual([false, false, false]);
  });
});

describe('which markets a suspension covers (L-19, INV-39; recipe-core 0875)', () => {
  it('[L-19][INV-39][IN-29] only a finished lot is suspended, only for the markets of its own set (a decided market outside it gets no row), once per open cause, with one open recall-assessment task', async () => {
    const lot = await readyLot(all, ['IN', 'US'], ['IN']);
    await manufacturerRelease(lot);
    // Stand-in: every market reads as decided released, so the set alone decides which markets are suspended.
    const decidedEverywhere = 'create or replace function recipe.market_decided_released(p_lot uuid, p_market text) returns boolean language sql stable as $$ select true $$';
    const rows = await withStandIns([decidedEverywhere], async (c) => {
      await c.query('select kernel.set_actor_context($1::jsonb)', [JSON.stringify({
        person_id: '00000000-0000-0000-0000-000000000000', account_id: '00000000-0000-0000-0000-000000000000', role_code: 'TEST_FIXTURE',
        session_id: '00000000-0000-0000-0000-000000000000', source: 'SYSTEM', site_zone: 'UTC', correlation_id: randomUUID(), legal_name: 'Test fixture',
        reason_code: 'TEST_FIXTURE', reason_text: 'which markets a suspension covers' })]);
      const cause = (lotId: string) => JSON.stringify({ kind: 'DEVIATION', ref: randomUUID(), via_kind: 'LOT', via_id: lotId, label: 'a cause for the test' });
      const none = randomUUID();
      const n0 = (await c.query<{ n: number }>('select recipe.suspend_lot($1, $2::jsonb) as n', [none, cause(none)])).rows[0]!.n;
      const first = cause(lot.lotId);
      const suspend = async (cz: string): Promise<number> => (await c.query<{ n: number }>('select recipe.suspend_lot($1, $2::jsonb) as n', [lot.lotId, cz])).rows[0]!.n;
      const n1 = await suspend(first);
      // The same cause again, while its row is open: idempotent (its only open row is that one).
      const again = await suspend(first);
      // Another lot's recall-assessment task was closed (a fixture); the lot's own task is still open, so a second cause
      // opens no second task.
      await c.query("set local session_replication_role = 'replica'");
      const other = (await c.query<{ id: string }>("insert into recipe.release_task (lot_id, kind, owner_role, cause) values (gen_random_uuid(), 'RECALL_ASSESSMENT', 'AUTHORISED_PERSON', '{}') returning id")).rows[0]!.id;
      await c.query('insert into recipe.release_task_closure (task_id, decision_id) values ($1, gen_random_uuid())', [other]);
      await c.query("set local session_replication_role = 'origin'");
      const n2 = await suspend(cause(lot.lotId));
      const markets = (await c.query<{ m: string }>('select market as m from recipe.release_suspension where lot_id = $1 order by market', [lot.lotId])).rows.map((r) => r.m);
      const tasks = (await c.query<{ n: number }>("select count(*)::int as n from recipe.release_task t where t.lot_id = $1 and t.kind = 'RECALL_ASSESSMENT' and not exists (select 1 from recipe.release_task_closure x where x.task_id = t.id)", [lot.lotId])).rows[0]!.n;
      return { n0, n1, again, n2, markets, tasks };
    });
    expect(rows).toEqual({ n0: 0, n1: 1, again: 0, n2: 1, markets: ['IN', 'IN'], tasks: 1 });
  }, 180_000);
});

describe('the released lots an amendment suspends (INV-21, R-04; recipe-core 0874)', () => {
  it('[INV-21][R-04][L-19] a record\'s released lots name each market decided for the lot and not recalled or rejected after release for that lot, whatever other lots or other markets were decided', async () => {
    const [l1, l2, l3, l4, batch] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const rows = await withStandIns([
      // l3 was rejected for IN after release; l4 was never released.
      `create or replace function recipe.lots_of_batch(p_batch uuid) returns uuid[] language sql stable as $$ select array['${l1}', '${l2}', '${l3}', '${l4}']::uuid[] $$`,
      `create or replace function recipe.market_set(p_kind text, p_id uuid) returns text[] language sql stable as $$
         select case p_id when '${l1}' then array['EU', 'IN', 'US'] when '${l2}' then array['EU'] else array['IN'] end $$`,
      `create or replace function recipe.market_decided_released(p_lot uuid, p_market text) returns boolean language sql stable as $$ select p_lot <> '${l4}' $$`,
      "create or replace function recipe.disposition_state(p_lot uuid, p_market text) returns text language sql stable as $$ select 'STATE'::text $$",
    ], async (c) => {
      // TEST FIXTURE: decisions as the AP's acts record them: l1 recalled for the US and re-confirmed for the EU; another lot rejected for IN.
      await c.query("set local session_replication_role = 'replica'");
      for (const [lot, market, act, to] of [[l1, 'US', 'RECALL', 'RECALLED'], [l1, 'EU', 'RECONFIRM', 'CERTIFIED'], [l3, 'IN', 'REJECT_AFTER_RELEASE', 'REJECTED_AFTER_RELEASE']]) {
        await c.query(`insert into recipe.after_release_decision (lot_id, market, seq, act, to_state, text, epoch, checklist, suspension_ids, signature_id, content_hash, person_id, account_id, role_code, correlation_id)
                       values ($1, $2, 1, $3, $4, 'fixture', case when $3 = 'RECONFIRM' then repeat('0', 64) end, case when $3 = 'RECONFIRM' then '{}'::jsonb end, '{}',
                               gen_random_uuid(), 'fixture', $5, $5, 'AUTHORISED_PERSON', gen_random_uuid())`, [lot, market, act, to, ap.personId]);
      }
      await c.query("set local session_replication_role = 'origin'");
      return (await c.query<{ r: { lot_id: string; markets: { market: string }[] }[] }>('select recipe.record_released_lots($1) as r', [batch])).rows[0]!.r;
    });
    const byLot = Object.fromEntries(rows.map((x) => [x.lot_id, x.markets.map((m) => m.market)]));
    expect(byLot).toEqual({ [l1]: ['EU', 'IN'], [l2]: ['EU', 'IN'] });
  });
});

describe('suspension by an as-found calibration failure (L-19; D-5-1, D-5a-3)', () => {
  it('[L-19] an as-found calibration failure suspends the released lots of the batches that used the unit (as equipment or as an instrument) since its previous calibration, and no earlier one; the AP\'s assessment resolves the cause', async () => {
    const before = await readyLot(all, ['IN']);
    await manufacturerRelease(before);
    const since = await readyLot(all, ['IN']);
    await manufacturerRelease(since);
    const run = await readyLot(all, ['IN']);
    await manufacturerRelease(run);
    const fx = await db.admin.connect();
    try {
      await fx.query('begin');
      await fx.query('select kernel.set_actor_context($1::jsonb)', [JSON.stringify({
        person_id: '00000000-0000-0000-0000-000000000000', account_id: '00000000-0000-0000-0000-000000000000', role_code: 'TEST_FIXTURE',
        session_id: '00000000-0000-0000-0000-000000000000', source: 'SYSTEM', site_zone: 'UTC', correlation_id: randomUUID(), legal_name: 'Test fixture',
        reason_code: 'TEST_FIXTURE', reason_text: 'a calibration failure after release' })]);
      // TEST FIXTURE (rolled back): a balance, a use of it by the first batch, a good calibration, a use by the second
      // batch, as plant's guarded commands record them (proven in plant/equipment.test.ts); then the failed calibration
      // is recorded with every trigger on.
      await fx.query("set local session_replication_role = 'replica'");
      const unit = randomUUID();
      const who = randomUUID();
      await fx.query("insert into plant.equipment (id, code, name, class_code, kind, recorded_by) values ($1, $2, 'Fixture balance', 'CL-FX', 'INSTRUMENT', $3)", [unit, `EQ-CAL-${unit.slice(0, 8).toUpperCase()}`, who]);
      const firstUse = randomUUID();
      await fx.query(`insert into plant.equipment_use (id, equipment_id, batch_id, batch_ref, product_code, planned_end, cleaning_id, started_by, started_at)
                      values ($4, $1, $2, 'B-BEFORE', 'FX', now() - interval '9 days', gen_random_uuid(), $3, now() - interval '10 days')`, [unit, before.batchId, who, firstUse]);
      await fx.query(`insert into plant.calibration (equipment_id, due_at, as_found, as_left, reference, person_id, account_id, recorded_at)
                      values ($1, now() + interval '1 year', 'PASS', 'PASS', 'CAL-GOOD', $2, $2, now() - interval '5 days')`, [unit, who]);
      await fx.query(`insert into plant.instrument_use (equipment_id, batch_id, batch_ref, product_code, regime, check_id, planned_end, person_id, account_id, recorded_at)
                      values ($1, $2, 'B-SINCE', 'FX', 'DAILY', gen_random_uuid(), now(), $3, $3, now() - interval '1 day')`, [unit, since.batchId, who]);
      // The third batch ran on the unit (an equipment use) after the good calibration.
      await fx.query(`insert into plant.equipment_use (equipment_id, previous_use_id, batch_id, batch_ref, product_code, planned_end, cleaning_id, started_by, started_at)
                      values ($1, $4, $2, 'B-RUN', 'FX', now(), gen_random_uuid(), $3, now() - interval '2 days')`, [unit, run.batchId, who, firstUse]);
      await fx.query("set local session_replication_role = 'origin'");
      await fx.query("insert into plant.calibration (equipment_id, due_at, as_found, as_left, reference, person_id, account_id) values ($1, now() + interval '1 year', 'FAIL', 'PASS', 'CAL-FAIL', $2, $2)", [unit, who]);
      const rows = async (lot: string) =>
        (await fx.query<{ market: string; cause_kind: string; via_kind: string; via_id: string; label: string; id: string }>(
          'select id, market, cause_kind, via_kind, via_id, label from recipe.release_suspension where lot_id = $1', [lot])).rows;
      const s = await rows(since.lotId);
      expect(s.map((r) => [r.market, r.cause_kind, r.via_kind, r.via_id])).toEqual([['IN', 'CALIBRATION_FAILURE', 'BATCH', since.batchId]]);
      expect(s[0]!.label).toMatch(/as-found calibration failure of EQ-CAL-.* \(CAL-FAIL\)/);
      expect(await rows(before.lotId)).toEqual([]);
      expect((await rows(run.lotId)).map((r) => [r.market, r.cause_kind, r.via_kind, r.via_id])).toEqual([['IN', 'CALIBRATION_FAILURE', 'BATCH', run.batchId]]);
      expect((await fx.query<{ s: string }>('select recipe.manufacturer_release_state($1) as s', [since.lotId])).rows[0]!.s).toBe('RELEASE_SUSPENDED');
      expect((await fx.query<{ s: string }>('select recipe.manufacturer_release_state($1) as s', [before.lotId])).rows[0]!.s).toBe('RELEASED');
      // D-5a-3: the AP's impact assessment of the failure resolves it (nothing else to wait for).
      expect((await fx.query<{ p: string | null }>('select recipe.suspension_cause_problem($1) as p', [s[0]!.id])).rows[0]!.p).toBeNull();
      // A passing as-found calibration suspends nothing.
      await fx.query("insert into plant.calibration (equipment_id, due_at, as_found, as_left, reference, person_id, account_id) values ($1, now() + interval '1 year', 'PASS', 'PASS', 'CAL-NEXT', $2, $2)", [unit, who]);
      expect(await rows(since.lotId)).toHaveLength(1);
    } finally {
      await fx.query('rollback');
      fx.release();
    }
  }, 180_000);
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
    // A link to anything but a batch or a material lot, or to a batch by another kind of reference, suspends nothing.
    await withCommand(db.app, await cmd(db, operator), (c) =>
      raiseIncident(c, { source: 'INTERFACE_FAILURE', type: 'BALANCE_INTERFACE_LOST', severity: 'MINOR', title: 'Unit and legacy record links',
                         links: [{ aggregateType: 'equipment', aggregateId: lot.batchId }, { aggregateType: 'batch', aggregateId: 'LEGACY-B-0042' }] }));
    expect(await suspensions(lot.lotId)).toHaveLength(1);
    await withCommand(db.app, await cmd(db, qaReviewer3), (c) => assessIncidentImpact(c, incident, { aggregateType: 'batch', aggregateId: lot.batchId }, 'NO_IMPACT', 'The weighing was repeated on a calibrated balance'));
    expect((await db.app.query<{ p: string | null }>('select recipe.suspension_cause_problem($1) as p', [id])).rows[0]!.p).toBeNull();
  });
});

describe('re-confirmation (outline 5.2.6; L-19, INV-05, INV-35, INV-39; D-5-4)', () => {
  it('[L-19][INV-05][INV-35][INV-39][IN-29] the AP re-confirms each market once every cause is resolved, at the evaluated epoch; the market returns to its state, the task closes and the ERP unblocks', async () => {
    // Another suspended lot: its task is not this lot's to close.
    const other = await readyLot(all, ['IN']);
    await manufacturerRelease(other);
    await deviationOn('LOT', other.lotId, 'Finding on another lot');
    const lot = await readyLot(all, ['IN', 'US']);
    await manufacturerRelease(lot);
    await usRelease(lot);
    const dev = await deviationOn('LOT', lot.lotId);
    expect(await marketState(lot.lotId, 'IN')).toBe('RELEASE_SUSPENDED');
    // The record the AP signs: this market's open causes, and for a re-confirmation the G-REL evaluation (INV-05).
    const pending = async (act: string) =>
      (await db.admin.query<{ c: { exists: boolean; state: string; content: { act: string; sequence: number; suspensions: { kind: string; ref: string }[]; checklist: unknown } } }>(
        'select recipe.release_suspension_content($1) as c', [await nextId(lot.lotId, 'IN', act)])).rows[0]!.c;
    const re = await pending('RECONFIRM');
    expect(re).toMatchObject({ exists: true, state: 'RELEASE_SUSPENDED', content: { act: 'RECONFIRM', sequence: 1 } });
    expect(re.content.suspensions.map((x) => [x.kind, x.ref])).toEqual([['DEVIATION', dev]]);
    expect(re.content.checklist).toMatchObject({ epoch: expect.any(String) as string });
    expect((await pending('RECALL')).content.checklist).toBeNull();
    const why = (market: Market, act = 'RECONFIRM') => db.app.query<{ p: string[] }>('select recipe.after_release_problems($1, $2, $3) as p', [lot.lotId, market, act]).then((r) => r.rows[0]!.p);
    // The problem names the cause's own deviation.
    const devRef = (await db.admin.query<{ r: string }>('select ref as r from site.deviation where id = $1', [dev])).rows[0]!.r;
    expect((await why('IN')).join(' ')).toMatch(new RegExp(`deviation ${devRef} is [A-Z_]+: a cause is resolved once its deviation is closed`));

    // Refused: the cause not resolved (the deviation still open).
    let g = await grel(lot.lotId, 'IN');
    expect(await codeOf(afterAct(ap, lot.lotId, 'IN', 'RECONFIRM', 'Impact assessed: no effect on the lot', g.epoch))).toBe('EBMR-ARL-012');
    // No lot, no market, a market outside the lot's set.
    const none = randomUUID();
    expect((await db.app.query<{ p: string[] }>("select recipe.after_release_problems($1, 'IN', 'RECALL') as p", [none])).rows[0]!.p).toEqual([`${none} is no finished lot`]);
    expect((await db.app.query<{ p: string[] }>("select recipe.after_release_problems($1, null, 'RECALL') as p", [lot.lotId])).rows[0]!.p).toEqual(['NULL is not a market of the lot']);
    expect((await db.app.query<{ p: string[] }>("select recipe.after_release_problems($1, 'EU', 'RECALL') as p", [lot.lotId])).rows[0]!.p).toEqual(['EU is not a market of the lot']);
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
    // No act or market the database does not know.
    const decide = (market: string | null, act: string | null) =>
      codeOf(w.run(ap, (c) => c.query('select recipe.record_after_release_decision($1, $2, $3, $4, null, $5)', [lot.lotId, market, act, randomUUID(), 'Impact assessed'])));
    expect(await decide('IN', 'RECONFIRM_ALL')).toBe('EBMR-ARL-010');
    expect(await decide('IN', null)).toBe('EBMR-ARL-010');
    expect(await decide('JP', 'RECALL')).toBe('EBMR-ARL-011');
    expect(await decide(null, 'RECALL')).toBe('EBMR-ARL-011');
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
    expect(await openTasks(other.lotId)).toHaveLength(1);
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
    // Everything is delivered once: a second run finds nothing; the other lot's block is in force; a lot never blocked has no stock state.
    const erpRun = <T>(sql: string, params: unknown[] = []) => withCommand(db.app, { ...erp, correlationId: randomUUID() }, async (c) => (await c.query<{ r: T }>(sql, params)).rows[0]!.r);
    expect(await erpRun<number>('select site.erp_stub_deliver_stock_blocks(1000) as r')).toBe(0);
    expect((await db.app.query<{ s: string }>('select site.erp_stock_state($1) as s', [other.lotId])).rows[0]!.s).toBe('BLOCKED');
    expect((await db.app.query<{ s: string | null }>('select site.erp_stock_state($1) as s', [randomUUID()])).rows[0]!.s).toBeNull();
    // A new cause on the other lot is one new message: delivered by a run of one, oldest first, then nothing is left.
    await deviationOn('LOT', other.lotId, 'Second finding on another lot');
    // Applying a message takes its lot's row lock (serialised with the lot's own commands): while another transaction holds
    // that lot, the delivery waits for it.
    const holder = await db.admin.connect();
    try {
      await holder.query('begin');
      await holder.query('select 1 from site.material_lot where id = $1 for update', [other.lotId]);
      const waited = await withCommand(db.app, { ...erp, correlationId: randomUUID() }, async (c) => {
        await c.query("set local lock_timeout = '1s'");
        return c.query('select site.erp_stub_deliver_stock_blocks(1)');
      }).then(() => 'delivered', (e: Error & { code?: string }) => e.code ?? e.message);
      expect(waited).toBe('55P03');
    } finally {
      await holder.query('rollback');
      holder.release();
    }
    expect(await erpRun<number>('select site.erp_stub_deliver_stock_blocks(1) as r')).toBe(1);
    expect(await erpRun<number>('select site.erp_stub_deliver_stock_blocks(1) as r')).toBe(0);
    for (const limit of [0, 1001, null]) expect(await codeOf(erpRun('select site.erp_stub_deliver_stock_blocks($1) as r', [limit]))).toBe('EBMR-SITE-881');
    expect(await codeOf(erpRun('select site.erp_stub_apply_stock_block($1) as r', [randomUUID()]))).toBe('EBMR-SITE-880');
    // The stock state is the lot's latest delivered message, read from that message alone: a site whose only message is the
    // other lot's first block reads it BLOCKED (TEST FIXTURE, rolled back: every other message removed).
    const only = await db.admin.connect();
    try {
      await only.query('begin');
      await only.query("set local session_replication_role = 'replica'");
      const keep = (await only.query<{ id: string }>("select id from site.erp_stock_block_request where lot_id = $1 and kind = 'BLOCK' order by requested_at limit 1", [other.lotId])).rows[0]!.id;
      await only.query('delete from site.erp_stock_block_delivery where request_id <> $1', [keep]);
      await only.query('delete from site.erp_stock_block_request where id <> $1', [keep]);
      expect((await only.query<{ s: string | null }>('select site.erp_stock_state($1) as s', [other.lotId])).rows[0]!.s).toBe('BLOCKED');
      expect((await only.query<{ s: string | null }>('select site.erp_stock_state($1) as s', [lot.lotId])).rows[0]!.s).toBeNull();
    } finally {
      await only.query('rollback');
      only.release();
    }
    // The outbox is idempotent by lot, kind and cause: the same message asked again is the same message (owner-only; rolled back).
    const ob = await db.admin.connect();
    try {
      await ob.query('begin');
      await ob.query('select kernel.set_actor_context($1::jsonb)', [JSON.stringify({
        person_id: '00000000-0000-0000-0000-000000000000', account_id: '00000000-0000-0000-0000-000000000000', role_code: 'TEST_FIXTURE',
        session_id: '00000000-0000-0000-0000-000000000000', source: 'SYSTEM', site_zone: 'UTC', correlation_id: randomUUID(), legal_name: 'Test fixture',
        reason_code: 'TEST_FIXTURE', reason_text: 'the outbox asked twice' })]);
      const ask = async (lotId: string, kind: string, key: string) => (await ob.query<{ id: string }>("select site.request_erp_stock_block($1, $2, $3, '{}') as id", [lotId, kind, key])).rows[0]!.id;
      const first = await ask(lot.lotId, 'BLOCK', 'TEST/again');
      expect(await ask(lot.lotId, 'BLOCK', 'TEST/again')).toBe(first);
      const others = [await ask(other.lotId, 'BLOCK', 'TEST/again'), await ask(lot.lotId, 'UNBLOCK', 'TEST/again'), await ask(lot.lotId, 'BLOCK', 'TEST/another')];
      expect(new Set([first, ...others]).size).toBe(4);
      expect(await ask(other.lotId, 'BLOCK', 'TEST/again')).toBe(others[0]);
    } finally {
      await ob.query('rollback');
      ob.release();
    }
  }, 300_000);

  it('[L-19][INV-05][DI-37] a decision signed before its causes moved is refused (its signature no longer matches the record); a re-confirmation with a RED item of G-REL is refused (EBMR-ARL-018)', async () => {
    const lot = await readyLot(all, ['IN']);
    await manufacturerRelease(lot);
    const dev = await deviationOn('LOT', lot.lotId, 'First finding after release');
    // The AP signs a recall of the suspended market; a second cause then joins the record before the act runs.
    const sig = await signAs(ap, 'release_suspension', await nextId(lot.lotId, 'IN', 'RECALL'), 'RECALLED', 'RELEASE_SUSPENDED');
    await deviationOn('LOT', lot.lotId, 'Second finding after release');
    expect(await codeOf(w.run(ap, (c) => c.query("select recipe.record_after_release_decision($1, 'IN', 'RECALL', $2, null, 'Recall after the first finding')", [lot.lotId, sig])))).toBe('EBMR-REL-013');
    expect(await marketState(lot.lotId, 'IN')).toBe('RELEASE_SUSPENDED');

    // Both causes resolved; the release gate then shows a RED item for this lot (the test edition answers it).
    await closeDeviation(dev, ['IN']);
    const second = (await db.app.query<{ ref: string }>("select cause_ref as ref from recipe.release_suspension where lot_id = $1 and cause_ref <> $2", [lot.lotId, dev])).rows[0]!.ref;
    await closeDeviation(second, ['IN']);
    const edition = (status: string) => `create or replace function test_edition.grel_items(p_lot uuid, p_market text) returns jsonb language sql stable as $$
      select jsonb_build_array(
        jsonb_build_object('id', 'E.RECONCILIATION', 'group', '4', 'title', 'Reconciliation within limits', 'status', 'GREEN', 'problem', null, 'evidence', '[]'::jsonb, 'since_review', false),
        jsonb_build_object('id', 'E.PACK_EXAMINATION', 'group', '9', 'title', 'Finished-pack examination',
                           'status', case when p_lot = '${lot.lotId}' then '${status}' else 'GREEN' end,
                           'problem', case when p_lot = '${lot.lotId}' then 'pack examination found torn foils' end, 'evidence', '[]'::jsonb, 'since_review', false))
    $$`;
    await db.admin.query(edition('RED'));
    try {
      const g = await grel(lot.lotId, 'IN');
      expect(red(g)).toEqual(['E.PACK_EXAMINATION']);
      expect(await codeOf(afterAct(ap, lot.lotId, 'IN', 'RECONFIRM', 'Both findings assessed: no impact on the lot', g.epoch))).toBe('EBMR-ARL-018');
      expect(await marketState(lot.lotId, 'IN')).toBe('RELEASE_SUSPENDED');
    } finally {
      await db.admin.query(edition('GREEN'));
    }
  }, 300_000);

  it('[L-19][PR-49] a deviation closed with a CONFIRMED impact for the market keeps it suspended (D-2a-9)', async () => {
    const lot = await readyLot(all, ['IN']);
    await manufacturerRelease(lot);
    const dev = await deviationOn('LOT', lot.lotId);
    await closeDeviation(dev, ['IN'], 'CONFIRMED');
    const p = (await db.app.query<{ p: string[] }>("select recipe.after_release_problems($1, 'IN', 'RECONFIRM') as p", [lot.lotId])).rows[0]!.p;
    const devRef = (await db.admin.query<{ r: string }>('select ref as r from site.deviation where id = $1', [dev])).rows[0]!.r;
    expect(p.join(' ')).toMatch(new RegExp(`deviation ${devRef} has a CONFIRMED impact for IN`));
    const g = await grel(lot.lotId, 'IN');
    expect(await codeOf(afterAct(ap, lot.lotId, 'IN', 'RECONFIRM', 'Impact assessed', g.epoch))).toBe('EBMR-ARL-012');
    expect(await marketState(lot.lotId, 'IN')).toBe('RELEASE_SUSPENDED');
  });
});

describe('recall, rejection after release and disposal (outline 5.2.6; L-19, PR-46, IN-05 (e); D-5-5, D-5-6)', () => {
  it('[L-19][INV-39] a market recalled on its own is final for that market only: a later cause suspends the other decided markets and leaves the recalled one as decided', async () => {
    const lot = await readyLot(all, ['IN', 'US']);
    await manufacturerRelease(lot);
    await usRelease(lot);
    // The US decision recorded in a transaction does not let that transaction move the lot register (only an IN decision does).
    const transition = "select site.lot_transition(l, 'RELEASE_RECALL', s.version, null, null) from site.material_lot l join platform.aggregate_state s on s.aggregate_type = 'material_lot' and s.aggregate_id = l.id where l.id = $1";
    const usSig = await signAs(ap, 'release_suspension', await nextId(lot.lotId, 'US', 'RECALL'), 'RECALLED', 'RELEASED');
    const both = await withCommand(db.admin, await cmd(db, ap), async (c) => {
      await c.query("select recipe.record_after_release_decision($1, 'US', 'RECALL', $2, null, 'US distributor complaint')", [lot.lotId, usSig]);
      return c.query(transition, [lot.lotId]);
    }).then(() => 'ok', (e: Error) => e.message);
    expect(both).toMatch(new RegExp(`finished lot ${lot.lotCode} is recalled or rejected after release only through the AP's signed decision for IN`));
    expect(await marketState(lot.lotId, 'US')).toBe('RELEASED');
    await w.run(ap, (c) => c.query("select recipe.record_after_release_decision($1, 'US', 'RECALL', $2, null, 'US distributor complaint: recalled from the US market only')", [lot.lotId, usSig]));
    expect(await marketState(lot.lotId, 'US')).toBe('RECALLED');
    expect(await marketState(lot.lotId, 'IN')).toBe('RELEASED');
    // Never blocked, so nothing is unblocked either (D-5-3).
    expect(await blocks(lot.lotId)).toEqual([]);
    // The US decision moves nothing in the lot register; a direct recall of the lot there is refused (no IN decision in that transaction).
    expect(await lotRegister(lot.lotId)).toBe('RELEASED');
    const direct = await withCommand(db.admin, await cmd(db, ap), (c) => c.query(transition, [lot.lotId]))
      .then(() => 'ok', (e: Error) => e.message);
    expect(direct).toMatch(new RegExp(`finished lot ${lot.lotCode} is recalled or rejected after release only through the AP's signed decision for IN`));
    expect(await lotRegister(lot.lotId)).toBe('RELEASED');
    await deviationOn('LOT', lot.lotId, 'Finding after the US recall');
    expect(await suspensions(lot.lotId)).toEqual([{ market: 'IN', cause_kind: 'DEVIATION', via_kind: 'LOT', prior_state: 'RELEASED' }]);
    expect(await marketState(lot.lotId, 'IN')).toBe('RELEASE_SUSPENDED');
    expect(await marketState(lot.lotId, 'US')).toBe('RECALLED');
  }, 180_000);

  it('[L-19] a market not decided on the lot is still removed after another market of the lot was recalled (3.3.3): only this lot\'s decision for this market keeps it in the set', async () => {
    const lot = await readyLot(all, ['IN', 'US']);
    await manufacturerRelease(lot);
    await afterAct(ap, lot.lotId, 'IN', 'RECALL', 'Recalled from the Indian market after a complaint');
    expect(await marketState(lot.lotId, 'US')).not.toMatch(/RELEASED|CERTIFIED|RELEASE_SUSPENDED/);
    const removal = await deviationOn('LOT', lot.lotId, 'US market dropped for this lot');
    const rid = (await db.app.query<{ a: string }>("select recipe.market_change_next_id('LOT', $1, 'REMOVE', 'US') as a", [lot.lotId])).rows[0]!.a;
    await signed(qaReviewer3, 'market_change', rid, 'MARKET_REMOVED', 'IN_SET', (c, sig) =>
      c.query("select recipe.record_market_change('LOT', $1, 'REMOVE', 'US', $2, $3)", [lot.lotId, removal, sig]));
    expect(await marketState(lot.lotId, 'US')).toBe('REMOVED');
  }, 180_000);


  it('[L-19][PR-46][IN-05] the AP recalls or rejects a market after release (terminal, with a reason); for IN the lot register moves in the same transaction; the rejected lot is disposed of once, a destruction completed by an independent witness', async () => {
    const recalled = await readyLot(all, ['IN', 'US']);
    await manufacturerRelease(recalled);
    await usRelease(recalled);
    const rejected = await readyLot(all, ['IN']);
    await manufacturerRelease(rejected);
    // Refused: disposal of a released lot (PR-46: a disposal follows a rejection or a recall).
    expect(await codeOf(dispose(qaReviewer3, rejected.lotId, { route: 'WITNESSED_DESTRUCTION', quantity: '1000' }))).toMatch(/EBMR-(ESIG-039|ARL-030)/);
    const disposalProblem = async (id: string) => (await db.app.query<{ p: string | null }>('select recipe.disposal_problem($1) as p', [id])).rows[0]!.p;
    expect(await disposalProblem(rejected.lotId)).toMatch(new RegExp(`^lot ${rejected.lotCode} is RELEASED for IN: a disposal follows a rejection`));
    const none = randomUUID();
    expect(await disposalProblem(none)).toBe(`${none} is no finished lot`);

    // RECALL from a decided state (D-5-5): refused without a reason, by the QCU, by an administrator.
    expect(await codeOf(afterAct(ap, recalled.lotId, 'IN', 'RECALL', null))).toBe('EBMR-ARL-013');
    for (const who of [qcu, admin]) {
      expect(await codeOf(afterAct(who, recalled.lotId, 'IN', 'RECALL', 'Complaint cluster'))).toMatch(/EBMR-(ESIG|IAM)-\d{3}/);
    }
    // A re-confirmation needs a suspension; an epoch is only for a re-confirmation.
    expect(await codeOf(afterAct(ap, recalled.lotId, 'IN', 'RECONFIRM', 'x', (await grel(recalled.lotId, 'IN')).epoch))).toBe('EBMR-ARL-012');
    expect(await codeOf(afterAct(ap, recalled.lotId, 'IN', 'RECALL', 'Complaint cluster', (await grel(recalled.lotId, 'IN')).epoch))).toBe('EBMR-ARL-014');
    await afterAct(ap, recalled.lotId, 'IN', 'RECALL', 'Complaint cluster: tablets crumbling in the blister');
    expect(await marketState(recalled.lotId, 'IN')).toBe('RECALLED');
    // The signed record stays readable as recorded (the signature is verified against it); the same number under another act is no record.
    const content = async (id: string) => (await db.admin.query<{ c: { exists: boolean; state?: string; content?: Record<string, unknown> } }>('select recipe.release_suspension_content($1) as c', [id])).rows[0]!.c;
    expect(await content(`${recalled.lotId}/IN/RECALL/1`)).toMatchObject({
      exists: true, state: 'RECORDED', market: 'IN',
      content: { lot_id: recalled.lotId, lot_code: recalled.lotCode, market: 'IN', act: 'RECALL', to_state: 'RECALLED', sequence: 1, suspensions: [] },
    });
    expect(await content(`${recalled.lotId}/IN/REJECT_AFTER_RELEASE/1`)).toEqual({ exists: false });
    expect(await lotRegister(recalled.lotId)).toBe('RECALLED');
    // INV-39: the US market reads RELEASE_SUSPENDED until the AP decides it too; terminal decisions are once per market.
    expect(await marketState(recalled.lotId, 'US')).toBe('RELEASE_SUSPENDED');
    expect(await codeOf(afterAct(ap, recalled.lotId, 'IN', 'REJECT_AFTER_RELEASE', 'again'))).toBe('EBMR-ARL-012');
    await afterAct(ap, recalled.lotId, 'US', 'RECALL', 'Same complaint cluster for the US market');
    expect(await marketState(recalled.lotId, 'US')).toBe('RECALLED');
    // A recalled market is never removed from the set afterwards (3.3.3: nothing decided is relabelled).
    const removal = await deviationOn('LOT', recalled.lotId, 'Market withdrawn after the recall');
    const rid = (await db.app.query<{ a: string }>("select recipe.market_change_next_id('LOT', $1, 'REMOVE', 'US') as a", [recalled.lotId])).rows[0]!.a;
    expect(await codeOf(signed(qaReviewer3, 'market_change', rid, 'MARKET_REMOVED', 'IN_SET', (c, sig) =>
      c.query("select recipe.record_market_change('LOT', $1, 'REMOVE', 'US', $2, $3)", [recalled.lotId, removal, sig])))).toBe('EBMR-ARL-050');
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
    // No serial numbers were drawn for this lot: no serial-decommissioning task (PR-46).
    expect(await openTasks(rejected.lotId, 'SERIAL_DECOMMISSIONING')).toEqual([]);
    expect(await lotRegister(rejected.lotId)).toBe('REJECTED');
    // Once per lot; the performer never witnesses; a person without the witness permission cannot.
    expect(await codeOf(dispose(ap, rejected.lotId, { route: 'RETURN', quantity: '1000', returnTo: 'SUPPLIER', reference: 'RT-1' }))).toMatch(/EBMR-(ESIG-011|ESIG-039|ARL-030)/);
    expect(await codeOf(witness(qaReviewer3, d))).toMatch(/EBMR-(ESIG-04[34]|ARL-043)/);
    expect(await codeOf(witness(qcu, d))).toMatch(/EBMR-(ESIG|IAM)-\d{3}/);
    // The record the witness signs: the recorded destruction, awaiting its witness; another set of details of the lot is no record.
    const dAid = (await db.app.query<{ a: string }>('select aggregate_id as a from recipe.lot_disposal where id = $1', [d])).rows[0]!.a;
    const disposalContent = async (id: string) => (await db.admin.query<{ c: { exists: boolean; state?: string; content?: Record<string, unknown> } }>('select recipe.disposal_content($1) as c', [id])).rows[0]!.c;
    expect(await disposalContent(dAid)).toMatchObject({
      exists: true, state: 'AWAITING_WITNESS',
      content: { lot_id: rejected.lotId, lot_code: rejected.lotCode, from_state: 'REJECTED_AFTER_RELEASE', route: 'WITNESSED_DESTRUCTION', quantity: '1000', reference: 'DR-2026-0007' },
    });
    expect(await disposalContent(`${rejected.lotId}/${'0'.repeat(64)}`)).toEqual({ exists: false });
    expect(await disposalContent(`${randomUUID()}/${'0'.repeat(64)}`)).toEqual({ exists: false });
    expect(await disposalContent('not-a-disposal')).toEqual({ exists: false });
    // The lot register leaves REJECTED only through the disposal completed in the same transaction (PR-46).
    const destroy = await withCommand(db.admin, await cmd(db, qaFloor), (c) =>
      c.query("select site.lot_transition(l, 'DISPOSAL_DESTROY', s.version, null, null) from site.material_lot l join platform.aggregate_state s on s.aggregate_type = 'material_lot' and s.aggregate_id = l.id where l.id = $1", [rejected.lotId]))
      .then(() => 'ok', (e: Error) => e.message);
    expect(destroy).toMatch(new RegExp(`finished lot ${rejected.lotCode} leaves its rejected state only by its recorded disposal \\(PR-46\\); no DISPOSAL_DESTROY was completed for it in this transaction`));
    expect(await lotRegister(rejected.lotId)).toBe('REJECTED');
    // The witness's own checks come before the signature: no such disposal; nothing but a destruction; once.
    const witnessDirect = (id: string) => codeOf(w.run(qaFloor, (c) => c.query('select recipe.witness_disposal($1, $2)', [id, randomUUID()])));
    expect(await witnessDirect(randomUUID())).toBe('EBMR-ARL-040');
    await witness(qaFloor, d);
    expect(await lotRegister(rejected.lotId)).toBe('DESTROYED');
    expect(await disposalContent(dAid)).toMatchObject({ exists: true, state: 'RECORDED' });
    expect(await codeOf(witness(qaFloor, d))).toMatch(/EBMR-(ESIG-039|ARL-042)/);
    expect(await witnessDirect(d)).toBe('EBMR-ARL-042');
    expect(await codeOf(db.app.query('delete from recipe.lot_disposal where id = $1', [d]))).toMatch(/permission denied/);

    // A recalled lot is returned to the customer (D-5a-4): RETURNED, with its reference.
    const ret = await dispose(ap, recalled.lotId, { route: 'RETURN', quantity: '1000', returnTo: 'CUSTOMER', reference: 'RET-2026-0042' });
    expect(await lotRegister(recalled.lotId)).toBe('RETURNED');
    expect(await witnessDirect(ret)).toBe('EBMR-ARL-041');
  });

  it('[PR-46][IN-05] a disposal states a known route, a positive quantity up to the lot\'s, a return\'s party and reference, a reprocessing record of the lot\'s own product, and no blank note; each is checked before the signature', async () => {
    const lot = await readyLot(all, ['IN']);
    await manufacturerRelease(lot);
    await afterAct(ap, lot.lotId, 'IN', 'REJECT_AFTER_RELEASE', 'Rejected after release: stability failure at 6 months');
    // TEST FIXTURE: a signed reprocessing request and a signed reprocessing authorisation of the lot's product (proven in the reprocessing tests).
    const request = randomUUID();
    const authorisation = randomUUID();
    const fx = await db.admin.connect();
    try {
      await fx.query('begin');
      await fx.query("set local session_replication_role = 'replica'");
      await fx.query(`insert into recipe.reprocessing_request (id, family_id, site_code, parent_batch_ids, investigation_ref, risk_evaluation_id, proposed_by_person, proposed_by_account, correlation_id)
                      values ($1, $2, 'SITE-1', array[$3::uuid], 'INV-RPR-1', gen_random_uuid(), $4, $4, gen_random_uuid())`, [request, all.familyId, lot.batchId, ap.personId]);
      await fx.query('insert into recipe.reprocessing_request_signature (request_id, signature_id, signer_person, recorded_by_account) values ($1, gen_random_uuid(), $2, $2)', [request, ap.personId]);
      await fx.query(`insert into recipe.reprocessing_authorisation (id, batch_id, step_id, scope, case_code, investigation_ref, risk_evaluation_ref, proposed_by_person, proposed_by_account, correlation_id)
                      values ($1, $2, 'S1', 'STEP', 'WHOLE_BATCH_REPROCESSING', 'INV-RPR-2', 'RISK-2', $3, $3, gen_random_uuid())`, [authorisation, lot.batchId, ap.personId]);
      await fx.query('insert into recipe.reprocessing_authorisation_signature (authorisation_id, signature_id, signer_person, recorded_by_account) values ($1, gen_random_uuid(), $2, $2)', [authorisation, ap.personId]);
      await fx.query('commit');
    } finally {
      fx.release();
    }
    // The checks run before the signature: a disposal that passes them fails only on the (unknown) signature, EBMR-REL-013.
    const rd = (route: string | null, quantity: string | null, returnTo: string | null = null, reference: string | null = null, reprocessing: string | null = null, text: string | null = null) =>
      codeOf(w.run(qaReviewer3, (c) => c.query('select recipe.record_disposal($1, $2, $3, $4, $5, $6, $7, $8)', [lot.lotId, route, quantity, returnTo, reference, reprocessing, text, randomUUID()])));
    expect(await rd(null, '10')).toBe('EBMR-ARL-031');
    expect(await rd('BURN', '10')).toBe('EBMR-ARL-031');
    for (const q of ['0', '-1', 'abc', '1000.5', '1000.000001', null]) expect(await rd('WITNESSED_DESTRUCTION', q)).toBe('EBMR-ARL-032');
    expect(await rd('WITNESSED_DESTRUCTION', '1000')).toBe('EBMR-REL-013');
    expect(await rd('WITNESSED_DESTRUCTION', '0.5', null, 'DR-1')).toBe('EBMR-REL-013');
    expect(await rd('RETURN', '10', null, 'RT-1')).toBe('EBMR-ARL-033');
    expect(await rd('WITNESSED_DESTRUCTION', '10', 'SUPPLIER', 'RT-1')).toBe('EBMR-ARL-033');
    expect(await rd('RETURN', '10', 'NEIGHBOUR', 'RT-1')).toBe('EBMR-ARL-033');
    expect(await rd('RETURN', '10', 'SUPPLIER', null)).toBe('EBMR-ARL-033');
    expect(await rd('RETURN', '10', 'SUPPLIER', '   ')).toBe('EBMR-ARL-033');
    expect(await rd('RETURN', '10', 'CUSTOMER', 'RT-1')).toBe('EBMR-REL-013');
    expect(await rd('REPROCESSING', '10')).toBe('EBMR-ARL-034');
    expect(await rd('WITNESSED_DESTRUCTION', '10', null, null, request)).toBe('EBMR-ARL-034');
    expect(await rd('REPROCESSING', '10', null, null, randomUUID())).toBe('EBMR-ARL-035');
    expect(await rd('REPROCESSING', '10', null, null, request)).toBe('EBMR-REL-013');
    expect(await rd('REPROCESSING', '10', null, null, authorisation)).toBe('EBMR-REL-013');
    expect(await rd('WITNESSED_DESTRUCTION', '10', null, null, null, '   ')).toBe('EBMR-ARL-036');
    expect(await rd('WITNESSED_DESTRUCTION', '10', null, null, null, 'Incinerated')).toBe('EBMR-REL-013');
    // The product compared is the lot's own: in a rolled-back transaction every other finished lot is relabelled with another
    // product, and a request of another product is named.
    const other = await db.admin.connect();
    try {
      await other.query('begin');
      await other.query("set local session_replication_role = 'replica'");
      await other.query("update site.finished_lot set product_code = 'OTHER-PRODUCT' where lot_id <> $1", [lot.lotId]);
      await other.query("update recipe.mbr_family set product_code = 'OTHER-PRODUCT' where id = $1", [all.familyId]);
      await other.query("set local session_replication_role = 'origin'");
      await other.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext({ ...(await cmd(db, qaReviewer3)) }))]);
      const msg = await other.query('select recipe.record_disposal($1, $2, $3, null, null, $4, null, $5)', [lot.lotId, 'REPROCESSING', '10', request, randomUUID()])
        .then(() => 'ok', (e: Error) => e.message);
      expect(msg).toMatch(new RegExp(`EBMR-ARL-035 the reprocessing named is for product OTHER-PRODUCT, not the lot's ${all.content.header.product.code}`));
    } finally {
      await other.query('rollback');
      other.release();
    }

    // A disposal completed in a transaction moves that lot only: another rejected lot in the same transaction does not leave
    // REJECTED with it (PR-46), whether the disposal is a return or a witnessed destruction.
    const second = await readyLot(all, ['IN']);
    await manufacturerRelease(second);
    await afterAct(ap, second.lotId, 'IN', 'REJECT_AFTER_RELEASE', 'Rejected after release: the same stability failure');
    const transition = (event: string) =>
      `select site.lot_transition(l, '${event}', s.version, null, null) from site.material_lot l join platform.aggregate_state s on s.aggregate_type = 'material_lot' and s.aggregate_id = l.id where l.id = $1`;
    const returned: Disposal = { route: 'RETURN', quantity: '1000', returnTo: 'SUPPLIER', reference: 'RT-2026-0099' };
    const returnSig = await signAs(qaReviewer3, 'disposal', disposalId(lot.lotId, returned), 'DISPOSAL_RECORDED', 'DISPOSABLE');
    const withReturn = await withCommand(db.admin, await cmd(db, qaReviewer3), async (c) => {
      await c.query("select recipe.record_disposal($1, 'RETURN', '1000', 'SUPPLIER', 'RT-2026-0099', null, null, $2)", [lot.lotId, returnSig]);
      return c.query(transition('DISPOSAL_RETURN'), [second.lotId]);
    }).then(() => 'ok', (e: Error) => e.message);
    expect(withReturn).toMatch(new RegExp(`finished lot ${second.lotCode} leaves its rejected state only by its recorded disposal \\(PR-46\\); no DISPOSAL_RETURN was completed for it in this transaction`));
    const destroyed = await dispose(qaReviewer3, lot.lotId, { route: 'WITNESSED_DESTRUCTION', quantity: '1000' });
    const aid = (await db.app.query<{ a: string }>('select aggregate_id as a from recipe.lot_disposal where id = $1', [destroyed])).rows[0]!.a;
    const witnessSig = await signAs(qaFloor, 'disposal', aid, 'DESTRUCTION_WITNESSED', 'AWAITING_WITNESS');
    const withDestroy = await withCommand(db.admin, await cmd(db, qaFloor), async (c) => {
      await c.query('select recipe.witness_disposal($1, $2)', [destroyed, witnessSig]);
      return c.query(transition('DISPOSAL_DESTROY'), [second.lotId]);
    }).then(() => 'ok', (e: Error) => e.message);
    expect(withDestroy).toMatch(new RegExp(`finished lot ${second.lotCode} leaves its rejected state only by its recorded disposal \\(PR-46\\); no DISPOSAL_DESTROY was completed for it in this transaction`));
    expect(await lotRegister(second.lotId)).toBe('REJECTED');
  }, 300_000);

  it('[L-19][INV-35] an after-release decision is the authorised person\'s: a person of another role the site gave the release permission still cannot record one (EBMR-ARL-015)', async () => {
    const lot = await readyLot(all, ['IN']);
    await manufacturerRelease(lot);
    // Last in the file: the site's grant stays for the rest of the run.
    const request = await withCommand(db.app, underChange(withReason(admin)), async (c) =>
      (await c.query<{ id: string }>("select iam.add_role_permission('QA_SHOP_FLOOR', 'RELEASE.MANUFACTURER', 'the site lets shop-floor QA hold the release permission') as id")).rows[0]!.id);
    await withCommand(db.app, underChange(withReason(owner)), (c) => c.query("select iam.decide_role_permission($1, true, 'approved for the role test')", [request]));
    expect(await codeOf(afterAct(qaFloor, lot.lotId, 'IN', 'RECALL', 'Recall attempted by shop-floor QA'))).toBe('EBMR-ARL-015');
    expect(await marketState(lot.lotId, 'IN')).toBe('RELEASED');
  }, 180_000);
});
