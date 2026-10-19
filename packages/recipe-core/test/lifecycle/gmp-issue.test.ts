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
import { approveTestRelease } from '../../../kernel/test/support/validation.ts';
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
  // Slice 7c (DI-03, recipe-core 1250): a GMP batch is issued only on a release with an approved validation summary.
  await approveTestRelease(db);
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
  it('[DI-05][INV-18][INV-01][INV-28][PR-04][IN-13][PR-10][IN-06] a GMP batch is never created without an effective MBR version: no family, a market set without India, a market no version is authorised for, a batch size not approved; nothing is planned and no number is taken', async () => {
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

describe('the validated release (DI-03, recipe-core 1250)', () => {
  /** Applies a stand-in migration to the ledger: the database now runs a release no summary was approved for. */
  async function upgraded<T>(work: (release: string) => Promise<T>): Promise<T> {
    const name = `9999_test_upgrade_${randomUUID().slice(0, 8)}.sql`;
    await db.admin.query("insert into public.schema_migration (namespace, name, checksum) values ('recipe-core', $1, repeat('a', 64))", [name]);
    try {
      return await work((await q<{ r: string }>('select platform.schema_release() as r'))[0]!.r);
    } finally {
      await db.admin.query("delete from public.schema_migration where namespace = 'recipe-core' and name = $1", [name]);
    }
  }
  const begin = (who: SeededActor, batchId: string) => w.run(who, (c) => c.query('select recipe.begin_gmp_issue($1)', [batchId]), reason('batch issued for the test'));

  it('[DI-03] a GMP batch is refused on a release without an approved validation summary', async () => {
    const m = await effectiveMaster(['IN']);
    const batchId = randomUUID();
    await plan(w.cast.issuer, batchId, { familyId: m.familyId, markets: ['IN'] });
    const signatureId = await signIssue(w.cast.issuer, batchId);
    await upgraded(async (release) => {
      // The summary approved for the release before the upgrade does not cover this one.
      expect((await q<{ p: string | null }>('select platform.validation_summary_problem() as p'))[0]?.p).toMatch(new RegExp(`^EBMR-VAL-001 release ${release} has no approved validation summary`));
      expect(await codeOf(issue(w.cast.issuer, batchId, signatureId))).toBe('EBMR-VAL-001');
      // The step the issuer starts from is refused too, so the engine never runs.
      expect(await codeOf(begin(w.cast.issuer, batchId))).toBe('EBMR-VAL-001');
      expect(await q('select 1 from recipe.batch_execution where id = $1', [batchId])).toEqual([]);
      expect((await q<{ status: string }>('select status from recipe.stub_batch where id = $1', [batchId]))[0]?.status).toBe('PLANNED');
      // QA approves the summary of the running release: the same planned batch, under the same signature, is issued.
      await approveTestRelease(db);
      expect((await q<{ p: string | null }>('select platform.validation_summary_problem() as p'))[0]?.p).toBeNull();
      await issue(w.cast.issuer, batchId, signatureId);
      expect((await q<{ status: string }>('select status from recipe.stub_batch where id = $1', [batchId]))[0]?.status).toBe('ISSUED');
    });
  });

  it('[DI-03] the validation-summary gate holds for every writer of a GMP batch row, and the application cannot approve or fake a release', async () => {
    await upgraded(async (release) => {
      // Even the database superuser's direct write of a GMP batch row is refused by the trigger (before any other check).
      await expect(db.admin.query("insert into recipe.batch_execution (id, installation) values (gen_random_uuid(), 'GMP')")).rejects.toThrow(/EBMR-VAL-001/);
      // The application role neither writes the ledger nor the approval, nor calls the gate's helper.
      await expect(db.app.query("insert into public.schema_migration (namespace, name, checksum) values ('kernel', '9999_fake.sql', 'x')")).rejects.toThrow(/permission denied/);
      await expect(db.app.query(
        "insert into platform.validation_summary (schema_release, summary_sha256, title, approved_signature, approved_by_person, approved_by_account) values ($1, repeat('b', 64), 'fake', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())",
        [release])).rejects.toThrow(/permission denied/);
      await expect(db.app.query('select recipe.batch_execution_validation_gate()')).rejects.toThrow(/permission denied|trigger functions can only be called as triggers/);
      // An issuer has no VALIDATION.APPROVE_SUMMARY: only the quality unit approves.
      await expect(w.run(w.cast.issuer, (c) => c.query('select platform.approve_validation_summary($1, repeat(\'c\', 64), \'by the issuer\', gen_random_uuid())', [release]), reason('not QA')))
        .rejects.toThrow(/EBMR-IAM-040/);
      expect((await q<{ p: string | null }>('select platform.validation_summary_problem() as p'))[0]?.p).toMatch(/^EBMR-VAL-001/);
    });
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

describe('the GMP issue functions as Phase 6A and Phase 7 re-create them (recipe-core 1218, 1260; D-P7-1 item 4)', () => {
  /** A superuser change committed by another connection, with the database's triggers off (a writer that bypassed them). */
  async function tamper(sqlText: string, params: unknown[]): Promise<void> {
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      await c.query("set local session_replication_role = 'replica'");
      await c.query(sqlText, params);
      await c.query('commit');
    } finally {
      c.release();
    }
  }
  /**
   * The issue as `issue` makes it, with `roles` in the request; `beforeIssue` runs (committed, from another connection)
   * after recipe.begin_gmp_issue and before recipe.issue_gmp_execution in the issuing command, and `edit` changes the
   * request the command hands the database.
   */
  function issueVia(who: SeededActor, batchId: string, signatureId: string, opts: { roles?: string[]; beforeIssue?: () => Promise<void>; edit?: (r: Json) => Json } = {}) {
    return w.run(
      who,
      (c) => {
        const client = new Proxy(c, {
          get(target, prop, receiver) {
            if (prop !== 'query') {
              const v = Reflect.get(target, prop, receiver) as unknown;
              return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
            }
            return async (text: unknown, params?: unknown[]) => {
              if (typeof text === 'string' && text.includes('recipe.issue_gmp_execution') && params) {
                await opts.beforeIssue?.();
                // As the server derives engine roles (tab.engine_roles): the map's permission evaluated in this command at
                // the actor's location (the issuer's session is at SITE-1, in no room).
                if (opts.roles?.length) await target.query('select iam.require_permission($1, $2::jsonb)', ['BATCH.ISSUE', JSON.stringify({ site: SITE })]);
                if (opts.edit) params = params.map((p, i) => (i === 3 ? JSON.stringify(opts.edit!(JSON.parse(String(p)) as Json)) : p));
              }
              return target.query(text as string, params);
            };
          },
        });
        return execution.issueGmpBatch(client, {
          batchId,
          signatureId,
          define: (content) => define(content, { installation: 'GMP', justifications: FIXTURE_JUSTIFICATIONS }),
          request: { inputs: FIXTURE_INPUTS[FIXTURE], issuedBy: { id: who.personId, kind: 'PERSON', roles: opts.roles ?? [] } },
        });
      },
      reason('batch issued for the test'),
    );
  }
  const begin = (who: SeededActor, batchId: string) => w.run(who, (c) => c.query('select recipe.begin_gmp_issue($1)', [batchId]), reason('batch issued for the test'));
  const message = async (p: Promise<unknown>): Promise<string> => p.then(() => 'ok', (e: unknown) => (e instanceof Error ? e.message : String(e)));
  const NOT_PLANNED = /^There is no GMP batch planned with this id; .*\[EBMR-EXE-192\]$/;
  let master: Awaited<ReturnType<typeof effectiveMaster>>;
  async function planned(): Promise<{ batchId: string; signatureId: string; number: string }> {
    master ??= await effectiveMaster(['IN']);
    const batchId = randomUUID();
    const p = await plan(w.cast.issuer, batchId, { familyId: master.familyId, markets: ['IN'] });
    return { batchId, signatureId: await signIssue(w.cast.issuer, batchId), number: p.batchNumber };
  }
  const PARTS = [['link', 'recipe.batch_allocation_link'], ['pin', 'recipe.batch_mbr_pin'], ['control recipe', 'recipe.control_recipe']] as const;

  it('[INV-01][DI-05] a planned batch missing its register link, its pin or its control recipe is not begun, and not issued when one goes between the two steps', async () => {
    for (const [part, table] of PARTS) {
      const a = await planned();
      await tamper(`delete from ${table} where batch_id = $1`, [a.batchId]);
      expect(await message(begin(w.cast.issuer, a.batchId)), `begin without its ${part}`).toMatch(NOT_PLANNED);
      const b = await planned();
      expect(await message(issueVia(w.cast.issuer, b.batchId, b.signatureId, { beforeIssue: () => tamper(`delete from ${table} where batch_id = $1`, [b.batchId]) })), `issue without its ${part}`)
        .toMatch(NOT_PLANNED);
      expect(await q('select 1 from recipe.batch_execution where id = any($1)', [[a.batchId, b.batchId]])).toEqual([]);
    }
  });

  it('[INV-27][IN-18] the issue refuses a register link whose number changed after the issue began', async () => {
    const a = await planned();
    expect(await message(issueVia(w.cast.issuer, a.batchId, a.signatureId, { beforeIssue: () => tamper('update recipe.batch_allocation_link set batch_number = batch_number || $2 where batch_id = $1', [a.batchId, 'X']) })))
      .toMatch(new RegExp(`^Batch number ${a.number} is not the number the site's register allocated for this batch .*\\[EBMR-EXE-191\\]$`));
  });

  it('[DI-03][INV-01] the issue itself refuses when the validation summary stops covering the release after the issue began', async () => {
    const a = await planned();
    const name = `9999_test_upgrade_${randomUUID().slice(0, 8)}.sql`;
    try {
      expect(await message(issueVia(w.cast.issuer, a.batchId, a.signatureId, {
        beforeIssue: () => db.admin.query("insert into public.schema_migration (namespace, name, checksum) values ('recipe-core', $1, repeat('a', 64))", [name]).then(() => undefined),
      }))).toMatch(/^EBMR-VAL-001 release .* has no approved validation summary/);
    } finally {
      await db.admin.query("delete from public.schema_migration where namespace = 'recipe-core' and name = $1", [name]);
    }
    expect(await q('select 1 from recipe.batch_execution where id = $1', [a.batchId])).toEqual([]);
  });

  it('[INV-27][IN-18] the issue itself refuses a number voided in the register after the issue began, with its own reason', async () => {
    const a = await planned();
    const voidIt = () => tamper(`insert into site.batch_number_void (allocation_id, site_code, reason_code, reason_text, voided_by_person_id, voided_by_account_id, correlation_id)
                                 select l.allocation_id, $2, 'TEST_VOID', 'voided between the two steps of the issue', $3, $4, gen_random_uuid()
                                   from recipe.batch_allocation_link l where l.batch_id = $1`, [a.batchId, SITE, w.cast.issuer.personId, w.cast.issuer.accountId]);
    expect(await message(issueVia(w.cast.issuer, a.batchId, a.signatureId, { beforeIssue: voidIt })))
      .toMatch(new RegExp(`^The batch number of batch ${a.number} is not the register's: batch number ${a.number} was voided in the register.*\\[EBMR-EXE-191\\]$`));
  });

  it('[INV-17][INV-01] planning holds its family against a market authorisation being activated until the plan commits', async () => {
    master ??= await effectiveMaster(['IN']);
    const erpOrder = await familyOrder(db, erp, master.familyId, BS);
    let probe = '';
    await withProtectedNumbers(db.app, await cmd(db, w.cast.issuer), ledger, async (c) => {
      const r = await execution.prepareGmpIssue(c, randomUUID(), { markets: ['IN'], site: SITE, line: 'L1', batchSize: BS, familyId: master.familyId, erpOrder });
      // An activation locks the family FOR UPDATE (recipe-core 0290); here a superuser asks for the same lock without waiting.
      probe = await message(db.admin.query('select 1 from recipe.mbr_family where id = $1 for update nowait', [master.familyId]));
      return r;
    });
    expect(probe).toMatch(/could not obtain lock on row in relation "mbr_family"/);
  });

  it('[DI-34] a planned batch that is no longer PLANNED is not begun, even with no execution yet', async () => {
    const a = await planned();
    await tamper("update recipe.stub_batch set status = 'CANCELLED' where id = $1", [a.batchId]);
    expect(await message(begin(w.cast.issuer, a.batchId))).toMatch(/is CANCELLED; a GMP batch is issued once \(DI-34\)\. \[EBMR-EXE-197\]$/);
  });

  it('[DI-34] a batch id planned already is not planned again', async () => {
    const a = await planned();
    expect(await message(plan(w.cast.issuer, a.batchId, { familyId: master.familyId, markets: ['IN'] })))
      .toMatch(/^A batch with this id exists already; a batch is planned and issued once \(DI-34\)\. \[EBMR-EXE-197\]$/);
  });

  it('[DI-35][DI-14] the issue function itself refuses an ISSUED signature of another person, before the row guard does', async () => {
    const a = await planned();
    const byOther = await signIssue(issuer2, a.batchId);
    expect(await message(issueVia(w.cast.issuer, a.batchId, byOther)))
      .toMatch(/^The ISSUED signature of batch \S+ is another person's; the person who issues the batch signs it \(DI-35, DI-14\)\. \[EBMR-EXE-193\]$/);
  });

  it('[INV-01][DI-17] a batch planned for one site is not issued from a session at another site', async () => {
    const a = await planned();
    const byOther = await signIssue(issuer2, a.batchId);
    await tamper("update iam.session set site_code = 'SITE-2' where id = $1", [issuer2.sessionId]);
    try {
      expect(await message(issueVia(issuer2, a.batchId, byOther)))
        .toMatch(/^Batch \S+ is planned for site SITE-1; it is issued at that site, not at SITE-2 \(INV-01\)\. \[EBMR-EXE-194\]$/);
    } finally {
      await tamper('update iam.session set site_code = $2 where id = $1', [issuer2.sessionId, SITE]);
    }
    expect(await q('select 1 from recipe.batch_execution where id = $1', [a.batchId])).toEqual([]);
  });

  it('[DI-14] the issue request must name this batch: a request naming another batch id is refused', async () => {
    const a = await planned();
    expect(await message(issueVia(w.cast.issuer, a.batchId, a.signatureId, { edit: (r) => ({ ...r, batchId: randomUUID() }) })))
      .toMatch(/^The issue request names another person, batch or number than this command \(DI-14\)\. \[EBMR-EXE-015\]$/);
  });

  it('[INV-26][DI-17][D4] an engine role in the issue request is given only through a map row of the declared role whose permission this command evaluated; the evidence is stored', async () => {
    // Each request below is made in a command that evaluated BATCH.ISSUE at the actor's location (as the server does).
    // As an edition's release would (apps/tablets-server/test/execution/db-guards-issuer.test.ts for the sandbox issue):
    // the issuing role gets an engine role through BATCH.ISSUE, and another kernel role one through the same permission.
    await tamper("insert into recipe.engine_role_permission (engine_role, permission) values ('BATCH_ISSUER', 'BATCH.ISSUE'), ('ISSUE_OF_ANOTHER_ROLE', 'BATCH.ISSUE')", []);
    await tamper(`insert into recipe.engine_role_map (kernel_role, engine_role, via_permission)
                  values ('BATCH_ISSUER', 'BATCH_ISSUER', 'BATCH.ISSUE'), ('HEAD_OF_PRODUCTION', 'ISSUE_OF_ANOTHER_ROLE', 'BATCH.ISSUE')`, []);
    for (const role of ['ISSUE_OF_ANOTHER_ROLE', 'NO_SUCH_ENGINE_ROLE', 'PRODUCTION_SUPERVISOR']) {
      const a = await planned();
      expect(await message(issueVia(w.cast.issuer, a.batchId, a.signatureId, { roles: [role] })), role)
        .toMatch(new RegExp(`^The issue request gives the issuer engine role ${role} without a stored authority evaluation .*\\[EBMR-EXE-037\\]$`));
    }
    const ok = await planned();
    await issueVia(w.cast.issuer, ok.batchId, ok.signatureId, { roles: ['BATCH_ISSUER'] });
    const roles = (await q<{ roles: Json[] }>('select roles from recipe.execution_command where batch_id = $1 and seq = 1', [ok.batchId]))[0]?.roles ?? [];
    expect(roles.map((r) => [r['role'], r['permission']])).toEqual([['BATCH_ISSUER', 'BATCH.ISSUE']]);
    const ev = (await q<{ p: string; c: string }>('select person_id::text as p, correlation_id::text as c from iam.authority_evaluation where id = $1', [roles[0]?.['evaluationId']]))[0];
    const exe = (await q<{ c: string }>('select correlation_id::text as c from recipe.batch_execution where id = $1', [ok.batchId]))[0];
    expect(ev).toEqual({ p: w.cast.issuer.personId, c: exe?.c });
  });
});
