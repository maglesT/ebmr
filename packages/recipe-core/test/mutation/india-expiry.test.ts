/**
 * Expiry dating at its edges (SQL mutation group "india-expiry": recipe-core 0893; decision 0012). These tests close the
 * gaps the Phase 4 focused mutation run found in test/release/india.test.ts: a planned batch not yet issued has no shelf
 * life and no expiry; a shelf life of one month; the expiry of one batch among several; and the cap a recovered input
 * puts on the expiry, at the cap equal to the month end (not capped) and one day earlier (capped). A recovered input is a
 * TEST FIXTURE row of recipe.source_addition written by the superuser with triggers off.
 *
 * Controls: PR-43 (expiry from the database), IN-19 (b) (expiry capped by recovered inputs).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withProtectedNumbers } from '../../../kernel/src/continuity/numbers.ts';
import { tempDir, tempLedger } from '../../../kernel/test/continuity/helpers.ts';
import { cmd } from '../../../kernel/test/esig/helpers.ts';
import { seedActor, seedServiceActor, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { approveTestRelease } from '../../../kernel/test/support/validation.ts';
import * as execution from '../../src/execution/index.ts';
import type { MbrContent } from '../../src/flow/model.ts';
import type * as lc from '../../src/lifecycle/index.ts';
import { define, FIXTURE_INPUTS, FIXTURE_JUSTIFICATIONS } from '../engine/support.ts';
import { gmpOrderFor } from '../lifecycle/gmp-support.ts';
import { cell, reason, seedCast, uniqueContent, World } from '../lifecycle/support.ts';

let db: TestDatabase;
let w: World;
let steward: SeededActor;
let erp: SeededActor;
const dir = tempDir('expiry-mutation');
const ledger = tempLedger('expiry-mutation', dir.path);

const SITE = 'SITE-1';
const BS = 'BS-200K';
const FIXTURE = 'tablet-granulation-compression';

function without(content: unknown, types: readonly string[]): unknown {
  if (Array.isArray(content)) {
    return content.filter((x) => !(x && typeof x === 'object' && types.includes(String(((x as Record<string, unknown>)['block'] as Record<string, unknown> | undefined)?.['type'])))).map((x) => without(x, types));
  }
  if (content && typeof content === 'object') return Object.fromEntries(Object.entries(content).map(([k, v]) => [k, without(v, types)]));
  return content;
}

type Master = { familyId: string; content: MbrContent; product: string; strength: string };
async function effective(): Promise<Master> {
  const m = uniqueContent(FIXTURE, ['EU', 'IN', 'US']);
  m.header.product = { ...m.header.product, code: m.header.product.code.toUpperCase() };
  const content = without(m, ['G-09', 'G-10']) as MbrContent;
  const v = await w.approvedVersion(content);
  const def: lc.MarketAuthorisationDefinition = { versionId: v.versionId, market: 'IN', kind: 'CURRENT', cells: [cell(SITE, 'L1', BS)], regulatoryBasis: 'IN: registration on file' };
  await w.authorise(def);
  await w.run(steward, (c) =>
    c.query('select site.define_batch_number_rule($1::jsonb)', [
      JSON.stringify({ rule_code: `R-${randomUUID().slice(0, 8).toUpperCase()}`, site_code: SITE, product_code: content.header.product.code, batch_kind: 'PROCESSING', format: 'X{YY}{SEQ:5}', site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3' }),
    ]),
  );
  const f = (await db.app.query<{ s: string }>('select strength as s from recipe.mbr_family where id = $1', [v.familyId])).rows[0]!.s;
  return { familyId: v.familyId, content, product: content.header.product.code, strength: f };
}

/** The ERP posts the product master of `m` with `months` of shelf life and QA confirms it (site services 0802). */
async function productMaster(m: Master, months: number): Promise<void> {
  const id = await w.run(erp, async (c) => (await c.query<{ r: string }>('select site.erp_receive_product($1::jsonb) as r', [
    JSON.stringify({ productCode: m.product, strength: m.strength, productName: `Product ${m.product}`, betaLactam: false, shelfLifeMonths: months, erpReference: `ERP-${m.product}-${months}` }),
  ])).rows[0]!.r);
  const state = (await db.app.query<{ s: string }>("select site.erp_master_state('PRODUCT', $1) as s", [id])).rows[0]!.s;
  if (state === 'PENDING') {
    const sig = await w.sign(w.cast.qa2, 'erp_master', `PRODUCT/${id}`, 'ERP_MASTER_CONFIRMED', 'PENDING');
    await w.run(w.cast.qa2, (c) => c.query("select site.confirm_erp_master('PRODUCT', $1, $2)", [id, sig]));
  }
}

async function plan(m: Master): Promise<string> {
  const batchId = randomUUID();
  const erpOrder = await gmpOrderFor(db, erp, m.content, BS);
  await cmd(db, w.cast.issuer).then((ctx) =>
    withProtectedNumbers(db.app, ctx, ledger, (c) => execution.prepareGmpIssue(c, batchId, { familyId: m.familyId, markets: ['IN'], site: SITE, line: 'L1', batchSize: BS, erpOrder })),
  );
  return batchId;
}

async function issue(batchId: string): Promise<void> {
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
}

/** TEST FIXTURE: a recovered input of batch `b` whose own expiry is `expiry` (superuser, triggers off). */
async function recoveredInput(b: string, expiry: string, entry: string): Promise<void> {
  const c = await db.admin.connect();
  try {
    await c.query('begin');
    await c.query("set local session_replication_role = 'replica'");
    await c.query(
      `insert into recipe.source_addition (batch_id, batch_number, step_key, entry_id, block, container_id, case_code, net_quantity, unit, source_batch_id, source_batch_number,
                                           product_code, strength, source_generated_at, source_manufactured_at, source_expiry, added_by_person, recorded_at)
       values ($1, 'X', 's@', $3, 'G-24@2', gen_random_uuid(), 'RECOVERY', 1, 'kg', gen_random_uuid(), 'S-1', 'P', '1 mg', now(), now(), $2::date, gen_random_uuid(), now())`,
      [b, expiry, entry],
    );
    await c.query('commit');
  } finally {
    c.release();
  }
}

interface Expiry {
  manufactureDate: string;
  expiryDate: string;
  capped: boolean;
}
const expiryOf = async (b: string): Promise<Expiry | null> => (await db.app.query<{ e: Expiry | null }>('select recipe.batch_expiry($1) as e', [b])).rows[0]?.e ?? null;

let m: Master;
beforeAll(async () => {
  db = await createTestDatabase();
  // Slice 7c (DI-03, recipe-core 1250): a GMP batch is issued only on a release with an approved validation summary.
  await approveTestRelease(db);
  w = new World(db, await seedCast(db));
  steward = await seedActor(db, { roleCode: 'MASTER_DATA_STEWARD', legalName: 'Mira Steward' });
  erp = await seedServiceActor(db, { kind: 'INTEGRATION', source: 'INTEGRATION', roleCode: 'ERP_INTERFACE', name: 'ERP interface' });
  m = await effective();
  await productMaster(m, 1);
}, 900_000);
afterAll(async () => {
  await db.drop();
  dir.cleanup();
});

describe('the shelf life and expiry of a batch (recipe-core 0893)', () => {
  it('[PR-43] a batch planned but not issued has no shelf life and no expiry yet, though its product has a master', async () => {
    const planned = await plan(m);
    const r = (await db.app.query<{ s: unknown; e: unknown }>('select recipe.batch_shelf_life($1) as s, recipe.batch_expiry($1) as e', [planned])).rows[0]!;
    expect(r).toEqual({ s: null, e: null });
  });

  it('[PR-43] [IN-19] a shelf life of one month counts: the batch expires at the end of its month of manufacture, and the expiry of a source batch is its own', async () => {
    const b = await plan(m);
    await issue(b);
    const e = (await expiryOf(b))!;
    const monthEnd = (await db.app.query<{ d: string }>("select to_char((date_trunc('month', $1::date) + interval '1 month')::date - 1, 'YYYY-MM-DD') as d", [e.manufactureDate])).rows[0]!.d;
    expect(e).toMatchObject({ expiryDate: monthEnd, capped: false });
    const source = async (id: string): Promise<string | null> =>
      (await db.admin.query<{ d: string | null }>("select to_char(recipe.source_batch_expiry($1), 'YYYY-MM-DD') as d", [id])).rows[0]?.d ?? null;
    expect(await source(b)).toBe(`${e.manufactureDate.slice(0, 7)}-01`);
    expect(await source(randomUUID())).toBeNull();
  });

  it('[IN-19] a recovered input caps the expiry only when it expires before the month end: at the month end the batch is not capped', async () => {
    const b = await plan(m);
    await issue(b);
    const e = (await expiryOf(b))!;
    await recoveredInput(b, e.expiryDate, 'EN-1');
    expect(await expiryOf(b)).toMatchObject({ expiryDate: e.expiryDate, capped: false });
    const dayBefore = (await db.app.query<{ d: string }>("select to_char($1::date - 1, 'YYYY-MM-DD') as d", [e.expiryDate])).rows[0]!.d;
    await recoveredInput(b, dayBefore, 'EN-2');
    expect(await expiryOf(b)).toMatchObject({ expiryDate: dayBefore, capped: true });
  });
});
