/**
 * The plant rules of slice 6b in the database (recipe-core 0973 to 0975, kernel 1190; builder B): a room overdue for
 * cleaning (PR-25), a spill (PR-27), line adjacency and the station display (PR-35), the status board (PR-22), area
 * authorisation at the step signature (PR-15) and the alarm log at the step signature and in review (DI-49). As the
 * application role through the real commands and real identities, with bypass attempts (direct writes, the owner's
 * forged execution row) and a success after each refusal.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '../../../kernel/src/db/command.ts';
import { expectRefused } from '../../../kernel/test/identity/helpers.ts';
import { seedActor, withReason, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { envelopeFor, nowUs, receive, registerAdapter, type TestAdapter } from '../../../kernel/test/integrations/support.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import * as plant from '../../src/plant/index.ts';
import { dbIn, PlantWorld, seedPlantCast, sleep, tag } from '../plant/support.ts';
import { batchWithSteps, forgedCommand, occupy, occupyBatch, stepProblem } from './support.ts';

let db: TestDatabase;
let w: PlantWorld;
let tc: SeededActor;
let ems: TestAdapter;

beforeAll(async () => {
  db = await createTestDatabase();
  w = new PlantWorld(db, await seedPlantCast(db));
  tc = await seedActor(db, { roleCode: 'TRAINING_COORDINATOR', legalName: 'Tara Coordinator', acknowledgeEsig: false });
  ems = await registerAdapter(db, 'EMS');
}, 300_000);
afterAll(async () => {
  await db.drop();
});

const asSteward = <T>(sql: string, params: unknown[]) => w.run(w.cast.steward, async (c) => (await c.query<{ r: T }>(sql, params)).rows[0]?.r as T);
const areaRule = (code: string, controlled: boolean, holdSeconds: number | null) =>
  asSteward<number>('select plant.set_area_rule($1, $2, $3, $4) as r', [code, controlled, holdSeconds, 'site rule for the test']);
const cleaningState = async (code: string) => (await db.app.query<{ s: string }>('select cleaning_state as s from plant.room_cleaning_state where code = $1', [code])).rows[0]?.s;
const startStep = (batch: string, room: string, person = w.cast.operator) => stepProblem(db, batch, 'START_STEP', 'p-1', room, person.personId);

describe('rooms: clean hold and spills (PR-25, PR-27)', () => {
  it('[PR-25] a room overdue for cleaning is blocked', async () => {
    const room = await w.room();
    const product = await w.product();
    await areaRule(room.code, false, 2);
    await w.clean('AREA', room.code, 'MAJOR');
    expect(await cleaningState(room.code)).toBe('CLEAN');
    await sleep(db, 2.2);
    expect(await cleaningState(room.code)).toBe('OVERDUE');
    // The clearance and the start of a batch in the room, and a step started from its terminal, are refused.
    await expectRefused(w.recordClearance(room.code, 'PRODUCT_CHANGE', { batch: 'OVD-1', product }), 'EBMR-PLANT-150', /overdue for cleaning.*clean-hold time 00:00:02/);
    const batch = await batchWithSteps(db, product, ['p-1']);
    expect(await startStep(batch, room.code)).toMatch(/^EBMR-PLANT-150 /);
    expect(await forgedCommand(db, batch, 'START_STEP', 'p-1', room.code, w.cast.operator.personId)).toMatch(/EBMR-PLANT-150/);
    // Bypass: the application cannot write or change the rules or the cleaning state itself.
    await expect(db.app.query("insert into plant.area_rule (area_id, version, authorisation_required, reason) values ($1, 9, false, 'x')", [room.id])).rejects.toThrow(/permission denied/);
    await expect(db.app.query('update plant.area_rule set clean_hold = null')).rejects.toThrow(/permission denied/);
    await expect(db.app.query('delete from plant.area_rule')).rejects.toThrow(/permission denied/);
    await expectRefused(w.run(w.cast.operator, (c) => c.query('select plant.set_area_rule($1, false, null, $2)', [room.code, 'no hold'])), 'EBMR-IAM-040');
    // Success: cleaned again, the room is cleared and the batch starts within its clean hold; the step start is allowed.
    await w.clean('AREA', room.code, 'MAJOR');
    await w.clear(room.code, 'PRODUCT_CHANGE', { batch: 'OVD-1', product });
    const b = await w.batch('OVD-1', product);
    await w.startIn(room.code, { batch: 'OVD-1', product });
    // Inside the batch's occupancy the hold runs to the occupancy's start, so later steps of the batch are not refused.
    await sleep(db, 2.2);
    expect(await stepProblem(db, b.id, 'START_STEP', 'p-1', room.code, w.cast.operator.personId)).toBeNull();
    expect(await cleaningState(room.code)).toBe('CLEAN');
    // Without a clean hold (the rule's next version), a room is never overdue.
    expect(await areaRule(room.code, false, null)).toBe(2);
  });

  it('[PR-27] a spill event sets the room to cleaning required', async () => {
    const room = await w.room();
    const product = await w.product();
    await w.clean('AREA', room.code, 'MAJOR');
    expect(await cleaningState(room.code)).toBe('CLEAN');
    const batch = await batchWithSteps(db, product, ['p-1']);
    // A person records it: the operator of the batch, or the logbook; not an integration identity, never empty.
    await expectRefused(w.run(w.cast.feed, (c) => c.query('select plant.record_spill($1, $2, null, null)', [room.code, 'x'])), 'EBMR-IAM-040');
    await expectRefused(w.run(w.cast.tech, (c) => c.query('select plant.record_spill($1, $2, null, null)', [room.code, ' '])), 'EBMR-PLANT-152');
    const spill = await w.run(w.cast.tech, async (c) => (await c.query<{ id: string }>('select plant.record_spill($1, $2, $3, null) as id', [room.code, 'Granulate spilt by the sieve', 'Granulate'])).rows[0]?.id);
    expect(spill).toMatch(/^[0-9a-f-]{36}$/);
    expect(await cleaningState(room.code)).toBe('CLEANING_REQUIRED');
    await expectRefused(w.recordClearance(room.code, 'PRODUCT_CHANGE', { batch: 'SPL-1', product }), 'EBMR-PLANT-151', /CLEANING_REQUIRED: a spill was recorded at .*Granulate spilt by the sieve/);
    expect(await startStep(batch, room.code)).toMatch(/^EBMR-PLANT-151 /);
    expect(await forgedCommand(db, batch, 'START_STEP', 'p-1', room.code, w.cast.operator.personId)).toMatch(/EBMR-PLANT-151/);
    // Bypass: the spill cannot be erased or changed, by the application or the owner.
    await expect(db.app.query('delete from plant.area_spill where id = $1', [spill])).rejects.toThrow(/permission denied/);
    await expect(db.app.query("update plant.area_spill set description = 'nothing' where id = $1", [spill])).rejects.toThrow(/permission denied/);
    const c = await db.admin.connect();
    try {
      await c.query('set role ebmr_owner');
      await expect(c.query('delete from plant.area_spill where id = $1', [spill])).rejects.toThrow(/EBMR-AUDIT|insert-only|not allowed/i);
    } finally {
      await c.query('reset role');
      c.release();
    }
    // Success: a verified cleaning after the spill clears it.
    await w.clean('AREA', room.code, 'MAJOR');
    expect(await cleaningState(room.code)).toBe('CLEAN');
    expect(await startStep(batch, room.code)).toBeNull();
    // The batch's operator records a spill during the batch (STEP.EXECUTE in its scope).
    await occupy(w, room.code, 'SPL-2', product);
    const b2 = await w.batch('SPL-2', product);
    await w.run(w.cast.operator, (cc) => cc.query('select plant.record_spill($1, $2, null, $3)', [room.code, 'Coating solution on the floor', b2.id]));
    expect(await stepProblem(db, b2.id, 'START_STEP', 'p-1', room.code, w.cast.operator.personId)).toMatch(/^EBMR-PLANT-151 /);
  });
});

describe('lines: adjacency and the station display (PR-35)', () => {
  it('[PR-35] product Y on an unsegregated adjacent line is blocked', async () => {
    const l1 = await w.room({ kind: 'LINE' });
    const l2 = await w.room({ kind: 'LINE' });
    const x = await w.product();
    const y = await w.product();
    await expectRefused(asSteward('select plant.define_area_adjacency($1, $1, true, false, null) as r', [l1.code]), 'EBMR-PLANT-160');
    await expectRefused(asSteward('select plant.define_area_adjacency($1, $2, true, true, null) as r', [l1.code, l2.code]), 'EBMR-PLANT-160');
    await expectRefused(w.run(w.cast.operator, (c) => c.query('select plant.define_area_adjacency($1, $2, true, false, null)', [l1.code, l2.code])), 'EBMR-IAM-040');
    expect(await asSteward<number>('select plant.define_area_adjacency($1, $2, true, false, null) as r', [l2.code, l1.code])).toBe(1);
    await occupy(w, l1.code, 'ADJ-X', x, true);
    // Product Y on the adjacent line while X runs: refused at the start (the clearance passed; the start is the act).
    await expectRefused(occupy(w, l2.code, 'ADJ-Y', y, true), 'EBMR-PLANT-161', new RegExp(`product ${y} cannot start on ${l2.code}: the adjacent line ${l1.code} runs product ${x}`));
    // Bypass: the occupancy table is written only through the command, and the adjacency only by the steward.
    await expect(db.app.query('insert into plant.area_occupancy (area_id) values ($1)', [l2.id])).rejects.toThrow(/permission denied/);
    await expect(db.app.query('update plant.area_adjacency set segregated = true')).rejects.toThrow(/permission denied/);
    // The same product beside it is allowed; so is Y once the lines are segregated (the adjacency's next version).
    const l3 = await w.room({ kind: 'LINE' });
    await asSteward('select plant.define_area_adjacency($1, $2, true, false, null) as r', [l1.code, l3.code]);
    await occupy(w, l3.code, 'ADJ-X2', x, true);
    expect(await asSteward<number>('select plant.define_area_adjacency($1, $2, true, true, $3) as r', [l1.code, l2.code, 'Full-height wall and separate air handling'])).toBe(2);
    const b = await w.batch('ADJ-Y', y);
    const order = { order: `PO-${tag()}`, artworkSet: `ART-${tag()}` };
    await w.clear(l2.code, 'PACKAGING_ORDER', { batch: 'ADJ-Y', product: y, ...order });
    await w.startIn(l2.code, { batch: 'ADJ-Y', product: y, stage: 'PACKAGING', ...order });
    expect((await db.app.query('select batch_id from plant.area_occupancy_status where area_id = $1 and ended_at is null', [l2.id])).rows).toEqual([{ batch_id: b.id }]);
  });

  it('[PR-35] the station display shows the product and batch', async () => {
    const line = await w.room({ kind: 'LINE' });
    const product = await w.product();
    const station = async () => (await db.app.query<{ s: Record<string, unknown> }>('select plant.line_station($1) as s', [line.code])).rows[0]?.s;
    expect(await station()).toMatchObject({ code: line.code, kind: 'LINE', state: 'DIRTY', batchId: null, product: null });
    const occupancy = await occupy(w, line.code, 'STN-1', product, true);
    const b = await w.batch('STN-1', product);
    const shown = await station();
    expect(shown).toMatchObject({ code: line.code, state: 'IN_USE', batchId: b.id, batchRef: b.number, product, productName: expect.any(String) as unknown, stage: 'PACKAGING' });
    expect(shown?.['packagingOrder']).toMatch(/^PO-/);
    await w.run(w.cast.operator, (c) => plant.endAreaOccupancy(c, occupancy));
    expect(await station()).toMatchObject({ state: 'DIRTY', batchId: null, product: null });
    await expect(db.app.query("select plant.line_station('NO-SUCH-LINE')")).rejects.toThrow(/Unknown room or line NO-SUCH-LINE \(EBMR-PLANT-011\)/);
  });
});

describe('the status board (PR-22)', () => {
  it('[PR-22] the status display matches the system state after each transition', async () => {
    const press = await w.press();
    const room = await w.room();
    const product = await w.product();
    const board = async (code: string) => {
      const rows = (await db.app.query<{ b: Record<string, unknown> }>('select b from plant.status_board() b')).rows.map((r) => r.b);
      return rows.find((r) => r['code'] === code);
    };
    const system = async (type: string, id: string) =>
      (await db.app.query<{ state: string; version: string }>('select state, version::text from platform.aggregate_state where aggregate_type = $1 and aggregate_id = $2', [type, id])).rows[0];
    const matches = async (code: string, type: string, id: string, batch: string | null) => {
      const s = await system(type, id);
      expect(await board(code), `${code} ${s?.state ?? ''}`).toMatchObject({ state: s?.state, stateVersion: s?.version, batchId: batch });
      return s?.state;
    };
    // The press: DIRTY, CLEANING, CLEAN, IN_PRODUCT, DIRTY.
    const states: (string | undefined)[] = [await matches(press.code, 'plant_equipment', press.id, null)];
    const cleaning = await w.run(w.cast.tech, (c) => plant.startCleaning(c, 'EQUIPMENT', press.code, 'MAJOR'));
    states.push(await matches(press.code, 'plant_equipment', press.id, null));
    await w.run(w.cast.tech, (c) => plant.completeCleaning(c, cleaning));
    states.push(await matches(press.code, 'plant_equipment', press.id, null));
    const sig = await w.sign(w.cast.tech2, 'plant_cleaning', cleaning, 'LOGBOOK_DOUBLE_CHECKED', 'COMPLETED');
    await w.run(w.cast.tech2, (c) => plant.verifyCleaning(c, cleaning, sig));
    states.push(await matches(press.code, 'plant_equipment', press.id, null));
    const b = await w.batch('BRD-1', product);
    const use = await w.run(w.cast.operator, async (c) => plant.startEquipmentUse(c, press.code, b.id, await dbIn(db, 3600)));
    states.push(await matches(press.code, 'plant_equipment', press.id, b.id));
    expect(await board(press.code)).toMatchObject({ product, batchRef: b.number, subjectKind: 'EQUIPMENT' });
    await w.run(w.cast.operator, (c) => plant.endEquipmentUse(c, use));
    states.push(await matches(press.code, 'plant_equipment', press.id, null));
    expect(states).toEqual(['DIRTY', 'CLEANING', 'CLEANING', 'CLEAN', 'IN_PRODUCT', 'DIRTY']);
    // A room: DIRTY, CLEAN, CLEARED_FOR_BATCH, IN_USE, DIRTY, with its cleaning state.
    const rs: (string | undefined)[] = [await matches(room.code, 'plant_area', room.id, null)];
    await w.clean('AREA', room.code, 'MAJOR');
    rs.push(await matches(room.code, 'plant_area', room.id, null));
    expect(await board(room.code)).toMatchObject({ cleaningState: 'CLEAN' });
    await w.clear(room.code, 'PRODUCT_CHANGE', { batch: 'BRD-1', product });
    rs.push(await matches(room.code, 'plant_area', room.id, null));
    const occ = await w.startIn(room.code, { batch: 'BRD-1', product });
    rs.push(await matches(room.code, 'plant_area', room.id, b.id));
    await w.run(w.cast.operator, (c) => plant.endAreaOccupancy(c, occ));
    rs.push(await matches(room.code, 'plant_area', room.id, null));
    expect(rs).toEqual(['DIRTY', 'CLEAN', 'CLEARED_FOR_BATCH', 'IN_USE', 'DIRTY']);
  });
});

describe('area authorisation at the step signature (PR-15, kernel 1190)', () => {
  it('[PR-15] a user without area authorisation cannot sign a step in the controlled area', async () => {
    const suite = await w.room();
    const open = await w.room();
    const product = await w.product();
    await areaRule(suite.code, true, null);
    const batch = await batchWithSteps(db, product, ['p-1']);
    const op = w.cast.operator;
    for (const type of ['SIGN_PERFORMED', 'START_STEP', 'VERIFY']) {
      expect(await stepProblem(db, batch, type, 'p-1', suite.code, op.personId), type).toMatch(new RegExp(`^EBMR-PLANT-180 ${suite.code} is a controlled area: EBMR-IAM-202 Om Operator holds no current authorisation AREA\\.${suite.code}`));
    }
    // Outside the controlled area nothing is asked.
    expect(await stepProblem(db, batch, 'SIGN_PERFORMED', 'p-1', open.code, op.personId)).toBeNull();
    // Bypass: the owner's forged signature row is refused too; the person cannot authorise themselves.
    expect(await forgedCommand(db, batch, 'SIGN_PERFORMED', 'p-1', suite.code, op.personId)).toMatch(/EBMR-PLANT-180/);
    const asTc = <T>(work: Parameters<typeof withCommand<T>>[2]) => withCommand(db.app, withReason(tc), work);
    await expectRefused(withCommand(db.app, withReason(op), (c) => c.query('select iam.create_area_authorisation_type($1, $2)', [suite.code, 'x'])), 'EBMR-IAM-040');
    const code = await asTc(async (c) => (await c.query<{ r: string }>('select iam.create_area_authorisation_type($1, $2) as r', [suite.code, 'Potent suite'])).rows[0]?.r);
    expect(code).toBe(`AREA.${suite.code}`);
    await expectRefused(asTc((c) => c.query('select iam.create_area_authorisation_type($1, $2)', [suite.code, 'again'])), 'EBMR-IAM-201');
    const qid = await asTc(async (c) =>
      (await c.query<{ r: string }>("select iam.record_qualification($1, $2, clock_timestamp() - interval '1 hour', null) as r", [op.personId, code])).rows[0]?.r);
    // Success: authorised, the operator signs; another operator still cannot.
    expect(await stepProblem(db, batch, 'SIGN_PERFORMED', 'p-1', suite.code, op.personId)).toBeNull();
    expect(await forgedCommand(db, batch, 'SIGN_PERFORMED', 'p-1', suite.code, op.personId)).not.toMatch(/EBMR-PLANT-180/);
    expect(await stepProblem(db, batch, 'SIGN_PERFORMED', 'p-1', suite.code, w.cast.operator2.personId)).toMatch(/^EBMR-PLANT-180 /);
    // Withdrawn, the authorisation no longer counts.
    await asTc((c) => c.query('select iam.withdraw_qualification($1, $2)', [qid, 'Left the potent suite team']));
    expect(await stepProblem(db, batch, 'SIGN_PERFORMED', 'p-1', suite.code, op.personId)).toMatch(/^EBMR-PLANT-180 /);
  });
});

describe('the alarm log at the step signature and in review (DI-49)', () => {
  const roomAlarm = (room: string, alarmCode: string) =>
    receive(db, ems, 'plant.receive_equipment_alarm', envelopeFor(ems, 'ems.alarm', {
      subjectKind: 'AREA', subjectCode: room, occurrenceId: `occ-${tag()}`, transition: 'RAISED', alarmCode, severity: '800', tag: 'room.rh_pct',
      value: { value: '61.0', unit: '%RH' }, limit: { value: '60.0', unit: '%RH' }, limitKind: 'HIGH', message: 'Room humidity high', occurredAt: nowUs(),
    }));

  it('[DI-49] an unacknowledged GMP-critical alarm blocks the step signature in its room until it is acknowledged', async () => {
    const room = await w.room();
    const other = await w.room();
    const product = await w.product();
    const batch = await batchWithSteps(db, product, ['p-1']);
    await occupyBatch(w, room.code, batch);
    const b = { id: batch };
    const r = await roomAlarm(room.code, `RH_HIGH_${tag()}`);
    const alarmId = r['alarmId'] as string;
    expect(await stepProblem(db, b.id, 'SIGN_PERFORMED', 'p-1', room.code, w.cast.operator.personId)).toMatch(/^EBMR-ALM-020 DI-49: GMP-critical alarm\(s\) await acknowledgment: RH_HIGH_/);
    expect(await forgedCommand(db, b.id, 'SIGN_PERFORMED', 'p-1', room.code, w.cast.operator.personId)).toMatch(/EBMR-ALM-020/);
    // A step of the batch in another room is not blocked by this room's alarm; a step start is not a signature.
    expect(await stepProblem(db, b.id, 'SIGN_PERFORMED', 'p-1', other.code, w.cast.operator.personId)).toBeNull();
    expect(await stepProblem(db, b.id, 'START_STEP', 'p-1', room.code, w.cast.operator.personId)).toBeNull();
    // The batch's alarm log has it, without its disposition, so review would not pass.
    expect((await db.app.query<{ p: string[] }>('select plant.batch_alarm_review_problems($1) as p', [b.id])).rows[0]?.p).toEqual([expect.stringMatching(/has no disposition/)]);
    await w.run(w.cast.operator, (c) => c.query('select plant.acknowledge_alarm($1, $2, $3, null)', [alarmId, 'Dehumidifier restarted', 'RH back below 60 % within 4 min']));
    expect(await stepProblem(db, b.id, 'SIGN_PERFORMED', 'p-1', room.code, w.cast.operator.personId)).toBeNull();
    expect((await db.app.query<{ p: string[] }>('select plant.batch_alarm_review_problems($1) as p', [b.id])).rows[0]?.p).toEqual([]);
  });

  it('[DI-49] alarms are in the batch\'s review scope: production approval and QA review list each alarm without its disposition', async () => {
    const room = await w.room();
    const product = await w.product();
    const batch = await batchWithSteps(db, product, ['p-1'], 'GMP_BATCH');
    await occupyBatch(w, room.code, batch);
    const minor = `RH_MINOR_${tag()}`;
    await w.run(w.cast.steward, (c) => c.query("select plant.define_alarm_code('EMS', $1, false, false, $2)", [minor, 'minor humidity alarm']));
    await roomAlarm(room.code, minor);
    for (const act of ['PRODUCTION_APPROVE', 'QA_REVIEW']) {
      const problems = (await db.app.query<{ p: string[] }>('select recipe.review_gate_problems($1, $2) as p', [batch, act])).rows[0]?.p ?? [];
      expect(problems.filter((p) => p.includes('alarm log')), act).toEqual([expect.stringMatching(new RegExp(`alarm occ-.* \\(${minor}, not GMP-critical\\) of the batch's alarm log has no disposition`))]);
    }
    const log = (await db.app.query<{ id: string }>('select id from plant.batch_alarms($1)', [batch])).rows;
    await w.run(w.cast.operator, (c) => c.query('select plant.acknowledge_alarm($1, $2, null, null)', [log[0]?.id, 'Noted; within the alert band']));
    for (const act of ['PRODUCTION_APPROVE', 'QA_REVIEW']) {
      const problems = (await db.app.query<{ p: string[] }>('select recipe.review_gate_problems($1, $2) as p', [batch, act])).rows[0]?.p ?? [];
      expect(problems.filter((p) => p.includes('alarm log')), act).toEqual([]);
    }
  });
});
