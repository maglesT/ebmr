/**
 * The release gate G-REL and the manufacturer release in the database (Phase 4 slice 3a; recipe-core 0781, site services
 * 0860 and 0861; outline 5.2.6, 5.2.7, 5.7). Every act runs as the application role through the release definers with
 * real e-signatures of seeded people, and each rule is also tried around (direct writes, another person's signature, a
 * direct lot transition, a stale evaluation).
 *
 * The evidence: a GMP processing batch issued from an effective master and reviewed through the real review acts (its
 * completion, EXECUTION_COMPLETE, is set by the test as in the review tests); its finished lot posted as the edition's
 * definer posts it (site.create_finished_lot; the packaging order's path is the edition's); the lot's specification,
 * release results approved by the head of QC, and reserve samples. Recipe-core's tests run without an edition, so a test
 * edition hook answers groups 4 and 9 (the Tablets items are slice 3b's).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withProtectedNumbers } from '../../../kernel/src/continuity/numbers.ts';
import { tempDir, tempLedger } from '../../../kernel/test/continuity/helpers.ts';
import { withCommand } from '../../../kernel/src/db/command.ts';
import { assessIncidentImpact, raiseIncident } from '../../../kernel/src/records/incidents.ts';
import { challengeFor, cmd, signatureAuth, signWith } from '../../../kernel/test/esig/helpers.ts';
import { signFor } from '../../../kernel/test/records/helpers.ts';
import { seedActor, seedAdministration, seedServiceActor, withReason, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { ensureFixtureChangeRecord, underChange } from '../../../kernel/test/support/change-record.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { approveTestRelease } from '../../../kernel/test/support/validation.ts';
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
const dir = tempDir('release');
const ledger = tempLedger('release', dir.path);

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
  await db.admin.query("update recipe.execution_state set status = 'EXECUTION_COMPLETE' where batch_id = $1", [b]);
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
  await withCommand(db.app, underChange(withReason(owner)), (c) => c.query("select platform.set_setting('release.open_investigation_path', $1)", [value]));
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
  // Slice 7c (DI-03, recipe-core 1250): a GMP batch is issued only on a release with an approved validation summary.
  await approveTestRelease(db);
  await ensureFixtureChangeRecord(db);
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
    await fx.query(`create function test_edition.grel_items(p_lot uuid, p_market text) returns jsonb language sql stable as $$
      select jsonb_build_array(
        jsonb_build_object('id', 'E.RECONCILIATION', 'group', '4', 'title', 'Reconciliation within limits', 'status', 'GREEN', 'problem', null, 'evidence', '[]'::jsonb, 'since_review', false),
        jsonb_build_object('id', 'E.PACK_EXAMINATION', 'group', '9', 'title', 'Finished-pack examination', 'status', 'GREEN', 'problem', null, 'evidence', '[]'::jsonb, 'since_review', false),
        case when exists (select 1 from test_edition.red_lot r where r.lot_id = p_lot)
             then jsonb_build_object('id', 'E.HELD_CONTAINERS', 'group', '10', 'title', 'Held containers dispositioned', 'status', 'RED', 'problem', 'a held container is not dispositioned', 'evidence', '[]'::jsonb, 'since_review', false)
             else jsonb_build_object('id', 'E.HELD_CONTAINERS', 'group', '10', 'title', 'Held containers dispositioned', 'status', 'GREEN', 'problem', null, 'evidence', '[]'::jsonb, 'since_review', false) end)
    $$`);
    await fx.query('grant usage on schema test_edition to ebmr_owner');
    await fx.query('grant select on test_edition.red_lot to ebmr_owner');
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

describe('G-REL and the manufacturer release (outline 5.2.6, 5.2.7; IN-05, INV-05)', () => {
  it('[IN-05][INV-05] a reviewed, tested and sampled lot is READY; the AP acknowledges the since-review items, signs the checklist and the lot leaves quarantine RELEASED with the checklist stored', async () => {
    const lot = await readyLot();
    const g = await grel(lot.lotId);
    expect(red(g)).toEqual([]);
    expect(g.ready).toBe(true);
    expect(g.epoch).toMatch(/^[0-9a-f]{64}$/);
    expect(item(g, 'G1.REVIEW_1')).toMatchObject({ status: 'GREEN', evidence: [{ kind: 'BATCH', ref: lot.batchId }] });
    // The results and samples came after the QA review: the signer acknowledges them one by one.
    expect(g.items.filter((i) => i.since_review).map((i) => i.id).sort()).toEqual(['G3.LIMS', 'G3.SAMPLES']);
    expect(await releaseState(lot.lotId)).toBe('READY');
    expect(await lotState(lot.lotId)).toBe('QUARANTINE');

    const sig = await signDecision(ap, lot.lotId, 'RELEASE');
    expect(await codeOf(record(ap, lot.lotId, 'RELEASE', sig, g.epoch))).toBe('EBMR-REL-021');
    await acknowledgeAll(ap, lot.lotId, g);
    // A stale epoch on the acknowledgement is refused.
    expect(await codeOf(w.run(ap, (c) => c.query("select recipe.acknowledge_release_item($1, 'IN', 'G3.LIMS', $2)", [lot.lotId, 'f'.repeat(64)])))).toBe('EBMR-REL-050');
    expect(await codeOf(w.run(ap, (c) => c.query("select recipe.acknowledge_release_item($1, 'IN', 'G1.REVIEW_1', $2)", [lot.lotId, g.epoch])))).toBe('EBMR-REL-051');
    await record(ap, lot.lotId, 'RELEASE', sig, g.epoch);

    expect(await lotState(lot.lotId)).toBe('RELEASED');
    expect(await releaseState(lot.lotId)).toBe('RELEASED');
    // The decided release provides the stored checklist: the signature still stands on what was signed.
    expect((await db.app.query<{ v: boolean }>("select (esig.signature_state($1) ->> 'valid')::boolean as v", [sig])).rows[0]!.v).toBe(true);
    const { rows } = await db.app.query<{ decision: string; epoch: string; checklist: Grel; checklist_hash: string; person_id: string; delegation_id: string | null }>(
      'select decision, epoch, checklist, checklist_hash, person_id, delegation_id from recipe.manufacturer_release_decision where lot_id = $1', [lot.lotId]);
    expect(rows[0]).toMatchObject({ decision: 'RELEASED', epoch: g.epoch, person_id: ap.personId, delegation_id: null });
    expect(rows[0]!.checklist.items.map((i) => i.id)).toEqual(g.items.map((i) => i.id));
    // One decision per lot; nothing is written directly.
    expect(await codeOf(record(ap, lot.lotId, 'RELEASE', sig, g.epoch))).toBe('EBMR-REL-012');
    expect(await messageOf(db.app.query("insert into recipe.manufacturer_release_decision (lot_id, decision, signature_id, epoch, checklist, checklist_hash, content_hash, person_id, account_id, role_code, correlation_id) values (gen_random_uuid(), 'RELEASED', gen_random_uuid(), $1, '{}', $1, 'x', gen_random_uuid(), gen_random_uuid(), 'AP', gen_random_uuid())", ['a'.repeat(64)]))).toMatch(/permission denied/);
    expect(await messageOf(db.app.query("update recipe.manufacturer_release_decision set decision = 'REJECTED' where lot_id = $1", [lot.lotId]))).toMatch(/permission denied/);
  });

  it('[PR-44][IN-32] a packed lot is not released without reserve samples of at least the computed quantity (twice the full test plan): none and too few keep G3.SAMPLES red and refuse the release; the full quantity releases it', async () => {
    const batchId = await issuedBatch();
    await review(batchId);
    const lotId = await finishedLot(batchId);
    await testedAndSampled(lotId, { samples: false });
    const required = (await db.app.query<{ q: string }>('select site.lot_sample_required($1)::text as q', [lotId])).rows[0]!.q;
    expect(Number(required)).toBeGreaterThan(0);
    const pull = (quantity: string) =>
      w.run(analyst, (c) => c.query('select site.pull_lot_sample($1, $2::jsonb)', [lotId, JSON.stringify({ kind: 'RESERVE', quantity, container: 'Marketed blister in carton', storageLocation: 'Reserve room R-2' })]));
    const samples = async () => item(await grel(lotId), 'G3.SAMPLES');
    const none = await samples();
    expect(none.status).toBe('RED');
    expect(none.problem).toMatch(new RegExp(`keeps 0 .*at least ${required.replace('.', '\\.')}.* \\(twice the full test plan\\)`));
    // One unit short of the computed quantity is still too few.
    const short = (await db.app.query<{ q: string }>('select ($1::numeric - 1)::text as q', [required])).rows[0]!.q;
    await pull(short);
    let g = await grel(lotId);
    expect(red(g)).toEqual(['G3.SAMPLES']);
    expect(g.ready).toBe(false);
    // A second authorised person tries the release on the red checklist (the AP signs the release below).
    await acknowledgeAll(delegate, lotId, g);
    expect(await codeOf(record(delegate, lotId, 'RELEASE', await signDecision(delegate, lotId, 'RELEASE'), g.epoch))).toBe('EBMR-REL-020');
    expect(await lotState(lotId)).toBe('QUARANTINE');
    // The last unit makes the computed quantity: the item turns green and the lot is released.
    await pull('1');
    g = await grel(lotId);
    expect(item(g, 'G3.SAMPLES').status).toBe('GREEN');
    await release(ap, { batchId, lotId });
    expect(await lotState(lotId)).toBe('RELEASED');
  });

  it('[IN-05] the four refusals of the catalog test: an open deviation, no head-of-QC approval, an unsigned step (record not QA reviewed) and a signer who is no AP or delegate', async () => {
    // An open deviation on the batch blocks (deviation-lite, not assessed for IN).
    const open = await readyLot();
    await deviationOn('DEVIATION', 'BATCH', open.batchId);
    // The link is an audit event in the record's scope: G1 asks for the delta review first (INV-48).
    expect(red(await grel(open.lotId))).toEqual(['G1.REVIEW_1', 'G2.DEVIATIONS']);
    await deltaReview(open.batchId);
    let g = await grel(open.lotId);
    expect(red(g)).toEqual(['G2.DEVIATIONS']);
    expect(item(g, 'G2.DEVIATIONS').problem).toMatch(/is not assessed for IN/);
    await acknowledgeAll(ap, open.lotId, g);
    expect(await codeOf(record(ap, open.lotId, 'RELEASE', await signDecision(ap, open.lotId, 'RELEASE'), g.epoch))).toBe('EBMR-REL-020');

    // A release result not approved by the head of QC.
    const unapproved = await readyLot({ approve: false });
    g = await grel(unapproved.lotId);
    expect(red(g)).toEqual(['G3.LIMS']);
    expect(item(g, 'G3.LIMS').problem).toMatch(/not approved by QC/);

    // A record that is not QA reviewed (steps open or the review unsigned).
    const unreviewed = await issuedBatch();
    const lotId = await finishedLot(unreviewed);
    await testedAndSampled(lotId);
    g = await grel(lotId);
    expect(red(g)).toEqual(['G1.REVIEW_1']);
    expect(item(g, 'G1.REVIEW_1').problem).toMatch(/is ISSUED; a disposition follows the completed QA review/);
    expect(await releaseState(lotId)).toBe('NOT_READY');

    // Only the AP (or a named delegate) signs: QA, the head of QC and production cannot.
    const ready = await readyLot();
    for (const who of [qaReviewer3, qcHead, head]) {
      expect(await codeOf(signDecision(who, ready.lotId, 'RELEASE'))).toMatch(/EBMR-ESIG-04[0-5]/);
    }
    // Bypass: another person's valid release signature does not record the act, and a QA reviewer cannot record it.
    g = await grel(ready.lotId);
    await acknowledgeAll(ap, ready.lotId, g);
    const apSig = await signDecision(ap, ready.lotId, 'RELEASE');
    expect(await codeOf(record(delegate, ready.lotId, 'RELEASE', apSig, g.epoch))).toBe('EBMR-REL-013');
    expect(await codeOf(record(qaReviewer3, ready.lotId, 'RELEASE', apSig, g.epoch))).toMatch(/EBMR-IAM-\d{3}/);
    // A release signature cannot record a rejection, nor the other way round.
    expect(await codeOf(record(ap, ready.lotId, 'REJECT', apSig, g.epoch, 'wrong signature'))).toBe('EBMR-REL-013');
    expect(await lotState(ready.lotId)).toBe('QUARANTINE');
  });

  it('[INV-05] a write after the evaluation refuses the release: the epoch moved, and a checklist signed before the change is no longer the current one', async () => {
    const lot = await readyLot();
    const g = await grel(lot.lotId);
    await acknowledgeAll(ap, lot.lotId, g);
    const sig = await signDecision(ap, lot.lotId, 'RELEASE');
    // QC records another release result after the AP evaluated and signed.
    await sqlAs(analyst, 'select site.record_lot_test_result($1, $2::jsonb) as r', [lot.lotId, JSON.stringify({ testCode: 'ASSAY', purpose: 'RELEASE', value: '99.9' })]);
    const after = await grel(lot.lotId);
    expect(after.epoch).not.toBe(g.epoch);
    expect(await codeOf(record(ap, lot.lotId, 'RELEASE', sig, g.epoch))).toBe('EBMR-REL-018');
    // Sending the new epoch with the old signature is refused too: the signed checklist is not the current one.
    expect(await codeOf(record(ap, lot.lotId, 'RELEASE', sig, after.epoch))).toMatch(/EBMR-REL-01[38]/);
    expect(await lotState(lot.lotId)).toBe('QUARANTINE');
    // A sample pulled after the evaluation moves the epoch as well (the samples take the lot's epoch lock).
    const before = (await grel(lot.lotId)).epoch;
    await w.run(analyst, (c) => c.query('select site.pull_lot_sample($1, $2::jsonb)', [lot.lotId, JSON.stringify({ kind: 'RESERVE', quantity: '5', container: 'Carton', storageLocation: 'Reserve room R-2' })]));
    expect((await grel(lot.lotId)).epoch).not.toBe(before);
  });

  it('[IN-05] a finished lot leaves quarantine only through the manufacturer release: the material-lot route and a direct transition are refused', async () => {
    const lot = await readyLot();
    const version = (await db.app.query<{ v: string }>("select version::text as v from platform.aggregate_state where aggregate_type = 'material_lot' and aggregate_id = $1", [lot.lotId])).rows[0]!.v;
    for (const event of ['MANUFACTURER_RELEASE', 'MANUFACTURER_REJECT', 'RELEASE']) {
      expect(await messageOf(w.run(ap, (c) => c.query("select platform.transition('material_lot', 'material_lot', $1, $2, $3::bigint, '{}'::jsonb)", [lot.lotId, event, version])))).toMatch(/EBMR-PLAT-0(06|08|68)/);
    }
    expect(await messageOf(w.run(ap, (c) => c.query("select site.lot_transition(l, 'MANUFACTURER_RELEASE', $2::bigint, null, null) from site.material_lot l where l.id = $1", [lot.lotId, version])))).toMatch(/permission denied/);
    expect(await lotState(lot.lotId)).toBe('QUARANTINE');
    await release(ap, lot);
    expect(await lotState(lot.lotId)).toBe('RELEASED');
  });

  it('[IN-05] a named delegate releases under a valid delegation, re-checked when the act is recorded; a revoked delegation refuses it', async () => {
    const delegation = async (): Promise<string> => {
      const id = await w.run(ap, async (c) => (await c.query<{ id: string }>(
        "select iam.request_delegation($1, '{}'::jsonb, '{}', array['MANUFACTURER_RELEASE'], clock_timestamp() - interval '1 minute', clock_timestamp() + interval '1 day', 'SOP-QA-017', 'annual leave of the AP') as id",
        [delegate.personId])).rows[0]!.id);
      await withCommand(db.app, withReason(owner), (c) => c.query("select iam.decide_delegation($1, true, 'approved')", [id]));
      return id;
    };
    const revoked = await readyLot();
    const d1 = await delegation();
    let g = await grel(revoked.lotId);
    await acknowledgeAll(delegate, revoked.lotId, g);
    const sig1 = await signDecision(delegate, revoked.lotId, 'RELEASE', d1);
    await withCommand(db.app, withReason(owner), (c) => c.query("select iam.revoke_delegation($1, 'the AP is back')", [d1]));
    expect(await codeOf(record(delegate, revoked.lotId, 'RELEASE', sig1, g.epoch))).toBe('EBMR-REL-015');

    const lot = await readyLot();
    const d2 = await delegation();
    g = await grel(lot.lotId);
    await acknowledgeAll(delegate, lot.lotId, g);
    const sig2 = await signDecision(delegate, lot.lotId, 'RELEASE', d2);
    await record(delegate, lot.lotId, 'RELEASE', sig2, g.epoch);
    const { rows } = await db.app.query<{ delegation_id: string }>('select delegation_id from recipe.manufacturer_release_decision where lot_id = $1', [lot.lotId]);
    expect(rows[0]?.delegation_id).toBe(d2);
  });

  it('[INV-35][IN-05] a person involved in the lot\'s records never decides its release: the production approver holding the AP role is refused', async () => {
    const lot = await readyLot();
    const approverAsAp = await withSecondRole(db, head, 'AUTHORISED_PERSON');
    expect(await codeOf(signDecision(approverAsAp, lot.lotId, 'RELEASE'))).toMatch(/EBMR-ESIG-04[45]/);
    const involved = (await db.app.query<{ i: string[] }>('select recipe.release_involvement($1) as i', [lot.lotId])).rows[0]!.i;
    expect(involved).toContain(head.personId);
    expect(involved).not.toContain(ap.personId);
  });

  it('[IN-05] a rejection needs the person\'s reason and is possible while NOT_READY; the lot leaves quarantine REJECTED', async () => {
    const lot = await readyLot({ approve: false });
    expect(await releaseState(lot.lotId)).toBe('NOT_READY');
    const g = await grel(lot.lotId);
    const sig = await signDecision(ap, lot.lotId, 'REJECT');
    expect(await codeOf(record(ap, lot.lotId, 'REJECT', sig, g.epoch, ' '))).toBe('EBMR-REL-022');
    // A release signature over a NOT_READY lot is refused (and a RELEASE needs every item green).
    expect(await codeOf(record(ap, lot.lotId, 'RELEASE', sig, g.epoch))).toBe('EBMR-REL-013');
    await w.run(ap, (c) => c.query('select recipe.record_manufacturer_release($1, $2, $3, $4, $5)', [lot.lotId, 'REJECT', sig, g.epoch, 'Assay result not approved; lot rejected']), reason('lot rejected'));
    expect(await lotState(lot.lotId)).toBe('REJECTED');
    expect(await releaseState(lot.lotId)).toBe('REJECTED');
  });

  it('[meta] the edition hook: groups 4 and 9 stay RED until the edition answers them, and a RED edition item blocks', async () => {
    const lot = await readyLot();
    await db.admin.query('insert into test_edition.red_lot (lot_id) values ($1)', [lot.lotId]);
    expect(red(await grel(lot.lotId))).toEqual(['E.HELD_CONTAINERS']);
  });
});

describe('deviations and open investigations (PR-53, PR-08)', () => {
  it('[PR-53] with the switch off an open investigation blocks and cannot be justified; with it on, the release authority\'s signed justification releases the lot and is printed on the release record, never for an OOS record', async () => {
    const lot = await readyLot();
    const dev = await deviationOn('DEVIATION', 'BATCH', lot.batchId);
    // Classified, impact POTENTIAL for IN signed by QA, concluded: still open (PENDING_CLOSURE).
    await concludedWithImpact(dev.deviationId, 'POTENTIAL');
    await deltaReview(lot.batchId);
    let g = await grel(lot.lotId);
    expect(red(g)).toEqual(['G2.DEVIATIONS']);
    expect(item(g, 'G2.DEVIATIONS').problem).toMatch(/is POTENTIAL/);
    const text = 'The root cause is confirmed and the affected range excludes this lot; closure waits only for the CAPA record.';
    const aggregate = async (deviationId: string, t: string) =>
      `${lot.lotId}/IN/${deviationId}/${(await db.app.query<{ h: string }>("select encode(sha256(convert_to(btrim($1), 'UTF8')), 'hex') as h", [t])).rows[0]!.h}`;
    // A signature stays valid after a refused act, so each person signs an aggregate once and the act is retried with it.
    const signed = new Map<string, string>();
    const justify = async (who: SeededActor, deviationId: string, t: string) => {
      const id = await aggregate(deviationId, t);
      const key = `${who.personId}:${id}`;
      const sig = signed.get(key) ?? (await signFor(db, who, { type: 'investigation_justification', id }, 'OPEN_INVESTIGATION_JUSTIFIED', await deviationState(deviationId)));
      signed.set(key, sig);
      return w.run(who, (c) => c.query("select recipe.justify_open_investigation($1, 'IN', $2, $3, $4)", [lot.lotId, deviationId, t, sig]));
    };
    expect(await codeOf(justify(ap, dev.deviationId, text))).toBe('EBMR-REL-041');

    await setOpenInvestigationPath('ON');
    try {
      // Never for a specification failure (an OOS record), and never by QA (the release authority signs).
      const oos = await deviationOn('OOS', 'LOT', lot.lotId);
      expect(await codeOf(justify(ap, oos.deviationId, text))).toBe('EBMR-REL-043');
      expect(await codeOf(justify(qaReviewer3, dev.deviationId, text))).toMatch(/EBMR-ESIG-040|EBMR-IAM-\d{3}/);
      expect(await messageOf(db.app.query("insert into recipe.open_investigation_justification (lot_id, market, deviation_id, justification, signature_id, person_id, account_id) values ($1, 'IN', $2, 'x', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())", [lot.lotId, dev.deviationId]))).toMatch(/permission denied/);
      // The OOS record blocks (not assessed); cancelled by QA it is only listed (L-21).
      await w.run(qaReviewer4, (c) => c.query("select site.cancel_deviation($1, 'raised against the wrong lot')", [oos.deviationId]));
      await justify(ap, dev.deviationId, text);
      if (red(await grel(lot.lotId)).includes('G1.REVIEW_1')) await deltaReview(lot.batchId);
      g = await grel(lot.lotId);
      expect(red(g)).toEqual([]);
      const labels = item(g, 'G2.DEVIATIONS').evidence.map((e) => e.label);
      expect(labels).toContain(`${dev.ref} PENDING_CLOSURE (open, released under a signed justification)`);
      expect(labels).toContain(`${oos.ref} CANCELLED (cancelled)`);
      await release(ap, lot);
      const { rows } = await db.app.query<{ c: Grel }>('select checklist as c from recipe.manufacturer_release_decision where lot_id = $1', [lot.lotId]);
      expect(JSON.stringify(rows[0]!.c)).toContain('released under a signed justification');
    } finally {
      await setOpenInvestigationPath('OFF');
    }
  });

  it('[PR-08] registration-relevant deviations of the records are shown on the release checklist; the application role cannot clear the flag', async () => {
    const lot = await readyLot();
    // A registered-limit breach as the engine raises it (copied from a real register row by the test fixture).
    const b = lot.batchId;
    expect(item(await grel(lot.lotId), 'G2.REGISTRATION').status).toBe('NA');
    const fx = await db.admin.connect();
    try {
      await fx.query('begin');
      await fx.query('set local session_replication_role = replica');
      await fx.query(
        `insert into recipe.exception_register (batch_id, exception_id, row_seq, exception_type, category, severity, tier, title, raising_step_key, raising_step, raised_at, raised_at_us,
                                                raised_by, command_person, mandatory, qa_only, deviation_required, registration_relevant, release_blocking, blocks_until, raised_record, correlation_id)
         values ($1, 'EX-REG-1', 1, 'LIMIT_BREACH', 'OUT_OF_LIMIT', 'CRITICAL', 'REGISTERED', 'LOD above the registered limit', null, null, now(), 0,
                 'test', gen_random_uuid(), true, true, true, true, true, null, '{}'::jsonb, gen_random_uuid())`,
        [b],
      );
      await fx.query('commit');
    } catch (error) {
      await fx.query('rollback');
      throw error;
    } finally {
      fx.release();
    }
    const reg = item(await grel(lot.lotId), 'G2.REGISTRATION');
    expect(reg.status).toBe('GREEN');
    expect(reg.evidence).toEqual([{ kind: 'EXCEPTION', ref: `${b}/EX-REG-1`, label: 'EX-REG-1: LOD above the registered limit' }]);
    expect(await messageOf(db.app.query("update recipe.exception_register set registration_relevant = false where batch_id = $1", [b]))).toMatch(/permission denied/);
    expect(await messageOf(db.app.query('delete from recipe.exception_register where batch_id = $1', [b]))).toMatch(/permission denied/);
  });
});

describe('the PR-53 justification after the slice 3 quick review (recipe-core 0783)', () => {
  /** QA starts the investigation; the owner records the given impact for IN on the links of the named subjects only. */
  async function underInvestigation(deviationId: string, impacts: Partial<Record<'LOT' | 'BATCH', 'NONE' | 'POTENTIAL' | 'CONFIRMED'>>): Promise<void> {
    await w.run(qaReviewer, (c) => c.query('select site.start_deviation_investigation($1, $2::jsonb)', [
      deviationId, JSON.stringify({ classification: 'MAJOR', riskRationale: 'QA classification after the first review of the facts', ownerPersonId: qaReviewer2.personId, dueDate: '2027-01-28' }),
    ]));
    await impact(deviationId, impacts);
  }
  async function impact(deviationId: string, impacts: Partial<Record<'LOT' | 'BATCH', 'NONE' | 'POTENTIAL' | 'CONFIRMED'>>): Promise<void> {
    const links = (await db.app.query<{ id: string; k: 'LOT' | 'BATCH' }>('select id, subject_kind as k from site.deviation_link where deviation_id = $1 order by linked_at, id', [deviationId])).rows;
    for (const l of links) {
      const value = impacts[l.k];
      if (!value) continue;
      await w.run(qaReviewer2, (c) => c.query('select site.record_deviation_impact($1, $2::jsonb)', [deviationId, JSON.stringify({ linkId: l.id, market: 'IN', impact: value, rationale: 'Assessed against the investigation findings' })]));
    }
  }
  const hashOf = async (t: string): Promise<string> => (await db.app.query<{ h: string }>("select encode(sha256(convert_to(btrim($1), 'UTF8')), 'hex') as h", [t])).rows[0]!.h;
  async function justify(lot: Lot, deviationId: string, t: string): Promise<unknown> {
    const sig = await signFor(db, ap, { type: 'investigation_justification', id: `${lot.lotId}/IN/${deviationId}/${await hashOf(t)}` }, 'OPEN_INVESTIGATION_JUSTIFIED', await deviationState(deviationId));
    return w.run(ap, (c) => c.query("select recipe.justify_open_investigation($1, 'IN', $2, $3, $4)", [lot.lotId, deviationId, t, sig]));
  }

  it('[PR-53] every link of an open record is read structurally: a link to the lot not assessed for the market refuses the justification, whatever the first blocking reason says', async () => {
    const lot = await readyLot();
    const dev = await deviationOn('DEVIATION', 'BATCH', lot.batchId);
    await w.run(operator, (c) => c.query("select site.link_deviation($1, 'LOT', $2)", [dev.deviationId, lot.lotId]));
    await underInvestigation(dev.deviationId, { BATCH: 'POTENTIAL' });
    await setOpenInvestigationPath('ON');
    try {
      const refused = await messageOf(justify(lot, dev.deviationId, 'Advanced enough: the batch link is assessed POTENTIAL'));
      expect(refused).toMatch(/EBMR-REL-043 .*its link to lot .* is not assessed for IN/);
      expect((await db.app.query<{ p: string | null }>("select recipe.investigation_unjustifiable_for($1, 'IN', $2) as p", [lot.lotId, dev.deviationId]).catch((e: Error) => ({ rows: [{ p: e.message }] }))).rows[0]!.p).toMatch(/permission denied|not assessed/);
      await impact(dev.deviationId, { LOT: 'POTENTIAL' });
      await justify(lot, dev.deviationId, 'Advanced enough: every link is assessed POTENTIAL');
      if (red(await grel(lot.lotId)).includes('G1.REVIEW_1')) await deltaReview(lot.batchId);
      expect(red(await grel(lot.lotId))).toEqual([]);
    } finally {
      await setOpenInvestigationPath('OFF');
    }
  });

  it('[PR-53] a CONFIRMED impact is never released under a justification (D-3a-10): refused at justification, and a justification made before the impact was confirmed no longer counts', async () => {
    const confirmed = await readyLot();
    const dev1 = await deviationOn('DEVIATION', 'BATCH', confirmed.batchId);
    await underInvestigation(dev1.deviationId, { BATCH: 'CONFIRMED' });
    const lot = await readyLot();
    const dev2 = await deviationOn('DEVIATION', 'BATCH', lot.batchId);
    await underInvestigation(dev2.deviationId, { BATCH: 'POTENTIAL' });
    await setOpenInvestigationPath('ON');
    try {
      expect(await messageOf(justify(confirmed, dev1.deviationId, 'Advanced enough despite the confirmed impact'))).toMatch(/EBMR-REL-043 .*CONFIRMED; a confirmed impact is never released under a justification/);
      await justify(lot, dev2.deviationId, 'Advanced enough: the impact is only potential');
      if (red(await grel(lot.lotId)).includes('G1.REVIEW_1')) await deltaReview(lot.batchId);
      expect(red(await grel(lot.lotId))).toEqual([]);
      await impact(dev2.deviationId, { BATCH: 'CONFIRMED' });
      if (red(await grel(lot.lotId)).includes('G1.REVIEW_1')) await deltaReview(lot.batchId);
      const g = await grel(lot.lotId);
      expect(red(g)).toEqual(['G2.DEVIATIONS']);
      expect(item(g, 'G2.DEVIATIONS').problem).toMatch(/is CONFIRMED/);
    } finally {
      await setOpenInvestigationPath('OFF');
    }
  });

  // Phase 6 exit, mutation triage T11 (recipe.investigation_justification_of#2, #4, #6): a justification is bound to its
  // own lot, market and deviation; one signed for another open record of the same lot justifies nothing else.
  it('[PR-53][INV-05] a justification counts for its own deviation only: a second open record of the lot stays RED on G-REL', async () => {
    const lot = await readyLot();
    const justified = await deviationOn('DEVIATION', 'BATCH', lot.batchId);
    const other = await deviationOn('DEVIATION', 'BATCH', lot.batchId);
    await underInvestigation(justified.deviationId, { BATCH: 'POTENTIAL' });
    await underInvestigation(other.deviationId, { BATCH: 'POTENTIAL' });
    await setOpenInvestigationPath('ON');
    try {
      await justify(lot, justified.deviationId, 'Advanced enough: the impact on this batch is only potential');
      if (red(await grel(lot.lotId)).includes('G1.REVIEW_1')) await deltaReview(lot.batchId);
      const g = await grel(lot.lotId);
      expect(red(g)).toEqual(['G2.DEVIATIONS']);
      expect(item(g, 'G2.DEVIATIONS').problem).toContain(`deviation ${other.ref} linked to batch`);
      const labels = item(g, 'G2.DEVIATIONS').evidence.map((e) => e.label);
      expect(labels.find((l) => l.startsWith(`${justified.ref} `))).toMatch(/\(open, released under a signed justification\)$/);
      expect(labels.find((l) => l.startsWith(`${other.ref} `))).not.toMatch(/justification/);
    } finally {
      await setOpenInvestigationPath('OFF');
    }
  });

  it('[PR-53][PR-08] an exception escalated to the record in QA review counts like a linked one: a yield discrepancy is never released under a justification', async () => {
    const lot = await readyLot();
    const dev = await deviationOn('DEVIATION', 'BATCH', lot.batchId);
    await underInvestigation(dev.deviationId, { BATCH: 'POTENTIAL' });
    // A yield exception the QA reviewer escalated to the record (register rows copied by the test fixture).
    const fx = await db.admin.connect();
    try {
      await fx.query('begin');
      await fx.query('set local session_replication_role = replica');
      await fx.query(
        `insert into recipe.exception_register (batch_id, exception_id, row_seq, exception_type, category, severity, tier, title, raising_step_key, raising_step, raised_at, raised_at_us,
                                                raised_by, command_person, mandatory, qa_only, deviation_required, registration_relevant, release_blocking, blocks_until, raised_record, correlation_id)
         values ($1, 'EX-YIELD-1', 1, 'YIELD_OUT_OF_LIMITS', 'OUT_OF_LIMIT', 'ACTION', 'INTERNAL_ACTION', 'Yield below the internal limit', null, null, now(), 0,
                 'test', gen_random_uuid(), true, false, true, false, true, null, '{}'::jsonb, gen_random_uuid())`,
        [lot.batchId],
      );
      await fx.query(
        `insert into recipe.exception_register_act (batch_id, exception_id, act, by_person, by_account, role_code, deviation_ref, note, correlation_id)
         values ($1, 'EX-YIELD-1', 'ESCALATED', $2, $2, 'QA_REVIEWER', $3, 'escalated in QA review', gen_random_uuid())`,
        [lot.batchId, qaReviewer2.personId, dev.ref],
      );
      await fx.query('commit');
    } catch (error) {
      await fx.query('rollback');
      throw error;
    } finally {
      fx.release();
    }
    await setOpenInvestigationPath('ON');
    try {
      expect(await messageOf(justify(lot, dev.deviationId, 'Advanced enough: only the yield is in question'))).toMatch(/EBMR-REL-043 .*yield or reconciliation discrepancy/);
    } finally {
      await setOpenInvestigationPath('OFF');
    }
  });
});

describe('incidents, validation and change (DI-12, PR-09, IN-03)', () => {
  it('[DI-12] an open incident linked to the batch is shown on the disposition checklist and blocks the release until it is assessed for the batch', async () => {
    const lot = await readyLot();
    const incident = await withCommand(db.app, await cmd(db, operator), (c) =>
      raiseIncident(c, { source: 'INTERFACE_FAILURE', type: 'BALANCE_INTERFACE_LOST', severity: 'MAJOR', title: 'Balance interface lost', links: [{ aggregateType: 'batch', aggregateId: lot.batchId }] }));
    if (red(await grel(lot.lotId)).includes('G1.REVIEW_1')) await deltaReview(lot.batchId);
    let g = await grel(lot.lotId);
    expect(red(g)).toEqual(['G7.INCIDENTS']);
    expect(item(g, 'G7.INCIDENTS')).toMatchObject({ since_review: true, evidence: [{ kind: 'INCIDENT', ref: incident }] });
    await acknowledgeAll(delegate, lot.lotId, g);
    expect(await codeOf(record(delegate, lot.lotId, 'RELEASE', await signDecision(delegate, lot.lotId, 'RELEASE'), g.epoch))).toBe('EBMR-REL-020');
    await withCommand(db.app, await cmd(db, qaReviewer3), (c) => assessIncidentImpact(c, incident, { aggregateType: 'batch', aggregateId: lot.batchId }, 'NO_IMPACT', 'The weighing was repeated on a calibrated balance'));
    if (red(await grel(lot.lotId)).includes('G1.REVIEW_1')) await deltaReview(lot.batchId);
    g = await grel(lot.lotId);
    expect(red(g)).toEqual([]);
    expect(item(g, 'G7.INCIDENTS').evidence[0]?.label).toMatch(/\(assessed\)/);
    await release(ap, lot);
  });

  it('[PR-09] a PPQ batch waits for its validation outcome; concurrent release counts for the US only (India treated as the EU, D-P4-6); QA records the outcome once', async () => {
    const lot = await readyLot({ purpose: 'PPQ' });
    let g = await grel(lot.lotId);
    expect(red(g)).toEqual(['G6.PPQ']);
    expect(item(g, 'G6.PPQ').problem).toMatch(/PPQ protocol and its validation outcome is not recorded/);
    const outcome = async (who: SeededActor, b: string, o: string, protocol: string, statement: string) => {
      const h = (await db.app.query<{ h: string }>('select recipe.ppq_statement_hash($1, $2) as h', [protocol, statement])).rows[0]!.h;
      const sig = await signFor(db, who, { type: 'ppq_outcome', id: `${b}/${o}/${h}` }, 'VALIDATION_OUTCOME_RECORDED', await reviewState(b));
      return w.run(who, (c) => c.query('select recipe.record_ppq_outcome($1, $2, $3, $4, $5)', [b, o, protocol, statement, sig]));
    };
    await outcome(qaReviewer3, lot.batchId, 'CONCURRENT_RELEASE', 'PV-PROT-7 (permits concurrent release)', 'All protocol results of this batch are complete and within limits');
    g = await grel(lot.lotId);
    expect(item(g, 'G6.PPQ').problem).toMatch(/allowed for the US only; for IN it waits/);
    expect(item(await grel(lot.lotId, 'US'), 'G6.PPQ').status).toBe('GREEN');
    expect(item(await grel(lot.lotId, 'EU'), 'G6.PPQ').status).toBe('RED');
    // Bypass and refusals: a commercial batch has no outcome; the table is the definer's alone.
    const commercial = await readyLot();
    expect(await codeOf(outcome(qaReviewer3, commercial.batchId, 'PASSED', 'PV-1', 'n/a'))).toBe('EBMR-REL-034');
    expect(await messageOf(db.app.query("insert into recipe.ppq_outcome (batch_id, outcome, protocol_ref, statement, signature_id, person_id, account_id) values ($1, 'PASSED', 'x', 'x', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())", [lot.batchId]))).toMatch(/permission denied/);
    await outcome(qaReviewer3, lot.batchId, 'PASSED', 'PV-REP-7', 'The validation report concludes the process is validated');
    expect(await codeOf(outcome(qaReviewer3, lot.batchId, 'FAILED', 'PV-REP-7', 'changed mind'))).toBe('EBMR-REL-036');
    expect(red(await grel(lot.lotId))).toEqual([]);
    await release(ap, lot);
  });

  it('[IN-03] the first batch made under a changed master is released only after QA signs its post-change evaluation; the change\'s regulatory assessment for the market is checked', async () => {
    // A master of its own, changed before any batch is issued on it (an earlier version's running batches would need
    // in-flight dispositions first, PR-05).
    const changed = await effective();
    await productAndSpecification(changed.content);
    const v2 = await w.approvedSuccessor(changed.versionId, (m) => {
      m.header.title = `${m.header.title} (rev 2)`;
    }, { regulatory: [{ market: 'IN', category: 'NOTIFICATION_LOW' }] });
    await w.authorise(auth(v2.versionId));
    const lot = await readyLot({ master: changed });
    const version = (await db.app.query<{ v: string }>('select cr.version_id as v from recipe.batch_execution b join recipe.control_recipe cr on cr.id = b.control_recipe_id where b.id = $1', [lot.batchId])).rows[0]!.v;
    expect(version).toBe(v2.versionId);
    let g = await grel(lot.lotId);
    expect(red(g)).toEqual(['G6.POST_CHANGE']);
    expect(item(g, 'G2.CHANGE_NOTIFICATION').status).toBe('GREEN');
    expect(item(g, 'G6.POST_CHANGE').problem).toMatch(/first made under change record .* not signed its post-change evaluation/);
    const evaluate = async (who: SeededActor, b: string, t: string) => {
      const h = (await db.app.query<{ h: string }>("select encode(sha256(convert_to(btrim($1), 'UTF8')), 'hex') as h", [t])).rows[0]!.h;
      const sig = await signFor(db, who, { type: 'post_change_evaluation', id: `${b}/${h}` }, 'POST_CHANGE_EVALUATED', await reviewState(b));
      return w.run(who, (c) => c.query('select recipe.record_post_change_evaluation($1, $2, $3)', [b, t, sig]));
    };
    const text = 'Yield, IPC trends and release results of the first batch match the pre-change batches';
    // The QA review's signer and the people who made the batch are involved; another QA person evaluates.
    expect(await codeOf(evaluate(qaReviewer2, lot.batchId, text))).toMatch(/EBMR-ESIG-04[45]|ok/);
    if ((await db.app.query('select 1 from recipe.post_change_evaluation where batch_id = $1', [lot.batchId])).rowCount === 0) await evaluate(qaReviewer3, lot.batchId, text);
    expect(await codeOf(evaluate(qaReviewer3, lot.batchId, text))).toMatch(/EBMR-REL-032|EBMR-ESIG-042/);
    g = await grel(lot.lotId);
    expect(red(g)).toEqual([]);
    await release(ap, lot);
    // The second batch on the same version needs no evaluation.
    const second = await readyLot({ master: changed });
    expect(item(await grel(second.lotId), 'G6.POST_CHANGE').status).toBe('NA');
    expect(await codeOf(evaluate(qaReviewer3, second.batchId, text))).toBe('EBMR-REL-030');
  });
});

// Phase 7 slice 7p (recipe-core 1725, site services 1720): a new version of the finished product's specification with a
// three-point dissolution profile and a content-uniformity acceptance value. It runs last: it changes the specification
// in effect for every later lot of the product (reserve samples: twice 10 + 6 + 4 units, the 40 units testedAndSampled pulls).
describe('a dissolution profile and content uniformity on the release checklist (slice 7p; R4 third check, R8 C7)', () => {
  const POINTS = [
    { label: '1 h', timeValue: '1', timeUnit: 'h', upperLimit: '40' },
    { label: '4 h', timeValue: '4', timeUnit: 'h', lowerLimit: '45', upperLimit: '70' },
    { label: '8 h', timeValue: '8', timeUnit: 'h', lowerLimit: '80' },
  ];
  const recordResult = async (lotId: string, p: Json): Promise<string> => {
    const r = await sqlAs<{ resultId: string }>(analyst, 'select site.record_lot_test_result($1, $2::jsonb) as r', [lotId, JSON.stringify({ purpose: 'RELEASE', ...p })]);
    const sig = await signFor(db, qcHead, { type: 'lot_test_result', id: r.resultId }, 'QC_RESULT_APPROVED', 'RECORDED');
    await w.run(qcHead, (c) => c.query('select site.approve_lot_test_result($1, $2)', [r.resultId, sig]));
    return r.resultId;
  };
  const profile = (results: [string, string][], lotId: string) => Promise.all(results.map(([point, value]) => recordResult(lotId, { testCode: 'DISSOLUTION', point, value })));

  beforeAll(async () => {
    const spec = await sqlAs<{ specificationId: string }>(analyst, 'select site.draft_specification($1::jsonb) as r', [
      JSON.stringify({ materialCode: master.content.header.product.code, title: 'Finished product specification (SR, with profile)', monographReference: 'In-house monograph', tests: [
        { testCode: 'ASSAY', methodReference: 'STP-AS', unit: '%', lowerLimit: '95.0', upperLimit: '105.0', required: true, pharmacopoeia: 'IP', edition: '2022', sampleQuantity: '10', sampleUnit: 'units' },
        { testCode: 'DISSOLUTION', methodReference: 'STP-DS-SR', unit: '%', required: true, pharmacopoeia: 'IN_HOUSE', edition: 'STP-DS-SR v1', sampleQuantity: '6', sampleUnit: 'units', points: POINTS },
        { testCode: 'CONTENT-UNIFORMITY', methodReference: 'STP-CU', unit: 'AV', upperLimit: '15.0', required: true, pharmacopoeia: 'IP', edition: '2022', sampleQuantity: '4', sampleUnit: 'units' },
      ] }),
    ]);
    const sig = await signFor(db, qcHead, { type: 'specification', id: spec.specificationId }, 'SPECIFICATION_APPROVED', 'DRAFT');
    await w.run(qcHead, (c) => c.query('select site.approve_specification($1, $2)', [spec.specificationId, sig]));
  });

  it('[IN-05][PR-45][IN-33] the profile is one checklist item: open while a point has no result, green when every point is within its limits, and the lot is released', async () => {
    const lot = await readyLot();
    await recordResult(lot.lotId, { testCode: 'CONTENT-UNIFORMITY', value: '6.1' });
    await profile([['1 h', '31'], ['4 h', '57']], lot.lotId);
    let g = await grel(lot.lotId);
    expect(g.items.filter((i) => i.id.startsWith('G3.PROFILE')).map((i) => i.id)).toEqual(['G3.PROFILE_DISSOLUTION']);
    expect(item(g, 'G3.PROFILE_DISSOLUTION').status).toBe('RED');
    expect(item(g, 'G3.PROFILE_DISSOLUTION').problem).toBe('the requirement is open: time point 8 h of profile DISSOLUTION has no current RELEASE result');
    expect(red(g).sort()).toEqual(['G3.LIMS', 'G3.PROFILE_DISSOLUTION']);
    await profile([['8 h', '86']], lot.lotId);
    g = await grel(lot.lotId);
    const p = item(g, 'G3.PROFILE_DISSOLUTION') as Item & { title: string; evidence: { kind: string; label: string }[] };
    expect(p.status).toBe('GREEN');
    expect(p.title).toBe('DISSOLUTION profile: every time point within its limits');
    expect(p.evidence.map((e) => e.label)).toEqual(['1 h (- to 40 %): 31 % PASS APPROVED', '4 h (45 to 70 %): 57 % PASS APPROVED', '8 h (80 to - %): 86 % PASS APPROVED']);
    // G3.LIMS lists the profile once, not its three point results.
    const lims = item(g, 'G3.LIMS') as Item & { evidence: { kind: string; label: string }[] };
    expect(lims.evidence.filter((e) => e.kind === 'LIMS_PROFILE').map((e) => e.label)).toEqual(['DISSOLUTION profile PASS (3 time points; see its own line)']);
    expect(lims.evidence.filter((e) => e.label.startsWith('DISSOLUTION '))).toHaveLength(1);
    await release(ap, lot);
    expect(await releaseState(lot.lotId)).toBe('RELEASED');
  });

  it('[IN-05][PR-45][IN-33][IN-20] one time point out of its limits fails the profile item and the database refuses the release', async () => {
    const lot = await readyLot();
    await recordResult(lot.lotId, { testCode: 'CONTENT-UNIFORMITY', value: '5.0' });
    await profile([['1 h', '29'], ['4 h', '74'], ['8 h', '90']], lot.lotId);
    const g = await grel(lot.lotId);
    expect(item(g, 'G3.PROFILE_DISSOLUTION').problem).toBe('the requirement fails: time point 4 h of profile DISSOLUTION: 74 % is outside its limits (45 to 70)');
    expect(g.ready).toBe(false);
    expect(await releaseState(lot.lotId)).toBe('NOT_READY');
    // The signature over a NOT_READY lot, or the release decision under it, is refused.
    const outcome = await codeOf(signDecision(ap, lot.lotId, 'RELEASE').then((sig) => record(ap, lot.lotId, 'RELEASE', sig, g.epoch)));
    expect(outcome).toMatch(/^EBMR-/);
    expect(await releaseState(lot.lotId)).toBe('NOT_READY');
  });

  it('[IN-05][PR-45][IN-33] content uniformity of a low-dose tablet is a release requirement as one test: its acceptance value above the limit keeps the lot from release (R8 C7)', async () => {
    const lot = await readyLot();
    await profile([['1 h', '30'], ['4 h', '55'], ['8 h', '85']], lot.lotId);
    const cu = await recordResult(lot.lotId, { testCode: 'CONTENT-UNIFORMITY', value: '16.2' });
    let g = await grel(lot.lotId);
    expect(red(g)).toEqual(['G3.LIMS']);
    expect(item(g, 'G3.LIMS').problem).toMatch(/CONTENT-UNIFORMITY result 16.2 AV of the lot failed its limits/);
    expect((await db.app.query<{ v: string }>('select verdict as v from site.lot_test_result where id = $1', [cu])).rows[0]?.v).toBe('FAIL');
    // A lot whose acceptance value is within the limit is released on the same checklist.
    const good = await readyLot();
    await profile([['1 h', '30'], ['4 h', '55'], ['8 h', '85']], good.lotId);
    await recordResult(good.lotId, { testCode: 'CONTENT-UNIFORMITY', value: '7.4' });
    g = await grel(good.lotId);
    expect(red(g)).toEqual([]);
    await release(ap, good);
  });
});
