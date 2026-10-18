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
import { seedActor, seedServiceActor, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { approveTestRelease } from '../../../kernel/test/support/validation.ts';
import type { MbrContent } from '../../src/flow/model.ts';
import * as containers from '../../src/containers/index.ts';
import * as execution from '../../src/execution/index.ts';
import * as lc from '../../src/lifecycle/index.ts';
import type { BlockVersion } from '../../src/blocks/contract.ts';
import { define, FIXTURE_INPUTS, FIXTURE_JUSTIFICATIONS, testRegistry } from '../engine/support.ts';
import { familyOrder } from './gmp-support.ts';
import { cell, reason, seedCast, uniqueContent, World } from './support.ts';

let db: TestDatabase;
let w: World;
let steward: SeededActor;
let erp: SeededActor;
const dir = tempDir('packaging-issue');
const ledger = tempLedger('packaging-issue', dir.path);

beforeAll(async () => {
  db = await createTestDatabase();
  // Slice 7c (DI-03, recipe-core 1250): a GMP batch is issued only on a release with an approved validation summary.
  await approveTestRelease(db);
  w = new World(db, await seedCast(db));
  steward = await seedActor(db, { roleCode: 'MASTER_DATA_STEWARD', legalName: 'Mira Steward' });
  erp = await seedServiceActor(db, { kind: 'INTEGRATION', source: 'INTEGRATION', roleCode: 'ERP_INTERFACE', name: 'ERP interface' });
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

/**
 * TEST STAND-IN for the tablets edition's TB-24 (secondary packaging), which recipe-core does not hold: G-16's version
 * under the type TB-24. A packaging order is planned only on a master with its edition's completion block (recipe-core
 * 0761, Phase 4 slice 2c), so the packaging masters here carry one such step.
 */
const TB24_STAND_IN: BlockVersion = (() => {
  const g = testRegistry().get('G-16', '1');
  if (!g) throw new Error('G-16 version 1 is not registered');
  return { ...g, type: 'TB-24', edition: 'tablets', title: 'TEST STAND-IN: secondary packaging (TB-24)' };
})();
const registry = testRegistry().extend(TB24_STAND_IN);

/** The packaging fixture with a secondary-packaging (TB-24 stand-in) step after its blister line check. */
function withSecondaryPacking(content: unknown): unknown {
  const c = JSON.parse(JSON.stringify(content)) as unknown;
  let done = false;
  const walk = (n: unknown): void => {
    if (done) return;
    if (Array.isArray(n)) {
      const i = n.findIndex((x) => (x as Json | null)?.['id'] === 'p-line-check');
      if (i >= 0) {
        n.splice(i + 1, 0, { ...(n[i] as Json), id: 'p-tb24-standin', name: 'Secondary packaging (stand-in)', block: { type: 'TB-24', version: '1' }, records: [] });
        done = true;
        return;
      }
      n.forEach(walk);
    } else if (n && typeof n === 'object') Object.values(n).forEach(walk);
  };
  walk(c);
  if (!done) throw new Error('the packaging fixture has no line check step');
  return c;
}

/** An effective master of `name` for IN at SITE-1/L1 with a numbering rule of its kind; the product given or its own. */
async function master(name: Fixture, product?: string, opts: { secondaryPacking?: boolean; packType?: string; markets?: ('IN' | 'US' | 'EU')[]; packSize?: { id: string; count: string } } = {}): Promise<{ familyId: string; product: string; versionId: string }> {
  const m = uniqueContent(name, opts.markets ?? ['IN']);
  m.header.product = { ...m.header.product, code: (product ?? m.header.product.code).toUpperCase() };
  if (opts.packType) m.header.packType = opts.packType;
  if (opts.packSize) m.header.batchSizes = [{ id: opts.packSize.id, quantity: { value: opts.packSize.count, unit: '{tbl}' } }];
  const stripped = without(m, ['G-09', 'G-10']);
  const content = (name === 'tablet-blister-packaging' && opts.secondaryPacking !== false ? withSecondaryPacking(stripped) : stripped) as MbrContent;
  const v = await w.approvedVersion(content);
  for (const market of opts.markets ?? ['IN']) {
    const def: lc.MarketAuthorisationDefinition = { versionId: v.versionId, market, kind: 'CURRENT', cells: [cell(SITE, 'L1', opts.packSize?.id ?? SIZE[name])], regulatoryBasis: `${market}: registration on file` };
    await w.authorise(def);
  }
  const kind = name === 'tablet-blister-packaging' ? 'PACKAGING' : 'PROCESSING';
  await w.run(steward, (c) =>
    c.query('select site.define_batch_number_rule($1::jsonb)', [
      JSON.stringify({
        rule_code: `R-${randomUUID().slice(0, 8).toUpperCase()}`, site_code: SITE, product_code: content.header.product.code, batch_kind: kind,
        format: kind === 'PACKAGING' ? '{PARENT}/P{SEQ:2}' : 'G{YY}{SEQ:5}', site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3',
      }),
    ]),
  );
  return { familyId: v.familyId, product: content.header.product.code, versionId: v.versionId };
}

async function plan(batchId: string, def: Partial<execution.GmpBatchPlan> & { familyId: string; batchSize: string }): Promise<execution.PlannedGmpBatch> {
  const erpOrder = def.erpOrder ?? (await familyOrder(db, erp, def.familyId, def.batchSize));
  return withProtectedNumbers(db.app, await cmd(db, w.cast.issuer), ledger, (c) => execution.prepareGmpIssue(c, batchId, { markets: ['IN'], site: SITE, line: 'L1', ...def, erpOrder }));
}

async function issue(batchId: string, name: Fixture): Promise<void> {
  const signatureId = await w.sign(w.cast.issuer, 'batch_issue', batchId, 'ISSUED', 'PLANNED');
  await w.run(
    w.cast.issuer,
    (c) =>
      execution.issueGmpBatch(c, {
        batchId,
        signatureId,
        define: (content) => define(content, { installation: 'GMP', justifications: FIXTURE_JUSTIFICATIONS, registry }),
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

  it('[PR-01] a packaging order for a pack type with no approved packaging master is refused: the pack type\'s master only drafted, approved but not authorised for the market, or not listing the pack size; a processing master never plans a packaging order; the approved and authorised one plans', async () => {
    const proc = await master('tablet-granulation-compression');
    const parent = randomUUID();
    await plan(parent, { familyId: proc.familyId, batchSize: SIZE['tablet-granulation-compression'] });
    await issue(parent, 'tablet-granulation-compression');
    // Pack families of the same product differ here by pack size: the family identity (recipe-core 0110) holds no pack
    // type of its own (reported to the planner, slice 6c).
    const packContent = (count: string): MbrContent => {
      const m = uniqueContent('tablet-blister-packaging', ['IN']);
      m.header.product = { ...m.header.product, code: proc.product };
      m.header.batchSizes = m.header.batchSizes.map((b) => ({ ...b, quantity: { ...b.quantity, value: count } }));
      return without(m, ['G-09', 'G-10']) as MbrContent;
    };
    // A pack type (its own family: product, pack type, pack sizes) whose master is only a draft, and one approved but
    // with no market authorisation: neither is an approved packaging master an order can be planned on.
    const drafted = await w.newVersion(packContent('20001'));
    const unauthorised = await w.approvedVersion(packContent('20002'));
    const packSize = SIZE['tablet-blister-packaging'];
    const order = 'ERP-NOT-REACHED';
    const pack = await master('tablet-blister-packaging', proc.product);
    expect({
      draftOnly: await codeOf(plan(randomUUID(), { familyId: drafted.familyId, batchSize: packSize, parentBatch: parent, erpOrder: order })),
      notAuthorised: await codeOf(plan(randomUUID(), { familyId: unauthorised.familyId, batchSize: packSize, parentBatch: parent, erpOrder: order })),
      unlistedPackSize: await codeOf(plan(randomUUID(), { familyId: pack.familyId, batchSize: 'PO-99K', parentBatch: parent, erpOrder: order })),
      processingMaster: await codeOf(plan(randomUUID(), { familyId: proc.familyId, batchSize: SIZE['tablet-granulation-compression'], parentBatch: parent })),
      unknownFamily: await codeOf(plan(randomUUID(), { familyId: randomUUID(), batchSize: packSize, parentBatch: parent, erpOrder: order })),
    }).toEqual({ draftOnly: 'EBMR-EXE-192', notAuthorised: 'EBMR-EXE-192', unlistedPackSize: 'EBMR-EXE-192', processingMaster: 'EBMR-EXE-198', unknownFamily: 'EBMR-EXE-192' });
    expect(await q('select 1 from recipe.stub_batch b join recipe.mbr_family f on f.id = b.family_id where f.id in ($1, $2)', [drafted.familyId, unauthorised.familyId])).toEqual([]);
    const planned = await plan(randomUUID(), { familyId: pack.familyId, batchSize: packSize, parentBatch: parent });
    expect(planned.batchNumber).toMatch(/\/P01$/);
  });

  it('a packaging order is planned only for markets inside its processing batch\'s set (outline 3.3.3; Phase 4 slice 4a)', async () => {
    const proc = await master('tablet-granulation-compression', undefined, { markets: ['IN', 'US'] });
    const pack = await master('tablet-blister-packaging', proc.product, { markets: ['IN', 'US'] });
    const parent = randomUUID();
    await plan(parent, { familyId: proc.familyId, batchSize: SIZE['tablet-granulation-compression'] });
    await issue(parent, 'tablet-granulation-compression');
    const packSize = SIZE['tablet-blister-packaging'];
    const refused = randomUUID();
    expect(await codeOf(plan(refused, { familyId: pack.familyId, batchSize: packSize, parentBatch: parent, markets: ['IN', 'US'] }))).toBe('EBMR-DSP-016');
    expect(await q('select 1 from recipe.stub_batch where id = $1', [refused])).toEqual([]);
    const planned = await plan(randomUUID(), { familyId: pack.familyId, batchSize: packSize, parentBatch: parent, markets: ['IN'] });
    expect(planned.batchNumber).toMatch(/\/P01$/);
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

describe('bulk issued to a packaging order only after the release for packing (exit review HIGH-3; recipe-core 0701)', () => {
  /** Superuser arrangement with triggers off (the processing batch's containers and its stored state). */
  async function arrange(sql: string, params: unknown[]): Promise<void> {
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      await c.query("set local session_replication_role = 'replica'");
      await c.query(sql, params);
      await c.query('commit');
    } finally {
      c.release();
    }
  }

  /** An output container of `batch` in `state`, closed with `net` kg (arranged: the container commands are proven in 0420 to 0422). */
  async function container(batch: string, state: string, net = '25.000'): Promise<string> {
    const id = randomUUID();
    const [b] = await q<{ n: string; p: string; s: string }>("select batch_number as n, (recipe.batch_product(id) ->> 'code') as p, (recipe.batch_product(id) ->> 'strength') as s from recipe.batch_execution where id = $1", [batch]);
    const label = `OC-${b?.n ?? 'X'}-${String(1000 + Math.floor(Math.random() * 8999))}`;
    await arrange(
      `with c as (insert into plant.output_container (id, label_code, batch_id, batch_number, product_code, strength, stage, quantity_unit, opened_by_person, opened_by_account)
                  values ($1, $2, $3, $4, $5, $6, 'COMPRESSION', 'kg', $1, $1) returning id),
            x as (insert into plant.container_close (container_id, net_quantity, person_id, account_id, basis, weighing) select id, $7::numeric, id, id, 'WEIGHED', '{}'::jsonb from c returning container_id)
       insert into platform.aggregate_state (aggregate_type, aggregate_id, machine_code, machine_version, state, version)
       select 'output_container', container_id, 'output_container', 1, $8, 3 from x`,
      [id, label, batch, b?.n, b?.p, b?.s, net, state],
    );
    return label;
  }

  /** The processing batch's stored state with an H-PACK instance in `status` (arranged as the engine stores a hold point). */
  async function hPack(batch: string, approved: boolean): Promise<void> {
    const inst = {
      key: 'H-PACK@', step: 'H-PACK', status: approved ? 'COMPLETED' : 'READY',
      ...(approved ? { disposition: { value: 'APPROVED', positive: true }, signatures: [{ id: randomUUID(), meaning: 'QA_HOLD_POINT', role: 'HOLD_POINT', valid: true }] } : { signatures: [] }),
    };
    await arrange("update recipe.execution_state set state = jsonb_set(state, '{steps,H-PACK@}', $2::jsonb) where batch_id = $1", [batch, JSON.stringify(inst)]);
  }

  async function orderOf(): Promise<{ parent: string; order: string; other: string }> {
    const proc = await master('tablet-granulation-compression');
    const pack = await master('tablet-blister-packaging', proc.product);
    const parent = randomUUID();
    await plan(parent, { familyId: proc.familyId, batchSize: SIZE['tablet-granulation-compression'] });
    await issue(parent, 'tablet-granulation-compression');
    const order = randomUUID();
    await plan(order, { familyId: pack.familyId, batchSize: SIZE['tablet-blister-packaging'], parentBatch: parent });
    await issue(order, 'tablet-blister-packaging');
    const other = randomUUID();
    await plan(other, { familyId: proc.familyId, batchSize: SIZE['tablet-granulation-compression'] });
    await issue(other, 'tablet-granulation-compression');
    return { parent, order, other };
  }

  it('[INV-27][IN-18] bulk is issued to a packaging order only once QA released its processing batch for packing (H-PACK): refused while the batch has not reached it or it waits, issued with each container\'s net quantity once it is approved', async () => {
    const operator = await seedActor(db, { roleCode: 'OPERATOR', legalName: 'Bulk Operator' });
    const { parent, order } = await orderOf();
    const label = await container(parent, 'RELEASED_BY_QA', '25.500');
    const bulk = (labels: string[]) => w.run(operator, (c) => containers.issuePackagingBulk(c, order, labels));
    expect(await codeOf(bulk([label]))).toBe('EBMR-PKG-002');
    await hPack(parent, false);
    const waiting = await bulk([label]).catch((e: Error) => e.message);
    expect(waiting).toMatch(/EBMR-PKG-002 .*has not signed its release for packing \(H-PACK\)/);
    expect((await q<{ c: boolean }>('select recipe.packaging_bulk_charged($1) as c', [order]))[0]?.c).toBe(false);
    await hPack(parent, true);
    expect(await bulk([label])).toEqual({ batchId: order, parentBatchId: parent, containers: [expect.objectContaining({ label, quantity: '25.500', unit: 'kg' })] });
    expect((await q<{ c: boolean }>('select recipe.packaging_bulk_charged($1) as c', [order]))[0]?.c).toBe(true);
    expect(await q('select purpose, stage from plant.container_charge where batch_id = $1', [order])).toEqual([{ purpose: 'PACK', stage: 'PACKAGING' }]);
  });

  it('[IN-26][INV-27] only the usable containers of the batch packed: a HELD or REJECTED container, one of another batch, or one issued already is refused, all or nothing; a processing batch takes no bulk; the application role writes no issue', async () => {
    const operator = await seedActor(db, { roleCode: 'OPERATOR', legalName: 'Bulk Operator 2' });
    const { parent, order, other } = await orderOf();
    await hPack(parent, true);
    const good = await container(parent, 'RELEASED_BY_QA');
    const held = await container(parent, 'HELD');
    const rejected = await container(parent, 'REJECTED');
    const foreign = await container(other, 'RELEASED_BY_QA');
    const bulk = (b: string, labels: string[]) => w.run(operator, (c) => containers.issuePackagingBulk(c, b, labels)).catch((e: Error) => e.message);
    expect(await bulk(order, [good, held])).toMatch(/EBMR-PKG-005 container .* is HELD/);
    expect(await bulk(order, [rejected])).toMatch(/EBMR-PKG-005 container .* is REJECTED/);
    expect(await bulk(order, [foreign])).toMatch(/EBMR-PKG-004/);
    expect(await bulk(order, [good, good])).toMatch(/EBMR-PKG-003/);
    expect(await bulk(other, [foreign])).toMatch(/EBMR-PKG-001 .*no packaging order/);
    // All or nothing: the refused issue above left the good container free.
    expect((await q<{ n: string }>('select count(*)::text as n from recipe.packaging_bulk_issue where order_batch_id = $1', [order]))[0]?.n).toBe('0');
    await bulk(order, [good]);
    expect(await bulk(order, [good])).toMatch(/EBMR-PKG-005 .*already charged or packed/);
    expect(await codeOf(db.app.query("insert into recipe.packaging_bulk_issue (order_batch_id, parent_batch_id, container_id, charge_id, quantity, unit, person_id, account_id) values ($1, $2, gen_random_uuid(), gen_random_uuid(), 1, 'kg', $1, $1)", [order, parent]))).toMatch(/permission denied/);
  });
});

/** The family definition of `content` (recipe-core lifecycle familyOf). */
const familyDef = (content: MbrContent): lc.FamilyDefinition => lc.familyOf(content);

describe('planning a packaging order (Phase 4 slice 2c; recipe-core 0760 to 0762)', () => {
  it('[PR-01] two pack types of one product at the same pack size are two packaging families (D-P4-13): a second family of the same pack type and size is refused, a master naming another pack type than its family is refused, a processing family names none, and the application role writes no pack type', async () => {
    const proc = await master('tablet-granulation-compression');
    const pvc = await master('tablet-blister-packaging', proc.product, { packType: 'ALU-PVC-BLISTER' });
    const alu = await master('tablet-blister-packaging', proc.product, { packType: 'ALU-ALU-BLISTER' });
    const plain = await master('tablet-blister-packaging', proc.product);
    expect(await q('select family_id::text as f, pack_type as t, source from recipe.mbr_family_pack where family_id = any ($1::uuid[]) order by pack_type', [[pvc.familyId, alu.familyId, plain.familyId]])).toEqual([
      { f: alu.familyId, t: 'ALU-ALU-BLISTER', source: 'DEFINED' },
      { f: pvc.familyId, t: 'ALU-PVC-BLISTER', source: 'DEFINED' },
      { f: plain.familyId, t: 'STANDARD', source: 'DEFINED' },
    ]);
    const content = (packType?: string): MbrContent => {
      const m = uniqueContent('tablet-blister-packaging', ['IN']);
      m.header.product = { ...m.header.product, code: proc.product };
      if (packType) m.header.packType = packType;
      return m;
    };
    // The same pack type at the same pack size again (another family code): one family per product, pack size and pack type.
    expect(await codeOf(w.run(w.cast.author, (c) => lc.defineFamily(c, familyDef(content('ALU-PVC-BLISTER')))))).toMatch(/mbr_family_pack_identity/);
    // A master naming another pack type than its family's.
    const other = content('HDPE-BOTTLE');
    const fam = await w.run(w.cast.author, (c) => lc.defineFamily(c, familyDef(other)));
    const wrong = { ...other, header: { ...other.header, packType: 'ALU-PVC-BLISTER' } };
    expect(await w.run(w.cast.author, (c) => lc.createVersion(c, fam, wrong)).catch((e: Error) => e.message)).toMatch(/pack type ALU-PVC-BLISTER differs from the family's pack type HDPE-BOTTLE/);
    // A processing family names no pack type.
    const pm = uniqueContent('tablet-granulation-compression', ['IN']);
    expect(await codeOf(w.run(w.cast.author, (c) => c.query('select recipe.define_family($1::jsonb)', [JSON.stringify({ ...familyDef(pm), packType: 'ALU-PVC-BLISTER' })])))).toBe('EBMR-PLN-003');
    // Bypass: the application role writes no pack type.
    expect(await codeOf(db.app.query("insert into recipe.mbr_family_pack (family_id, edition, record_kind, product_code, strength, dosage_form, batch_sizes, pack_type, source, created_by_person, created_by_account) values ($1, 'tablets', 'PACKAGING', 'X', 'X', 'X', '[]', 'X', 'DEFINED', $1, $1)", [pvc.familyId]))).toMatch(/permission denied/);
    // Both pack types plan their own packaging order of one processing batch.
    const parent = randomUUID();
    await plan(parent, { familyId: proc.familyId, batchSize: SIZE['tablet-granulation-compression'] });
    await issue(parent, 'tablet-granulation-compression');
    const a = await plan(randomUUID(), { familyId: pvc.familyId, batchSize: SIZE['tablet-blister-packaging'], parentBatch: parent });
    const b = await plan(randomUUID(), { familyId: alu.familyId, batchSize: SIZE['tablet-blister-packaging'], parentBatch: parent });
    expect([a.batchNumber, b.batchNumber]).toEqual([expect.stringMatching(/\/P01$/), expect.stringMatching(/\/P02$/)]);
  });

  it('[IN-14][PR-01] two pack sizes of one product each need their own approved packaging master: an order for a pack size is planned only on an approved, authorised master listing it, never on the other pack size\'s master, and a second family of the same pack size and type is refused', async () => {
    const proc = await master('tablet-granulation-compression');
    const parent = randomUUID();
    await plan(parent, { familyId: proc.familyId, batchSize: SIZE['tablet-granulation-compression'] });
    await issue(parent, 'tablet-granulation-compression');
    const small = await master('tablet-blister-packaging', proc.product, { packType: 'ALU-PVC-BLISTER', packSize: { id: 'PO-20K', count: '20000' } });
    // The second pack size of the product: its own family; while its master is only drafted no order of that size is planned,
    // and the first pack size's approved master never plans it.
    const bigContent = (): MbrContent => {
      const m = uniqueContent('tablet-blister-packaging', ['IN']);
      m.header.product = { ...m.header.product, code: proc.product };
      m.header.packType = 'ALU-PVC-BLISTER';
      m.header.batchSizes = [{ id: 'PO-30K', quantity: { value: '30000', unit: '{tbl}' } }];
      return withSecondaryPacking(without(m, ['G-09', 'G-10'])) as MbrContent;
    };
    const bigDraft = bigContent();
    const drafted = await w.newVersion(bigDraft);
    const order = 'ERP-NOT-REACHED';
    expect({
      bigOnSmallMaster: await codeOf(plan(randomUUID(), { familyId: small.familyId, batchSize: 'PO-30K', parentBatch: parent, erpOrder: order })),
      bigDraftOnly: await codeOf(plan(randomUUID(), { familyId: drafted.familyId, batchSize: 'PO-30K', parentBatch: parent, erpOrder: order })),
    }).toEqual({ bigOnSmallMaster: 'EBMR-EXE-192', bigDraftOnly: 'EBMR-EXE-192' });
    // The same pack size and pack type of the product a second time is refused: one packaging master family per pack size.
    expect(await codeOf(w.run(w.cast.author, (c) => lc.defineFamily(c, familyDef(bigContent()))))).toMatch(/mbr_family_pack_identity/);
    // With its own master approved and authorised, each pack size plans its own order on its own master.
    await w.prepare(drafted.versionId, bigDraft);
    await w.startVerification(drafted.versionId);
    await w.submit(drafted.versionId);
    await w.check(drafted.versionId);
    await w.approve(drafted.versionId);
    await w.authorise({ versionId: drafted.versionId, market: 'IN', kind: 'CURRENT', cells: [cell(SITE, 'L1', 'PO-30K')], regulatoryBasis: 'IN: registration on file' });
    const a = await plan(randomUUID(), { familyId: small.familyId, batchSize: 'PO-20K', parentBatch: parent });
    const b = await plan(randomUUID(), { familyId: drafted.familyId, batchSize: 'PO-30K', parentBatch: parent });
    expect([a.batchNumber, b.batchNumber]).toEqual([expect.stringMatching(/\/P01$/), expect.stringMatching(/\/P02$/)]);
    expect(await codeOf(plan(randomUUID(), { familyId: drafted.familyId, batchSize: 'PO-20K', parentBatch: parent, erpOrder: order }))).toBe('EBMR-EXE-192');
  });

  it('[PR-37][IN-16] a packaging order whose master has no secondary-packaging step (TB-24 for tablets) is refused and nothing is planned; an edition with no completion block plans none', async () => {
    const proc = await master('tablet-granulation-compression');
    const bare = await master('tablet-blister-packaging', proc.product, { secondaryPacking: false, packType: 'NO-TB24' });
    const parent = randomUUID();
    await plan(parent, { familyId: proc.familyId, batchSize: SIZE['tablet-granulation-compression'] });
    await issue(parent, 'tablet-granulation-compression');
    const order = randomUUID();
    const refused = await plan(order, { familyId: bare.familyId, batchSize: SIZE['tablet-blister-packaging'], parentBatch: parent }).catch((e: Error) => e.message);
    expect(refused).toMatch(/EBMR-PLN-005 the packaging order cannot be planned on MBR .*: its procedure has no TB-24 step/);
    expect(await q('select id from recipe.stub_batch where id = $1', [order])).toEqual([]);
    expect(await q<{ p: string | null }>("select recipe.packaging_master_problem('injectables', '{\"procedure\": {}}'::jsonb) as p")).toEqual([{ p: 'no block completes a packaging record of the injectables edition yet' }]);
    // Bypass: the application role cannot register a completion block.
    expect(await codeOf(db.app.query("insert into recipe.packaging_completion_block (edition, block_type) values ('tablets', 'G-16')"))).toMatch(/permission denied/);
  });

  it('[IN-18][INV-27][DI-14] a batch number allocated ahead by another person is not taken by the planner (review backlog 2b #4); the planner\'s own allocation is, and a test number is refused on the GMP installation', async () => {
    const proc = await master('tablet-granulation-compression');
    const other = await seedActor(db, { roleCode: 'BATCH_ISSUER', legalName: 'Olga Other Issuer' });
    const ahead = async (who: SeededActor): Promise<string> =>
      withProtectedNumbers(db.app, await cmd(db, who), ledger, async (c) =>
        (await c.query<{ id: string }>('select allocation_id::text as id from site.allocate_batch_number($1::jsonb)', [
          JSON.stringify({ site_code: SITE, product_code: proc.product, product_name: 'Atorvastatin calcium tablets', edition: 'TABLETS', batch_kind: 'PROCESSING', batch_size: '51.2', batch_size_unit: 'kg' }),
        ])).rows[0]?.id ?? '');
    const theirs = await ahead(other);
    const batch = randomUUID();
    const refused = await plan(batch, { familyId: proc.familyId, batchSize: SIZE['tablet-granulation-compression'], allocationId: theirs }).catch((e: Error) => e.message);
    expect(refused).toMatch(/EBMR-PLN-004 batch number .* was allocated by another person/);
    expect(await q('select id from recipe.stub_batch where id = $1', [batch])).toEqual([]);
    const mine = await ahead(w.cast.issuer);
    expect((await plan(randomUUID(), { familyId: proc.familyId, batchSize: SIZE['tablet-granulation-compression'], allocationId: mine })).allocationId).toBe(mine);
    expect(await q<{ p: boolean }>("select sandbox.identifier_problem('BATCH_NUMBER', 'TEST-B26-0001') is not null as p")).toEqual([{ p: true }]);
  });
});

describe('the planning reads of packaging orders and their bulk (Phase 4 slice 2c; recipe-core 0762)', () => {
  async function arrange(sql: string, params: unknown[]): Promise<void> {
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      await c.query("set local session_replication_role = 'replica'");
      await c.query(sql, params);
      await c.query('commit');
    } finally {
      c.release();
    }
  }

  it('[IN-26][INV-27] the bulk-issue read shows the order, its processing batch and why it is not released for packing, each container with the database\'s reason it cannot be issued, and the bulk issued; the planning read names the parent candidates of a packaging order', async () => {
    const operator = await seedActor(db, { roleCode: 'OPERATOR', legalName: 'Bulk Reader' });
    const proc = await master('tablet-granulation-compression');
    const pack = await master('tablet-blister-packaging', proc.product, { packType: 'ALU-PVC-READ' });
    const parent = randomUUID();
    await plan(parent, { familyId: proc.familyId, batchSize: SIZE['tablet-granulation-compression'] });
    await issue(parent, 'tablet-granulation-compression');
    const erpNo = await familyOrder(db, erp, pack.familyId, SIZE['tablet-blister-packaging']);
    const orders = (await db.admin.query<{ r: Json[] }>('select recipe.planning_orders($1) as r', [SITE])).rows[0]?.r ?? [];
    const card = orders.find((o) => o['orderNo'] === erpNo);
    expect(card?.['match']).toMatchObject({
      familyId: pack.familyId, recordKind: 'PACKAGING', packType: 'ALU-PVC-READ',
      parents: expect.arrayContaining([expect.objectContaining({ batchId: parent, releaseForPackingProblem: (expect.stringMatching(/H-PACK/) as unknown) })]) as unknown,
    });
    const order = randomUUID();
    await plan(order, { familyId: pack.familyId, batchSize: SIZE['tablet-blister-packaging'], parentBatch: parent, erpOrder: erpNo });
    const read = async (): Promise<Json> => (await db.app.query<{ r: Json }>('select recipe.packaging_order_bulk($1) as r', [order])).rows[0]?.r ?? {};
    expect(await read()).toMatchObject({
      batchId: order, status: 'PLANNED', packType: 'ALU-PVC-READ', orderProblem: expect.stringMatching(/is PLANNED: bulk is issued only to a packaging order that is issued or running/) as unknown,
      parent: { batchId: parent }, issued: [], containers: [],
    });
    await issue(order, 'tablet-blister-packaging');
    // The processing batch's containers and its approved H-PACK (arranged, as the 0701 tests arrange them).
    const [b] = await q<{ n: string }>('select batch_number as n from recipe.batch_execution where id = $1', [parent]);
    const good = `OC-${b?.n ?? 'X'}-2001`;
    const held = `OC-${b?.n ?? 'X'}-2002`;
    for (const [label, state] of [[good, 'RELEASED_BY_QA'], [held, 'HELD']] as const) {
      const id = randomUUID();
      await arrange(
        `with c as (insert into plant.output_container (id, label_code, batch_id, batch_number, product_code, strength, stage, quantity_unit, opened_by_person, opened_by_account)
                    values ($1, $2, $3, $4, $5, 'X', 'COMPRESSION', 'kg', $1, $1) returning id),
              x as (insert into plant.container_close (container_id, net_quantity, person_id, account_id, basis, weighing) select id, 25.5, id, id, 'WEIGHED', '{}'::jsonb from c returning container_id)
         insert into platform.aggregate_state (aggregate_type, aggregate_id, machine_code, machine_version, state, version) select 'output_container', container_id, 'output_container', 1, $6, 3 from x`,
        [id, label, parent, b?.n, proc.product, state],
      );
    }
    const before = await read();
    expect(before).toMatchObject({ status: 'ISSUED', orderProblem: null, parent: { releaseForPackingProblem: (expect.stringMatching(/H-PACK/) as unknown) } });
    expect(before['containers']).toEqual([
      expect.objectContaining({ label: good, state: 'RELEASED_BY_QA', netQuantity: '25.5', unit: 'kg', issueProblem: null }),
      expect.objectContaining({ label: held, state: 'HELD', issueProblem: (expect.stringMatching(/HELD/) as unknown) }),
    ]);
    await arrange("update recipe.execution_state set state = jsonb_set(state, '{steps,H-PACK@}', $2::jsonb) where batch_id = $1", [
      parent,
      JSON.stringify({ key: 'H-PACK@', step: 'H-PACK', status: 'COMPLETED', disposition: { value: 'APPROVED', positive: true }, signatures: [{ id: randomUUID(), meaning: 'QA_HOLD_POINT', role: 'HOLD_POINT', valid: true }] }),
    ]);
    await w.run(operator, (c) => containers.issuePackagingBulk(c, order, [good]));
    const after = await read();
    expect(after).toMatchObject({ parent: { releaseForPackingProblem: null }, issued: [expect.objectContaining({ label: good, quantity: '25.5', unit: 'kg', personId: operator.personId })] });
    expect((after['containers'] as Json[])[0]).toMatchObject({ label: good, issueProblem: (expect.stringMatching(/^issued to packaging order /) as unknown) });
    const listed = (await db.app.query<{ r: Json[] }>('select recipe.packaging_orders($1) as r', [SITE])).rows[0]?.r ?? [];
    expect(listed.find((o) => o['batchId'] === order)).toMatchObject({ parentBatchId: parent, packType: 'ALU-PVC-READ', bulkContainers: 1, releaseForPackingProblem: null });
  });
});
