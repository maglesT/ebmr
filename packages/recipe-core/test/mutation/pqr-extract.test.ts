/**
 * The PQR extract and its reconciliation, rule by rule (SQL mutation group "pqr-extract": recipe-core 0910; decision
 * 0012). These tests close the gaps the Phase 4 focused mutation run found in test/release/pqr-extract.test.ts:
 *   - the register side of the reconciliation for each source of a deviation or a change record: a deviation linked to
 *     a finished lot only, market additions of the batch and of its lot, a successor master effective in the period, with
 *     another product's records of each kind alongside (the extract reconciles only when the register sees exactly the
 *     same);
 *   - the reconciliation's own counts (a register with a repeated entry), the period bounds, the query version, the
 *     reading of one extract among several, and the sign-off of one extract while another is locked or signed off.
 * The batches are real GMP batches issued from effective masters, as in test/release/pqr-extract.test.ts.
 *
 * Controls: IN-01 (product quality review), PR-58 (reproducible, reconciled extract).
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withProtectedNumbers } from '../../../kernel/src/continuity/numbers.ts';
import { withCommand } from '../../../kernel/src/db/command.ts';
import { createChallenge, contentForSigning, sign } from '../../../kernel/src/esig/signing.ts';
import { tempDir, tempLedger } from '../../../kernel/test/continuity/helpers.ts';
import { cmd, ensureSealKey, signatureAuth, testSealKey } from '../../../kernel/test/esig/helpers.ts';
import { seedActor, seedServiceActor, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { signFor } from '../../../kernel/test/records/helpers.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { approveTestRelease } from '../../../kernel/test/support/validation.ts';
import * as execution from '../../src/execution/index.ts';
import type { MbrContent } from '../../src/flow/model.ts';
import * as lc from '../../src/lifecycle/index.ts';
import { define, FIXTURE_INPUTS, FIXTURE_JUSTIFICATIONS } from '../engine/support.ts';
import { gmpOrderFor } from '../lifecycle/gmp-support.ts';
import { cell, reason, seedCast, uniqueContent, World } from '../lifecycle/support.ts';

let db: TestDatabase;
let w: World;
let steward: SeededActor;
let operator: SeededActor;
let qaReviewer: SeededActor;
let qaReviewer3: SeededActor;
let ap: SeededActor;
let warehouse: SeededActor;
let erp: SeededActor;
type Master = { familyId: string; versionId: string; content: MbrContent; product: string };
const dir = tempDir('pqr-mutation');
const ledger = tempLedger('pqr-mutation', dir.path);

const SITE = 'SITE-1';
const BS = 'BS-200K';
const FIXTURE = 'tablet-granulation-compression';

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
  for (const market of ['IN', 'US']) {
    const def: lc.MarketAuthorisationDefinition = { versionId: v.versionId, market, kind: 'CURRENT', cells: [cell(SITE, 'L1', BS)], regulatoryBasis: `${market}: registration on file` };
    await w.authorise(def);
  }
  await w.run(steward, (c) =>
    c.query('select site.define_batch_number_rule($1::jsonb)', [
      JSON.stringify({ rule_code: `R-${randomUUID().slice(0, 8).toUpperCase()}`, site_code: SITE, product_code: content.header.product.code, batch_kind: 'PROCESSING', format: 'Q{YY}{SEQ:5}', site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3' }),
    ]),
  );
  return { familyId: v.familyId, versionId: v.versionId, content, product: content.header.product.code };
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

async function finishedLot(b: string, m: Master, markets: string[]): Promise<string> {
  const number = (await db.app.query<{ n: string }>('select batch_number as n from recipe.batch_execution where id = $1', [b])).rows[0]!.n;
  return withCommand(db.admin, await cmd(db, warehouse), async (c) =>
    (await c.query<{ id: string }>('select site.create_finished_lot($1::jsonb) as id', [
      JSON.stringify({ batchId: b, batchNumber: number, edition: 'TABLETS', siteCode: SITE, productCode: m.product, productName: 'PQR mutation product',
                       strength: '500 mg', markets, quantity: '1000', unit: 'units', expiresAt: '2029-06-30T23:59:59Z' }),
    ])).rows[0]!.id,
  );
}

async function sqlAs<T>(who: SeededActor, text: string, params: unknown[] = []): Promise<T> {
  return w.run(who, async (c) => ((await c.query(text, params)).rows[0] as { r: T } | undefined)?.r as T);
}

async function deviationOnLot(lot: string): Promise<string> {
  const d = await sqlAs<{ deviationId: string }>(operator, 'select site.raise_deviation($1::jsonb) as r', [
    JSON.stringify({ kind: 'DEVIATION', title: 'Found on the finished lot', classification: 'MINOR', riskRationale: 'Assessed for every market of the lot' }),
  ]);
  await w.run(operator, (c) => c.query("select site.link_deviation($1, 'LOT', $2)", [d.deviationId, lot]));
  return d.deviationId;
}

/** As the server's ceremony does it: challenge and authentication, then one command that signs and runs the act. */
async function signed<T = unknown>(who: SeededActor, type: string, id: string, meaning: string, expectedState: string | null, act: (c: pg.PoolClient, sig: string) => Promise<T>): Promise<T> {
  await ensureSealKey(db);
  const content = await contentForSigning(db.app, type, id);
  const ch = await withCommand(db.app, await cmd(db, who), (c) => createChallenge(c, { aggregateType: type, aggregateId: id, contentVersion: content.contentVersion ?? '1', meaning, clientContentHash: content.contentHash ?? '' }));
  const ev = await signatureAuth(db, who, who, ch.challengeId);
  return withCommand(db.app, await cmd(db, who), async (c) => act(c, (await sign(c, { challengeId: ch.challengeId, authEventId: ev, expectedState }, testSealKey)).signatureId));
}

async function marketAdd(kind: 'LOT' | 'BATCH', id: string, market: string, changeRecord: string): Promise<void> {
  const aid = (await db.app.query<{ a: string }>("select recipe.market_change_next_id($1, $2, 'ADD', $3) as a", [kind, id, market])).rows[0]!.a;
  await signed(qaReviewer3, 'market_change', aid, 'MARKET_ADDED', 'NOT_IN_SET', (c, sig) =>
    c.query("select recipe.record_market_change($1, $2, 'ADD', $3, $4, $5)", [kind, id, market, changeRecord, sig]));
}

/** A draft successor of `m` naming its own change record and effective on `day` (the register reads the attribute as set). */
async function successorEffective(m: Master, day: string): Promise<string> {
  const ref = await w.run(w.cast.author, (c) => lc.deriveVersion(c, m.versionId, 'change under test'));
  const cr = await w.changeRecord();
  await w.run(w.cast.author, (c) => lc.setDraftAttributes(c, ref.versionId, { changeRecordId: cr, effectiveFrom: `${day}T06:00:00Z`, reviewDue: '2027-12-31' }),
    reason('draft attributes of the successor set for the test'));
  return numberOf(cr);
}
const numberOf = async (changeRecord: string): Promise<string> => (await db.app.query<{ n: string }>('select number as n from recipe.change_record where id = $1', [changeRecord])).rows[0]!.n;
const refOf = async (deviation: string): Promise<string> => (await db.app.query<{ r: string }>('select ref as r from site.deviation where id = $1', [deviation])).rows[0]!.r;

let FROM = '';
let TO = '';
let TODAY = '';
const run = (who: SeededActor, product: string, from = FROM, to = TO): Promise<string> =>
  sqlAs<string>(who, 'select recipe.run_pqr_extract($1, $2::date, $3::date) as r', [product, from, to]);

let p: Master;
let pBatch: string;
let lotDeviation: string;
let changes: string[] = [];
let foreignChanges: string[] = [];
let foreignDeviation: string;

beforeAll(async () => {
  db = await createTestDatabase();
  // Slice 7c (DI-03, recipe-core 1250): a GMP batch is issued only on a release with an approved validation summary.
  await approveTestRelease(db);
  w = new World(db, await seedCast(db));
  steward = await seedActor(db, { roleCode: 'MASTER_DATA_STEWARD', legalName: 'Mira Steward' });
  operator = await seedActor(db, { roleCode: 'OPERATOR', legalName: 'Om Operator', roomCode: 'DISP-01' });
  qaReviewer = await seedActor(db, { roleCode: 'QA_REVIEWER', legalName: 'Rhea Reviewer' });
  qaReviewer3 = await seedActor(db, { roleCode: 'QA_REVIEWER', legalName: 'Rani Reviewer' });
  ap = await seedActor(db, { roleCode: 'AUTHORISED_PERSON', legalName: 'Anita Authorised' });
  warehouse = await seedActor(db, { roleCode: 'WAREHOUSE_LABELLING', legalName: 'Wasim Warehouse' });
  erp = await seedServiceActor(db, { kind: 'INTEGRATION', source: 'INTEGRATION', roleCode: 'ERP_INTERFACE', name: 'ERP interface' });
  const { rows } = await db.admin.query<{ f: string; t: string; d: string }>("select (current_date - 3)::text as f, (current_date + 3)::text as t, current_date::text as d");
  FROM = rows[0]!.f;
  TO = rows[0]!.t;
  TODAY = rows[0]!.d;

  // The reviewed product: a batch for IN, its lot, a deviation linked to the lot only, the batch and the lot added to the
  // US under two change records, and a successor master effective in the period under a third.
  p = await effective();
  const b = await issuedBatch(p, ['IN']);
  pBatch = b;
  const lot = await finishedLot(b, p, ['IN']);
  lotDeviation = await deviationOnLot(lot);
  const crBatch = await w.changeRecord();
  await marketAdd('BATCH', b, 'US', crBatch);
  const crLot = await w.changeRecord();
  await marketAdd('LOT', lot, 'US', crLot);
  changes = [await numberOf(crBatch), await numberOf(crLot), await successorEffective(p, TODAY)];

  // Another product with records of every kind in the same period: none of them is the reviewed product's.
  const q = await effective();
  const bq = await issuedBatch(q, ['IN']);
  const lotq = await finishedLot(bq, q, ['IN']);
  foreignDeviation = await deviationOnLot(lotq);
  const crQ = await w.changeRecord();
  await marketAdd('LOT', lotq, 'US', crQ);
  foreignChanges = [await numberOf(crQ), await successorEffective(q, TODAY)];
}, 900_000);

afterAll(async () => {
  await db.drop();
  dir.cleanup();
});

interface Result {
  deviations: { ref: string }[];
  changes: { number: string }[];
}
const extractOf = async (id: string): Promise<{ result: Result; reconciliation: { ok: boolean } }> =>
  (await db.app.query<{ result: Result; reconciliation: { ok: boolean } }>('select result, reconciliation from recipe.pqr_extract where id = $1', [id])).rows[0]!;

describe('the register side of the reconciliation, source by source (recipe-core 0910, recipe.pqr_register_view)', () => {
  it('[IN-01] [PR-58] a deviation of the product\'s lot only, the market additions of its batch and its lot and a successor effective in the period are in the extract and in the registers alike; another product\'s are in neither', async () => {
    const id = await run(qaReviewer, p.product);
    const x = await extractOf(id);
    expect(x.reconciliation.ok).toBe(true);
    expect(x.result.deviations.map((d) => d.ref)).toEqual([await refOf(lotDeviation)]);
    const numbers = x.result.changes.map((c) => c.number);
    for (const n of changes) expect(numbers).toContain(n);
    for (const n of foreignChanges) expect(numbers).not.toContain(n);
    expect(x.result.deviations.map((d) => d.ref)).not.toContain(await refOf(foreignDeviation));
    const register = (await db.admin.query<{ r: { deviations: string[]; changes: string[] } }>('select recipe.pqr_register_view($1, $2::date, $3::date) as r', [p.product, FROM, TO])).rows[0]!.r;
    expect(register.deviations).toEqual([await refOf(lotDeviation)]);
    expect([...register.changes].sort()).toEqual([...numbers].sort());
  });
});

describe('the reconciliation itself (recipe-core 0910, recipe.pqr_reconciliation)', () => {
  const reconcile = async (extract: string[], register: string[]): Promise<{ ok: boolean; problems: string[] }> =>
    (await db.admin.query<{ r: { ok: boolean; problems: string[] } }>('select recipe.pqr_reconciliation($1::jsonb, $2::jsonb) as r', [
      JSON.stringify({ batches: extract.map((n) => ({ batch_number: n })), deviations: [], changes: [] }),
      JSON.stringify({ batches: register, deviations: [], changes: [] }),
    ])).rows[0]!.r;

  it('[PR-58] the counts must agree as well as the members: an entry counted twice on one side fails, with only the counts named', async () => {
    const twice = await reconcile(['B1', 'B1'], ['B1']);
    expect(twice.ok).toBe(false);
    expect(twice.problems).toEqual(['batches: 2 in the extract, 1 in the register']);
    const swapped = await reconcile(['B1', 'B1'], ['B1', 'B2']);
    expect(swapped.ok).toBe(false);
    expect(swapped.problems).toEqual(['batches: 2 in the extract, 2 in the register; in the register only: B2']);
    expect((await reconcile(['B1', 'B2'], ['B2', 'B1'])).ok).toBe(true);
  });
});

describe('the period, the query version and one extract among several (recipe-core 0910)', () => {
  it('[IN-01] a period may be one day, and up to exactly three years; it has both ends, in order', async () => {
    const PERIOD = /EBMR-PQR-002 the period runs from a first day to a last day on or after it/;
    expect(await messageOf(run(qaReviewer, p.product, TODAY, TODAY))).toBe('ok');
    expect(await messageOf(sqlAs(qaReviewer, 'select recipe.run_pqr_extract($1, null, $2::date) as r', [p.product, TO]))).toMatch(PERIOD);
    expect(await messageOf(sqlAs(qaReviewer, 'select recipe.run_pqr_extract($1, $2::date, null) as r', [p.product, FROM]))).toMatch(PERIOD);
    expect(await messageOf(run(qaReviewer, p.product, '2023-10-10', '2026-10-10'))).toBe('ok');
    expect(await messageOf(run(qaReviewer, p.product, '2023-10-10', '2026-10-11'))).toMatch(/EBMR-PQR-003 a review period is at most three years/);
  });

  it('[PR-58] an unknown query version is refused for what it is; an installed version other than 1 is not runnable here', async () => {
    expect(await messageOf(db.admin.query("select recipe.pqr_run_query(99, 'X', current_date, current_date)"))).toMatch(/EBMR-PQR-004 there is no PQR query version 99/);
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      await c.query("set local session_replication_role = 'replica'");
      await c.query('create temp table pqr_v2 on commit drop as select * from recipe.pqr_query_version where version = 1');
      // Version 2 is installed and runnable since recipe-core 1062 (PR-09); an installed version 3 is not.
      await c.query(`update pqr_v2 set version = 3, query_function = 'recipe.pqr_result_sha256(jsonb)',
                       definition_sha256 = encode(sha256(convert_to(pg_get_functiondef('recipe.pqr_result_sha256(jsonb)'::regprocedure), 'UTF8')), 'hex')`);
      await c.query('insert into recipe.pqr_query_version select * from pqr_v2');
      expect(await messageOf(c.query("select recipe.pqr_run_query(3, 'X', current_date, current_date)"))).toMatch(/EBMR-PQR-004 PQR query version 3 is not runnable here/);
    } finally {
      await c.query('rollback');
      c.release();
    }
  });

  it('[PR-58] an unknown extract neither reproduces nor involves anyone, whatever extracts exist', async () => {
    await run(qaReviewer, p.product);
    const r = (await db.app.query<{ r: boolean | null; i: string[] }>('select recipe.pqr_reproduces($1) as r, recipe.pqr_involvement($1) as i', [randomUUID()])).rows[0]!;
    expect(r).toEqual({ r: null, i: [] });
  });

  it('[IN-01] an unknown extract is not signed off; the sign-off of an extract is neither held by a lock on another extract nor refused by another\'s sign-off', async () => {
    expect(await messageOf(w.run(ap, (c) => c.query('select recipe.sign_off_pqr($1, $2)', [randomUUID(), randomUUID()])))).toMatch(/EBMR-PQR-010 there is no PQR extract/);
    const a = await run(qaReviewer, p.product);
    const other = await run(qaReviewer, p.product, TODAY, TODAY);
    // Another extract signed off (a TEST FIXTURE row written with triggers off) and held locked by another transaction.
    const fixture = await db.admin.connect();
    try {
      await fixture.query('begin');
      await fixture.query("set local session_replication_role = 'replica'");
      await fixture.query(`insert into recipe.pqr_signoff (extract_id, result_sha256, signature_id, content_hash, person_id, account_id, role_code, correlation_id)
                           select id, result_sha256, gen_random_uuid(), repeat('0', 64), gen_random_uuid(), gen_random_uuid(), 'AUTHORISED_PERSON', gen_random_uuid()
                             from recipe.pqr_extract where id = $1`, [other]);
      await fixture.query('commit');
    } finally {
      fixture.release();
    }
    const holder = await db.admin.connect();
    try {
      await holder.query('begin');
      await holder.query('select 1 from recipe.pqr_extract where id = $1 for update', [other]);
      const refused = await messageOf(w.run(ap, async (c) => {
        await c.query("set local lock_timeout = '5s'");
        return c.query('select recipe.sign_off_pqr($1, $2)', [a, randomUUID()]);
      }));
      // Refused for its (unknown) signature, after the extract was locked, found not signed off, reproduced and reconciled.
      expect(refused).not.toMatch(/lock timeout|EBMR-PQR-01[0-2]|EBMR-PQR-006/);
      expect(refused).toMatch(/EBMR-/);
    } finally {
      await holder.query('rollback');
      holder.release();
    }
    // The extract signed off already is refused as such.
    expect(await messageOf(w.run(ap, (c) => c.query('select recipe.sign_off_pqr($1, $2)', [other, randomUUID()])))).toMatch(/EBMR-PQR-011 this extract is signed off already/);
  });

  it('[IN-01] [INV-35] a signer who became involved in a reviewed batch after signing does not record the sign-off', async () => {
    const id = await run(qaReviewer, p.product);
    const sig = await signFor(db, ap, { type: 'pqr_extract', id }, 'PQR_SIGNED_OFF', 'EXTRACTED');
    // TEST FIXTURE: a line clearance of the reviewed batch performed by the AP after signing (superuser, triggers off): the
    // extract and its signed content are unchanged, the AP is now involved in the batch's record.
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      await c.query("set local session_replication_role = 'replica'");
      await c.query(`insert into plant.clearance (area_id, clearance_type, next_batch_id, next_product, next_batch, performed_by, performed_account, recorded_result)
                     values (gen_random_uuid(), 'PRODUCT_CHANGE', $1, $2, 'B', $3, $4, 'PASSED')`, [pBatch, p.product, ap.personId, ap.accountId]);
      await c.query('commit');
    } finally {
      c.release();
    }
    expect((await db.app.query<{ i: string[] }>('select recipe.pqr_involvement($1) as i', [id])).rows[0]!.i).toContain(ap.personId);
    expect(await messageOf(w.run(ap, (x) => x.query('select recipe.sign_off_pqr($1, $2)', [id, sig])))).toMatch(/EBMR-PQR-014 a person involved in the records of the reviewed batches never signs off/);
  });

  it('[IN-01] a PQR is signed off as the authorised person: a signature made in another role, even one granted the sign-off permission, is refused', async () => {
    const id = await run(qaReviewer, p.product, TODAY, TODAY);
    // TEST FIXTURE: the sign-off permission granted to QA_REVIEWER, written as the database owner with triggers off.
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      await c.query("set local session_replication_role = 'replica'");
      await c.query("insert into iam.role_permission (role_code, permission_code) values ('QA_REVIEWER', 'PQR.SIGN_OFF') on conflict do nothing");
      await c.query('commit');
    } finally {
      c.release();
    }
    const refused = await messageOf(signed(qaReviewer3, 'pqr_extract', id, 'PQR_SIGNED_OFF', 'EXTRACTED', (x, sig) => x.query('select recipe.sign_off_pqr($1, $2)', [id, sig])));
    expect(refused).toMatch(/EBMR-PQR-013 a PQR is signed off by the authorised person, not as QA_REVIEWER/);
  });
});
