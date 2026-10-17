/**
 * Kill tests of the SQL mutation group "equipment-data-and-alarms" on the tablets side (tablets 1210; Phase 6 exit,
 * decision 0019): the OPC UA readings of the gateway path checked in the database alone. The listener's wire validator
 * refuses a malformed or rounded reading before the database sees it (opcua-readings.test.ts), so these cases go
 * straight to tab.ingest_opcua_readings in the gateway's own validated command, as a writer that bypasses the server
 * would. Fixtures (a gateway key bound to the session, process devices, endpoint enrolments) are written with
 * session_replication_role = replica in a transaction that is always rolled back (kill-support.ts).
 *
 * Controls: DI-32 (the shown value is the raw value the device sent; the original record is kept), DI-31 (device data
 * checked as received), DI-20 (the reading's endpoint is the enrolled endpoint of its device).
 */
import type { PoolClient } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { openServiceSession } from '@ebmr/test-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type TestServer } from '../support/harness.ts';
import { attempt, inActor, replica, tag, type Json } from './kill-support.ts';

let gmp: TestServer;
beforeAll(async () => {
  gmp = await startServer('GMP');
}, 180_000);
afterAll(async () => {
  await gmp?.close();
});

/** A gateway key bound to `session`, and a process device of that key with serial `serial`; the key's id. */
async function gatewayWithDevice(c: PoolClient, session: string, serial: string): Promise<{ key: string; device: string }> {
  const t = tag();
  const site = (await c.query<{ s: string }>('select site_code as s from iam.device limit 1')).rows[0]?.s ?? 'SITE-1';
  const key = (await c.query<{ id: string }>(
    `insert into tab.gateway_key (gateway_device_id, gateway_code, account_id, public_key_spki, key_fingerprint, status, enrolled_by_person)
     values (gen_random_uuid(), $1, gen_random_uuid(), encode(sha256(convert_to($1, 'UTF8')), 'base64'), encode(sha256(convert_to($1, 'UTF8')), 'hex'), 'ACTIVE', gen_random_uuid())
     returning id::text`,
    [`GW-${t}`],
  )).rows[0]!.id;
  await c.query("insert into tab.gateway_session (token_hash, session_id, gateway_key_id) values (encode(sha256(convert_to($1, 'UTF8')), 'hex'), $2, $3)", [randomUUID(), session, key]);
  const instrument = (await c.query<{ id: string }>(
    `insert into iam.device (code, device_class, site_code, room_code, key_fingerprint, status, description, registered_by_person)
     values ($1, 'INSTRUMENT', $2, 'DISP-1', encode(sha256(convert_to($1, 'UTF8')), 'hex'), 'ACTIVE', 'kill test device', gen_random_uuid()) returning id::text`,
    [`DEV-${t}`, site],
  )).rows[0]!.id;
  const device = (await c.query<{ id: string }>(
    `insert into tab.process_device (gateway_key_id, instrument_device_id, device_code, serial, equipment_kind, bound_by_person)
     values ($1, $2, $3, $4, 'PRESS', gen_random_uuid()) returning id::text`,
    [key, instrument, `DEV-${t}`, serial],
  )).rows[0]!.id;
  return { key, device };
}

/** An endpoint version of `deviceId` (a registry device id) with the units it serves; its row id. */
async function endpointVersion(c: PoolClient, deviceId: string, code: string, version: number, status: 'ENROLLED' | 'RETIRED', units: string[]): Promise<string> {
  const id = (await c.query<{ id: string }>(
    `insert into plant.opcua_endpoint (device_id, device_code, version, status, endpoint_url, security_policy, certificate_thumbprint, area_id, reason,
                                       recorded_by_person, recorded_by_account, correlation_id)
     values ($1, $2, $3, $4, 'opc.tcp://kill.plant.local:4840', 'Basic256Sha256', encode(sha256(convert_to($2, 'UTF8')), 'hex'), gen_random_uuid(), 'kill test',
             gen_random_uuid(), gen_random_uuid(), gen_random_uuid()) returning id::text`,
    [deviceId, code, version, status],
  )).rows[0]!.id;
  for (const u of units) await c.query('insert into plant.opcua_endpoint_unit (endpoint_id, equipment_id) values ($1, $2)', [id, u]);
  return id;
}

describe('OPC UA readings checked in the database (tablets 1210)', () => {
  it('[DI-31][DI-32] the request and each native original record are refused for each malformed field on its own; a raw value of 40 characters is taken', async () => {
    const actor = await openServiceSession(gmp.db, gmp.seed, 'gateway');
    await inActor(gmp, actor, async (c) => {
      await replica(c, () => gatewayWithDevice(c, actor.sessionId, `S-${tag()}`));
      const run = randomUUID();
      const native = (over: Json = {}): Json => ({ raw: '12.5', status: '0x00000000', deviceTime: '1790584617000000', endpointCode: 'OPC-KILL-1', ...over });
      const reading = (over: Json = {}, nat: unknown = native()): Json => ({
        deviceSerial: `NO-SUCH-${tag()}`, tag: 'force.main_kN', value: '12.50', unit: 'kN', quality: 'GOOD', sourceTime: '1790584618000000', sequence: '1', kind: 'ACTUAL', native: nat, ...over,
      });
      const ingest = (body: unknown) => attempt(c, 'select tab.ingest_opcua_readings($1) as r', [JSON.stringify(body)]);
      const outcome = async (body: unknown): Promise<string> => {
        const o = await ingest(body);
        return o.ok ? 'ok' : o.message;
      };
      // The request: an object whose readings are an array.
      expect(await outcome([reading()])).toMatch(/^EBMR-DEV-121 DI-31: the process readings are not in the expected form/);
      expect(await outcome({ sessionId: run, readings: { r: reading() } })).toMatch(/^EBMR-DEV-121 DI-31: the process readings are not in the expected form/);
      // Each field of the native original record wrong on its own.
      for (const nat of [
        'x', native({ extra: '1' }), native({ raw: 'abc' }), native({ raw: `1.${'0'.repeat(39)}` }), native({ status: '0x0' }), native({ deviceTime: '01' }),
        native({ endpointCode: '-bad' }),
      ]) {
        expect(await outcome({ sessionId: run, readings: [reading({ value: '1' }, nat)] }), JSON.stringify(nat)).toMatch(/^EBMR-DEV-170 DI-32: reading 0 carries no well-formed original record/);
      }
      // A raw value of 40 characters is well formed: the reading goes on to the device check (an unknown serial).
      expect(await outcome({ sessionId: run, readings: [reading({ value: '1' }, native({ raw: `1.${'0'.repeat(38)}` }))] })).toMatch(/^EBMR-DEV-122/);
      // DI-32: a shown value that rounds the raw one, and a shown value that is no decimal text.
      expect(await outcome({ sessionId: run, readings: [reading({ value: '12.50' }, native({ raw: '12.499' }))] })).toMatch(/^EBMR-DEV-172 DI-32: reading 0 shows 12.50, which is not the raw value 12.499/);
      expect(await outcome({ sessionId: run, readings: [reading({ value: '12.5' })] })).toMatch(/^EBMR-DEV-122/);
    });
  });

  it('[DI-20][DI-31] a reading is matched to a device of this gateway by its serial alone, among the active bindings; an unknown serial is not another device\'s', async () => {
    const actor = await openServiceSession(gmp.db, gmp.seed, 'gateway');
    await inActor(gmp, actor, async (c) => {
      const serial = `S-${tag()}`;
      await replica(c, () => gatewayWithDevice(c, actor.sessionId, serial));
      const body = (deviceSerial: string): Json => ({
        sessionId: randomUUID(),
        readings: [{ deviceSerial, tag: 'force.main_kN', value: '12.5', unit: 'kN', quality: 'GOOD', sourceTime: '1790584618000000', sequence: '1', kind: 'ACTUAL',
                     native: { raw: '12.5', status: '0x00000000', deviceTime: '1790584617000000', endpointCode: 'OPC-KILL-1' } }],
      });
      const o = await attempt(c, 'select tab.ingest_opcua_readings($1) as r', [JSON.stringify(body(`NO-SUCH-${tag()}`))]);
      expect(o.ok ? 'ok' : o.message).toMatch(/^EBMR-DEV-122/);
      // The gateway's own device, linked to no unit behind an endpoint: its endpoint check refuses it.
      const own = await attempt(c, 'select tab.ingest_opcua_readings($1) as r', [JSON.stringify(body(serial))]);
      expect(own.ok ? 'ok' : own.message).toMatch(/^EBMR-DEV-174 DI-20: reading 0 names endpoint OPC-KILL-1, which is not the enrolled endpoint/);
    });
  });

  it('[DI-20] the endpoint of a process device is the enrolment in force of the endpoint serving its unit, never another endpoint', async () => {
    const actor = await openServiceSession(gmp.db, gmp.seed, 'gateway');
    await inActor(gmp, actor, async (c) => {
      const [unitRetired, unitServed] = [randomUUID(), randomUUID()];
      const endpoint = async (unit: string | null) =>
        (await c.query<{ id: string }>(
          `insert into iam.device (code, device_class, site_code, room_code, key_fingerprint, status, description, registered_by_person)
           values ($1, 'INSTRUMENT', 'SITE-1', 'DISP-1', encode(sha256(convert_to($1, 'UTF8')), 'hex'), 'ACTIVE', 'kill test endpoint', gen_random_uuid()) returning id::text`,
          [`OPC-${randomBytes(3).toString('hex').toUpperCase()}${unit ? '' : '-FREE'}`],
        )).rows[0]!.id;
      const { retiredDevice, servedDevice, servedEndpoint } = await replica(c, async () => {
        const a = await gatewayWithDevice(c, actor.sessionId, `S-${tag()}`);
        const b = await gatewayWithDevice(c, randomUUID(), `S-${tag()}`);
        await c.query('insert into tab.process_device_unit (process_device_id, equipment_id, person_id, account_id) values ($1, $2, gen_random_uuid(), gen_random_uuid())', [a.device, unitRetired]);
        await c.query('insert into tab.process_device_unit (process_device_id, equipment_id, person_id, account_id) values ($1, $2, gen_random_uuid(), gen_random_uuid())', [b.device, unitServed]);
        // The unit of device a was served by an endpoint now retired; another endpoint is enrolled, serving nothing of a.
        const e1 = await endpoint(unitRetired);
        await endpointVersion(c, e1, `OPC-R-${tag()}`, 1, 'ENROLLED', [unitRetired]);
        await endpointVersion(c, e1, `OPC-R-${tag()}`, 2, 'RETIRED', []);
        await endpointVersion(c, await endpoint(null), `OPC-F-${tag()}`, 1, 'ENROLLED', []);
        const e3 = await endpoint(unitServed);
        const served = await endpointVersion(c, e3, `OPC-S-${tag()}`, 1, 'ENROLLED', [unitServed]);
        return { retiredDevice: a.device, servedDevice: b.device, servedEndpoint: served };
      });
      const of = async (device: string) => (await c.query<{ id: string | null }>('select (tab.process_device_endpoint($1)).id as id', [device])).rows[0]!.id;
      expect(await of(retiredDevice)).toBeNull();
      expect(await of(servedDevice)).toBe(servedEndpoint);
    });
  });

  it('[DI-49][DI-31] plain readings pass through the OPC UA path untouched; ALARM_CLEARED clears the open bridged alarm of its own unit and tag only', async () => {
    const actor = await openServiceSession(gmp.db, gmp.seed, 'gateway');
    await inActor(gmp, actor, async (c) => {
      const serial = `S-${tag()}`;
      const unit = randomUUID();
      await replica(c, async () => {
        const g = await gatewayWithDevice(c, actor.sessionId, serial);
        await c.query(`insert into plant.equipment (id, code, name, class_code, kind, recorded_by) values ($1, $2, $2, 'KILL-CLASS', 'PROCESS', gen_random_uuid())`, [unit, `EQ-KILL-${tag()}`]);
        await c.query('insert into tab.process_device_unit (process_device_id, equipment_id, person_id, account_id) values ($1, $2, gen_random_uuid(), gen_random_uuid())', [g.device, unit]);
      });
      const us = BigInt((await c.query<{ us: string }>('select floor(extract(epoch from clock_timestamp()) * 1000000)::bigint::text as us')).rows[0]!.us);
      let seq = 0;
      const r = (tagName: string, value: string, unit_: string, kind: string, at: bigint): Json => {
        seq += 1;
        return { deviceSerial: serial, tag: tagName, value, unit: unit_, quality: 'GOOD', sourceTime: at.toString(), sequence: String(seq), kind };
      };
      const ingest = async (readings: Json[]) => {
        const o = await attempt(c, 'select tab.ingest_opcua_readings($1) as r', [JSON.stringify({ sessionId: randomUUID(), readings })]);
        return o.ok ? 'ok' : o.message;
      };
      // Two open alarms of the unit, the second raised later on another tag; then the first tag clears.
      expect(await ingest([r('force.main_kN', '14.10', 'kN', 'ALARM', us - 3_000_000n), r('turret.speed_rpm', '75.0', 'rpm', 'ALARM', us - 2_000_000n)])).toBe('ok');
      const alarms = async () =>
        (await c.query<{ tag: string; cleared: boolean }>(
          `select a.tag, exists (select 1 from plant.alarm_transition t where t.alarm_id = a.id and t.transition = 'CLEARED') as cleared
             from plant.alarm a where a.equipment_id = $1 order by a.tag`, [unit],
        )).rows;
      expect(await alarms()).toEqual([{ tag: 'force.main_kN', cleared: false }, { tag: 'turret.speed_rpm', cleared: false }]);
      expect(await ingest([r('force.main_kN', '12.48', 'kN', 'ALARM_CLEARED', us - 1_000_000n)])).toBe('ok');
      expect(await alarms()).toEqual([{ tag: 'force.main_kN', cleared: true }, { tag: 'turret.speed_rpm', cleared: false }]);
    });
  });
});
