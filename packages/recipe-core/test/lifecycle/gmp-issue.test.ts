/**
 * A GMP batch is issued from an effective MBR version (Phase 3 slice 2b items 1, 2 and 4; recipe-core 0500 to 0503):
 * plan (the selection of 0170, the batch number from the site's register, the pin and the control recipe), the
 * issuer's ISSUED signature on the batch's issue content, then the issue (the engine's initial state from the control
 * recipe, the ISSUE row). Every call is made as the application role (ebmr_app) through the definer functions, with the
 * bypass attempts the role has (direct writes). The kernel's template database is a GMP installation; the sandbox side
 * of the boundary is in apps/tablets-server/test/execution/store.test.ts.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withProtectedNumbers } from '../../../kernel/src/continuity/numbers.ts';
import { withCommand } from '../../../kernel/src/db/command.ts';
import { tempDir, tempLedger } from '../../../kernel/test/continuity/helpers.ts';
import { cmd } from '../../../kernel/test/esig/helpers.ts';
import { seedActor, seedAdministration, seedServiceActor, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { stepKey, type Command } from '../../src/engine/index.ts';
import type { MbrContent } from '../../src/flow/model.ts';
import * as oc from '../../src/containers/index.ts';
import * as execution from '../../src/execution/index.ts';
import type * as lc from '../../src/lifecycle/index.ts';
import * as plantApi from '../../src/plant/index.ts';
import { define, FIXTURE_INPUTS, FIXTURE_JUSTIFICATIONS } from '../engine/support.ts';
import { dbIn, PlantWorld, seedPlantCast } from '../plant/support.ts';
import { familyOrder } from './gmp-support.ts';
import { cell, reason, seedCast, uniqueContent, World } from './support.ts';

let db: TestDatabase;
let w: World;
let steward: SeededActor;
let erp: SeededActor;
let issuer2: SeededActor;
let operator: SeededActor;
const dir = tempDir('gmp-issue');
const ledger = tempLedger('gmp-issue', dir.path);

beforeAll(async () => {
  db = await createTestDatabase();
  w = new World(db, await seedCast(db));
  steward = await seedActor(db, { roleCode: 'MASTER_DATA_STEWARD', legalName: 'Mira Steward' });
  erp = await seedServiceActor(db, { kind: 'INTEGRATION', source: 'INTEGRATION', roleCode: 'ERP_INTERFACE', name: 'ERP interface' });
  issuer2 = await seedActor(db, { roleCode: 'BATCH_ISSUER', legalName: 'Isha Issuer' });
  operator = await seedActor(db, { roleCode: 'OPERATOR', legalName: 'Om Operator', roomCode: 'DISP-01' });
}, 300_000);

afterAll(async () => {
  await db.drop();
  dir.cleanup();
});

const SITE = 'SITE-1'; // the seed site: every seeded session is at SITE-1
const BS = 'BS-200K';
const FIXTURE = 'tablet-granulation-compression';
type Json = Record<string, unknown>;
const q = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, params)).rows as T[];

/** The error code a promise is rejected with (EBMR-XXX-NNN), or 'ok'. */
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    const m = /\b(EBMR-[A-Z]+-\d{3})\b/.exec(e instanceof Error ? e.message : String(e));
    return m?.[1] ?? (e instanceof Error ? e.message : String(e));
  }
}

/** A copy of `content` without the steps whose block is one of `types` (anywhere in the procedure). */
function without(content: unknown, types: readonly string[]): unknown {
  if (Array.isArray(content)) {
    return content.filter((x) => !(x && typeof x === 'object' && types.includes(String(((x as Json)['block'] as Json | undefined)?.['type'])))).map((x) => without(x, types));
  }
  if (content && typeof content === 'object') return Object.fromEntries(Object.entries(content).map(([k, v]) => [k, without(v, types)]));
  return content;
}

/**
 * The granulation fixture with its own family and an upper-case product code (the register's form); without the
 * SANDBOX_ONLY blocks G-09 and G-10 version 1 unless `sandboxOnly` (D-S2b-2).
 */
function gmpContent(sandboxOnly = false): MbrContent {
  const m = uniqueContent(FIXTURE);
  m.header.product = { ...m.header.product, code: m.header.product.code.toUpperCase() };
  return (sandboxOnly ? m : without(m, ['G-09', 'G-10'])) as MbrContent;
}

const current = (versionId: string, market: string): lc.MarketAuthorisationDefinition => ({
  versionId,
  market,
  kind: 'CURRENT',
  cells: [cell(SITE, 'L1', BS)],
  regulatoryBasis: `${market}: registration on file`,
});

/** An approved version CURRENT for `markets` at SITE-1/L1/BS-200K, and a numbering rule for its product. */
async function effectiveMaster(markets: string[] = ['IN', 'US'], sandboxOnly = false): Promise<{ familyId: string; versionId: string; product: string; content: MbrContent }> {
  const content = gmpContent(sandboxOnly);
  const v = await w.approvedVersion(content);
  for (const m of markets) await w.authorise(current(v.versionId, m));
  const product = content.header.product.code;
  const rule = `G-${randomUUID().slice(0, 8).toUpperCase()}`;
  await w.run(steward, (c) =>
    c.query('select site.define_batch_number_rule($1::jsonb)', [
      JSON.stringify({ rule_code: rule, site_code: SITE, product_code: product, batch_kind: 'PROCESSING', format: 'G{YY}{SEQ:5}', site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3' }),
    ]),
  );
  return { familyId: v.familyId, versionId: v.versionId, product, content };
}

/** Plans a GMP batch as `who` (the register's counter is write-ahead: withProtectedNumbers, kernel continuity). */
async function plan(who: SeededActor, batchId: string, def: Partial<execution.GmpBatchPlan> & { familyId: string }): Promise<execution.PlannedGmpBatch> {
  const erpOrder = def.erpOrder ?? (await familyOrder(db, erp, def.familyId, def.batchSize ?? BS));
  return withProtectedNumbers(db.app, await cmd(db, who), ledger, (c) =>
    execution.prepareGmpIssue(c, batchId, { markets: ['IN', 'US'], site: SITE, line: 'L1', batchSize: BS, ...def, erpOrder }),
  );
}

const signIssue = (who: SeededActor, batchId: string): Promise<string> => w.sign(who, 'batch_issue', batchId, 'ISSUED', 'PLANNED');

/** Issues planned GMP batch `batchId` as `who` under `signatureId`, with the issuer's own reason. */
function issue(who: SeededActor, batchId: string, signatureId: string) {
  return w.run(
    who,
    (c) =>
      execution.issueGmpBatch(c, {
        batchId,
        signatureId,
        define: (content) => define(content, { installation: 'GMP', justifications: FIXTURE_JUSTIFICATIONS }),
        request: { inputs: FIXTURE_INPUTS[FIXTURE], issuedBy: { id: who.personId, kind: 'PERSON', roles: [] } },
      }),
    reason('batch issued for the test'),
  );
}

/** Planned, signed and issued. */
async function issued(familyId: string, markets: string[] = ['IN']): Promise<{ batchId: string; planned: execution.PlannedGmpBatch; signatureId: string }> {
  const batchId = randomUUID();
  const planned = await plan(w.cast.issuer, batchId, { familyId, markets });
  const signatureId = await signIssue(w.cast.issuer, batchId);
  await issue(w.cast.issuer, batchId, signatureId);
  return { batchId, planned, signatureId };
}

const violations = async () => (await db.app.query<{ batch_id: string | null; problem: string }>('select batch_id, problem from recipe.execution_violations()')).rows;

describe('the GMP issue (INV-01, INV-02, INV-28, PR-04, IN-18)', () => {
  it('[INV-01][INV-02][INV-28][PR-04] a GMP batch is issued from the effective version: the pin, the control recipe and the register number of one transaction, the ISSUED signature, and the engine\'s initial state from the control recipe', async () => {
    const m = await effectiveMaster();
    const batchId = randomUUID();
    const planned = await plan(w.cast.issuer, batchId, { familyId: m.familyId, markets: ['US', 'IN'] });
    expect(planned).toMatchObject({ batchId, versionId: m.versionId, versionNumber: 1, rule: 'CURRENT_FOR_EVERY_MARKET', markets: ['IN', 'US'] });
    // The number is the register's, allocated for this product, site, kind and batch size, and linked to the batch.
    const [alloc] = await q<Json>(
      `select a.batch_number, a.product_code, a.site_code, a.edition, a.batch_kind, a.batch_size::text as batch_size, a.batch_size_unit, l.batch_id::text as batch_id
         from site.batch_number_allocation a join recipe.batch_allocation_link l on l.allocation_id = a.id where a.id = $1`,
      [planned.allocationId],
    );
    expect(alloc).toEqual({ batch_number: planned.batchNumber, product_code: m.product, site_code: SITE, edition: 'TABLETS', batch_kind: 'PROCESSING', batch_size: '51.2', batch_size_unit: 'kg', batch_id: batchId });
    expect(planned.batchNumber).toMatch(/^G\d{2}\d{5}$/);
    // Planned, pinned, with its control recipe: not issued until signed.
    expect((await q<{ status: string }>('select status from recipe.stub_batch where id = $1', [batchId]))[0]?.status).toBe('PLANNED');
    expect((await q<{ ok: boolean }>("select (recipe.verify_control_recipe($1) ->> 'ok')::boolean as ok", [batchId]))[0]?.ok).toBe(true);
    expect(await q('select 1 from recipe.batch_execution where id = $1', [batchId])).toEqual([]);

    const signatureId = await signIssue(w.cast.issuer, batchId);
    const r = await issue(w.cast.issuer, batchId, signatureId);
    expect(r.batchNumber).toBe(planned.batchNumber);
    expect(r.state.status).toBe('ISSUED');
    const [row] = await q<Json>(
      `select installation, purpose, package_hash, control_recipe_id::text as cr, issue_signature_id::text as sig, content_hash, market_set, batch_size, site_code, batch_number
         from recipe.batch_execution where id = $1`,
      [batchId],
    );
    expect(row).toEqual({
      installation: 'GMP', purpose: 'GMP_BATCH', package_hash: null, cr: planned.controlRecipeId, sig: signatureId, content_hash: planned.contentHash,
      market_set: ['IN', 'US'], batch_size: BS, site_code: SITE, batch_number: planned.batchNumber,
    });
    // The engine's state names the control recipe's MBR content (INV-02) and the register number.
    const stored = await execution.loadState(db.app, batchId);
    expect(stored?.state.mbrHash).toBe(planned.contentHash);
    expect(stored?.state.header).toMatchObject({ batchId, batchNumber: planned.batchNumber, batchSize: BS, marketSet: ['IN', 'US'] });
    expect(await q<Json>('select seq::text as seq, kind, command_type from recipe.execution_command where batch_id = $1', [batchId])).toEqual([{ seq: '1', kind: 'ISSUE', command_type: 'ISSUE' }]);
    expect((await q<{ status: string }>('select status from recipe.stub_batch where id = $1', [batchId]))[0]?.status).toBe('ISSUED');
    // The signature stays valid: everything it covers is insert-only.
    expect((await q<{ v: boolean }>("select (esig.signature_state($1) ->> 'valid')::boolean as v", [signatureId]))[0]?.v).toBe(true);
    // A GMP batch in a GMP database is no violation; the MBR life cycle's invariants hold.
    expect(await violations()).toEqual([]);
    expect(await w.violations()).toEqual([]);
  });

  it('[INV-01][PR-04] a batch is issued once, and only on the version its markets may use at the issue instant (a successor made CURRENT after planning refuses the planned version)', async () => {
    const once = await effectiveMaster(['IN']);
    const done = await issued(once.familyId);
    // Issued already: neither planned nor issued again.
    expect(await codeOf(plan(w.cast.issuer, done.batchId, { familyId: once.familyId, markets: ['IN'] }))).toBe('EBMR-EXE-197');
    expect(await codeOf(issue(w.cast.issuer, done.batchId, done.signatureId))).toBe('EBMR-EXE-197');
    // Planned on v1 (a planned batch is not in flight); v2 becomes CURRENT for IN before the issue: the planned version
    // is refused (PR-05).
    const m = await effectiveMaster(['IN']);
    const batchId = randomUUID();
    await plan(w.cast.issuer, batchId, { familyId: m.familyId, markets: ['IN'] });
    const sig = await signIssue(w.cast.issuer, batchId);
    const v2 = await w.approvedSuccessor(m.versionId, (c) => {
      c.header.title = `${c.header.title} (v2)`;
    });
    await w.authorise(current(v2.versionId, 'IN'));
    expect(await codeOf(issue(w.cast.issuer, batchId, sig))).toBe('EBMR-EXE-196');
    expect(await q('select 1 from recipe.batch_execution where id = $1', [batchId])).toEqual([]);
  });
});

describe('the boundary of the GMP issue (DI-05, INV-18)', () => {
  it('[DI-05][INV-18][INV-01][INV-28][PR-04] a GMP batch is never created without an effective MBR version: no family, a market set without India, a market no version is authorised for, a batch size not approved; nothing is planned and no number is taken', async () => {
    const m = await effectiveMaster(['IN']);
    const allocations = async () => (await q<{ n: string }>('select count(*)::text as n from site.batch_number_allocation where product_code = $1', [m.product]))[0]?.n;
    const before = await allocations();
    const tried = {
      unknownFamily: await codeOf(plan(w.cast.issuer, randomUUID(), { familyId: randomUUID(), markets: ['IN'] })),
      withoutIndia: await codeOf(plan(w.cast.issuer, randomUUID(), { familyId: m.familyId, markets: ['US'] })),
      notAuthorised: await codeOf(plan(w.cast.issuer, randomUUID(), { familyId: m.familyId, markets: ['IN', 'US'] })),
      otherLine: await codeOf(plan(w.cast.issuer, randomUUID(), { familyId: m.familyId, markets: ['IN'], line: 'L2' })),
      sizeNotApproved: await codeOf(plan(w.cast.issuer, randomUUID(), { familyId: m.familyId, markets: ['IN'], batchSize: 'BS-999K' })),
    };
    expect(tried).toEqual({ unknownFamily: 'EBMR-EXE-192', withoutIndia: 'EBMR-EXE-192', notAuthorised: 'EBMR-EXE-192', otherLine: 'EBMR-EXE-192', sizeNotApproved: 'EBMR-EXE-192' });
    expect(await allocations()).toBe(before);
    // A batch planned through the stub path (no register number, not linked) is not a GMP batch: it cannot be issued.
    const stub = await w.planBatch(m.familyId, ['IN'], { site: SITE, line: 'L1', batch_size: BS });
    expect(await codeOf(w.run(w.cast.issuer, (c) => execution.beginGmpIssue(c, stub)))).toBe('EBMR-EXE-192');
  });

  it('[DI-05][INV-18] a SANDBOX_ONLY block version never reaches a GMP control recipe: an approved, authorised version holding G-09 and G-10 version 1 is refused at planning, and a control recipe landed with one is reported', async () => {
    const m = await effectiveMaster(['IN'], true);
    const batchId = randomUUID();
    const refused = plan(w.cast.issuer, batchId, { familyId: m.familyId, markets: ['IN'] });
    await expect(refused).rejects.toThrow(/G-09@1, G-10@1, which run only in the sandbox.*\[EBMR-EXE-195\]/);
    expect(await q('select 1 from recipe.stub_batch where id = $1', [batchId])).toEqual([]);
    expect(await q('select 1 from site.batch_number_allocation where product_code = $1', [m.product])).toEqual([]);
    // Behind the writers' back (a restore, a hand edit): an issued GMP batch's control recipe swapped for one holding the
    // blocks is reported with each block, and its control recipe no longer verifies.
    const ok = await effectiveMaster(['IN']);
    const done = await issued(ok.familyId);
    const admin = await db.admin.connect();
    try {
      await admin.query('begin');
      await admin.query('set local session_replication_role = replica');
      await admin.query("update recipe.control_recipe set snapshot = jsonb_set(snapshot, '{mbr,content}', $2::jsonb) where batch_id = $1", [done.batchId, JSON.stringify(m.content)]);
      await admin.query('commit');
    } finally {
      admin.release();
    }
    const reported = (await violations()).filter((v) => v.batch_id === done.batchId).map((v) => v.problem);
    expect(reported).toEqual(
      expect.arrayContaining([
        'SANDBOX_ONLY block G-09@1 in the control recipe of a GMP batch (DI-05, INV-18)',
        'SANDBOX_ONLY block G-10@1 in the control recipe of a GMP batch (DI-05, INV-18)',
        expect.stringMatching(/^GMP batch .*: its control recipe does not verify/),
      ]),
    );
  });

  it('[DI-05][INV-18] in a GMP database the sandbox\'s writers stay refused (test packages, test batches), a TEST- number never enters the register, and a row of sandbox origin is never written, whoever writes it', async () => {
    const actor = await cmd(db, w.cast.issuer);
    expect(await codeOf(withCommand(db.app, actor, (c) => execution.beginIssue(c, randomUUID())))).toBe('EBMR-SBX-011');
    expect(await codeOf(withCommand(db.app, { ...actor, correlationId: randomUUID() }, (c) => c.query("select recipe.import_test_package('{}'::jsonb, 'x.json')")))).toBe('EBMR-SBX-011');
    // A sandbox batch number (TEST-) never enters the GMP register, so no GMP batch can be planned under one.
    const testNumber = await codeOf(
      w.run(w.cast.issuer, (c) =>
        c.query('select site.register_external_batch_number($1::jsonb)', [
          JSON.stringify({ batch_number: 'TEST-B26-0001', site_code: SITE, site_zone: 'Asia/Kolkata', product_code: 'ATV-40-FCT', product_name: 'Atorvastatin calcium tablets', edition: 'TABLETS', batch_size: '51.2', batch_size_unit: 'kg' }),
        ]),
      ),
    );
    expect(testNumber).toMatch(/^EBMR-SBX-02\d$/);
    // The owner's own insert of a sandbox-origin row (no replica mode: every trigger runs) is refused.
    const m = await effectiveMaster(['IN']);
    const done = await issued(m.familyId);
    const err = await codeOf(
      db.admin.query(
        `insert into recipe.batch_execution select (jsonb_populate_record(null::recipe.batch_execution,
            to_jsonb(b) || jsonb_build_object('id', gen_random_uuid(), 'batch_number', 'B' || left(md5(random()::text), 8), 'installation', 'SANDBOX',
                                              'purpose', 'SANDBOX_TEST_RUN', 'control_recipe_id', null, 'issue_signature_id', null, 'package_hash', null))).*
           from recipe.batch_execution b where b.id = $1`,
        [done.batchId],
      ),
    );
    expect(err).toBe('EBMR-EXE-190');
  });
});

describe('the batch number (INV-27, IN-18)', () => {
  it('[INV-27][DI-05] a batch takes only its own register number: an allocation of another product, a voided one, or one another batch took is refused, and the issue refuses any number but the planned one', async () => {
    const m = await effectiveMaster(['IN']);
    const other = await effectiveMaster(['IN']);
    const allocate = async (product: string) =>
      withProtectedNumbers(db.app, await cmd(db, w.cast.issuer), ledger, async (c) => {
        const { rows } = await c.query<{ id: string }>('select allocation_id::text as id from site.allocate_batch_number($1::jsonb)', [
          JSON.stringify({ site_code: SITE, product_code: product, product_name: 'Atorvastatin calcium tablets', edition: 'TABLETS', batch_kind: 'PROCESSING', batch_size: '51.2', batch_size_unit: 'kg' }),
        ]);
        return rows[0]?.id ?? '';
      });
    const otherProduct = await allocate(other.product);
    const voided = await allocate(m.product);
    await w.run(w.cast.issuer, (c) => c.query("select site.void_batch_number($1, 'ORDER_CANCELLED', 'ERP order cancelled before issue')", [voided]));
    const own = await allocate(m.product);
    const tried = {
      otherProduct: await codeOf(plan(w.cast.issuer, randomUUID(), { familyId: m.familyId, markets: ['IN'], allocationId: otherProduct })),
      voided: await codeOf(plan(w.cast.issuer, randomUUID(), { familyId: m.familyId, markets: ['IN'], allocationId: voided })),
      unknown: await codeOf(plan(w.cast.issuer, randomUUID(), { familyId: m.familyId, markets: ['IN'], allocationId: randomUUID() })),
    };
    expect(tried).toEqual({ otherProduct: 'EBMR-EXE-191', voided: 'EBMR-EXE-191', unknown: 'EBMR-EXE-191' });
    const first = randomUUID();
    const planned = await plan(w.cast.issuer, first, { familyId: m.familyId, markets: ['IN'], allocationId: own });
    expect(planned.allocationId).toBe(own);
    // The same number is never given to a second batch.
    expect(await codeOf(plan(w.cast.issuer, randomUUID(), { familyId: m.familyId, markets: ['IN'], allocationId: own }))).toBe('EBMR-EXE-191');
    // The issue under another number than the one this transaction's clock marker holds is refused.
    const sig = await signIssue(w.cast.issuer, first);
    const wrongNumber = await codeOf(
      w.run(w.cast.issuer, async (c) => {
        const begun = await execution.beginGmpIssue(c, first);
        await execution.issueGmpExecution(c, {
          batchId: first, signatureId: sig, batchNumber: `${begun.batchNumber}9`, request: {}, policy: {}, registryFingerprint: 'a'.repeat(64), engineVersion: '1.0.0',
          nowUs: begun.nowUs, state: {} as never, events: [], contents: [],
        });
      }),
    );
    expect(wrongNumber).toBe('EBMR-EXE-012');
    // A number voided after the issue is reported (the register and the batch disagree).
    await issue(w.cast.issuer, first, sig);
    expect((await violations()).filter((v) => v.batch_id === first)).toEqual([]);
    await w.run(w.cast.issuer, (c) => c.query("select site.void_batch_number($1, 'ENTERED_IN_ERROR', 'test: the register and the batch disagree')", [own]));
    expect((await violations()).filter((v) => v.batch_id === first).map((v) => v.problem)).toEqual([
      expect.stringMatching(/^GMP batch .*: its batch number is not the one the register allocated for it: batch number .* was voided in the register/),
    ]);
  });
});

describe('the ISSUED signature (DI-35, INV-10)', () => {
  it('[DI-35][INV-10] a GMP batch is issued only under the issuer\'s own valid ISSUED signature on its issue content: none, another person\'s, or one of another batch is refused', async () => {
    const m = await effectiveMaster(['IN']);
    const a = randomUUID();
    const b = randomUUID();
    await plan(w.cast.issuer, a, { familyId: m.familyId, markets: ['IN'] });
    await plan(w.cast.issuer, b, { familyId: m.familyId, markets: ['IN'] });
    const sigB = await signIssue(w.cast.issuer, b);
    const byOther = await signIssue(issuer2, a);
    expect({
      none: await codeOf(issue(w.cast.issuer, a, randomUUID())),
      anotherBatch: await codeOf(issue(w.cast.issuer, a, sigB)),
      anotherPerson: await codeOf(issue(w.cast.issuer, a, byOther)),
    }).toEqual({ none: 'EBMR-EXE-193', anotherBatch: 'EBMR-EXE-193', anotherPerson: 'EBMR-EXE-193' });
    // The signer may issue it under the own signature.
    await issue(issuer2, a, byOther);
    expect((await q<{ p: string }>('select issued_by_person::text as p from recipe.batch_execution where id = $1', [a]))[0]?.p).toBe(issuer2.personId);
  });
});

describe('writer authority on the GMP installation (DI-17, DI-18)', () => {
  it('[DI-17][DI-18] the GMP writers refuse administrators and check the permission; the application role writes no batch, link or plan directly', async () => {
    const m = await effectiveMaster(['IN']);
    const { admin } = await seedAdministration(db);
    expect(await codeOf(plan(admin, randomUUID(), { familyId: m.familyId, markets: ['IN'] }))).toBe('EBMR-IAM-042');
    expect(await codeOf(plan(w.cast.author, randomUUID(), { familyId: m.familyId, markets: ['IN'] }))).toBe('EBMR-IAM-040');
    const done = await issued(m.familyId);
    // The execution writers run a GMP batch (installation-aware actor) and still refuse administrators.
    expect(await codeOf(w.run(admin, (c) => execution.lockExecution(c, done.batchId)))).toBe('EBMR-IAM-042');
    expect(await codeOf(w.run(w.cast.issuer, (c) => execution.beginGmpIssue(c, done.batchId)))).toBe('EBMR-EXE-197');
    // Bypass attempts as the application role.
    const direct = async (sql: string, params: unknown[] = []) => codeOf(w.run(w.cast.issuer, (c: pg.PoolClient) => c.query(sql, params)));
    const denied = /permission denied/;
    for (const sql of [
      'insert into recipe.batch_allocation_link (batch_id, allocation_id, batch_number, person_id, account_id, correlation_id) select batch_id, allocation_id, batch_number, person_id, account_id, correlation_id from recipe.batch_allocation_link limit 1',
      "update recipe.batch_execution set batch_size = 'BS-1' where id = $1",
      "update recipe.stub_batch set status = 'COMPLETED' where id = $1",
      'delete from recipe.control_recipe where batch_id = $1',
    ]) {
      expect(await direct(sql, sql.includes('$1') ? [done.batchId] : [])).toMatch(denied);
    }
  });

  it('[DI-17][INV-02] an operator runs the first step of a GMP batch: the execution writers and the database\'s guards read the control recipe\'s content', async () => {
    const m = await effectiveMaster(['IN']);
    const done = await issued(m.familyId);
    const result = await w.run(operator, async (c) => {
      const tx = await execution.ExecutionTx.open(c, define(m.content, { installation: 'GMP', justifications: FIXTURE_JUSTIFICATIONS }), done.batchId);
      const first = Object.values(tx.state.steps).find((s) => s.status === 'ENABLED');
      if (!first) throw new Error('no enabled step');
      // The evaluation the engine role rests on (INV-26): the declared role at the session's location (the dispensing room).
      const { rows } = await c.query<{ id: string }>("select iam.require_permission('STEP.EXECUTE', $1::jsonb) ->> 'evaluation_id' as id", [JSON.stringify({ site: SITE, area: 'DISP-01' })]);
      const roles = [{ role: 'PRODUCTION_OPERATOR', permission: 'STEP.EXECUTE', evaluationId: rows[0]?.id ?? '' }];
      const command: Command = { type: 'START_STEP', commandId: randomUUID(), actor: { id: operator.personId, kind: 'PERSON', roles: ['PRODUCTION_OPERATOR'] }, step: first.step, context: [] };
      const r = await tx.command(command, roles);
      return { accepted: r.accepted, key: stepKey(first.step, []), status: r.state.steps[stepKey(first.step, [])]?.status };
    });
    expect(result).toMatchObject({ accepted: true, status: 'IN_PROGRESS' });
    expect((await violations()).filter((v) => v.batch_id === done.batchId)).toEqual([]);
  });
});

describe('plant and output containers on a GMP batch (DI-17, IN-21, IN-25; slice 2b review findings 1 and 2)', () => {
  it('[DI-17][IN-25][IN-21] a press is started and a container opened for a GMP batch, and an operator whose grant is limited to its product records an IPC check on it; one limited to another product, or to another site, is refused (the scope is the batch\'s product and site, never empty)', async () => {
    const m = await effectiveMaster(['IN']);
    const done = await issued(m.familyId);
    const pw = new PlantWorld(db, await seedPlantCast(db));
    await pw.run(pw.cast.steward, (c) => plantApi.defineProduct(c, { code: m.product, name: m.content.header.product.name, highlyPotent: false }));
    const press = await pw.press();
    await pw.clean('EQUIPMENT', press.code, 'MAJOR');
    const own = await seedActor(db, { roleCode: 'OPERATOR', legalName: 'Oma Own-product', scope: { product: m.product } });
    const other = await seedActor(db, { roleCode: 'OPERATOR', legalName: 'Otto Other-product', scope: { product: 'OTHER-PRODUCT' } });
    const elsewhere = await seedActor(db, { roleCode: 'OPERATOR', legalName: 'Eli Elsewhere', scope: { site: 'SITE-9', product: m.product } });
    const end = await dbIn(db, 8 * 3600);
    const startUse = (who: SeededActor) => w.run(who, (c) => plantApi.startEquipmentUse(c, press.code, done.batchId, end));
    const open = (who: SeededActor) => w.run(who, (c) => oc.openContainer(c, { batchId: done.batchId, stage: 'COMPRESSION', unit: 'kg', pressCode: press.code }));
    const ipc = (who: SeededActor) => w.run(who, (c) => oc.recordIpcCheck(c, { batchId: done.batchId, pressCode: press.code, result: 'PASS', reference: `IPC-${randomUUID().slice(0, 8)}` }));
    expect({ startUse: await codeOf(startUse(other)), open: await codeOf(open(other)), ipc: await codeOf(ipc(other)) }).toEqual({
      startUse: 'EBMR-IAM-040', open: 'EBMR-IAM-040', ipc: 'EBMR-IAM-040',
    });
    // The press's own transition checks STEP.EXECUTE at the unit's site only, which a product-limited grant does not cover
    // (fail closed, plant 0403): an operator with an unlimited grant starts it; the batch is accepted as a GMP batch.
    await startUse(pw.cast.operator);
    // The container's own state, like the press's, is checked at the site only, which a product-limited grant does not
    // cover (plant 0420): an operator with an unlimited grant opens it.
    const container = await open(pw.cast.operator);
    expect(container.labelCode).toBe(`OC-${done.planned.batchNumber}-0001`);
    expect(await q<Json>('select product_code, strength from plant.output_container where batch_id = $1', [done.batchId])).toEqual([
      { product_code: m.product, strength: m.content.header.product.strength },
    ]);
    expect(await codeOf(ipc(own))).toBe('ok');
    expect(await codeOf(ipc(elsewhere))).toBe('EBMR-IAM-040');
    // The scope fails closed: a batch that does not exist gives none.
    expect(await codeOf(ipc(own).then(() => w.run(own, (c) => oc.recordIpcCheck(c, { batchId: randomUUID(), pressCode: press.code, result: 'PASS', reference: 'IPC-X' }))))).toBe('EBMR-CNT-020');
    expect((await q<{ s: Json }>('select plant.batch_scope($1) as s', [done.batchId]))[0]?.s).toEqual({ product: m.product, site: SITE });
  });
});
