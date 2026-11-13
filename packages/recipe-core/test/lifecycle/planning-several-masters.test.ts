/**
 * The planning read when more than one master matches an ERP order (owner retest of 13 November 2026, bug 6): two
 * families of the same product and strength, both authorised now at the site for the order's batch size (the family
 * identity, INV-17, compares the whole batch-size set, so {51.2 kg} and {51.2 kg, 102.4 kg} are two families). Until
 * this fix recipe.planning_orders took the first by family code and showed it as "the" match, and the planner planned
 * the batch on a master that could not be run. Now the read never chooses: it lists every match and names none as the
 * match, and the planner chooses (the plan names the family; recipe.prepare_gmp_issue checks it again).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedServiceActor, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import type { MbrContent } from '../../src/flow/model.ts';
import { postOrder } from './gmp-support.ts';
import { cell, seedCast, uniqueContent, World } from './support.ts';

let db: TestDatabase;
let w: World;
let erp: SeededActor;
const SITE = 'SITE-1';
const SIZE = 'BS-200K';
type Json = Record<string, unknown>;
interface Match {
  familyId: string;
  familyCode: string;
  versionNumber: string;
  batchSizeId: string;
}
interface Order {
  orderNo: string;
  match: Match | null;
  matches?: Match[];
  noMatch: string | null;
}

beforeAll(async () => {
  db = await createTestDatabase();
  w = new World(db, await seedCast(db));
  erp = await seedServiceActor(db, { kind: 'INTEGRATION', source: 'INTEGRATION', roleCode: 'ERP_INTERFACE', name: 'ERP interface' });
}, 300_000);

afterAll(async () => {
  await db.drop();
});

/** The content without the G-09 and G-10 version 1 steps (sandbox-only blocks a GMP master may not hold). */
function gmp(m: MbrContent): MbrContent {
  const strip = (n: unknown): unknown => {
    if (Array.isArray(n)) return n.filter((x) => !['G-09', 'G-10'].includes(String(((x as Json | null)?.['block'] as Json | undefined)?.['type']))).map(strip);
    if (n && typeof n === 'object') return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, strip(v)]));
    return n;
  };
  return strip(m) as MbrContent;
}

async function authorised(content: MbrContent): Promise<{ familyId: string }> {
  const v = await w.approvedVersion(content);
  await w.authorise({ versionId: v.versionId, market: 'IN', kind: 'CURRENT', cells: [cell(SITE, 'L1', SIZE)], regulatoryBasis: 'IN: registration on file' });
  return { familyId: v.familyId };
}

const orders = async (): Promise<Order[]> => (await db.admin.query<{ r: Order[] }>('select recipe.planning_orders($1) as r', [SITE])).rows[0]?.r ?? [];

describe('an ERP order that more than one master matches (retest 13 November 2026, bug 6)', () => {
  it('[PR-01][INV-01] one matching master is the match; with two the read names none as the match, lists both by family code and says the planner chooses', async () => {
    const a = gmp(uniqueContent('tablet-granulation-compression', ['IN']));
    a.header.product = { ...a.header.product, code: a.header.product.code.toUpperCase() };
    const famA = await authorised(a);
    const orderNo = await postOrder(db.app, erp, a, SIZE);
    const one = (await orders()).find((o) => o.orderNo === orderNo);
    expect(one?.match?.familyId).toBe(famA.familyId);
    expect(one?.matches?.map((m) => m.familyId)).toEqual([famA.familyId]);
    expect(one?.noMatch).toBeNull();
    // A second family of the same product and strength, with the same batch size among a wider set, authorised too.
    const b = structuredClone(a);
    b.header.family = `${a.header.family}-B`.slice(0, 64);
    b.header.batchSizes = [...a.header.batchSizes, { id: 'BS-400K', quantity: { value: '102.4', unit: 'kg' } }];
    const famB = await authorised(b);
    const two = (await orders()).find((o) => o.orderNo === orderNo);
    expect(two?.match).toBeNull();
    const byCode = [
      { id: famA.familyId, code: a.header.family },
      { id: famB.familyId, code: b.header.family },
    ].sort((x, y) => (x.code < y.code ? -1 : 1));
    expect(two?.matches?.map((m) => [m.familyId, m.batchSizeId])).toEqual(byCode.map((f) => [f.id, SIZE]));
    expect(two?.noMatch).toMatch(/2 master records match this order .*choose/);
  }, 300_000);
});
