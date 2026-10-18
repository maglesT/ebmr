/**
 * Phase 4 slice 5b (recipe-core 0870, 0872; D-5-7; INV-21, R-04): the record of a finished lot locks at the lot's first
 * manufacturer disposition, and opening an amendment of a record whose lots are released suspends those releases
 * (recipe.suspend_release, the 4-0 interface slice 5a builds) and opens the AP's market-impact tasks, in one transaction.
 *
 * The evidence is built as in dispositions.test.ts: GMP batches issued from an effective master, reviewed through the real
 * review acts, the finished lot posted, its release results approved and its reserve samples pulled; a test edition
 * answers G-REL groups 4, 9 and 10. Every act runs as the application role with real e-signatures.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withProtectedNumbers } from '../../../kernel/src/continuity/numbers.ts';
import { tempDir, tempLedger } from '../../../kernel/test/continuity/helpers.ts';
import { withCommand } from '../../../kernel/src/db/command.ts';
import { createChallenge, contentForSigning, sign } from '../../../kernel/src/esig/signing.ts';
import { cmd, ensureSealKey, signatureAuth, testSealKey } from '../../../kernel/test/esig/helpers.ts';
import { signFor } from '../../../kernel/test/records/helpers.ts';
import { seedActor, seedServiceActor, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { approveTestRelease } from '../../../kernel/test/support/validation.ts';
import type { MbrContent } from '../../src/flow/model.ts';
import * as execution from '../../src/execution/index.ts';
import type * as lc from '../../src/lifecycle/index.ts';
import { define, FIXTURE_INPUTS, FIXTURE_JUSTIFICATIONS } from '../engine/support.ts';
import { gmpOrderFor } from '../lifecycle/gmp-support.ts';
import { cell, reason, seedCast, uniqueContent, World } from '../lifecycle/support.ts';

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
type Master = { familyId: string; versionId: string; content: MbrContent };
let all: Master;
const dir = tempDir('record-amendment');
const ledger = tempLedger('record-amendment', dir.path);
const SITE = 'SITE-1';
const BS = 'BS-200K';
const FIXTURE = 'tablet-granulation-compression';
interface Lot {
  batchId: string;
  lotId: string;
}
const FIXTURE_ACTOR = JSON.stringify({
  person_id: '00000000-0000-0000-0000-000000000000', account_id: '00000000-0000-0000-0000-000000000000', role_code: 'TEST_FIXTURE',
  session_id: '00000000-0000-0000-0000-000000000000', source: 'SYSTEM', site_zone: 'UTC', correlation_id: randomUUID(), legal_name: 'Test fixture',
  reason_code: 'TEST_FIXTURE', reason_text: 'a test stand-in of the release gate or of slice 5a' });

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    const m = /\b(EBMR-[A-Z]+-\d{3})\b/.exec(e instanceof Error ? e.message : String(e));
    return m?.[1] ?? (e instanceof Error ? e.message : String(e));
  }
}

const q = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, params)).rows as T[];

/** A superuser fixture transaction with an actor context (the test edition and the stand-ins below). */
async function fixture(work: (c: pg.PoolClient) => Promise<void>): Promise<void> {
  const fx = await db.admin.connect();
  try {
    await fx.query('begin');
    await fx.query('select kernel.set_actor_context($1::jsonb)', [FIXTURE_ACTOR]);
    await work(fx);
    await fx.query('commit');
  } catch (error) {
    await fx.query('rollback');
    throw error;
  } finally {
    fx.release();
  }
}

function without(content: unknown, types: readonly string[]): unknown {
  if (Array.isArray(content)) {
    return content.filter((x) => !(x && typeof x === 'object' && types.includes(String(((x as Record<string, unknown>)['block'] as Record<string, unknown> | undefined)?.['type'])))).map((x) => without(x, types));
  }
  if (content && typeof content === 'object') return Object.fromEntries(Object.entries(content).map(([k, v]) => [k, without(v, types)]));
  return content;
}

async function effective(): Promise<Master> {
  const m = uniqueContent(FIXTURE, ['EU', 'IN', 'US']);
  m.header.product = { ...m.header.product, code: m.header.product.code.toUpperCase() };
  const content = without(m, ['G-09', 'G-10']) as MbrContent;
  const v = await w.approvedVersion(content);
  for (const market of ['IN', 'US', 'EU'] as const) {
    const def: lc.MarketAuthorisationDefinition = { versionId: v.versionId, market, kind: 'CURRENT', cells: [cell(SITE, 'L1', BS)], regulatoryBasis: `${market}: registration on file` };
    await w.authorise(def);
  }
  await w.run(steward, (c) =>
    c.query('select site.define_batch_number_rule($1::jsonb)', [
      JSON.stringify({ rule_code: `R-${randomUUID().slice(0, 8).toUpperCase()}`, site_code: SITE, product_code: content.header.product.code, batch_kind: 'PROCESSING', format: 'A{YY}{SEQ:5}', site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3' }),
    ]),
  );
  return { familyId: v.familyId, versionId: v.versionId, content };
}

async function issuedBatch(m: Master): Promise<string> {
  const batchId = randomUUID();
  const erpOrder = await gmpOrderFor(db, erp, m.content, BS);
  await cmd(db, w.cast.issuer).then((ctx) =>
    withProtectedNumbers(db.app, ctx, ledger, (c) => execution.prepareGmpIssue(c, batchId, { familyId: m.familyId, markets: ['IN', 'US', 'EU'], site: SITE, line: 'L1', batchSize: BS, erpOrder })),
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

async function readyLot(): Promise<Lot> {
  const batchId = await issuedBatch(all);
  await review(batchId);
  const number = (await q<{ n: string }>('select batch_number as n from recipe.batch_execution where id = $1', [batchId]))[0]!.n;
  const lotId = await withCommand(db.admin, await cmd(db, warehouse), async (c) =>
    (await c.query<{ id: string }>('select site.create_finished_lot($1::jsonb) as id', [
      JSON.stringify({ batchId, batchNumber: number, edition: 'TABLETS', siteCode: SITE, productCode: all.content.header.product.code, productName: 'Amendment test product',
                       strength: '500 mg', markets: ['IN', 'US', 'EU'], quantity: '1000', unit: 'units', expiresAt: '2029-06-30T23:59:59Z' }),
    ])).rows[0]!.id,
  );
  const r = await w.run(analyst, async (c) => (await c.query<{ r: { resultId: string } }>('select site.record_lot_test_result($1, $2::jsonb) as r', [lotId, JSON.stringify({ testCode: 'ASSAY', purpose: 'RELEASE', value: '99.5' })])).rows[0]!.r);
  const sig = await signFor(db, qcHead, { type: 'lot_test_result', id: r.resultId }, 'QC_RESULT_APPROVED', 'RECORDED');
  await w.run(qcHead, (c) => c.query('select site.approve_lot_test_result($1, $2)', [r.resultId, sig]));
  await w.run(analyst, (c) => c.query('select site.pull_lot_sample($1, $2::jsonb)', [lotId, JSON.stringify({ kind: 'RESERVE', quantity: '80', container: 'Marketed blister in carton', storageLocation: 'Reserve room R-2' })]));
  return { batchId, lotId };
}

interface Grel {
  epoch: string;
  items: { id: string; status: string; since_review: boolean }[];
}
const grel = async (lotId: string, market: string): Promise<Grel> => (await db.app.query<{ g: Grel }>('select recipe.grel_evaluate($1, $2) as g', [lotId, market])).rows[0]!.g;

async function acknowledged(who: SeededActor, lotId: string, market: string): Promise<Grel> {
  const g = await grel(lotId, market);
  expect(g.items.filter((i) => i.status === 'RED').map((i) => i.id)).toEqual([]);
  for (const i of g.items.filter((x) => x.since_review)) await w.run(who, (c) => c.query('select recipe.acknowledge_release_item($1, $2, $3, $4)', [lotId, market, i.id, g.epoch]));
  return g;
}

async function manufacturerRelease(lot: Lot): Promise<void> {
  const g = await acknowledged(ap, lot.lotId, 'IN');
  const sig = await signFor(db, ap, { type: 'manufacturer_release', id: `${lot.lotId}/RELEASE` }, 'MANUFACTURER_RELEASE', 'READY');
  await w.run(ap, (c) => c.query("select recipe.record_manufacturer_release($1, 'RELEASE', $2, $3, null)", [lot.lotId, sig, g.epoch]));
}

async function usRelease(lot: Lot): Promise<void> {
  const g = await acknowledged(qcu, lot.lotId, 'US');
  const sig = await signFor(db, qcu, { type: 'us_disposition', id: `${lot.lotId}/RELEASE` }, 'US_DISPOSITION', 'READY');
  await w.run(qcu, (c) => c.query("select recipe.record_us_disposition($1, 'RELEASE', $2, $3, null, null)", [lot.lotId, sig, g.epoch]));
}

async function deviationOnLot(lotId: string): Promise<string> {
  const d = await w.run(operator, async (c) => (await c.query<{ r: { deviationId: string } }>('select site.raise_deviation($1::jsonb) as r', [
    JSON.stringify({ kind: 'DEVIATION', title: 'Record finding after release', classification: 'MAJOR', riskRationale: 'A record entry missing after release' }),
  ])).rows[0]!.r);
  await w.run(operator, (c) => c.query("select site.link_deviation($1, 'LOT', $2)", [d.deviationId, lotId]));
  return d.deviationId;
}

const batchNumberOf = async (batch: string): Promise<string> => (await q<{ n: string }>('select batch_number as n from recipe.batch_execution where id = $1', [batch]))[0]!.n;
const lotCodeOf = async (lot: string): Promise<string> => (await q<{ c: string }>('select lot_code as c from site.material_lot where id = $1', [lot]))[0]!.c;
const lockState = async (batch: string): Promise<string> => (await q<{ s: string }>('select recipe.record_lock_state($1) as s', [batch]))[0]!.s;
const openId = async (batch: string, basis: string): Promise<string> => (await q<{ a: string }>("select recipe.record_lock_next_id($1, 'OPEN', 'DEVIATION', $2) as a", [batch, basis]))[0]!.a;
const open = (who: SeededActor, batch: string, basis: string, sig: string) =>
  w.run(who, (c) => c.query("select recipe.open_record_amendment($1, 'DEVIATION', $2, 'LATE_ENTRY', 'Untranscribed check found after release', $3)", [batch, basis, sig]));

const openAs = (who: SeededActor, batch: string, kind: 'DEVIATION' | 'CHANGE_RECORD', basis: string, sig: string) =>
  w.run(who, (c) => c.query("select recipe.open_record_amendment($1, $2, $3, 'LATE_ENTRY', 'Untranscribed check found after release', $4)", [batch, kind, basis, sig]));
const inState = async (lotId: string): Promise<string> => (await q<{ s: string }>('select recipe.manufacturer_release_state($1) as s', [lotId]))[0]!.s;
const reconfirmProblems = async (lotId: string): Promise<string[]> => (await q<{ p: string[] }>("select recipe.after_release_problems($1, 'IN', 'RECONFIRM') as p", [lotId]))[0]!.p;

/** The AP's RECONFIRM of IN as the ceremony runs it: sign the record now, then the act with the signature. */
async function reconfirmIn(lotId: string): Promise<void> {
  const g = await acknowledged(ap, lotId, 'IN');
  const aid = (await q<{ a: string }>("select recipe.release_suspension_next_id($1, 'IN', 'RECONFIRM') as a", [lotId]))[0]!.a;
  // As the server's ceremony: the signature and the act in one command, so a refused act rolls its signature back.
  await ensureSealKey(db);
  const content = await contentForSigning(db.app, 'release_suspension', aid);
  const ch = await withCommand(db.app, await cmd(db, ap), (c) =>
    createChallenge(c, { aggregateType: 'release_suspension', aggregateId: aid, contentVersion: content.contentVersion ?? '1', meaning: 'RELEASE_RECONFIRMED', clientContentHash: content.contentHash ?? '' }));
  const ev = await signatureAuth(db, ap, ap, ch.challengeId);
  await withCommand(db.app, await cmd(db, ap), async (c) => {
    const sig = (await sign(c, { challengeId: ch.challengeId, authEventId: ev, expectedState: 'RELEASE_SUSPENDED' }, testSealKey)).signatureId;
    await c.query("select recipe.record_after_release_decision($1, 'IN', 'RECONFIRM', $2, $3, 'Amendment reviewed: no impact on the lot')", [lotId, sig, g.epoch]);
  });
}

beforeAll(async () => {
  db = await createTestDatabase();
  // Slice 7c (DI-03, recipe-core 1250): a GMP batch is issued only on a release with an approved validation summary.
  await approveTestRelease(db);
  w = new World(db, await seedCast(db));
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
  erp = await seedServiceActor(db, { kind: 'INTEGRATION', source: 'INTEGRATION', roleCode: 'ERP_INTERFACE', name: 'ERP interface' });
  all = await effective();
  const product = all.content.header.product;
  const productVersion = await withCommand(db.app, { ...erp, correlationId: randomUUID() }, async (c) =>
    (await c.query<{ id: string }>('select site.erp_receive_product($1::jsonb) as id', [
      JSON.stringify({ productCode: product.code, strength: '500 mg', productName: 'Amendment test product', betaLactam: false, shelfLifeMonths: 24, erpReference: 'ERP-AMD' }),
    ])).rows[0]!.id,
  );
  if ((await q<{ s: string }>("select site.erp_master_state('PRODUCT', $1) as s", [productVersion]))[0]?.s === 'PENDING') {
    const confirmation = await signFor(db, w.cast.qa, { type: 'erp_master', id: `PRODUCT/${productVersion}` }, 'ERP_MASTER_CONFIRMED', 'PENDING');
    await w.run(w.cast.qa, (c) => c.query("select site.confirm_erp_master('PRODUCT', $1, $2)", [productVersion, confirmation]));
  }
  const spec = await w.run(analyst, async (c) => (await c.query<{ r: { specificationId: string } }>('select site.draft_specification($1::jsonb) as r', [
    JSON.stringify({ materialCode: product.code, title: 'Finished product specification', monographReference: 'IP 2022 monograph', tests: [
      { testCode: 'ASSAY', methodReference: 'STP-AS', unit: '%', lowerLimit: '95.0', upperLimit: '105.0', required: true, pharmacopoeia: 'IP', edition: '2022', sampleQuantity: '20', sampleUnit: 'units' },
    ] }),
  ])).rows[0]!.r);
  const specSig = await signFor(db, qcHead, { type: 'specification', id: spec.specificationId }, 'SPECIFICATION_APPROVED', 'DRAFT');
  await w.run(qcHead, (c) => c.query('select site.approve_specification($1, $2)', [spec.specificationId, specSig]));
  // A test edition: it answers G-REL groups 4, 9 and 10 (the Tablets items are slice 3b's).
  await fixture(async (fx) => {
    await fx.query('create schema test_edition');
    await fx.query(`create function test_edition.grel_items(p_lot uuid, p_market text) returns jsonb language sql stable as $$
      select jsonb_build_array(
        jsonb_build_object('id', 'E.RECONCILIATION', 'group', '4', 'title', 'Reconciliation within limits', 'status', 'GREEN', 'problem', null, 'evidence', '[]'::jsonb, 'since_review', false),
        jsonb_build_object('id', 'E.PACK_EXAMINATION', 'group', '9', 'title', 'Finished-pack examination', 'status', 'GREEN', 'problem', null, 'evidence', '[]'::jsonb, 'since_review', false))
    $$`);
    await fx.query('grant usage, create on schema test_edition to ebmr_owner');
    await fx.query('grant usage on schema test_edition to ebmr_app');
    await fx.query("select recipe.register_grel_edition_hook('TABLETS', 'test_edition.grel_items(uuid, text)')");
  });
}, 900_000);

afterAll(async () => {
  await db.drop();
  dir.cleanup();
});

describe('the record of a finished lot locks at its first disposition; an amendment suspends its releases (INV-21, R-04; recipe-core 0870, 0872)', () => {
  it('[INV-21] the record of a finished lot locks at the lot\'s first manufacturer disposition, in the same transaction; from then on the database refuses every write to it, a superuser\'s too', async () => {
    const lot = await readyLot();
    expect(await lockState(lot.batchId)).toBe('UNLOCKED');
    await manufacturerRelease(lot);
    expect(await lockState(lot.batchId)).toBe('LOCKED');
    expect(await q('select event, cause, lot_id from recipe.record_lock_event where batch_id = $1', [lot.batchId])).toEqual([{ event: 'LOCKED', cause: 'FIRST_DISPOSITION', lot_id: lot.lotId }]);
    expect(await codeOf(db.admin.query("update recipe.execution_state set status = 'IN_PROGRESS' where batch_id = $1", [lot.batchId]))).toBe('EBMR-LCK-001');
    // The review acts are about the record, not in it: the market dispositions still run (the US release here).
    await usRelease(lot);
    expect((await q<{ s: string }>("select recipe.disposition_state($1, 'US') as s", [lot.lotId]))[0]!.s).toBe('RELEASED');
  });

  it('[INV-21][R-04][L-19] opening an amendment of a released record whose lot a linked deviation suspended already: the lot still counts (its decided markets), the amendment is added as a cause of its own, and the AP gets a market-impact task per decided market', async () => {
    const lot = await readyLot();
    await manufacturerRelease(lot);
    await usRelease(lot);
    const dev = await deviationOnLot(lot.lotId);
    // Slice 5a: the deviation linked after release suspends the lot at once.
    expect(await inState(lot.lotId)).toBe('RELEASE_SUSPENDED');
    const aid = await openId(lot.batchId, dev);
    const content = (await q<{ c: { content: { released_lots: unknown } } }>("select esig.provide('record_lock', $1) as c", [aid]))[0]!.c;
    expect(content.content.released_lots).toEqual([{ lot_id: lot.lotId, lot_code: await lotCodeOf(lot.lotId), markets: [
      { market: 'IN', disposition: 'RELEASED', now: 'RELEASE_SUSPENDED' }, { market: 'US', disposition: 'RELEASED', now: 'RELEASE_SUSPENDED' }] }]);
    const sig = await signFor(db, qaReviewer3, { type: 'record_lock', id: aid }, 'AMENDMENT_OPENED', 'LOCKED');
    await open(qaReviewer3, lot.batchId, dev, sig);
    expect(await lockState(lot.batchId)).toBe('UNDER_AMENDMENT');
    const [a] = await q<{ id: string; lots: string[] }>('select id, suspended_lots::text[] as lots from recipe.record_amendment where batch_id = $1', [lot.batchId]);
    expect(a?.lots).toEqual([lot.lotId]);
    expect(await q("select market, cause_kind, prior_state from recipe.release_suspension where lot_id = $1 and cause_kind = 'RECORD_AMENDMENT' and cause_ref = $2 order by market", [lot.lotId, a?.id])).toEqual([
      { market: 'IN', cause_kind: 'RECORD_AMENDMENT', prior_state: 'RELEASED' }, { market: 'US', cause_kind: 'RECORD_AMENDMENT', prior_state: 'RELEASED' }]);
    expect(await q('select market, disposition_before from recipe.amendment_market_task where batch_id = $1 order by market', [lot.batchId])).toEqual([
      { market: 'IN', disposition_before: 'RELEASED' }, { market: 'US', disposition_before: 'RELEASED' }]);
    expect((await q<{ s: string }>("select recipe.disposition_state($1, 'US') as s", [lot.lotId]))[0]!.s).toBe('RELEASE_SUSPENDED');
  });

  it('[INV-21][L-19] a RECORD_AMENDMENT cause is resolved only once its amendment is closed (D-5b-9): the AP\'s re-confirmation is refused while the amendment is open and allowed after QA closes it', async () => {
    const lot = await readyLot();
    await manufacturerRelease(lot);
    // A change record as the basis isolates the amendment's own cause (no deviation is linked to the lot).
    const cr = (await q<{ id: string }>('select id from recipe.change_record order by recorded_at limit 1'))[0]!.id;
    const aid = (await q<{ a: string }>("select recipe.record_lock_next_id($1, 'OPEN', 'CHANGE_RECORD', $2) as a", [lot.batchId, cr]))[0]!.a;
    const sig = await signFor(db, qaReviewer3, { type: 'record_lock', id: aid }, 'AMENDMENT_OPENED', 'LOCKED');
    await openAs(qaReviewer3, lot.batchId, 'CHANGE_RECORD', cr, sig);
    expect(await inState(lot.lotId)).toBe('RELEASE_SUSPENDED');
    // The real recipe.suspend_release, end to end: the amendment's own cause, the ERP stock block, the AP's tasks.
    const amendment = (await q<{ id: string }>('select id from recipe.record_amendment where batch_id = $1', [lot.batchId]))[0]!.id;
    expect(await q('select market, cause_kind, via_kind, via_id from recipe.release_suspension where lot_id = $1 and cause_ref = $2', [lot.lotId, amendment])).toEqual([
      { market: 'IN', cause_kind: 'RECORD_AMENDMENT', via_kind: 'BATCH', via_id: lot.batchId }]);
    expect(await q("select kind from site.erp_stock_block_request where lot_id = $1 and cause_key like 'RECORD_AMENDMENT/' || $2 || '/%'", [lot.lotId, amendment])).toEqual([{ kind: 'BLOCK' }]);
    expect(await q("select kind, owner_role from recipe.release_task where lot_id = $1 and not exists (select 1 from recipe.release_task_closure c where c.task_id = release_task.id)", [lot.lotId])).toEqual([
      { kind: 'RECALL_ASSESSMENT', owner_role: 'AUTHORISED_PERSON' }]);
    expect(await q('select market, disposition_before from recipe.amendment_market_task where batch_id = $1', [lot.batchId])).toEqual([{ market: 'IN', disposition_before: 'RELEASED' }]);
    expect((await reconfirmProblems(lot.lotId)).join(' ')).toMatch(/is still open: a record amendment is resolved once QA closes it/);
    expect(await codeOf(reconfirmIn(lot.lotId))).toBe('EBMR-ARL-012');
    const cid = (await q<{ a: string }>("select recipe.record_lock_next_id($1, 'CLOSE', null, null) as a", [lot.batchId]))[0]!.a;
    const closeSig = await signFor(db, qaReviewer2, { type: 'record_lock', id: cid }, 'AMENDMENT_CLOSED', 'UNDER_AMENDMENT');
    await w.run(qaReviewer2, (c) => c.query("select recipe.close_record_amendment($1, 1, 'Nothing appended: the record stands as signed', $2)", [lot.batchId, closeSig]));
    expect(await lockState(lot.batchId)).toBe('LOCKED');
    expect((await reconfirmProblems(lot.lotId)).join(' ')).not.toMatch(/record amendment/);
    await reconfirmIn(lot.lotId);
    expect(await inState(lot.lotId)).toBe('RELEASED');
    expect(await q("select count(*)::int as n from site.erp_stock_block_request where lot_id = $1 and kind = 'UNBLOCK'", [lot.lotId])).toEqual([{ n: 1 }]);
  });

  it('[L-19] a cause linked again after the AP re-confirmed the market (here through another genealogy path) suspends the lot again, with a new ERP block and a recall-assessment task; linked again while still uncovered it adds nothing', async () => {
    const lot = await readyLot();
    await manufacturerRelease(lot);
    const cr = (await q<{ id: string }>('select id from recipe.change_record order by recorded_at limit 1'))[0]!.id;
    const sig = await signFor(db, qaReviewer3, { type: 'record_lock', id: (await q<{ a: string }>("select recipe.record_lock_next_id($1, 'OPEN', 'CHANGE_RECORD', $2) as a", [lot.batchId, cr]))[0]!.a }, 'AMENDMENT_OPENED', 'LOCKED');
    await openAs(qaReviewer3, lot.batchId, 'CHANGE_RECORD', cr, sig);
    const amendment = (await q<{ id: string }>('select id from recipe.record_amendment where batch_id = $1', [lot.batchId]))[0]!.id;
    const cid = (await q<{ a: string }>("select recipe.record_lock_next_id($1, 'CLOSE', null, null) as a", [lot.batchId]))[0]!.a;
    const closeSig = await signFor(db, qaReviewer2, { type: 'record_lock', id: cid }, 'AMENDMENT_CLOSED', 'UNDER_AMENDMENT');
    await w.run(qaReviewer2, (c) => c.query("select recipe.close_record_amendment($1, 1, 'Nothing appended: the record stands as signed', $2)", [lot.batchId, closeSig]));
    await reconfirmIn(lot.lotId);
    expect(await inState(lot.lotId)).toBe('RELEASED');
    // The same cause reaches the lot again through another node of its genealogy (the owner-only entry the triggers use).
    const again = async (): Promise<void> => fixture(async (fx) => {
      await fx.query("select recipe.suspend_release($1, $2::jsonb)", [lot.lotId, JSON.stringify({ kind: 'RECORD_AMENDMENT', ref: amendment, via_kind: 'LOT', via_id: lot.lotId, label: 'the same amendment, another path' })]);
    });
    await again();
    expect(await inState(lot.lotId)).toBe('RELEASE_SUSPENDED');
    expect(await q('select count(*)::int as n from recipe.release_suspension where lot_id = $1 and cause_ref = $2', [lot.lotId, amendment])).toEqual([{ n: 2 }]);
    expect(await q("select count(*)::int as n from site.erp_stock_block_request where lot_id = $1 and kind = 'BLOCK'", [lot.lotId])).toEqual([{ n: 2 }]);
    expect(await q("select count(*)::int as n from recipe.release_task where lot_id = $1 and kind = 'RECALL_ASSESSMENT' and not exists (select 1 from recipe.release_task_closure c where c.task_id = release_task.id)", [lot.lotId])).toEqual([{ n: 1 }]);
    // Idempotent while uncovered: linked a third time, nothing is added.
    await again();
    expect(await q('select count(*)::int as n from recipe.release_suspension where lot_id = $1 and cause_ref = $2', [lot.lotId, amendment])).toEqual([{ n: 2 }]);
    expect(await q("select count(*)::int as n from site.erp_stock_block_request where lot_id = $1 and kind = 'BLOCK'", [lot.lotId])).toEqual([{ n: 2 }]);
  });

  it('[INV-21][R-04] the call path: with a recording stand-in for recipe.suspend_release (last in the file: it replaces the one of slice 5a), the opening calls it once per released lot with the amendment as its cause and opens one AP task per market already released; the amendment names the lots it suspended', async () => {
    const lot = await readyLot();
    await manufacturerRelease(lot);
    await usRelease(lot);
    // TEST STAND-IN for slice 5a's recipe.suspend_release (same signature, owner only): it records each call.
    await fixture(async (fx) => {
      await fx.query('create table if not exists test_edition.suspend_call (lot_id uuid not null, cause jsonb not null)');
      await fx.query('grant insert, select on test_edition.suspend_call to ebmr_owner');
      await fx.query(`create or replace function recipe.suspend_release(p_lot uuid, p_cause jsonb) returns void language sql volatile security definer
        set search_path = pg_catalog, pg_temp as $$ insert into test_edition.suspend_call (lot_id, cause) values (p_lot, p_cause) $$`);
      await fx.query('alter function recipe.suspend_release(uuid, jsonb) owner to ebmr_owner');
      await fx.query('revoke all on function recipe.suspend_release(uuid, jsonb) from public');
    });
    expect(await codeOf(db.app.query("select recipe.suspend_release($1, '{}'::jsonb)", [lot.lotId]))).toMatch(/permission denied/);
    const dev = await deviationOnLot(lot.lotId);
    const sig = await signFor(db, qaReviewer3, { type: 'record_lock', id: await openId(lot.batchId, dev) }, 'AMENDMENT_OPENED', 'LOCKED');
    await open(qaReviewer3, lot.batchId, dev, sig);
    expect(await lockState(lot.batchId)).toBe('UNDER_AMENDMENT');
    const [a] = await q<{ id: string; lots: string[] }>('select id, suspended_lots::text[] as lots from recipe.record_amendment where batch_id = $1', [lot.batchId]);
    expect(a?.lots).toEqual([lot.lotId]);
    const number = await batchNumberOf(lot.batchId);
    expect(await q('select lot_id, cause from test_edition.suspend_call where lot_id = $1', [lot.lotId])).toEqual([{
      lot_id: lot.lotId,
      cause: { kind: 'RECORD_AMENDMENT', ref: a?.id, via_kind: 'BATCH', via_id: lot.batchId, label: `amendment 1 of batch record ${number}`,
               batch_id: lot.batchId, batch_number: number, amendment_id: a?.id, amendment_number: 1, basis_kind: 'DEVIATION', basis_id: dev, signature_id: sig },
    }]);
    expect(await q('select lot_id, market, owner_role, disposition_before from recipe.amendment_market_task where batch_id = $1 order by market', [lot.batchId])).toEqual([
      { lot_id: lot.lotId, market: 'IN', owner_role: 'AUTHORISED_PERSON', disposition_before: 'RELEASED' },
      { lot_id: lot.lotId, market: 'US', owner_role: 'AUTHORISED_PERSON', disposition_before: 'RELEASED' },
    ]);
    // The lot's evidence moved: its epoch was bumped with the opening.
    expect(Number((await q<{ e: string }>("select recipe.epoch_of('LOT', $1)::text as e", [lot.lotId]))[0]!.e)).toBeGreaterThan(0);
  });
});
