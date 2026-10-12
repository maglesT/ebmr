/**
 * Deviation and investigation references on a GMP batch are checked in the database (Phase 3 slice 5a; recipe-core
 * 0601; site services 0730, 0731; slice 5 plan D-S5-2; backlog slice 2 #1b and #6). A real GMP batch is issued from an
 * effective MBR version; its commands run through the execution writers as the application role, so the database's
 * trigger (recipe.execution_change_path_check) and recipe.review_exception decide. The invalidation and the fail-to-pass
 * correction need a failed QA-approved result, so their rule is proven on recipe.gmp_reference_problem, the function
 * the trigger calls, with the batch's real identity.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withProtectedNumbers } from '../../../kernel/src/continuity/numbers.ts';
import { withCommand } from '../../../kernel/src/db/command.ts';
import { tempDir, tempLedger } from '../../../kernel/test/continuity/helpers.ts';
import { cmd } from '../../../kernel/test/esig/helpers.ts';
import { seedActor, seedServiceActor, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { signFor } from '../../../kernel/test/records/helpers.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import type { Command } from '../../src/engine/index.ts';
import type { MbrContent } from '../../src/flow/model.ts';
import * as execution from '../../src/execution/index.ts';
import type * as lc from '../../src/lifecycle/index.ts';
import { define, FIXTURE_INPUTS, FIXTURE_JUSTIFICATIONS } from '../engine/support.ts';
import { bomFor, gmpOrderFor } from './gmp-support.ts';
import { cell, reason, seedCast, uniqueContent, World } from './support.ts';

let db: TestDatabase;
let w: World;
let steward: SeededActor;
let operator: SeededActor;
let supervisor: SeededActor;
let qa: SeededActor;
let qa2: SeededActor;
let qaReviewer: SeededActor;
let qcu: SeededActor;
let erp: SeededActor;
const dir = tempDir('gmp-references');
const ledger = tempLedger('gmp-references', dir.path);

beforeAll(async () => {
  db = await createTestDatabase();
  w = new World(db, await seedCast(db));
  steward = await seedActor(db, { roleCode: 'MASTER_DATA_STEWARD', legalName: 'Mira Steward' });
  operator = await seedActor(db, { roleCode: 'OPERATOR', legalName: 'Om Operator', roomCode: 'DISP-01' });
  supervisor = await seedActor(db, { roleCode: 'SHIFT_SUPERVISOR', legalName: 'Sana Supervisor', roomCode: 'DISP-01' });
  qa = await seedActor(db, { roleCode: 'QA_REVIEWER', legalName: 'Qamar Investigator' });
  qa2 = await seedActor(db, { roleCode: 'QA_REVIEWER', legalName: 'Quentin Approver' });
  qaReviewer = await seedActor(db, { roleCode: 'QA_REVIEWER', legalName: 'Rhea Reviewer' });
  qcu = await seedActor(db, { roleCode: 'AUTHORISED_PERSON', legalName: 'Uma Authoriser' });
  erp = await seedServiceActor(db, { kind: 'INTEGRATION', source: 'INTEGRATION', roleCode: 'ERP_INTERFACE', name: 'ERP interface' });
}, 300_000);

afterAll(async () => {
  await db.drop();
  dir.cleanup();
});

const SITE = 'SITE-1';
const BS = 'BS-200K';
const FIXTURE = 'tablet-granulation-compression';
type Json = Record<string, unknown>;

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
    return content.filter((x) => !(x && typeof x === 'object' && types.includes(String(((x as Json)['block'] as Json | undefined)?.['type'])))).map((x) => without(x, types));
  }
  if (content && typeof content === 'object') return Object.fromEntries(Object.entries(content).map(([k, v]) => [k, without(v, types)]));
  return content;
}

/** An effective master for India at SITE-1/L1/BS-200K with a numbering rule. */
async function effective(given?: MbrContent, rule = true): Promise<{ familyId: string; content: MbrContent }> {
  const m = uniqueContent(FIXTURE);
  m.header.product = { ...m.header.product, code: m.header.product.code.toUpperCase() };
  const content = given ?? (without(m, ['G-09', 'G-10']) as MbrContent);
  const v = await w.approvedVersion(content);
  const auth: lc.MarketAuthorisationDefinition = { versionId: v.versionId, market: 'IN', kind: 'CURRENT', cells: [cell(SITE, 'L1', BS)], regulatoryBasis: 'IN: registration on file' };
  await w.authorise(auth);
  const product = content.header.product.code;
  if (rule) await w.run(steward, (c) =>
    c.query('select site.define_batch_number_rule($1::jsonb)', [
      JSON.stringify({ rule_code: `G-${randomUUID().slice(0, 8).toUpperCase()}`, site_code: SITE, product_code: product, batch_kind: 'PROCESSING', format: 'G{YY}{SEQ:5}', site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3' }),
    ]),
  );
  return { familyId: v.familyId, content };
}

/** Plans a GMP batch of family `familyId` against ERP order `erpOrder`. */
function plan(batchId: string, familyId: string, erpOrder: string): Promise<execution.PlannedGmpBatch> {
  return cmd(db, w.cast.issuer).then((ctx) =>
    withProtectedNumbers(db.app, ctx, ledger, (c) => execution.prepareGmpIssue(c, batchId, { familyId, markets: ['IN'], site: SITE, line: 'L1', batchSize: BS, erpOrder })),
  );
}

/** An effective master and an issued GMP batch of it. */
async function issuedBatch(given?: { familyId: string; content: MbrContent }, planWith?: (batchId: string, erpOrder: string) => Promise<unknown>): Promise<{ batchId: string; content: MbrContent }> {
  const { familyId, content } = given ?? (await effective());
  const v = { familyId };
  const batchId = randomUUID();
  const erpOrder = await gmpOrderFor(db, erp, content, BS);
  await (planWith ? planWith(batchId, erpOrder) : plan(batchId, v.familyId, erpOrder));
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
  return { batchId, content };
}

/** Runs one engine command on the batch as `who` (declared role, evaluated at the dispensing room). */
async function run(
  who: SeededActor,
  b: { batchId: string; content: MbrContent },
  command: Json,
  permission = 'STEP.EXECUTE',
  role = 'PRODUCTION_OPERATOR',
): Promise<{ accepted: boolean; state: Json }> {
  return w.run(who, async (c) => {
    const tx = await execution.ExecutionTx.open(c, define(b.content, { installation: 'GMP', justifications: FIXTURE_JUSTIFICATIONS }), b.batchId);
    const { rows } = await c.query<{ id: string }>("select iam.require_permission($2, $1::jsonb) ->> 'evaluation_id' as id", [JSON.stringify({ site: SITE, area: 'DISP-01' }), permission]);
    const roles = [{ role, permission, evaluationId: rows[0]?.id ?? '' }];
    const r = await tx.command({ ...command, commandId: randomUUID(), actor: { id: who.personId, kind: 'PERSON', roles: [role] } } as unknown as Command, roles);
    return { accepted: r.accepted, state: r.state as unknown as Json };
  });
}

async function deviation(kind: 'DEVIATION' | 'OOS' | 'INVESTIGATION', batchId?: string): Promise<{ deviationId: string; ref: string }> {
  const d = await w.run(operator, async (c) =>
    (await c.query<{ r: { deviationId: string; ref: string } }>('select site.raise_deviation($1::jsonb) as r', [
      JSON.stringify({ kind, title: 'Exception on the shop floor', classification: 'MINOR', riskRationale: 'No product contact; documentation only' }),
    ])).rows[0]!.r,
  );
  if (batchId) await w.run(operator, (c) => c.query("select site.link_deviation($1, 'BATCH', $2)", [d.deviationId, batchId]));
  return d;
}

async function conclude(d: { deviationId: string }, assignableCause: boolean): Promise<void> {
  await w.run(qa, (c) => c.query('select site.start_deviation_investigation($1)', [d.deviationId]));
  await w.run(qa, (c) =>
    c.query('select site.record_deviation_finding($1, $2::jsonb)', [
      d.deviationId,
      JSON.stringify({ assignableCause, cause: 'Analyst used an expired reference standard', rootCauseCategory: assignableCause ? 'LABORATORY_ERROR' : 'NOT_DETERMINED' }),
    ]),
  );
  const sig = await signFor(db, qa2, { type: 'deviation', id: d.deviationId }, 'DEVIATION_CONCLUDED', 'UNDER_INVESTIGATION');
  await w.run(qa2, (c) => c.query('select site.conclude_deviation($1, $2)', [d.deviationId, sig]));
}

const exceptionIds = (state: Json): string[] => Object.keys((state['exceptions'] as Json | undefined) ?? {});

describe('GMP deviation references (D-S2-2, D-S5-2)', () => {
  it('[PR-13][PR-49] ATTACH_DEVIATION on a GMP batch with an unknown, unlinked or cancelled reference is refused; a linked deviation-lite record is accepted; an escalation in review is checked the same way', async () => {
    const b = await issuedBatch();
    const raised = await run(operator, b, { type: 'RAISE_EXCEPTION', description: 'Label roll changed without line clearance record', severity: 'ALERT' });
    expect(raised.accepted).toBe(true);
    const exception = exceptionIds(raised.state)[0] ?? '';
    const attach = (ref: string) =>
      run(supervisor, b, { type: 'ATTACH_DEVIATION', exception, deviationRef: ref }, 'STEP.SUPERVISE', 'PRODUCTION_SUPERVISOR');

    expect(await codeOf(attach('DEV-SITE-1-2026-99999'))).toBe('EBMR-EXE-600');
    const unlinked = await deviation('DEVIATION');
    expect(await codeOf(attach(unlinked.ref))).toBe('EBMR-EXE-600');
    const cancelled = await deviation('DEVIATION', b.batchId);
    await w.run(qa2, (c) => c.query('select site.cancel_deviation($1, $2)', [cancelled.deviationId, 'raised twice']));
    expect(await codeOf(attach(cancelled.ref))).toBe('EBMR-EXE-600');

    const good = await deviation('DEVIATION', b.batchId);
    const linked = await attach(good.ref);
    expect(linked.accepted).toBe(true);
    const { rows } = await db.app.query('select deviation_ref from recipe.exception_register_act where batch_id = $1 and act = $2', [b.batchId, 'DEVIATION_LINKED']);
    expect(rows).toEqual([{ deviation_ref: good.ref }]);

    // Review by exception: an escalation names a linked, valid record too (EBMR-EXE-604).
    const review = (ref: string) => w.run(qaReviewer, (c) => c.query("select recipe.review_exception($1, $2, 'ESCALATED', 'escalated for impact assessment', $3)", [b.batchId, exception, ref]));
    expect(await codeOf(review('DEV-SITE-1-2026-99998'))).toBe('EBMR-EXE-604');
    expect(await codeOf(review(unlinked.ref))).toBe('EBMR-EXE-604');
    expect(await codeOf(review(good.ref))).toBe('ok');
  });

  it('[IN-20][DI-24] a GMP invalidation citing an unknown, cancelled, unlinked or not concluded reference is refused and the concluded one accepted; a fail-to-pass correction needs a stored document of the batch\'s site with the evidence\'s hash', async () => {
    const b = await issuedBatch();
    const problem = async (command: Json, old: Json = {}, next: Json = {}): Promise<string | null> =>
      (await db.admin.query<{ p: string | null }>("select recipe.gmp_reference_problem($1, $2::jsonb, $3::jsonb, 'COMMAND', $4::jsonb, true) as p", [
        b.batchId,
        JSON.stringify(old),
        JSON.stringify(next),
        JSON.stringify(command),
      ])).rows[0]?.p ?? null;
    const invalidate = (ref: string) => problem({ type: 'INVALIDATE_RESULT', point: 'P1', investigationRef: ref, assignableCause: 'expired standard' });

    expect(await invalidate('DEV-SITE-1-2026-99997')).toMatch(/^\[602\] .* is not a deviation-lite record/);
    const unlinked = await deviation('OOS');
    expect(await invalidate(unlinked.ref)).toMatch(/^\[602\] .* is not linked to batch/);
    const open = await deviation('OOS', b.batchId);
    expect(await invalidate(open.ref)).toMatch(/^\[602\] .* no QA-signed conclusion/);
    const cancelled = await deviation('OOS', b.batchId);
    await w.run(qa2, (c) => c.query('select site.cancel_deviation($1, $2)', [cancelled.deviationId, 'duplicate']));
    expect(await invalidate(cancelled.ref)).toMatch(/^\[602\] .* was cancelled/);
    const noCause = await deviation('OOS', b.batchId);
    await conclude(noCause, false);
    expect(await invalidate(noCause.ref)).toMatch(/^\[602\] .* without an assignable cause/);
    const good = await deviation('OOS', b.batchId);
    await conclude(good, true);
    expect(await invalidate(good.ref)).toBeNull();
    // The disposition of an exception as deviation raised re-checks the linked record.
    expect(await problem({ type: 'DISPOSITION_EXCEPTION', exception: 'X1', outcome: 'DEVIATION_RAISED' }, {}, { exceptions: { X1: { deviation: { ref: cancelled.ref } } } })).toMatch(/^\[601\] .* was cancelled/);
    expect(await problem({ type: 'DISPOSITION_EXCEPTION', exception: 'X1', outcome: 'DEVIATION_RAISED' }, {}, { exceptions: { X1: { deviation: { ref: good.ref } } } })).toBeNull();

    // Correction from fail to pass: the evidence is a stored document of the batch's site, with the evidence's hash.
    const failToPass = (evidence: Json) =>
      problem({ type: 'CORRECT_ENTRY', point: 'P1', evidence }, { points: { P1: { failed: true } } }, { points: { P1: { failed: true, supersededBy: 'P2' }, P2: { failed: false } } });
    const sha = createHash('sha256').update('printout of the balance').digest('hex');
    expect(await failToPass({ kind: 'PRINTOUT' })).toMatch(/^\[603\] .* names no stored evidence document/);
    expect(await failToPass({ kind: 'PRINTOUT', sha256: sha })).toMatch(/^\[603\] .* no evidence document with SHA-256 .* is stored at site SITE-1/);
    await w.run(operator, (c) =>
      c.query('select site.register_evidence_document($1::jsonb)', [
        JSON.stringify({ sha256: sha, mediaType: 'image/png', sizeBytes: '2048', storageKey: `evidence/${randomUUID()}.png`, title: 'Balance printout' }),
      ]),
    );
    expect(await failToPass({ kind: 'PRINTOUT', sha256: createHash('sha256').update('another').digest('hex') })).toMatch(/^\[603\]/);
    expect(await failToPass({ kind: 'PRINTOUT', sha256: sha })).toBeNull();
    // A correction that is not from fail to pass carries no document requirement.
    expect(await problem({ type: 'CORRECT_ENTRY', point: 'P1' }, { points: { P1: { failed: false } } }, { points: { P1: { supersededBy: 'P2' }, P2: { failed: false } } })).toBeNull();
    // The application role cannot call the check itself, nor write a reference past it.
    expect(await codeOf(db.app.query("select recipe.gmp_reference_problem($1, '{}', '{}', 'COMMAND', '{}', true)", [b.batchId]))).toMatch(/permission denied/);
  });
});

describe('the ERP order at GMP issue (outline 5.2.2; D-S5-4)', () => {
  it('a GMP batch is planned only against an ERP order whose product, strength, site, size and BOM match the pinned MBR; a missing, unknown, other-product, other-size or mismatched order is refused; an order plans one batch', async () => {
    const { familyId, content } = await effective();
    const bom = bomFor(content, BS);
    const refused = async (erpOrder: string): Promise<string> => codeOf(plan(randomUUID(), familyId, erpOrder));
    expect(await refused('')).toBe('EBMR-EXE-605');
    expect(await refused('PO-NEVER-POSTED')).toBe('EBMR-EXE-605');
    expect(await refused(await gmpOrderFor(db, erp, content, BS, { productCode: 'OTHER-PRODUCT' }))).toBe('EBMR-EXE-605');
    expect(await refused(await gmpOrderFor(db, erp, content, BS, { strength: '999 mg' }))).toBe('EBMR-EXE-605');
    expect(await refused(await gmpOrderFor(db, erp, content, BS, { siteCode: 'SITE-2' }))).toBe('EBMR-EXE-605');
    expect(await refused(await gmpOrderFor(db, erp, content, BS, { batchSize: '102.4' }))).toBe('EBMR-EXE-605');
    const first = bom[0];
    if (!first) throw new Error('the fixture has a BOM');
    expect(await refused(await gmpOrderFor(db, erp, content, BS, { bom: bom.slice(1) }))).toBe('EBMR-EXE-605');
    expect(await refused(await gmpOrderFor(db, erp, content, BS, { bom: [{ ...first, quantity: `${first.quantity}1` }, ...bom.slice(1)] }))).toBe('EBMR-EXE-605');
    expect(await refused(await gmpOrderFor(db, erp, content, BS, { bom: [{ ...first, unit: 'g' }, ...bom.slice(1)] }))).toBe('EBMR-EXE-605');
    expect(await refused(await gmpOrderFor(db, erp, content, BS, { bom: [...bom, { materialCode: 'MAT-EXTRA', quantity: '1', unit: 'kg' }] }))).toBe('EBMR-EXE-605');
    // A later version of an order replaces the earlier (latest wins): a corrected order plans the batch.
    const orderNo = await gmpOrderFor(db, erp, content, BS, { bom: bom.slice(1) });
    expect(await refused(orderNo)).toBe('EBMR-EXE-605');
    await gmpOrderFor(db, erp, content, BS, { orderNo, bom: [{ ...first, quantity: `${first.quantity}000` }, ...bom.slice(1)] });
    const planned = await plan(randomUUID(), familyId, orderNo);
    expect(planned.erpOrder).toBe(orderNo);
    // An order plans one batch; nothing was planned or numbered by the refused attempts.
    expect(await refused(orderNo)).toBe('EBMR-EXE-605');
    const { rows } = await db.app.query<{ n: string }>('select count(*)::text as n from recipe.batch_erp_order o join recipe.stub_batch b on b.id = o.batch_id where b.family_id = $1', [familyId]);
    expect(rows[0]?.n).toBe('1');
    // The server's reader names the oldest open order of the product, strength, site and size (its BOM is matched when it
    // plans), never one that planned a batch; the application role writes neither table.
    const open = (await db.app.query<{ o: string }>("select recipe.open_erp_order_for($1, 'SITE-1', $2) as o", [familyId, BS])).rows[0]?.o;
    expect(open).toMatch(/^PO-/);
    expect(open).not.toBe(orderNo);
    expect(await codeOf(db.app.query("insert into recipe.batch_erp_order (batch_id, order_id, order_no) values (gen_random_uuid(), gen_random_uuid(), 'X')"))).toMatch(/permission denied/);
    expect(await codeOf(db.app.query("update site.erp_production_order set bom = '[]'"))).toMatch(/permission denied/);
    expect(await codeOf(withCommand(db.app, { ...w.cast.issuer, correlationId: randomUUID() }, (c) => c.query('select site.erp_receive_order($1::jsonb)', [JSON.stringify({ orderNo: 'PO-X', siteCode: SITE, productCode: 'P', strength: '1', batchSize: '1', batchSizeUnit: 'kg', bom: bom, erpReference: 'E' })])))).toBe('EBMR-IAM-040');
  });
});

describe('a whole-batch reprocessing batch on GMP (slice 5b case 1; recipe-core 0603)', () => {
  it('[INV-33][IN-18] a reprocessing batch of a REPROCESSING master is planned, signed and issued end to end with a PROCESSING number from the register, linked to its parents', async () => {
    // The parents: two issued GMP batches of one processing master.
    const parentMaster = await effective();
    const parents = [await issuedBatch(parentMaster), await issuedBatch(parentMaster)];
    // Review 5 (0625): only a parent whose execution is complete or aborted is reprocessed as a whole. Running two batches
    // to completion is out of scope here; the parent-state rule has its own tests (site-services quality/reprocessing).
    await db.admin.query("update recipe.execution_state set status = 'EXECUTION_COMPLETE' where batch_id = any($1::uuid[])", [parents.map((p) => p.batchId)]);
    // The reprocessing master: the same product and strength, record kind REPROCESSING (the numbering rule is the product's).
    const rc = structuredClone(parentMaster.content);
    (rc.header as { recordKind: string }).recordKind = 'REPROCESSING';
    rc.header.family = `${rc.header.family}-RP`.slice(0, 60);
    rc.header.title = `${rc.header.title} (reprocessing)`;
    const master = await effective(rc, false);
    const product = rc.header.product;
    // The investigation, concluded by QA and linked to both parents; the stored risk evaluation; the product's permission.
    const inv = await deviation('INVESTIGATION');
    for (const p of parents) await w.run(operator, (c) => c.query("select site.link_deviation($1, 'BATCH', $2)", [inv.deviationId, p.batchId]));
    await conclude(inv, true);
    const risk = await w.run(operator, async (c) =>
      (await c.query<{ r: string }>('select site.register_evidence_document($1::jsonb) as r', [
        JSON.stringify({ sha256: createHash('sha256').update(`risk ${randomUUID()}`).digest('hex'), mediaType: 'application/pdf', sizeBytes: '4096', storageKey: `evidence/${randomUUID()}.pdf`, title: 'Risk evaluation' }),
      ])).rows[0]!.r,
    );
    const productVersion = await withCommand(db.app, { ...erp, correlationId: randomUUID() }, async (c) =>
      (await c.query<{ id: string }>('select site.erp_receive_product($1::jsonb) as id', [
        JSON.stringify({ productCode: product.code, strength: product.strength, productName: product.name, reprocessingPermitted: true, betaLactam: false, shelfLifeMonths: 24, erpReference: 'ERP-RP' }),
      ])).rows[0]!.id,
    );
    // A new product master takes effect once QA confirms it (site services 0802).
    const confirmation = await signFor(db, w.cast.qa, { type: 'erp_master', id: `PRODUCT/${productVersion}` }, 'ERP_MASTER_CONFIRMED', 'PENDING');
    await w.run(w.cast.qa, (c) => c.query("select site.confirm_erp_master('PRODUCT', $1, $2)", [productVersion, confirmation]));
    // The request, authorised by the quality-control unit (another person than the issuer).
    const req = await w.run(w.cast.issuer, async (c) =>
      (await c.query<{ r: { id: string } }>('select recipe.propose_reprocessing_request($1, $2, $3::uuid[], $4, $5) as r', [master.familyId, SITE, parents.map((p) => p.batchId), inv.ref, risk])).rows[0]!.r.id,
    );
    const sig = await signFor(db, qcu, { type: 'reprocessing_request', id: req }, 'REPROCESSING_AUTHORISED', 'PROPOSED');
    await w.run(qcu, (c) => c.query('select recipe.authorise_reprocessing_request($1, $2)', [req, sig]));

    // Planned through prepare_reprocessing_issue (5a's GMP issue with its ERP order), signed ISSUED and issued.
    let planned: Record<string, unknown> = {};
    const child = await issuedBatch(master, async (batchId, erpOrder) => {
      planned = await withProtectedNumbers(db.app, await cmd(db, w.cast.issuer), ledger, async (c) =>
        (await c.query<{ r: Record<string, unknown> }>('select recipe.prepare_reprocessing_issue($1, $2::jsonb) as r', [
          batchId, JSON.stringify({ familyId: master.familyId, markets: ['IN'], site: SITE, line: 'L1', batchSize: BS, erpOrder, reprocessingRequest: req }),
        ])).rows[0]!.r,
      );
    });
    const { rows } = await db.admin.query<{ batch_kind: string; batch_number: string; state: string | null }>(
      `select a.batch_kind, a.batch_number, b.installation as state from recipe.batch_allocation_link l join site.batch_number_allocation a on a.id = l.allocation_id
         join recipe.batch_execution b on b.id = l.batch_id where l.batch_id = $1`,
      [child.batchId],
    );
    expect(rows[0]?.batch_kind).toBe('PROCESSING');
    expect(rows[0]?.state).toBe('GMP');
    expect(planned['batch_number']).toBe(rows[0]?.batch_number);
    const parentNumbers = (await db.admin.query<{ n: string }>('select batch_number as n from recipe.batch_execution where id = any($1::uuid[])', [parents.map((p) => p.batchId)])).rows.map((r) => r.n);
    expect(parentNumbers).not.toContain(rows[0]?.batch_number);
    const links = await db.app.query<{ parent_batch_id: string }>('select parent_batch_id from recipe.batch_parent_link where child_batch_id = $1 order by parent_batch_id', [child.batchId]);
    expect(links.rows.map((r) => r.parent_batch_id)).toEqual(parents.map((p) => p.batchId).sort());
    expect((await db.app.query<{ b: string | null }>('select recipe.batch_reprocessing_basis($1) as b', [child.batchId])).rows[0]?.b).toBe('WHOLE_BATCH');
    // The register's batch kinds stay PROCESSING and PACKAGING: the mapping is the batch side's.
    expect((await db.admin.query<{ k: string | null }>("select recipe.register_batch_kind('REPROCESSING') as k")).rows[0]?.k).toBe('PROCESSING');
  });
});
