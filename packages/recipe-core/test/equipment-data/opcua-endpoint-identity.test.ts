/**
 * OPC UA endpoint identity (recipe-core 0961; DI-20, D-P6b-2): each endpoint is a registered INSTRUMENT with its
 * certificate thumbprint and room or line, enrolled with the units it serves; the gateway reports each session; data of
 * a unit stand on a VALID session of its endpoint. As the application role through real identities (the OPCUA adapter
 * of the 6a framework, the device administrator, the plant cast), with bypass attempts.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '../../../kernel/src/db/command.ts';
import { expectRefused } from '../../../kernel/test/identity/helpers.ts';
import { seedAdministration, withReason } from '../../../kernel/test/identity/seed.ts';
import { envelopeFor, nowUs, receive, recordRefusal, registerAdapter, type TestAdapter } from '../../../kernel/test/integrations/support.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { PlantWorld, seedPlantCast } from '../plant/support.ts';
import { enrol, enrolEndpoint, reportSession, sessionPayload, type TestEndpoint } from './support.ts';

let db: TestDatabase;
let w: PlantWorld;
let opcua: TestAdapter;

beforeAll(async () => {
  db = await createTestDatabase();
  w = new PlantWorld(db, await seedPlantCast(db));
  opcua = await registerAdapter(db, 'OPCUA');
}, 300_000);
afterAll(async () => {
  await db.drop();
});

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

function chunk(subjectCode: string, chunkNo: string, startUs: bigint): Record<string, unknown> {
  const samples = [0n, 1n, 2n].map((i) => ({ sourceTime: (startUs + i * 100_000n).toString(), serverTime: null, raw: '12.5', value: '12.50', status: '0x00000000' }));
  const c = { subjectKind: 'EQUIPMENT', subjectCode, tag: 'force.main_kN', unit: 'kN', chunkNo, samples };
  const text = [[c.subjectKind, c.subjectCode, c.tag, c.unit, c.chunkNo].join('|'), ...samples.map((s) => [s.sourceTime, '', s.raw, s.value, s.status].join('|'))].join('\n');
  return { ...c, chunkHash: sha(text) };
}
const sendChunk = (payload: unknown) => receive(db, opcua, 'plant.receive_series_chunk', envelopeFor(opcua, 'opcua.series_chunk', payload));
// Slice 7b-1 (6jc-R13, recipe-core 1233): data are dated within five minutes of the session they stand on.
let clock = BigInt(Date.now()) * 1000n - 150_000_000n;
const nextStart = (): bigint => (clock += 10_000_000n);

async function admin<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const { admin: a } = await seedAdministration(db);
  return withCommand(db.app, withReason(a), fn);
}

/** A refused data message is recorded by the worker with its alarm (6a pattern); returns the alarm's kind. */
async function refusedWithAlarm(payload: unknown, code: string, pattern: RegExp): Promise<void> {
  const env = envelopeFor(opcua, 'opcua.series_chunk', payload);
  await expectRefused(receive(db, opcua, 'plant.receive_series_chunk', env), code, pattern);
  const exceptionId = await recordRefusal(db, opcua, env, 'WRONG_IDENTITY', `${code} (test)`);
  const { rows } = await db.app.query<{ kind: string }>(
    'select a.kind from platform.inbound_exception e join platform.integration_alarm a on a.id = e.alarm_id where e.id = $1',
    [exceptionId],
  );
  expect(rows).toEqual([{ kind: 'WRONG_IDENTITY' }]);
}

async function pressIn(): Promise<{ press: { id: string; code: string }; room: { id: string; code: string } }> {
  return { press: await w.press(), room: await w.room() };
}

describe('OPC UA endpoint identity (DI-20)', () => {
  it('[DI-20] data from an unregistered or relocated OPC UA endpoint is refused with an alarm', async () => {
    const { press, room } = await pressIn();
    // No endpoint serves the unit: its data are refused.
    await refusedWithAlarm(chunk(press.code, '1', nextStart()), 'EBMR-EQD-002', /served by no enrolled OPC UA endpoint/);
    const ep = await enrolEndpoint(db, room, [press.code]);
    // Enrolled, but no session reported yet.
    await refusedWithAlarm(chunk(press.code, '1', nextStart()), 'EBMR-EQD-002', /no session of endpoint/);
    expect(await reportSession(db, opcua, ep)).toMatchObject({ outcome: 'ACCEPTED', applied: 'SESSION_VALID', refusal: null });
    expect(await sendChunk(chunk(press.code, '1', nextStart()))).toMatchObject({ outcome: 'ACCEPTED', applied: 'RECORDED' });

    // A session from an endpoint nobody registered is recorded REFUSED with an integration alarm and a security alert.
    const ghost: TestEndpoint = { ...ep, code: `OPC-GHOST-${randomBytes(2).toString('hex').toUpperCase()}` };
    const g = await reportSession(db, opcua, ghost);
    expect(g).toMatchObject({ outcome: 'ACCEPTED', applied: 'SESSION_REFUSED', refusal: 'UNREGISTERED' });
    expect((await db.app.query('select kind, severity from platform.integration_alarm where id = $1', [g['alarmId']])).rows).toEqual([{ kind: 'WRONG_IDENTITY', severity: 'CRITICAL' }]);

    // The endpoint now reports another room (moved without re-registration): REFUSED with an alarm, and its data after it too.
    const other = await w.room();
    const moved = await reportSession(db, opcua, ep, { reportedLocation: other.code });
    expect(moved).toMatchObject({ applied: 'SESSION_REFUSED', refusal: 'RELOCATED' });
    const alert = (await db.admin.query<{ kind: string }>('select s.kind from plant.opcua_endpoint_session x join iam.security_alert s on s.id = x.security_alert_id where x.id = $1', [moved['sessionId']])).rows;
    expect(alert).toEqual([{ kind: 'DEVICE_LOCATION_MISMATCH' }]);
    await refusedWithAlarm(chunk(press.code, '2', nextStart()), 'EBMR-EQD-002', /refused \(RELOCATED\)/);
    // A VALID session again, then the registry relocates the device: its data are refused until it is enrolled again.
    await reportSession(db, opcua, ep);
    expect(await sendChunk(chunk(press.code, '2', nextStart()))).toMatchObject({ outcome: 'ACCEPTED' });
    await admin((c) => c.query('select iam.relocate_device($1, $2, null, $3)', [ep.deviceId, other.code, 'moved to the other room']));
    await refusedWithAlarm(chunk(press.code, '3', nextStart()), 'EBMR-EQD-002', /relocated after its enrolment/);
    // Re-enrolled in the new room with a new session, the data are accepted again; nothing in between was recorded.
    await enrol(db, ep.code, ep.url, [press.code]);
    await expectRefused(sendChunk(chunk(press.code, '3', nextStart())), 'EBMR-EQD-002', /predates its enrolment in force/);
    await reportSession(db, opcua, { ...ep, areaCode: other.code });
    expect(await sendChunk(chunk(press.code, '3', nextStart()))).toMatchObject({ outcome: 'ACCEPTED' });
    expect((await db.app.query('select chunk_no::int as n from plant.series where equipment_id = $1 order by chunk_no', [press.id])).rows).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it('[DI-20] a changed certificate, an insecure session, another URL, a blocked or retired endpoint and an unserved unit are refused; data follow the verdict', async () => {
    const { press, room } = await pressIn();
    const ep = await enrolEndpoint(db, room, [press.code]);
    const cases: [Record<string, unknown>, string][] = [
      [{ certificateThumbprint: randomBytes(32).toString('hex') }, 'CERTIFICATE_CHANGED'],
      [{ securityMode: 'None' }, 'INSECURE'],
      [{ securityMode: 'Sign' }, 'INSECURE'],
      [{ securityPolicy: 'Basic128Rsa15' }, 'INSECURE'],
      [{ endpointUrl: 'opc.tcp://elsewhere:4840/' }, 'URL_CHANGED'],
      [{ equipmentCodes: [press.code, 'EQ-NOT-SERVED'] }, 'UNIT_NOT_SERVED'],
    ];
    for (const [over, refusal] of cases) {
      expect(await reportSession(db, opcua, ep, over), refusal).toMatchObject({ applied: 'SESSION_REFUSED', refusal });
      await expectRefused(sendChunk(chunk(press.code, '1', nextStart())), 'EBMR-EQD-002', new RegExp(`refused \\(${refusal}\\)`));
    }
    await reportSession(db, opcua, ep);
    expect(await sendChunk(chunk(press.code, '1', nextStart()))).toMatchObject({ outcome: 'ACCEPTED' });
    // Blocked in the registry: the data stop at once (no new session needed to see it), and a new session is refused.
    await admin((c) => c.query("select iam.set_device_status($1, 'BLOCKED', 'certificate compromised')", [ep.deviceId]));
    await expectRefused(sendChunk(chunk(press.code, '2', nextStart())), 'EBMR-EQD-002', /is BLOCKED/);
    expect(await reportSession(db, opcua, ep)).toMatchObject({ refusal: 'BLOCKED' });
    await admin((c) => c.query("select iam.set_device_status($1, 'ACTIVE', 'new certificate checked')", [ep.deviceId]));
    expect(await reportSession(db, opcua, ep)).toMatchObject({ applied: 'SESSION_VALID' });
    await admin((c) => c.query('select plant.retire_opcua_endpoint($1, $2)', [ep.code, 'replaced']));
    await expectRefused(sendChunk(chunk(press.code, '2', nextStart())), 'EBMR-EQD-002', /served by no enrolled/);
    expect(await reportSession(db, opcua, ep)).toMatchObject({ refusal: 'RETIRED' });
  });

  it('[DI-20] equipment events and OPC UA alarms of a unit without a valid session are refused as well', async () => {
    const { press } = await pressIn();
    const event = { equipmentCode: press.code, eventId: `ev-${randomBytes(4).toString('hex')}`, kind: 'STATE_CHANGED', state: 'RUNNING', recipeVersion: null, message: 'Started', occurredAt: nowUs() };
    await expectRefused(receive(db, opcua, 'plant.receive_equipment_event', envelopeFor(opcua, 'opcua.equipment_event', event)), 'EBMR-EQD-002', /DI-20/);
    const alarm = {
      subjectKind: 'EQUIPMENT', subjectCode: press.code, occurrenceId: `occ-${randomBytes(4).toString('hex')}`, transition: 'RAISED', alarmCode: 'REJECT_BURST', severity: '700',
      tag: null, value: null, limit: null, limitKind: null, message: 'Reject burst', occurredAt: nowUs(),
    };
    await expectRefused(receive(db, opcua, 'plant.receive_equipment_alarm', envelopeFor(opcua, 'opcua.alarm', alarm)), 'EBMR-ALM-002', /DI-20/);
  });

  it('[DI-20] enrolment: the registry permission, an instrument in a plant room or line, units installed there and served once; the tables refuse direct writes', async () => {
    const { press, room } = await pressIn();
    const ep = await enrolEndpoint(db, room, [press.code]);
    // An operator or the adapter cannot enrol (IAM.DEVICE_MANAGE).
    await expectRefused(w.run(w.cast.operator, (c) => c.query("select plant.enrol_opcua_endpoint($1, $2, 'Basic256Sha256', $3, 'x')", [ep.code, ep.url, [press.code]])), 'EBMR-IAM-040');
    await expectRefused(w.run(opcua.actor, (c) => c.query("select plant.enrol_opcua_endpoint($1, $2, 'Basic256Sha256', $3, 'x')", [ep.code, ep.url, [press.code]])), 'EBMR-IAM-040');
    await expectRefused(enrol(db, ep.code, ep.url, [press.code], 'None'), 'EBMR-EQD-033');
    await expectRefused(enrol(db, ep.code, 'http://x', [press.code]), 'EBMR-EQD-033');
    await expectRefused(enrol(db, `NOPE-${randomBytes(2).toString('hex')}`, ep.url, [press.code]), 'EBMR-EQD-031');
    await expectRefused(enrol(db, ep.code, ep.url, []), 'EBMR-EQD-034');
    await expectRefused(enrol(db, ep.code, ep.url, ['EQ-UNKNOWN-UNIT']), 'EBMR-EQD-035');
    // A unit is served by one enrolled endpoint at a time.
    const room2 = await w.room();
    await expectRefused(enrolEndpoint(db, room2, [press.code]), 'EBMR-EQD-037');
    // An endpoint registered on no plant room or line cannot be enrolled.
    await expectRefused(enrolEndpoint(db, { code: 'RM-NOT-A-PLANT-ROOM' }, [press.code]), 'EBMR-EQD-032');
    for (const t of ['plant.opcua_endpoint', 'plant.opcua_endpoint_unit', 'plant.opcua_endpoint_session']) {
      await expect(db.app.query(`delete from ${t}`), t).rejects.toThrow(/permission denied/);
      await expect(db.app.query(`truncate ${t}`), t).rejects.toThrow(/permission denied/);
    }
    await expect(db.app.query("update plant.opcua_endpoint set area_id = area_id")).rejects.toThrow(/permission denied/);
    await expect(db.app.query("insert into plant.opcua_endpoint_session (endpoint_code) values ('x')")).rejects.toThrow(/permission denied/);
    const c = await db.admin.connect();
    try {
      await c.query('set role ebmr_owner');
      await expect(c.query("update plant.opcua_endpoint set reason = 'changed' where device_code = $1", [ep.code])).rejects.toThrow(/EBMR-AUDIT|insert-only/i);
    } finally {
      await c.query('reset role');
      c.release();
    }
  });

  it('[DI-32] a chunk is held as received and as the checked series row; the audit trail holds the row hash only (D-P6b-A-1)', async () => {
    const { press, room } = await pressIn();
    const ep = await enrolEndpoint(db, room, [press.code]);
    await reportSession(db, opcua, ep, sessionPayload(ep));
    const r = await sendChunk(chunk(press.code, '1', nextStart()));
    const { rows } = await db.admin.query<{ payload: Record<string, unknown> }>(
      "select e.payload from kernel.audit_event e where e.table_name = 'plant.series' and e.record_id = $1", [r['seriesId']],
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]!.payload)).not.toMatch(/"samples"|sourceTime/);
    expect(JSON.stringify(rows[0]!.payload)).toMatch(/row_hash/);
    const same = (await db.app.query<{ same: boolean }>(
      'select s.samples = m.payload -> \'samples\' as same from plant.series s join platform.inbound_message m on m.id = s.inbound_message_id where s.id = $1', [r['seriesId']],
    )).rows[0]!.same;
    expect(same).toBe(true);
  });
});
