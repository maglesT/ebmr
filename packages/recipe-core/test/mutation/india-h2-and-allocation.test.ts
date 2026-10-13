/**
 * The India label particulars, the Schedule H2 payload stub and the allocation register at their edges (SQL mutation
 * group "india-h2-and-allocation": recipe-core 0894, 0913; decision 0012). These tests close the gaps the Phase 4
 * focused mutation run found in test/release/india.test.ts: a planned batch or a sandbox batch has no label particulars;
 * a batch without its own licence basis takes its packaging parent's, never another batch's; each value the payload
 * cannot carry (none, not printable, a ; or =); a payload never issued although an earlier one of the batch was; an
 * unknown batch; and one register entry per allocation. Altered records are TEST FIXTURES written by the superuser with
 * triggers off in a transaction that is always rolled back, and read in that transaction.
 *
 * Controls: IN-31 (label particulars and H2 payload from the record), IN-30 (licence basis), IN-18 (allocation register).
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withProtectedNumbers } from '../../../kernel/src/continuity/numbers.ts';
import { withCommand } from '../../../kernel/src/db/command.ts';
import { tempDir, tempLedger } from '../../../kernel/test/continuity/helpers.ts';
import { cmd } from '../../../kernel/test/esig/helpers.ts';
import { seedActor, seedServiceActor, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
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
let operator: SeededActor;
const dir = tempDir('h2-mutation');
const ledger = tempLedger('h2-mutation', dir.path);

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
      JSON.stringify({ rule_code: `R-${randomUUID().slice(0, 8).toUpperCase()}`, site_code: SITE, product_code: content.header.product.code, batch_kind: 'PROCESSING', format: 'H{YY}{SEQ:5}', site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3' }),
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


/** Runs `read` in a superuser transaction after `arrange` (triggers off), then rolls everything back. */
async function inFixture<T>(arrange: string[], params: unknown[], read: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db.admin.connect();
  try {
    await c.query('begin');
    await c.query("set local session_replication_role = 'replica'");
    for (const sql of arrange) {
      const used = Math.max(0, ...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
      await c.query(sql, params.slice(0, used));
    }
    await c.query("set local session_replication_role = 'origin'");
    return await read(c);
  } finally {
    await c.query('rollback');
    c.release();
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
const particulars = (c: pg.PoolClient, b: string): Promise<{ manufacturer: { licenceNumber: string } }> =>
  c.query<{ p: { manufacturer: { licenceNumber: string } } }>('select recipe.india_label_particulars($1) as p', [b]).then((r) => r.rows[0]!.p);
const payloadOf = (c: pg.PoolClient, b: string): Promise<string | null> => c.query<{ p: string | null }>('select recipe.h2_payload($1) as p', [b]).then((r) => r.rows[0]!.p);

let a: Master;
let x: string;
let y: string;
let z: string;
let planned: string;
beforeAll(async () => {
  db = await createTestDatabase();
  w = new World(db, await seedCast(db));
  steward = await seedActor(db, { roleCode: 'MASTER_DATA_STEWARD', legalName: 'Mira Steward' });
  operator = await seedActor(db, { roleCode: 'OPERATOR', legalName: 'Om Operator', roomCode: 'DISP-01' });
  erp = await seedServiceActor(db, { kind: 'INTEGRATION', source: 'INTEGRATION', roleCode: 'ERP_INTERFACE', name: 'ERP interface' });
  a = await effective();
  await productMaster(a, 24);
  x = await plan(a);
  await issue(x);
  y = await plan(a);
  await issue(y);
  planned = await plan(a);
  const other = await effective();
  await productMaster(other, 24);
  z = await plan(other);
  await issue(z);
}, 900_000);
afterAll(async () => {
  await db.drop();
  dir.cleanup();
});

describe('the label particulars of a batch (recipe-core 0894, recipe.india_label_particulars)', () => {
  it('[IN-31] a batch planned but not issued, or a batch of the sandbox, has no label particulars', async () => {
    const NONE = /EBMR-IND-050 .* is no issued GMP batch, so it has no label particulars/;
    expect(await messageOf(db.app.query('select recipe.india_label_particulars($1)', [planned]))).toMatch(NONE);
    expect(await messageOf(inFixture(["update recipe.batch_execution set installation = 'SANDBOX', purpose = 'SANDBOX_TEST_RUN', package_hash = repeat('a', 64), control_recipe_id = null, issue_signature_id = null where id = $1"], [x], (c) => particulars(c, x)))).toMatch(NONE);
  });

  it('[IN-31] [IN-30] a batch without a licence basis of its own takes its packaging parent\'s, never another batch\'s; without either it has no particulars', async () => {
    const own = await inFixture([], [], (c) => particulars(c, y));
    const otherLicence = await inFixture([], [], (c) => particulars(c, z));
    expect(otherLicence.manufacturer.licenceNumber).not.toBe(own.manufacturer.licenceNumber);
    const viaParent = await inFixture(
      ['delete from recipe.batch_licence_basis where batch_id = $1',
       `update site.batch_number_allocation set batch_kind = 'PACKAGING', parent_allocation_id = (select allocation_id from recipe.batch_allocation_link where batch_id = $2)
         where id = (select allocation_id from recipe.batch_allocation_link where batch_id = $1)`],
      [x, y], (c) => particulars(c, x));
    expect(viaParent.manufacturer.licenceNumber).toBe(own.manufacturer.licenceNumber);
    expect(await messageOf(inFixture(['delete from recipe.batch_licence_basis where batch_id = $1'], [x], (c) => particulars(c, x))))
      .toMatch(/EBMR-IND-050 batch .* carries no licence recorded at its issue/);
  });
});

describe('the H2 payload (recipe-core 0894, recipe.h2_payload, recipe.h2_payload_problem)', () => {
  it('[IN-31] a value the payload cannot carry is refused: none, one that is not printable text, one with ; or =', async () => {
    const CANNOT = (key: string) => new RegExp(`EBMR-IND-051 the H2 payload of batch .* cannot carry ${key}`);
    expect(await messageOf(inFixture(["update recipe.batch_licence_basis set basis = basis - 'holderName' where batch_id = $1"], [x], (c) => payloadOf(c, x)))).toMatch(CANNOT('MFR'));
    expect(await messageOf(inFixture(["update recipe.batch_licence_basis set licence_number = 'MFG;25' where batch_id = $1"], [x], (c) => payloadOf(c, x)))).toMatch(CANNOT('LIC'));
    expect(await messageOf(inFixture(["update recipe.batch_licence_basis set licence_number = 'MFG=25' where batch_id = $1"], [x], (c) => payloadOf(c, x)))).toMatch(CANNOT('LIC'));
    expect(await messageOf(inFixture(["update recipe.batch_licence_basis set licence_number = E'MFG\\t25' where batch_id = $1"], [x], (c) => payloadOf(c, x)))).toMatch(CANNOT('LIC'));
    expect(await messageOf(inFixture(["update recipe.batch_licence_basis set licence_number = 'MFG-25-é' where batch_id = $1"], [x], (c) => payloadOf(c, x)))).toMatch(CANNOT('LIC'));
  });

  it('[IN-31] an unknown batch has no payload; a payload computed now that was never issued fails although an earlier payload of the batch was issued', async () => {
    expect((await db.app.query<{ p: string | null }>('select recipe.h2_payload_problem($1, $2) as p', [randomUUID(), 'V=H2-STUB-1'])).rows[0]!.p).toMatch(/is no batch of this installation/);
    await w.run(operator, (c) => c.query('select recipe.issue_h2_payload($1)', [y]));
    const problem = await inFixture(["update recipe.batch_licence_basis set licence_number = 'MFG-25-RENEWED' where batch_id = $1"], [y], async (c) => {
      const now = (await payloadOf(c, y))!;
      return (await c.query<{ p: string | null }>('select recipe.h2_payload_problem($1, $2) as p', [y, now])).rows[0]!.p;
    });
    expect(problem).toMatch(/the payload of batch .* was never issued for printing/);
  });
});

describe('the allocation register (recipe-core 0913, recipe.allocation_register)', () => {
  it('[IN-18] the register has one entry per allocation; a processing batch has no parent batch number', async () => {
    const register = (await w.run(w.cast.qa, (c) => c.query<{ r: Record<string, unknown>[] }>('select recipe.allocation_register($1) as r', [SITE]))).rows[0]!.r;
    const ids = register.map((e) => e['allocationId']);
    expect(new Set(ids).size).toBe(ids.length);
    const count = (await db.admin.query<{ n: number }>("select count(*)::int as n from site.batch_number_allocation where site_code = $1", [SITE])).rows[0]!.n;
    expect(ids.length).toBe(count);
    expect(register.find((e) => e['batchId'] === x)).toMatchObject({ parentBatchNumber: null, use: 'ISSUED' });
  });

  it('[IN-18] a packaging allocation names its own parent\'s batch number and appears once', async () => {
    // TEST FIXTURE: x's allocation made the packaging allocation of y's (superuser, triggers off), read and rolled back.
    const ROLLBACK = new Error('rollback the fixture');
    let register: Record<string, unknown>[] = [];
    await withCommand(db.admin, await cmd(db, w.cast.qa), async (c) => {
      await c.query("set local session_replication_role = 'replica'");
      await c.query(`update site.batch_number_allocation set batch_kind = 'PACKAGING', parent_allocation_id = (select allocation_id from recipe.batch_allocation_link where batch_id = $2)
                      where id = (select allocation_id from recipe.batch_allocation_link where batch_id = $1)`, [x, y]);
      await c.query("set local session_replication_role = 'origin'");
      register = (await c.query<{ r: Record<string, unknown>[] }>('select recipe.allocation_register($1) as r', [SITE])).rows[0]!.r;
      throw ROLLBACK;
    }).catch((e: unknown) => {
      if (e !== ROLLBACK) throw e;
    });
    const ids = register.map((e) => e['allocationId']);
    expect(new Set(ids).size).toBe(ids.length);
    const parent = register.find((e) => e['batchId'] === y)!;
    expect(register.find((e) => e['batchId'] === x)).toMatchObject({ kind: 'PACKAGING', parentBatchNumber: parent['batchNumber'] });
  });

  it('[IN-18] a period includes an allocation made at its first instant and excludes one made at its end', async () => {
    const at = (await db.admin.query<{ t: string }>('select a.recorded_at::text as t from site.batch_number_allocation a join recipe.batch_allocation_link l on l.allocation_id = a.id where l.batch_id = $1', [x])).rows[0]!.t;
    const ofPeriod = async (from: string | null, to: string | null): Promise<unknown[]> =>
      (await w.run(w.cast.qa, (c) => c.query<{ r: Record<string, unknown>[] }>('select recipe.allocation_register($1, $2::timestamptz, $3::timestamptz) as r', [SITE, from, to]))).rows[0]!.r.map((e) => e['batchId']);
    expect(await ofPeriod(at, null)).toContain(x);
    expect(await ofPeriod(null, at)).not.toContain(x);
  });
});
