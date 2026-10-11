/**
 * The ERP production order a GMP batch is planned against, recipe side (SQL mutation group "erp-interfaces",
 * recipe-core 0602): the batch size the order is for against the family's approved size, the MBR's reference size
 * its BOM quantities are for, and the open order a planning screen is offered for a family, site and size.
 *
 * recipe.erp_order_problem is called directly by the superuser with the family's own row; the rows a test arranges
 * (a planned order) are written with session_replication_role = replica in a transaction that is rolled back.
 *
 * Controls: PR-04, PR-17; invariant INV-28.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedServiceActor, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import type { MbrContent } from '../../src/flow/model.ts';
import { postOrder } from '../lifecycle/gmp-support.ts';
import { seedCast, uniqueContent, World } from '../lifecycle/support.ts';

let db: TestDatabase;
let w: World;
let erp: SeededActor;
let familyId: string;
let content: MbrContent;

beforeAll(async () => {
  db = await createTestDatabase();
  w = new World(db, await seedCast(db));
  erp = await seedServiceActor(db, { kind: 'INTEGRATION', source: 'INTEGRATION', roleCode: 'ERP_INTERFACE', name: 'ERP interface' });
  content = uniqueContent('tablet-granulation-compression');
  content.header.product = { ...content.header.product, code: content.header.product.code.toUpperCase() };
  familyId = (await w.approvedVersion(content)).familyId;
}, 300_000);
afterAll(async () => {
  await db.drop();
});

const SIZE = (): MbrContent['header']['batchSizes'][number] => {
  const s = content.header.batchSizes[0];
  if (!s) throw new Error('the fixture has no batch size');
  return s;
};

/** The order as the ERP stub holds it, for the family's product at SITE-1 and its first approved size. */
const order = (over: Record<string, unknown> = {}) => ({
  orderNo: `PO-${randomUUID().slice(0, 8)}`,
  siteCode: 'SITE-1',
  productCode: content.header.product.code,
  strength: content.header.product.strength,
  batchSize: SIZE().quantity.value,
  batchSizeUnit: SIZE().quantity.unit,
  bom: content.bom.map((b) => ({ materialCode: b.material, quantity: b.quantity.value, unit: b.quantity.unit })),
  ...over,
});

async function problem(o: Record<string, unknown>, sizeId: string, mbr: unknown = content, familyOver: Record<string, unknown> = {}): Promise<string | null> {
  const { rows } = await db.admin.query<{ p: string | null }>(
    `select recipe.erp_order_problem($1, $2::jsonb, jsonb_populate_record(f, $5::jsonb), 'SITE-1', $3, $4::jsonb) as p from recipe.mbr_family f where f.id = $6`,
    [o['orderNo'], JSON.stringify(o), sizeId, JSON.stringify(mbr), JSON.stringify(familyOver), familyId],
  );
  return rows[0]?.p ?? null;
}

describe('the batch size of an ERP order (recipe-core 0602)', () => {
  it('[PR-04][PR-17] the order is for the approved size: an unknown size, another quantity or unit, or a size whose value is not a decimal is refused', async () => {
    const id = SIZE().id;
    expect(await problem(order(), id)).toBeNull();
    expect(await problem(order(), 'NO-SUCH-SIZE')).toMatch(/is for a batch of .* not the approved batch size NO-SUCH-SIZE \(\? \?\)/);
    expect(await problem(order({ batchSize: `${SIZE().quantity.value}1` }), id)).toMatch(/not the approved batch size/);
    expect(await problem(order({ batchSizeUnit: SIZE().quantity.unit === 'kg' ? 'g' : 'kg' }), id)).toMatch(/not the approved batch size/);
    const malformed = [{ id, quantity: { value: 'about 200', unit: SIZE().quantity.unit } }];
    expect(await problem(order(), id, content, { batch_sizes: malformed })).toMatch(/not the approved batch size/);
  });

  it('[PR-04][PR-17] the MBR states its reference size: none, not a decimal, zero, or in another unit than the batch size is refused', async () => {
    const id = SIZE().id;
    const withRef = (q: unknown): unknown => ({ ...content, header: { ...content.header, batchSizes: [{ ...SIZE(), quantity: q }, ...content.header.batchSizes.slice(1)] } });
    const unit = SIZE().quantity.unit;
    expect(await problem(order(), id, withRef(null))).toBe('the MBR states no reference batch size its BOM quantities are for');
    expect(await problem(order(), id, withRef({ value: 'two hundred', unit }))).toBe('the MBR states no reference batch size its BOM quantities are for');
    expect(await problem(order(), id, withRef({ value: '0', unit }))).toBe('the MBR states no reference batch size its BOM quantities are for');
    expect(await problem(order(), id, withRef({ value: SIZE().quantity.value, unit: unit === 'kg' ? 'g' : 'kg' }))).toBe(
      'the MBR states no reference batch size its BOM quantities are for',
    );
  });
});

describe('the open order offered for a family, site and size (recipe-core 0602)', () => {
  async function replica<T>(work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      await c.query("set local session_replication_role = 'replica'");
      return await work(c);
    } finally {
      await c.query('rollback');
      c.release();
    }
  }

  it('[PR-04][PR-17] the oldest open order of the family\'s product, strength, site, unit and size, in its latest version, not yet planned', async () => {
    const id = SIZE().id;
    const post = (over: Record<string, string>) => postOrder(db.app, erp, content, id, over);
    const value = SIZE().quantity.value;
    const unit = SIZE().quantity.unit;
    // Older orders that do not match, each in one respect.
    await post({ productCode: 'OTHER-PRODUCT' });
    await post({ strength: '999 mg' });
    await post({ siteCode: 'SITE-2' });
    await post({ batchSizeUnit: unit === 'kg' ? 'g' : 'kg' });
    await post({ batchSize: `${value}1` });
    // An order whose latest version is for another size.
    const revised = await post({});
    await post({ orderNo: revised, batchSize: `${value}2` });
    // An order already planned (arranged in the rolled-back transaction below), then the one expected.
    const planned = await post({});
    const expected = await post({});
    const offered = await replica(async (c) => {
      await c.query("insert into recipe.batch_erp_order (batch_id, order_id, order_no) values (gen_random_uuid(), gen_random_uuid(), $1)", [planned]);
      return (await c.query<{ o: string | null }>("select recipe.open_erp_order_for($1, 'SITE-1', $2) as o", [familyId, id])).rows[0]?.o;
    });
    expect(offered).toBe(expected);
    // Another site, or a size the family does not approve, is offered nothing.
    expect((await db.admin.query<{ o: string | null }>("select recipe.open_erp_order_for($1, 'SITE-9', $2) as o", [familyId, id])).rows[0]?.o).toBeNull();
    expect((await db.admin.query<{ o: string | null }>("select recipe.open_erp_order_for($1, 'SITE-1', 'NOPE') as o", [familyId])).rows[0]?.o).toBeNull();
  });
});
