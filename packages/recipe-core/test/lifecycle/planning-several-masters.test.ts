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

async function approved(content: MbrContent): Promise<{ familyId: string; versionId: string }> {
  const v = await w.approvedVersion(content);
  return { familyId: v.familyId, versionId: v.versionId };
}

const authorise = (versionId: string, line: string, size = SIZE) =>
  w.authorise({ versionId, market: 'IN', kind: 'CURRENT', cells: [cell(SITE, line, size)], regulatoryBasis: 'IN: registration on file' });

async function authorised(content: MbrContent, line = 'L1'): Promise<{ familyId: string }> {
  const v = await approved(content);
  await authorise(v.versionId, line);
  return { familyId: v.familyId };
}

/** A GMP master of a new product (upper-case code, as the ERP gives it). */
function product(): MbrContent {
  const a = gmp(uniqueContent('tablet-granulation-compression', ['IN']));
  a.header.product = { ...a.header.product, code: a.header.product.code.toUpperCase() };
  return a;
}

/** A second family of the same product and strength: the same batch size among a wider set (another identity, INV-17). */
function twin(a: MbrContent): MbrContent {
  const b = structuredClone(a);
  b.header.family = `${a.header.family}-B`.slice(0, 64);
  b.header.batchSizes = [...a.header.batchSizes, { id: 'BS-400K', quantity: { value: '102.4', unit: 'kg' } }];
  return b;
}

const orders = async (): Promise<Order[]> => (await db.admin.query<{ r: Order[] }>('select recipe.planning_orders($1) as r', [SITE])).rows[0]?.r ?? [];

describe('an ERP order that more than one master matches (retest 13 November 2026, bug 6)', () => {
  it('[PR-01][INV-01] one matching master is the match; with two the read names none as the match, lists both by family code and says the planner chooses', async () => {
    const a = product();
    const famA = await authorised(a);
    const orderNo = await postOrder(db.app, erp, a, SIZE);
    const one = (await orders()).find((o) => o.orderNo === orderNo);
    expect(one?.match?.familyId).toBe(famA.familyId);
    expect(one?.matches?.map((m) => m.familyId)).toEqual([famA.familyId]);
    expect(one?.noMatch).toBeNull();
    // A twin family authorised for the same batch size on another line (the twin guard, 1923, is per line): the order
    // names no line, so both match it.
    const b = twin(a);
    const famB = await authorised(b, 'L2');
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

describe('a twin family is refused at authorisation (owner decision of 13 November 2026 on bug 6; recipe-core 1923)', () => {
  it('[PR-01][INV-01][INV-17] a second family of the same product authorised for the same market, site, line and batch quantity as an active one is refused naming that family; another line or another batch quantity is authorised', async () => {
    const a = product();
    const famA = await authorised(a);
    const b = twin(a);
    const vB = await approved(b);
    const refused = await authorise(vB.versionId, 'L1').then(
      () => 'authorised',
      (e: Error) => e.message,
    );
    expect(refused).toMatch(new RegExp(`^MBR family ${a.header.family} version 1 is already authorised .* line L1 and batch size ${SIZE} .*EBMR-RCP-438`));
    const cells = await db.admin.query('select 1 from recipe.authorisation_cell where family_id = $1', [vB.familyId]);
    expect(cells.rows).toEqual([]);
    // Its other batch size (102.4 kg) on the same line, and the shared size on another line, are authorised.
    await authorise(vB.versionId, 'L1', 'BS-400K');
    await authorise(vB.versionId, 'L3');
    const open = await db.admin.query<{ line: string; batch_size: string }>(
      "select line, batch_size from recipe.authorisation_cell where family_id = $1 and status = 'CURRENT' order by line, batch_size",
      [vB.familyId],
    );
    expect(open.rows).toEqual([{ line: 'L1', batch_size: 'BS-400K' }, { line: 'L3', batch_size: SIZE }]);
    expect(famA.familyId).not.toBe(vB.familyId);
  }, 300_000);
});
