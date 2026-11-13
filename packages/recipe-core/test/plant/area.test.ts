/**
 * Rooms and lines (outline 5.2.8): status machine, clearance types with a performer and a different verifier, the start
 * of a batch stage or packaging order only after a passed clearance of the required type recorded after the previous
 * occupancy (INV-15, IN-21, PR-26, PR-34), one active packaging order per line (PR-35), room eligibility (IN-26 (b)(c),
 * PR-25) and the logbook view (IN-25 (a), PR-24). Every write runs as ebmr_app inside a validated command.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import * as plant from '../../src/plant/index.ts';
import { finishBatch, PlantWorld, seedPlantCast } from './support.ts';

let db: TestDatabase;
let w: PlantWorld;

beforeAll(async () => {
  db = await createTestDatabase();
  w = new PlantWorld(db, await seedPlantCast(db));
}, 300_000);

afterAll(async () => {
  await db.drop();
});

const start = (areaCode: string, s: { batch: string; product: string; stage?: string; order?: string; artworkSet?: string }) => w.startIn(areaCode, s);
const end = (occupancy: string) => w.run(w.cast.operator, (c) => plant.endAreaOccupancy(c, occupancy));

describe('starting in a room needs a passed clearance of the required type (INV-15, IN-21, PR-26)', () => {
  it('[IN-21][INV-15] start compression on a room with status "to be cleaned": refused', async () => {
    const room = await w.room();
    const product = await w.product();
    expect(await w.state('area', room.id)).toBe('DIRTY');
    await expect(start(room.code, { batch: 'B-1', product })).rejects.toThrow(/is DIRTY \(to be cleaned\).*IN-21.*EBMR-PLANT-126/);
    // Cleaned but not cleared: still refused.
    await w.clean('AREA', room.code, 'MAJOR');
    await expect(start(room.code, { batch: 'B-1', product })).rejects.toThrow(/is CLEAN \(no passed clearance\)/);
  });

  it('[INV-15][PR-26][IN-21] clean, clear, start, end: the next batch needs a new clearance recorded after the previous occupancy; the clearance records the previous product and batch', async () => {
    const room = await w.room();
    const a = await w.product();
    const b = await w.product();
    await w.clean('AREA', room.code, 'MAJOR');
    // A clearance for another batch does not clear this one.
    await w.clear(room.code, 'PRODUCT_CHANGE', {
      batch: 'B-OTHER',
      product: a,
    });
    expect(await w.state('area', room.id)).toBe('CLEARED_FOR_BATCH');
    await expect(start(room.code, { batch: 'B-1', product: a })).rejects.toThrow(/no passed PRODUCT_CHANGE clearance for batch TEST-B-1-.*EBMR-PLANT-127/);
    await w.clear(room.code, 'PRODUCT_CHANGE', { batch: 'B-1', product: a });
    const o1 = await start(room.code, { batch: 'B-1', product: a });
    expect(await w.state('area', room.id)).toBe('IN_USE');
    await end(o1);
    expect(await w.state('area', room.id)).toBe('DIRTY');
    // A FAILED clearance does not clear the room.
    await w.clean('AREA', room.code, 'MAJOR');
    const failed = await w.clear(room.code, 'PRODUCT_CHANGE', { batch: 'B-2', product: b }, 'FAILED');
    expect(await w.state('area', room.id)).toBe('CLEAN');
    const passed = await w.clear(room.code, 'PRODUCT_CHANGE', {
      batch: 'B-2',
      product: b,
    });
    const { rows } = await db.app.query<{
      id: string;
      previous_product: string;
      previous_batch: string;
      result: string;
    }>('select id, previous_product, previous_batch, result from plant.clearance_status where id = any($1) order by performed_at', [[failed, passed]]);
    expect(rows.map((r) => [r.previous_product, r.previous_batch, r.result])).toEqual([
      [a, (await w.batch('B-1', a)).number, 'FAILED'],
      [a, (await w.batch('B-1', a)).number, 'PASSED'],
    ]);
    await expect(start(room.code, { batch: 'B-2', product: b })).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });

  it('[INV-15][IN-21] the same person cannot perform and verify a clearance: refused in the command, by the signature service and by the table', async () => {
    const room = await w.room();
    const product = await w.product();
    await w.clean('AREA', room.code, 'MAJOR');
    const id = await w.recordClearance(room.code, 'PRODUCT_CHANGE', {
      batch: 'B-S',
      product,
    });
    // The performer's own verification signature is refused by the signature service (they entered the record) ...
    await expect(w.sign(w.cast.operator, 'plant_clearance', id, 'VERIFIED', 'PERFORMED')).rejects.toThrow(/EBMR-ESIG/);
    // ... a signature of someone else presented by the performer is refused by the command ...
    const sig = await w.sign(w.cast.verifier, 'plant_clearance', id, 'VERIFIED', 'PERFORMED');
    await expect(w.run(w.cast.operator, (c) => plant.verifyClearance(c, id, sig))).rejects.toThrow(/EBMR-IAM-040|EBMR-PLANT-104/);
    // ... and a verification row naming the performer is refused by the table, whoever writes it.
    await expect(
      db.admin.query('insert into plant.clearance_verification (clearance_id, verified_by, signature_id) values ($1, $2, gen_random_uuid())', [
        id,
        w.cast.operator.personId,
      ]),
    ).rejects.toThrow(/EBMR-PLANT-104/);
    await w.run(w.cast.verifier, (c) => plant.verifyClearance(c, id, sig));
    expect(await w.state('area', room.id)).toBe('CLEARED_FOR_BATCH');
  });

  it('[INV-15][IN-26][PR-27] a product change in a room needs a MAJOR cleaning and a PRODUCT_CHANGE clearance; the same product inside an open room campaign takes a CAMPAIGN clearance', async () => {
    const room = await w.room();
    const a = await w.product();
    const b = await w.product();
    await w.run(w.cast.steward, (c) =>
      plant.openCampaign(c, {
        areaCode: room.code,
        product: a,
        maxBatches: 3,
        maxDays: 10,
        validationRef: 'CV-ROOM-1',
      }),
    );
    // First batch after a MINOR cleaning: refused (product change needs MAJOR).
    await w.clean('AREA', room.code, 'MINOR');
    await w.clear(room.code, 'PRODUCT_CHANGE', { batch: 'A-1', product: a });
    await expect(start(room.code, { batch: 'A-1', product: a })).rejects.toThrow(/needs a MAJOR cleaning.*EBMR-PLANT-128/);
    await w.run(
      w.cast.tech,
      (c) =>
        c.query(
          "select platform.transition('area_status', 'plant_area', $1, 'MARK_DIRTY', (select version from platform.aggregate_state where aggregate_id = $1), '{}'::jsonb)",
          [room.id],
        ),
      {
        reasonCode: 'REWORK',
        reasonText: 'minor cleaning not enough for a first batch',
      },
    );
    await w.clean('AREA', room.code, 'MAJOR');
    await w.clear(room.code, 'PRODUCT_CHANGE', { batch: 'A-1', product: a });
    await end(await start(room.code, { batch: 'A-1', product: a }));
    // Same product next batch: a CAMPAIGN clearance after a MINOR cleaning.
    await w.clean('AREA', room.code, 'MINOR');
    await w.clear(room.code, 'CAMPAIGN', { batch: 'A-2', product: a });
    await end(await start(room.code, { batch: 'A-2', product: a }));
    // Product B: a CAMPAIGN clearance is not of the required type.
    await w.clean('AREA', room.code, 'MAJOR');
    await w.clear(room.code, 'CAMPAIGN', { batch: 'B-1', product: b });
    await expect(start(room.code, { batch: 'B-1', product: b })).rejects.toThrow(/no passed PRODUCT_CHANGE clearance for batch TEST-B-1-.*product change from/);
  });
});

describe('the end of a room\'s use records a reason (owner decision of 13 November 2026 on demo report bug 4; recipe-core 1922)', () => {
  it('[DI-22][IN-21][PR-34] a room\'s use ended with a reason keeps it on its end row and in the audit trail; a blank reason is refused; the use of a finished or cancelled batch is ended only with a reason, and the room stays in use until then', async () => {
    const room = await w.room();
    const a = await w.product();
    await w.clean('AREA', room.code, 'MAJOR');
    await w.clear(room.code, 'PRODUCT_CHANGE', { batch: 'B-RR1', product: a });
    const o1 = await start(room.code, { batch: 'B-RR1', product: a });
    const endWith = (occupancy: string, reason: string | null) => w.run(w.cast.operator2, (c) => c.query('select plant.end_area_occupancy($1, $2) as r', [occupancy, reason]));
    await expect(endWith(o1, '')).rejects.toThrow(/EBMR-PLANT-065/);
    await finishBatch(db, (await w.batch('B-RR1', a)).id, 'CANCELLED');
    await expect(end(o1)).rejects.toThrow(/batch TEST-B-RR1-\w+ is CANCELLED.*EBMR-PLANT-065/);
    expect(await w.state('area', room.id)).toBe('IN_USE');
    await endWith(o1, 'Batch cancelled; room left in use from the Plant screen');
    expect(await w.state('area', room.id)).toBe('DIRTY');
    const { rows } = await db.admin.query<{ reason: string; ended_by: string }>('select reason, ended_by::text from plant.area_occupancy_end where occupancy_id = $1', [o1]);
    expect(rows).toEqual([{ reason: 'Batch cancelled; room left in use from the Plant screen', ended_by: w.cast.operator2.personId }]);
    const audit = await db.admin.query<{ reason: string; person: string }>(
      `select payload -> 'body' -> 'details' ->> 'reason' as reason, payload -> 'actor' ->> 'person_id' as person from kernel.audit_event where action = 'BUSINESS' and chain_key = $1`,
      [`plant_area:${o1}`],
    );
    expect(audit.rows).toEqual([{ reason: 'Batch cancelled; room left in use from the Plant screen', person: w.cast.operator2.personId }]);
    // A running batch's room is ended without a reason, as the clearance step does.
    await w.clean('AREA', room.code, 'MAJOR');
    await w.clear(room.code, 'PRODUCT_CHANGE', { batch: 'B-RR2', product: a });
    await end(await start(room.code, { batch: 'B-RR2', product: a }));
    expect(await w.state('area', room.id)).toBe('DIRTY');
  });
});

describe('the verifier signs the recorded finding (S23, S24)', () => {
  it("[IN-21][INV-15] the verifier's signature covers the performer's finding: a FAILED clearance cannot be verified as PASSED, and a signature of one clearance verifies no other", async () => {
    const room = await w.room();
    const product = await w.product();
    await w.clean('AREA', room.code, 'MAJOR');
    const failed = await w.recordClearance(room.code, 'PRODUCT_CHANGE', { batch: 'B-F', product }, 'FAILED');
    const { rows } = await db.admin.query<{ c: { content: { result: string } } }>("select esig.provide('plant_clearance', $1) as c", [failed]);
    expect(rows[0]?.c.content.result).toBe('FAILED');
    const sig = await w.sign(w.cast.verifier, 'plant_clearance', failed, 'VERIFIED', 'PERFORMED');
    // The signature over the FAILED clearance does not verify a PASSED one.
    const passed = await w.recordClearance(room.code, 'PRODUCT_CHANGE', { batch: 'B-F', product }, 'PASSED');
    await expect(w.run(w.cast.verifier, (c) => plant.verifyClearance(c, passed, sig))).rejects.toThrow(/EBMR-PLAT-008/);
    // Verifying the FAILED one records FAILED: the area stays CLEAN and cannot be started.
    await w.run(w.cast.verifier, (c) => plant.verifyClearance(c, failed, sig));
    const { rows: v } = await db.app.query<{ result: string }>('select result from plant.clearance_status where id = $1', [failed]);
    expect(v[0]?.result).toBe('FAILED');
    expect(await w.state('area', room.id)).toBe('CLEAN');
    await expect(start(room.code, { batch: 'B-F', product })).rejects.toThrow(/EBMR-PLANT-126/);
  });

  it("[IN-26] the product a start is checked against is the batch's own: a batch of a highly potent product cannot be started in a positive-pressure room under any name", async () => {
    const potent = await w.product({ highlyPotent: true });
    const room = await w.room({ negativePressure: false });
    await w.clean('AREA', room.code, 'MAJOR');
    await w.clear(room.code, 'PRODUCT_CHANGE', { batch: 'HP-9', product: potent });
    const b = await w.batch('HP-9', potent);
    // The start takes only the batch; there is no product argument to claim another product with.
    await expect(w.run(w.cast.operator, (c) => plant.startAreaOccupancy(c, room.code, { batchId: b.id, stage: 'COMPRESSION' }))).rejects.toThrow(
      new RegExp(`${potent} is highly potent.*EBMR-PLANT-122`),
    );
    await expect(db.app.query("select plant.start_area_occupancy($1, $2, 'COMPRESSION', 'NOT-POTENT')", [room.code, b.id])).rejects.toThrow();
  });
});

describe('a clearance follows the cleaning it checks (INV-15)', () => {
  it('[INV-15][IN-21] a clearance recorded before the area was dirtied and cleaned again does not clear it', async () => {
    const room = await w.room();
    const product = await w.product();
    await w.clean('AREA', room.code, 'MAJOR');
    const early = await w.recordClearance(room.code, 'PRODUCT_CHANGE', { batch: 'B-E', product });
    await w.run(
      w.cast.tech,
      (c) =>
        c.query(
          "select platform.transition('area_status', 'plant_area', $1, 'MARK_DIRTY', (select version from platform.aggregate_state where aggregate_id = $1), '{}'::jsonb)",
          [room.id],
        ),
      { reasonCode: 'SPILL', reasonText: 'powder spill at the hopper' },
    );
    await w.clean('AREA', room.code, 'MAJOR');
    const sig = await w.sign(w.cast.verifier, 'plant_clearance', early, 'VERIFIED', 'PERFORMED');
    await expect(w.run(w.cast.verifier, (c) => plant.verifyClearance(c, early, sig))).rejects.toThrow(/record a new clearance.*EBMR-PLANT-106/);
    expect(await w.state('area', room.id)).toBe('CLEAN');
    await w.clear(room.code, 'PRODUCT_CHANGE', { batch: 'B-E', product });
    await expect(start(room.code, { batch: 'B-E', product })).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('lines: a clearance for every packaging order (L-29, PR-34, PR-35)', () => {
  it('[PR-34][PR-35][INV-15] a change of packaging order on a line needs a PACKAGING_ORDER clearance keyed on the order and the artwork set, even for the same bulk batch; one active order per line', async () => {
    const line = await w.room({ kind: 'LINE' });
    const product = await w.product();
    await expect(
      w.recordClearance(line.code, 'PRODUCT_CHANGE', {
        batch: 'BULK-1',
        product,
      }),
    ).rejects.toThrow(/DIRTY/);
    await w.clean('AREA', line.code, 'MAJOR');
    await expect(
      w.recordClearance(line.code, 'PRODUCT_CHANGE', {
        batch: 'BULK-1',
        product,
      }),
    ).rejects.toThrow(/PACKAGING_ORDER clearance naming the packaging order and the artwork set.*EBMR-PLANT-101/);
    await w.clear(line.code, 'PACKAGING_ORDER', {
      batch: 'BULK-1',
      product,
      order: 'PO-1',
      artworkSet: 'ART-IN-v3',
    });
    // Starting without naming the order, or another order or artwork set: refused.
    await expect(start(line.code, { batch: 'BULK-1', product, stage: 'PACKAGING' })).rejects.toThrow(/names the packaging order.*EBMR-PLANT-121/);
    await expect(
      start(line.code, {
        batch: 'BULK-1',
        product,
        stage: 'PACKAGING',
        order: 'PO-1',
        artworkSet: 'ART-US-v1',
      }),
    ).rejects.toThrow(/no passed PACKAGING_ORDER clearance/);
    const o1 = await start(line.code, {
      batch: 'BULK-1',
      product,
      stage: 'PACKAGING',
      order: 'PO-1',
      artworkSet: 'ART-IN-v3',
    });
    // PR-35: a second order on the running line is refused.
    await expect(
      start(line.code, {
        batch: 'BULK-1',
        product,
        stage: 'PACKAGING',
        order: 'PO-2',
        artworkSet: 'ART-US-v1',
      }),
    ).rejects.toThrow(/one active packaging order per line.*EBMR-PLANT-123/);
    await end(o1);
    // Same bulk batch, next order: the clearance of PO-1 does not carry over.
    await w.clean('AREA', line.code, 'MINOR');
    expect(await w.state('area', line.id)).toBe('CLEAN');
    await w.clear(line.code, 'PACKAGING_ORDER', {
      batch: 'BULK-1',
      product,
      order: 'PO-2',
      artworkSet: 'ART-US-v1',
    });
    const { rows } = await db.app.query<{
      previous_order: string;
      previous_artwork_set: string;
    }>("select previous_order, previous_artwork_set from plant.clearance where area_id = $1 and next_order = 'PO-2'", [line.id]);
    expect(rows[0]).toEqual({
      previous_order: 'PO-1',
      previous_artwork_set: 'ART-IN-v3',
    });
    await expect(
      start(line.code, {
        batch: 'BULK-1',
        product,
        stage: 'PACKAGING',
        order: 'PO-2',
        artworkSet: 'ART-US-v1',
      }),
    ).resolves.toMatch(/^[0-9a-f-]{36}$/);
    // Even an owner-level insert of a second open order on the line is refused by the occupancy chain.
    const clearance = (await db.app.query<{ id: string }>("select id from plant.clearance where area_id = $1 and next_order = 'PO-2'", [line.id])).rows[0]?.id;
    await expect(
      db.admin.query(
        `insert into plant.area_occupancy (area_id, exclusive, previous_occupancy_id, batch_id, batch_ref, product_code, stage, packaging_order, artwork_set, clearance_id, started_by)
      values ($1, true, (select id from plant.area_occupancy where area_id = $1 order by started_at desc limit 1), $4, 'BULK-1', $2, 'PACKAGING', 'PO-3', 'A', $3, gen_random_uuid())`,
        [line.id, product, clearance, (await w.batch('BULK-1', product)).id],
      ),
    ).rejects.toThrow(/EBMR-PLANT-130|area_occupancy_clearance_id_key/);
  });
});

describe('room eligibility (IN-26 (b)(c), PR-25)', () => {
  it('[IN-26] schedule a highly potent product in a positive-pressure cubicle: blocked; a negative-pressure room accepts it', async () => {
    const potent = await w.product({ highlyPotent: true });
    const cubicle = await w.room({ negativePressure: false });
    await w.clean('AREA', cubicle.code, 'MAJOR');
    await w.clear(cubicle.code, 'PRODUCT_CHANGE', {
      batch: 'HP-1',
      product: potent,
    });
    await expect(start(cubicle.code, { batch: 'HP-1', product: potent })).rejects.toThrow(
      /highly potent.*negative pressure cascade.*IN-26 \(c\).*EBMR-PLANT-122/,
    );
    const contained = await w.room({ negativePressure: true });
    await w.clean('AREA', contained.code, 'MAJOR');
    await w.clear(contained.code, 'PRODUCT_CHANGE', {
      batch: 'HP-1',
      product: potent,
    });
    await expect(start(contained.code, { batch: 'HP-1', product: potent })).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });

  it('[IN-26][PR-25] starting product Y in a room occupied by product X is blocked unless the room is segregated with a recorded risk justification', async () => {
    const x = await w.product();
    const y = await w.product();
    const room = await w.room();
    await w.clean('AREA', room.code, 'MAJOR');
    await w.clear(room.code, 'PRODUCT_CHANGE', { batch: 'X-1', product: x });
    await start(room.code, { batch: 'X-1', product: x });
    await expect(start(room.code, { batch: 'Y-1', product: y })).rejects.toThrow(
      /second batch of another product is allowed only in a segregated room.*EBMR-PLANT-124/,
    );
    await expect(w.room({ segregated: true })).rejects.toThrow(/risk justification.*EBMR-PLANT-003/);
    const seg = await w.room({
      segregated: true,
      segregationJustification: 'QRM-2026-014: closed booths with separate AHU',
    });
    await w.clean('AREA', seg.code, 'MAJOR');
    await w.clear(seg.code, 'PRODUCT_CHANGE', { batch: 'X-2', product: x });
    await start(seg.code, { batch: 'X-2', product: x });
    // The second batch still needs its own clearance, recorded after the first started.
    await expect(start(seg.code, { batch: 'Y-2', product: y })).rejects.toThrow(/no passed PRODUCT_CHANGE clearance for batch TEST-Y-2-/);
    await w.clear(seg.code, 'PRODUCT_CHANGE', { batch: 'Y-2', product: y });
    await expect(start(seg.code, { batch: 'Y-2', product: y })).resolves.toMatch(/^[0-9a-f-]{36}$/);
    expect(await w.state('area', seg.id)).toBe('IN_USE');
  });
});

describe('out of service, bypass attempts and the logbook', () => {
  it("[IN-21][INV-15] an area out of service is never started; a direct transition to CLEARED_FOR_BATCH or IN_USE without the command's rows is refused; direct writes are refused", async () => {
    const room = await w.room();
    const product = await w.product();
    await w.clean('AREA', room.code, 'MAJOR');
    const version = async () => (await plant.areaState(db.app, room.id))?.version;
    await expect(
      w.run(w.cast.verifier, async (c) =>
        c.query("select platform.transition('area_status', 'plant_area', $1, 'CLEAR', $2, '{}'::jsonb)", [room.id, await version()]),
      ),
    ).rejects.toThrow(/plant.clearance_passed: no passed clearance/);
    await expect(
      w.run(w.cast.operator, (c) =>
        c.query(
          "insert into plant.clearance (area_id, clearance_type, next_product, next_batch, performed_by, performed_account) values ($1, 'PRODUCT_CHANGE', $2, 'B', gen_random_uuid(), gen_random_uuid())",
          [room.id, product],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      w.run(w.cast.operator, (c) => c.query('insert into plant.area_occupancy_end (occupancy_id, ended_by) values (gen_random_uuid(), gen_random_uuid())')),
    ).rejects.toThrow(/permission denied/);
    await w.clear(room.code, 'PRODUCT_CHANGE', { batch: 'B-O', product });
    await expect(
      w.run(w.cast.operator, async (c) =>
        c.query("select platform.transition('area_status', 'plant_area', $1, 'START', $2, '{}'::jsonb)", [room.id, await version()]),
      ),
    ).rejects.toThrow(/plant.area_occupancy_open: no batch was started/);
    await w.run(
      w.cast.tech,
      async (c) => c.query("select platform.transition('area_status', 'plant_area', $1, 'TAKE_OUT_OF_SERVICE', $2, '{}'::jsonb)", [room.id, await version()]),
      { reasonCode: 'HVAC_FAILURE', reasonText: 'pressure cascade lost' },
    );
    await expect(start(room.code, { batch: 'B-O', product })).rejects.toThrow(/is OUT_OF_SERVICE/);
  });

  it('[IN-25][PR-24] the logbook of a room and of a press is written from the recorded acts, with persons and batches', async () => {
    const room = await w.room();
    const product = await w.product();
    await w.clean('AREA', room.code, 'MAJOR');
    await w.clear(room.code, 'PRODUCT_CHANGE', { batch: 'L-1', product });
    await end(await start(room.code, { batch: 'L-1', product }));
    const press = await w.press();
    await w.clean('EQUIPMENT', press.code, 'MAJOR');
    const use = await w.startUse(press.code, 'L-1', product);
    await w.run(w.cast.operator, (c) => plant.endEquipmentUse(c, use));
    const entries = async (code: string) =>
      (
        await db.app.query<{
          entry: string;
          batch_ref: string | null;
          person_id: string;
        }>('select entry, batch_ref, person_id from plant.logbook where subject_code = $1 order by at, entry', [code])
      ).rows;
    const roomLog = await entries(room.code);
    expect(roomLog.map((r) => r.entry)).toEqual([
      'CLEANING_STARTED',
      'CLEANING_COMPLETED',
      'CLEANING_VERIFIED',
      'CLEARANCE_PERFORMED',
      'CLEARANCE_PASSED',
      'STARTED',
      'ENDED',
    ]);
    expect(roomLog.find((r) => r.entry === 'CLEARANCE_PASSED')?.person_id).toBe(w.cast.verifier.personId);
    const pressLog = await entries(press.code);
    const lNumber = (await w.batch('L-1', product)).number;
    expect(pressLog.map((r) => r.entry)).toEqual(['QUALIFIED', 'CLEANING_STARTED', 'CLEANING_COMPLETED', 'CLEANING_VERIFIED', 'USE_STARTED', 'USE_ENDED']);
    expect(pressLog.filter((r) => r.batch_ref === lNumber).length).toBe(2);
  });

  it('[DI-28][IN-25] a back-dated logbook entry is impossible: the application role writes no logbook row, and a row written below it with a past time is stored at the database time, which never changes after', async () => {
    const press = await w.press();
    const past = '2020-01-01T00:00:00Z';
    // As the application role, in a validated command: no direct write to the rows the logbook reads.
    await expect(
      w.run(w.cast.operator, (c) =>
        c.query("insert into plant.equipment_event (equipment_id, kind, detail, person_id, account_id, recorded_at) values ($1, 'FAILURE_SIGNALLED', 'back-dated', gen_random_uuid(), gen_random_uuid(), $2)", [press.id, past]),
      ),
    ).rejects.toThrow(/permission denied/);
    // Owner-level code naming a past time: the row takes the database time; changing it later keeps the stored time.
    const fx = await db.admin.connect();
    let id = '';
    try {
      await fx.query('begin');
      await fx.query('select kernel.set_actor_context($1::jsonb)', [JSON.stringify({
        person_id: '00000000-0000-0000-0000-000000000000', account_id: '00000000-0000-0000-0000-000000000000', role_code: 'TEST_FIXTURE',
        session_id: '00000000-0000-0000-0000-000000000000', source: 'SYSTEM', site_zone: 'UTC', correlation_id: randomUUID(), legal_name: 'Test fixture',
        reason_code: 'TEST_FIXTURE', reason_text: 'a back-dated logbook entry attempted below the application' })]);
      id = (await fx.query<{ id: string }>("insert into plant.equipment_event (equipment_id, kind, detail, person_id, account_id, recorded_at) values ($1, 'FAILURE_SIGNALLED', 'back-dated', gen_random_uuid(), gen_random_uuid(), $2) returning id::text", [press.id, past])).rows[0]!.id;
      await fx.query('commit');
    } finally {
      fx.release();
    }
    const stored = async () => (await db.admin.query<{ late: boolean; at: Date }>("select recorded_at > clock_timestamp() - interval '5 minutes' as late, recorded_at as at from plant.equipment_event where id = $1", [id])).rows[0];
    const first = await stored();
    expect(first?.late).toBe(true);
    await db.admin.query('update plant.equipment_event set recorded_at = $2 where id = $1', [id, past]).catch(() => undefined);
    expect((await stored())?.at.getTime()).toBe(first?.at.getTime());
    const lines = (await db.app.query<{ at: Date }>("select at from plant.logbook where subject_code = $1 and at < '2021-01-01'", [press.code])).rows;
    expect(lines).toEqual([]);
  });
});
