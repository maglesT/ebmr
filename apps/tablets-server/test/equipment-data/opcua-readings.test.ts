/**
 * Process readings taken over OPC UA on the gateway path (tablets 1210 over 0820; recipe-core 0961; DI-32, DI-20,
 * DI-31): the listener takes a request whose readings carry their native original record through
 * tab.ingest_opcua_readings. The gateway speaks the integration-sdk process wire to the listener; bypasses go straight
 * to the database as the application role.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enrol, fakeGateway, type FakeGateway } from '../devices/support.ts';
import { startServer, type TestServer } from '../support/harness.ts';
import { opcuaWorld, reportSession, type OpcuaWorld } from './opcua-support.ts';

let server: TestServer;
let gw: FakeGateway;
let w: OpcuaWorld;
const RUN = randomUUID();
let seq = 0;

beforeAll(async () => {
  server = await startServer('SANDBOX');
  const chainId = await enrol(server);
  gw = await fakeGateway(server);
  w = await opcuaWorld(server, chainId);
}, 300_000);
afterAll(async () => {
  await gw?.close();
  await server?.close();
});

type Json = Record<string, unknown>;
const reading = (value: string, raw: string | null, over: Json = {}, nativeOver: Json = {}): Json => {
  seq += 1;
  const base: Json = { deviceSerial: w.device.serial, tag: 'force.main_kN', value, unit: 'kN', quality: 'GOOD', sourceTime: String(1790584618000000 + seq * 1000), sequence: String(seq), kind: 'ACTUAL', ...over };
  if (raw !== null) base['native'] = { raw, status: '0x00000000', deviceTime: String(1790584617000000 + seq * 1000), endpointCode: w.endpoint.code, ...nativeOver };
  return base;
};
const send = (readings: Json[]) => gw.post('/gw/v1/process-readings', { sessionId: RUN, readings });
const errorOf = (r: { status: number; body: unknown }): string => JSON.stringify(r.body);

async function stored(): Promise<{ value: string; raw: string | null; status: string | null }[]> {
  const { rows } = await server.db.app.query<{ value: string; raw: string | null; status: string | null }>(
    'select r.value, n.raw, n.status from tab.process_reading r left join tab.process_reading_native n on n.reading_id = r.id where r.serial = $1 order by r.seq',
    [w.device.serial],
  );
  return rows;
}

describe('OPC UA readings on the gateway path (DI-32, DI-20)', () => {
  it('[DI-32] an OPC UA reading stores raw output equal to the displayed value', async () => {
    expect(await reportSession(server, w)).toMatchObject({ applied: 'SESSION_VALID' });
    const r = await send([reading('12.50', '12.5'), reading('12.43', '1.243E1')]);
    expect(r.status, errorOf(r)).toBe(200);
    expect(await stored()).toEqual([
      { value: '12.50', raw: '12.5', status: '0x00000000' },
      { value: '12.43', raw: '1.243E1', status: '0x00000000' },
    ]);
    // The same request again is a duplicate (nothing stored twice); the same sequence with another original record is refused.
    seq -= 2;
    const again = await send([reading('12.50', '12.5'), reading('12.43', '1.243E1')]);
    expect(again.status, errorOf(again)).toBe(200);
    seq -= 1;
    const changed = await send([reading('12.43', '12.430')]);
    expect(changed.status).toBe(422);
    expect(errorOf(changed)).toMatch(/EBMR-DEV-176/);
    expect(await stored()).toHaveLength(2);
  });

  it('[DI-32] a rounded display, a quality that contradicts the status, a reading of an OPC UA unit without its original record are refused; nothing lands', async () => {
    await reportSession(server, w);
    const before = (await stored()).length;
    // The device sent 12.499; showing 12.50 would be a rounding (the wire validator and the database both refuse it).
    const rounded = await send([reading('12.50', '12.499')]);
    expect(rounded.status).toBe(400);
    seq -= 1;
    const bad = await send([reading('12.50', '12.5', {}, { status: '0x80000000' })]);
    expect(bad.status).toBe(422);
    expect(errorOf(bad)).toMatch(/EBMR-DEV-173/);
    seq -= 1;
    // The old path without the original record: refused at commit for a unit behind an OPC UA endpoint (bypass).
    const plain = await send([reading('12.50', null)]);
    expect(plain.status).toBe(422);
    expect(errorOf(plain)).toMatch(/EBMR-DEV-171/);
    seq -= 1;
    // Another endpoint than the enrolled one.
    const other = await send([reading('12.50', '12.5', {}, { endpointCode: 'OPC-SOMEONE-ELSE' })]);
    expect(errorOf(other)).toMatch(/EBMR-DEV-174/);
    seq -= 1;
    expect(await stored()).toHaveLength(before);
    // The application role cannot write an original record or a reading itself.
    await expect(server.db.app.query("insert into tab.process_reading_native (reading_id, raw, status, device_time_us, endpoint_device_id, endpoint_session_id) values (gen_random_uuid(), '1', '0x00000000', 0, gen_random_uuid(), gen_random_uuid())")).rejects.toThrow(/permission denied/);
    await expect(server.db.app.query('delete from tab.process_reading_native')).rejects.toThrow(/permission denied/);
  });

  it('[DI-20] readings of a unit whose endpoint session was refused (certificate changed) are refused until a valid session', async () => {
    const changed = await reportSession(server, w, { certificateThumbprint: 'a'.repeat(64) });
    expect(changed).toMatchObject({ applied: 'SESSION_REFUSED', refusal: 'CERTIFICATE_CHANGED' });
    const r = await send([reading('12.50', '12.5')]);
    expect(r.status).toBe(422);
    expect(errorOf(r)).toMatch(/EBMR-DEV-175 DI-20: the session of endpoint .* was refused \(CERTIFICATE_CHANGED\)/);
    seq -= 1;
    await reportSession(server, w);
    expect((await send([reading('12.50', '12.5')])).status).toBe(200);
  });
});
