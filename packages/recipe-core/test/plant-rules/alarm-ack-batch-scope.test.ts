/**
 * The acknowledgment of a plant alarm is authorised in the scope of each batch it is bound to, {site, product}, and only
 * there (Phase 6 exit review 6jc-R16, the rest; recipe-core 1217; IN-04, DI-21, DI-17, DI-49; open question O-T1-1).
 *
 * Before: plant.acknowledge_alarm (recipe-core 0976) checked ALARM.ACKNOWLEDGE unscoped first, then in the scope of every
 * bound batch. The unscoped check names no product, so a requirement limited to any product applied to it (the request
 * may be work on that product: iam.requirement_applies fails closed), and a grant limited to a product never covered it.
 * Now an alarm bound to batches is checked in each batch's scope only; an alarm bound to none is checked unscoped as before.
 * As the application role through real identities and an EMS adapter; the requirements are test arrangement.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectRefused } from '../../../kernel/test/identity/helpers.ts';
import { permissionRequirement, qualify, underRequirement, withStaleLms } from '../../../kernel/test/identity/requirements.ts';
import { seedActor, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { envelopeFor, nowUs, receive, registerAdapter, type TestAdapter } from '../../../kernel/test/integrations/support.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { PlantWorld, seedPlantCast, tag } from '../plant/support.ts';
import { batchWithSteps, occupyBatch } from './support.ts';

let db: TestDatabase;
let w: PlantWorld;
let ems: TestAdapter;

beforeAll(async () => {
  db = await createTestDatabase();
  w = new PlantWorld(db, await seedPlantCast(db));
  ems = await registerAdapter(db, 'EMS');
}, 300_000);
afterAll(async () => {
  await db.drop();
});

const roomAlarm = async (room: string): Promise<string> =>
  (await receive(db, ems, 'plant.receive_equipment_alarm', envelopeFor(ems, 'ems.alarm', {
    subjectKind: 'AREA', subjectCode: room, occurrenceId: `occ-${tag()}`, transition: 'RAISED', alarmCode: `RH_HIGH_${tag()}`, severity: '800', tag: 'room.rh_pct',
    value: { value: '61.0', unit: '%RH' }, limit: { value: '60.0', unit: '%RH' }, limitKind: 'HIGH', message: 'Room humidity high', occurredAt: nowUs(),
  })))['alarmId'] as string;

/** A room alarm bound to one batch of a new product (the room cleaned, cleared and occupied by the batch). */
async function boundAlarm(): Promise<{ alarmId: string; product: string; batchId: string }> {
  const room = await w.room();
  const product = await w.product();
  const batchId = await batchWithSteps(db, product, ['p-1'], 'GMP_BATCH');
  await occupyBatch(w, room.code, batchId);
  const alarmId = await roomAlarm(room.code);
  expect((await db.app.query('select batch_id from plant.alarm_batch where alarm_id = $1', [alarmId])).rows).toEqual([{ batch_id: batchId }]);
  return { alarmId, product, batchId };
}

const acknowledge = (alarmId: string, who: SeededActor = w.cast.operator) =>
  w.run(who, (c) => c.query('select plant.acknowledge_alarm($1, $2, $3, null)', [alarmId, 'Dehumidifier restarted', 'RH back below 60 % within 5 min']));
const acknowledgedBy = async (alarmId: string): Promise<string[]> =>
  (await db.app.query<{ p: string }>('select person_id::text as p from plant.alarm_ack where alarm_id = $1', [alarmId])).rows.map((r) => r.p);

describe('the alarm acknowledgment in the batch\'s {site, product} scope (6jc-R16)', () => {
  it('[IN-04][DI-21][DI-49] a product-limited requirement no longer refuses the alarm acknowledgment on another product\'s batch', async () => {
    const { alarmId } = await boundAlarm();
    const req = await permissionRequirement(db, 'ALARM.ACKNOWLEDGE', `OTHER-${tag()}`);
    await underRequirement(db, req, async () => {
      await acknowledge(alarmId);
      expect(await acknowledgedBy(alarmId)).toEqual([w.cast.operator.personId]);
    });
  });

  it('[IN-04][DI-21][DI-49] the alarm acknowledgment: this product\'s requirement still applies, and once qualified the person acknowledges', async () => {
    const { alarmId, product } = await boundAlarm();
    const req = await permissionRequirement(db, 'ALARM.ACKNOWLEDGE', product);
    await underRequirement(db, req, async () => {
      await expectRefused(acknowledge(alarmId), 'EBMR-IAM-040', new RegExp(`ALARM\\.ACKNOWLEDGE.*MISSING_QUALIFICATION:${req.code}`));
      expect(await acknowledgedBy(alarmId)).toEqual([]);
      await qualify(db, w.cast.operator.personId, req);
      await acknowledge(alarmId);
      expect(await acknowledgedBy(alarmId)).toEqual([w.cast.operator.personId]);
    });
  });

  it('[IN-04][DI-21][DI-49] the alarm acknowledgment: a requirement without a product limit still applies', async () => {
    const { alarmId } = await boundAlarm();
    const req = await permissionRequirement(db, 'ALARM.ACKNOWLEDGE');
    await underRequirement(db, req, async () => {
      await expectRefused(acknowledge(alarmId), 'EBMR-IAM-040', new RegExp(`MISSING_QUALIFICATION:${req.code}`));
      expect(await acknowledgedBy(alarmId)).toEqual([]);
    });
  });

  it('[IN-04][DI-31][DI-49] the alarm acknowledgment: a stale qualification source is still refused', async () => {
    const { alarmId, product } = await boundAlarm();
    const req = await permissionRequirement(db, 'ALARM.ACKNOWLEDGE', product);
    await underRequirement(db, req, async () => {
      await qualify(db, w.cast.operator.personId, req, 'LMS');
      await withStaleLms(db, () => expectRefused(acknowledge(alarmId), 'EBMR-IAM-040', new RegExp(`STALE_QUALIFICATION_SOURCE:${req.code}`)));
      expect(await acknowledgedBy(alarmId)).toEqual([]);
    });
  });

  it('[DI-17][DI-49] O-T1-1: a person whose grant is limited to one product acknowledges an alarm bound only to batches of that product, not one bound to another product nor one bound to no batch', async () => {
    const { alarmId, product } = await boundAlarm();
    const other = await boundAlarm();
    const scoped = await seedActor(db, { roleCode: 'OPERATOR', legalName: 'Priya Product-scoped', scope: { product } });
    await expectRefused(acknowledge(other.alarmId, scoped), 'EBMR-IAM-040', /ALARM\.ACKNOWLEDGE/);
    // An alarm of a room no batch occupies is bound to none: the right is checked unscoped, as before.
    const empty = await w.room();
    const unbound = await roomAlarm(empty.code);
    expect((await db.app.query('select 1 from plant.alarm_batch where alarm_id = $1', [unbound])).rowCount).toBe(0);
    await expectRefused(acknowledge(unbound, scoped), 'EBMR-IAM-040', /ALARM\.ACKNOWLEDGE in scope \{\}/);
    await acknowledge(alarmId, scoped);
    expect(await acknowledgedBy(alarmId)).toEqual([scoped.personId]);
    await acknowledge(unbound);
    expect(await acknowledgedBy(unbound)).toEqual([w.cast.operator.personId]);
  });
});
