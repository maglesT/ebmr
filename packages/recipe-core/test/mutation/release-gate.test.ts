/**
 * Mutation checks of the release gate (decision 0012; tools/sql-mutation group release-gate): G-REL and its helpers read
 * the lot's own evidence only, flag what changed since the QA review and nothing else, fail closed on an edition answer
 * that is not well formed, and the gate read (recipe.release_gate_problems) lists exactly the refusals of the act. The
 * set-up is release.test.ts's (a GMP batch reviewed through the real acts, its finished lot, tested and sampled; a test
 * edition answers groups 4, 9 and 10), with an edition answer that can be shaped per lot.
 */
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withProtectedNumbers } from '../../../kernel/src/continuity/numbers.ts';
import { tempDir, tempLedger } from '../../../kernel/test/continuity/helpers.ts';
import { withCommand } from '../../../kernel/src/db/command.ts';
import { assessIncidentImpact, raiseIncident } from '../../../kernel/src/records/incidents.ts';
import { challengeFor, cmd, signatureAuth, signWith } from '../../../kernel/test/esig/helpers.ts';
import { signFor } from '../../../kernel/test/records/helpers.ts';
import { seedActor, seedAdministration, seedServiceActor, withReason, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import type { MbrContent } from '../../src/flow/model.ts';
import * as execution from '../../src/execution/index.ts';
import type * as lc from '../../src/lifecycle/index.ts';
import { define, FIXTURE_INPUTS, FIXTURE_JUSTIFICATIONS } from '../engine/support.ts';
import { gmpOrderFor } from '../lifecycle/gmp-support.ts';
import { cell, reason, seedCast, uniqueContent, withSecondRole, World } from '../lifecycle/support.ts';

let db: TestDatabase;
let w: World;
let steward: SeededActor;
let operator: SeededActor;
let head: SeededActor;
let qaReviewer: SeededActor;
let qaReviewer2: SeededActor;
let qaReviewer3: SeededActor;
let qaReviewer4: SeededActor;
let erp: SeededActor;
let ap: SeededActor;
let delegate: SeededActor;
let analyst: SeededActor;
let qcHead: SeededActor;
let warehouse: SeededActor;

let owner: SeededActor;
let master: { familyId: string; versionId: string; content: MbrContent };
const dir = tempDir('release-gate');
const ledger = tempLedger('release-gate', dir.path);

const SITE = 'SITE-1';
const BS = 'BS-200K';
const FIXTURE = 'tablet-granulation-compression';
type Json = Record<string, unknown>;
interface Item {
  id: string;
  group: string;
  status: 'GREEN' | 'RED' | 'NA';
  problem: string | null;
  evidence: { kind: string; ref: string; label: string }[];
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
async function messageOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

function without(content: unknown, types: readonly string[]): unknown {
  if (Array.isArray(content)) {
    return content.filter((x) => !(x && typeof x === 'object' && types.includes(String(((x as Json)['block'] as Json | undefined)?.['type'])))).map((x) => without(x, types));
  }
  if (content && typeof content === 'object') return Object.fromEntries(Object.entries(content).map(([k, v]) => [k, without(v, types)]));
  return content;
}

const auth = (versionId: string): lc.MarketAuthorisationDefinition => ({ versionId, market: 'IN', kind: 'CURRENT', cells: [cell(SITE, 'L1', BS)], regulatoryBasis: 'IN: registration on file' });

async function effective(): Promise<{ familyId: string; versionId: string; content: MbrContent }> {
  const m = uniqueContent(FIXTURE);
  m.header.product = { ...m.header.product, code: m.header.product.code.toUpperCase() };
  const content = without(m, ['G-09', 'G-10']) as MbrContent;
  const v = await w.approvedVersion(content);
  await w.authorise(auth(v.versionId));
  await w.run(steward, (c) =>
    c.query('select site.define_batch_number_rule($1::jsonb)', [
      JSON.stringify({ rule_code: `R-${randomUUID().slice(0, 8).toUpperCase()}`, site_code: SITE, product_code: content.header.product.code, batch_kind: 'PROCESSING', format: 'R{YY}{SEQ:5}', site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3' }),
    ]),
  );
  return { familyId: v.familyId, versionId: v.versionId, content };
}

async function issuedBatch(purpose?: 'PPQ', m: { familyId: string; content: MbrContent } = master): Promise<string> {
  const batchId = randomUUID();
  const erpOrder = await gmpOrderFor(db, erp, m.content, BS);
  await cmd(db, w.cast.issuer).then((ctx) =>
    withProtectedNumbers(db.app, ctx, ledger, (c) => execution.prepareGmpIssue(c, batchId, { familyId: m.familyId, markets: ['IN'], site: SITE, line: 'L1', batchSize: BS, erpOrder })),
  );
  const signatureId = await w.sign(w.cast.issuer, 'batch_issue', batchId, 'ISSUED', 'PLANNED');
  await w.run(
    w.cast.issuer,
    (c) =>
      execution.issueGmpBatch(c, {
        batchId,
        signatureId,
        define: (x) => define(x, { installation: 'GMP', justifications: FIXTURE_JUSTIFICATIONS }),
        request: { inputs: FIXTURE_INPUTS[FIXTURE], issuedBy: { id: w.cast.issuer.personId, kind: 'PERSON', roles: [] }, ...(purpose ? { purpose } : {}) },
      }),
    reason('batch issued for the test'),
  );
  return batchId;
}

const reviewState = async (b: string): Promise<string> => (await db.app.query<{ s: string }>('select recipe.batch_review_state($1) as s', [b])).rows[0]!.s;

/** Completed (set by the test), approved by production, audit trail reviewed and QA reviewed through the real acts. */
async function review(b: string): Promise<void> {
  // Under an actor context: the lot of an early-lot test may already exist, and its guards need one.
  await withCommand(db.admin, await cmd(db, head), (c) => c.query("update recipe.execution_state set status = 'EXECUTION_COMPLETE' where batch_id = $1", [b]));
  const approval = await w.sign(head, 'batch_review', b, 'PRODUCTION_APPROVED', 'EXECUTION_COMPLETE');
  await w.run(head, (c) => c.query('select recipe.record_production_approval($1, $2)', [b, approval]));
  const id = (await db.app.query<{ id: string }>('select recipe.audit_review_next_id($1) as id', [b])).rows[0]!.id;
  const at = await w.sign(qaReviewer, 'batch_audit_review', id, 'AUDIT_TRAIL_REVIEWED', 'PRODUCTION_APPROVED');
  await w.run(qaReviewer, (c) => c.query('select recipe.record_audit_trail_review($1, $2)', [id, at]));
  const qa = await w.sign(qaReviewer2, 'batch_review', b, 'QA_REVIEWED', 'PRODUCTION_APPROVED');
  const epoch = (await db.app.query<{ e: string }>("select recipe.epoch_of('BATCH', $1)::text as e", [b])).rows[0]!.e;
  await w.run(qaReviewer2, (c) => c.query('select recipe.record_qa_review($1, $2, $3)', [b, qa, epoch]));
  expect(await reviewState(b)).toBe('QA_REVIEWED');
}

/** The delta audit-trail review the evidence linked after the QA review needs (INV-48), by an uninvolved reviewer. */
async function deltaReview(b: string): Promise<void> {
  const id = (await db.app.query<{ id: string }>('select recipe.audit_review_next_id($1) as id', [b])).rows[0]!.id;
  const sig = await w.sign(qaReviewer, 'batch_audit_review', id, 'DELTA_AUDIT_TRAIL_REVIEWED', 'QA_REVIEWED');
  await w.run(qaReviewer, (c) => c.query('select recipe.record_audit_trail_review($1, $2)', [id, sig]));
}

/** The finished lot of batch `b`, posted as the edition's definer posts it (site.create_finished_lot is not granted). */
async function finishedLot(b: string, m: { content: MbrContent } = master): Promise<string> {
  const number = (await db.app.query<{ n: string }>('select batch_number as n from recipe.batch_execution where id = $1', [b])).rows[0]!.n;
  return withCommand(db.admin, await cmd(db, warehouse), async (c) =>
    (await c.query<{ id: string }>('select site.create_finished_lot($1::jsonb) as id', [
      JSON.stringify({ batchId: b, batchNumber: number, edition: 'TABLETS', siteCode: SITE, productCode: m.content.header.product.code, productName: 'Release test product',
                       strength: '500 mg', markets: ['IN'], quantity: '1000', unit: 'units', expiresAt: '2029-06-30T23:59:59Z' }),
    ])).rows[0]!.id,
  );
}

async function sqlAs<T>(who: SeededActor, text: string, params: unknown[] = []): Promise<T> {
  return w.run(who, async (c) => ((await c.query(text, params)).rows[0] as { r: T } | undefined)?.r as T);
}

/** An approved passing ASSAY release result (head of QC) and the reserve samples of the lot. */
async function testedAndSampled(lotId: string, opts: { approve?: boolean; samples?: boolean } = {}): Promise<string> {
  const r = await sqlAs<{ resultId: string }>(analyst, 'select site.record_lot_test_result($1, $2::jsonb) as r', [lotId, JSON.stringify({ testCode: 'ASSAY', purpose: 'RELEASE', value: '99.5' })]);
  if (opts.approve ?? true) {
    const sig = await signFor(db, qcHead, { type: 'lot_test_result', id: r.resultId }, 'QC_RESULT_APPROVED', 'RECORDED');
    await w.run(qcHead, (c) => c.query('select site.approve_lot_test_result($1, $2)', [r.resultId, sig]));
  }
  if (opts.samples ?? true) {
    await w.run(analyst, (c) => c.query('select site.pull_lot_sample($1, $2::jsonb)', [lotId, JSON.stringify({ kind: 'RESERVE', quantity: '40', container: 'Marketed blister in carton', storageLocation: 'Reserve room R-2' })]));
  }
  return r.resultId;
}

/** A reviewed batch, its finished lot, tested and sampled. */
async function readyLot(opts: { purpose?: 'PPQ'; approve?: boolean; master?: { familyId: string; content: MbrContent } } = {}): Promise<Lot> {
  const batchId = await issuedBatch(opts.purpose, opts.master);
  await review(batchId);
  const lotId = await finishedLot(batchId, opts.master);
  await testedAndSampled(lotId, { approve: opts.approve ?? true });
  return { batchId, lotId };
}

const grel = async (lotId: string, market = 'IN'): Promise<Grel> => (await db.app.query<{ g: Grel }>('select recipe.grel_evaluate($1, $2) as g', [lotId, market])).rows[0]!.g;
const item = (g: Grel, id: string): Item => {
  const i = g.items.find((x) => x.id === id);
  if (!i) throw new Error(`no item ${id} in ${g.items.map((x) => x.id).join(', ')}`);
  return i;
};
const red = (g: Grel): string[] => g.items.filter((i) => i.status === 'RED').map((i) => i.id);
const lotState = async (lotId: string): Promise<string> =>
  (await db.app.query<{ s: string }>("select state as s from platform.aggregate_state where aggregate_type = 'material_lot' and aggregate_id = $1", [lotId])).rows[0]!.s;
const deviationState = async (id: string): Promise<string> => (await db.app.query<{ s: string }>('select site.deviation_state($1) as s', [id])).rows[0]!.s;
const releaseState = async (lotId: string): Promise<string> => (await db.app.query<{ s: string }>('select recipe.manufacturer_release_state($1) as s', [lotId])).rows[0]!.s;

async function acknowledgeAll(who: SeededActor, lotId: string, g: Grel): Promise<void> {
  for (const i of g.items.filter((x) => x.since_review)) {
    await w.run(who, (c) => c.query("select recipe.acknowledge_release_item($1, 'IN', $2, $3)", [lotId, i.id, g.epoch]));
  }
}

/** The AP's (or a delegate's) MANUFACTURER_RELEASE signature over the lot's current checklist. */
async function signDecision(who: SeededActor, lotId: string, decision: 'RELEASE' | 'REJECT', delegationId?: string): Promise<string> {
  const id = `${lotId}/${decision}`;
  const ch = await challengeFor(db, who, id, { meaning: 'MANUFACTURER_RELEASE', aggregateType: 'manufacturer_release' });
  const ev = await signatureAuth(db, who, who, ch.challengeId);
  return (await signWith(db, who, ch.challengeId, ev, { expectedState: await releaseState(lotId), ...(delegationId ? { delegationId } : {}) })).signatureId;
}

const record = (who: SeededActor, lotId: string, decision: 'RELEASE' | 'REJECT', sig: string, epoch: string, why: string | null = null) =>
  w.run(who, (c) => c.query('select recipe.record_manufacturer_release($1, $2, $3, $4, $5)', [lotId, decision, sig, epoch, why]));

async function release(who: SeededActor, lot: Lot): Promise<string> {
  const g = await grel(lot.lotId);
  expect(red(g)).toEqual([]);
  await acknowledgeAll(who, lot.lotId, g);
  const sig = await signDecision(who, lot.lotId, 'RELEASE');
  await record(who, lot.lotId, 'RELEASE', sig, g.epoch);
  return sig;
}

async function deviationOn(kind: 'DEVIATION' | 'OOS', subject: 'BATCH' | 'LOT', id: string): Promise<{ deviationId: string; ref: string }> {
  const d = await sqlAs<{ deviationId: string; ref: string }>(operator, 'select site.raise_deviation($1::jsonb) as r', [
    JSON.stringify({ kind, title: 'Found after the record review', classification: 'MAJOR', riskRationale: 'Investigated before any release of the lot' }),
  ]);
  await w.run(operator, (c) => c.query('select site.link_deviation($1, $2, $3)', [d.deviationId, subject, id]));
  return d;
}

/**
 * The deviation path to an open record assessed for IN (site services 0820 to 0822, as site-services' own
 * deviation-path helper drives it): QA classifies, the owner records the finding and the impact on every link, another QA
 * person signs the impact, the basis is recorded and a fourth person concludes (PENDING_CLOSURE: still open).
 */
async function concludedWithImpact(deviationId: string, impact: 'NONE' | 'POTENTIAL'): Promise<void> {
  const q = (who: SeededActor, text: string, values: unknown[]) => w.run(who, (c) => c.query(text, values));
  await q(qaReviewer, 'select site.start_deviation_investigation($1, $2::jsonb)', [
    deviationId, JSON.stringify({ classification: 'MAJOR', riskRationale: 'QA classification after the first review of the facts', ownerPersonId: qaReviewer2.personId, dueDate: '2027-01-28' }),
  ]);
  await q(qaReviewer2, 'select site.record_deviation_finding($1, $2::jsonb)', [deviationId, JSON.stringify({ assignableCause: true, cause: 'A gasket wore out', rootCauseCategory: 'EQUIPMENT' })]);
  const links = (await db.app.query<{ id: string }>('select id from site.deviation_link where deviation_id = $1 order by linked_at, id', [deviationId])).rows;
  for (const l of links) {
    await q(qaReviewer2, 'select site.record_deviation_impact($1, $2::jsonb)', [deviationId, JSON.stringify({ linkId: l.id, market: 'IN', impact, rationale: 'Assessed against the investigation findings' })]);
  }
  const assessed = await signFor(db, qaReviewer3, { type: 'deviation', id: deviationId }, 'DEVIATION_IMPACT_ASSESSED', 'UNDER_INVESTIGATION');
  await q(qaReviewer3, 'select site.assess_deviation_impact($1, $2)', [deviationId, assessed]);
  await q(qaReviewer2, 'select site.record_deviation_closure_basis($1, $2::jsonb)', [deviationId, JSON.stringify({
    rootCauseMethod: 'Five whys with the investigation team', capaRefs: ['CAPA-TEST-001'], notificationRequired: false,
    notificationRationale: 'No registered detail or licence condition is affected',
    otherBatches: [{ subjectKind: 'PRODUCT', ref: 'All other batches of the product made since the last good check', included: false, reason: 'Checks passed on them' }],
  })]);
  const concluded = await signFor(db, qaReviewer4, { type: 'deviation', id: deviationId }, 'DEVIATION_CONCLUDED', 'IMPACT_ASSESSED');
  await q(qaReviewer4, 'select site.conclude_deviation($1, $2)', [deviationId, concluded]);
}

async function setOpenInvestigationPath(value: 'ON' | 'OFF'): Promise<void> {
  await withCommand(db.app, withReason(owner), (c) => c.query("select platform.set_setting('release.open_investigation_path', $1)", [value]));
}

/** The product master (QA confirms a new code) and the finished product's specification: ASSAY 95 to 105 %, 20 units a run. */
async function productAndSpecification(content: MbrContent): Promise<void> {
  const product = content.header.product;

  const productVersion = await withCommand(db.app, { ...erp, correlationId: randomUUID() }, async (c) =>
    (await c.query<{ id: string }>('select site.erp_receive_product($1::jsonb) as id', [
      JSON.stringify({ productCode: product.code, strength: '500 mg', productName: 'Release test product', betaLactam: false, shelfLifeMonths: 24, erpReference: 'ERP-REL' }),
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
    ] }),
  ]);
  const specSig = await signFor(db, qcHead, { type: 'specification', id: spec.specificationId }, 'SPECIFICATION_APPROVED', 'DRAFT');
  await w.run(qcHead, (c) => c.query('select site.approve_specification($1, $2)', [spec.specificationId, specSig]));

}

beforeAll(async () => {
  db = await createTestDatabase();
  w = new World(db, await seedCast(db));
  ({ owner } = await seedAdministration(db));
  steward = await seedActor(db, { roleCode: 'MASTER_DATA_STEWARD', legalName: 'Mira Steward' });
  operator = await seedActor(db, { roleCode: 'OPERATOR', legalName: 'Om Operator', roomCode: 'DISP-01' });
  head = await seedActor(db, { roleCode: 'HEAD_OF_PRODUCTION', legalName: 'Hari Head' });
  qaReviewer = await seedActor(db, { roleCode: 'QA_REVIEWER', legalName: 'Rhea Reviewer' });
  qaReviewer2 = await seedActor(db, { roleCode: 'QA_REVIEWER', legalName: 'Ravi Reviewer' });
  qaReviewer3 = await seedActor(db, { roleCode: 'QA_REVIEWER', legalName: 'Rani Reviewer' });
  qaReviewer4 = await seedActor(db, { roleCode: 'QA_REVIEWER', legalName: 'Roshan Reviewer' });
  ap = await seedActor(db, { roleCode: 'AUTHORISED_PERSON', legalName: 'Anita Authorised' });
  delegate = await seedActor(db, { roleCode: 'AUTHORISED_PERSON', legalName: 'Dev Delegate' });
  analyst = await seedActor(db, { roleCode: 'QC_ANALYST', legalName: 'Asha Analyst' });
  qcHead = await seedActor(db, { roleCode: 'HEAD_OF_QC', legalName: 'Hema QC-Head' });
  warehouse = await seedActor(db, { roleCode: 'WAREHOUSE_LABELLING', legalName: 'Wasim Warehouse' });
  erp = await seedServiceActor(db, { kind: 'INTEGRATION', source: 'INTEGRATION', roleCode: 'ERP_INTERFACE', name: 'ERP interface' });
  master = await effective();
  await productAndSpecification(master.content);

  // A test edition: it answers groups 4 and 9 (the Tablets items are slice 3b's); a lot listed in the table gets a RED item.
  const fx = await db.admin.connect();
  try {
    await fx.query('begin');
    await fx.query('select kernel.set_actor_context($1::jsonb)', [JSON.stringify({
      person_id: '00000000-0000-0000-0000-000000000000', account_id: '00000000-0000-0000-0000-000000000000', role_code: 'TEST_FIXTURE',
      session_id: '00000000-0000-0000-0000-000000000000', source: 'SYSTEM', site_zone: 'UTC', correlation_id: randomUUID(), legal_name: 'Test fixture',
      reason_code: 'TEST_FIXTURE', reason_text: 'a test edition of the release gate' })]);
    await fx.query('create schema test_edition');
    await fx.query('create table test_edition.red_lot (lot_id uuid primary key)');
    // The shape of the edition's answer for a lot: MALFORMED, NULL, ONLY_4 (no group 9 item) or ONLY_9 (no group 4 item).
    await fx.query('create table test_edition.shape (lot_id uuid primary key, kind text not null)');
    await fx.query(`create function test_edition.grel_items(p_lot uuid, p_market text) returns jsonb language sql stable as $$
      with base as (select jsonb_build_array(
        jsonb_build_object('id', 'E.RECONCILIATION', 'group', '4', 'title', 'Reconciliation within limits', 'status', 'GREEN', 'problem', null, 'evidence', '[]'::jsonb, 'since_review', false),
        jsonb_build_object('id', 'E.PACK_EXAMINATION', 'group', '9', 'title', 'Finished-pack examination', 'status', 'GREEN', 'problem', null, 'evidence', '[]'::jsonb, 'since_review', false),
        case when exists (select 1 from test_edition.red_lot r where r.lot_id = p_lot)
             then jsonb_build_object('id', 'E.HELD_CONTAINERS', 'group', '10', 'title', 'Held containers dispositioned', 'status', 'RED', 'problem', 'a held container is not dispositioned', 'evidence', '[]'::jsonb, 'since_review', false)
             else jsonb_build_object('id', 'E.HELD_CONTAINERS', 'group', '10', 'title', 'Held containers dispositioned', 'status', 'GREEN', 'problem', null, 'evidence', '[]'::jsonb, 'since_review', false) end) as a)
      select case (select s.kind from test_edition.shape s where s.lot_id = p_lot)
               when 'MALFORMED' then jsonb_build_array(jsonb_build_object('id', 'E.RECONCILIATION', 'group', '4'))
               when 'NULL' then null
               when 'ONLY_4' then jsonb_build_array(a -> 0, a -> 2)
               when 'ONLY_9' then jsonb_build_array(a -> 1, a -> 2)
               else a end
        from base
    $$`);
    await fx.query('grant usage on schema test_edition to ebmr_owner');
    await fx.query('grant select on test_edition.red_lot, test_edition.shape to ebmr_owner');
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

/** TEST FIXTURE: a received API lot, not a finished lot (site services' receipt is proven there; as in after-release.test.ts). */
async function apiLot(): Promise<string> {
  const lotId = randomUUID();
  await asFixture(async (fx) => {
    await fx.query(`insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, received_quantity, unit, expires_at,
                                                   received_by_person, received_by_account, correlation_id)
                    values ($1, 'SITE-1', $2, 'API-FX', 'Fixture API', 'API', 10, 'kg', '2030-01-01T00:00:00Z', $3, $3, $3)`,
                   [lotId, `L-${lotId.slice(0, 8).toUpperCase()}`, randomUUID()]);
  });
  return lotId;
}

/** TEST FIXTURE: a lot consumed by a batch, as the guarded consumption records it (proven in site services; as in review.test.ts). */
async function consumed(lotId: string, batchId: string): Promise<void> {
  const resId = randomUUID();
  await asFixture(async (fx) => {
    await fx.query(`insert into site.lot_reservation (id, lot_id, batch_id, batch_number, edition, quantity, unit, expires_at, lot_state_version, reserved_by_person, reserved_by_account)
                    select $1, $2, b.id, b.batch_number, 'TABLETS', 1, 'kg', now() + interval '1 day', 2, $3, $3 from recipe.batch_execution b where b.id = $4`,
                   [resId, lotId, randomUUID(), batchId]);
    await fx.query(`insert into site.lot_consumption (lot_id, reservation_id, batch_id, batch_number, edition, material_code, quantity, unit, quantity_before, quantity_after, market_set,
                                                      identity_basis, consumed_by_person, consumed_by_account, xact_id)
                    select $1, $2, b.id, b.batch_number, 'TABLETS', 'API-FX', 1, 'kg', 10, 9, b.market_set, 'IDENTITY_RESULT', $3, $3, txid_current() from recipe.batch_execution b where b.id = $4`,
                   [lotId, resId, randomUUID(), batchId]);
  });
}

/** TEST FIXTURE: a disposed reserve sample (the retention period is years; site services prove the disposal act). */
async function disposed(sampleId: string): Promise<void> {
  await asFixture(async (fx) => {
    await fx.query('insert into site.lot_sample_disposal (sample_id, reason, disposed_by_person, disposed_by_account) values ($1, $2, $3, $3)',
                   [sampleId, 'fixture: retention period over', randomUUID()]);
  });
}

async function asFixture(work: (fx: pg.PoolClient) => Promise<void>): Promise<void> {
  const fx = await db.admin.connect();
  try {
    await fx.query('begin');
    await fx.query("set local session_replication_role = 'replica'");
    await work(fx);
    await fx.query('commit');
  } catch (error) {
    await fx.query('rollback');
    throw error;
  } finally {
    fx.release();
  }
}

const one = async <T>(text: string, params: unknown[] = []): Promise<T> => (await db.admin.query<{ r: T }>(text, params)).rows[0]!.r;
const gate = async (lotId: string, act: string | null): Promise<string[]> =>
  (await db.app.query<{ r: string[] }>('select recipe.release_gate_problems($1, $2) as r', [lotId, act])).rows[0]!.r;
const lotCode = async (lotId: string): Promise<string> => one<string>('select lot_code as r from site.material_lot where id = $1', [lotId]);
const batchNumber = async (batchId: string): Promise<string> => one<string>('select batch_number as r from recipe.batch_execution where id = $1', [batchId]);
const refs = (i: Item): string[] => i.evidence.map((e) => e.ref).sort();
const sampleIds = async (lotId: string): Promise<string[]> =>
  (await db.admin.query<{ id: string }>('select id from site.lot_sample where lot_id = $1 order by id', [lotId])).rows.map((r) => r.id);

/** The investigation started and its finding recorded, then the impact for IN recorded on the named links only. */
async function impactOn(deviationId: string, links: { kind: 'LOT' | 'BATCH'; id: string }[]): Promise<void> {
  const q = (who: SeededActor, text: string, values: unknown[]) => w.run(who, (c) => c.query(text, values));
  await q(qaReviewer, 'select site.start_deviation_investigation($1, $2::jsonb)', [
    deviationId, JSON.stringify({ classification: 'MAJOR', riskRationale: 'QA classification after the first review of the facts', ownerPersonId: qaReviewer2.personId, dueDate: '2027-01-28' }),
  ]);
  await q(qaReviewer2, 'select site.record_deviation_finding($1, $2::jsonb)', [deviationId, JSON.stringify({ assignableCause: true, cause: 'A gasket wore out', rootCauseCategory: 'EQUIPMENT' })]);
  for (const l of links) {
    const id = (await db.app.query<{ id: string }>('select id from site.deviation_link where deviation_id = $1 and subject_kind = $2 and subject_id = $3', [deviationId, l.kind, l.id])).rows[0]!.id;
    await q(qaReviewer2, 'select site.record_deviation_impact($1, $2::jsonb)', [deviationId, JSON.stringify({ linkId: id, market: 'IN', impact: 'NONE', rationale: 'Assessed against the investigation findings' })]);
  }
}

describe('G-REL: the gate functions read only the lot\'s own evidence (decision 0012, mutation checks; INV-05, IN-05)', () => {
  it('[INV-05] an edition answer counts only when every item is well formed: each malformation alone, a duplicate id or a non-array is refused; an item without since_review reads false', async () => {
    const good = { id: 'E.GOOD', group: '10', title: 'Good item', status: 'GREEN', problem: null, evidence: [], since_review: false };
    const wf = (items: unknown): Promise<boolean> => one<boolean>('select recipe.grel_items_well_formed($1::jsonb) as r', [JSON.stringify(items)]);
    expect(await wf([good, { ...good, id: 'E.RED', status: 'RED', problem: 'a reason' }, { ...good, id: 'E.NA', group: '4', status: 'NA' }])).toBe(true);
    expect(await wf(good)).toBe(false);
    expect(await wf([good, good])).toBe(false);
    const malformed: unknown[] = ['an item', { ...good, id: 'X.BAD' }, { ...good, group: '8' }, { ...good, title: ' ' }, { ...good, status: 'AMBER' },
                                 { ...good, status: 'RED' }, { ...good, problem: 'a problem on a GREEN item' }, { ...good, evidence: {} }, { ...good, since_review: 'no' }];
    for (const m of malformed) expect(await wf([{ ...good, id: 'E.FIRST' }, m]), JSON.stringify(m)).toBe(false);
    expect(await one<Item>("select recipe.grel_item('E.X', '10', 'An item', null, null, null, null) as r")).toEqual(
      { id: 'E.X', group: '10', title: 'An item', status: 'GREEN', problem: null, evidence: [], since_review: false });
  });

  it('[INV-05][IN-05] a lot that is no finished lot gets the RED lot item, the edition placeholders and no market items for any market; the gate and the scope refuse it', async () => {
    const api = await apiLot();
    for (const [lotId, market] of [[api, 'IN'], [api, 'US'], [randomUUID(), 'US'], [randomUUID(), 'EU']] as const) {
      const g = await grel(lotId, market);
      expect(g.items.map((i) => i.id), market).toEqual(['G1.LOT', 'G4.RECONCILIATION', 'G9.PACK_EXAMINATION', 'E.EDITION']);
      expect(g.ready).toBe(false);
      expect(await gate(lotId, 'RELEASE')).toEqual(['the lot is no finished lot of a packaging batch']);
    }
    expect(await messageOf(db.admin.query('select recipe.release_scope($1)', [api]))).toMatch(/EBMR-REL-010/);
  });

  it('[INV-05][IN-05] the edition answer fails closed (malformed, NULL, a missing group 4 or 9); the gate lists RED items for RELEASE only, names an unknown act and, once decided, the lot; a suspended release reads RELEASE_SUSPENDED', async () => {
    const lot = await readyLot();
    const g0 = await grel(lot.lotId);
    expect(red(g0)).toEqual([]);
    expect(item(g0, 'G1.REVIEW_1').title).toContain(await batchNumber(lot.batchId));
    // IN keeps its own checklist: the market-add item is NA and there are no market items (US and EU only).
    expect(item(g0, 'G8.MARKET_ADD').status).toBe('NA');
    expect(g0.items.filter((i) => i.group === '11')).toEqual([]);
    expect(await gate(lot.lotId, 'RELEASE')).toEqual([]);
    expect(await gate(lot.lotId, 'REJECT')).toEqual([]);
    expect(await gate(lot.lotId, 'APPROVE')).toEqual(['APPROVE is no act of the manufacturer release (RELEASE or REJECT)']);
    expect(await gate(lot.lotId, null)).toEqual(['NULL is no act of the manufacturer release (RELEASE or REJECT)']);

    const shaped = async (kind: string): Promise<Grel> => {
      await db.admin.query('insert into test_edition.shape (lot_id, kind) values ($1, $2)', [lot.lotId, kind]);
      try {
        return await grel(lot.lotId);
      } finally {
        await db.admin.query('delete from test_edition.shape where lot_id = $1', [lot.lotId]);
      }
    };
    for (const kind of ['MALFORMED', 'NULL']) {
      const g = await shaped(kind);
      expect(red(g), kind).toEqual(['G4.RECONCILIATION', 'G9.PACK_EXAMINATION', 'E.EDITION']);
      expect(item(g, 'E.EDITION').problem).toMatch(/not well formed/);
    }
    const only4 = await shaped('ONLY_4');
    expect(red(only4)).toEqual(['G9.PACK_EXAMINATION']);
    expect(only4.items.map((i) => i.id)).not.toContain('G4.RECONCILIATION');
    const only9 = await shaped('ONLY_9');
    expect(red(only9)).toEqual(['G4.RECONCILIATION']);
    expect(only9.items.map((i) => i.id)).not.toContain('G9.PACK_EXAMINATION');

    await db.admin.query('insert into test_edition.red_lot (lot_id) values ($1)', [lot.lotId]);
    expect(await gate(lot.lotId, 'RELEASE')).toEqual(['G-REL item E.HELD_CONTAINERS is RED: a held container is not dispositioned']);
    expect(await gate(lot.lotId, 'REJECT')).toEqual([]);
    await db.admin.query('delete from test_edition.red_lot where lot_id = $1', [lot.lotId]);

    await release(ap, lot);
    const decided = [`the manufacturer release of lot ${await lotCode(lot.lotId)} is RELEASED`];
    expect(await gate(lot.lotId, 'RELEASE')).toEqual(decided);
    expect(await gate(lot.lotId, 'REJECT')).toEqual(decided);
    expect(await releaseState(lot.lotId)).toBe('RELEASED');
    // A deviation linked after the release suspends it: the state reads the after-release state over the decision.
    await deviationOn('DEVIATION', 'LOT', lot.lotId);
    expect(await releaseState(lot.lotId)).toBe('RELEASE_SUSPENDED');
  });

  it('[INV-05][IN-05] evidence recorded before the QA review is not "since review", later evidence is; every item lists the lot\'s own evidence only', async () => {
    // The lot posted, tested, sampled, given a deviation, an assessed incident and a consumed API lot before its record's QA review.
    const batchId = await issuedBatch();
    const lotId = await finishedLot(batchId);
    const resultId = await testedAndSampled(lotId);
    const early = await deviationOn('DEVIATION', 'LOT', lotId);
    const incident = await withCommand(db.app, await cmd(db, operator), (c) =>
      raiseIncident(c, { source: 'INTERFACE_FAILURE', type: 'BALANCE_INTERFACE_LOST', severity: 'MAJOR', title: 'Balance interface lost', links: [{ aggregateType: 'material_lot', aggregateId: lotId }] }));
    await withCommand(db.app, await cmd(db, qaReviewer3), (c) => assessIncidentImpact(c, incident, { aggregateType: 'material_lot', aggregateId: lotId }, 'NO_IMPACT', 'No effect on the lot'));
    const api = await apiLot();
    await consumed(api, batchId);
    await review(batchId);

    // Another lot whose evidence all comes after its review, with its own deviation, consumed lot and a disposed sample.
    const other = await readyLot();
    const otherDeviation = await deviationOn('DEVIATION', 'LOT', other.lotId);
    const otherBatchDeviation = await deviationOn('DEVIATION', 'BATCH', other.batchId);
    const otherApi = await apiLot();
    await consumed(otherApi, other.batchId);
    await disposed((await sampleIds(other.lotId))[0]!);

    let g = await grel(lotId);
    expect(g.items.filter((i) => i.since_review).map((i) => i.id)).toEqual([]);
    expect(item(g, 'G2.DEVIATIONS')).toMatchObject({ status: 'RED', since_review: false });
    expect(item(g, 'G2.DEVIATIONS').evidence.map((e) => e.ref)).toEqual([early.deviationId]);
    expect(refs(item(g, 'G3.LIMS'))).toEqual([resultId]);
    expect(refs(item(g, 'G3.SAMPLES'))).toEqual(await sampleIds(lotId));
    expect(item(g, 'G5.MATERIALS')).toMatchObject({ status: 'GREEN', evidence: [{ kind: 'LOT', ref: api }] });
    expect(item(g, 'G7.INCIDENTS')).toMatchObject({ status: 'GREEN', since_review: false, evidence: [{ kind: 'INCIDENT', ref: incident }] });
    expect((await one<{ consumed: [string, string][] }>('select recipe.grel_versions($1) as r', [lotId])).consumed.map((x) => x[0])).toEqual([api]);
    expect((await db.app.query<{ r: string[] }>('select recipe.release_deviations($1) as r', [lotId])).rows[0]!.r).toEqual([early.deviationId]);
    expect((await db.app.query<{ r: string[] }>('select recipe.release_deviations($1) as r', [other.lotId])).rows[0]!.r.sort())
      .toEqual([otherDeviation.deviationId, otherBatchDeviation.deviationId].sort());
    // The other lot's disposed sample is not its evidence any more.
    expect(refs(item(await grel(other.lotId), 'G3.SAMPLES'))).toEqual([]);

    // After the review: a release result not yet approved, a deviation on the consumed API lot and one on the lot.
    await sqlAs(analyst, 'select site.record_lot_test_result($1, $2::jsonb) as r', [lotId, JSON.stringify({ testCode: 'ASSAY', purpose: 'RELEASE', value: '99.7' })]);
    await deviationOn('DEVIATION', 'LOT', api);
    await deviationOn('DEVIATION', 'LOT', lotId);
    g = await grel(lotId);
    expect(g.items.filter((i) => i.since_review).map((i) => i.id).sort()).toEqual(['G2.DEVIATIONS', 'G3.LIMS', 'G5.MATERIALS']);
  });

  it('[PR-53][INV-05] a justification reads only the links of the lot and its batches: another lot\'s unassessed link does not refuse it; the lot\'s own unassessed link does', async () => {
    const a = await readyLot();
    const b = await readyLot();
    const shared = await deviationOn('DEVIATION', 'LOT', a.lotId);
    await w.run(operator, (c) => c.query('select site.link_deviation($1, $2, $3)', [shared.deviationId, 'LOT', b.lotId]));
    await w.run(operator, (c) => c.query('select site.link_deviation($1, $2, $3)', [shared.deviationId, 'BATCH', b.batchId]));
    await impactOn(shared.deviationId, [{ kind: 'LOT', id: a.lotId }]);
    const why = (lotId: string, deviationId: string): Promise<string | null> =>
      one<string | null>("select recipe.investigation_unjustifiable_for($1, 'IN', $2) as r", [lotId, deviationId]);
    expect(await why(a.lotId, shared.deviationId)).toBeNull();
    expect(await why(b.lotId, shared.deviationId)).toMatch(/is not assessed for IN/);
    const own = await deviationOn('DEVIATION', 'LOT', a.lotId);
    expect(await why(a.lotId, own.deviationId)).toMatch(new RegExp(`its link to lot ${await lotCode(a.lotId)} is not assessed for IN`));
  });
});
