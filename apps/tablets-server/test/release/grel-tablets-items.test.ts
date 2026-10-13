/**
 * Phase 4 slice 3b (tablets 1161, 1162; recipe-core 0800): the Tablets items of the release gate G-REL for a finished lot
 * of a GMP packaging order and the processing batch it packs, each a database rule read as the application role with a
 * red and a green case; QA's signed verification of a compendial rule set; a packaging master completes only through its
 * secondary packaging step.
 *
 * The processing batch and its packaging order are planned and issued through the routes (real register numbers, so the
 * order's parent is the database's own link). What the items read (step states, entries, registered exceptions,
 * deviations, containers, a printing step in the processing master, a whole-batch reprocessing link) is arranged as test
 * set-up: the commands that write those records are proven by their own slices' tests.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type SignatureCredentials } from '@ebmr/api-contract';
import { sha256Hex } from '@ebmr/expr';
import { esig, withCommand } from '@ebmr/kernel';
import { openServiceSession } from '@ebmr/test-kit';
import { flow } from '@ebmr/recipe-core';
import { cmd, signatureAuth } from '../../../../packages/kernel/test/esig/helpers.ts';
import type { TestDatabase } from '../../../../packages/kernel/test/support/db.ts';
import { cell, reason } from '../../../../packages/recipe-core/test/lifecycle/support.ts';
import { postOrder } from '../../../../packages/recipe-core/test/lifecycle/gmp-support.ts';
import { actorOfBrowser, personaIn, valueOf } from '../esig/support.ts';
import { codeOf } from '../execution/db-guards-support.ts';
import { asSetup } from '../blocks/compression/plant-support.ts';
import { G21_CONFIG } from '../blocks/packaging/db-support.ts';
import { actorOf, gmpLifecycleWorld, INPUTS, LINE, SITE, startGmpBatchWorld, type GmpBatchWorld } from '../support/gmp-world.ts';

type Json = Record<string, unknown>;
interface Item { id: string; group: string; title: string; status: string; problem: string | null; evidence: { kind: string; ref: string; label: string }[]; since_review: boolean }

let w: GmpBatchWorld;
let db: TestDatabase;
let parentId: string;
let orderId: string;
let lotId: string;
const PACK_SIZE = 'PO-100K';
/** A matcher for a string matching r (typed, for object matchers). */
const like = (r: RegExp): unknown => expect.stringMatching(r);
const SIGNATURES = { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } };

function phase(id: string, type: string, config: Json, signatures: Json = SIGNATURES): Json {
  return { kind: 'phase', id, name: `Packing step ${id}`, block: { type, version: '1' }, config, records: [], computes: [], reads: [], consumes: [], produces: [], uses: [], equipment: [], signatures, significant: true, riskClass: 'HIGH' };
}

/** The processing master as a packaging master of the same product: printed materials, cartoning and coded surplus. */
function packagingContent(base: flow.MbrContent): flow.MbrContent {
  const m = JSON.parse(JSON.stringify(base)) as Json;
  const header = m['header'] as Json;
  header['family'] = `${String(header['family'])}-PK`;
  header['recordKind'] = 'PACKAGING';
  header['packType'] = 'ALU-PVC-BLISTER';
  header['batchSizes'] = [{ id: PACK_SIZE, quantity: { value: '100000', unit: '{tbl}' } }];
  const stage = ((((m['procedure'] as Json)['body'] as Json)['children'] as Json[])[0] as Json)['body'] as Json;
  const prep = ((stage['children'] as Json[])[0] as Json)['body'] as Json;
  const tb24 = phase('p-tb24', 'TB-24', {
    unit: 'TEST-LINE-CTN-R1', devices: [{ id: 'CW', kind: 'CHECKWEIGHER' }], examination: { every: { value: '1', unit: 'h' }, inRunSample: '5', endSample: '20' },
    cartonsPerShipper: '20', ssccPrefix: '089012345', printedStep: 'p-g21',
  });
  prep['children'] = [
    {
      kind: 'parallel', id: 'par-pack',
      branches: [
        { id: 'br-g21', name: 'Printed materials', body: phase('p-g21', 'G-21', G21_CONFIG) },
        { id: 'br-tb24', name: 'Cartoning', body: tb24 },
        { id: 'br-destroy', name: 'Coded surplus', body: phase('p-destroy', 'G-23', {}, { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'WITNESSED', role: 'PRODUCTION_VERIFIER' } }) },
      ],
    },
    ...(prep['children'] as Json[]),
  ];
  const parsed = flow.parseMbr(m);
  if (!parsed.ok) throw new Error(`the packaging master does not parse: ${JSON.stringify(parsed.problems.slice(0, 3))}`);
  return parsed.mbr;
}

// ------------------------------------------------------------------------------------------------
// Arranged facts (test set-up, triggers off)
// ------------------------------------------------------------------------------------------------

const arrange = (sql: string, params: unknown[] = []): Promise<void> => asSetup(w.gmp, sql, params);

/** Sets step instance `key` of batch `batch` (merged into the stored state). */
async function setStep(batch: string, key: string, step: Json): Promise<void> {
  await arrange(`update recipe.execution_state set state = state || jsonb_build_object('steps', coalesce(state -> 'steps', '{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb))
                  where batch_id = $1`, [batch, key, JSON.stringify(step)]);
}

let entrySeq = 9000;
/** Adds an entry of kind `kind` with `data` at step instance `key` of batch `batch`; its id. */
async function addEntry(batch: string, key: string, kind: string, data: Json): Promise<string> {
  entrySeq += 1;
  const id = `EN-${entrySeq}`;
  await arrange(`update recipe.execution_state set state = state || jsonb_build_object('entries', coalesce(state -> 'entries', '{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb))
                  where batch_id = $1`, [batch, id, JSON.stringify({ id, stepKey: key, kind, data, enteredBy: 'test', recordedAt: '0', recordedSeq: entrySeq })]);
  return id;
}
async function dropEntry(batch: string, id: string): Promise<void> {
  await arrange("update recipe.execution_state set state = jsonb_set(state, '{entries}', (state -> 'entries') - $2::text) where batch_id = $1", [batch, id]);
}

/** Registers exception `type` at step instance `key` of batch `batch` (open); its id. */
async function raise(batch: string, key: string, type: string): Promise<string> {
  const id = `EX-${randomUUID().slice(0, 8)}`;
  await arrange(
    `insert into recipe.exception_register (batch_id, exception_id, row_seq, exception_type, category, severity, title, raising_step_key, raising_step, raised_at, raised_at_us,
                                            raised_by, command_person, mandatory, qa_only, deviation_required, registration_relevant, release_blocking, blocks_until, raised_record, correlation_id)
     values ($1, $2, 1, $3, 'OUT_OF_LIMIT', 'ACTION', $3 || ' (test)', $4, split_part($4, '@', 1), clock_timestamp(), 0, 'BLOCK', gen_random_uuid(), true, false, true, false, true, 'DEVIATION', '{}'::jsonb, gen_random_uuid())`,
    [batch, id, type, key],
  );
  return id;
}

/** A deviation of the site (OPEN); its id and reference. */
async function deviation(): Promise<{ id: string; ref: string }> {
  const id = randomUUID();
  const serial = 10000 + Math.floor(Math.random() * 80000000);
  const ref = `DEV-${SITE}-2026-${serial}`;
  await arrange(`insert into site.deviation (id, ref, site_code, ref_year, ref_serial, kind, title, classification, risk_rationale, raised_by_person, raised_by_account, correlation_id)
                 values ($1, $2, $3, 2026, $4, 'DEVIATION', 'Reconciliation outside its limit (test)', 'MAJOR', 'Counts outside the limit need an investigation', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
    [id, ref, SITE, serial]);
  return { id, ref };
}
async function link(batch: string, exception: string, ref: string): Promise<void> {
  await arrange(`insert into recipe.exception_register_act (batch_id, exception_id, act, row_seq, by_person, by_account, role_code, deviation_ref, correlation_id)
                 values ($1, $2, 'DEVIATION_LINKED', 1, gen_random_uuid(), gen_random_uuid(), 'PRODUCTION_SUPERVISOR', $3, gen_random_uuid())`, [batch, exception, ref]);
}
async function disposition(batch: string, exception: string): Promise<void> {
  await arrange(`insert into recipe.exception_register_act (batch_id, exception_id, act, row_seq, by_person, by_account, role_code, outcome, signature_id, note, correlation_id)
                 values ($1, $2, 'DISPOSITIONED', 1, gen_random_uuid(), gen_random_uuid(), 'QA', 'DEVIATION_RAISED', gen_random_uuid(), 'Investigated under the linked deviation', gen_random_uuid())`, [batch, exception]);
}
async function close(dev: string): Promise<void> {
  await arrange("insert into site.deviation_event (deviation_id, event, signature_id, person_id, account_id) values ($1, 'CLOSED', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())", [dev]);
}
/** Resolves exception `ex` of `batch`: linked to a deviation, dispositioned, and the deviation closed. */
async function resolve(batch: string, ex: string): Promise<void> {
  const d = await deviation();
  await link(batch, ex, d.ref);
  await disposition(batch, ex);
  await close(d.id);
}

/** An output container of `batch` in state `state` (held when `held`); its id. */
async function container(batch: string, state: string, held = false): Promise<{ id: string; label: string }> {
  const id = randomUUID();
  const { rows } = await w.gmp.db.admin.query<{ n: string }>('select batch_number as n from recipe.batch_execution where id = $1', [batch]);
  const label = `OC-${rows[0]?.n.replace(/[^A-Za-z0-9/._-]/g, '') ?? 'X'}-${String(10000 + Math.floor(Math.random() * 89999999))}`;
  await arrange(`insert into plant.output_container (id, label_code, batch_id, batch_number, product_code, strength, stage, quantity_unit, opened_by_person, opened_by_account)
                 values ($1, $2, $3, $4, 'P', 'S', 'COMPRESSION', 'kg', gen_random_uuid(), gen_random_uuid())`, [id, label, batch, rows[0]?.n]);
  await arrange("insert into plant.container_close (container_id, net_quantity, person_id, account_id, basis) values ($1, 10, gen_random_uuid(), gen_random_uuid(), 'TYPED')", [id]);
  await arrange("insert into platform.aggregate_state (aggregate_type, aggregate_id, machine_code, machine_version, state, version) values ('output_container', $1, 'output_container', 1, $2, 1)", [id, state]);
  if (held) {
    const check = randomUUID();
    await arrange("insert into plant.ipc_check (id, batch_id, press_code, result, reference, person_id, account_id) values ($1, $2, 'PRESS-T1', 'FAIL', 'TB11:s@:EN-1', gen_random_uuid(), gen_random_uuid())", [check, batch]);
    await arrange('insert into plant.container_hold (container_id, ipc_check_id, person_id, account_id) values ($1, $2, gen_random_uuid(), gen_random_uuid())', [id, check]);
  }
  return { id, label };
}
const setContainerState = (id: string, state: string): Promise<void> => arrange("update platform.aggregate_state set state = $2 where aggregate_type = 'output_container' and aggregate_id = $1", [id, state]);

// ------------------------------------------------------------------------------------------------
// Reading the gate as the application role
// ------------------------------------------------------------------------------------------------

async function items(market = 'IN'): Promise<Item[]> {
  const { rows } = await w.gmp.db.app.query<{ r: Item[] }>('select tab.grel_edition_items($1, $2) as r', [lotId, market]);
  return rows[0]?.r ?? [];
}
async function item(id: string): Promise<Item> {
  const found = (await items()).find((i) => i.id === id);
  if (!found) throw new Error(`no item ${id}`);
  return found;
}

/** A real COMPENDIAL_RULE_SET_VERIFIED signature of the QA approver over rule set `code` version `version`; its id. */
async function signVerification(code: string, version: number): Promise<string> {
  const qa = await actorOf(w.gmp, 'approver');
  const content = await esig.contentForSigning(w.gmp.db.admin, 'compendial_rule_set', `${code}:${version}`);
  const ch = await withCommand(db.app, await cmd(db, qa), (c) =>
    esig.createChallenge(c, { aggregateType: 'compendial_rule_set', aggregateId: `${code}:${version}`, contentVersion: content.contentVersion ?? '1', meaning: 'COMPENDIAL_RULE_SET_VERIFIED', clientContentHash: content.contentHash ?? '' }),
  );
  const authEventId = await signatureAuth(db, qa, qa, ch.challengeId);
  const key = w.gmp.built.ctx.sealKey;
  if (!key) throw new Error('no seal key');
  const r = await withCommand(db.app, await cmd(db, qa), (c) => esig.sign(c, { challengeId: ch.challengeId, authEventId, expectedState: content.state ?? null }, key));
  return r.signatureId;
}

beforeAll(async () => {
  w = await startGmpBatchWorld();
  db = { name: w.gmp.database, admin: w.gmp.db.admin, app: w.gmp.db.app, drop: () => Promise.resolve() };
  const issuer = await w.gmp.asPersona('issuer');
  parentId = await w.issued(issuer);
  const world = await gmpLifecycleWorld(w.gmp);
  const packContent = packagingContent(w.content);
  const v = await world.approvedVersion(packContent);
  await world.authorise({ versionId: v.versionId, market: 'IN', kind: 'CURRENT', cells: [cell(SITE, LINE, PACK_SIZE)], regulatoryBasis: 'IN: registration on file' });
  const steward = await actorOf(w.gmp, 'steward');
  await world.run(steward, (c) =>
    c.query('select site.define_batch_number_rule($1::jsonb)', [
      JSON.stringify({ rule_code: `P-${randomUUID().slice(0, 8).toUpperCase()}`, site_code: SITE, product_code: packContent.header.product.code, batch_kind: 'PACKAGING', format: '{PARENT}/P{SEQ:2}', site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3' }),
    ]),
    reason('packaging numbering rule for the test'),
  );
  const orderNo = await postOrder(w.gmp.db.app, await openServiceSession(w.gmp.db, w.gmp.seed, 'erpInterface'), packContent, PACK_SIZE);
  const planned = valueOf(await issuer.call(routes.planning.planPackagingOrder, { body: { familyId: v.familyId, markets: ['IN'], site: SITE, line: LINE, batchSize: PACK_SIZE, erpOrder: orderNo, parentBatchId: parentId } }));
  orderId = planned.batchId;
  const preview = valueOf(await issuer.call(routes.esig.content, { query: { aggregateType: 'batch_issue', aggregateId: orderId, intent: 'ISSUED' } }));
  const action = { kind: 'GMP_BATCH_ISSUE' as const, batchId: orderId, reason: { code: 'PRODUCTION_PLAN', text: 'Packaging order issued for the plan' }, variants: {}, inputs: INPUTS };
  const challenge = valueOf(
    await issuer.call(routes.esig.createChallenge, { body: { aggregateType: 'batch_issue', aggregateId: orderId, contentVersion: preview.contentVersion, meaning: 'ISSUED', clientContentHash: sha256Hex(preview.canonicalText), action } }),
  );
  const password: SignatureCredentials = { kind: 'PASSWORD', loginName: personaIn(w.gmp, 'issuer').loginName, password: personaIn(w.gmp, 'issuer').password };
  const sign = { challengeId: challenge.challengeId, credentials: password, action };
  valueOf(await issuer.call(routes.esig.sign, { body: { ...sign, proof: await issuer.proof('POST', '/api/esig/sign', sign) } }));
  // The finished lot of the order, 40 packs, as the edition's definer posts it (tab.post_finished_lot is proven in slice 2b).
  const stores = await w.gmp.asPersona('stores');
  lotId = await withCommand(w.gmp.db.admin, { ...(await actorOfBrowser(w.gmp, stores, 'stores')), correlationId: randomUUID() }, async (c) =>
    (await c.query<{ id: string }>('select site.create_finished_lot($1::jsonb) as id', [
      JSON.stringify({ batchId: orderId, batchNumber: planned.batchNumber, edition: 'TABLETS', siteCode: SITE, productCode: packContent.header.product.code, productName: 'Test tablets',
                       strength: packContent.header.product.strength, markets: ['IN'], quantity: '40', unit: 'packs', expiresAt: '2029-06-30T23:59:59Z' }),
    ])).rows[0]?.id ?? '',
  );
  // The order's packing steps as they stand when its record is complete: completed, with an end-of-run examination that
  // passed, the packs reconciled and two full shippers of 20 packs.
  for (const s of ['p-g21', 'p-tb24', 'p-destroy']) await setStep(orderId, `${s}@`, { step: s, status: 'COMPLETED', frames: [] });
  await addEntry(orderId, 'p-tb24@', 'EXAMINATION', { stream: 'EXAM', timing: 'IN_RUN', examined: '5', defective: '0', labelCorrect: true, result: 'PASS' });
  await addEntry(orderId, 'p-tb24@', 'SHIPPER', { sscc: '089012345000000017', packs: '20', part: false });
  await addEntry(orderId, 'p-tb24@', 'SHIPPER', { sscc: '089012345000000024', packs: '20', part: false });
}, 900_000);

afterAll(async () => {
  await w?.close();
});

describe('the Tablets items of G-REL (slice 3b, tablets 1162)', () => {
  it('[INV-05][IN-05] the evidence set of a packaging order\'s lot is the order and its processing parent, in that order (recipe.release_batches)', async () => {
    const { rows } = await w.gmp.db.app.query<{ r: string[] }>('select recipe.release_batches($1) as r', [lotId]);
    expect(rows[0]!.r).toEqual([orderId, parentId]);
  });

  it('[meta] the Tablets hook answers well-formed items for groups 4, 9 and 10 through recipe.grel_evaluate; a lot that is no Tablets finished lot gets one red item', async () => {
    const { rows } = await w.gmp.db.app.query<{ g: { items: Item[] } }>("select recipe.grel_evaluate($1, 'IN') as g", [lotId]);
    const ours = rows[0]!.g.items.filter((i) => i.id.startsWith('E.'));
    expect(ours.map((i) => i.id)).toEqual([
      'E.RECONCILIATION_PRINTED', 'E.RECONCILIATION_PACKS', 'E.RECONCILIATION_SERIAL', 'E.RECONCILIATION_YIELD', 'E.POSTED_QUANTITY',
      'E.FINISHED_PACK_EXAMINATION', 'E.PRINTED_TABLETS_QC', 'E.HELD_CONTAINERS', 'E.CONTAINER_RELEASE', 'E.RULE_SETS_VERIFIED', 'E.WHOLE_BATCH_PARENTS',
    ]);
    expect(new Set(ours.map((i) => i.group))).toEqual(new Set(['4', '9', '10']));
    const other = await w.gmp.db.app.query<{ r: Item[] }>("select tab.grel_edition_items($1, 'IN') as r", [randomUUID()]);
    expect(other.rows[0]?.r).toEqual([expect.objectContaining({ id: 'E.EDITION', status: 'RED' })]);
  });

  it('[PR-37] E.FINISHED_PACK_EXAMINATION: red without an end-of-run examination and while a failed one is unresolved; green once it passed or its failure is resolved', async () => {
    expect(await item('E.FINISHED_PACK_EXAMINATION')).toMatchObject({ group: '9', status: 'RED', problem: like(/no end-of-run examination/) });
    const failed = await addEntry(orderId, 'p-tb24@', 'EXAMINATION', { stream: 'EXAM', timing: 'END', examined: '20', defective: '1', labelCorrect: true, result: 'FAIL' });
    const ex = await raise(orderId, 'p-tb24@', 'LINE_CHECK_FAILED');
    expect(await item('E.FINISHED_PACK_EXAMINATION')).toMatchObject({ status: 'RED', problem: like(/end-of-run examination at p-tb24@ failed and is not resolved/) });
    await resolve(orderId, ex);
    expect(await item('E.FINISHED_PACK_EXAMINATION')).toMatchObject({ status: 'GREEN', problem: null });
    await dropEntry(orderId, failed);
    await addEntry(orderId, 'p-tb24@', 'EXAMINATION', { stream: 'EXAM', timing: 'END', examined: '20', defective: '0', labelCorrect: true, result: 'PASS' });
    expect((await item('E.FINISHED_PACK_EXAMINATION')).status).toBe('GREEN');
    await setStep(orderId, 'p-tb24@', { step: 'p-tb24', status: 'SKIPPED', frames: [] });
    expect(await item('E.FINISHED_PACK_EXAMINATION')).toMatchObject({ status: 'RED', problem: like(/p-tb24@ is SKIPPED, not COMPLETED/) });
    await setStep(orderId, 'p-tb24@', { step: 'p-tb24', status: 'COMPLETED', frames: [] });
  });

  it('[IN-17][PR-39][PR-37] E.RECONCILIATION_PACKS: red without the reconciliation entry and while a pack reconciliation outside its limit has no closed deviation (release is blocked); green once the deviation is closed', async () => {
    expect(await item('E.RECONCILIATION_PACKS')).toMatchObject({ group: '4', status: 'RED', problem: like(/holds no reconciliation of the packs/) });
    await addEntry(orderId, 'p-tb24@', 'RECONCILIATION', { made: '42', shipped: '40', rejects: '0', samples: '0', setAside: '0', reEntered: '0', unexplained: '2', withinLimits: false });
    const ex = await raise(orderId, 'p-tb24@', 'PACK_RECONCILIATION');
    expect(await item('E.RECONCILIATION_PACKS')).toMatchObject({ status: 'RED', problem: like(/outside their limit: exception .* is not dispositioned/) });
    // The catalogue test of IN-17 clause 2: the gate holds the lot.
    const g = (await w.gmp.db.app.query<{ g: { ready: boolean; items: Item[] } }>("select recipe.grel_evaluate($1, 'IN') as g", [lotId])).rows[0]!.g;
    expect(g.ready).toBe(false);
    expect(g.items.find((i) => i.id === 'E.RECONCILIATION_PACKS')?.status).toBe('RED');
    const d = await deviation();
    await link(orderId, ex, d.ref);
    await disposition(orderId, ex);
    const red = await item('E.RECONCILIATION_PACKS');
    expect(red).toMatchObject({ status: 'RED', problem: like(new RegExp(`deviation ${d.ref} .* is OPEN, not CLOSED`)) });
    expect(red.evidence).toEqual(expect.arrayContaining([{ kind: 'DEVIATION', ref: d.id, label: d.ref }]));
    await close(d.id);
    expect(await item('E.RECONCILIATION_PACKS')).toMatchObject({ status: 'GREEN', problem: null });
  });

  it('[IN-17][PR-39][INV-32] E.RECONCILIATION_PRINTED: red while the printed-materials step is open or a printed reconciliation outside its limits is unresolved; green once resolved', async () => {
    expect((await item('E.RECONCILIATION_PRINTED')).status).toBe('GREEN');
    await setStep(orderId, 'p-g21@', { step: 'p-g21', status: 'IN_PROGRESS', frames: [] });
    expect(await item('E.RECONCILIATION_PRINTED')).toMatchObject({ status: 'RED', problem: like(/p-g21@ is IN_PROGRESS: its reconciliation is not closed/) });
    await setStep(orderId, 'p-g21@', { step: 'p-g21', status: 'COMPLETED', frames: [] });
    const ex = await raise(orderId, 'p-g21@', 'PRINTED_RECONCILIATION');
    expect(await item('E.RECONCILIATION_PRINTED')).toMatchObject({ group: '4', status: 'RED', problem: like(/printed materials reconciled outside their limits/) });
    await resolve(orderId, ex);
    expect((await item('E.RECONCILIATION_PRINTED')).status).toBe('GREEN');
  });

  it('[IN-17][PR-39] E.RECONCILIATION_YIELD: a yield outside its limits in the processing batch blocks until its deviation is closed', async () => {
    expect((await item('E.RECONCILIATION_YIELD')).status).toBe('GREEN');
    const ex = await raise(parentId, 'p-yield@', 'YIELD_OUT_OF_LIMITS');
    expect(await item('E.RECONCILIATION_YIELD')).toMatchObject({ group: '4', status: 'RED', problem: like(/a yield outside its limits: exception/) });
    await resolve(parentId, ex);
    expect((await item('E.RECONCILIATION_YIELD')).status).toBe('GREEN');
  });

  it('[PR-42][IN-17] E.RECONCILIATION_SERIAL: an open serial reconciliation blocks until its deviation is closed', async () => {
    expect((await item('E.RECONCILIATION_SERIAL')).status).toBe('GREEN');
    const ex = await raise(orderId, 'p-g21@', 'SERIAL_RECONCILIATION_OPEN');
    expect(await item('E.RECONCILIATION_SERIAL')).toMatchObject({ status: 'RED', problem: like(/a serial pool reconciled open/) });
    await resolve(orderId, ex);
    expect((await item('E.RECONCILIATION_SERIAL')).status).toBe('GREEN');
  });

  it('[PR-45][IN-05] E.POSTED_QUANTITY: the posted quantity must equal the packs put into shippers', async () => {
    expect(await item('E.POSTED_QUANTITY')).toMatchObject({ group: '4', status: 'GREEN' });
    const extra = await addEntry(orderId, 'p-tb24@', 'SHIPPER', { sscc: '089012345000000031', packs: '5', part: true });
    expect(await item('E.POSTED_QUANTITY')).toMatchObject({ status: 'RED', problem: 'the finished lot was posted with 40 packs, but the packaging order put 45 packs into shippers' });
    await dropEntry(orderId, extra);
    expect((await item('E.POSTED_QUANTITY')).status).toBe('GREEN');
  });

  it('[IN-37][PR-45] E.PRINTED_TABLETS_QC: NA when the processing batch prints nothing; red until the QC hold point after printing is approved under a valid signature; green then', async () => {
    expect((await item('E.PRINTED_TABLETS_QC')).status).toBe('NA');
    // The processing master with a printing step followed by its QC hold point (arranged in the batch's control recipe).
    await arrange(`update recipe.control_recipe set snapshot = jsonb_set(snapshot, '{mbr,content,procedure,body}', jsonb_build_object('kind', 'sequence', 'id', 'seq-print', 'children',
                     jsonb_build_array(jsonb_build_object('kind', 'phase', 'id', 'p-print', 'block', jsonb_build_object('type', 'TB-19', 'version', '1')),
                                       jsonb_build_object('kind', 'holdPoint', 'id', 'H-PRINT', 'name', 'QC approval of printed tablets', 'role', 'QA', 'dispositions', jsonb_build_array('APPROVED', 'REJECTED')),
                                       snapshot #> '{mbr,content,procedure,body}')))
                    where id = (select control_recipe_id from recipe.batch_execution where id = $1)`, [parentId]);
    expect(await item('E.PRINTED_TABLETS_QC')).toMatchObject({ group: '10', status: 'RED', problem: like(/holds no printing step/) });
    await setStep(parentId, 'p-print@', { step: 'p-print', status: 'COMPLETED', frames: [] });
    await setStep(parentId, 'H-PRINT@', { step: 'H-PRINT', status: 'ENABLED', frames: [] });
    expect(await item('E.PRINTED_TABLETS_QC')).toMatchObject({ status: 'RED', problem: 'the tablets printed at p-print@ wait for the QC approval at hold point H-PRINT under a valid signature (IN-37)' });
    await setStep(parentId, 'H-PRINT@', { step: 'H-PRINT', status: 'COMPLETED', frames: [], disposition: { positive: true, value: 'APPROVED' }, signatures: [{ role: 'HOLD_POINT', valid: false, id: randomUUID() }] });
    expect((await item('E.PRINTED_TABLETS_QC')).status).toBe('RED');
    await setStep(parentId, 'H-PRINT@', { step: 'H-PRINT', status: 'COMPLETED', frames: [], disposition: { positive: false, value: 'REJECTED' }, signatures: [{ role: 'HOLD_POINT', valid: true, id: randomUUID() }] });
    expect((await item('E.PRINTED_TABLETS_QC')).status).toBe('RED');
    // The stored flag alone does not count: the signature must exist and be valid in the kernel now (quick review 2).
    await setStep(parentId, 'H-PRINT@', { step: 'H-PRINT', status: 'COMPLETED', frames: [], disposition: { positive: true, value: 'APPROVED' }, signatures: [{ role: 'HOLD_POINT', valid: true, id: randomUUID() }] });
    expect(await item('E.PRINTED_TABLETS_QC')).toMatchObject({ status: 'RED', problem: like(/under a valid signature/) });
    const signature = await signVerification('PHEUR-UOW', 1);
    await setStep(parentId, 'H-PRINT@', { step: 'H-PRINT', status: 'COMPLETED', frames: [], disposition: { positive: true, value: 'APPROVED' }, signatures: [{ role: 'HOLD_POINT', valid: true, id: signature }] });
    expect(await item('E.PRINTED_TABLETS_QC')).toMatchObject({ status: 'GREEN', problem: null });
  });

  it('[L-30][TB-11] E.HELD_CONTAINERS: a held container of the processing batch keeps the lot red until QA rejects or releases it', async () => {
    expect((await item('E.HELD_CONTAINERS')).status).toBe('GREEN');
    const c = await container(parentId, 'HELD', true);
    const red = await item('E.HELD_CONTAINERS');
    expect(red).toMatchObject({ group: '10', status: 'RED', problem: `container ${c.label} was held and is HELD: QA has not dispositioned it` });
    expect(red.evidence).toEqual([{ kind: 'CONTAINER', ref: c.id, label: c.label }]);
    await setContainerState(c.id, 'SORTED');
    expect((await item('E.HELD_CONTAINERS')).status).toBe('RED');
    await setContainerState(c.id, 'RELEASED_BY_QA');
    expect((await item('E.HELD_CONTAINERS')).status).toBe('GREEN');
  });

  it('[L-30][INV-27] E.CONTAINER_RELEASE: red with no bulk issued and when a packed container is held after packing; green when every packed container is closed and vouched for or released by QA', async () => {
    expect(await item('E.CONTAINER_RELEASE')).toMatchObject({ status: 'RED', problem: 'no bulk container was issued to the packaging order' });
    const c = await container(parentId, 'CLOSED');
    await arrange("insert into recipe.packaging_bulk_issue (order_batch_id, parent_batch_id, container_id, charge_id, quantity, unit, person_id, account_id) values ($1, $2, $3, gen_random_uuid(), 10, 'kg', gen_random_uuid(), gen_random_uuid())",
      [orderId, parentId, c.id]);
    expect(await item('E.CONTAINER_RELEASE')).toMatchObject({ status: 'GREEN', evidence: [{ kind: 'CONTAINER', ref: c.id, label: c.label }] });
    await setContainerState(c.id, 'HELD');
    expect(await item('E.CONTAINER_RELEASE')).toMatchObject({ status: 'RED', problem: `container ${c.label} packed into this order is HELD` });
    await setContainerState(c.id, 'RELEASED_BY_QA');
    expect((await item('E.CONTAINER_RELEASE')).status).toBe('GREEN');
  });

  it('[PR-47][INV-33] E.WHOLE_BATCH_PARENTS: NA without a whole-batch parent; red while the parent has a container that is not rejected; green once it is', async () => {
    expect((await item('E.WHOLE_BATCH_PARENTS')).status).toBe('NA');
    const issuer = await w.gmp.asPersona('issuer');
    const x = await w.issued(issuer);
    const n = (await w.gmp.db.admin.query<{ n: string }>('select batch_number as n from recipe.batch_execution where id = $1', [x])).rows[0]?.n;
    await arrange('insert into recipe.batch_parent_link (child_batch_id, parent_batch_id, parent_batch_number, parent_containers, request_id) values ($1, $2, $3, $4, gen_random_uuid())', [parentId, x, n, []]);
    const c = await container(x, 'CLOSED');
    expect(await item('E.WHOLE_BATCH_PARENTS')).toMatchObject({ group: '10', status: 'RED', problem: `parent ${n} of the whole-batch reprocessing is not rejected: its container ${c.label} is CLOSED` });
    await setContainerState(c.id, 'REJECTED');
    expect(await item('E.WHOLE_BATCH_PARENTS')).toMatchObject({ status: 'GREEN', evidence: [{ kind: 'BATCH', ref: x, label: n }] });
  });
});

describe('QA verification of a compendial rule set (slice 3b, tablets 1161; tablets spec E.1)', () => {
  it('[IN-34][DI-10] E.RULE_SETS_VERIFIED: NA when no entry cites a rule set; red while a cited rule set has no signed QA verification; green once QA records and signs it', async () => {
    expect((await item('E.RULE_SETS_VERIFIED')).status).toBe('NA');
    await addEntry(parentId, 'p-ipc@', 'WEIGHT_CHECK', { check: 'EN-1', ruleSets: [{ code: 'IP-UOW', version: 1 }] });
    expect(await item('E.RULE_SETS_VERIFIED')).toMatchObject({ group: '10', status: 'RED', problem: 'rule set IP-UOW version 1 has no QA verification against the official text (tablets spec E.1)',
                                                               evidence: [{ kind: 'RULE_SET', ref: 'IP-UOW:1', label: 'IP-UOW version 1' }] });
    const qa = await actorOf(w.gmp, 'approver');
    // Only the quality unit's master-data approver records it, with the official text it was checked against.
    const operator = await actorOf(w.gmp, 'operator1');
    expect(await codeOf(withCommand(db.app, await cmd(db, operator), (c) => c.query("select tab.record_rule_set_verification('IP-UOW', 1, 'IP 2026 vol. 1 controlled copy', 'Bands checked')")))).toMatch(/^EBMR-IAM/);
    expect(await codeOf(withCommand(db.app, await cmd(db, qa), (c) => c.query("select tab.record_rule_set_verification('IP-UOW', 1, ' ', 'Bands checked')")))).toBe('EBMR-TAB-861');
    expect(await codeOf(withCommand(db.app, await cmd(db, qa), (c) => c.query("select tab.record_rule_set_verification('IP-NONE', 1, 'IP 2026', 'Bands checked')")))).toBe('EBMR-TAB-860');
    await withCommand(db.app, await cmd(db, qa), (c) => c.query("select tab.record_rule_set_verification('IP-UOW', 1, 'IP 2026 vol. 1 controlled copy QA-LIB-0042', 'Bands, sample size and acceptance checked against the official text')"));
    expect(await item('E.RULE_SETS_VERIFIED')).toMatchObject({ status: 'RED', problem: 'the QA verification of rule set IP-UOW version 1 is not signed' });
    // A signature over another meaning or record is refused; the right one is bound.
    expect(await codeOf(withCommand(db.app, await cmd(db, qa), (c) => c.query("select tab.sign_rule_set_verification('IP-UOW', 1, $1)", [randomUUID()])))).toMatch(/^EBMR-/);
    const signature = await signVerification('IP-UOW', 1);
    await withCommand(db.app, await cmd(db, qa), (c) => c.query("select tab.sign_rule_set_verification('IP-UOW', 1, $1)", [signature]));
    expect(await item('E.RULE_SETS_VERIFIED')).toMatchObject({ status: 'GREEN', problem: null });
    expect(await codeOf(withCommand(db.app, await cmd(db, qa), (c) => c.query("select tab.sign_rule_set_verification('IP-UOW', 1, $1)", [signature])))).toBe('EBMR-TAB-862');
    // The application role cannot write the verification tables directly.
    expect(await codeOf(db.app.query("insert into tab.rule_set_verification (code, version, document_ref, note, recorded_by_person, recorded_by_account) values ('IP-UOW', 1, 'x', 'y', gen_random_uuid(), gen_random_uuid())"))).toMatch(/permission denied/);
    // A new verification row supersedes the signed one: red again until it is signed.
    await withCommand(db.app, await cmd(db, qa), (c) => c.query("select tab.record_rule_set_verification('IP-UOW', 1, 'IP 2026 addendum controlled copy', 'Rechecked after the addendum')"));
    expect((await item('E.RULE_SETS_VERIFIED')).status).toBe('RED');
  });
});

describe('a packaging master completes only through its secondary packaging step (slice 3b, recipe-core 0800)', () => {
  const problem = async (body: Json): Promise<string | null> =>
    (await w.gmp.db.app.query<{ p: string | null }>("select recipe.packaging_master_problem('tablets', $1::jsonb) as p", [JSON.stringify({ procedure: { body } })])).rows[0]?.p ?? null;
  const tb24 = phase('p-tb24', 'TB-24', {});
  const other = phase('p-other', 'G-21', {});

  it('[PR-37][IN-16] TB-24 in a sequence, a parallel branch, every branch of an alternative or a loop body completes the master; in one branch of an alternative, a replicate that may run none or a hold point only, it does not', async () => {
    expect(await problem({ kind: 'sequence', id: 's', children: [other, tb24] })).toBeNull();
    expect(await problem({ kind: 'stage', id: 'st', body: { kind: 'parallel', id: 'par', branches: [{ id: 'b1', body: other }, { id: 'b2', body: tb24 }] } })).toBeNull();
    expect(await problem({ kind: 'alternative', id: 'alt', branches: [{ id: 'a', body: tb24 }, { id: 'b', body: { kind: 'sequence', id: 's2', children: [other, { ...tb24, id: 'p-tb24b' }] } }] })).toBeNull();
    expect(await problem({ kind: 'loop', id: 'l', body: tb24 })).toBeNull();
    expect(await problem({ kind: 'replicate', id: 'r', count: { mode: 'RUNTIME', min: 1, max: 3 }, body: tb24 })).toBeNull();
    expect(await problem({ kind: 'sequence', id: 's', children: [other, { kind: 'alternative', id: 'alt', branches: [{ id: 'a', body: tb24 }, { id: 'b', body: other }] }] }))
      .toMatch(/can complete without a TB-24 step/);
    expect(await problem({ kind: 'alternative', id: 'alt', branches: [{ id: 'a', body: tb24 }, { id: 'b' }] })).toMatch(/can complete without a TB-24 step/);
    expect(await problem({ kind: 'replicate', id: 'r', count: { mode: 'RUNTIME', min: 0, max: 3 }, body: tb24 })).toMatch(/can complete without a TB-24 step/);
    expect(await problem({ kind: 'sequence', id: 's', children: [other] })).toMatch(/has no TB-24 step/);
  });
});

describe('slice 3 quick review: the Tablets items fail closed (tablets 1163)', () => {
  const contentOfParent = "snapshot #> '{mbr,content}'";
  const setParentContent = (sql: string): Promise<void> =>
    arrange(`update recipe.control_recipe set snapshot = jsonb_set(snapshot, '{mbr,content}', ${sql}) where id = (select control_recipe_id from recipe.batch_execution where id = $1)`, [parentId]);

  it('[IN-34][DI-10] E.RULE_SETS_VERIFIED: an entry whose rule-set reference is malformed is red ("cannot determine"), never dropped to NA', async () => {
    const bad = await addEntry(parentId, 'p-ipc@', 'WEIGHT_CHECK', { check: 'EN-2', ruleSets: [{ code: 'PHEUR-UOW', version: 'one' }] });
    expect(await item('E.RULE_SETS_VERIFIED')).toMatchObject({ status: 'RED', problem: like(/cannot determine the rule sets entry .* cites: its rule-set reference is malformed/) });
    await dropEntry(parentId, bad);
    const notArray = await addEntry(parentId, 'p-ipc@', 'WEIGHT_CHECK', { check: 'EN-3', ruleSets: 'IP-UOW' });
    expect((await item('E.RULE_SETS_VERIFIED')).status).toBe('RED');
    await dropEntry(parentId, notArray);
  });

  it('[IN-37][PR-45] E.PRINTED_TABLETS_QC: a library call whose element is not pinned is red ("cannot determine"); a printing step inlined from a pinned element needs the hold point after it in that element, under a valid signature', async () => {
    await setParentContent(`jsonb_set(${contentOfParent}, '{procedure,body}', jsonb_build_object('kind', 'sequence', 'id', 'seq-lib', 'children',
                              jsonb_build_array(jsonb_build_object('kind', 'libraryCall', 'id', 'call-print', 'element', 'LIB-PRINT', 'bind', '{}'::jsonb),
                                                ${contentOfParent} #> '{procedure,body}')))`);
    expect(await item('E.PRINTED_TABLETS_QC')).toMatchObject({ status: 'RED', problem: like(/cannot determine whether the processing batch prints/) });
    await setParentContent(`jsonb_set(${contentOfParent}, '{library}', coalesce(${contentOfParent} -> 'library', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
                              'ref', 'LIB-PRINT', 'level', 'OPERATION', 'symbols', '[]'::jsonb, 'body', jsonb_build_object('kind', 'sequence', 'id', 'seq-lprint', 'children', jsonb_build_array(
                                jsonb_build_object('kind', 'phase', 'id', 'p-lprint', 'block', jsonb_build_object('type', 'TB-19', 'version', '1')),
                                jsonb_build_object('kind', 'holdPoint', 'id', 'H-LPRINT', 'name', 'QC approval', 'role', 'QA', 'dispositions', jsonb_build_array('APPROVED', 'REJECTED')))))))`);
    await setStep(parentId, 'call-print/p-lprint@', { step: 'call-print/p-lprint', status: 'COMPLETED', frames: [] });
    expect(await item('E.PRINTED_TABLETS_QC')).toMatchObject({ status: 'RED', problem: 'the tablets printed at call-print/p-lprint@ wait for the QC approval at hold point call-print/H-LPRINT under a valid signature (IN-37)' });
    const signature = await signVerification('LEGACY-UOW', 1);
    await setStep(parentId, 'call-print/H-LPRINT@', { step: 'call-print/H-LPRINT', status: 'COMPLETED', frames: [], disposition: { positive: true, value: 'APPROVED' }, signatures: [{ role: 'HOLD_POINT', valid: true, id: signature }] });
    expect(await item('E.PRINTED_TABLETS_QC')).toMatchObject({ status: 'GREEN', problem: null });
  });

  it('[IN-17][PR-39] E.RECONCILIATION_PRINTED: when the packaging master prints but the record holds no G-21 step instance it is red, never NA', async () => {
    const saved = (await w.gmp.db.admin.query<{ s: Json | null }>("select state -> 'steps' -> 'p-g21@' as s from recipe.execution_state where batch_id = $1", [orderId])).rows[0]?.s;
    await arrange("update recipe.execution_state set state = jsonb_set(state, '{steps}', (state -> 'steps') - 'p-g21@') where batch_id = $1", [orderId]);
    expect(await item('E.RECONCILIATION_PRINTED')).toMatchObject({ status: 'RED', problem: 'the packaging master prints, but the record holds no printed-materials step (G-21): nothing was reconciled' });
    await setStep(orderId, 'p-g21@', saved ?? { step: 'p-g21', status: 'COMPLETED', frames: [] });
    expect((await item('E.RECONCILIATION_PRINTED')).status).toBe('GREEN');
  });

  it('[INV-05][DI-37] since_review: false before QA reviewed the packaging record and for facts older than the review; true on an item whose facts changed after it (an exception, a container state)', async () => {
    expect((await items()).every((i) => !i.since_review)).toBe(true);
    await arrange(`insert into recipe.batch_review_act (batch_id, cycle, act, signature_id, person_id, account_id, role_code, correlation_id)
                   values ($1, recipe.batch_review_cycle($1), 'QA_REVIEWED', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'QA', gen_random_uuid())`, [orderId]);
    // Facts recorded in the earlier tests are older than the review: nothing to acknowledge for the packs reconciliation.
    expect((await item('E.RECONCILIATION_PACKS')).since_review).toBe(false);
    const ex = await raise(orderId, 'p-tb24@', 'PACK_RECONCILIATION');
    expect(await item('E.RECONCILIATION_PACKS')).toMatchObject({ status: 'RED', since_review: true });
    await resolve(orderId, ex);
    expect(await item('E.RECONCILIATION_PACKS')).toMatchObject({ status: 'GREEN', since_review: true });
    // A container packed into the order released again after the review.
    expect((await item('E.CONTAINER_RELEASE')).since_review).toBe(false);
    const packed = (await item('E.CONTAINER_RELEASE')).evidence[0]?.ref ?? '';
    await arrange("update platform.aggregate_state set state = 'RELEASED_BY_QA', updated_at = clock_timestamp() where aggregate_type = 'output_container' and aggregate_id = $1", [packed]);
    expect(await item('E.CONTAINER_RELEASE')).toMatchObject({ status: 'GREEN', since_review: true });
  });
});
