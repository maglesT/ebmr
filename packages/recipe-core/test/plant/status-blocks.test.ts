/**
 * Phase 3 slice 3a, recipe-core 0521 and 0522: G-09@2 and G-10@2 stand on the plant schema's own records (an open
 * equipment use, an open room occupancy on a passed and verified clearance), never on a person's word; plant
 * transitions evaluate the batch's product scope (review backlog #5); a utility's feed status older than its class's
 * feed age does not count (review backlog #9). Everything is called as the application role; the binding check is
 * read through its function (the row trigger ad_plant_status_entry raises its answer as EBMR-EXE-210).
 */
import { createHash, randomUUID } from 'node:crypto';
import { asTimeTraveller } from '../../../kernel/test/esig/helpers.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedActor, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import * as containers from '../../src/containers/index.ts';
import * as plant from '../../src/plant/index.ts';
import { dbIn, PlantWorld, seedPlantCast } from './support.ts';

let db: TestDatabase;
let w: PlantWorld;

beforeAll(async () => {
  db = await createTestDatabase();
  w = new PlantWorld(db, await seedPlantCast(db));
}, 300_000);

afterAll(async () => {
  await db.drop();
});

/** recipe.plant_status_entry_problem: why the entry does not stand on its plant record (null when it does). */
async function problem(batchId: string, person: SeededActor, entry: Record<string, unknown>, step = 'p-use'): Promise<string | null> {
  const { rows } = await db.admin.query<{ p: string | null }>('select recipe.plant_status_entry_problem($1, $2, $3, $4::jsonb) as p', [batchId, person.personId, step, JSON.stringify(entry)]);
  return rows[0]?.p ?? null;
}

/**
 * A test batch of `product` whose MBR binds stage equipment PRESS to plant class `classCode` in the stage of step p-use
 * (arranged by the superuser with triggers off, as the plant support's batches: test setup only).
 */
async function batchBinding(product: string, classCode: string): Promise<string> {
  const id = randomUUID();
  const hash = createHash('sha256').update(id).digest('hex');
  const content = {
    procedure: { kind: 'procedure', id: 'proc', body: { kind: 'stage', id: 'S-1', binding: { equipment: [{ ref: 'PRESS', equipmentClass: 'EQC-PRESS', kind: 'PROCESS' }] }, body: { kind: 'phase', id: 'p-use' } } },
    references: [{ id: 'EQC-PRESS', kind: 'EQUIPMENT_CLASS', code: classCode }],
  };
  await asTimeTraveller(
    db,
    `insert into recipe.test_package (package_hash, file_name, package, content, content_hash, family_id, family_code, product, version_id, version_number,
                                      revision, version_state, exporter, exported_at_us, source, imported_by_person, imported_by_account, correlation_id)
     values ($1, $1 || '.json', '{}', $3::jsonb, $1, gen_random_uuid(), 'FAM', $2::jsonb, gen_random_uuid(), '1', 1, 'APPROVED', '{}', 0, '{}',
             gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
    [hash, JSON.stringify({ code: product, name: `Product ${product}`, strength: '10 mg' }), JSON.stringify(content)],
  );
  await asTimeTraveller(
    db,
    `insert into recipe.batch_execution (id, batch_number, package_hash, content_hash, installation, purpose, engine_version, registry_fingerprint, policy,
                                         policy_hash, issue_request, market_set, batch_size, site_code, site_zone, issued_at_us, issued_by_person,
                                         issued_by_account, correlation_id)
     values ($1, $2, $3, $3, 'SANDBOX', 'SANDBOX_TEST_RUN', '1', $3, '{}', $3, '{}', '{IN}', 'BS', 'SITE-1', 'Asia/Kolkata', 0, gen_random_uuid(),
             gen_random_uuid(), gen_random_uuid())`,
    [id, `TEST-G09-${id.slice(0, 6).toUpperCase()}`, hash],
  );
  return id;
}

/** A clean, qualified press of a new class, in use for a batch of `product` whose MBR binds PRESS to that class. */
async function pressInUse(product: string): Promise<{ code: string; classCode: string; useId: string; batchId: string }> {
  const press = await w.press();
  await w.clean('EQUIPMENT', press.code, 'MAJOR');
  const batchId = await batchBinding(product, press.classCode);
  const useId = await w.run(w.cast.operator, async (c) => plant.startEquipmentUse(c, press.code, batchId, await dbIn(db, 3600)));
  return { code: press.code, classCode: press.classCode, useId, batchId };
}

describe('G-09@2: the equipment use an entry names is the plant record (recipe-core 0521, EBMR-EXE-210)', () => {
  it('[INV-12][PR-23][IN-25] an EQUIPMENT_USE entry stands only on an open use of its unit for this batch, started by the person recording it; any other use is refused with the reason', async () => {
    const product = await w.product();
    const a = await pressInUse(product);
    const entry = { kind: 'EQUIPMENT_USE', equipmentRef: 'PRESS', equipmentCode: a.code, useId: a.useId };
    expect(await problem(a.batchId, w.cast.operator, entry)).toBeNull();
    const other = await w.batch('G09B', product);
    expect(await problem(other.id, w.cast.operator, entry)).toMatch(/is of batch .*, not of this batch/);
    expect(await problem(a.batchId, w.cast.operator, { ...entry, equipmentCode: 'EQ-NOPE' })).toMatch(/is of unit .*, not of EQ-NOPE/);
    expect(await problem(a.batchId, w.cast.operator2, entry)).toMatch(/started by another person/);
    expect(await problem(a.batchId, w.cast.operator, { ...entry, useId: randomUUID() })).toMatch(/does not exist in site services/);
    expect(await problem(a.batchId, w.cast.operator, { ...entry, useId: 'L2409-0017' })).toBe('it names no useId');
    // Review 3a finding 4: the unit must be of the class the MBR binds for the reference (a balance is never the press).
    expect(await problem(a.batchId, w.cast.operator, { ...entry, equipmentRef: 'BAL' })).toMatch(/BAL is not equipment the stage of step p-use binds/);
    const scale = await w.press();
    await w.clean('EQUIPMENT', scale.code, 'MAJOR');
    const wrongClass = await w.run(w.cast.operator, async (c) => plant.startEquipmentUse(c, scale.code, a.batchId, await dbIn(db, 3600)));
    expect(await problem(a.batchId, w.cast.operator, { ...entry, equipmentCode: scale.code, useId: wrongClass })).toMatch(new RegExp(`is of class ${scale.classCode}, not of class ${a.classCode}`));
    await w.run(w.cast.operator, (c) => plant.endEquipmentUse(c, a.useId));
    expect(await problem(a.batchId, w.cast.operator, entry)).toMatch(/has ended/);
    // Other kinds are not read here.
    expect(await problem(a.batchId, w.cast.operator, { kind: 'EQUIPMENT_STATUS', equipmentRef: 'PRESS' })).toBeNull();
  });

  it('[INV-12][DI-05] the application role can neither read the binding check directly nor write a command row past the store', async () => {
    await expect(db.app.query("select recipe.plant_status_entry_problem(gen_random_uuid(), gen_random_uuid(), 'p', '{}'::jsonb)")).rejects.toThrow(/permission denied/);
    await expect(db.app.query("insert into recipe.execution_command (batch_id) values (gen_random_uuid())")).rejects.toThrow(/permission denied/);
  });
});

describe('G-10@2: the room occupancy an entry names is the plant record (recipe-core 0521, EBMR-EXE-210)', () => {
  it('[INV-15][IN-21][PR-34] an AREA_OCCUPANCY entry stands only on an open occupancy of its room by this batch on a passed, verified clearance, started by the person recording it', async () => {
    const product = await w.product();
    const room = await w.room();
    await w.clean('AREA', room.code, 'MAJOR');
    await w.clear(room.code, 'PRODUCT_CHANGE', { batch: 'G10A', product });
    const occupancyId = await w.startIn(room.code, { batch: 'G10A', product });
    const batch = await w.batch('G10A', product);
    const entry = { kind: 'AREA_OCCUPANCY', areaCode: room.code, occupancyId };
    expect(await problem(batch.id, w.cast.operator, entry)).toBeNull();
    expect(await problem((await w.batch('G10B', product)).id, w.cast.operator, entry)).toMatch(/not of this batch/);
    expect(await problem(batch.id, w.cast.operator, { ...entry, areaCode: 'RM-NOPE' })).toMatch(/not of RM-NOPE/);
    expect(await problem(batch.id, w.cast.operator2, entry)).toMatch(/started by another person/);
    expect(await problem(batch.id, w.cast.operator, { ...entry, occupancyId: randomUUID() })).toMatch(/does not exist/);
    await w.run(w.cast.operator, (c) => plant.endAreaOccupancy(c, occupancyId));
    expect(await problem(batch.id, w.cast.operator, entry)).toMatch(/has ended/);
  });
});

describe('review backlog #5: plant transitions evaluate the batch product (recipe-core 0522)', () => {
  it('[DI-17][IN-21] an operator whose STEP.EXECUTE is limited to a product starts and ends a press use and opens a container for a batch of that product, and is refused for another product', async () => {
    const product = await w.product();
    const otherProduct = await w.product();
    const scoped = await seedActor(db, { roleCode: 'OPERATOR', legalName: 'Priya Product-Scoped', scope: { product } });
    const press = await w.press();
    await w.clean('EQUIPMENT', press.code, 'MAJOR');
    const batch = await w.batch('SCOPE-A', product);
    const end = await dbIn(db, 3600);
    const useId = await w.run(scoped, (c) => plant.startEquipmentUse(c, press.code, batch.id, end));
    await w.run(scoped, (c) => plant.endEquipmentUse(c, useId));
    const opened = await w.run(scoped, (c) => containers.openContainer(c, { batchId: batch.id, stage: 'COMPRESSION', unit: 'kg' }));
    expect(opened.state).toBe('OPEN');
    const press2 = await w.press();
    await w.clean('EQUIPMENT', press2.code, 'MAJOR');
    const foreign = await w.batch('SCOPE-B', otherProduct);
    await expect(w.run(scoped, (c) => plant.startEquipmentUse(c, press2.code, foreign.id, end))).rejects.toThrow(/EBMR-IAM-040/);
    await expect(w.run(scoped, (c) => containers.openContainer(c, { batchId: foreign.id, stage: 'COMPRESSION', unit: 'kg' }))).rejects.toThrow(/EBMR-IAM-040/);
    // The scope a transition adds: the product, only for step.execute on a plant unit or a container.
    const { rows } = await db.admin.query<{ a: unknown; b: unknown; c: unknown }>(
      "select plant.transition_scope('step.execute', 'plant_equipment', $1) as a, plant.transition_scope('logbook.entry', 'plant_equipment', $1) as b, plant.transition_scope('step.execute', 'plant_area', $1) as c",
      [(await db.admin.query<{ id: string }>('select id from plant.equipment where code = $1', [press.code])).rows[0]?.id],
    );
    expect(rows[0]).toEqual({ a: { product }, b: {}, c: {} });
  });
});

describe('review backlog #9: a utility feed status older than its feed age does not count (recipe-core 0522)', () => {
  it('[IN-25] an OK status observed longer ago than the class feed age (default 15 minutes) leaves the utility unusable; the age is configured by master data and the latest setting counts', async () => {
    const hvac = await w.equipment({ kind: 'UTILITY', calibrationRequired: false });
    await w.run(w.cast.feed, async (c) => plant.recordUtilityReading(c, hvac.code, 'OK', 'BMS', await dbIn(db, -20 * 60)));
    expect(await plant.utilityProblem(db.app, hvac.code)).toMatch(/older than its feed age of 00:15:00/);
    await expect(db.app.query('select plant.assert_utility_usable($1)', [hvac.code])).rejects.toThrow(/EBMR-PLANT-027/);
    await w.run(w.cast.steward, (c) => c.query('select plant.set_utility_feed_age($1, $2::interval)', [hvac.classCode, '30 minutes']));
    expect(await plant.utilityProblem(db.app, hvac.code)).toBeNull();
    await w.run(w.cast.steward, (c) => c.query('select plant.set_utility_feed_age($1, $2::interval)', [hvac.classCode, '10 minutes']));
    expect(await plant.utilityProblem(db.app, hvac.code)).toMatch(/older than its feed age of 00:10:00/);
    await w.run(w.cast.feed, async (c) => plant.recordUtilityReading(c, hvac.code, 'OK', 'BMS', await dbIn(db, 0)));
    expect(await plant.utilityProblem(db.app, hvac.code)).toBeNull();
    // A feed clock ahead of the database does not make a status younger: the database's receipt time also bounds it.
    // Only master data sets the age, only for a utility class, and the application role writes no row itself.
    await expect(w.run(w.cast.operator, (c) => c.query('select plant.set_utility_feed_age($1, $2::interval)', [hvac.classCode, '1 day']))).rejects.toThrow(/EBMR-IAM-040/);
    const press = await w.press();
    await expect(w.run(w.cast.steward, (c) => c.query('select plant.set_utility_feed_age($1, $2::interval)', [press.classCode, '1 hour']))).rejects.toThrow(/EBMR-PLANT-140/);
    await expect(db.app.query("insert into plant.utility_feed_age (class_code, max_age, recorded_by) values ($1, '1 day', gen_random_uuid())", [hvac.classCode])).rejects.toThrow(/permission denied/);
    await expect(db.app.query('update plant.utility_feed_age set max_age = $1', ['1 day'])).rejects.toThrow(/permission denied/);
  });
});
