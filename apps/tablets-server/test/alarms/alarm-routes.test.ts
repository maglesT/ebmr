/**
 * The alarms and equipment-data routes (Phase 6 slice 6b-0; DI-49, DI-32, INV-40; contract ns/alarms.ts,
 * ns/equipment-data.ts; recipe-core 0960): the plant alarm list and an alarm; a person acknowledges a GMP-critical
 * alarm from a shared kiosk only with a fresh tap, only with a comment, once; QA without ALARM.ACKNOWLEDGE cannot.
 * The alarm row is arranged by the superuser with triggers off (test set-up only; raising is tested in recipe-core).
 */
import { randomUUID } from 'node:crypto';
import { routes } from '@ebmr/api-contract';
import { EMS_TAGS } from '@ebmr/integration-sdk/adapter';
import { PROCESS_TAGS } from '@ebmr/integration-sdk/process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { personaIn, refusalOf, tapFor, valueOf } from '../esig/support.ts';
import { startServer, type TestServer } from '../support/harness.ts';

const A = routes.alarms;
let gmp: TestServer;
let alarmId = '';
const roomCode = `RM-ALM-${randomUUID().slice(0, 6).toUpperCase()}`;

beforeAll(async () => {
  gmp = await startServer('GMP');
  const c = await gmp.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    const area = (await c.query<{ id: string }>(
      "insert into plant.area (code, kind, name, segregated, negative_pressure, recorded_by) values ($1, 'ROOM', 'Compression room', false, false, gen_random_uuid()) returning id",
      [roomCode],
    )).rows[0]!.id;
    alarmId = (await c.query<{ id: string }>(
      `insert into plant.alarm (source, occurrence_id, subject_kind, area_id, alarm_code, gmp_critical, deviation_required, severity, tag, value, value_unit,
                                limit_value, limit_unit, limit_kind, message, raised_source_us, raised_by_person, raised_by_account, correlation_id)
       values ('EMS', $1, 'AREA', $2, 'RH_HIGH', true, false, 500, 'room.rh_pct', '61.2', '%RH', '60.0', '%RH', 'HIGH', 'Room humidity above 60 %RH',
               1792000060000000, gen_random_uuid(), gen_random_uuid(), gen_random_uuid()) returning id`,
      [`EMS-${randomUUID()}`, area],
    )).rows[0]!.id;
    await c.query('commit');
  } finally {
    c.release();
  }
}, 300_000);
afterAll(async () => {
  await gmp?.close();
});

describe('alarms routes (DI-49)', () => {
  it('[DI-49] the alarm list and the alarm show a room alarm with its limit, source time and no acknowledgment', async () => {
    const qa = await gmp.asPersona('qaInvestigator');
    const open = valueOf(await qa.call(A.list, { query: { subjectCode: roomCode } })).alarms;
    expect(open).toEqual([expect.objectContaining({ alarmId, source: 'EMS', subject: { kind: 'AREA', code: roomCode }, gmpCritical: true, codeVersion: null, acknowledgement: null })]);
    expect(open[0]?.limit).toEqual({ value: '60.0', unit: '%RH', kind: 'HIGH' });
    expect(open[0]?.raisedAtSource.us).toBe('1792000060000000');
    expect(refusalOf(await qa.call(A.alarm, { params: { alarmId: randomUUID() } }))?.status).toBe(404);
    expect(valueOf(await qa.call(A.batchLog, { params: { batchId: randomUUID() } })).alarms).toEqual([]);
  });

  it('[DI-49][INV-40] a GMP-critical alarm is acknowledged from a kiosk only with a fresh tap and a comment, once; QA without ALARM.ACKNOWLEDGE cannot', async () => {
    const kiosk = await gmp.asPersona('operator1');
    const path = `/api/alarms/${alarmId}/acknowledge`;
    const noComment = { actionTaken: 'Dehumidifier checked and restarted' };
    expect(refusalOf(await kiosk.call(A.acknowledge, { params: { alarmId }, body: noComment }))).toMatchObject({ status: 428, code: 'TAP_REQUIRED' });
    expect(refusalOf(await kiosk.call(A.acknowledge, { params: { alarmId }, body: noComment, attribution: await tapFor(kiosk, personaIn(gmp, 'operator1'), 'POST', path, noComment) })))
      .toMatchObject({ status: 422, code: 'EBMR-ALM-013' });
    const qa = await gmp.asPersona('qaInvestigator');
    const body = { ...noComment, comment: 'RH 61.2 %RH for 4 min; granules in closed containers' };
    expect(refusalOf(await qa.call(A.acknowledge, { params: { alarmId }, body }))?.status).toBeGreaterThanOrEqual(400);
    const acked = valueOf(await kiosk.call(A.acknowledge, { params: { alarmId }, body, attribution: await tapFor(kiosk, personaIn(gmp, 'operator1'), 'POST', path, body) }));
    expect(acked.acknowledgement).toMatchObject({ actionTaken: body.actionTaken, comment: body.comment, deviationRef: null, by: { personId: personaIn(gmp, 'operator1').personId } });
    expect(refusalOf(await kiosk.call(A.acknowledge, { params: { alarmId }, body, attribution: await tapFor(kiosk, personaIn(gmp, 'operator1'), 'POST', path, body) }))).toMatchObject({ status: 409, code: 'EBMR-ALM-016' });
    expect(valueOf(await qa.call(A.list, { query: { state: 'ACKNOWLEDGED', subjectCode: roomCode } })).alarms.map((a) => a.alarmId)).toEqual([alarmId]);
  });

  it('[DI-32] the series tags list every released process tag and the EMS room tags', async () => {
    const qa = await gmp.asPersona('qaInvestigator');
    const tags = valueOf(await qa.call(routes.equipmentData.tags)).tags;
    expect(tags.find((t) => t.tag === 'force.main_kN')).toEqual({ tag: 'force.main_kN', subjectKind: 'EQUIPMENT', equipmentType: 'PRESS', unit: 'kN', scale: '2' });
    expect(tags.filter((t) => t.subjectKind === 'AREA').map((t) => t.tag).sort()).toEqual(['room.rh_pct', 'room.temp_C']);
    // The database's tag list is the SDK's: every released process tag (with its kind, unit and digits) and the EMS tags.
    const want = [
      ...PROCESS_TAGS.map((t) => ({ tag: t.tag, subjectKind: 'EQUIPMENT', equipmentType: t.equipment, unit: t.unit, scale: t.scale.toString() })),
      ...EMS_TAGS.map((t) => ({ tag: t.tag, subjectKind: 'AREA', equipmentType: null, unit: t.unit, scale: t.scale.toString() })),
    ];
    const byTag = (a: { tag: string }, b: { tag: string }) => a.tag.localeCompare(b.tag);
    expect([...tags].sort(byTag)).toEqual(want.sort(byTag));
    const page = valueOf(await qa.call(routes.equipmentData.series, { query: { subjectKind: 'AREA', subjectCode: roomCode, tag: 'room.rh_pct', fromUs: '0', toUs: '1900000000000000' } }));
    expect(page).toEqual({ chunks: [], nextAfter: null });
  });
});
