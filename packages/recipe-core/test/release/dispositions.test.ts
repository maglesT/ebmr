/**
 * The US and EU market dispositions, market add and removal, and the transcribed and in-system EU certification in the
 * database (Phase 4 slice 4a; recipe-core 0821 to 0824; outline 3.3.3, 5.2.6, 5.2.7 items 8 and 11). Every act runs as
 * the application role through the definers with real e-signatures of seeded people, and each rule is also tried around
 * (direct writes, another person's signature, the wrong role, a stale evaluation).
 *
 * The evidence is built as in release.test.ts: GMP batches issued from an effective master (here authorised for IN, US
 * and EU, or for IN only), reviewed through the real review acts, the finished lot posted by the edition's definer, its
 * release results approved by the head of QC and its reserve samples; a test edition answers groups 4, 9 and 10.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withProtectedNumbers } from '../../../kernel/src/continuity/numbers.ts';
import { tempDir, tempLedger } from '../../../kernel/test/continuity/helpers.ts';
import { withCommand } from '../../../kernel/src/db/command.ts';
import { createChallenge, contentForSigning, sign } from '../../../kernel/src/esig/signing.ts';
import { challengeFor, cmd, ensureSealKey, signatureAuth, signWith, testSealKey } from '../../../kernel/test/esig/helpers.ts';
import { signFor } from '../../../kernel/test/records/helpers.ts';
import { seedActor, seedAdministration, seedServiceActor, withReason, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import type { MbrContent } from '../../src/flow/model.ts';
import * as execution from '../../src/execution/index.ts';
import type * as lc from '../../src/lifecycle/index.ts';
import { define, FIXTURE_INPUTS, FIXTURE_JUSTIFICATIONS } from '../engine/support.ts';
import { gmpOrderFor } from '../lifecycle/gmp-support.ts';
import { cell, reason, seedCast, uniqueContent, World } from '../lifecycle/support.ts';
import { dueDate } from './deviation-path.ts';

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
let qp: SeededActor;
let erp: SeededActor;
let owner: SeededActor;
let admin: SeededActor;
type Master = { familyId: string; versionId: string; content: MbrContent };
let all: Master;
let indiaOnly: Master;
let extended: Master;
const dir = tempDir('dispositions');
const ledger = tempLedger('dispositions', dir.path);

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
const item = (g: Grel, id: string): Item => {
  const i = g.items.find((x) => x.id === id);
  if (!i) throw new Error(`no item ${id} in ${g.items.map((x) => x.id).join(', ')}`);
  return i;
};
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

async function deviationOnLot(lotId: string): Promise<string> {
  const d = await sqlAs<{ deviationId: string }>(operator, 'select site.raise_deviation($1::jsonb) as r', [
    JSON.stringify({ kind: 'DEVIATION', title: 'Rejected for one market', classification: 'MAJOR', riskRationale: 'Investigated for every market of the lot' }),
  ]);
  await w.run(operator, (c) => c.query("select site.link_deviation($1, 'LOT', $2)", [d.deviationId, lotId]));
  return d.deviationId;
}

/** QA's classification, the finding and the signed impact per market of an open deviation (site services 0820 to 0824). */
async function assessedOpen(deviationId: string, impacts: Partial<Record<Market, 'NONE' | 'POTENTIAL' | 'CONFIRMED'>>): Promise<void> {
  await w.run(qaReviewer, (c) => c.query('select site.start_deviation_investigation($1, $2::jsonb)', [deviationId, JSON.stringify({
    classification: 'MAJOR', riskRationale: 'QA classification after the first review of the facts', ownerPersonId: qaReviewer.personId, dueDate: dueDate() })]));
  await w.run(qaReviewer, (c) => c.query('select site.record_deviation_finding($1, $2::jsonb)', [deviationId, JSON.stringify({
    assignableCause: true, cause: 'Dissolution drift traced to one granulation lot', rootCauseCategory: 'MATERIAL' })]));
  const links = (await db.app.query<{ id: string }>('select id from site.deviation_link where deviation_id = $1', [deviationId])).rows;
  for (const l of links) {
    for (const [market, impact] of Object.entries(impacts)) {
      await w.run(qaReviewer, (c) => c.query('select site.record_deviation_impact($1, $2::jsonb)', [deviationId, JSON.stringify({ linkId: l.id, market, impact, rationale: 'Assessed against the finding' })]));
    }
  }
  const sig = await signFor(db, qaReviewer2, { type: 'deviation', id: deviationId }, 'DEVIATION_IMPACT_ASSESSED', 'UNDER_INVESTIGATION');
  await w.run(qaReviewer2, (c) => c.query('select site.assess_deviation_impact($1, $2)', [deviationId, sig]));
}

async function changeRecord(): Promise<string> {
  const { rows } = await db.app.query<{ id: string }>('select id from recipe.change_record order by recorded_at limit 1');
  return rows[0]!.id;
}

async function marketChange(who: SeededActor, kind: 'LOT' | 'BATCH', id: string, change: 'ADD' | 'REMOVE', market: Market, ref: string): Promise<string> {
  const aid = (await db.app.query<{ a: string }>('select recipe.market_change_next_id($1, $2, $3, $4) as a', [kind, id, change, market])).rows[0]!.a;
  const st = (await db.app.query<{ s: boolean }>('select $1 = any (recipe.market_set($2, $3)) as s', [market, kind, id])).rows[0]!.s ? 'IN_SET' : 'NOT_IN_SET';
  return signed(who, 'market_change', aid, change === 'ADD' ? 'MARKET_ADDED' : 'MARKET_REMOVED', st, async (c, sig) =>
    (await c.query<{ id: string }>('select recipe.record_market_change($1, $2, $3, $4, $5, $6) as id', [kind, id, change, market, ref, sig])).rows[0]!.id);
}

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
  ({ owner, admin } = await seedAdministration(db));
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
  qp = await seedActor(db, { roleCode: 'EU_QP', legalName: 'Dr. Lena Vogel' });
  erp = await seedServiceActor(db, { kind: 'INTEGRATION', source: 'INTEGRATION', roleCode: 'ERP_INTERFACE', name: 'ERP interface' });
  all = await effective(['IN', 'US', 'EU']);
  indiaOnly = await effective(['IN']);
  extended = await effective(['IN', 'US', 'EU'], 'Extended-release tablet');
  await productAndSpecification(all.content);
  await productAndSpecification(indiaOnly.content);
  await productAndSpecification(extended.content, [{ testCode: 'RELEASE_RATE.MAT-ATV', lowerLimit: '80', upperLimit: '100' }]);

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
    // TEST STAND-IN for the edition's intake definer (tablets 1180 verifies the importer's Ed25519 signature; its tests
    // prove the verification): hands a message to recipe.take_qp_message as signed, or as not signed.
    await fx.query('set local role ebmr_owner');
    await fx.query(`create function test_edition.take_qp_message(p_message text, p_signed boolean) returns jsonb language sql volatile security definer
      set search_path = pg_catalog, recipe, pg_temp as $$ select recipe.take_qp_message(p_message, p_signed) $$`);
    await fx.query('grant execute on function test_edition.take_qp_message(text, boolean) to ebmr_app');
    await fx.query('reset role');
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

describe('the US disposition (outline 5.2.6; PR-54, INV-39, DI-39)', () => {
  it('[PR-54][INV-39][DI-39] the QCU releases a lot for the US only once the manufacturer release is RELEASED; QA, the AP and an administrator cannot; the checklist is stored with the signature', async () => {
    const lot = await readyLot();
    expect(await state(lot.lotId, 'US')).toBe('READY');
    expect(await state(lot.lotId, 'EU')).toBe('NOT_READY');
    const g = await grel(lot.lotId, 'US');
    expect(red(g)).toEqual([]);
    expect(item(g, 'G11.REGISTRATION').status).toBe('GREEN');
    expect(item(g, 'G11.MARKET_IN_SET').status).toBe('GREEN');
    expect(item(g, 'G8.MARKET_ADD').status).toBe('NA');
    expect(item(g, 'G11.US_RELEASE_RATE').status).toBe('NA');
    await acknowledgeAll(qcu, lot.lotId, 'US', g);
    // INV-39: the manufacturer release is not RELEASED yet.
    expect(await codeOf(usAct(qcu, lot.lotId, 'RELEASE', g.epoch))).toBe('EBMR-DSP-033');

    await manufacturerRelease(lot);
    // DI-39: nobody but the QCU role signs or records a US disposition.
    for (const who of [qaReviewer3, ap, head, admin]) {
      expect(await codeOf(usAct(who, lot.lotId, 'RELEASE', g.epoch))).toMatch(/EBMR-(ESIG|IAM)-\d{3}/);
    }
    // The manufacturer release moved the lot (its status): the US evaluation is a new one, acknowledged again.
    const g2 = await grel(lot.lotId, 'US');
    await acknowledgeAll(qcu, lot.lotId, 'US', g2);
    // INV-05: a stale evaluation is refused (and the signature made with it rolls back).
    expect(await codeOf(usAct(qcu, lot.lotId, 'RELEASE', 'd'.repeat(64)))).toBe('EBMR-DSP-036');
    // Bypass: the QCU's valid signature does not let a QA person record the act.
    const qcuSig = await signAs(qcu, 'us_disposition', `${lot.lotId}/REJECT`, 'US_DISPOSITION', 'READY');
    expect(await codeOf(w.run(qaReviewer3, (c) => c.query("select recipe.record_us_disposition($1, 'REJECT', $2, $3, 'x', null)", [lot.lotId, qcuSig, g.epoch])))).toMatch(/EBMR-IAM-\d{3}/);
    // A rejection signature never records a release.
    expect(await codeOf(w.run(qcu, (c) => c.query("select recipe.record_us_disposition($1, 'RELEASE', $2, $3, null, null)", [lot.lotId, qcuSig, g2.epoch])))).toBe('EBMR-REL-013');

    await usAct(qcu, lot.lotId, 'RELEASE', g2.epoch);
    expect(await state(lot.lotId, 'US')).toBe('RELEASED');
    // US and EU are independent (S32): the EU disposition waits for its own certification.
    expect(await state(lot.lotId, 'EU')).toBe('AWAITING_QP_CERTIFICATION');
    const { rows } = await db.app.query<{ decision: string; epoch: string; person_id: string; with_manufacturer_release: boolean; signature_id: string }>(
      'select decision, epoch, person_id, with_manufacturer_release, signature_id from recipe.us_disposition_decision where lot_id = $1', [lot.lotId]);
    expect(rows[0]).toMatchObject({ decision: 'RELEASED', epoch: g2.epoch, person_id: qcu.personId, with_manufacturer_release: false });
    expect((await db.app.query<{ v: boolean }>("select (esig.signature_state($1) ->> 'valid')::boolean as v", [rows[0]!.signature_id])).rows[0]!.v).toBe(true);
    expect(await codeOf(w.run(qcu, (c) => c.query("select recipe.record_us_disposition($1, 'RELEASE', $2, $3, null, null)", [lot.lotId, rows[0]!.signature_id, g2.epoch])))).toBe('EBMR-DSP-035');
    expect(await codeOf(db.app.query("update recipe.us_disposition_decision set decision = 'REJECTED' where lot_id = $1", [lot.lotId]))).toMatch(/permission denied/);
    expect(await codeOf(db.app.query("insert into recipe.us_disposition_decision (lot_id, decision, signature_id, epoch, checklist, checklist_hash, content_hash, person_id, account_id, role_code, correlation_id) values (gen_random_uuid(), 'RELEASED', gen_random_uuid(), $1, '{}', $1, 'x', gen_random_uuid(), gen_random_uuid(), 'X', gen_random_uuid())", ['a'.repeat(64)]))).toMatch(/permission denied/);
  });

  it('[PR-54] an extended-release lot missing one active\'s release-rate result cannot be released for the US; with it approved it can', async () => {
    const lot = await readyLot(extended);
    await manufacturerRelease(lot);
    let g = await grel(lot.lotId, 'US');
    expect(red(g)).toEqual(['G11.US_RELEASE_RATE']);
    expect(item(g, 'G11.US_RELEASE_RATE').problem).toMatch(/RELEASE_RATE\.MAT-ATV/);
    expect(await state(lot.lotId, 'US')).toBe('NOT_READY');
    await acknowledgeAll(qcu, lot.lotId, 'US', g);
    expect(await codeOf(usAct(qcu, lot.lotId, 'RELEASE', g.epoch))).toBe('EBMR-DSP-037');
    // The EU checklist has no US item: EU waits for its own certification.
    expect(red(await grel(lot.lotId, 'EU'))).toEqual([]);

    await result(lot.lotId, 'RELEASE_RATE.MAT-ATV', '92');
    g = await grel(lot.lotId, 'US');
    expect(item(g, 'G11.US_RELEASE_RATE').status).toBe('GREEN');
    await acknowledgeAll(qcu, lot.lotId, 'US', g);
    await usAct(qcu, lot.lotId, 'RELEASE', g.epoch);
    expect(await state(lot.lotId, 'US')).toBe('RELEASED');
  });

  it('[PR-56] a US rejection states its reason and names the investigation linked to the lot; the EU sees it and assesses that record for itself', async () => {
    const lot = await readyLot();
    // Slice 5a (L-19): a deviation linked after the release suspends it, and INV-39 then holds every market disposition,
    // a rejection included. The investigation is linked before the release here, with QA's signed impact NONE for IN and
    // POTENTIAL for the export markets, so the manufacturer release goes ahead and the export markets wait on it.
    const deviation = await deviationOnLot(lot.lotId);
    await assessedOpen(deviation, { IN: 'NONE', US: 'POTENTIAL', EU: 'POTENTIAL' });
    await manufacturerRelease(lot);
    let g = await grel(lot.lotId, 'US');
    expect(await codeOf(usAct(qcu, lot.lotId, 'REJECT', g.epoch, null, null))).toBe('EBMR-DSP-039');
    expect(await codeOf(usAct(qcu, lot.lotId, 'REJECT', g.epoch, 'Dissolution trend outside the US registration', null))).toBe('EBMR-DSP-040');
    g = await grel(lot.lotId, 'US');
    await usAct(qcu, lot.lotId, 'REJECT', g.epoch, 'Dissolution trend outside the US registration', deviation);
    expect(await state(lot.lotId, 'US')).toBe('REJECTED');
    const eu = await grel(lot.lotId, 'EU');
    // The rejection is visible (its investigation is linked) and the EU assesses the deviation itself (G2).
    expect(item(eu, 'G11.MARKET_REJECTIONS').status).toBe('GREEN');
    expect(red(eu)).toContain('G2.DEVIATIONS');
    expect(await state(lot.lotId, 'EU')).toBe('NOT_READY');
  });

  it('[INV-39] rejecting the manufacturer release moves every export market of the lot to NOT_READY in the same transaction', async () => {
    const lot = await readyLot();
    expect(await state(lot.lotId, 'US')).toBe('READY');
    const sig = await signAs(ap, 'manufacturer_release', `${lot.lotId}/REJECT`, 'MANUFACTURER_RELEASE', 'READY');
    const g = await grel(lot.lotId, 'IN');
    await w.run(ap, (c) => c.query("select recipe.record_manufacturer_release($1, 'REJECT', $2, $3, 'Assay trend investigated: lot not released')", [lot.lotId, sig, g.epoch]));
    expect(await state(lot.lotId, 'US')).toBe('NOT_READY');
    expect(await state(lot.lotId, 'EU')).toBe('NOT_READY');
    const { rows } = await db.app.query<{ market: string; to_state: string; same: boolean }>(
      `select e.market, e.to_state, e.xact_id = d.xact_id as same from recipe.market_disposition_event e join recipe.manufacturer_release_decision d on d.lot_id = e.lot_id
        where e.lot_id = $1 order by e.market`, [lot.lotId]);
    expect(rows).toEqual([{ market: 'EU', to_state: 'NOT_READY', same: true }, { market: 'US', to_state: 'NOT_READY', same: true }]);
    // No market disposition follows a rejected manufacturer release.
    const us = await grel(lot.lotId, 'US');
    expect(await codeOf(usAct(qcu, lot.lotId, 'RELEASE', us.epoch))).toBe('EBMR-DSP-033');
  });
});

describe('two signature rows in one ceremony (D-P4-5)', () => {
  it('[INV-39][PR-54] the AP who also holds the QCU permission releases for the manufacturer and the US in one command: two rows, each its own meaning and content; a stale US evaluation records neither', async () => {
    const request = await withCommand(db.app, withReason(admin), async (c) => (await c.query<{ id: string }>("select iam.add_role_permission('AUTHORISED_PERSON', 'RELEASE.US_DISPOSITION', 'the AP holds the QCU permission at this site') as id")).rows[0]!.id);
    await withCommand(db.app, withReason(owner), (c) => c.query("select iam.decide_role_permission($1, true, 'approved for the two-row release')", [request]));

    const both = async (lot: Lot, usEpoch?: string): Promise<{ mr: string; us: string }> => {
      const gin = await grel(lot.lotId, 'IN');
      const gus = await grel(lot.lotId, 'US');
      await acknowledgeAll(ap, lot.lotId, 'IN', gin);
      await acknowledgeAll(ap, lot.lotId, 'US', gus);
      await ensureSealKey(db);
      const ids = [`${lot.lotId}/RELEASE`, `${lot.lotId}/RELEASE`];
      const types = ['manufacturer_release', 'us_disposition'];
      const meanings = ['MANUFACTURER_RELEASE', 'US_DISPOSITION'];
      const chs: { challengeId: string }[] = [];
      for (let i = 0; i < 2; i++) {
        const content = await contentForSigning(db.app, types[i]!, ids[i]!);
        chs.push(await withCommand(db.app, await cmd(db, ap), (c) => createChallenge(c, { aggregateType: types[i]!, aggregateId: ids[i]!, contentVersion: content.contentVersion ?? '1', meaning: meanings[i]!, clientContentHash: content.contentHash ?? '' })));
      }
      const evs = [await signatureAuth(db, ap, ap, chs[0]!.challengeId), await signatureAuth(db, ap, ap, chs[1]!.challengeId)];
      // One command: both signatures and the act.
      return withCommand(db.app, await cmd(db, ap), async (c) => {
        const mr = await sign(c, { challengeId: chs[0]!.challengeId, authEventId: evs[0]!, expectedState: 'READY' }, testSealKey);
        const us = await sign(c, { challengeId: chs[1]!.challengeId, authEventId: evs[1]!, expectedState: 'READY' }, testSealKey);
        await c.query('select recipe.record_release_with_us_disposition($1, $2, $3, $4, $5)', [lot.lotId, mr.signatureId, us.signatureId, gin.epoch, usEpoch ?? gus.epoch]);
        return { mr: mr.signatureId, us: us.signatureId };
      });
    };

    const stale = await readyLot();
    expect(await codeOf(both(stale, 'f'.repeat(64)))).toBe('EBMR-DSP-036');
    expect(await state(stale.lotId, 'IN')).toBe('READY');

    const lot = await readyLot();
    const rows = await both(lot);
    expect(await state(lot.lotId, 'IN')).toBe('RELEASED');
    expect(await state(lot.lotId, 'US')).toBe('RELEASED');
    const sigs = await db.app.query<{ meaning_code: string; aggregate_type: string; content_hash: string; valid: boolean }>(
      "select s.meaning_code, s.aggregate_type, s.content_hash, (esig.signature_state(s.id) ->> 'valid')::boolean as valid from esig.signature s where s.id = any ($1::uuid[]) order by s.meaning_code",
      [[rows.mr, rows.us]]);
    expect(sigs.rows.map((r) => [r.meaning_code, r.aggregate_type, r.valid])).toEqual([['MANUFACTURER_RELEASE', 'manufacturer_release', true], ['US_DISPOSITION', 'us_disposition', true]]);
    expect(sigs.rows[0]!.content_hash).not.toBe(sigs.rows[1]!.content_hash);
    expect((await db.app.query<{ m: boolean }>('select with_manufacturer_release as m from recipe.us_disposition_decision where lot_id = $1', [lot.lotId])).rows[0]!.m).toBe(true);

    // Two signatures made in separate commands are not one ceremony.
    const split = await readyLot();
    const gin = await grel(split.lotId, 'IN');
    const gus = await grel(split.lotId, 'US');
    await acknowledgeAll(ap, split.lotId, 'IN', gin);
    await acknowledgeAll(ap, split.lotId, 'US', gus);
    const mr = await signAs(ap, 'manufacturer_release', `${split.lotId}/RELEASE`, 'MANUFACTURER_RELEASE', 'READY');
    const us = await signAs(ap, 'us_disposition', `${split.lotId}/RELEASE`, 'US_DISPOSITION', 'READY');
    expect(await codeOf(w.run(ap, (c) => c.query('select recipe.record_release_with_us_disposition($1, $2, $3, $4, $5)', [split.lotId, mr, us, gin.epoch, gus.epoch])))).toBe('EBMR-DSP-042');
    expect(await codeOf(w.run(qcu, (c) => c.query('select recipe.record_release_with_us_disposition($1, $2, $3, $4, $5)', [split.lotId, mr, us, gin.epoch, gus.epoch])))).toBe('EBMR-DSP-042');
  });
});

describe('market add and removal (outline 3.3.3; INV-43)', () => {
  it('[INV-43] US added after issue to a batch made on a master never authorised for the US: the evaluation is UNMET_FINAL, the market INELIGIBLE (terminal), its disposition never READY', async () => {
    const lot = await readyLot(indiaOnly, ['IN']);
    expect(await state(lot.lotId, 'US')).toBeNull();
    const ev = (await db.app.query<{ e: { outcome: string; items: { id: string; outcome: string; detail: string | null }[] } }>("select recipe.market_add_evaluate('LOT', $1, 'US') as e", [lot.lotId])).rows[0]!.e;
    expect(ev.outcome).toBe('UNMET_FINAL');
    expect(ev.items.find((i) => i.id === 'MA.MBR_AUTHORISATION')).toMatchObject({ outcome: 'UNMET_FINAL' });
    // QA only, under a change record; India is never added or removed.
    expect(await codeOf(marketChange(operator, 'LOT', lot.lotId, 'ADD', 'US', await changeRecord()))).toMatch(/EBMR-(ESIG|IAM)-\d{3}/);
    expect(await codeOf(marketChange(qaReviewer3, 'LOT', lot.lotId, 'ADD', 'US', randomUUID()))).toBe('EBMR-DSP-015');
    expect(await codeOf(w.run(qaReviewer3, (c) => c.query("select recipe.record_market_change('LOT', $1, 'REMOVE', 'IN', $2, $3)", [lot.lotId, randomUUID(), randomUUID()])))).toBe('EBMR-DSP-013');
    await marketChange(qaReviewer3, 'LOT', lot.lotId, 'ADD', 'US', await changeRecord());
    expect(await state(lot.lotId, 'US')).toBe('INELIGIBLE');
    const g = await grel(lot.lotId, 'US');
    expect(red(g)).toEqual(expect.arrayContaining(['G8.MARKET_ADD', 'G11.REGISTRATION', 'G11.MARKET_IN_SET']));
    await manufacturerRelease(lot);
    expect(await state(lot.lotId, 'US')).toBe('INELIGIBLE');
    expect(await codeOf(usAct(qcu, lot.lotId, 'RELEASE', g.epoch))).toBe('EBMR-DSP-032');
    expect(await codeOf(db.app.query("insert into recipe.market_change (subject_kind, subject_id, seq, change, market, deviation_id, content, signature_id, person_id, account_id) values ('LOT', $1, 9, 'REMOVE', 'US', gen_random_uuid(), '{}', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())", [lot.lotId]))).toMatch(/permission denied/);
  });

  it('[INV-43] a market added with a recoverable item is not READY until the item is met; the batch-level addition makes the records the market\'s', async () => {
    // An India-only batch and lot on a master authorised for all three: the addition is valid, the reserve samples missing.
    const batchId = await issuedBatch(all, ['IN']);
    await review(batchId);
    const lotId = await finishedLot(batchId, all, ['IN']);
    await result(lotId, 'ASSAY', '99.1');
    await marketChange(qaReviewer3, 'BATCH', batchId, 'ADD', 'EU', await changeRecord());
    await marketChange(qaReviewer3, 'LOT', lotId, 'ADD', 'EU', await changeRecord());
    expect(await state(lotId, 'EU')).toBe('NOT_READY');
    const g = await grel(lotId, 'EU');
    expect(red(g)).toContain('G8.MARKET_ADD');
    expect(item(g, 'G8.MARKET_ADD').problem).toMatch(/MA\.RESERVE_SAMPLES UNMET_RECOVERABLE/);
    expect(item(g, 'G11.MARKET_IN_SET').status).toBe('GREEN');
    await w.run(analyst, (c) => c.query('select site.pull_lot_sample($1, $2::jsonb)', [lotId, JSON.stringify({ kind: 'RESERVE', quantity: '40', container: 'Marketed blister in carton', storageLocation: 'Reserve room R-2' })]));
    expect(item(await grel(lotId, 'EU'), 'G8.MARKET_ADD').status).toBe('GREEN');
  });

  it('[INV-43] a removal names a deviation linked to the lot and is flagged "removed after failure" when the market failed; a decided market is never removed', async () => {
    const lot = await readyLot();
    expect(await codeOf(marketChange(qaReviewer3, 'LOT', lot.lotId, 'REMOVE', 'EU', randomUUID()))).toBe('EBMR-DSP-018');
    const deviation = await deviationOnLot(lot.lotId);
    // QA records a potential impact of the deviation for the EU: a failure against the EU's rules.
    await w.run(qaReviewer, (c) => c.query('select site.start_deviation_investigation($1, $2::jsonb)', [deviation, JSON.stringify({ classification: 'MAJOR', riskRationale: 'QA classification after the first review of the facts', ownerPersonId: qaReviewer2.personId, dueDate: '2027-01-28' })]));
    const link = (await db.app.query<{ id: string }>('select id from site.deviation_link where deviation_id = $1', [deviation])).rows[0]!.id;
    await w.run(qaReviewer2, (c) => c.query('select site.record_deviation_impact($1, $2::jsonb)', [deviation, JSON.stringify({ linkId: link, market: 'EU', impact: 'POTENTIAL', rationale: 'The EU limit is tighter than the registered one here' })]));
    const id = await marketChange(qaReviewer3, 'LOT', lot.lotId, 'REMOVE', 'EU', deviation);
    const row = (await db.app.query<{ removed_after_failure: boolean }>('select removed_after_failure from recipe.market_change where id = $1', [id])).rows[0]!;
    expect(row.removed_after_failure).toBe(true);
    expect(await state(lot.lotId, 'EU')).toBe('REMOVED');
    expect((await db.app.query<{ s: string[] }>("select recipe.market_set('LOT', $1) as s", [lot.lotId])).rows[0]!.s).toEqual(['IN', 'US']);
    // The original resolution stays: the finished lot still records its posted set.
    expect((await db.app.query<{ m: string[] }>('select markets as m from site.finished_lot where lot_id = $1', [lot.lotId])).rows[0]!.m).toEqual(ALL);

    // A RELEASED market is not removed here.
    const released = await readyLot();
    await manufacturerRelease(released);
    const g = await grel(released.lotId, 'US');
    await acknowledgeAll(qcu, released.lotId, 'US', g);
    await usAct(qcu, released.lotId, 'RELEASE', g.epoch);
    const d2 = await deviationOnLot(released.lotId);
    expect(await codeOf(marketChange(qaReviewer3, 'LOT', released.lotId, 'REMOVE', 'US', d2))).toBe('EBMR-DSP-019');
  });

  it('a market is added to an issued processing batch (before a packaging order for it) and evaluated against the master the batch was made on', async () => {
    // Tried directly at the trigger: a batch allocation link of a packaging order whose stub names a market the parent lacks.
    const parent = await issuedBatch(indiaOnly, ['IN']);
    const { rows } = await db.app.query<{ ok: boolean }>("select not ('US' = any (recipe.market_set('BATCH', $1))) as ok", [parent]);
    expect(rows[0]!.ok).toBe(true);
    // The market add on the parent is the way in; it evaluates against the master (never authorised for the US: UNMET_FINAL).
    await marketChange(qaReviewer3, 'BATCH', parent, 'ADD', 'US', await changeRecord());
    expect((await db.app.query<{ s: string[] }>("select recipe.market_set('BATCH', $1) as s", [parent])).rows[0]!.s).toEqual(['IN', 'US']);
    expect((await db.app.query<{ o: string }>("select evaluation ->> 'outcome' as o from recipe.market_change where subject_id = $1", [parent])).rows[0]!.o).toBe('UNMET_FINAL');
  });
});

describe('the EU certification (outline 5.2.6 EU; DI-39, DI-30, PR-55)', () => {
  const importerCode = `EUIMP-${randomUUID().slice(0, 6).toUpperCase()}`;
  const mia = 'DE-MIA-2024-118';

  async function importer(products: string[]): Promise<void> {
    const def = { code: importerCode, name: 'Example Pharma Import GmbH', technicalAgreementRef: 'TA-2026-007', miaNumber: mia, publicKey: Buffer.alloc(32, 7).toString('base64'), products };
    const sha = (await db.app.query<{ h: string }>("select encode(sha256(convert_to(recipe.eu_importer_canonical($1::jsonb), 'UTF8')), 'hex') as h", [JSON.stringify(def)])).rows[0]!.h;
    const sig = await signAs(qaReviewer3, 'eu_importer', `${importerCode}/${sha}`, 'EU_IMPORTER_APPROVED', 'NEW');
    await w.run(qaReviewer3, (c) => c.query('select recipe.register_eu_importer($1::jsonb, $2)', [JSON.stringify(def), sig]));
  }

  const transcribe = async (who: SeededActor, lotId: string, outcome: string, at: string, reasonText: string | null = null): Promise<string> => {
    const f = [outcome, 'Dr. Lena Vogel', mia, at, 'QP-CERT-2026-0412', reasonText] as const;
    const sha = (await db.app.query<{ h: string }>('select recipe.qp_details_sha256($1, $2, $3, $4, $5, $6) as h', [...f])).rows[0]!.h;
    return signed(who, 'qp_transcription', `${lotId}/${sha}`, 'QP_CERTIFICATION_RECORDED', await state(lotId, 'EU'), async (c, sig) =>
      (await c.query<{ id: string }>('select recipe.record_qp_transcription($1, $2, $3, $4, $5, $6, $7, $8) as id', [lotId, ...f, sig])).rows[0]!.id);
  };
  const verify = async (who: SeededActor, id: string): Promise<unknown> => {
    return signed(who, 'qp_transcription_check', id, 'QP_CERTIFICATION_VERIFIED', 'TRANSCRIBED', (c, sig) => c.query('select recipe.verify_qp_transcription($1, $2)', [id, sig]));
  };

  it('[DI-30][DI-39][INV-39] a transcribed certification counts only once a second QA person verifies it, never the transcriber, and only while the lot awaits certification', async () => {
    const lot = await readyLot();
    await importer([lot.productCode, extended.content.header.product.code]);
    const now = new Date().toISOString();
    // INV-39: the manufacturer release is not RELEASED: nothing is recorded.
    expect(await codeOf(transcribe(qaReviewer3, lot.lotId, 'CERTIFIED', now))).toBe('EBMR-DSP-033');
    await manufacturerRelease(lot);
    expect(await state(lot.lotId, 'EU')).toBe('AWAITING_QP_CERTIFICATION');
    expect(await codeOf(transcribe(qaReviewer3, lot.lotId, 'CERTIFIED', '12.10.2026'))).toBe('EBMR-DSP-067');
    expect(await codeOf(transcribe(qaReviewer3, lot.lotId, 'CERTIFIED', '2099-01-01T00:00:00Z'))).toBe('EBMR-DSP-056');
    const at = (await db.app.query<{ t: string }>(`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as t`)).rows[0]!.t;
    const id = await transcribe(qaReviewer3, lot.lotId, 'CERTIFIED', at);
    expect(await state(lot.lotId, 'EU')).toBe('AWAITING_QP_CERTIFICATION');
    expect(await codeOf(verify(qaReviewer3, id))).toMatch(/EBMR-(DSP-072|ESIG-04\d)/);
    expect(await codeOf(verify(operator, id))).toMatch(/EBMR-(ESIG|IAM)-\d{3}/);
    await verify(qaReviewer2, id);
    expect(await state(lot.lotId, 'EU')).toBe('CERTIFIED');
    // The register is append-only; a second outcome is refused.
    expect(await codeOf(transcribe(qaReviewer3, lot.lotId, 'REJECTED_BY_QP', at, 'Late'))).toBe('EBMR-DSP-051');
    expect(await codeOf(db.app.query("update recipe.qp_certification set outcome = 'REJECTED_BY_QP' where id = $1", [id]))).toMatch(/permission denied/);
    expect(await codeOf(db.app.query('delete from recipe.qp_transcription_check where certification_id = $1', [id]))).toMatch(/permission denied/);
  });

  it('[PR-55][DI-39] in-system certification is off by default; switched on, only a registered QP certifies, never QA or the AP, and the register entry is written at signature', async () => {
    const lot = await readyLot();
    await manufacturerRelease(lot);
    let g = await grel(lot.lotId, 'EU');
    const certify = async (who: SeededActor, epoch: string): Promise<unknown> => {
      return signed(who, 'qp_certification', `${lot.lotId}/CERTIFIED`, 'QP_CERTIFIED', 'AWAITING_QP_CERTIFICATION', (c, sig) =>
        c.query("select recipe.record_qp_certification($1, 'CERTIFIED', $2, $3, null)", [lot.lotId, sig, epoch]));
    };
    expect(await codeOf(certify(qp, g.epoch))).toBe('EBMR-DSP-073');
    await withCommand(db.app, withReason(owner), (c) => c.query("select platform.set_setting('release.in_system_qp_certification', 'ON')"));
    try {
      for (const who of [qaReviewer3, ap, head]) expect(await codeOf(certify(who, g.epoch))).toMatch(/EBMR-(ESIG|IAM)-\d{3}/);
      expect(await codeOf(certify(admin, g.epoch))).toMatch(/EBMR-(ESIG|IAM)-\d{3}/);
      // The QP role alone is not enough: the QP is registered by QA on the importer's authorisation.
      expect(await codeOf(certify(qp, g.epoch))).toBe('EBMR-DSP-074');
      const reg = await signAs(qaReviewer3, 'qp_register', `${qp.personId}/REGISTER/${importerCode}/${mia}`, 'QP_REGISTERED', 'NONE');
      await w.run(qaReviewer3, (c) => c.query("select recipe.register_qp($1, 'REGISTER', $2, $3, $4)", [qp.personId, importerCode, mia, reg]));
      g = await grel(lot.lotId, 'EU');
      await acknowledgeAll(qp, lot.lotId, 'EU', g);
      expect(await codeOf(certify(qp, 'e'.repeat(64)))).toBe('EBMR-DSP-075');
      await certify(qp, g.epoch);
      expect(await state(lot.lotId, 'EU')).toBe('CERTIFIED');
      const { rows } = await db.app.query<{ source: string; certifier: string; mia_number: string }>("select source, certifier, mia_number from recipe.qp_certification where lot_id = $1", [lot.lotId]);
      expect(rows).toEqual([{ source: 'IN_SYSTEM', certifier: 'Dr. Lena Vogel', mia_number: mia }]);
    } finally {
      await withCommand(db.app, withReason(owner), (c) => c.query("select platform.set_setting('release.in_system_qp_certification', 'OFF')"));
    }
  });

  it('[DI-39][PR-56] a signed certification message is taken in only while the lot awaits certification, from the importer\'s QP: acknowledged ACCEPTED, then CERTIFIED; a QP rejection is visible to the US until its investigation is linked', async () => {
    const take = (who: SeededActor, m: Record<string, unknown>, signedOk = true) =>
      sqlAs<{ outcome: string; reason: string | null; id: string; certification_id: string | null }>(who, 'select test_edition.take_qp_message($1, $2) as r', [JSON.stringify(m), signedOk]);
    const lot = await readyLot();
    const msg = (extra: Record<string, unknown> = {}) => ({ format: 'ebmr.qp-certification.v1', messageId: `MSG-${randomUUID()}`, importerCode, lotCode: lot.lotCode,
      batchNumber: lot.batchNumber, productCode: lot.productCode, outcome: 'CERTIFIED', certifier: { name: 'Dr. Lena Vogel', miaNumber: mia }, ...extra });
    // INV-39: before the manufacturer release, refused and acknowledged with the reason.
    expect((await take(qaReviewer3, { ...msg(), certifiedAt: new Date().toISOString() })).reason).toMatch(/EBMR-DSP-033/);
    await manufacturerRelease(lot);
    const now = async (): Promise<string> => (await db.app.query<{ t: string }>(`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as t`)).rows[0]!.t;
    expect((await take(qaReviewer3, { ...msg(), certifiedAt: await now() }, false)).reason).toMatch(/EBMR-DSP-082/);
    expect((await take(qaReviewer3, { ...msg({ certifier: { name: 'Dr. X', miaNumber: 'FR-MIA-1' } }), certifiedAt: await now() })).reason).toMatch(/EBMR-DSP-055/);
    expect(await codeOf(take(operator, { ...msg(), certifiedAt: await now() }))).toMatch(/EBMR-IAM-\d{3}/);
    const good = { ...msg(), certifiedAt: await now() };
    const ack = await take(qaReviewer3, good);
    expect(ack).toMatchObject({ outcome: 'ACCEPTED', reason: null });
    expect(await state(lot.lotId, 'EU')).toBe('CERTIFIED');
    // A resend gets its first acknowledgement; a second outcome is refused.
    expect((await take(qaReviewer3, good)).id).toBe(ack.id);
    expect((await take(qaReviewer3, { ...msg({ outcome: 'REJECTED_BY_QP', reason: 'Late' }), certifiedAt: await now() })).reason).toMatch(/EBMR-DSP-051/);

    // A QP rejection on another lot: the US sees it (RED) until an investigation is linked to the lot.
    const other = await readyLot();
    await manufacturerRelease(other);
    const rej = await take(qaReviewer3, { ...msg({ lotCode: other.lotCode, batchNumber: other.batchNumber, outcome: 'REJECTED_BY_QP', reason: 'Transport temperature excursion' }), certifiedAt: await now() });
    expect(rej.outcome).toBe('ACCEPTED');
    expect(await state(other.lotId, 'EU')).toBe('REJECTED_BY_QP');
    expect(red(await grel(other.lotId, 'US'))).toContain('G11.MARKET_REJECTIONS');
    await deviationOnLot(other.lotId);
    expect(item(await grel(other.lotId, 'US'), 'G11.MARKET_REJECTIONS').status).toBe('GREEN');
  });

  it('[PR-55] an open OOS linked to the lot blocks the EU certification', async () => {
    const lot = await readyLot();
    await manufacturerRelease(lot);
    const d = await sqlAs<{ deviationId: string }>(operator, 'select site.raise_deviation($1::jsonb) as r', [
      JSON.stringify({ kind: 'OOS', title: 'Assay OOS on stability pull', classification: 'MAJOR', riskRationale: 'Investigated before any certification' }),
    ]);
    await w.run(operator, (c) => c.query("select site.link_deviation($1, 'LOT', $2)", [d.deviationId, lot.lotId]));
    expect(await state(lot.lotId, 'EU')).toBe('NOT_READY');
    expect(red(await grel(lot.lotId, 'EU'))).toContain('G2.DEVIATIONS');
    // Slice 5a (L-19): the link after the release suspended it; INV-39 refuses the certification before its own G2 check.
    expect(await state(lot.lotId, 'IN')).toBe('RELEASE_SUSPENDED');
    expect(await codeOf(transcribe(qaReviewer3, lot.lotId, 'CERTIFIED', new Date(Date.now() - 1000).toISOString()))).toBe('EBMR-DSP-033');
  });

  // Slice 4 quick review (recipe-core 0826).
  const dbNow = async (): Promise<string> => (await db.app.query<{ t: string }>(`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as t`)).rows[0]!.t;
  const takeText = (text: string, signedOk = true) =>
    sqlAs<{ outcome: string; reason: string | null; id: string }>(qaReviewer3, 'select test_edition.take_qp_message($1, $2) as r', [text, signedOk]);
  const msgFor = (lot: Lot, at: string, extra: Record<string, unknown> = {}) => JSON.stringify({ format: 'ebmr.qp-certification.v1', messageId: `MSG-${randomUUID()}`, importerCode,
    lotCode: lot.lotCode, batchNumber: lot.batchNumber, productCode: lot.productCode, outcome: 'CERTIFIED', certifier: { name: 'Dr. Lena Vogel', miaNumber: mia }, certifiedAt: at, ...extra });

  it('[DI-39] a resend of a refused message is evaluated afresh (a bad signature, a lot not yet awaiting certification); only an accepted one is answered with its acknowledgement; a lock timeout is raised, never acknowledged', async () => {
    const lot = await readyLot();
    const early = msgFor(lot, new Date().toISOString());
    expect((await takeText(early)).reason).toMatch(/EBMR-DSP-033/);
    await manufacturerRelease(lot);
    const text = msgFor(lot, await dbNow());
    const bad = await takeText(text, false);
    expect(bad.reason).toMatch(/EBMR-DSP-082/);
    // A transient error is not a refusal: the lot is locked elsewhere, the intake times out and nothing is acknowledged.
    const holder = await db.admin.connect();
    try {
      await holder.query('begin');
      await holder.query('select 1 from site.material_lot where id = $1 for update', [lot.lotId]);
      const sha = (await db.app.query<{ h: string }>("select encode(sha256(convert_to($1, 'UTF8')), 'hex') as h", [text])).rows[0]!.h;
      const before = Number((await db.app.query<{ n: string }>('select count(*) as n from recipe.qp_message_ack where message_sha256 = $1', [sha])).rows[0]!.n);
      expect(await codeOf(w.run(qaReviewer3, async (c) => {
        await c.query("set local lock_timeout = '300ms'");
        return c.query('select test_edition.take_qp_message($1, true)', [text]);
      }))).toMatch(/lock timeout/);
      expect(Number((await db.app.query<{ n: string }>('select count(*) as n from recipe.qp_message_ack where message_sha256 = $1', [sha])).rows[0]!.n)).toBe(before);
    } finally {
      await holder.query('rollback');
      holder.release();
    }
    // The same bytes, now correctly signed and the lot awaiting: accepted; the resend gets that acknowledgement.
    const ok = await takeText(text);
    expect(ok.outcome).toBe('ACCEPTED');
    expect((await takeText(text)).id).toBe(ok.id);
    expect(await state(lot.lotId, 'EU')).toBe('CERTIFIED');
    // The early message, sent again, is evaluated again: the lot is decided now.
    expect((await takeText(early)).reason).toMatch(/EBMR-DSP-051/);
  });

  it('[DI-30][DI-39] one outcome path at a time: while a transcription waits for its second person, a message and an in-system QP are refused', async () => {
    const lot = await readyLot();
    await manufacturerRelease(lot);
    const id = await transcribe(qaReviewer3, lot.lotId, 'CERTIFIED', await dbNow());
    expect((await takeText(msgFor(lot, await dbNow()))).reason).toMatch(/EBMR-DSP-090/);
    await withCommand(db.app, withReason(owner), (c) => c.query("select platform.set_setting('release.in_system_qp_certification', 'ON')"));
    try {
      const g = await grel(lot.lotId, 'EU');
      await acknowledgeAll(qp, lot.lotId, 'EU', g);
      expect(await codeOf(signed(qp, 'qp_certification', `${lot.lotId}/CERTIFIED`, 'QP_CERTIFIED', 'AWAITING_QP_CERTIFICATION', (c, sig) =>
        c.query("select recipe.record_qp_certification($1, 'CERTIFIED', $2, $3, null)", [lot.lotId, sig, g.epoch])))).toBe('EBMR-DSP-090');
    } finally {
      await withCommand(db.app, withReason(owner), (c) => c.query("select platform.set_setting('release.in_system_qp_certification', 'OFF')"));
    }
    await verify(qaReviewer2, id);
    expect(await state(lot.lotId, 'EU')).toBe('CERTIFIED');
    expect((await db.app.query('select 1 from recipe.qp_certification where lot_id = $1', [lot.lotId])).rows).toHaveLength(1);
  });

  it('[PR-55] an in-system QP rejection is signed QP_REJECTED, never with the certification meaning; the QA fallback of an acknowledgement still works with the switch on', async () => {
    const lot = await readyLot();
    await manufacturerRelease(lot);
    await withCommand(db.app, withReason(owner), (c) => c.query("select platform.set_setting('release.in_system_qp_certification', 'ON')"));
    try {
      const g = await grel(lot.lotId, 'EU');
      // LOW 5: a QA reviewer (no QP permission) still acknowledges through the QA permission; an unknown lot is raised.
      await acknowledgeAll(qaReviewer3, lot.lotId, 'EU', g);
      expect(await codeOf(w.run(qaReviewer3, (c) => c.query("select recipe.acknowledge_release_item($1, 'EU', 'G3.LIMS', $2)", [randomUUID(), g.epoch])))).toBe('EBMR-REL-010');
      const reject = (meaning: string) => signed(qp, 'qp_certification', `${lot.lotId}/REJECTED_BY_QP`, meaning, 'AWAITING_QP_CERTIFICATION', (c, sig) =>
        c.query("select recipe.record_qp_certification($1, 'REJECTED_BY_QP', $2, $3, 'Stability commitment not met for the EU')", [lot.lotId, sig, g.epoch]));
      expect(await codeOf(reject('QP_CERTIFIED'))).toBe('EBMR-REL-013');
      await reject('QP_REJECTED');
      expect(await state(lot.lotId, 'EU')).toBe('REJECTED_BY_QP');
      const { rows } = await db.admin.query<{ m: string }>('select s.meaning_code as m from recipe.qp_certification q join esig.signature s on s.id = q.signature_id where q.lot_id = $1', [lot.lotId]);
      expect(rows).toEqual([{ m: 'QP_REJECTED' }]);
    } finally {
      await withCommand(db.app, withReason(owner), (c) => c.query("select platform.set_setting('release.in_system_qp_certification', 'OFF')"));
    }
  });
});
