/**
 * The change-impact query (Phase 6 slice 6g; recipe-core 1071; D-P6g-0-8): for each kind of proposed change, the MBR
 * versions, open batches, released lots, markets and configuration history it reaches, checked against an independent
 * query written here from the tables (not from the query's own helpers) and against the scenario's expected names.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { refusal, unique, type Batch, type Lot } from '../genealogy/world.ts';
import { ReportWorld } from './world.ts';

let db: TestDatabase;
let w: ReportWorld;

interface ImpactRow {
  impact: string;
  id: string | null;
  label: string;
  detail: string | null;
  via: string | null;
}

const material = unique('MAT-');
const manufacturer = unique('MFR-');
const siteKey = `report.key.${unique('k').toLowerCase()}`;
let v1: { id: string; label: string };
let v2: { id: string; label: string };
let v3: { id: string; label: string };
let pinned: Batch;
let reviewed: Batch;
let consumer: Batch;
let order: Batch;
let lot: Lot;
let finished: Lot;
let press: { id: string; code: string };
let specId: string;

async function impact(kind: string, ref: string): Promise<ImpactRow[]> {
  return (await db.app.query<ImpactRow>('select * from recipe.change_impact($1, $2)', [kind, ref])).rows;
}

const pick = (rows: ImpactRow[], kind: string): string[] => rows.filter((r) => r.impact === kind).map((r) => r.label).sort();

beforeAll(async () => {
  db = await createTestDatabase();
  w = await ReportWorld.create(db);
  // Three versions: v1 APPROVED with the material, v2 RETIRED with it (out of scope), v3 APPROVED without it (authorised in US).
  v1 = await w.version('APPROVED');
  v2 = await w.version('RETIRED');
  v3 = await w.version('APPROVED');
  await w.formula(v1.id, [material, 'MAT-OTHER']);
  await w.formula(v2.id, [material]);
  await w.formula(v3.id, ['MAT-OTHER']);
  await w.authorise(v1.id, 'IN');
  await w.authorise(v3.id, 'US');
  // Batches: one pinned to v1 and running, one pinned to v1 and QA reviewed (closed), one consuming a lot of the material.
  pinned = await w.batch('pinned', v1.id);
  await w.status(pinned, 'IN_PROGRESS');
  reviewed = await w.batch('reviewed', v1.id);
  await w.status(reviewed, 'EXECUTION_COMPLETE');
  await w.reviewAct(reviewed, 'QA_REVIEWED');
  consumer = await w.batch('consumer', v3.id);
  await w.status(consumer, 'IN_PROGRESS');
  lot = await w.g.materialLot('lot', 'EXCIPIENT', material);
  await w.g.consume(lot, consumer);
  await w.receipt(lot, manufacturer, material);
  // The consumer's output is packed into an order whose finished lot is released for IN and US.
  const c = await w.g.container('c1', consumer);
  order = await w.batch('order', null, consumer);
  await w.status(order, 'IN_PROGRESS');
  await w.g.bulkIssue(c, consumer, order);
  finished = await w.g.finishedLot('finished', order, ['IN', 'US']);
  await w.g.released(finished);
  press = await w.equipment();
  await w.used(press.id, pinned);
  specId = await w.specification(material);
  await w.siteValue(siteKey, ['IN', 'US']);
}, 300_000);

afterAll(async () => {
  await db?.drop();
});

describe('recipe.change_impact (D-P6g-0-8)', () => {
  it('change impact matches an independent query for each kind', async () => {
    // MATERIAL: the independent query, from the tables.
    const rows = await impact('MATERIAL', material);
    const indep = await db.admin.query<{ versions: string[]; batches: string[]; lots: string[] }>(
      `with v as (select distinct p.mbr_version_id as id from formulary.mbr_formula_pin p join formulary.formula_line l on l.version_id = p.formula_version_id
                   join platform.aggregate_state s on s.aggregate_type = 'mbr_version' and s.aggregate_id = p.mbr_version_id
                  where l.material_code = $1 and s.state not in ('RETIRED', 'WITHDRAWN')),
            direct as (select p.batch_id as id from recipe.batch_mbr_pin p where p.version_id in (select id from v)
                       union select c.batch_id from site.lot_consumption c join site.material_lot l on l.id = c.lot_id where l.material_code = $1),
            down as (select g.node_id as id, g.node_kind as kind from direct d, recipe.genealogy('BATCH', d.id, 'FORWARD', null) g
                     union select g.node_id, g.node_kind from site.material_lot l, recipe.genealogy('LOT', l.id, 'FORWARD', null) g where l.material_code = $1),
            open as (select b.id from recipe.batch_execution b left join recipe.execution_state s on s.batch_id = b.id
                      where (b.id in (select id from direct) or b.id in (select id from down where kind = 'BATCH'))
                        and coalesce(s.status, 'NONE') not in ('ABORTED', 'CANCELLED')
                        and not exists (select 1 from recipe.batch_review_act a where a.batch_id = b.id and a.act = 'QA_REVIEWED'))
       select (select coalesce(array_agg(id::text order by id), '{}') from v) as versions,
              (select coalesce(array_agg(id::text order by id), '{}') from open) as batches,
              (select coalesce(array_agg(l.id::text order by l.id), '{}') from site.material_lot l join platform.aggregate_state s on s.aggregate_type = 'material_lot' and s.aggregate_id = l.id
                where s.state = 'RELEASED' and l.id in (select id from down where kind = 'LOT')) as lots`,
      [material],
    );
    const ids = (k: string) => rows.filter((r) => r.impact === k).map((r) => r.id as string).sort();
    expect(ids('MBR_VERSION')).toEqual(indep.rows[0]!.versions);
    expect(ids('OPEN_BATCH')).toEqual(indep.rows[0]!.batches);
    expect(ids('RELEASED_LOT')).toEqual(indep.rows[0]!.lots);
    // And by name: v1 only (v2 retired, v3 has no such line); pinned and consumer and the order (reviewed is closed).
    expect(pick(rows, 'MBR_VERSION')).toEqual([v1.label]);
    expect(pick(rows, 'OPEN_BATCH')).toEqual([consumer.number, order.number, pinned.number].sort());
    expect(pick(rows, 'RELEASED_LOT')).toEqual([finished.code]);
    expect(pick(rows, 'MARKET')).toEqual(['IN', 'US']);
    expect(rows.find((r) => r.impact === 'OPEN_BATCH' && r.label === order.number)?.via).toBe('downstream');

    // SPECIFICATION: the impact of its material.
    const spec = await impact('SPECIFICATION', specId);
    expect(spec.map((r) => [r.impact, r.label])).toEqual(rows.map((r) => [r.impact, r.label]));

    // SUPPLIER: the versions of the materials it is approved for, and only its own lots' batches.
    const sup = await impact('SUPPLIER', manufacturer);
    expect(pick(sup, 'MBR_VERSION')).toEqual([v1.label]);
    expect(pick(sup, 'OPEN_BATCH')).toEqual([consumer.number, order.number, pinned.number].sort());
    expect(pick(sup, 'RELEASED_LOT')).toEqual([finished.code]);

    // EQUIPMENT: the batches that used it and their versions.
    const eq = await impact('EQUIPMENT', press.code);
    expect(pick(eq, 'MBR_VERSION')).toEqual([v1.label]);
    expect(pick(eq, 'OPEN_BATCH')).toEqual([pinned.number]);
    expect(pick(eq, 'RELEASED_LOT')).toEqual([]);

    // MBR_VERSION: v3 reaches its consumer batch, the order downstream and the released lot; its US cell is a market.
    const mv = await impact('MBR_VERSION', v3.id);
    expect(pick(mv, 'MBR_VERSION')).toEqual([v3.label]);
    expect(pick(mv, 'OPEN_BATCH')).toEqual([consumer.number, order.number].sort());
    expect(pick(mv, 'RELEASED_LOT')).toEqual([finished.code]);
    expect(pick(mv, 'MARKET')).toEqual(['IN', 'US']);

    // SITE_VALUE: every APPROVED version authorised in its markets (v1 in IN, v3 in US).
    const sv = await impact('SITE_VALUE', siteKey);
    expect(pick(sv, 'MBR_VERSION')).toEqual([v1.label, v3.label].sort());
    expect(pick(sv, 'MARKET')).toEqual(['IN', 'US']);
    expect(v2.id).not.toBe(v1.id);
  });

  it('an unknown kind or subject is refused; the query writes nothing', async () => {
    expect(await refusal(impact('RECIPE', 'x'))).toMatch(/EBMR-CIM-001/);
    expect(await refusal(impact('MATERIAL', unique('NONE-')))).toMatch(/EBMR-CIM-002/);
    expect(await refusal(impact('MBR_VERSION', 'not-a-uuid'))).toMatch(/EBMR-CIM-002/);
    expect(await refusal(impact('SPECIFICATION', '00000000-0000-4000-8000-000000000000'))).toMatch(/EBMR-CIM-002/);
    expect(await refusal(impact('EQUIPMENT', 'EQ-NONE'))).toMatch(/EBMR-CIM-002/);
    expect(await refusal(impact('SITE_VALUE', 'no.such.key'))).toMatch(/EBMR-CIM-002/);
    const { rows } = await db.admin.query<{ v: string }>("select provolatile::text as v from pg_catalog.pg_proc where oid = 'recipe.change_impact(text, text)'::regprocedure");
    expect(rows[0]!.v).toBe('s');
  });
});
