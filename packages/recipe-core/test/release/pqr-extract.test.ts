/**
 * The product quality review extract in the database (Phase 4 slice 6c; recipe-core 0910; IN-01 (b), PR-58; defaults
 * D-P4-8, D-6-7, D-6c-*): a versioned query with a stored SHA-256 of its result, reconciled to the batch number register,
 * the deviation register and the change records (a mismatch fails the extract and stores nothing), export-only batches
 * and market removals included, and the authorised person's sign-off (PQR_SIGNED_OFF) by someone outside the batches'
 * records. Every act runs as the application role through the definers with real e-signatures of seeded people; each
 * rule is also tried around (direct writes, another role, a stale extract, an involved signer).
 *
 * The batches are built as in after-release.test.ts: GMP batches issued from an effective master and reviewed through the
 * real review acts; the finished lot posted by the edition's definer. A register mismatch is a TEST FIXTURE: a row
 * written as the database owner with triggers off, standing in for a corrupted or diverging register.
 */
import { createHash, randomUUID } from 'node:crypto';
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
import { encodeState } from '../../src/engine/codec.ts';
import { autopilot, define, FIXTURE_INPUTS, FIXTURE_JUSTIFICATIONS, fixtureDefinition, GRANULATION_SCENARIO, Run } from '../engine/support.ts';
import { gmpOrderFor } from '../lifecycle/gmp-support.ts';
import { cell, reason, seedCast, uniqueContent, withSecondRole, World } from '../lifecycle/support.ts';
import { investigateDeviation } from './deviation-path.ts';

let db: TestDatabase;
let w: World;
let steward: SeededActor;
let operator: SeededActor;
let head: SeededActor;
let qaReviewer: SeededActor;
let qaReviewer2: SeededActor;
let qaReviewer3: SeededActor;
let ap: SeededActor;
let warehouse: SeededActor;
let erp: SeededActor;
type Master = { familyId: string; versionId: string; content: MbrContent };
const dir = tempDir('pqr-extract');
const ledger = tempLedger('pqr-extract', dir.path);

const SITE = 'SITE-1';
const BS = 'BS-200K';
const FIXTURE = 'tablet-granulation-compression';
type Market = 'IN' | 'US' | 'EU';

interface ExtractRow {
  id: string;
  result: {
    counts: Record<string, number>;
    batches: { batch_number: string; export_only: boolean; markets: string[]; failed: boolean; lots: unknown[]; market_removals: { market: string }[]; deviations: string[] }[];
    deviations: { ref: string; capa_refs: string[]; state: string; batches: string[] }[];
    changes: { number: string }[];
  };
  result_sha256: string;
  reconciliation: { ok: boolean; batches: { extract: number; register: number } };
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

async function effective(markets: Market[]): Promise<Master> {
  const m = uniqueContent(FIXTURE, ['EU', 'IN', 'US']);
  m.header.product = { ...m.header.product, code: m.header.product.code.toUpperCase() };
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

async function productionApproval(b: string): Promise<void> {
  await db.admin.query("update recipe.execution_state set status = 'EXECUTION_COMPLETE' where batch_id = $1", [b]);
  const approval = await w.sign(head, 'batch_review', b, 'PRODUCTION_APPROVED', 'EXECUTION_COMPLETE');
  await w.run(head, (c) => c.query('select recipe.record_production_approval($1, $2)', [b, approval]));
}

async function finishedLot(b: string, m: Master, markets: string[]): Promise<string> {
  const number = (await db.app.query<{ n: string }>('select batch_number as n from recipe.batch_execution where id = $1', [b])).rows[0]!.n;
  return withCommand(db.admin, await cmd(db, warehouse), async (c) =>
    (await c.query<{ id: string }>('select site.create_finished_lot($1::jsonb) as id', [
      JSON.stringify({ batchId: b, batchNumber: number, edition: 'TABLETS', siteCode: SITE, productCode: m.content.header.product.code, productName: 'PQR test product',
                       strength: '500 mg', markets, quantity: '1000', unit: 'units', expiresAt: '2029-06-30T23:59:59Z' }),
    ])).rows[0]!.id,
  );
}

async function sqlAs<T>(who: SeededActor, text: string, params: unknown[] = []): Promise<T> {
  return w.run(who, async (c) => ((await c.query(text, params)).rows[0] as { r: T } | undefined)?.r as T);
}

async function deviationOn(kind: 'LOT' | 'BATCH', id: string, title = 'Found during the period'): Promise<string> {
  const d = await sqlAs<{ deviationId: string }>(operator, 'select site.raise_deviation($1::jsonb) as r', [
    JSON.stringify({ kind: 'DEVIATION', title, classification: 'MAJOR', riskRationale: 'Assessed for every market of the batch' }),
  ]);
  await w.run(operator, (c) => c.query('select site.link_deviation($1, $2, $3)', [d.deviationId, kind, id]));
  return d.deviationId;
}

const pathDriver = {
  run: <T>(who: SeededActor, work: (c: pg.PoolClient) => Promise<T>) => w.run(who, work),
  sign: (who: SeededActor, aggregate: { type: string; id: string }, meaning: string, expectedState: string) => signFor(db, who, aggregate, meaning, expectedState),
};

/** As the server's ceremony does it: challenge and authentication, then one command that signs and runs the act. */
async function signed<T = unknown>(who: SeededActor, type: string, id: string, meaning: string, expectedState: string | null, act: (c: pg.PoolClient, sig: string) => Promise<T>): Promise<T> {
  await ensureSealKey(db);
  const content = await contentForSigning(db.app, type, id);
  const ch = await withCommand(db.app, await cmd(db, who), (c) => createChallenge(c, { aggregateType: type, aggregateId: id, contentVersion: content.contentVersion ?? '1', meaning, clientContentHash: content.contentHash ?? '' }));
  const ev = await signatureAuth(db, who, who, ch.challengeId);
  return withCommand(db.app, await cmd(db, who), async (c) => act(c, (await sign(c, { challengeId: ch.challengeId, authEventId: ev, expectedState }, testSealKey)).signatureId));
}

async function marketRemoval(who: SeededActor, batchId: string, market: Market, deviation: string): Promise<string> {
  const aid = (await db.app.query<{ a: string }>("select recipe.market_change_next_id('BATCH', $1, 'REMOVE', $2) as a", [batchId, market])).rows[0]!.a;
  return signed(who, 'market_change', aid, 'MARKET_REMOVED', 'IN_SET', async (c, sig) =>
    (await c.query<{ id: string }>("select recipe.record_market_change('BATCH', $1, 'REMOVE', $2, $3, $4) as id", [batchId, market, deviation, sig])).rows[0]!.id);
}

let FROM = '';
let TO = '';
const run = async (who: SeededActor, product: string, from = FROM, to = TO): Promise<string> =>
  sqlAs<string>(who, 'select recipe.run_pqr_extract($1, $2::date, $3::date) as r', [product, from, to]);
const extractOf = async (id: string): Promise<ExtractRow> =>
  (await db.app.query<ExtractRow>('select id, result, result_sha256, reconciliation from recipe.pqr_extract where id = $1', [id])).rows[0]!;
const reproduces = async (id: string): Promise<boolean> => (await db.app.query<{ r: boolean }>('select recipe.pqr_reproduces($1) as r', [id])).rows[0]!.r;
const signOff = (who: SeededActor, id: string): Promise<string> =>
  signed(who, 'pqr_extract', id, 'PQR_SIGNED_OFF', 'EXTRACTED', async (c, sig) => (await c.query<{ id: string }>('select recipe.sign_off_pqr($1, $2) as id', [id, sig])).rows[0]!.id);
const extractCount = async (product: string): Promise<number> =>
  Number((await db.app.query<{ n: string }>('select count(*) as n from recipe.pqr_extract where product_code = $1', [product])).rows[0]!.n);

/** TEST FIXTURE: a row written as the database owner with triggers off (a register that diverges from the records). */
async function corrupt(sql: string, params: unknown[]): Promise<void> {
  const c = await db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    await c.query(sql, params);
    await c.query('commit');
  } catch (error) {
    await c.query('rollback');
    throw error;
  } finally {
    c.release();
  }
}

let main: Master;
let domestic: string;
let exportOnly: string;
let lotId: string;
let exportLot: string;
let deviation: string;

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
  warehouse = await seedActor(db, { roleCode: 'WAREHOUSE_LABELLING', legalName: 'Wasim Warehouse' });
  erp = await seedServiceActor(db, { kind: 'INTEGRATION', source: 'INTEGRATION', roleCode: 'ERP_INTERFACE', name: 'ERP interface' });
  const { rows } = await db.admin.query<{ f: string; t: string }>("select (current_date - 3)::text as f, (current_date + 3)::text as t");
  FROM = rows[0]!.f;
  TO = rows[0]!.t;

  main = await effective(['IN', 'US', 'EU']);
  domestic = await issuedBatch(main, ['IN', 'US', 'EU']);
  exportOnly = await issuedBatch(main, ['IN', 'US']);
  await productionApproval(domestic);
  lotId = await finishedLot(domestic, main, ['IN', 'US', 'EU']);
  exportLot = await finishedLot(exportOnly, main, ['US']);
  deviation = await deviationOn('BATCH', domestic, 'Granulation endpoint missed');
  await investigateDeviation(pathDriver, deviation, { classifier: qaReviewer, owner: qaReviewer, assessor: qaReviewer2, concluder: qaReviewer2, closer: qaReviewer3 }, {
    finding: { assignableCause: true, cause: 'A gasket wore out between two maintenance checks', rootCauseCategory: 'EQUIPMENT' },
    markets: ['IN', 'US', 'EU'],
    impact: 'NONE',
    close: true,
  });
  await marketRemoval(qaReviewer3, domestic, 'US', deviation);
}, 900_000);

afterAll(async () => {
  await db.drop();
  dir.cleanup();
});

describe('the PQR extract (IN-01, PR-58)', () => {
  it('[IN-01][PR-58] the extract of a product and period includes domestic and export-only batches, their lots, market removals, deviations with CAPA as recorded and the change records, and reconciles to the registers', async () => {
    const id = await run(qaReviewer, main.content.header.product.code);
    const x = await extractOf(id);
    const numbers = (await db.app.query<{ id: string; n: string }>('select id, batch_number as n from recipe.batch_execution where id = any ($1)', [[domestic, exportOnly]])).rows;
    const nOf = (b: string): string => numbers.find((r) => r.id === b)!.n;
    expect(x.result.batches.map((b) => b.batch_number)).toEqual([nOf(domestic), nOf(exportOnly)].sort());
    const exp = x.result.batches.find((b) => b.batch_number === nOf(exportOnly))!;
    // Every batch is made under the Indian licence (INV-28); the export-only SKU is its finished lot for the US only.
    expect(exp.export_only).toBe(true);
    expect(exp.markets).toEqual(['IN', 'US']);
    expect(exp.lots).toEqual([expect.objectContaining({ lot_id: exportLot, export_only: true, markets: ['US'] })]);
    const dom = x.result.batches.find((b) => b.batch_number === nOf(domestic))!;
    expect(dom.export_only).toBe(false);
    expect(dom.lots).toHaveLength(1);
    expect(JSON.stringify(dom.lots)).toContain(lotId);
    expect(dom.market_removals.map((r) => r.market)).toEqual(['US']);
    expect(dom.deviations).toHaveLength(1);
    expect(x.result.deviations).toHaveLength(1);
    expect(x.result.deviations[0]!.capa_refs).toEqual(['CAPA-TEST-001']);
    expect(x.result.deviations[0]!.state).toBe('CLOSED');
    expect(x.result.counts).toMatchObject({ batches: 2, export_only_batches: 1, lots: 2, export_only_lots: 1, market_removals: 1, deviations: 1, deviations_with_capa: 1 });
    expect(x.reconciliation.ok).toBe(true);
    expect(x.reconciliation.batches).toMatchObject({ extract: 2, register: 2 });
    // The stored hash is the SHA-256 of the result as stored.
    const text = (await db.app.query<{ t: string }>('select result::text as t from recipe.pqr_extract where id = $1', [id])).rows[0]!.t;
    expect(x.result_sha256).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
    // A batch of another period is not in it.
    const other = await extractOf(await run(qaReviewer, main.content.header.product.code, '2020-01-01', '2020-12-31'));
    expect(other.result.counts['batches']).toBe(0);
  });

  it('[PR-58] a re-run on the same data gives the same result and the same hash; the stored extract reproduces', async () => {
    const a = await extractOf(await run(qaReviewer, main.content.header.product.code));
    const b = await extractOf(await run(ap, main.content.header.product.code));
    expect(b.result_sha256).toBe(a.result_sha256);
    expect(b.result).toEqual(a.result);
    expect(await reproduces(a.id)).toBe(true);
    // The query is versioned: version 1 with the SHA-256 of its definition as installed, still matching; version 2
    // (recipe-core 1062, typed CPP values, PR-09) is the current one and matches too.
    const q = (await db.app.query<{ p: string | null; p2: string | null; v: number }>('select recipe.pqr_query_problem(1) as p, recipe.pqr_query_problem(2) as p2, recipe.pqr_current_version() as v')).rows[0]!;
    expect(q).toEqual({ p: null, p2: null, v: 2 });
  });

  it('[PR-58] parameters are checked: a product code, a period whose end is not before its start, at most three years', async () => {
    const p = main.content.header.product.code;
    expect(await codeOf(run(qaReviewer, 'not a code'))).toBe('EBMR-PQR-001');
    expect(await codeOf(run(qaReviewer, p, TO, FROM))).toBe('EBMR-PQR-002');
    expect(await codeOf(run(qaReviewer, p, '2020-01-01', '2024-01-02'))).toBe('EBMR-PQR-003');
  });

  it('[IN-01] only a role with PQR.EXTRACT runs an extract; the application role writes no extract, sign-off or query version directly and changes none', async () => {
    const p = main.content.header.product.code;
    expect(await codeOf(run(operator, p))).toMatch(/EBMR-IAM-040/);
    expect(await codeOf(db.app.query("insert into recipe.pqr_extract (product_code, period_from, period_to, query_version, parameters, result, result_sha256, reconciliation, person_id, account_id, role_code, correlation_id) values ($1, current_date, current_date, 1, '{}', '{}', repeat('0', 64), '{\"ok\": true}', gen_random_uuid(), gen_random_uuid(), 'AUTHORISED_PERSON', gen_random_uuid())", [p]))).toMatch(/permission denied/);
    expect(await codeOf(db.app.query("update recipe.pqr_extract set result_sha256 = repeat('0', 64)"))).toMatch(/permission denied/);
    expect(await codeOf(db.app.query("insert into recipe.pqr_signoff (extract_id, result_sha256, signature_id, content_hash, person_id, account_id, role_code, correlation_id) select id, result_sha256, gen_random_uuid(), 'x', gen_random_uuid(), gen_random_uuid(), 'AUTHORISED_PERSON', gen_random_uuid() from recipe.pqr_extract limit 1"))).toMatch(/permission denied/);
    expect(await codeOf(db.app.query("update recipe.pqr_query_version set definition_sha256 = repeat('0', 64)"))).toMatch(/permission denied/);
    // Even the owner cannot rewrite a stored extract (insert-only).
    expect(await codeOf(db.admin.query("update recipe.pqr_extract set result_sha256 = repeat('0', 64)"))).not.toBe('ok');
  });

  it('[IN-01][PR-58] a deviation register that does not match the records fails the extract and stores nothing', async () => {
    const m = await effective(['IN']);
    const b = await issuedBatch(m, ['IN']);
    const p = m.content.header.product.code;
    expect((await extractOf(await run(qaReviewer, p))).reconciliation.ok).toBe(true);
    const before = await extractCount(p);
    const n = (await db.app.query<{ n: string }>('select batch_number as n from recipe.batch_execution where id = $1', [b])).rows[0]!.n;
    const dev = await sqlAs<{ deviationId: string }>(operator, 'select site.raise_deviation($1::jsonb) as r', [JSON.stringify({ kind: 'DEVIATION', title: 'Linked to the wrong batch id', classification: 'MINOR', riskRationale: 'Assessed for the one market' })]);
    // TEST FIXTURE: the register names the batch's number, but the link's batch id is another one.
    await corrupt("insert into site.deviation_link (deviation_id, subject_kind, subject_id, subject_ref, batch_id, batch_number, edition, linked_by_person, linked_by_account) values ($1, 'CONTAINER', gen_random_uuid(), 'C-1', gen_random_uuid(), $2, 'TABLETS', gen_random_uuid(), gen_random_uuid())", [dev.deviationId, n]);
    const message = await run(qaReviewer, p).then(() => 'ok', (e: unknown) => (e instanceof Error ? e.message : String(e)));
    expect(message).toMatch(/EBMR-PQR-006/);
    expect(message).toMatch(/deviations: 0 in the extract, 1 in the register; in the register only: /);
    expect(await extractCount(p)).toBe(before);
  });

  it('[IN-01][PR-58] a batch number register that does not match the issued batches fails the extract', async () => {
    const m = await effective(['IN']);
    const b = await issuedBatch(m, ['IN']);
    const p = m.content.header.product.code;
    const first = await run(qaReviewer, p);
    // TEST FIXTURE: the register entry of the issued batch reads as voided.
    await corrupt("insert into site.batch_number_void (allocation_id, site_code, reason_code, reason_text, voided_by_person_id, voided_by_account_id, correlation_id) select allocation_id, 'SITE-1', 'TEST_FIXTURE', 'diverging register', gen_random_uuid(), gen_random_uuid(), gen_random_uuid() from recipe.batch_allocation_link where batch_id = $1", [b]);
    const message = await run(qaReviewer, p).then(() => 'ok', (e: unknown) => (e instanceof Error ? e.message : String(e)));
    expect(message).toMatch(/EBMR-PQR-006/);
    expect(message).toMatch(/batches: 1 in the extract, 0 in the register/);
    // The extract run before no longer reconciles, so the AP cannot sign it off.
    expect(await codeOf(signOff(ap, first))).toBe('EBMR-PQR-006');
  });
});

describe('the AP sign-off (IN-01 (b), PR-58)', () => {
  it('[IN-01][PR-58] changed data gives a different hash; the earlier extract no longer reproduces and is not signed off', async () => {
    const p = main.content.header.product.code;
    const old = await extractOf(await run(qaReviewer, p));
    await deviationOn('BATCH', exportOnly, 'Found after the first extract');
    const now = await extractOf(await run(qaReviewer, p));
    expect(now.result_sha256).not.toBe(old.result_sha256);
    expect(now.result.counts['deviations']).toBe(old.result.counts['deviations']! + 1);
    expect(await reproduces(old.id)).toBe(false);
    expect(await codeOf(signOff(ap, old.id))).toBe('EBMR-PQR-012');
  });

  it('[IN-01] a person without the AP\'s sign-off permission cannot sign or record a sign-off', async () => {
    const id = await run(qaReviewer, main.content.header.product.code);
    expect(await codeOf(signOff(qaReviewer3, id))).toMatch(/EBMR-(ESIG|IAM)-\d{3}/);
    expect(await codeOf(w.run(qaReviewer3, (c) => c.query('select recipe.sign_off_pqr($1, $2)', [id, randomUUID()])))).toMatch(/EBMR-IAM-040/);
    expect((await db.app.query('select 1 from recipe.pqr_signoff where extract_id = $1', [id])).rowCount).toBe(0);
  });

  it('[IN-01][INV-35] a person involved in the reviewed batches\' records never signs off their review: the production approver holding the AP role is refused', async () => {
    const id = await run(qaReviewer, main.content.header.product.code);
    const involved = (await db.app.query<{ i: string[] }>('select recipe.pqr_involvement($1) as i', [id])).rows[0]!.i;
    expect(involved).toContain(head.personId);
    expect(involved).not.toContain(ap.personId);
    const approverAsAp = await withSecondRole(db, head, 'AUTHORISED_PERSON');
    expect(await codeOf(signOff(approverAsAp, id))).toMatch(/EBMR-ESIG-04[45]|EBMR-PQR-014/);
    expect((await db.app.query('select 1 from recipe.pqr_signoff where extract_id = $1', [id])).rowCount).toBe(0);
  });

  it('[IN-01][PR-58] the AP signs off a reproducing, reconciled extract once; the signed content carries the hash and the reconciliation', async () => {
    const id = await run(qaReviewer, main.content.header.product.code);
    const signoff = await signOff(ap, id);
    const row = (await db.app.query<{ s: string; h: string; x: string; p: string }>('select s.signature_id as s, s.result_sha256 as h, x.result_sha256 as x, s.person_id as p from recipe.pqr_signoff s join recipe.pqr_extract x on x.id = s.extract_id where s.id = $1', [signoff])).rows[0]!;
    expect(row.h).toBe(row.x);
    expect(row.p).toBe(ap.personId);
    const content = await contentForSigning(db.app, 'pqr_extract', id);
    expect(content.state).toBe('SIGNED_OFF');
    expect(await codeOf(signOff(ap, id))).toMatch(/EBMR-(ESIG-\d{3}|PQR-011)/);
  });
});

describe('typed CPP values in the extract (recipe-core 1062; PR-09)', () => {
  interface Cpp { batch_number: string; kind: string; ref: string; id: string; step: string; attempt: number; value: unknown; unit: string | null; failed: boolean }
  type Json = Record<string, unknown>;
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

  /** The CPP values recomputed in TypeScript from one batch record (its stored state) and its master content. */
  function recompute(batchNumber: string, content: MbrContent, state: Json): Cpp[] {
    const params = new Map((content.parameters as unknown as Json[]).map((p) => [String(p['id']), p]));
    const calcs = new Map((content.calculations as unknown as Json[]).map((c) => [String(c['id']), c]));
    const out: Cpp[] = [];
    for (const [ref, pt] of Object.entries((state['points'] ?? {}) as Record<string, Json>)) {
      const p = params.get(String(pt['item']));
      if (!p || pt['status'] !== 'VALID' || pt['kind'] !== 'VALUE' || p['criticality'] !== 'CRITICAL' || !['PROCESS_PARAMETER', 'IPC', 'PROCESS_ENDPOINT'].includes(String(p['role']))) continue;
      out.push({ batch_number: batchNumber, kind: 'PARAMETER', ref, id: String(pt['item']), step: String(pt['stepKey']), attempt: Number(pt['attempt']), value: pt['value'],
                 unit: (p['unit'] as string | undefined) ?? null, failed: pt['failed'] === true });
    }
    for (const [ref, dv] of Object.entries((state['derived'] ?? {}) as Record<string, Json>)) {
      const c = calcs.get(String(dv['calculation']));
      if (!c || dv['status'] !== 'CURRENT' || c['criticality'] !== 'CRITICAL') continue;
      out.push({ batch_number: batchNumber, kind: 'CALCULATION', ref, id: String(dv['calculation']), step: String(dv['stepKey']), attempt: 1, value: dv['value'],
                 unit: ((c['output'] as Json | undefined)?.['unit'] as string | undefined) ?? null, failed: dv['failed'] === true });
    }
    return out.sort((a, b) => cmp(a.kind, b.kind) || cmp(a.id, b.id) || cmp(a.step, b.step) || a.attempt - b.attempt || cmp(a.ref, b.ref));
  }

  /** The record of a batch as executed on the floor: the golden granulation run, with this batch's own hardness. */
  function executedRecord(hardness: string): Json {
    const r = Run.issue(fixtureDefinition(FIXTURE), { inputs: FIXTURE_INPUTS[FIXTURE], variants: {} });
    const scenario = { ...GRANULATION_SCENARIO, value: (item: string, step: string, frames: Parameters<NonNullable<typeof GRANULATION_SCENARIO.value>>[2], run: Run) =>
      item === 'hardness' ? { kind: 'DECIMAL' as const, value: hardness, unit: 'N' } : GRANULATION_SCENARIO.value?.(item, step, frames, run) };
    expect(autopilot(r, scenario)).toBe('COMPLETE');
    return JSON.parse(JSON.stringify(encodeState(r.state))) as Json;
  }

  it('[PR-09] CPP data exported for N batches and recomputed from source records match', async () => {
    const m = await effective(['IN']);
    const product = m.content.header.product.code;
    const N = 3;
    const records: { batchId: string; number: string; state: Json }[] = [];
    for (let i = 0; i < N; i++) {
      const batchId = await issuedBatch(m, ['IN']);
      const state = executedRecord(String(85 + i));
      // ARRANGEMENT: the batch's record as executed (the engine's golden run), written as the projection the execution
      // writers keep; the floor flow itself is proven by the engine and execution tests.
      await corrupt("update recipe.execution_state set state = $2::jsonb, status = 'EXECUTION_COMPLETE' where batch_id = $1", [batchId, JSON.stringify(state)]);
      const number = (await db.app.query<{ n: string }>('select batch_number as n from recipe.batch_execution where id = $1', [batchId])).rows[0]!.n;
      records.push({ batchId, number, state });
    }
    const x = await extractOf(await run(qaReviewer, product));
    const cpp = (x.result as unknown as { cpp: Cpp[] }).cpp;
    // Recomputed from the source records (each batch's stored record and its issued master), the export is the same.
    const stored = await db.admin.query<{ id: string; state: Json; content: MbrContent }>(
      'select b.id, s.state, recipe.batch_mbr_content(b.id) as content from recipe.batch_execution b join recipe.execution_state s on s.batch_id = b.id where b.id = any($1::uuid[])',
      [records.map((r) => r.batchId)]);
    const recomputed = records.slice().sort((a, b) => cmp(a.number, b.number)).flatMap((r) => {
      const row = stored.rows.find((s) => s.id === r.batchId)!;
      return recompute(r.number, row.content, row.state);
    });
    expect(cpp).toEqual(recomputed);
    // SETUP: every batch exports its IPC results, process parameters and endpoint, and its yields, typed.
    for (const r of records) {
      const mine = cpp.filter((c) => c.batch_number === r.number);
      expect(mine.some((c) => c.kind === 'CALCULATION' && c.id === 'granYield')).toBe(true);
      expect(mine.some((c) => c.kind === 'PARAMETER' && c.id === 'lod')).toBe(true);
      expect(mine.filter((c) => c.id === 'hardness').map((c) => c.value)).toContainEqual({ kind: 'DECIMAL', value: String(85 + records.indexOf(r)), unit: 'N' });
      expect(mine.some((c) => c.id === 'machineSpeed')).toBe(false);
    }
    expect(new Set(cpp.map((c) => c.batch_number)).size).toBe(N);
    expect(await reproduces(x.id)).toBe(true);
    // A changed source record changes the export: the earlier extract no longer reproduces.
    const changed = JSON.parse(JSON.stringify(records[1]!.state)) as Json;
    const point = Object.values(changed['points'] as Record<string, Json>).find((p) => p['item'] === 'hardness' && p['status'] === 'VALID')!;
    point['value'] = { kind: 'DECIMAL', value: '70', unit: 'N' };
    await corrupt('update recipe.execution_state set state = $2::jsonb where batch_id = $1', [records[1]!.batchId, JSON.stringify(changed)]);
    expect(await reproduces(x.id)).toBe(false);
  }, 600_000);
});
