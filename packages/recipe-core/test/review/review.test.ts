/**
 * Review of a GMP batch record in the database (Phase 4 slice 1a; recipe-core 0710 to 0716; outline 5.2.2, 5.2.4, 5.4,
 * 7.3, 7.4). Every act runs as the application role through the review definers, with real e-signatures of seeded
 * people; each rule is also tried around (direct writes to the review tables, an act out of order, another person's
 * signature). A GMP batch is issued from an effective master; its exceptions are raised and dispositioned through the
 * execution writers; its completion (EXECUTION_COMPLETE) is set by the test, as the engine's completeness is proven
 * elsewhere (PR-16, DI-43), and a critical register item is copied from a real one by the test (the engine raises
 * critical items only on registered-limit breaches of real steps).
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withProtectedNumbers } from '../../../kernel/src/continuity/numbers.ts';
import { tempDir, tempLedger } from '../../../kernel/test/continuity/helpers.ts';
import { withCommand } from '../../../kernel/src/db/command.ts';
import { sign } from '../../../kernel/src/esig/signing.ts';
import { challengeFor, cmd, ensureSealKey, signatureAuth, testSealKey } from '../../../kernel/test/esig/helpers.ts';
import { decideRoleGrant, requestRoleGrant } from '../../../kernel/src/identity/admin.ts';
import { seedActor, seedAdministration, seedServiceActor, withReason, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import type { Command } from '../../src/engine/index.ts';
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
let supervisor: SeededActor;
let qaFloor: SeededActor;
let head: SeededActor;
let head2: SeededActor;
let qaReviewer: SeededActor;
let qaReviewer2: SeededActor;
let erp: SeededActor;
let master: { familyId: string; content: MbrContent };
const dir = tempDir('review');
const ledger = tempLedger('review', dir.path);

const SITE = 'SITE-1';
const BS = 'BS-200K';
const FIXTURE = 'tablet-granulation-compression';
type Json = Record<string, unknown>;
interface Batch {
  batchId: string;
  content: MbrContent;
}

function without(content: unknown, types: readonly string[]): unknown {
  if (Array.isArray(content)) {
    return content.filter((x) => !(x && typeof x === 'object' && types.includes(String(((x as Json)['block'] as Json | undefined)?.['type'])))).map((x) => without(x, types));
  }
  if (content && typeof content === 'object') return Object.fromEntries(Object.entries(content).map(([k, v]) => [k, without(v, types)]));
  return content;
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

async function effective(): Promise<{ familyId: string; content: MbrContent }> {
  const m = uniqueContent(FIXTURE);
  m.header.product = { ...m.header.product, code: m.header.product.code.toUpperCase() };
  const content = without(m, ['G-09', 'G-10']) as MbrContent;
  const v = await w.approvedVersion(content);
  const auth: lc.MarketAuthorisationDefinition = { versionId: v.versionId, market: 'IN', kind: 'CURRENT', cells: [cell(SITE, 'L1', BS)], regulatoryBasis: 'IN: registration on file' };
  await w.authorise(auth);
  await w.run(steward, (c) =>
    c.query('select site.define_batch_number_rule($1::jsonb)', [
      JSON.stringify({ rule_code: `R-${randomUUID().slice(0, 8).toUpperCase()}`, site_code: SITE, product_code: content.header.product.code, batch_kind: 'PROCESSING', format: 'R{YY}{SEQ:5}', site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3' }),
    ]),
  );
  return { familyId: v.familyId, content };
}

async function issuedBatch(): Promise<Batch> {
  const batchId = randomUUID();
  const erpOrder = await gmpOrderFor(db, erp, master.content, BS);
  await cmd(db, w.cast.issuer).then((ctx) =>
    withProtectedNumbers(db.app, ctx, ledger, (c) => execution.prepareGmpIssue(c, batchId, { familyId: master.familyId, markets: ['IN'], site: SITE, line: 'L1', batchSize: BS, erpOrder })),
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
  return { batchId, content: master.content };
}

async function run(who: SeededActor, b: Batch, command: Json, permission = 'STEP.EXECUTE', role = 'PRODUCTION_OPERATOR'): Promise<{ accepted: boolean; state: Json }> {
  return w.run(who, async (c) => {
    const tx = await execution.ExecutionTx.open(c, define(b.content, { installation: 'GMP', justifications: FIXTURE_JUSTIFICATIONS }), b.batchId);
    const { rows } = await c.query<{ id: string }>("select iam.require_permission($2, $1::jsonb) ->> 'evaluation_id' as id", [JSON.stringify({ site: SITE, area: 'DISP-01' }), permission]);
    const roles = [{ role, permission, evaluationId: rows[0]?.id ?? '' }];
    const r = await tx.command({ ...command, commandId: randomUUID(), actor: { id: who.personId, kind: 'PERSON', roles: [role] } } as unknown as Command, roles);
    return { accepted: r.accepted, state: r.state as unknown as Json };
  });
}

/** Raises an exception (no step) as the operator; returns its id. */
async function raise(b: Batch, description: string): Promise<string> {
  const before = await exceptionIds(b);
  const r = await run(operator, b, { type: 'RAISE_EXCEPTION', description, severity: 'ALERT' });
  expect(r.accepted).toBe(true);
  const id = (await exceptionIds(b)).find((x) => !before.includes(x));
  if (!id) throw new Error('no exception was raised');
  return id;
}

async function exceptionIds(b: Batch): Promise<string[]> {
  const { rows } = await db.admin.query<{ id: string }>('select exception_id as id from recipe.exception_register where batch_id = $1 order by exception_id', [b.batchId]);
  return rows.map((r) => r.id);
}

/** The engine disposition of an exception by `who` (EXCEPTION_DISPOSITIONED), signed in the command that records it. */
async function disposition(b: Batch, exception: string, who: SeededActor = qaFloor, deviationRef: string | null = null): Promise<void> {
  const justification = 'No impact on the product: documentation only';
  await w.run(who, (c) => execution.proposeDisposition(c, b.batchId, exception, { outcome: 'NO_IMPACT', justification, deviationRef }));
  await ensureSealKey(db);
  const ch = await challengeFor(db, who, `${b.batchId}:${exception}`, { meaning: 'EXCEPTION_DISPOSITIONED', aggregateType: 'batch_exception' });
  const ev = await signatureAuth(db, who, who, ch.challengeId);
  const accepted = await withCommand(db.app, await cmd(db, who), async (c) => {
    const s = await sign(c, { challengeId: ch.challengeId, authEventId: ev, expectedState: 'OPEN' }, testSealKey);
    const tx = await execution.ExecutionTx.open(c, define(b.content, { installation: 'GMP', justifications: FIXTURE_JUSTIFICATIONS }), b.batchId);
    const { rows } = await c.query<{ id: string }>("select iam.require_permission('QA.FLOOR_APPROVE', $1::jsonb) ->> 'evaluation_id' as id", [JSON.stringify({ site: SITE, area: 'DISP-01' })]);
    const r = await tx.command(
      { type: 'DISPOSITION_EXCEPTION', exception, outcome: 'NO_IMPACT', justification, signature: { id: s.signatureId, meaning: 'EXCEPTION_DISPOSITIONED', signer: who.personId }, commandId: randomUUID(), actor: { id: who.personId, kind: 'PERSON', roles: ['QA'] } } as unknown as Command,
      [{ role: 'QA', permission: 'QA.FLOOR_APPROVE', evaluationId: rows[0]?.id ?? '' }],
    );
    return r.accepted;
  });
  expect(accepted).toBe(true);
}

async function deviation(batchId: string): Promise<{ deviationId: string; ref: string }> {
  const d = await w.run(operator, async (c) =>
    (await c.query<{ r: { deviationId: string; ref: string } }>('select site.raise_deviation($1::jsonb) as r', [
      JSON.stringify({ kind: 'DEVIATION', title: 'Exception on the shop floor', classification: 'MINOR', riskRationale: 'No product contact; documentation only' }),
    ])).rows[0]!.r,
  );
  await w.run(operator, (c) => c.query("select site.link_deviation($1, 'BATCH', $2)", [d.deviationId, batchId]));
  return d;
}

const complete = (b: Batch, status = 'EXECUTION_COMPLETE') => db.admin.query('update recipe.execution_state set status = $2 where batch_id = $1', [b.batchId, status]);
const state = async (b: Batch): Promise<string> => (await db.app.query<{ s: string }>('select recipe.batch_review_state($1) as s', [b.batchId])).rows[0]!.s;
const epoch = async (b: Batch): Promise<string> => (await db.app.query<{ e: string }>("select recipe.epoch_of('BATCH', $1)::text as e", [b.batchId])).rows[0]!.e;
const problems = async (b: Batch, act: string): Promise<string[]> => (await db.app.query<{ p: string[] }>('select recipe.review_gate_problems($1, $2) as p', [b.batchId, act])).rows[0]!.p;
const dispositionProblem = async (b: Batch): Promise<string | null> => (await db.app.query<{ p: string | null }>('select recipe.review_disposition_problem($1) as p', [b.batchId])).rows[0]!.p;
const valid = async (sig: string): Promise<boolean> => (await db.app.query<{ v: boolean }>("select (esig.signature_state($1) ->> 'valid')::boolean as v", [sig])).rows[0]!.v;

async function approve(b: Batch, who = head): Promise<string> {
  const sig = await w.sign(who, 'batch_review', b.batchId, 'PRODUCTION_APPROVED', await state(b));
  await w.run(who, (c) => c.query('select recipe.record_production_approval($1, $2)', [b.batchId, sig]));
  return sig;
}

async function nextReviewId(b: Batch): Promise<string> {
  return (await db.app.query<{ id: string }>('select recipe.audit_review_next_id($1) as id', [b.batchId])).rows[0]!.id;
}

async function auditReview(b: Batch, who = qaReviewer, meaning = 'AUDIT_TRAIL_REVIEWED'): Promise<string> {
  const id = await nextReviewId(b);
  const sig = await w.sign(who, 'batch_audit_review', id, meaning, await state(b));
  await w.run(who, (c) => c.query('select recipe.record_audit_trail_review($1, $2)', [id, sig]));
  return sig;
}

async function itemsAggregate(b: Batch, disposition: string, items: string[], text: string | null, ref: string | null = null): Promise<string> {
  return (await db.app.query<{ id: string }>('select recipe.review_items_aggregate_id($1, $2, $3, $4, $5) as id', [b.batchId, disposition, items, text, ref])).rows[0]!.id;
}

async function dispose(b: Batch, who: SeededActor, disposition: 'ACCEPT' | 'QUERY' | 'ESCALATE', items: string[], text: string | null, ref: string | null = null): Promise<string> {
  const agg = await itemsAggregate(b, disposition, items, text, ref);
  const sig = await w.sign(who, 'review_items', agg, 'REVIEW_ITEMS_DISPOSITIONED', await state(b));
  await w.run(who, (c) => c.query('select recipe.dispose_review_items($1, $2, $3, $4, $5, $6)', [b.batchId, items, disposition, text, ref, sig]));
  return sig;
}

async function qaReview(b: Batch, who = qaReviewer2): Promise<string> {
  const sig = await w.sign(who, 'batch_review', b.batchId, 'QA_REVIEWED', 'PRODUCTION_APPROVED');
  const seen = await epoch(b);
  await w.run(who, (c) => c.query('select recipe.record_qa_review($1, $2, $3)', [b.batchId, sig, seen]));
  return sig;
}

/** A batch with one dispositioned exception, completed and approved by production. */
async function approvedBatch(): Promise<{ b: Batch; ex: string; approval: string }> {
  const b = await issuedBatch();
  const ex = await raise(b, 'Label roll changed without a recorded check');
  await disposition(b, ex);
  await complete(b);
  const approval = await approve(b);
  return { b, ex, approval };
}

beforeAll(async () => {
  db = await createTestDatabase();
  w = new World(db, await seedCast(db));
  steward = await seedActor(db, { roleCode: 'MASTER_DATA_STEWARD', legalName: 'Mira Steward' });
  operator = await seedActor(db, { roleCode: 'OPERATOR', legalName: 'Om Operator', roomCode: 'DISP-01' });
  supervisor = await seedActor(db, { roleCode: 'SHIFT_SUPERVISOR', legalName: 'Sana Supervisor', roomCode: 'DISP-01' });
  qaFloor = await seedActor(db, { roleCode: 'QA_SHOP_FLOOR', legalName: 'Farah Floor-QA', roomCode: 'DISP-01' });
  head = await seedActor(db, { roleCode: 'HEAD_OF_PRODUCTION', legalName: 'Hari Head' });
  head2 = await seedActor(db, { roleCode: 'HEAD_OF_PRODUCTION', legalName: 'Hema Head' });
  qaReviewer = await seedActor(db, { roleCode: 'QA_REVIEWER', legalName: 'Rhea Reviewer' });
  qaReviewer2 = await seedActor(db, { roleCode: 'QA_REVIEWER', legalName: 'Ravi Reviewer' });
  erp = await seedServiceActor(db, { kind: 'INTEGRATION', source: 'INTEGRATION', roleCode: 'ERP_INTERFACE', name: 'ERP interface' });
  master = await effective();
}, 600_000);

afterAll(async () => {
  await db.drop();
  dir.cleanup();
});

describe('production approval and QA review (outline 5.2.2; INV-30, PR-52)', () => {
  it('[INV-30][PR-52] production approval waits for every exception to be dispositioned, then QA review follows it: QA review and item dispositions before it are refused, as the application role', async () => {
    const b = await issuedBatch();
    const ex = await raise(b, 'Gauge reading taken late');
    const done = await raise(b, 'Label roll changed without a recorded check');
    await disposition(b, done);
    await complete(b);
    expect(await state(b)).toBe('EXECUTION_COMPLETE');
    const gate = await problems(b, 'PRODUCTION_APPROVE');
    expect(gate).toHaveLength(1);
    expect(gate[0]).toMatch(new RegExp(`exception ${ex} .* is neither dispositioned nor raised as a deviation \\(PR-52\\)`));
    const early = await w.sign(head, 'batch_review', b.batchId, 'PRODUCTION_APPROVED', 'EXECUTION_COMPLETE');
    expect(await codeOf(w.run(head, (c) => c.query('select recipe.record_production_approval($1, $2)', [b.batchId, early])))).toBe('EBMR-REV-002');

    // INV-30: nothing of the QA review comes before the production approval.
    const qaEarly = await w.sign(qaReviewer, 'batch_review', b.batchId, 'QA_REVIEWED', 'EXECUTION_COMPLETE');
    expect(await codeOf(w.run(qaReviewer, (c) => c.query('select recipe.record_qa_review($1, $2, $3)', [b.batchId, qaEarly, '0'])))).toBe('EBMR-REV-020');
    expect(await codeOf(w.run(qaReviewer, (c) => c.query("select recipe.dispose_review_items($1, $2, 'QUERY', 'Why no check?', null, $3)", [b.batchId, [ex], qaEarly])))).toBe('EBMR-REV-050');
    // Bypass: the review register is the definers' alone.
    expect(await codeOf(db.app.query("insert into recipe.batch_review_act (batch_id, cycle, act, signature_id, person_id, account_id, role_code, correlation_id) values ($1, 1, 'PRODUCTION_APPROVED', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'X', gen_random_uuid())", [b.batchId]))).toMatch(/permission denied/);
    expect(await state(b)).toBe('EXECUTION_COMPLETE');
  });

  it('[INV-30][PR-52] a completed record with every exception dispositioned is approved by production, with the approver\'s own signature only', async () => {
    const b = await issuedBatch();
    const ex = await raise(b, 'Label roll changed without a recorded check');
    await disposition(b, ex);
    await complete(b);
    expect(await problems(b, 'PRODUCTION_APPROVE')).toEqual([]);
    const other = await w.sign(head2, 'batch_review', b.batchId, 'PRODUCTION_APPROVED', 'EXECUTION_COMPLETE');
    expect(await codeOf(w.run(head, (c) => c.query('select recipe.record_production_approval($1, $2)', [b.batchId, other])))).toBe('EBMR-REV-005');
    expect(await codeOf(w.run(operator, (c) => c.query('select recipe.record_production_approval($1, $2)', [b.batchId, other])))).toMatch(/EBMR-IAM-\d{3}|permission/);
    const approval = await w.sign(head, 'batch_review', b.batchId, 'PRODUCTION_APPROVED', 'EXECUTION_COMPLETE');
    await w.run(head, (c) => c.query('select recipe.record_production_approval($1, $2)', [b.batchId, approval]));
    expect(await state(b)).toBe('PRODUCTION_APPROVED');
    expect(await codeOf(w.run(head2, (c) => c.query('select recipe.record_production_approval($1, $2)', [b.batchId, other])))).toBe('EBMR-REV-002');
  });

  it('[INV-30][PR-52][DI-26] QA review needs every item concluded and the audit-trail review signed; the production approver cannot sign it; with the evidence epoch unchanged it is recorded', async () => {
    const { b, ex } = await approvedBatch();
    const gate = (await problems(b, 'QA_REVIEW')).join(' ');
    expect(gate).toMatch(/is not concluded in review \(it is OPEN\)/);
    expect(gate).toMatch(/audit-trail review of review cycle 1 is not signed/);
    // QA_REVIEWED is independent of the production approver (kernel, S8/S9).
    expect(await codeOf(w.sign(head, 'batch_review', b.batchId, 'QA_REVIEWED', 'PRODUCTION_APPROVED'))).toMatch(/EBMR-ESIG-04[03]|EBMR-IAM|permission/);
    await w.run(qaReviewer2, (c) => c.query('select recipe.show_review_register($1)', [b.batchId]));
    await dispose(b, qaReviewer2, 'ACCEPT', [ex], null);
    await auditReview(b);
    expect(await problems(b, 'QA_REVIEW')).toEqual([]);
    await qaReview(b);
    expect(await state(b)).toBe('QA_REVIEWED');
    expect(await dispositionProblem(b)).toBeNull();
  });

  it('[DI-34] a disposition before the review is complete is refused: the review gate names the missing review until QA_REVIEWED, and QA cannot conclude an item before production approval nor accept one unsigned', async () => {
    const b = await issuedBatch();
    const ex = await raise(b, 'Gauge reading taken late');
    await disposition(b, ex);
    expect(await dispositionProblem(b)).toMatch(/a disposition follows the completed QA review \(DI-34\)/);
    await complete(b);
    expect(await dispositionProblem(b)).toMatch(/is EXECUTION_COMPLETE/);
    // The unsigned acceptance of the Phase 3 register is closed for GMP batches.
    expect(await codeOf(w.run(qaReviewer, (c) => c.query("select recipe.review_exception($1, $2, 'ACCEPTED_BY_QA', null, null)", [b.batchId, ex])))).toBe('EBMR-REV-059');
    await approve(b);
    expect(await dispositionProblem(b)).toMatch(/is PRODUCTION_APPROVED/);
  });
});

describe('the exception register in QA review (outline 7.3; PR-52, DI-26)', () => {
  it('[PR-52][DI-26] grouped acceptance takes non-critical items sharing one deviation, after the full list was shown, with one justification; each item gets its own row; a critical item is accepted alone, after its detail was opened, with a justification', async () => {
    const b = await issuedBatch();
    const dev = await deviation(b.batchId);
    const a1 = await raise(b, 'Line clearance record late');
    const a2 = await raise(b, 'Label count entered late');
    const lone = await raise(b, 'Balance printout missing');
    for (const x of [a1, a2]) expect((await run(supervisor, b, { type: 'ATTACH_DEVIATION', exception: x, deviationRef: dev.ref }, 'STEP.SUPERVISE', 'PRODUCTION_SUPERVISOR')).accepted).toBe(true);
    for (const x of [a1, a2]) await disposition(b, x, qaFloor, dev.ref);
    await disposition(b, lone);
    await complete(b);
    // A critical item as the engine raises it on a registered-limit breach (copied from a real register row by the test).
    const crit = `${lone}-C`;
    const fx = await db.admin.connect();
    try {
      await fx.query('begin');
      await fx.query('select kernel.set_actor_context($1::jsonb)', [JSON.stringify({
        person_id: '00000000-0000-0000-0000-000000000000', account_id: '00000000-0000-0000-0000-000000000000', role_code: 'TEST_FIXTURE',
        session_id: '00000000-0000-0000-0000-000000000000', source: 'SYSTEM', site_zone: 'UTC', correlation_id: randomUUID(), legal_name: 'Test fixture',
        reason_code: 'TEST_FIXTURE', reason_text: 'a critical register item copied from a real one' })]);
      await fx.query(
        `insert into recipe.exception_register (batch_id, exception_id, row_seq, exception_type, category, severity, tier, title, raising_step_key, raising_step, raised_at, raised_at_us,
                                                raised_by, command_person, mandatory, qa_only, deviation_required, registration_relevant, release_blocking, blocks_until, raised_record, correlation_id)
         select batch_id, $2, row_seq, 'LIMIT_BREACH', category, 'CRITICAL', 'REGISTERED', 'LOD above the registered limit', raising_step_key, raising_step, raised_at, raised_at_us,
                raised_by, command_person, mandatory, true, deviation_required, true, release_blocking, blocks_until, raised_record, correlation_id
           from recipe.exception_register where batch_id = $1 and exception_id = $3`,
        [b.batchId, crit, lone],
      );
      await fx.query(
        `insert into recipe.exception_register_act (batch_id, exception_id, act, row_seq, by_person, by_account, role_code, outcome, signature_id, note, correlation_id)
         select batch_id, $2, act, row_seq, by_person, by_account, role_code, outcome, signature_id, note, correlation_id
           from recipe.exception_register_act where batch_id = $1 and exception_id = $3 and act = 'DISPOSITIONED'`,
        [b.batchId, crit, lone],
      );
      await fx.query('commit');
    } finally {
      fx.release();
    }
    await approve(b);

    const group = 'Both entries were late for one cause, investigated under the linked deviation; no product impact.';
    // Not before the full list was shown to the person (a refused act signs nothing over HTTP: there the signing and
    // the act are one transaction; here they are two, so each refused attempt is another person's or another text).
    expect(await codeOf(dispose(b, qaReviewer2, 'ACCEPT', [a1, a2], group))).toBe('EBMR-REV-058');
    await w.run(qaReviewer, (c) => c.query('select recipe.show_review_register($1)', [b.batchId]));
    // Not without one justification, and not across items that share no deviation.
    expect(await codeOf(dispose(b, qaReviewer, 'ACCEPT', [a1, a2], null))).toBe('EBMR-REV-054');
    expect(await codeOf(dispose(b, qaReviewer, 'ACCEPT', [a1, lone], group))).toBe('EBMR-REV-057');
    // A critical item is never in a group.
    expect(await codeOf(dispose(b, qaReviewer, 'ACCEPT', [a1, crit], group))).toBe('EBMR-REV-054');
    const sig = await dispose(b, qaReviewer, 'ACCEPT', [a1, a2], group);
    const { rows } = await db.app.query<{ exception_id: string; act: string; note: string; item_count: number }>(
      `select a.exception_id, a.act, a.note, d.item_count from recipe.review_item_disposition d join recipe.exception_register_act a on a.id = d.act_id
        where d.signature_id = $1 order by a.exception_id`,
      [sig],
    );
    expect(rows).toEqual([a1, a2].sort().map((x) => ({ exception_id: x, act: 'ACCEPTED_BY_QA', note: group, item_count: 2 })));
    // The signed content lists every item.
    const { rows: content } = await db.admin.query<{ c: { content: { items: { id: string }[] } } }>("select esig.provide('review_items', $1) as c", [await itemsAggregate(b, 'ACCEPT', [a1, a2], group)]);
    expect(content[0]!.c.content.items.map((i) => i.id)).toEqual([a1, a2].sort());

    // The critical item: alone, with a justification, after its detail was opened by this person.
    expect(await codeOf(dispose(b, qaReviewer, 'ACCEPT', [crit], null))).toBe('EBMR-REV-054');
    expect(await codeOf(dispose(b, qaReviewer2, 'ACCEPT', [crit], 'Investigated: balance recalibrated, results confirmed.'))).toBe('EBMR-REV-055');
    await w.run(qaReviewer, (c) => c.query('select recipe.open_review_item($1, $2)', [b.batchId, crit]));
    await dispose(b, qaReviewer, 'ACCEPT', [crit], 'Investigated: balance recalibrated, results confirmed.');
    // A query, an answer, then the acceptance; the person who asked does not answer.
    await dispose(b, qaReviewer, 'QUERY', [lone], 'Where is the printout?');
    expect(await codeOf(dispose(b, qaReviewer, 'ACCEPT', [lone], null))).toBe('EBMR-REV-052');
    expect(await codeOf(w.run(qaReviewer, (c) => c.query("select recipe.review_exception($1, $2, 'RESPONDED', 'Attached', null)", [b.batchId, lone])))).toMatch(/EBMR-EXE-165|EBMR-IAM/);
    await w.run(head2, (c) => c.query("select recipe.review_exception($1, $2, 'RESPONDED', 'The printout is attached to the deviation.', null)", [b.batchId, lone]));
    await dispose(b, qaReviewer, 'ACCEPT', [lone], 'Answered: the printout is on the deviation.');
    // Bypass: QA's acceptance is never written past the definer.
    expect(await codeOf(db.app.query("insert into recipe.review_item_disposition (act_id, batch_id, exception_id, disposition, aggregate_id, signature_id, item_count) values (1, $1, $2, 'ACCEPT', 'x', gen_random_uuid(), 1)", [b.batchId, lone]))).toMatch(/permission denied/);
  });

  it('[PR-52][DI-26] a person who dispositioned an item cannot conclude it in review, and an escalation names a deviation linked to the batch', async () => {
    const { b, ex } = await approvedBatch();
    // The shop-floor QA who dispositioned it is not the one who concludes it (they hold no review authority either).
    expect(await codeOf(dispose(b, qaFloor, 'ACCEPT', [ex], null))).toMatch(/EBMR-REV-053|EBMR-ESIG|EBMR-IAM/);
    expect(await codeOf(dispose(b, qaReviewer, 'ESCALATE', [ex], 'Repeat event', 'DEV-SITE-1-2026-99999'))).toBe('EBMR-REV-051');
    const dev = await deviation(b.batchId);
    await dispose(b, qaReviewer, 'ESCALATE', [ex], 'Repeat event: impact assessment needed', dev.ref);
    expect((await db.app.query<{ s: string }>('select recipe.review_item_status($1, $2) as s', [b.batchId, ex])).rows[0]!.s).toBe('ESCALATED');
  });
});

describe('the audit-trail review (outline 5.4; DI-25, INV-35, INV-48)', () => {
  it('[INV-35][DI-25] a person involved in the batch cannot sign its audit-trail review: the QA who dispositioned an exception and the production approver are refused by the kernel; an uninvolved reviewer signs it with the high-water mark of every in-scope chain', async () => {
    const b = await issuedBatch();
    const ex = await raise(b, 'Gauge reading taken late');
    const engineQa = await seedActor(db, { roleCode: 'QA_SHOP_FLOOR', legalName: 'Isha Involved', roomCode: 'DISP-01' });
    await disposition(b, ex, engineQa);
    await complete(b);
    // Not before the production approval.
    expect((await problems(b, 'AUDIT_TRAIL_REVIEW')).join(' ')).toMatch(/follows the production approval/);
    await approve(b);
    const involved = (await db.app.query<{ p: string[] }>('select recipe.batch_involvement($1) as p', [b.batchId])).rows[0]!.p;
    expect(involved).toEqual(expect.arrayContaining([operator.personId, engineQa.personId, head.personId, w.cast.issuer.personId]));
    expect(involved).not.toContain(qaReviewer.personId);
    // The QA person who dispositioned the exception, also granted the review role, is refused by the kernel on the
    // provider's involvement set (EBMR-ESIG-045); the production approver and the operator hold no review authority.
    const { admin, owner } = await seedAdministration(db);
    const grant = await withCommand(db.app, withReason(admin), (c) => requestRoleGrant(c, { accountId: engineQa.accountId, roleCode: 'QA_REVIEWER', scope: {}, reason: 'second role for the test' }));
    await withCommand(db.app, withReason(owner), (c) => decideRoleGrant(c, grant, true, 'approved for test'));
    const id = await nextReviewId(b);
    expect(await codeOf(w.sign({ ...engineQa, roleCode: 'QA_REVIEWER' }, 'batch_audit_review', id, 'AUDIT_TRAIL_REVIEWED', 'PRODUCTION_APPROVED'))).toBe('EBMR-ESIG-045');
    expect(await codeOf(w.sign(head, 'batch_audit_review', id, 'AUDIT_TRAIL_REVIEWED', 'PRODUCTION_APPROVED'))).toMatch(/EBMR-ESIG-04[05]/);
    expect(await codeOf(w.sign(operator, 'batch_audit_review', id, 'AUDIT_TRAIL_REVIEWED', 'PRODUCTION_APPROVED'))).toMatch(/EBMR-ESIG-04[05]/);
    // Bypass: another person's valid signature does not record a review.
    const sig = await w.sign(qaReviewer, 'batch_audit_review', id, 'AUDIT_TRAIL_REVIEWED', 'PRODUCTION_APPROVED');
    expect(await codeOf(w.run(qaReviewer2, (c) => c.query('select recipe.record_audit_trail_review($1, $2)', [id, sig])))).toBe('EBMR-REV-005');
    await w.run(qaReviewer, (c) => c.query('select recipe.record_audit_trail_review($1, $2)', [id, sig]));
    const { rows } = await db.app.query<{ high_water: Record<string, string>; act: string }>("select high_water, act from recipe.batch_review_act where batch_id = $1 and review_number is not null", [b.batchId]);
    expect(rows[0]!.act).toBe('AUDIT_TRAIL_REVIEWED');
    expect(Object.keys(rows[0]!.high_water)).toEqual(expect.arrayContaining([`batch:${b.batchId}`, `person:${operator.personId}`]));
    // QA's own register acts never make the review stale (D-1a-2).
    await w.run(qaReviewer2, (c) => c.query('select recipe.show_review_register($1)', [b.batchId]));
    await dispose(b, qaReviewer2, 'ACCEPT', [ex], null);
    expect((await db.app.query<{ c: boolean }>('select recipe.audit_review_covered($1) as c', [b.batchId])).rows[0]!.c).toBe(true);
  });

  it('[INV-48][DI-25] a change in scope after the QA review (a deviation linked to the batch) keeps disposition blocked until a signed delta review covers it; a delta with nothing to review is refused', async () => {
    const { b, ex } = await approvedBatch();
    await w.run(qaReviewer2, (c) => c.query('select recipe.show_review_register($1)', [b.batchId]));
    await dispose(b, qaReviewer2, 'ACCEPT', [ex], null);
    await auditReview(b);
    // A second full review in the cycle is no review: there is nothing after the mark.
    expect((await problems(b, 'AUDIT_TRAIL_REVIEW')).join(' ')).toMatch(/nothing to review/);
    await qaReview(b);
    expect(await dispositionProblem(b)).toBeNull();
    const before = await epoch(b);
    await deviation(b.batchId);
    expect(await dispositionProblem(b)).toMatch(/delta review is due before any disposition \(INV-48/);
    expect(BigInt(await epoch(b))).toBeGreaterThan(BigInt(before));
    // The delta review signs the events after the mark, by an uninvolved reviewer, as DELTA_AUDIT_TRAIL_REVIEWED.
    expect(await codeOf(auditReview(b, qaReviewer, 'AUDIT_TRAIL_REVIEWED'))).toMatch(/EBMR-REV-005|EBMR-ESIG/);
    await auditReview(b, qaReviewer, 'DELTA_AUDIT_TRAIL_REVIEWED');
    expect(await dispositionProblem(b)).toBeNull();
    const { rows } = await db.app.query<{ act: string; from_mark: unknown }>('select act, from_mark from recipe.batch_review_act where batch_id = $1 and review_number = 2', [b.batchId]);
    expect(rows[0]!.act).toBe('DELTA_AUDIT_TRAIL_REVIEWED');
    expect(rows[0]!.from_mark).not.toBeNull();
  });
});

describe('the evidence epoch (plan interface; write after evaluation)', () => {
  it('[INV-30][DI-26] the QA review names the evidence epoch it evaluated: a deviation linked to the batch after the evaluation refuses it; reloaded, it is recorded', async () => {
    const { b, ex } = await approvedBatch();
    await w.run(qaReviewer2, (c) => c.query('select recipe.show_review_register($1)', [b.batchId]));
    await dispose(b, qaReviewer2, 'ACCEPT', [ex], null);
    await auditReview(b);
    const seen = await epoch(b);
    const sig = await w.sign(qaReviewer2, 'batch_review', b.batchId, 'QA_REVIEWED', 'PRODUCTION_APPROVED');
    await deviation(b.batchId);
    expect(await codeOf(w.run(qaReviewer2, (c) => c.query('select recipe.record_qa_review($1, $2, $3)', [b.batchId, sig, seen])))).toMatch(/EBMR-REV-02[01]/);
    // The new link is in scope: a delta review first, then the QA review with the current epoch.
    await auditReview(b, qaReviewer, 'DELTA_AUDIT_TRAIL_REVIEWED');
    await w.run(qaReviewer2, (c) => c.query('select recipe.record_qa_review($1, $2, $3)', [b.batchId, sig, '0'])).catch(() => undefined);
    expect(await state(b)).toBe('PRODUCTION_APPROVED');
    await w.run(qaReviewer2, async (c) => c.query('select recipe.record_qa_review($1, $2, $3)', [b.batchId, sig, await epoch(b)]));
    expect(await state(b)).toBe('QA_REVIEWED');
    // Bypass: the counter is the triggers' alone.
    expect(await codeOf(db.app.query("update recipe.evidence_epoch set version = 1 where subject_id = $1", [b.batchId]))).toMatch(/permission denied/);
    expect(await codeOf(db.app.query("select recipe.bump_epoch('BATCH', $1)", [b.batchId]))).toMatch(/permission denied/);
  });
});

describe('reopening (outline 5.2.2; corrections after the production approval go only through a QA reopen)', () => {
  it('[INV-30] after the production approval nothing in the record changes; a QA reopen with a reason supersedes every review signature of the cycle, and the record takes rows again', async () => {
    const { b, approval } = await approvedBatch();
    expect(await codeOf(run(operator, b, { type: 'RAISE_EXCEPTION', description: 'Found later', severity: 'ALERT' }))).toBe('EBMR-REV-040');
    const atReview = await auditReview(b);
    // Only QA reopens, with a reason.
    const cycle = `${b.batchId}/1`;
    expect(await codeOf(w.sign(head, 'batch_review_reopen', cycle, 'REVIEW_REOPENED', 'PRODUCTION_APPROVED'))).toMatch(/EBMR-IAM|EBMR-ESIG/);
    const reopen = await w.sign(qaReviewer2, 'batch_review_reopen', cycle, 'REVIEW_REOPENED', 'PRODUCTION_APPROVED');
    expect(await codeOf(w.run(qaReviewer2, (c) => c.query('select recipe.reopen_review($1, $2, $3)', [b.batchId, reopen, '  '])))).toBe('EBMR-REV-030');
    await w.run(qaReviewer2, (c) => c.query('select recipe.reopen_review($1, $2, $3)', [b.batchId, reopen, 'A keying error in the label count is to be corrected']));
    expect(await valid(approval)).toBe(false);
    expect(await valid(atReview)).toBe(false);
    expect(await valid(reopen)).toBe(true);
    expect(await state(b)).toBe('EXECUTION_COMPLETE');
    expect((await db.app.query<{ c: number }>('select recipe.batch_review_cycle($1) as c', [b.batchId])).rows[0]!.c).toBe(2);
    expect((await run(operator, b, { type: 'RAISE_EXCEPTION', description: 'Found later', severity: 'ALERT' })).accepted).toBe(true);
    // A second reopen of the same cycle is refused: the record is not in review.
    expect((await problems(b, 'REOPEN')).join(' ')).toMatch(/only a record in review/);
  });
});

describe('the abort checklist (outline 5.2.2 ABORTED -> PRODUCTION_APPROVED)', () => {
  it('[PR-52] an aborted record is approved by production only with its abort checklist, recorded in words, and its exceptions dispositioned', async () => {
    const b = await issuedBatch();
    const ex = await raise(b, 'Granulator stopped');
    await disposition(b, ex);
    await complete(b, 'ABORTED');
    expect((await problems(b, 'PRODUCTION_APPROVE')).join(' ')).toMatch(/abort checklist is not recorded/);
    const sig = await w.sign(head, 'batch_review', b.batchId, 'PRODUCTION_APPROVED', 'ABORTED');
    expect(await codeOf(w.run(head, (c) => c.query('select recipe.record_production_approval($1, $2)', [b.batchId, sig])))).toBe('EBMR-REV-002');
    const list = { materialsAccounted: 'All dispensed material reconciled', outputsDispositioned: 'No output was made', equipmentDirty: 'RMG-01 set dirty', genealogyClosed: 'Nothing charged', contingencyReconciled: '' };
    expect(await codeOf(w.run(head, (c) => c.query('select recipe.record_abort_checklist($1, $2::jsonb)', [b.batchId, JSON.stringify(list)])))).toBe('EBMR-REV-060');
    await w.run(head, (c) => c.query('select recipe.record_abort_checklist($1, $2::jsonb)', [b.batchId, JSON.stringify({ ...list, contingencyReconciled: 'No contingency form was issued' })]));
    // The checklist is part of the signed record: the signature taken before it no longer matches.
    expect(await codeOf(w.run(head, (c) => c.query('select recipe.record_production_approval($1, $2)', [b.batchId, sig])))).toBe('EBMR-REV-005');
    await approve(b, head2);
    expect(await state(b)).toBe('PRODUCTION_APPROVED');
  });
});

describe('free text on US and EU batches (D-P4-12, outline 7.4)', () => {
  it('[PR-52] a text in a non-Latin script needs a translation verified by a second person on a US or EU batch only; the translator does not verify it', async () => {
    expect((await db.app.query<{ a: boolean; b: boolean }>("select recipe.text_needs_translation('लेबल रोल बदला गया') as a, recipe.text_needs_translation('Label roll changed at 25 °C ± 2') as b")).rows[0]).toEqual({ a: true, b: false });
    const b = await issuedBatch();
    const ex = await raise(b, 'लेबल रोल बदला गया');
    await disposition(b, ex);
    await complete(b);
    // An India-only batch needs no translation.
    expect(await problems(b, 'PRODUCTION_APPROVE'), 'India only').toEqual([]);
    // On the same record, as if planned for the US as well (the market set is the batch's, fixed at issue; set by the test).
    await db.admin.query("alter table recipe.batch_execution disable trigger user");
    await db.admin.query("update recipe.batch_execution set market_set = array['IN', 'US'] where id = $1", [b.batchId]);
    await db.admin.query("alter table recipe.batch_execution enable trigger user");
    expect((await problems(b, 'PRODUCTION_APPROVE')).join(' ')).toMatch(/needs an English translation verified by a second person, as the batch is for IN, US \(D-P4-12\)/);
    const ref = `exception:${ex}:raised`;
    expect(await codeOf(w.run(supervisor, (c) => c.query('select recipe.record_translation($1, $2, $3)', [b.batchId, ref, 'लेबल'])))).toBe('EBMR-REV-062');
    const t = (await w.run(supervisor, (c) => c.query<{ id: string }>('select recipe.record_translation($1, $2, $3) as id', [b.batchId, ref, 'Label roll changed']))).rows[0]!.id;
    expect(await codeOf(w.run(supervisor, (c) => c.query('select recipe.verify_translation($1)', [t])))).toBe('EBMR-REV-064');
    await w.run(head2, (c) => c.query('select recipe.verify_translation($1)', [t]));
    expect(await problems(b, 'PRODUCTION_APPROVE')).toEqual([]);
    await approve(b);
    // After the approval, translations wait for a reopen.
    expect(await codeOf(w.run(supervisor, (c) => c.query('select recipe.record_translation($1, $2, $3)', [b.batchId, ref, 'Label roll replaced'])))).toBe('EBMR-REV-061');
  });
});

describe('review by exception paused after three deviations on a step (PR-07)', () => {
  it('[PR-07] three deviations on a low-risk step open a re-review task and pause review-by-exception for that step', async () => {
    const b = await issuedBatch();
    const xs: string[] = [];
    for (let i = 0; i < 3; i += 1) xs.push(await raise(b, `Late entry ${String(i)}`));
    // The exceptions are raised by a step of the master (the register's raising step, set on the copy by the test).
    const step = 'p-blend';
    await db.admin.query("alter table recipe.exception_register disable trigger user");
    await db.admin.query('update recipe.exception_register set raising_step = $2 where batch_id = $1', [b.batchId, step]);
    await db.admin.query("alter table recipe.exception_register enable trigger user");
    for (const [i, x] of xs.entries()) {
      const d = await deviation(b.batchId);
      expect((await run(supervisor, b, { type: 'ATTACH_DEVIATION', exception: x, deviationRef: d.ref }, 'STEP.SUPERVISE', 'PRODUCTION_SUPERVISOR')).accepted).toBe(true);
      const paused = (await db.app.query<{ s: string }>('select recipe.rbe_paused_step($1) as s', [b.batchId])).rows.map((r) => r.s);
      expect(paused).toEqual(i < 2 ? [] : [step]);
    }
    const { rows } = await db.app.query<{ n: number }>('select cardinality(deviation_refs) as n from recipe.rbe_rereview_task t join recipe.stub_batch sb on sb.family_id = t.family_id where sb.id = $1', [b.batchId]);
    expect(rows).toEqual([{ n: 3 }]);
    expect(await codeOf(db.app.query("insert into recipe.rbe_rereview_task (family_id, step_id, deviation_refs, batch_id) values (gen_random_uuid(), 'x', array['a','b','c'], $1)", [b.batchId]))).toMatch(/permission denied/);
  });
});

describe('the correction of a loop reading (plan open question 1, default: counts as failing)', () => {
  it('[DI-24] a loop reading that did not meet the endpoint needs a stored evidence document and QA approval to be corrected, whatever its new value; other readings keep their rule', async () => {
    const b = await issuedBatch();
    const problem = async (command: Json, old: Json): Promise<string | null> =>
      (await db.admin.query<{ p: string | null }>("select recipe.gmp_reference_problem($1, $2::jsonb, '{}'::jsonb, 'COMMAND', $3::jsonb, true) as p", [b.batchId, JSON.stringify(old), JSON.stringify(command)])).rows[0]?.p ?? null;
    const loop = (outcome: string) => ({ decisions: { 'L-DRY@R-DRY=1': { kind: 'LOOP', outcome, inputs: { points: ['P-LOD-1'], derived: [] } } }, points: { 'P-LOD-1': { failed: false } } });
    const sha = createHash('sha256').update(`moisture balance printout ${b.batchId}`).digest('hex');
    const qaApproval = { approver: { id: qaFloor.personId, kind: 'PERSON', roles: ['QA'] } };
    const correction = (extra: Json) => ({ type: 'CORRECT_ENTRY', point: 'P-LOD-1', ...extra });
    expect(await problem(correction({}), loop('CONTINUE'))).toMatch(/^\[603\] .* without the approval of QA/);
    expect(await problem(correction({ approval: { approver: { id: supervisor.personId, kind: 'PERSON', roles: ['PRODUCTION_SUPERVISOR'] } } }), loop('EXHAUSTED'))).toMatch(/without the approval of QA/);
    expect(await problem(correction({ approval: qaApproval, evidence: { kind: 'PRINTOUT', sha256: sha } }), loop('CONTINUE'))).toMatch(/without a stored evidence document/);
    await w.run(operator, (c) =>
      c.query('select site.register_evidence_document($1::jsonb)', [JSON.stringify({ sha256: sha, mediaType: 'image/png', sizeBytes: '2048', storageKey: `evidence/${randomUUID()}.png`, title: 'Moisture balance printout' })]),
    );
    expect(await problem(correction({ approval: qaApproval, evidence: { kind: 'PRINTOUT', sha256: sha } }), loop('CONTINUE'))).toBeNull();
    // The reading of the iteration that met the endpoint (EXIT) keeps the ordinary rule: no requirement without a failure.
    expect(await problem(correction({}), loop('EXIT'))).toBeNull();
  });
});
