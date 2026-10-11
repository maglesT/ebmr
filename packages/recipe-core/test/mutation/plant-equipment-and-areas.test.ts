/**
 * Plant equipment and areas, rule by rule (SQL mutation group "plant-equipment-and-areas": recipe-core 0400, 0403,
 * 0404, 0460 and 0522). These tests close the gaps the Phase 3 exit SQL mutation run found in test/plant:
 *   - the row guards that hold whoever writes (owner-level inserts, in a transaction that is always rolled back): an
 *     abandoned cleaning is never verified, a verified one never abandoned, a clearance is verified by another person
 *     than its own performer only, a use or an occupancy follows the latest one and never overlaps, a repair
 *     verification names the REPAIRED event of the repaired unit;
 *   - the guards of the plant machines on direct transitions, each read for the aggregate named and no other;
 *   - each refusal of the commands on its own (an unknown, closed or already decided cleaning, clearance, campaign,
 *     repair or occupancy; malformed targets, results and types), with its own code;
 *   - the row locks the commands take on the unit or area they act on (so two acts on one unit serialise);
 *   - what the readers compute: when a unit became dirty, which batches an as-found failure affects, the daily and
 *     per-use checks an instrument rests on, the campaign a batch may run in, the signed content of a cleaning.
 *
 * Controls: IN-21, IN-25, IN-26, PR-23, PR-25, PR-26, PR-27, PR-34, PR-35; invariants INV-12, INV-15.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toDbContext, type ActorContext } from '../../../kernel/src/db/command.ts';
import { cmd } from '../../../kernel/test/esig/helpers.ts';
import { seedActor, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import * as plant from '../../src/plant/index.ts';
import { dbIn, DAY, PlantWorld, seedPlantCast, tag } from '../plant/support.ts';

let db: TestDatabase;
let w: PlantWorld;
/** A third technician, who verifies the repairs below. */
let tech3: SeededActor;

beforeAll(async () => {
  db = await createTestDatabase();
  w = new PlantWorld(db, await seedPlantCast(db));
  // The first signature of this database is the second technician's (a cleaning verified by them), so a reader that
  // took "some signature" instead of the one named would find a signer other than the repair verifier below.
  const press = await w.press();
  await w.clean('EQUIPMENT', press.code, 'MAJOR');
  tech3 = await seedActor(db, { roleCode: 'MAINTENANCE_TECHNICIAN', legalName: 'Tara Technician' });
}, 300_000);

afterAll(async () => {
  await db.drop();
});

/** The message `p` is refused with, or '(not refused)'. */
async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '(not refused)';
}

/** Owner-level work (the superuser inside a validated command of `actor`, triggers on), always rolled back. */
async function asOwner<T>(actor: SeededActor, work: (c: pg.PoolClient) => Promise<T>, extra: Partial<ActorContext> = {}): Promise<T> {
  const ctx = await cmd(db, actor, extra);
  const c = await db.admin.connect();
  try {
    await c.query('begin');
    await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(ctx))]);
    return await work(c);
  } finally {
    await c.query('rollback');
    c.release();
  }
}

/**
 * Whether `work`, run in a command of `actor` left open, holds a row lock on the row `id` of `table` that a FOR NO KEY
 * UPDATE of another session waits for (a foreign key's KEY SHARE lock does not count). The work may fail after taking
 * its lock: the lock stays until the transaction ends. Everything is rolled back.
 */
async function locksRow(table: string, id: string, actor: SeededActor, work: (c: pg.PoolClient) => Promise<unknown>, extra: Partial<ActorContext> = {}): Promise<boolean> {
  const ctx = await cmd(db, actor, extra);
  const a = await db.admin.connect();
  const b = await db.admin.connect();
  try {
    await a.query('begin');
    await a.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(ctx))]);
    await work(a).catch(() => undefined);
    const code = await b.query(`select 1 from ${table} where id = $1 for no key update nowait`, [id]).then(
      () => 'free',
      (e: { code?: string }) => e.code,
    );
    return code === '55P03';
  } finally {
    await a.query('rollback');
    a.release();
    b.release();
  }
}

const q = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, params)).rows as T[];
const REASON = { reasonCode: 'EQUIPMENT_FAULT', reasonText: 'detergent supply failed' };

async function transition(actor: SeededActor, machine: string, aggregateType: string, id: string, event: string, extra: Partial<ActorContext> = {}): Promise<string> {
  const s = aggregateType === 'plant_equipment' ? await plant.equipmentState(db.app, id) : await plant.areaState(db.app, id);
  return refusal(
    asOwner(actor, (c) => c.query("select platform.transition($1, $2, $3, $4, $5, '{}'::jsonb)", [machine, aggregateType, id, event, s?.version]), extra),
  );
}

describe('the row guards hold for owner-level writes', () => {
  it('[IN-25] an abandoned cleaning is never verified, and a verified cleaning is never abandoned, even by the owner', async () => {
    const press = await w.press();
    const abandoned = await w.run(w.cast.tech, (c) => plant.startCleaning(c, 'EQUIPMENT', press.code, 'MAJOR'));
    await w.run(w.cast.tech, (c) => plant.completeCleaning(c, abandoned));
    await w.run(w.cast.tech, (c) => plant.abandonCleaning(c, abandoned), REASON);
    expect(
      await refusal(
        asOwner(w.cast.tech2, (c) =>
          c.query('insert into plant.cleaning_verification (cleaning_id, verified_by, signature_id) values ($1, $2, gen_random_uuid())', [
            abandoned,
            w.cast.tech2.personId,
          ]),
        ),
      ),
    ).toMatch(/An abandoned cleaning is never verified \(EBMR-PLANT-046\)/);
    const verified = await w.clean('EQUIPMENT', press.code, 'MAJOR');
    expect(
      await refusal(
        asOwner(w.cast.tech, (c) =>
          c.query("insert into plant.cleaning_abandonment (cleaning_id, reason, abandoned_by) values ($1, 'late', $2)", [verified, w.cast.tech.personId]),
        ),
      ),
    ).toMatch(/A verified cleaning is never abandoned \(EBMR-PLANT-049\)/);
  });

  it('[INV-15][IN-21] the table refuses a clearance verified by its own performer only: the performer of another clearance may verify this one', async () => {
    const product = await w.product();
    const room = await w.room();
    await w.clean('AREA', room.code, 'MAJOR');
    // The operator performs one clearance; the second operator performs another, which the operator then verifies.
    await w.recordClearance(room.code, 'PRODUCT_CHANGE', { batch: 'CV-1', product });
    const other = await w.run(w.cast.operator2, async (c) =>
      plant.recordClearance(c, room.code, 'PRODUCT_CHANGE', { batchId: (await w.batch('CV-2', product)).id, result: 'PASSED' }),
    );
    expect(
      await refusal(
        asOwner(w.cast.operator, (c) =>
          c.query('insert into plant.clearance_verification (clearance_id, verified_by, signature_id) values ($1, $2, gen_random_uuid())', [
            other,
            w.cast.operator.personId,
          ]),
        ),
      ),
    ).toBe('(not refused)');
    expect(
      await refusal(
        asOwner(w.cast.operator2, (c) =>
          c.query('insert into plant.clearance_verification (clearance_id, verified_by, signature_id) values ($1, $2, gen_random_uuid())', [
            other,
            w.cast.operator2.personId,
          ]),
        ),
      ),
    ).toMatch(/EBMR-PLANT-104/);
  });

  it('[INV-12][L-27] only PROCESS equipment is occupied, and a use names the latest use of its unit, even for owner-level inserts', async () => {
    const product = await w.product();
    const press = await w.press();
    const cleaning = await w.clean('EQUIPMENT', press.code, 'MAJOR');
    const instrument = await w.equipment({ kind: 'INSTRUMENT', checkRegime: 'PER_USE' });
    const b = (await w.batch('U-1', product)).id;
    const ins = `insert into plant.equipment_use (equipment_id, previous_use_id, batch_id, batch_ref, product_code, planned_end, cleaning_id, started_by)
                 values ($1, $2, $3, 'U-1', $4, clock_timestamp() + interval '1 day', $5, gen_random_uuid())`;
    expect(await refusal(asOwner(w.cast.operator, (c) => c.query(ins, [instrument.id, null, b, product, cleaning])))).toMatch(
      /Only PROCESS equipment is occupied by a batch \(L-27; EBMR-PLANT-062\)/,
    );
    // The press's first use is started and ended; a new use naming a use of another unit is refused.
    const first = await w.startUse(press.code, 'U-2', product);
    await w.run(w.cast.operator, (c) => plant.endEquipmentUse(c, first));
    const press2 = await w.press();
    await w.clean('EQUIPMENT', press2.code, 'MAJOR');
    const foreign = await w.startUse(press2.code, 'U-3', product);
    expect(await refusal(asOwner(w.cast.operator, (c) => c.query(ins, [press.id, foreign, b, product, cleaning])))).toMatch(
      /A use follows the latest use of the unit \(INV-12; EBMR-PLANT-064\)/,
    );
  });

  it('[INV-15][IN-26][PR-25] an occupancy of a room: concurrent batches only in a segregated room; an exclusive one follows the latest occupancy, which has ended', async () => {
    const product = await w.product();
    const plain = await w.room();
    const segregated = await w.room({ segregated: true, segregationJustification: 'RA-1: closed processing' });
    await w.clean('AREA', plain.code, 'MAJOR');
    await w.clean('AREA', segregated.code, 'MAJOR');
    const clPlain = await w.clear(plain.code, 'PRODUCT_CHANGE', { batch: 'O-1', product });
    const clSeg = await w.clear(segregated.code, 'PRODUCT_CHANGE', { batch: 'O-2', product });
    const b = (await w.batch('O-1', product)).id;
    const ins = `insert into plant.area_occupancy (area_id, exclusive, previous_occupancy_id, batch_id, batch_ref, product_code, stage, clearance_id, started_by)
                 values ($1, $2, $3, $4, 'O-1', $5, 'COMPRESSION', $6, gen_random_uuid())`;
    // A non-exclusive occupancy: refused in the plain room, accepted in the segregated one (rolled back).
    expect(await refusal(asOwner(w.cast.operator, (c) => c.query(ins, [plain.id, false, null, b, product, clPlain])))).toMatch(
      /Only a segregated room holds concurrent batches \(IN-26 \(b\); EBMR-PLANT-124\)/,
    );
    expect(await refusal(asOwner(w.cast.operator, (c) => c.query(ins, [segregated.id, false, null, b, product, clSeg])))).toBe('(not refused)');
    // An exclusive occupancy of the plain room while its latest occupancy is open, or naming another room's occupancy.
    const open = await w.startIn(plain.code, { batch: 'O-1', product });
    const other = await w.startIn(segregated.code, { batch: 'O-2', product });
    const room3 = await w.room();
    await w.clean('AREA', room3.code, 'MAJOR');
    const cl3 = await w.clear(room3.code, 'PRODUCT_CHANGE', { batch: 'O-3', product });
    expect(await refusal(asOwner(w.cast.operator, (c) => c.query(ins, [plain.id, true, open, b, product, cl3])))).toMatch(
      /The area is occupied by an open batch or order \(PR-35, INV-15; EBMR-PLANT-130\)/,
    );
    expect(await refusal(asOwner(w.cast.operator, (c) => c.query(ins, [plain.id, true, other, b, product, cl3])))).toMatch(
      /An occupancy follows the latest occupancy of the area \(INV-15; EBMR-PLANT-130\)/,
    );
  });

  it('[IN-25] a repair verification names the REPAIRED event of the repaired unit, written by the verifier, even for owner-level inserts', async () => {
    const press = await w.press();
    const other = await w.press();
    await w.run(w.cast.operator, (c) => plant.signalFailure(c, press.code, 'B-RV', 'feeder jam'));
    const repair = await w.run(w.cast.tech, (c) => plant.recordRepair(c, press.code, 'feeder cleared', `WO-${tag()}`));
    const verify = (kind: string, unit: string, eventBy: SeededActor, verifier: SeededActor) =>
      refusal(
        asOwner(verifier, (c) =>
          c.query(
            `with e as (insert into plant.equipment_event (equipment_id, kind, reference, detail, person_id, account_id)
                        values ($1, $2, 'WO-X', 'x', $3, $4) returning id)
             insert into plant.equipment_repair_verification (repair_id, repaired_event_id, verified_by, signature_id)
             select $5, e.id, $6, gen_random_uuid() from e`,
            [unit, kind, eventBy.personId, eventBy.accountId, repair, verifier.personId],
          ),
        ),
      );
    expect(await verify('MAINTENANCE_ENDED', press.id, w.cast.tech2, w.cast.tech2)).toMatch(/names the REPAIRED event of the repaired unit \(EBMR-PLANT-033\)/);
    expect(await verify('REPAIRED', other.id, w.cast.tech2, w.cast.tech2)).toMatch(/names the REPAIRED event of the repaired unit \(EBMR-PLANT-033\)/);
    // The REPAIRED event is the verifier's own act.
    expect(await verify('REPAIRED', press.id, w.cast.verifier, w.cast.tech2)).toMatch(/EBMR-PLANT-032/);
    expect(await verify('REPAIRED', press.id, w.cast.tech2, w.cast.tech2)).toBe('(not refused)');
  });
});

describe('the guards of the plant machines read the aggregate they are asked about', () => {
  it('[IN-25] VERIFY_CLEANING and ABANDON_CLEANING need the unit\'s own cleaning in that state, START_CLEANING its own open cleaning', async () => {
    const press = await w.press();
    const id = await w.run(w.cast.tech, (c) => plant.startCleaning(c, 'EQUIPMENT', press.code, 'MAJOR'));
    expect(await transition(w.cast.tech2, 'equipment_cleanliness', 'plant_equipment', press.id, 'VERIFY_CLEANING')).toMatch(/the cleaning has not been verified/);
    expect(await transition(w.cast.tech, 'equipment_cleanliness', 'plant_equipment', press.id, 'ABANDON_CLEANING', REASON)).toMatch(/the cleaning has not been abandoned/);
    await w.run(w.cast.tech, (c) => plant.completeCleaning(c, id));
    // A unit DIRTY and never cleaned, while an open cleaning of another unit is the latest one anywhere.
    const fresh = await w.press();
    const busy = await w.press();
    await w.run(w.cast.tech, (c) => plant.startCleaning(c, 'EQUIPMENT', busy.code, 'MINOR'));
    expect(await transition(w.cast.tech, 'equipment_cleanliness', 'plant_equipment', fresh.id, 'START_CLEANING')).toMatch(/no cleaning was started/);
    // A room never cleaned, while an equipment cleaning is the latest one anywhere.
    const room = await w.room();
    expect(await transition(w.cast.tech, 'area_status', 'plant_area', room.id, 'START_CLEANING')).toMatch(/no cleaning was started/);
  });

  it('[INV-15][IN-21] CLEAR needs a passed, verified, unused clearance of the area itself, performed after its last occupancy or cleaning', async () => {
    const product = await w.product();
    // A passed, verified clearance of another room exists.
    const elsewhere = await w.room();
    await w.clean('AREA', elsewhere.code, 'MAJOR');
    await w.clear(elsewhere.code, 'PRODUCT_CHANGE', { batch: 'CL-0', product });
    // This room is CLEAN with no clearance of its own: CLEAR is refused.
    const room = await w.room();
    await w.clean('AREA', room.code, 'MAJOR');
    expect(await transition(w.cast.verifier, 'area_status', 'plant_area', room.id, 'CLEAR')).toMatch(/no passed clearance has been verified/);
    // A FAILED verified clearance of the room does not clear it either.
    await w.clear(room.code, 'PRODUCT_CHANGE', { batch: 'CL-1', product }, 'FAILED');
    expect(await transition(w.cast.verifier, 'area_status', 'plant_area', room.id, 'CLEAR')).toMatch(/no passed clearance has been verified/);
    // A clearance already used by an occupancy, or performed before the last cleaning, does not count.
    await w.clear(room.code, 'PRODUCT_CHANGE', { batch: 'CL-2', product });
    const occ = await w.startIn(room.code, { batch: 'CL-2', product });
    await w.run(w.cast.operator, (c) => plant.endAreaOccupancy(c, occ));
    await w.clean('AREA', room.code, 'MAJOR');
    expect(await transition(w.cast.verifier, 'area_status', 'plant_area', room.id, 'CLEAR')).toMatch(/no passed clearance has been verified/);
  });

  it('[INV-15] a clearance is checked against the last occupancy or cleaning of its own area: a later batch in another room does not void it', async () => {
    const product = await w.product();
    const room = await w.room();
    await w.clean('AREA', room.code, 'MAJOR');
    const id = await w.recordClearance(room.code, 'PRODUCT_CHANGE', { batch: 'LE-1', product });
    // Another room is cleaned, cleared and started after this clearance was performed.
    const other = await w.room();
    await w.clean('AREA', other.code, 'MAJOR');
    await w.clear(other.code, 'PRODUCT_CHANGE', { batch: 'LE-2', product });
    await w.startIn(other.code, { batch: 'LE-2', product });
    const sig = await w.sign(w.cast.verifier, 'plant_clearance', id, 'VERIFIED', 'PERFORMED');
    await w.run(w.cast.verifier, (c) => plant.verifyClearance(c, id, sig));
    expect(await w.state('area', room.id)).toBe('CLEARED_FOR_BATCH');
  });
});

describe('each refusal of the commands, on its own', () => {
  it('[IN-25] a cleaning names a known target, level and method; an unknown, completed or abandoned cleaning is not completed again', async () => {
    const press = await w.press();
    expect(await refusal(w.run(w.cast.tech, (c) => plant.startCleaning(c, 'EQUIPMENT', press.code, 'MEDIUM' as plant.CleaningLevel)))).toMatch(/EBMR-PLANT-040/);
    expect(await refusal(w.run(w.cast.tech, (c) => plant.startCleaning(c, 'EQUIPMENT', press.code, 'MAJOR', 'STEAM' as 'CIP')))).toMatch(/EBMR-PLANT-040/);
    expect(await refusal(w.run(w.cast.tech, (c) => plant.startCleaning(c, 'TANK' as 'AREA', press.code, 'MAJOR')))).toMatch(/EBMR-PLANT-040/);
    expect(await refusal(w.run(w.cast.tech, (c) => plant.completeCleaning(c, randomUUID())))).toMatch(/is not in progress \(EBMR-PLANT-044\)/);
    const id = await w.run(w.cast.tech, (c) => plant.startCleaning(c, 'EQUIPMENT', press.code, 'MAJOR'));
    await w.run(w.cast.tech, (c) => plant.completeCleaning(c, id));
    expect(await refusal(w.run(w.cast.tech, (c) => plant.completeCleaning(c, id)))).toMatch(/is not in progress \(EBMR-PLANT-044\)/);
    const press2 = await w.press();
    const ab = await w.run(w.cast.tech, (c) => plant.startCleaning(c, 'EQUIPMENT', press2.code, 'MAJOR'));
    await w.run(w.cast.tech, (c) => plant.abandonCleaning(c, ab), REASON);
    expect(await refusal(w.run(w.cast.tech, (c) => plant.completeCleaning(c, ab)))).toMatch(/is not in progress \(EBMR-PLANT-044\)/);
  });

  it('[IN-25] only a completed cleaning neither verified nor abandoned is verified; only an open one is abandoned, with both reason fields', async () => {
    const press = await w.press();
    const sig = randomUUID();
    expect(await refusal(w.run(w.cast.tech2, (c) => plant.verifyCleaning(c, randomUUID(), sig)))).toMatch(/is not awaiting verification.*EBMR-PLANT-046/);
    const started = await w.run(w.cast.tech, (c) => plant.startCleaning(c, 'EQUIPMENT', press.code, 'MAJOR'));
    expect(await refusal(w.run(w.cast.tech2, (c) => plant.verifyCleaning(c, started, sig)))).toMatch(/is not awaiting verification.*EBMR-PLANT-046/);
    await w.run(w.cast.tech, (c) => plant.abandonCleaning(c, started), REASON);
    expect(await refusal(w.run(w.cast.tech2, (c) => plant.verifyCleaning(c, started, sig)))).toMatch(/is not awaiting verification.*EBMR-PLANT-046/);
    expect(await refusal(w.run(w.cast.tech, (c) => plant.abandonCleaning(c, started), REASON))).toMatch(/is closed \(EBMR-PLANT-049\)/);
    expect(await refusal(w.run(w.cast.tech, (c) => plant.abandonCleaning(c, randomUUID()), REASON))).toMatch(/is closed \(EBMR-PLANT-049\)/);
    const verified = await w.clean('EQUIPMENT', press.code, 'MAJOR');
    expect(await refusal(w.run(w.cast.tech2, (c) => plant.verifyCleaning(c, verified, sig)))).toMatch(/is not awaiting verification.*EBMR-PLANT-046/);
    expect(await refusal(w.run(w.cast.tech, (c) => plant.abandonCleaning(c, verified), REASON))).toMatch(/is closed \(EBMR-PLANT-049\)/);
    // The reason code alone is not enough.
    const open = await w.run(w.cast.tech, (c) => plant.startCleaning(c, 'EQUIPMENT', press.code, 'MAJOR'));
    expect(await refusal(w.run(w.cast.tech, (c) => plant.abandonCleaning(c, open), { reasonCode: 'EQUIPMENT_FAULT' }))).toMatch(/EBMR-PLANT-049|reason/);
  });

  it('[IN-25] a cleaning records whether the dirty-hold was exceeded: never for a CLEAN unit, never for a room', async () => {
    const press = await w.press();
    await w.clean('EQUIPMENT', press.code, 'MAJOR');
    const again = await w.run(w.cast.tech, (c) => plant.startCleaning(c, 'EQUIPMENT', press.code, 'MINOR'));
    const room = await w.room();
    const roomCleaning = await w.run(w.cast.tech, (c) => plant.startCleaning(c, 'AREA', room.code, 'MAJOR'));
    const rows = await q<{ id: string; dirty_hold_exceeded: boolean }>('select id, dirty_hold_exceeded from plant.cleaning where id = any($1) order by started_at', [
      [again, roomCleaning],
    ]);
    expect(rows.map((r) => r.dirty_hold_exceeded)).toEqual([false, false]);
  });

  it('[IN-25][PR-23] a calibration, an instrument use and an equipment use state a due instant or planned end; an empty one is refused with its own code', async () => {
    const press = await w.press({ calibrationRequired: true });
    expect(await refusal(asOwner(w.cast.tech, (c) => c.query("select plant.record_calibration($1, null, 'PASS', 'PASS', 'CAL-N')", [press.code])))).toMatch(
      /A calibration states a due instant in the future \(EBMR-PLANT-024\)/,
    );
    const instrument = await w.equipment({ kind: 'INSTRUMENT', checkRegime: 'PER_USE' });
    const b = (await w.batch('PE-1', await w.product())).id;
    expect(await refusal(asOwner(w.cast.operator, (c) => c.query('select plant.record_instrument_use($1, $2, null)', [instrument.code, b])))).toMatch(
      /planned end, in the future \(EBMR-PLANT-060\)/,
    );
    expect(await refusal(asOwner(w.cast.operator, (c) => c.query('select plant.start_equipment_use($1, $2, null)', [press.code, b])))).toMatch(
      /planned end, in the future \(EBMR-PLANT-060\)/,
    );
  });

  it('[IN-25][PR-23] a calibration due exactly at the planned end does not cover the use', async () => {
    const instrument = await w.equipment({ kind: 'INSTRUMENT', checkRegime: 'PER_USE' }, { calibratedForSeconds: 30 * DAY });
    const due = (await q<{ t: string }>('select to_char(due_at at time zone \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') as t from plant.calibration where equipment_id = $1', [instrument.id]))[0]?.t ?? '';
    const b = (await w.batch('CAL-EQ', await w.product())).id;
    await w.run(w.cast.operator, (c) => plant.recordInstrumentCheck(c, instrument.code, 'PASS', `CHK-${tag()}`, b));
    expect(await refusal(w.run(w.cast.operator, (c) => plant.recordInstrumentUse(c, instrument.code, b, due)))).toMatch(/its calibration is due at .* before the planned end/);
  });

  it('[IN-25] a fitness reads the unit\'s own out-of-service events: a unit returned to service is qualified again', async () => {
    const press = await w.press();
    await w.run(w.cast.tech, (c) => plant.recordEquipmentEvent(c, press.code, 'TAKEN_OUT_OF_SERVICE', 'inspection'));
    expect(await plant.equipmentFitness(db.app, press.id)).toBe('OUT_OF_SERVICE');
    await w.run(w.cast.tech, (c) => plant.recordEquipmentEvent(c, press.code, 'RETURNED_TO_SERVICE', 'inspected'));
    expect(await plant.equipmentFitness(db.app, press.id)).toBe('QUALIFIED');
  });

  it('[IN-26][PR-27] a unit or room has one open campaign; a campaign elsewhere does not block it; a campaign is closed once', async () => {
    const product = await w.product();
    const a = await w.press();
    const b = await w.press();
    const def = (code: string) => ({ equipmentCode: code, product, maxBatches: 3, maxDays: 10, validationRef: `VAL-${tag()}` });
    const campB = await w.run(w.cast.steward, (c) => plant.openCampaign(c, def(b.code)));
    const campA = await w.run(w.cast.steward, (c) => plant.openCampaign(c, def(a.code)));
    expect(await refusal(w.run(w.cast.steward, (c) => plant.openCampaign(c, def(a.code))))).toMatch(/one open campaign at a time.*EBMR-PLANT-080/);
    await w.run(w.cast.steward, (c) => plant.closeCampaign(c, campA, 'run finished'));
    expect(await refusal(w.run(w.cast.steward, (c) => plant.closeCampaign(c, campA, 'again')))).toMatch(/is not open \(EBMR-PLANT-082\)/);
    expect(campB).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('[INV-15][IN-21][PR-34] a clearance records PASSED or FAILED in a CLEAN area (or alongside a batch in a segregated room), of the type its area takes', async () => {
    const product = await w.product();
    const room = await w.room();
    await w.clean('AREA', room.code, 'MAJOR');
    const b = (await w.batch('RC-1', product)).id;
    const rec = (area: string, type: plant.ClearanceType, result: string | null, order?: string, art?: string) =>
      refusal(asOwner(w.cast.operator, (c) => c.query('select plant.record_clearance($1, $2, $3, $4, $5, $6)', [area, type, b, result, order ?? null, art ?? null])));
    expect(await rec(room.code, 'PRODUCT_CHANGE', null)).toMatch(/PASSED or FAILED \(EBMR-PLANT-103\)/);
    expect(await rec(room.code, 'PACKAGING_ORDER', 'PASSED')).toMatch(/A room clearance is a PRODUCT_CHANGE or CAMPAIGN clearance.*EBMR-PLANT-101/);
    expect(await rec(room.code, 'PRODUCT_CHANGE', 'PASSED', 'PO-1')).toMatch(/A room clearance.*EBMR-PLANT-101/);
    expect(await rec(room.code, 'PRODUCT_CHANGE', 'PASSED', undefined, 'ART-1')).toMatch(/A room clearance.*EBMR-PLANT-101/);
    const line = await w.room({ kind: 'LINE' });
    await w.clean('AREA', line.code, 'MAJOR');
    expect(await rec(line.code, 'PACKAGING_ORDER', 'PASSED', 'PO-1')).toMatch(/A line clearance is a PACKAGING_ORDER clearance.*EBMR-PLANT-101/);
    expect(await rec(line.code, 'PACKAGING_ORDER', 'PASSED', undefined, 'ART-1')).toMatch(/A line clearance.*EBMR-PLANT-101/);
    expect(await rec(line.code, 'PRODUCT_CHANGE', 'PASSED', 'PO-1', 'ART-1')).toMatch(/A line clearance.*EBMR-PLANT-101/);
    // A plain room in use, and a segregated room that is DIRTY, take no clearance.
    await w.clear(room.code, 'PRODUCT_CHANGE', { batch: 'RC-1', product });
    await w.startIn(room.code, { batch: 'RC-1', product });
    expect(await rec(room.code, 'PRODUCT_CHANGE', 'PASSED')).toMatch(/EBMR-PLANT-100/);
    const seg = await w.room({ segregated: true, segregationJustification: 'RA-2' });
    expect(await rec(seg.code, 'PRODUCT_CHANGE', 'PASSED')).toMatch(/EBMR-PLANT-100/);
  });

  it('[INV-15][IN-21] a clearance is verified once; a second verification is refused as already verified', async () => {
    const product = await w.product();
    const room = await w.room();
    await w.clean('AREA', room.code, 'MAJOR');
    const id = await w.clear(room.code, 'PRODUCT_CHANGE', { batch: 'VC-1', product });
    expect(await refusal(w.run(w.cast.verifier, (c) => plant.verifyClearance(c, id, randomUUID())))).toMatch(/is already verified \(EBMR-PLANT-102\)/);
  });

  it('[INV-15][IN-26][PR-34][PR-35] a start names its batch and stage, a line start its order and artwork set, a room start neither', async () => {
    const product = await w.product();
    const room = await w.room();
    const line = await w.room({ kind: 'LINE' });
    const b = (await w.batch('ST-1', product)).id;
    const start = (area: string, stage: string, order?: string, art?: string) =>
      refusal(asOwner(w.cast.operator, (c) => c.query('select plant.start_area_occupancy($1, $2, $3, $4, $5)', [area, b, stage, order ?? null, art ?? null])));
    expect(await start(room.code, ' ')).toMatch(/names the batch and the stage \(EBMR-PLANT-120\)/);
    expect(await start(line.code, 'PACKAGING', 'PO-1')).toMatch(/names the packaging order and its artwork set.*EBMR-PLANT-121/);
    expect(await start(line.code, 'PACKAGING', undefined, 'ART-1')).toMatch(/names the packaging order and its artwork set.*EBMR-PLANT-121/);
    expect(await start(room.code, 'COMPRESSION', undefined, 'ART-1')).toMatch(/Packaging orders run on lines \(EBMR-PLANT-121\)/);
    expect(await start(room.code, 'COMPRESSION', 'PO-1')).toMatch(/Packaging orders run on lines \(EBMR-PLANT-121\)/);
  });

  it('[INV-15][PR-25] a plain room in use refuses another batch of its own product as in use, naming the batch in it, whatever other rooms hold', async () => {
    const x = await w.product();
    const y = await w.product();
    // Another room holds an open batch of another product, started first.
    const other = await w.room();
    await w.clean('AREA', other.code, 'MAJOR');
    await w.clear(other.code, 'PRODUCT_CHANGE', { batch: 'IU-0', product: y });
    await w.startIn(other.code, { batch: 'IU-0', product: y });
    const room = await w.room();
    await w.clean('AREA', room.code, 'MAJOR');
    await w.clear(room.code, 'PRODUCT_CHANGE', { batch: 'IU-1', product: x });
    const first = await w.batch('IU-1', x);
    await w.startIn(room.code, { batch: 'IU-1', product: x });
    const msg = await refusal(w.startIn(room.code, { batch: 'IU-2', product: x }));
    expect(msg).toMatch(new RegExp(`is in use by batch ${first.number}: release, clean and clear it first.*EBMR-PLANT-125`));
  });

  it('[INV-15][PR-26][IN-26] a room start takes a clearance of the required type, recorded for this batch: a CAMPAIGN clearance does not stand for a product change', async () => {
    const x = await w.product();
    const room = await w.room();
    await w.clean('AREA', room.code, 'MAJOR');
    // The first batch in a room is a product change; a passed CAMPAIGN clearance is not the clearance it needs.
    await w.clear(room.code, 'CAMPAIGN', { batch: 'RT-1', product: x });
    expect(await refusal(w.startIn(room.code, { batch: 'RT-1', product: x }))).toMatch(/has no passed PRODUCT_CHANGE clearance for batch .*EBMR-PLANT-127/);
  });

  it('[IN-26] a product change in a room reads the latest verified cleaning of that room', async () => {
    const x = await w.product();
    const room = await w.room();
    await w.clean('AREA', room.code, 'MINOR');
    await w.clear(room.code, 'PRODUCT_CHANGE', { batch: 'MC-1', product: x });
    // Another room's MAJOR cleaning is verified later; it does not stand for this room's.
    const other = await w.room();
    await w.clean('AREA', other.code, 'MAJOR');
    // A cleaning still open in a third room (not verified) is not this room's either.
    const third = await w.room();
    await w.run(w.cast.tech, (c) => plant.startCleaning(c, 'AREA', third.code, 'MAJOR'));
    expect(await refusal(w.startIn(room.code, { batch: 'MC-1', product: x }))).toMatch(/a product change needs a MAJOR cleaning of the area; the last one was MINOR.*EBMR-PLANT-128/);
  });

  it('[INV-15] an occupancy is ended once', async () => {
    const x = await w.product();
    const room = await w.room();
    await w.clean('AREA', room.code, 'MAJOR');
    await w.clear(room.code, 'PRODUCT_CHANGE', { batch: 'EO-1', product: x });
    const occ = await w.startIn(room.code, { batch: 'EO-1', product: x });
    await w.run(w.cast.operator, (c) => plant.endAreaOccupancy(c, occ));
    expect(await refusal(w.run(w.cast.operator, (c) => plant.endAreaOccupancy(c, occ)))).toMatch(/has ended \(EBMR-PLANT-129\)/);
  });

  it('[IN-25] a repair answers the unit\'s open failure, states what was done and cites its work order; an event on another unit does not hide the failure', async () => {
    const press = await w.press();
    expect(await refusal(w.run(w.cast.tech, (c) => plant.recordRepair(c, press.code, 'nothing', 'WO-0')))).toMatch(/has no open failure to repair \(EBMR-PLANT-021\)/);
    await w.run(w.cast.operator, (c) => plant.signalFailure(c, press.code, 'B-OF', 'cam broken'));
    // A later event of another unit.
    const other = await w.press();
    await w.run(w.cast.tech, (c) => plant.recordEquipmentEvent(c, other.code, 'MAINTENANCE_STARTED', 'routine'));
    expect(await refusal(w.run(w.cast.tech, (c) => plant.recordRepair(c, press.code, 'cam replaced', ' ')))).toMatch(/cites its work order \(EBMR-PLANT-031\)/);
    const repair = await w.run(w.cast.tech, (c) => plant.recordRepair(c, press.code, 'cam replaced', `WO-${tag()}`));
    const sig = await w.sign(tech3, 'plant_equipment_repair', repair, 'LOGBOOK_DOUBLE_CHECKED', 'RECORDED');
    await w.run(tech3, (c) => plant.verifyRepair(c, repair, sig));
    expect(await plant.equipmentFitness(db.app, press.id)).toBe('QUALIFIED');
    // The failure is repaired: no open failure is left to repair.
    expect(await refusal(w.run(w.cast.tech, (c) => plant.recordRepair(c, press.code, 'again', 'WO-1')))).toMatch(/has no open failure to repair \(EBMR-PLANT-021\)/);
  });

  it('[IN-25] a repair recorded before another failure was signalled does not answer the open failure', async () => {
    const press = await w.press();
    await w.run(w.cast.operator, (c) => plant.signalFailure(c, press.code, 'B-F1', 'first'));
    const repair = await w.run(w.cast.tech, (c) => plant.recordRepair(c, press.code, 'fixed', `WO-${tag()}`));
    await w.run(w.cast.operator, (c) => plant.signalFailure(c, press.code, 'B-F2', 'second'));
    const sig = await w.sign(tech3, 'plant_equipment_repair', repair, 'LOGBOOK_DOUBLE_CHECKED', 'RECORDED');
    expect(await refusal(w.run(tech3, (c) => plant.verifyRepair(c, repair, sig)))).toMatch(/does not answer the unit's open failure.*EBMR-PLANT-033/);
  });

  it('[IN-25] a utility problem names a code that is not a utility, known or not', async () => {
    const press = await w.press();
    expect(await plant.utilityProblem(db.app, press.code)).toBe(`${press.code} is not a utility`);
    expect(await plant.utilityProblem(db.app, `NOPE-${tag()}`)).toMatch(/^NOPE-.* is not a utility$/);
  });

  it('[IN-25] a room defined without the flags is neither segregated nor under negative pressure', async () => {
    const room = await w.room();
    expect(await q('select segregated, negative_pressure from plant.area where id = $1', [room.id])).toEqual([{ segregated: false, negative_pressure: false }]);
  });
});

describe('the commands lock the unit or area they act on', () => {
  it('[INV-12][IN-25] calibration, checks, uses, readings, events, repairs and cleanings of a unit lock its row', async () => {
    const product = await w.product();
    const press = await w.press({ calibrationRequired: true });
    const due = await dbIn(db, 90 * DAY);
    expect(await locksRow('plant.equipment', press.id, w.cast.tech, (c) => plant.recordCalibration(c, press.code, due, 'PASS', 'PASS', `CAL-${tag()}`))).toBe(true);
    const instrument = await w.equipment({ kind: 'INSTRUMENT', checkRegime: 'PER_USE' });
    const b = (await w.batch('LK-1', product)).id;
    expect(await locksRow('plant.equipment', instrument.id, w.cast.operator, (c) => plant.recordInstrumentCheck(c, instrument.code, 'PASS', 'CHK-L', b))).toBe(true);
    await w.run(w.cast.operator, (c) => plant.recordInstrumentCheck(c, instrument.code, 'PASS', `CHK-${tag()}`, b));
    const end = await dbIn(db, 3600);
    expect(await locksRow('plant.equipment', instrument.id, w.cast.operator, (c) => plant.recordInstrumentUse(c, instrument.code, b, end))).toBe(true);
    const hvac = await w.equipment({ kind: 'UTILITY', calibrationRequired: false });
    const at = await dbIn(db, 0);
    expect(await locksRow('plant.equipment', hvac.id, w.cast.feed, (c) => plant.recordUtilityReading(c, hvac.code, 'OK', 'BMS', at))).toBe(true);
    expect(await locksRow('plant.equipment', press.id, w.cast.tech, (c) => plant.recordEquipmentEvent(c, press.code, 'MAINTENANCE_STARTED', 'routine'))).toBe(true);
    // Cleaning: start, complete (by the cleaning's unit), and use.
    expect(await locksRow('plant.equipment', press.id, w.cast.tech, (c) => plant.startCleaning(c, 'EQUIPMENT', press.code, 'MAJOR'))).toBe(true);
    const cl = await w.run(w.cast.tech, (c) => plant.startCleaning(c, 'EQUIPMENT', press.code, 'MAJOR'));
    expect(await locksRow('plant.equipment', press.id, w.cast.tech, (c) => plant.completeCleaning(c, cl))).toBe(true);
    await w.run(w.cast.tech, (c) => plant.completeCleaning(c, cl));
    const sig = await w.sign(w.cast.tech2, 'plant_cleaning', cl, 'LOGBOOK_DOUBLE_CHECKED', 'COMPLETED');
    await w.run(w.cast.tech2, (c) => plant.verifyCleaning(c, cl, sig));
    const b2 = (await w.batch('LK-2', product)).id;
    expect(await locksRow('plant.equipment', press.id, w.cast.operator, (c) => plant.startEquipmentUse(c, press.code, b2, end))).toBe(true);
    const use = await w.run(w.cast.operator, (c) => plant.startEquipmentUse(c, press.code, b2, end));
    expect(await locksRow('plant.equipment', press.id, w.cast.operator, (c) => plant.endEquipmentUse(c, use))).toBe(true);
    // Repair: record and verify.
    const p2 = await w.press();
    await w.run(w.cast.operator, (c) => plant.signalFailure(c, p2.code, 'B-LK', 'jam'));
    expect(await locksRow('plant.equipment', p2.id, w.cast.tech, (c) => plant.recordRepair(c, p2.code, 'cleared', 'WO-L'))).toBe(true);
    const repair = await w.run(w.cast.tech, (c) => plant.recordRepair(c, p2.code, 'cleared', `WO-${tag()}`));
    const rsig = await w.sign(tech3, 'plant_equipment_repair', repair, 'LOGBOOK_DOUBLE_CHECKED', 'RECORDED');
    expect(await locksRow('plant.equipment', p2.id, tech3, (c) => plant.verifyRepair(c, repair, rsig))).toBe(true);
  });

  it('[INV-15][IN-21] campaigns, cleanings, clearances and occupancies of a room lock its row', async () => {
    const product = await w.product();
    const room = await w.room();
    expect(
      await locksRow('plant.area', room.id, w.cast.steward, (c) => plant.openCampaign(c, { areaCode: room.code, product, maxBatches: 2, maxDays: 5, validationRef: 'VAL-L' })),
    ).toBe(true);
    expect(await locksRow('plant.area', room.id, w.cast.tech, (c) => plant.startCleaning(c, 'AREA', room.code, 'MAJOR'))).toBe(true);
    const cl = await w.run(w.cast.tech, (c) => plant.startCleaning(c, 'AREA', room.code, 'MAJOR'));
    expect(await locksRow('plant.area', room.id, w.cast.tech, (c) => plant.completeCleaning(c, cl))).toBe(true);
    await w.run(w.cast.tech, (c) => plant.completeCleaning(c, cl));
    const sig = await w.sign(w.cast.tech2, 'plant_cleaning', cl, 'LOGBOOK_DOUBLE_CHECKED', 'COMPLETED');
    await w.run(w.cast.tech2, (c) => plant.verifyCleaning(c, cl, sig));
    const b = (await w.batch('LA-1', product)).id;
    expect(await locksRow('plant.area', room.id, w.cast.operator, (c) => plant.recordClearance(c, room.code, 'PRODUCT_CHANGE', { batchId: b, result: 'PASSED' }))).toBe(true);
    const clr = await w.recordClearance(room.code, 'PRODUCT_CHANGE', { batch: 'LA-1', product });
    const csig = await w.sign(w.cast.verifier, 'plant_clearance', clr, 'VERIFIED', 'PERFORMED');
    expect(await locksRow('plant.area', room.id, w.cast.verifier, (c) => plant.verifyClearance(c, clr, csig))).toBe(true);
    await w.run(w.cast.verifier, (c) => plant.verifyClearance(c, clr, csig));
    expect(await locksRow('plant.area', room.id, w.cast.operator, (c) => plant.startAreaOccupancy(c, room.code, { batchId: b, stage: 'COMPRESSION' }))).toBe(true);
    const occ = await w.startIn(room.code, { batch: 'LA-1', product });
    expect(await locksRow('plant.area', room.id, w.cast.operator, (c) => plant.endAreaOccupancy(c, occ))).toBe(true);
  });
});

describe('what the readers compute', () => {
  it('[IN-25] a unit is dirty since its own first DIRTY entry after its last verified cleaning', async () => {
    const product = await w.product();
    const press = await w.press();
    await w.clean('EQUIPMENT', press.code, 'MAJOR');
    const use = await w.startUse(press.code, 'DS-1', product);
    await w.run(w.cast.operator, (c) => plant.endEquipmentUse(c, use));
    // Another unit becomes dirty afterwards.
    const other = await w.press();
    await w.clean('EQUIPMENT', other.code, 'MAJOR');
    await w.run(w.cast.operator, async (c) => plant.endEquipmentUse(c, await plant.startEquipmentUse(c, other.code, (await w.batch('DS-2', product)).id, await dbIn(db, 3600))));
    const [row] = await q<{ since: string; expected: string }>(
      `select plant.dirty_since($1)::text as since,
              (select recorded_at::text from platform.state_history where aggregate_type = 'plant_equipment' and aggregate_id = $1 and event = 'END_USE'
               order by to_version desc limit 1) as expected`,
      [press.id],
    );
    expect(row?.since).toBe(row?.expected);
  });

  it('[IN-25][PR-23] an as-found failure lists exactly the uses of its own unit since the unit\'s last as-found PASS, and a PASS lists none', async () => {
    const product = await w.product();
    const instrument = await w.equipment({ kind: 'INSTRUMENT', checkRegime: 'PER_USE' }); // calibrated, as-found PASS
    const other = await w.equipment({ kind: 'INSTRUMENT', checkRegime: 'PER_USE' });
    const use = async (code: string, label: string): Promise<string> => {
      const b = (await w.batch(label, product)).id;
      await w.run(w.cast.operator, (c) => plant.recordInstrumentCheck(c, code, 'PASS', `CHK-${tag()}`, b));
      await w.run(w.cast.operator, async (c) => plant.recordInstrumentUse(c, code, b, await dbIn(db, 3600)));
      return (await w.batch(label, product)).number;
    };
    const u1 = await use(instrument.code, 'AF-1');
    // An as-found FAIL that left the unit in tolerance, and a PASS calibration of another unit.
    await w.calibrate(instrument.code, 180 * DAY, 'FAIL', 'PASS');
    await w.calibrate(other.code, 180 * DAY);
    const u2 = await use(instrument.code, 'AF-2');
    await use(other.code, 'AF-X');
    const fail = await w.calibrate(instrument.code, 180 * DAY, 'FAIL', 'PASS');
    await use(instrument.code, 'AF-3');
    const pass = await w.calibrate(instrument.code, 180 * DAY);
    const affected = await q<{ batch_ref: string; use_kind: string }>('select batch_ref, use_kind from plant.calibration_affected_batches($1)', [fail]);
    expect(affected).toEqual([
      { batch_ref: u1, use_kind: 'INSTRUMENT_USE' },
      { batch_ref: u2, use_kind: 'INSTRUMENT_USE' },
    ]);
    expect(await q('select * from plant.calibration_affected_batches($1)', [pass])).toEqual([]);
    // PROCESS uses of a press that needs calibration, as for an instrument.
    const press = await w.press({ calibrationRequired: true });
    await w.clean('EQUIPMENT', press.code, 'MAJOR');
    const pu = await w.startUse(press.code, 'AF-P', product);
    await w.run(w.cast.operator, (c) => plant.endEquipmentUse(c, pu));
    const pressOther = await w.press({ calibrationRequired: true });
    await w.clean('EQUIPMENT', pressOther.code, 'MAJOR');
    await w.startUse(pressOther.code, 'AF-Q', product);
    const pfail = await w.calibrate(press.code, 180 * DAY, 'FAIL', 'PASS');
    expect(await q<{ batch_ref: string; use_kind: string }>('select batch_ref, use_kind from plant.calibration_affected_batches($1)', [pfail])).toEqual([
      { batch_ref: (await w.batch('AF-P', product)).number, use_kind: 'PROCESS_USE' },
    ]);
  });

  it('[IN-25][PR-23] an instrument rests on its own passing daily check of today, or on its own unused passing per-use check for this batch', async () => {
    const product = await w.product();
    const end = await dbIn(db, 3600);
    const problems = async (id: string, batch: string): Promise<string[]> =>
      ((await q<{ a: { problems: string[] } }>('select plant.instrument_use_assessment($1, $2, $3::timestamptz) as a', [id, batch, end]))[0]?.a.problems ?? []);
    const daily = await w.equipment({ kind: 'INSTRUMENT', checkRegime: 'DAILY' });
    const dailyOther = await w.equipment({ kind: 'INSTRUMENT', checkRegime: 'DAILY' });
    const b1 = (await w.batch('IA-1', product)).id;
    await w.run(w.cast.operator, (c) => plant.recordInstrumentCheck(c, dailyOther.code, 'PASS', `CHK-${tag()}`));
    expect(await problems(daily.id, b1)).toContain('it has no passing daily check today');
    await w.run(w.cast.operator, (c) => plant.recordInstrumentCheck(c, daily.code, 'FAIL', `CHK-${tag()}`));
    expect(await problems(daily.id, b1)).toContain('it has no passing daily check today');
    const perUse = await w.equipment({ kind: 'INSTRUMENT', checkRegime: 'PER_USE' });
    const perUseOther = await w.equipment({ kind: 'INSTRUMENT', checkRegime: 'PER_USE' });
    const b2 = await w.batch('IA-2', product);
    await w.run(w.cast.operator, (c) => plant.recordInstrumentCheck(c, perUse.code, 'PASS', `CHK-${tag()}`, b1));
    await w.run(w.cast.operator, (c) => plant.recordInstrumentCheck(c, perUseOther.code, 'PASS', `CHK-${tag()}`, b2.id));
    expect(await problems(perUse.id, b2.id)).toContain(`it has no unused passing check for batch ${b2.number}`);
    expect(await problems(perUse.id, b1)).toEqual([]);
  });

  it('[IN-26][PR-27] a campaign check reads the open campaign of this product on this unit or room, and the MAJOR cleaning and batches of that unit or room only', async () => {
    const x = await w.product();
    const y = await w.product();
    const check = async (eq: string | null, area: string | null, product: string) =>
      (await q<{ r: { ok: boolean; reason?: string; batch_number?: number } }>('select plant.campaign_check($1, $2, $3) as r', [eq, area, product]))[0]?.r;
    const camp = (def: Partial<plant.CampaignDefinition>) =>
      w.run(w.cast.steward, (c) => plant.openCampaign(c, { product: x, maxBatches: 5, maxDays: 10, validationRef: `VAL-${tag()}`, ...def } as plant.CampaignDefinition));
    // Press B has an open campaign of X; press A has a closed campaign of X and an open one of Y.
    const a = await w.press();
    const b = await w.press();
    await camp({ equipmentCode: b.code });
    const closed = await camp({ equipmentCode: a.code });
    await w.run(w.cast.steward, (c) => plant.closeCampaign(c, closed, 'done'));
    await camp({ equipmentCode: a.code, product: y });
    expect(await check(a.id, null, x)).toEqual({ ok: false, reason: `no campaign of ${x} is open` });
    // Press C has an open campaign of X but no MAJOR cleaning, while press B has one.
    await w.clean('EQUIPMENT', b.code, 'MAJOR');
    const c3 = await w.press();
    await camp({ equipmentCode: c3.code });
    expect(await check(c3.id, null, x)).toEqual({ ok: false, reason: 'no MAJOR cleaning starts the run' });
    // Rooms: room R's campaign counts R's batches since its MAJOR cleaning, not another room's.
    const r = await w.room();
    await w.clean('AREA', r.code, 'MAJOR');
    await camp({ areaCode: r.code });
    const r2 = await w.room();
    await w.clean('AREA', r2.code, 'MAJOR');
    await w.clear(r2.code, 'PRODUCT_CHANGE', { batch: 'CC-0', product: x });
    await w.startIn(r2.code, { batch: 'CC-0', product: x });
    expect(await check(null, r.id, x)).toMatchObject({ ok: true, batch_number: 1 });
    // A room never cleaned MAJOR has no run.
    const r3 = await w.room();
    await camp({ areaCode: r3.code });
    expect(await check(null, r3.id, x)).toEqual({ ok: false, reason: 'no MAJOR cleaning starts the run' });
  });

  it('[IN-25][INV-12] a use assessment names the open use of its own unit, and the clean-hold of its own last verified cleaning', async () => {
    const product = await w.product();
    // Another press is in use first.
    const other = await w.press();
    await w.clean('EQUIPMENT', other.code, 'MAJOR');
    await w.startUse(other.code, 'UA-0', product);
    const press = await w.press();
    const cl = await w.clean('EQUIPMENT', press.code, 'MAJOR');
    // A cleaning left open on a third unit.
    const third = await w.press();
    await w.run(w.cast.tech, (c) => plant.startCleaning(c, 'EQUIPMENT', third.code, 'MAJOR'));
    const end = await dbIn(db, 3600);
    const [a] = await q<{ a: { clean_hold_until: string; cleaning_id: string } }>('select plant.equipment_use_assessment($1, $2, $3::timestamptz) as a', [press.id, product, end]);
    const [expected] = await q<{ t: string }>(
      `select recipe.utc_text(c.verified_at + k.clean_hold) as t from plant.cleaning_status c join plant.equipment e on e.id = c.equipment_id
       join plant.equipment_class k on k.code = e.class_code where c.id = $1`,
      [cl],
    );
    expect(a?.a.cleaning_id).toBe(cl);
    expect(a?.a.clean_hold_until).toBe(expected?.t);
    await w.startUse(press.code, 'UA-1', product);
    const batch = await w.batch('UA-1', product);
    const [b] = await q<{ a: { problems: string[] } }>('select plant.equipment_use_assessment($1, $2, $3::timestamptz) as a', [press.id, product, end]);
    expect(b?.a.problems).toContain(`it is in use by batch ${batch.number} (INV-12)`);
  });

  it('[IN-25][PR-23] a use that ends inside its clean-hold, calibration and plan crosses nothing', async () => {
    const product = await w.product();
    const press = await w.press({ calibrationRequired: true });
    await w.clean('EQUIPMENT', press.code, 'MAJOR');
    const use = await w.startUse(press.code, 'NC-1', product);
    const r = await w.run(w.cast.operator, (c) => plant.endEquipmentUse(c, use));
    expect(r).toEqual({ use_id: use, clean_hold_crossed: false, calibration_crossed: false, campaign_crossed: false, overran_plan: false });
  });

  it('[IN-25] the signed content of a cleaning: version 1 while started, 2 once completed; a manual cleaning names who entered it, a CIP cleaning nobody', async () => {
    const manual = await w.press();
    const id = await w.run(w.cast.tech, (c) => plant.startCleaning(c, 'EQUIPMENT', manual.code, 'MAJOR'));
    const content = async (cid: string) => (await q<{ c: { content_version: number; entered_by: string[] } }>('select plant.cleaning_content($1) as c', [cid]))[0]?.c;
    expect(await content(id)).toMatchObject({ content_version: 1, entered_by: [w.cast.tech.personId] });
    await w.run(w.cast.tech2, (c) => plant.completeCleaning(c, id));
    expect(await content(id)).toMatchObject({ content_version: 2, entered_by: [w.cast.tech.personId, w.cast.tech2.personId] });
    const cip = await w.press({ cipValidationRef: 'CIP-VAL-1' });
    const cid = await w.run(w.cast.tech, (c) => plant.startCleaning(c, 'EQUIPMENT', cip.code, 'MAJOR', 'CIP'));
    expect(await content(cid)).toMatchObject({ content_version: 1, entered_by: [] });
  });
});
