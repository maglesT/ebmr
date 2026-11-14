/**
 * PROCESS equipment, instruments and utilities (outline 5.2.8): cleaning with a different verifier, the use guard
 * (INV-12, IN-25 (b)(c)(d), PR-23), campaigns (IN-26 (a), PR-27), fitness, and the refusal of every write that does not
 * come through the plant commands. Every write runs as ebmr_app inside a validated command.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedAdministration } from '../../../kernel/test/identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import * as plant from '../../src/plant/index.ts';
import { dbIn, DAY, finishBatch, PlantWorld, seedPlantCast, sleep, tag } from './support.ts';
import { asTimeTraveller, run } from '../../../kernel/test/esig/helpers.ts';
import { withSecondRole } from '../lifecycle/support.ts';

let db: TestDatabase;
let w: PlantWorld;

beforeAll(async () => {
  db = await createTestDatabase();
  w = new PlantWorld(db, await seedPlantCast(db));
}, 300_000);

afterAll(async () => {
  await db.drop();
});

describe('cleanliness and the use guard of PROCESS equipment', () => {
  it('[IN-25][PR-23][INV-12][PR-24] a new press is DIRTY and blocked; cleaned, verified by a second person and within its clean-hold it is used by one batch at a time', async () => {
    const press = await w.press();
    const product = await w.product();
    expect(await w.state('equipment', press.id)).toBe('DIRTY');
    await expect(w.startUse(press.code, 'B-1', product)).rejects.toThrow(/DIRTY: to be cleaned.*EBMR-PLANT-061/);
    await w.clean('EQUIPMENT', press.code, 'MAJOR');
    expect(await w.state('equipment', press.id)).toBe('CLEAN');
    const use = await w.startUse(press.code, 'B-1', product);
    expect(await w.state('equipment', press.id)).toBe('IN_PRODUCT');
    // INV-12: idle is required; a second batch is refused while the first one occupies the press.
    await expect(w.startUse(press.code, 'B-2', product)).rejects.toThrow(/in use by batch TEST-B-1-\w+ \(INV-12\)/);
    const ended = await w.run(w.cast.operator, (c) => plant.endEquipmentUse(c, use));
    expect(ended).toMatchObject({
      clean_hold_crossed: false,
      calibration_crossed: false,
    });
    expect(await w.state('equipment', press.id)).toBe('DIRTY');
    await expect(w.startUse(press.code, 'B-2', product)).rejects.toThrow(/DIRTY: to be cleaned/);
  });

  // Demo report 13 November 2026 (bug 4): a use no step of its batch names is ended from the Plant screen by whoever is on
  // the floor, not only by the person who started it; the right stays STEP.EXECUTE, whatever the batch's state.
  it('[INV-12][IN-25][DI-17] an open use is ended by any person holding STEP.EXECUTE for its product, not only the one who started it; a person without it is refused and the use stays open; ended, the unit is cleaned and used again', async () => {
    const press = await w.press();
    const product = await w.product();
    await w.clean('EQUIPMENT', press.code, 'MAJOR');
    const use = await w.startUse(press.code, 'B-1', product);
    await expect(w.run(w.cast.verifier, (c) => plant.endEquipmentUse(c, use))).rejects.toThrow(/EBMR-IAM-040/);
    expect(await w.state('equipment', press.id)).toBe('IN_PRODUCT');
    await expect(w.startUse(press.code, 'B-2', product)).rejects.toThrow(/EBMR-PLANT-061/);
    await w.run(w.cast.operator2, (c) => plant.endEquipmentUse(c, use));
    const { rows } = await db.admin.query<{ ended_by: string }>('select ended_by::text from plant.equipment_use_end where use_id = $1', [use]);
    expect(rows).toEqual([{ ended_by: w.cast.operator2.personId }]);
    await expect(w.run(w.cast.operator, (c) => plant.endEquipmentUse(c, use))).rejects.toThrow(/EBMR-PLANT-063/);
    await w.clean('EQUIPMENT', press.code, 'MAJOR');
    expect(await w.startUse(press.code, 'B-2', product)).toMatch(/^[0-9a-f-]{36}$/);
  });

  // Owner decision of 13 November 2026 on demo report bug 4: ending a use records the person's reason (recipe-core 1926).
  it('[DI-22][IN-25][INV-12] a use ended with a reason keeps it on its end row and in the audit trail; a blank reason is refused; the use of a finished or aborted batch is ended only with a reason; the application cannot write the reason around the command', async () => {
    const press = await w.press();
    const product = await w.product();
    await w.clean('EQUIPMENT', press.code, 'MAJOR');
    const use = await w.startUse(press.code, 'B-R1', product);
    const endWith = (who: typeof w.cast.operator, reason: string | null) => w.run(who, (c) => c.query('select plant.end_equipment_use($1, $2) as r', [use, reason]));
    await expect(endWith(w.cast.operator2, '   ')).rejects.toThrow(/EBMR-PLANT-065/);
    // The batch is finished (test setup: the execution state as the engine leaves it at EXECUTION_COMPLETE).
    await finishBatch(db, (await w.batch('B-R1', product)).id, 'EXECUTION_COMPLETE');
    await expect(w.run(w.cast.operator2, (c) => plant.endEquipmentUse(c, use))).rejects.toThrow(/batch TEST-B-R1-\w+ is EXECUTION_COMPLETE.*EBMR-PLANT-065/);
    expect(await w.state('equipment', press.id)).toBe('IN_PRODUCT');
    await endWith(w.cast.operator2, 'Batch finished; the use was left open on the Plant screen');
    const { rows } = await db.admin.query<{ reason: string; ended_by: string }>('select reason, ended_by::text from plant.equipment_use_end where use_id = $1', [use]);
    expect(rows).toEqual([{ reason: 'Batch finished; the use was left open on the Plant screen', ended_by: w.cast.operator2.personId }]);
    const audit = await db.admin.query<{ message: string; reason: string; person: string }>(
      `select payload -> 'body' ->> 'message' as message, payload -> 'body' -> 'details' ->> 'reason' as reason, payload -> 'actor' ->> 'person_id' as person
         from kernel.audit_event where action = 'BUSINESS' and chain_key = $1 and payload -> 'body' -> 'details' ->> 'use_id' = $2`,
      [`plant_equipment:${press.id}`, use],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ reason: 'Batch finished; the use was left open on the Plant screen', person: w.cast.operator2.personId });
    expect(audit.rows[0]?.message).toContain(press.code);
    // The reason is written only by the command: the application role cannot insert or change an end row.
    await expect(w.run(w.cast.operator, (c) => c.query("update plant.equipment_use_end set reason = 'other' where use_id = $1", [use]))).rejects.toThrow(/permission denied|EBMR-AUDIT-004/);
    // A use of a batch still running is ended without a reason, as the step screen does.
    await w.clean('EQUIPMENT', press.code, 'MAJOR');
    const next = await w.startUse(press.code, 'B-R2', product);
    await w.run(w.cast.operator, (c) => plant.endEquipmentUse(c, next));
    await finishBatch(db, (await w.batch('B-R3', product)).id, 'ABORTED');
    await w.clean('EQUIPMENT', press.code, 'MAJOR');
    const aborted = await w.startUse(press.code, 'B-R3', product);
    await expect(w.run(w.cast.operator, (c) => plant.endEquipmentUse(c, aborted))).rejects.toThrow(/is ABORTED.*EBMR-PLANT-065/);
  });

  it('[INV-12] overlapping occupancies of one PROCESS unit are refused by the database even for owner-level writes: the use chain admits one open use, and the exclusion constraint refuses overlapping closed intervals with every trigger off', async () => {
    const press = await w.press();
    const product = await w.product();
    const cleaning = await w.clean('EQUIPMENT', press.code, 'MAJOR');
    const use = await w.startUse(press.code, 'B-X', product);
    const y = (await w.batch('B-Y', product)).id;
    const ins = `insert into plant.equipment_use (equipment_id, previous_use_id, batch_id, batch_ref, product_code, planned_end, cleaning_id, started_by)
                 values ($1, $2, $5, 'B-Y', $3, clock_timestamp() + interval '1 day', $4, gen_random_uuid())`;
    // A second use naming no predecessor, or the open use as its predecessor: both refused.
    await expect(db.admin.query(ins, [press.id, null, product, cleaning, y])).rejects.toThrow(/EBMR-PLANT-064|equipment_use_equipment_id_previous_use_id_key/);
    await expect(db.admin.query(ins, [press.id, use, product, cleaning, y])).rejects.toThrow(/open use: PROCESS occupancy never overlaps.*EBMR-PLANT-064/);
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      await c.query("set local session_replication_role = 'replica'");
      const end = `insert into plant.equipment_use_end (use_id, equipment_id, started_at, ended_by, ended_at, clean_hold_crossed, calibration_crossed,
                                                        campaign_crossed, overran_plan)
                   values ($1, $2, $3::timestamptz, gen_random_uuid(), $4::timestamptz, false, false, false, false)`;
      await c.query(end, [use, press.id, '2026-10-01T08:00:00Z', '2026-10-01T12:00:00Z']);
      const other = (
        await c.query<{ id: string }>(
          `insert into plant.equipment_use (equipment_id, previous_use_id, batch_id, batch_ref, product_code, planned_end, cleaning_id, started_by)
        values ($1, $2, $5, 'B-Y', $3, clock_timestamp() + interval '1 day', $4, gen_random_uuid()) returning id`,
          [press.id, use, product, cleaning, y],
        )
      ).rows[0]?.id;
      await expect(c.query(end, [other, press.id, '2026-10-01T11:00:00Z', '2026-10-01T13:00:00Z'])).rejects.toThrow(/equipment_use_no_overlap/);
    } finally {
      await c.query('rollback');
      c.release();
    }
  });

  it("[IN-25][PR-23] wait past a press's clean-hold: the next batch cannot use it until it is cleaned again", async () => {
    // 4 s, not 1: on a GitHub-hosted runner the second cleaning and the use took over 1 s, so the hold had expired again
    // before the use that must be accepted (EBMR-PLANT-061, run 42470816675).
    const press = await w.press({ cleanHold: '4 seconds' });
    const product = await w.product();
    await w.clean('EQUIPMENT', press.code, 'MAJOR');
    await sleep(db, 4.2);
    await expect(w.startUse(press.code, 'B-H1', product)).rejects.toThrow(/clean-hold expired at .*clean it again.*EBMR-PLANT-061/);
    expect(await w.state('equipment', press.id)).toBe('CLEAN');
    await w.clean('EQUIPMENT', press.code, 'MAJOR');
    await expect(w.startUse(press.code, 'B-H1', product)).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });

  it('[IN-25] a use that outlasts the clean-hold or the calibration is recorded as having crossed them when it ends (D-S1-5)', async () => {
    const press = await w.press({
      cleanHold: '1 second',
      calibrationRequired: true,
      // 6 s, not 2: the set-up below (product, cleaning) took over 1.3 s on a GitHub-hosted runner, which put the planned
      // end (1 s after the start) past the due time and refused the use (EBMR-PLANT-061). The margin is now about 5 s.
      calibratedForSeconds: 6,
    });
    const product = await w.product();
    await w.clean('EQUIPMENT', press.code, 'MAJOR');
    // The planned end is inside the calibration; the use itself runs past both.
    const use = await w.startUse(press.code, 'B-C1', product, 1);
    await sleep(db, 6.2);
    const ended = await w.run(w.cast.operator, (c) => plant.endEquipmentUse(c, use));
    // Evaluated against the actual end, which passed the planned end too.
    expect(ended).toMatchObject({
      clean_hold_crossed: true,
      calibration_crossed: true,
      overran_plan: true,
      campaign_crossed: false,
    });
  });

  it('[IN-25] a press dirty for longer than its dirty-hold accepts only a MAJOR cleaning', async () => {
    const press = await w.press({ dirtyHold: '1 second' });
    await sleep(db, 1.2);
    await expect(w.run(w.cast.tech, (c) => plant.startCleaning(c, 'EQUIPMENT', press.code, 'MINOR'))).rejects.toThrow(
      /past its dirty-hold.*only a MAJOR cleaning.*EBMR-PLANT-043/,
    );
    const id = await w.clean('EQUIPMENT', press.code, 'MAJOR');
    const { rows } = await db.app.query<{ x: boolean }>('select dirty_hold_exceeded as x from plant.cleaning where id = $1', [id]);
    expect(rows[0]?.x).toBe(true);
  });

  it('[IN-25] abandoning a cleaning does not restart the dirty-hold clock: past the dirty-hold, a MAJOR cleaning abandoned leaves MINOR refused', async () => {
    const press = await w.press({ dirtyHold: '1 second' });
    await sleep(db, 1.2);
    const id = await w.run(w.cast.tech, (c) => plant.startCleaning(c, 'EQUIPMENT', press.code, 'MAJOR'));
    await w.run(w.cast.tech, (c) => plant.abandonCleaning(c, id), { reasonCode: 'EQUIPMENT_FAULT', reasonText: 'washer pump failed' });
    expect(await w.state('equipment', press.id)).toBe('DIRTY');
    await expect(w.run(w.cast.tech, (c) => plant.startCleaning(c, 'EQUIPMENT', press.code, 'MINOR'))).rejects.toThrow(
      /past its dirty-hold.*only a MAJOR cleaning.*EBMR-PLANT-043/,
    );
  });

  it('[IN-25] the same person cannot clean and verify: refused in the command, by the signature service and by the table', async () => {
    const press = await w.press();
    const id = await w.run(w.cast.tech, (c) => plant.startCleaning(c, 'EQUIPMENT', press.code, 'MAJOR'));
    await w.run(w.cast.tech, (c) => plant.completeCleaning(c, id));
    // The performer cannot even sign: the signature service knows who entered the record.
    await expect(w.sign(w.cast.tech, 'plant_cleaning', id, 'LOGBOOK_DOUBLE_CHECKED', 'COMPLETED')).rejects.toThrow(/EBMR-ESIG/);
    // A signature by someone else presented by the performer is refused before it is looked at.
    const sig = await w.sign(w.cast.tech2, 'plant_cleaning', id, 'LOGBOOK_DOUBLE_CHECKED', 'COMPLETED');
    await expect(w.run(w.cast.tech, (c) => plant.verifyCleaning(c, id, sig))).rejects.toThrow(/other than the one who performed it.*EBMR-PLANT-047/);
    // And by the table: a verification row written by the owner naming the performer is refused by its trigger.
    await expect(
      db.admin.query('insert into plant.cleaning_verification (cleaning_id, verified_by, signature_id) values ($1, $2, gen_random_uuid())', [
        id,
        w.cast.tech.personId,
      ]),
    ).rejects.toThrow(/EBMR-PLANT-047/);
    await w.run(w.cast.tech2, (c) => plant.verifyCleaning(c, id, sig));
    expect(await w.state('equipment', press.id)).toBe('CLEAN');
  });

  it('[IN-25] CIP is accepted only on a unit whose class has a validated CIP program: one person cannot CIP-clean a unit of any other class', async () => {
    const press = await w.press();
    await expect(w.run(w.cast.tech, (c) => plant.startCleaning(c, 'EQUIPMENT', press.code, 'MAJOR', 'CIP'))).rejects.toThrow(
      /no validated CIP program.*S22.*EBMR-PLANT-050/,
    );
    // Not even an owner-level insert: the table refuses it.
    await expect(
      db.admin.query(
        "insert into plant.cleaning (equipment_id, level, method, dirty_hold_exceeded, started_by) values ($1, 'MAJOR', 'CIP', false, gen_random_uuid())",
        [press.id],
      ),
    ).rejects.toThrow(/EBMR-PLANT-050/);
    expect(await w.state('equipment', press.id)).toBe('DIRTY');
  });

  it('[IN-25] a validated CIP cleaning cites its cycle record and needs one verifier', async () => {
    const press = await w.press({ cipValidationRef: 'CIP-VAL-2026-03' });
    const id = await w.run(w.cast.tech, (c) => plant.startCleaning(c, 'EQUIPMENT', press.code, 'MAJOR', 'CIP'));
    await expect(w.run(w.cast.tech, (c) => plant.completeCleaning(c, id))).rejects.toThrow(/EBMR-PLANT-045/);
    await w.run(w.cast.tech, (c) => plant.completeCleaning(c, id, 'CIP-RUN-0042'));
    const sig = await w.sign(w.cast.tech2, 'plant_cleaning', id, 'LOGBOOK_DOUBLE_CHECKED', 'COMPLETED');
    await w.run(w.cast.tech2, (c) => plant.verifyCleaning(c, id, sig));
    expect(await w.state('equipment', press.id)).toBe('CLEAN');
  });

  it('[IN-25] an abandoned cleaning returns the unit to DIRTY with its reason', async () => {
    const press = await w.press();
    const id = await w.run(w.cast.tech, (c) => plant.startCleaning(c, 'EQUIPMENT', press.code, 'MAJOR'));
    await expect(w.run(w.cast.tech, (c) => plant.abandonCleaning(c, id))).rejects.toThrow(/EBMR-PLANT-049/);
    await w.run(w.cast.tech, (c) => plant.abandonCleaning(c, id), {
      reasonCode: 'EQUIPMENT_FAULT',
      reasonText: 'detergent supply failed',
    });
    expect(await w.state('equipment', press.id)).toBe('DIRTY');
    const { rows } = await db.app.query<{ reason: string }>('select reason from plant.cleaning_abandonment where cleaning_id = $1', [id]);
    expect(rows[0]?.reason).toBe('detergent supply failed');
  });
});

describe('product change and campaigns (IN-26 (a), PR-27)', () => {
  it('[IN-26][PR-27] a product change needs a MAJOR cleaning; the same product follows a MINOR cleaning only inside an open, validated campaign within its maximum batches', async () => {
    const press = await w.press();
    const a = await w.product();
    const b = await w.product();
    await w.clean('EQUIPMENT', press.code, 'MAJOR');
    const u1 = await w.startUse(press.code, 'A-1', a, 3600);
    await w.run(w.cast.operator, (c) => plant.endEquipmentUse(c, u1));
    // Same product, no campaign: MINOR is not enough.
    await w.clean('EQUIPMENT', press.code, 'MINOR');
    await expect(w.startUse(press.code, 'A-2', a)).rejects.toThrow(/MAJOR cleaning is required \(no campaign of .* is open\)/);
    // A campaign needs its validation reference.
    await expect(
      w.run(w.cast.steward, (c) =>
        plant.openCampaign(c, {
          equipmentCode: press.code,
          product: a,
          maxBatches: 2,
          maxDays: 5,
          validationRef: ' ',
        }),
      ),
    ).rejects.toThrow(/EBMR-PLANT-081/);
    await w.run(w.cast.steward, (c) =>
      plant.openCampaign(c, {
        equipmentCode: press.code,
        product: a,
        maxBatches: 2,
        maxDays: 5,
        validationRef: 'CV-PRESS-2026-07',
      }),
    );
    // The run opened before the campaign: still MAJOR. A MAJOR cleaning starts a run inside the campaign.
    await expect(w.startUse(press.code, 'A-2', a)).rejects.toThrow(/run began before the campaign was opened/);
    await w.clean('EQUIPMENT', press.code, 'MAJOR');
    const u2 = await w.startUse(press.code, 'A-2', a);
    await w.run(w.cast.operator, (c) => plant.endEquipmentUse(c, u2));
    await w.clean('EQUIPMENT', press.code, 'MINOR');
    const u3 = await w.startUse(press.code, 'A-3', a);
    const { rows } = await db.app.query<{ campaign_id: string | null }>('select campaign_id from plant.equipment_use where id = $1', [u3]);
    expect(rows[0]?.campaign_id).not.toBeNull();
    await w.run(w.cast.operator, (c) => plant.endEquipmentUse(c, u3));
    // Batch 3 of a 2-batch campaign: MAJOR required.
    await w.clean('EQUIPMENT', press.code, 'MINOR');
    await expect(w.startUse(press.code, 'A-4', a)).rejects.toThrow(/allows 2 batches between MAJOR cleanings; this would be batch 3/);
    // Product B after a MINOR cleaning: refused; after MAJOR: accepted.
    await expect(w.startUse(press.code, 'B-1', b)).rejects.toThrow(/MAJOR cleaning is required \(product change from/);
    await w.clean('EQUIPMENT', press.code, 'MAJOR');
    await expect(w.startUse(press.code, 'B-1', b)).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });

  /** Moves the run's first use, its MAJOR cleaning and the campaign back in time (test setup, triggers off). */
  async function backdate(pressId: string, campaignId: string, by: string): Promise<void> {
    await asTimeTraveller(
      db,
      `update plant.equipment_use set started_at = started_at - $2::interval, planned_end = planned_end - $2::interval where equipment_id = $1`,
      [pressId, by],
    );
    await asTimeTraveller(
      db,
      `update plant.equipment_use_end set started_at = started_at - $2::interval, ended_at = ended_at - $2::interval where equipment_id = $1`,
      [pressId, by],
    );
    await asTimeTraveller(
      db,
      `update plant.cleaning_verification set verified_at = verified_at - $2::interval
        where cleaning_id in (select id from plant.cleaning where equipment_id = $1 and level = 'MAJOR')`,
      [pressId, by],
    );
    await asTimeTraveller(db, `update plant.campaign set opened_at = opened_at - $2::interval where id = $1`, [campaignId, by]);
  }

  async function campaignRun(maxDays: number) {
    const press = await w.press();
    const a = await w.product();
    const campaign = await w.run(w.cast.steward, (c) =>
      plant.openCampaign(c, { equipmentCode: press.code, product: a, maxBatches: 10, maxDays, validationRef: 'CV-2' }),
    );
    await w.clean('EQUIPMENT', press.code, 'MAJOR');
    const u1 = await w.startUse(press.code, 'A-1', a);
    await w.run(w.cast.operator, (c) => plant.endEquipmentUse(c, u1));
    return { press, a, campaign };
  }

  it("[IN-26][PR-27] outside the campaign's maximum days from its first batch a MAJOR cleaning is required, however short the planned end", async () => {
    const { press, a, campaign } = await campaignRun(2);
    await backdate(press.id, campaign, '3 days');
    await w.clean('EQUIPMENT', press.code, 'MINOR');
    await expect(w.startUse(press.code, 'A-2', a, 60)).rejects.toThrow(/allows 2 days from its first batch/);
    await w.clean('EQUIPMENT', press.code, 'MAJOR');
    await expect(w.startUse(press.code, 'A-2', a, 60)).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });

  it('[IN-26][PR-27] a campaign batch that runs past the campaign window and its planned end is recorded as crossing both when it ends (D-S1-5)', async () => {
    const { press, a, campaign } = await campaignRun(1);
    // The run's first batch started 1 day less 6 seconds ago: the window closes in 6 seconds.
    await backdate(press.id, campaign, '86394 seconds');
    await w.clean('EQUIPMENT', press.code, 'MINOR');
    const u2 = await w.startUse(press.code, 'A-2', a, 1);
    await sleep(db, 6.5);
    const ended = await w.run(w.cast.operator, (c) => plant.endEquipmentUse(c, u2));
    expect(ended).toMatchObject({ campaign_crossed: true, overran_plan: true });
  });
});

describe('the batch, not the caller, names the product (IN-26, PR-27)', () => {
  it('[IN-26][PR-27] a unit last used for product X refuses a batch of product Y after a MINOR cleaning, whatever product the caller has in mind: the product is read from the batch record', async () => {
    const press = await w.press();
    const x = await w.product();
    const y = await w.product();
    await w.run(w.cast.steward, (c) => plant.openCampaign(c, { equipmentCode: press.code, product: x, maxBatches: 5, maxDays: 5, validationRef: 'CV-X' }));
    await w.clean('EQUIPMENT', press.code, 'MAJOR');
    const u1 = await w.startUse(press.code, 'X-1', x);
    await w.run(w.cast.operator, (c) => plant.endEquipmentUse(c, u1));
    await w.clean('EQUIPMENT', press.code, 'MINOR');
    await expect(w.startUse(press.code, 'Y-1', y)).rejects.toThrow(new RegExp(`MAJOR cleaning is required \\(product change from ${x}\\)`));
    const { rows } = await db.app.query<{ product_code: string; batch_ref: string }>('select product_code, batch_ref from plant.equipment_use where id = $1', [
      u1,
    ]);
    expect(rows[0]).toEqual({ product_code: x, batch_ref: (await w.batch('X-1', x)).number });
    // A batch whose product the plant does not know, or an unknown batch, is refused.
    await expect(w.startUse(press.code, 'Z-1', 'NOT-IN-PLANT')).rejects.toThrow(/Unknown product NOT-IN-PLANT.*EBMR-PLANT-012/);
    await expect(
      w.run(w.cast.operator, async (c) => plant.startEquipmentUse(c, press.code, '00000000-0000-4000-8000-000000000000', await dbIn(db, 60))),
    ).rejects.toThrow(/Unknown batch.*EBMR-PLANT-014/);
  });
});

describe('fitness: qualification, calibration, maintenance, failure (IN-25 (b)(d), PR-23)', () => {
  it('[IN-25][PR-23] a balance with calibration past due is blocked; a calibration that does not cover the planned end is blocked too', async () => {
    const balance = await w.equipment({ kind: 'INSTRUMENT', checkRegime: 'DAILY' }, { calibratedForSeconds: 1 });
    const product = await w.product();
    const ids: Record<string, string> = { 'B-W1': (await w.batch('B-W1', product)).id };
    await w.run(w.cast.operator, (c) => plant.recordInstrumentCheck(c, balance.code, 'PASS', 'DAILY-CHECK-1'));
    // Planned end after the due instant.
    await expect(w.run(w.cast.operator, async (c) => plant.recordInstrumentUse(c, balance.code, ids['B-W1'] ?? '', await dbIn(db, 3600)))).rejects.toThrow(
      /calibration is due at .* before the planned end.*EBMR-PLANT-061/,
    );
    await sleep(db, 1.2);
    expect(await plant.equipmentFitness(db.app, balance.id)).toBe('CALIBRATION_OVERDUE');
    await expect(w.run(w.cast.operator, async (c) => plant.recordInstrumentUse(c, balance.code, ids['B-W1'] ?? '', await dbIn(db, 60)))).rejects.toThrow(
      /the unit is CALIBRATION_OVERDUE.*IN-25/,
    );
    await w.calibrate(balance.code, 90 * DAY);
    await expect(w.run(w.cast.operator, async (c) => plant.recordInstrumentUse(c, balance.code, ids['B-W1'] ?? '', await dbIn(db, 60)))).resolves.toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });

  it('[IN-25][PR-23] one hardness tester serves two presses at once (no occupancy); each use needs its own passing per-use check', async () => {
    const tester = await w.equipment({
      kind: 'INSTRUMENT',
      checkRegime: 'PER_USE',
    });
    const product = await w.product();
    const ids: Record<string, string> = {};
    for (const l of ['B-P1', 'B-P2', 'B-P3']) ids[l] = (await w.batch(l, product)).id;
    await w.run(w.cast.operator, (c) => plant.recordInstrumentCheck(c, tester.code, 'PASS', 'STD-WT-1', ids['B-P1']));
    await w.run(w.cast.operator, (c) => plant.recordInstrumentCheck(c, tester.code, 'PASS', 'STD-WT-2', ids['B-P2']));
    const end = await dbIn(db, 3600);
    await w.run(w.cast.operator, (c) => plant.recordInstrumentUse(c, tester.code, ids['B-P1'] ?? '', end));
    await w.run(w.cast.operator2, (c) => plant.recordInstrumentUse(c, tester.code, ids['B-P2'] ?? '', end));
    // The check of B-P1 is used up.
    await expect(w.run(w.cast.operator, (c) => plant.recordInstrumentUse(c, tester.code, ids['B-P1'] ?? '', end))).rejects.toThrow(
      /no unused passing check for batch TEST-B-P1-/,
    );
    // A failed check blocks every use until a passing one is recorded.
    await w.run(w.cast.operator, (c) => plant.recordInstrumentCheck(c, tester.code, 'FAIL', 'STD-WT-3', ids['B-P3']));
    await expect(w.run(w.cast.operator, (c) => plant.recordInstrumentUse(c, tester.code, ids['B-P3'] ?? '', end))).rejects.toThrow(
      /latest check \(STD-WT-3\) failed/,
    );
  });

  it('[IN-25][PR-23] an unqualified unit, a unit in maintenance and a unit out of tolerance are blocked', async () => {
    const product = await w.product();
    const unqualified = await w.equipment(
      {
        kind: 'PROCESS',
        cleanHold: '1 day',
        dirtyHold: '1 day',
        calibrationRequired: false,
      },
      { qualified: false },
    );
    await w.clean('EQUIPMENT', unqualified.code, 'MAJOR');
    await expect(w.startUse(unqualified.code, 'B-Q', product)).rejects.toThrow(/the unit is NOT_QUALIFIED/);

    const press = await w.press({ calibrationRequired: true });
    await w.clean('EQUIPMENT', press.code, 'MAJOR');
    await w.run(w.cast.tech, (c) => plant.recordEquipmentEvent(c, press.code, 'MAINTENANCE_STARTED', 'punch guide inspection'));
    await expect(w.startUse(press.code, 'B-M', product)).rejects.toThrow(/the unit is MAINTENANCE/);
    await w.run(w.cast.tech, (c) => plant.recordEquipmentEvent(c, press.code, 'MAINTENANCE_ENDED', 'inspection done'));
    await w.calibrate(press.code, 90 * DAY, 'FAIL', 'FAIL');
    await expect(w.startUse(press.code, 'B-M', product)).rejects.toThrow(/the unit is OUT_OF_TOLERANCE/);
  });

  it('[IN-25][PR-23] an as-found calibration failure lists every batch since the last good calibration', async () => {
    const balance = await w.equipment({
      kind: 'INSTRUMENT',
      checkRegime: 'DAILY',
    });
    const product = await w.product();
    await w.run(w.cast.operator, (c) => plant.recordInstrumentCheck(c, balance.code, 'PASS', 'DAILY'));
    const end = await dbIn(db, 600);
    for (const b of ['B-A1', 'B-A2']) {
      const id = (await w.batch(b, product)).id;
      await w.run(w.cast.operator, (c) => plant.recordInstrumentUse(c, balance.code, id, end));
    }
    const cal = await w.calibrate(balance.code, 90 * DAY, 'FAIL', 'PASS');
    const { rows } = await db.app.query<{ batch_ref: string }>('select batch_ref from plant.calibration_affected_batches($1)', [cal]);
    expect(rows.map((r) => r.batch_ref)).toEqual([(await w.batch('B-A1', product)).number, (await w.batch('B-A2', product)).number]);
  });

  it('[ST-03] a filling line past its requalification due date is blocked; once the due date is reset after the change, a batch may use it', async () => {
    // The line's requalification is its due date in the plant register (plan 4.1); after a change, QA resets it.
    const line = await w.press({ calibrationRequired: true, calibratedForSeconds: 1 });
    const product = await w.product();
    await w.clean('EQUIPMENT', line.code, 'MAJOR');
    await sleep(db, 1.2);
    expect(await plant.equipmentFitness(db.app, line.id)).toBe('CALIBRATION_OVERDUE');
    await expect(w.startUse(line.code, 'B-RQ', product)).rejects.toThrow(/the unit is CALIBRATION_OVERDUE/);
    await w.calibrate(line.code, 180 * DAY);
    expect(await plant.equipmentFitness(db.app, line.id)).toBe('QUALIFIED');
    await expect(w.startUse(line.code, 'B-RQ', product)).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });

  it('[ST-38] a compounding vessel past its clean-hold cannot be assigned to a batch until it is cleaned again', async () => {
    const vessel = await w.press({ cleanHold: '4 seconds' });
    const product = await w.product();
    await w.clean('EQUIPMENT', vessel.code, 'MAJOR');
    await sleep(db, 4.2);
    await expect(w.startUse(vessel.code, 'B-V1', product)).rejects.toThrow(/clean-hold expired at .*EBMR-PLANT-061/);
    await w.clean('EQUIPMENT', vessel.code, 'MAJOR');
    await expect(w.startUse(vessel.code, 'B-V1', product)).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });

  it('[ST-25][ST-26][ST-27] a point of use (WFI outlet, nitrogen drop, clean-steam point) is a unit whose status follows QC: taken out of service on a failed result it may not be used, returned to service on a passing one it may', async () => {
    const point = await w.equipment({ kind: 'UTILITY', calibrationRequired: false });
    expect(await plant.equipmentFitness(db.app, point.id)).toBe('QUALIFIED');
    await w.run(w.cast.tech, (c) => plant.recordEquipmentEvent(c, point.code, 'TAKEN_OUT_OF_SERVICE', 'QC: action-level result at the outlet'));
    expect(await plant.equipmentFitness(db.app, point.id)).toBe('OUT_OF_SERVICE');
    await w.run(w.cast.tech, (c) => plant.recordEquipmentEvent(c, point.code, 'RETURNED_TO_SERVICE', 'QC: resampling passed'));
    expect(await plant.equipmentFitness(db.app, point.id)).toBe('QUALIFIED');
  });

  it('[IN-25] a failure signalled from a step removes the unit from use until it is repaired', async () => {
    const press = await w.press();
    const product = await w.product();
    await w.clean('EQUIPMENT', press.code, 'MAJOR');
    await expect(w.run(w.cast.operator, (c) => plant.recordEquipmentEvent(c, press.code, 'FAILURE_SIGNALLED', 'turret vibration'))).rejects.toThrow(
      /names its batch/,
    );
    await w.run(w.cast.operator, (c) => plant.signalFailure(c, press.code, 'B-F0', 'turret vibration above limit'));
    expect(await plant.equipmentFitness(db.app, press.id)).toBe('OUT_OF_SERVICE');
    await expect(w.startUse(press.code, 'B-F1', product)).rejects.toThrow(/the unit is OUT_OF_SERVICE/);
    // The operator cannot record the repair; maintenance does, with a reference, and a second person verifies it (sql/0460).
    await expect(w.run(w.cast.operator, (c) => plant.recordRepair(c, press.code, 'fixed', 'WO-1'))).rejects.toThrow(/EBMR-IAM-040/);
    const repair = await w.run(w.cast.tech, (c) => plant.recordRepair(c, press.code, 'bearing replaced', 'WO-7781'));
    await expect(w.startUse(press.code, 'B-F1', product)).rejects.toThrow(/the unit is OUT_OF_SERVICE/);
    const sig = await w.sign(w.cast.tech2, 'plant_equipment_repair', repair, 'LOGBOOK_DOUBLE_CHECKED', 'RECORDED');
    await w.run(w.cast.tech2, (c) => plant.verifyRepair(c, repair, sig));
    await expect(w.startUse(press.code, 'B-F1', product)).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });

  it('[IN-25][PR-23] clearing a signalled failure needs a second person: the repairer and the person who signalled it cannot verify; a signed second person can', async () => {
    const press = await w.press();
    await w.clean('EQUIPMENT', press.code, 'MAJOR');
    // The operator who signals the failure also holds the maintenance role, so only the rule (not the permission) refuses him.
    const signaller = await withSecondRole(db, w.cast.operator2, 'MAINTENANCE_TECHNICIAN');
    await w.run(w.cast.operator2, (c) => plant.signalFailure(c, press.code, 'B-R0', 'punch breakage'));
    // One person can no longer clear the failure with a REPAIRED event.
    await expect(w.run(w.cast.tech, (c) => plant.recordEquipmentEvent(c, press.code, 'REPAIRED', 'punch replaced', 'WO-1'))).rejects.toThrow(/EBMR-PLANT-030/);
    const repair = await w.run(w.cast.tech, (c) => plant.recordRepair(c, press.code, 'punch set replaced', 'WO-9001'));
    expect(await plant.equipmentFitness(db.app, press.id)).toBe('OUT_OF_SERVICE');
    // The repairer cannot sign the check (a performer of the signed content), nor verify with another's signature.
    await expect(w.sign(w.cast.tech, 'plant_equipment_repair', repair, 'LOGBOOK_DOUBLE_CHECKED', 'RECORDED')).rejects.toThrow(/EBMR-ESIG/);
    const sig = await w.sign(w.cast.tech2, 'plant_equipment_repair', repair, 'LOGBOOK_DOUBLE_CHECKED', 'RECORDED');
    await expect(w.run(w.cast.tech, (c) => plant.verifyRepair(c, repair, sig))).rejects.toThrow(/EBMR-PLANT-032/);
    // The person who signalled the failure cannot sign or verify it either.
    await expect(w.sign(signaller, 'plant_equipment_repair', repair, 'LOGBOOK_DOUBLE_CHECKED', 'RECORDED')).rejects.toThrow(/EBMR-ESIG/);
    await expect(w.run(signaller, (c) => plant.verifyRepair(c, repair, sig))).rejects.toThrow(/EBMR-PLANT-032/);
    // Without a valid signature of the meaning on this repair, nothing is cleared.
    await expect(w.run(w.cast.tech2, (c) => plant.verifyRepair(c, repair, '00000000-0000-4000-8000-000000000009'))).rejects.toThrow(/EBMR-PLAT-008/);
    expect(await plant.equipmentFitness(db.app, press.id)).toBe('OUT_OF_SERVICE');
    // The signed second person clears it.
    const event = await w.run(w.cast.tech2, (c) => plant.verifyRepair(c, repair, sig));
    expect(event).toMatch(/^[0-9a-f-]{36}$/);
    expect(await plant.equipmentFitness(db.app, press.id)).toBe('QUALIFIED');
    const { rows } = await db.admin.query<{ verified_by: string; person_id: string }>(
      'select v.verified_by, e.person_id from plant.equipment_repair_verification v join plant.equipment_event e on e.id = v.repaired_event_id where v.repair_id = $1',
      [repair],
    );
    expect(rows).toEqual([{ verified_by: w.cast.tech2.personId, person_id: w.cast.tech2.personId }]);
    // The same repair is not verified twice.
    await expect(w.run(w.cast.tech2, (c) => plant.verifyRepair(c, repair, sig))).rejects.toThrow(/EBMR-PLANT-033/);
  });

  it('[IN-25] a repair cannot be cleared around the commands: no direct writes by the application, and the table refuses a lone REPAIRED event or a verification by the repairer even for owner-level writes', async () => {
    const press = await w.press();
    await w.run(w.cast.operator, (c) => plant.signalFailure(c, press.code, 'B-R1', 'feeder jam'));
    const repair = await w.run(w.cast.tech, (c) => plant.recordRepair(c, press.code, 'feeder cleared', 'WO-9002'));
    const event = "insert into plant.equipment_event (equipment_id, kind, reference, detail, person_id, account_id) values ($1, 'REPAIRED', 'WO-X', 'x', $2, $3)";
    // The application role writes none of the tables.
    await expect(db.app.query(event, [press.id, w.cast.tech.personId, w.cast.tech.accountId])).rejects.toThrow(/permission denied/);
    await expect(
      db.app.query(
        'insert into plant.equipment_repair_verification (repair_id, repaired_event_id, verified_by, signature_id) values ($1, gen_random_uuid(), $2, gen_random_uuid())',
        [repair, w.cast.tech2.personId],
      ),
    ).rejects.toThrow(/permission denied/);
    // Owner-level (superuser inside a validated command, triggers on): a REPAIRED event without its verification is refused at commit.
    const asOwner = { ...db, app: db.admin };
    await expect(run(asOwner, w.cast.tech, (c) => c.query(event, [press.id, w.cast.tech.personId, w.cast.tech.accountId]))).rejects.toThrow(/EBMR-PLANT-030/);
    // Owner-level: a verification by the repairer is refused by its row guard.
    await expect(
      run(asOwner, w.cast.tech, (c) =>
        c.query(
          `with e as (insert into plant.equipment_event (equipment_id, kind, reference, detail, person_id, account_id)
                      values ($1, 'REPAIRED', 'WO-X', 'x', $2, $3) returning id)
           insert into plant.equipment_repair_verification (repair_id, repaired_event_id, verified_by, signature_id)
           select $4, e.id, $2, gen_random_uuid() from e`,
          [press.id, w.cast.tech.personId, w.cast.tech.accountId, repair],
        ),
      ),
    ).rejects.toThrow(/EBMR-PLANT-032/);
    expect(await plant.equipmentFitness(db.app, press.id)).toBe('OUT_OF_SERVICE');
  });

  it('[IN-25] a utility is usable only while the latest feed status is OK', async () => {
    const hvac = await w.equipment({
      kind: 'UTILITY',
      calibrationRequired: false,
    });
    expect(await plant.utilityProblem(db.app, hvac.code)).toMatch(/latest feed status .* is missing/);
    const at = await dbIn(db, 0);
    await w.run(w.cast.feed, (c) => plant.recordUtilityReading(c, hvac.code, 'OK', 'BMS', at));
    expect(await plant.utilityProblem(db.app, hvac.code)).toBeNull();
    await w.run(w.cast.feed, (c) => plant.recordUtilityReading(c, hvac.code, 'ALARM', 'BMS', at));
    expect(await plant.utilityProblem(db.app, hvac.code)).toMatch(/is ALARM/);
    await expect(db.app.query('select plant.assert_utility_usable($1)', [hvac.code])).rejects.toThrow(/EBMR-PLANT-027/);
    // Only the feed's service identity writes readings.
    await expect(w.run(w.cast.operator, (c) => plant.recordUtilityReading(c, hvac.code, 'OK', 'manual', at))).rejects.toThrow(/EBMR-IAM-040/);
    // Instruments and utilities have no occupancy and no cleanliness.
    await expect(w.startUse(hvac.code, 'B-U', await w.product())).rejects.toThrow(/no occupancy.*EBMR-PLANT-062/);
    await expect(w.run(w.cast.tech, (c) => plant.startCleaning(c, 'EQUIPMENT', hvac.code, 'MAJOR'))).rejects.toThrow(/no cleanliness state/);
  });
});

describe('only the plant commands write (bypass attempts)', () => {
  it("[INV-12][IN-25] direct writes as the application role are refused, and a direct transition without the command's rows is refused by the guards", async () => {
    const press = await w.press();
    const product = await w.product();
    const cleaning = await w.clean('EQUIPMENT', press.code, 'MAJOR');
    await expect(
      w.run(w.cast.operator, (c) =>
        c.query(
          "insert into plant.equipment_use (equipment_id, batch_id, batch_ref, product_code, planned_end, cleaning_id, started_by) values ($1, gen_random_uuid(), 'B-Z', $2, clock_timestamp() + interval '1 hour', $3, gen_random_uuid())",
          [press.id, product, cleaning],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(w.run(w.cast.tech, (c) => c.query("update plant.cleaning set level = 'MAJOR' where id = $1", [cleaning]))).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      w.run(w.cast.tech2, (c) =>
        c.query('insert into plant.cleaning_verification (cleaning_id, verified_by, signature_id) values ($1, $2, gen_random_uuid())', [
          cleaning,
          w.cast.tech2.personId,
        ]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(w.run(w.cast.tech, (c) => c.query('delete from plant.cleaning where id = $1', [cleaning]))).rejects.toThrow(/permission denied/);
    await expect(
      w.run(w.cast.steward, (c) =>
        c.query(
          "insert into plant.calibration (equipment_id, due_at, as_found, as_left, reference, person_id, account_id) values ($1, clock_timestamp() + interval '1 year', 'PASS', 'PASS', 'x', gen_random_uuid(), gen_random_uuid())",
          [press.id],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
    // The state engine is reachable, but START_USE without a use row started through the guard is refused.
    const s = await plant.equipmentState(db.app, press.id);
    await expect(
      w.run(w.cast.operator, (c) =>
        c.query("select platform.transition('equipment_cleanliness', 'plant_equipment', $1, 'START_USE', $2, '{}'::jsonb)", [press.id, s?.version]),
      ),
    ).rejects.toThrow(/plant.equipment_use_open: no use was started/);
    await expect(
      w.run(w.cast.tech2, (c) =>
        c.query("select platform.transition('equipment_cleanliness', 'plant_equipment', $1, 'START_CLEANING', $2, '{}'::jsonb)", [press.id, s?.version]),
      ),
    ).rejects.toThrow(/plant.cleaning_open: no cleaning was started/);
    // Recorded rows are never rewritten, even by the owner.
    await expect(db.admin.query("update plant.cleaning set level = 'MINOR' where id = $1", [cleaning])).rejects.toThrow(/EBMR-AUDIT-004/);
    await expect(db.admin.query('delete from plant.cleaning_verification where cleaning_id = $1', [cleaning])).rejects.toThrow(/EBMR-AUDIT-004/);
  });

  it('[DI-17][DI-18] an administrator never writes plant data; a person without the permission is refused', async () => {
    const { admin } = await seedAdministration(db);
    await expect(
      w.run(admin, (c) =>
        plant.defineProduct(c, {
          code: `P-${tag()}`,
          name: 'x',
          highlyPotent: false,
        }),
      ),
    ).rejects.toThrow(/EBMR-IAM-042/);
    await expect(
      w.run(w.cast.operator, (c) =>
        plant.defineProduct(c, {
          code: `P-${tag()}`,
          name: 'x',
          highlyPotent: false,
        }),
      ),
    ).rejects.toThrow(/EBMR-IAM-040/);
    const press = await w.press();
    const batch = await w.batch('B', await w.product());
    await expect(w.run(w.cast.operator, (c) => plant.startCleaning(c, 'EQUIPMENT', press.code, 'MAJOR'))).rejects.toThrow(/EBMR-IAM-040/);
    await expect(w.run(w.cast.tech, (c) => plant.startEquipmentUse(c, press.code, batch.id, '2099-01-01T00:00:00Z'))).rejects.toThrow(/EBMR-IAM-040/);
  });

  it('[DI-17][DI-18] every app-callable plant function that can write refuses administrators first, then checks a catalogued permission', async () => {
    const { rows } = await db.admin.query<{
      fn: string;
      src: string;
      volatile: boolean;
    }>(`
      select p.oid::regprocedure::text as fn, p.prosrc as src, p.provolatile = 'v' as volatile
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'plant' and p.prokind = 'f' and has_function_privilege('ebmr_app', p.oid, 'EXECUTE')
      order by 1`);
    // Volatile only because they read the clock or the site calendar; they write nothing.
    const readers = new Set(['plant.instrument_use_assessment(uuid,uuid,timestamp with time zone)']);
    const writers = rows.filter((r) => r.volatile && !readers.has(r.fn));
    expect(writers.length).toBeGreaterThanOrEqual(20);
    // Thin wrappers that delegate to a gated helper of the schema (the output containers of sql/0422); the helper itself
    // is proven to hold both checks in that order.
    const gated = (src: string) => {
      const admin = src.indexOf('iam.assert_not_administrator()');
      const perm = src.indexOf('iam.require_permission(');
      return admin >= 0 && perm >= 0 && admin < perm;
    };
    const helperSrc = async (name: string) =>
      (await db.admin.query<{ src: string }>('select prosrc as src from pg_proc where oid = $1::regproc', [name])).rows[0]?.src ?? '';
    const delegates = ['plant.dispose_container'];
    for (const h of delegates) expect(gated(await helperSrc(h))).toBe(true);
    // Administration acts (DI-18 side): OPC UA endpoint enrolment is device and interface configuration, done by the
    // administrator under IAM.DEVICE_MANAGE like iam.register_device, so it may not refuse administrators. Each must
    // check a permission, and every permission it cites must be of the ADMINISTRATION domain, never a GMP one.
    const adminActs = ['plant.enrol_opcua_endpoint(text,text,text,text[],text)', 'plant.retire_opcua_endpoint(text,text)'];
    const domain = new Map((await db.admin.query<{ code: string; domain: string }>('select code, domain from iam.permission')).rows.map((r) => [r.code, r.domain]));
    for (const fn of adminActs) {
      const src = writers.find((r) => r.fn === fn)?.src ?? '';
      const perms = [...src.matchAll(/iam\.require_permission\('([A-Z][A-Z0-9_.]*)'/g)].map((m) => m[1] ?? '');
      expect(perms.length, fn).toBeGreaterThan(0);
      expect(perms.filter((p) => domain.get(p) !== 'ADMINISTRATION'), fn).toEqual([]);
    }
    const bad = writers.filter((r) => !gated(r.src) && !adminActs.includes(r.fn) && !delegates.some((h) => new RegExp(`^\\s*select ${h.replace('.', '\\.')}\\(`).test(r.src)));
    expect(bad.map((r) => r.fn)).toEqual([]);
    const known = new Set(domain.keys());
    const cited = writers.flatMap((r) => [...r.src.matchAll(/'([A-Z][A-Z0-9_]*\.[A-Z][A-Z0-9_]*)'/g)].map((m) => m[1] ?? ''));
    expect(cited.length).toBeGreaterThan(0);
    expect(cited.filter((c) => !known.has(c))).toEqual([]);
    // The readers granted to the application write nothing: none of them inserts.
    expect(rows.filter((r) => !writers.includes(r) && /insert into/i.test(r.src)).map((r) => r.fn)).toEqual([]);
  });

  it('[IN-25] every plant table is audited and its event times come from the database clock', async () => {
    const { rows } = await db.admin.query<{ t: string }>(`
      select c.oid::regclass::text as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'plant' and c.relkind = 'r'
        and c.oid not in (select table_name from kernel.audited_table)`);
    expect(rows).toEqual([]);
    expect((await db.admin.query("select * from platform.time_model_violations() where table_name::text like 'plant.%'")).rows).toEqual([]);
    const { rows: grants } = await db.admin.query<{ t: string }>(`
      select c.oid::regclass::text as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'plant' and c.relkind = 'r'
        and (has_table_privilege('ebmr_app', c.oid, 'INSERT') or has_table_privilege('ebmr_app', c.oid, 'UPDATE') or has_table_privilege('ebmr_app', c.oid, 'DELETE'))`);
    expect(grants).toEqual([]);
  });
});
