/**
 * Phase 3 slice 4a (D-S4-2; recipe-core 0582): a packaging order is a GMP batch of record kind PACKAGING, issued like a
 * processing batch, whose number the site's register allocates as a PACKAGING number of the issued processing batch it
 * packs. Every call is made as the application role through the definer functions, with the bypass attempts the role has.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withProtectedNumbers } from '../../../kernel/src/continuity/numbers.ts';
import { tempDir, tempLedger } from '../../../kernel/test/continuity/helpers.ts';
import { cmd } from '../../../kernel/test/esig/helpers.ts';
import { seedActor, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import type { MbrContent } from '../../src/flow/model.ts';
import * as execution from '../../src/execution/index.ts';
import type * as lc from '../../src/lifecycle/index.ts';
import { define, FIXTURE_INPUTS, FIXTURE_JUSTIFICATIONS } from '../engine/support.ts';
import { cell, reason, seedCast, uniqueContent, World } from './support.ts';

let db: TestDatabase;
let w: World;
let steward: SeededActor;
const dir = tempDir('packaging-issue');
const ledger = tempLedger('packaging-issue', dir.path);

beforeAll(async () => {
  db = await createTestDatabase();
  w = new World(db, await seedCast(db));
  steward = await seedActor(db, { roleCode: 'MASTER_DATA_STEWARD', legalName: 'Mira Steward' });
}, 300_000);

afterAll(async () => {
  await db.drop();
  dir.cleanup();
});

const SITE = 'SITE-1';
type Json = Record<string, unknown>;
type Fixture = 'tablet-granulation-compression' | 'tablet-blister-packaging';
const SIZE: Record<Fixture, string> = { 'tablet-granulation-compression': 'BS-200K', 'tablet-blister-packaging': 'PO-20K' };
const q = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, params)).rows as T[];

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

/** An effective master of `name` for IN at SITE-1/L1 with a numbering rule of its kind; the product given or its own. */
async function master(name: Fixture, product?: string): Promise<{ familyId: string; product: string }> {
  const m = uniqueContent(name, ['IN']);
  m.header.product = { ...m.header.product, code: (product ?? m.header.product.code).toUpperCase() };
  const content = without(m, ['G-09', 'G-10']) as MbrContent;
  const v = await w.approvedVersion(content);
  const def: lc.MarketAuthorisationDefinition = { versionId: v.versionId, market: 'IN', kind: 'CURRENT', cells: [cell(SITE, 'L1', SIZE[name])], regulatoryBasis: 'IN: registration on file' };
  await w.authorise(def);
  const kind = name === 'tablet-blister-packaging' ? 'PACKAGING' : 'PROCESSING';
  await w.run(steward, (c) =>
    c.query('select site.define_batch_number_rule($1::jsonb)', [
      JSON.stringify({
        rule_code: `R-${randomUUID().slice(0, 8).toUpperCase()}`, site_code: SITE, product_code: content.header.product.code, batch_kind: kind,
        format: kind === 'PACKAGING' ? '{PARENT}/P{SEQ:2}' : 'G{YY}{SEQ:5}', site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3',
      }),
    ]),
  );
  return { familyId: v.familyId, product: content.header.product.code };
}

async function plan(batchId: string, def: Partial<execution.GmpBatchPlan> & { familyId: string; batchSize: string }): Promise<execution.PlannedGmpBatch> {
  return withProtectedNumbers(db.app, await cmd(db, w.cast.issuer), ledger, (c) => execution.prepareGmpIssue(c, batchId, { markets: ['IN'], site: SITE, line: 'L1', ...def }));
}

async function issue(batchId: string, name: Fixture): Promise<void> {
  const signatureId = await w.sign(w.cast.issuer, 'batch_issue', batchId, 'ISSUED', 'PLANNED');
  await w.run(
    w.cast.issuer,
    (c) =>
      execution.issueGmpBatch(c, {
        batchId,
        signatureId,
        define: (content) => define(content, { installation: 'GMP', justifications: FIXTURE_JUSTIFICATIONS }),
        request: {
          inputs: FIXTURE_INPUTS[name],
          ...(name === 'tablet-blister-packaging' ? { variants: { packDestination: 'IN-DOMESTIC' } } : {}),
          issuedBy: { id: w.cast.issuer.personId, kind: 'PERSON', roles: [] },
        },
      }),
    reason('batch issued for the test'),
  );
}

describe('packaging orders as GMP batches (D-S4-2; recipe-core 0582)', () => {
  it('[INV-27][IN-18][IN-16] a packaging order is planned with the issued processing batch it packs: its number is the register\'s PACKAGING number of that batch, linked once, and it is issued like any GMP batch', async () => {
    const proc = await master('tablet-granulation-compression');
    const pack = await master('tablet-blister-packaging', proc.product);
    const parent = randomUUID();
    const p = await plan(parent, { familyId: proc.familyId, batchSize: SIZE['tablet-granulation-compression'] });
    await issue(parent, 'tablet-granulation-compression');
    const order = randomUUID();
    const planned = await plan(order, { familyId: pack.familyId, batchSize: SIZE['tablet-blister-packaging'], parentBatch: parent });
    expect(planned.batchNumber).toBe(`${p.batchNumber}/P01`);
    const [a] = await q<Json>(
      `select a.batch_kind, pa.batch_number as parent from site.batch_number_allocation a join site.batch_number_allocation pa on pa.id = a.parent_allocation_id where a.id = $1`,
      [planned.allocationId],
    );
    expect(a).toEqual({ batch_kind: 'PACKAGING', parent: p.batchNumber });
    await issue(order, 'tablet-blister-packaging');
    expect(await q<Json>('select purpose, batch_number from recipe.batch_execution where id = $1', [order])).toEqual([{ purpose: 'GMP_BATCH', batch_number: planned.batchNumber }]);
  });

  it('[INV-27][IN-18] a packaging order without its processing batch, of a batch not issued or cancelled, of another product, or a processing batch naming a parent, is refused; a packaging number of another batch is never taken; the role cannot link a number directly', async () => {
    const proc = await master('tablet-granulation-compression');
    const pack = await master('tablet-blister-packaging', proc.product);
    const other = await master('tablet-granulation-compression');
    const parent = randomUUID();
    const pp = await plan(parent, { familyId: proc.familyId, batchSize: SIZE['tablet-granulation-compression'] });
    await issue(parent, 'tablet-granulation-compression');
    const planned = randomUUID();
    await plan(planned, { familyId: proc.familyId, batchSize: SIZE['tablet-granulation-compression'] });
    const foreign = randomUUID();
    await plan(foreign, { familyId: other.familyId, batchSize: SIZE['tablet-granulation-compression'] });
    await issue(foreign, 'tablet-granulation-compression');
    const packSize = SIZE['tablet-blister-packaging'];
    expect({
      noParent: await codeOf(plan(randomUUID(), { familyId: pack.familyId, batchSize: packSize })),
      notIssued: await codeOf(plan(randomUUID(), { familyId: pack.familyId, batchSize: packSize, parentBatch: planned })),
      unknown: await codeOf(plan(randomUUID(), { familyId: pack.familyId, batchSize: packSize, parentBatch: randomUUID() })),
      otherProduct: await codeOf(plan(randomUUID(), { familyId: pack.familyId, batchSize: packSize, parentBatch: foreign })),
      processingWithParent: await codeOf(plan(randomUUID(), { familyId: proc.familyId, batchSize: SIZE['tablet-granulation-compression'], parentBatch: parent })),
    }).toEqual({ noParent: 'EBMR-EXE-198', notIssued: 'EBMR-EXE-198', unknown: 'EBMR-EXE-198', otherProduct: 'EBMR-EXE-198', processingWithParent: 'EBMR-EXE-198' });
    // A packaging number of this batch, allocated ahead, is taken by its own order; one of the planned (never issued)
    // processing number is refused even when the order names the issued batch (the allocationId path of 0501).
    const plannedNumber = (await q<{ n: string }>('select batch_number as n from recipe.stub_batch where id = $1', [planned]))[0]?.n;
    const ahead = async (parentNumber: string): Promise<string> =>
      withProtectedNumbers(db.app, await cmd(db, w.cast.issuer), ledger, async (c) =>
        (await c.query<{ id: string }>(
          `select allocation_id::text as id from site.allocate_batch_number($1::jsonb)`,
          [JSON.stringify({ site_code: SITE, product_code: proc.product, product_name: 'Atorvastatin calcium tablets', edition: 'TABLETS', batch_kind: 'PACKAGING', batch_size: '20000', batch_size_unit: '{tbl}', parent_batch_number: parentNumber })],
        )).rows[0]?.id ?? '');
    const wrongParent = await ahead(plannedNumber ?? '');
    expect(await codeOf(plan(randomUUID(), { familyId: pack.familyId, batchSize: packSize, parentBatch: parent, allocationId: wrongParent }))).toBe('EBMR-EXE-198');
    const own = await ahead(pp.batchNumber);
    const order = randomUUID();
    expect((await plan(order, { familyId: pack.familyId, batchSize: packSize, parentBatch: parent, allocationId: own })).allocationId).toBe(own);
    // Review 4a LOW 8: a cancelled processing batch is never packed (arranged: the batch's state set cancelled).
    const cancelled = randomUUID();
    await plan(cancelled, { familyId: proc.familyId, batchSize: SIZE['tablet-granulation-compression'] });
    await issue(cancelled, 'tablet-granulation-compression');
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      await c.query("set local session_replication_role = 'replica'");
      await c.query("update recipe.execution_state set state = jsonb_set(state, '{status}', '\"CANCELLED\"') where batch_id = $1", [cancelled]);
      await c.query('commit');
    } finally {
      c.release();
    }
    expect(await codeOf(plan(randomUUID(), { familyId: pack.familyId, batchSize: packSize, parentBatch: cancelled }))).toBe('EBMR-EXE-198');
    // Bypass: the application role cannot link a number itself.
    await expect(db.app.query('insert into recipe.batch_allocation_link (batch_id, allocation_id, batch_number, person_id, account_id, correlation_id) values ($1, $2, $3, $1, $1, $1)', [randomUUID(), wrongParent, 'X'])).rejects.toThrow(/permission denied/);
  });
});
