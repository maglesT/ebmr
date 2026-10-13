/**
 * The process-device gateway checks in the database alone (SQL mutation group "process-devices-and-status", tablets 0820,
 * 0870; Phase 4 slice 7c, the "not twins" of the Phase 3 exit run): the binding of a press or coater to a gateway
 * enrolment and its row guard, the gateway's process readings taken whole or refused whole, the setpoint downloads the
 * step asks for and the gateway acknowledges, and a person's acknowledgement of an alarm. The gateway reaches these
 * functions with its own identity; the engine never stands in front of them.
 *
 * The enrolments, devices, bindings, batches and readings each case needs are written by the superuser with
 * session_replication_role = replica in a transaction that is always rolled back; the gateway's session is bound to an
 * enrolment written so; each function runs in its caller's own validated command (the gateway's INTEGRATION identity,
 * the system administrator, operator1).
 *
 * Controls: DI-31 (device data taken as the device sent it, in sequence), DI-20 (a device of the enrolment), DI-49
 * (alarms acknowledged by a person with a comment), PR-14 (setpoints are the MBR's), PR-22, PR-23.
 */
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { openServiceSession } from '@ebmr/test-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type TestServer } from '../support/harness.ts';
import { adminActor } from '../devices/support.ts';
import { attempt, batchWith, code, inActor, inCommand, replica, tag, value, type Json } from './kill-support.ts';

let gmp: TestServer;
beforeAll(async () => {
  gmp = await startServer('GMP');
}, 180_000);
afterAll(async () => {
  await gmp?.close();
});

interface World {
  key: string;
  otherKey: string;
  revokedKey: string;
  devices: Record<string, string>;
  bindings: Record<string, string>;
}

/** Enrolments (one bound to `session` when given), registry devices and process-device bindings. */
async function world(c: PoolClient, session: string | null): Promise<World> {
  const t = tag();
  const site = (await c.query<{ s: string }>('select site_code as s from iam.device limit 1')).rows[0]?.s ?? 'SITE-1';
  const device = async (code: string, cls: string, status = 'ACTIVE'): Promise<string> =>
    (await c.query<{ id: string }>(
      `insert into iam.device (code, device_class, site_code, room_code, key_fingerprint, status, description, registered_by_person)
       values ($1, $2, $3, 'DISP-1', encode(sha256(convert_to($1, 'UTF8')), 'hex'), $4, 'kill test device', gen_random_uuid()) returning id::text`,
      [code, cls, site, status],
    )).rows[0]?.id as string;
  const key = async (status: string): Promise<string> =>
    (await c.query<{ id: string }>(
      `insert into tab.gateway_key (gateway_device_id, gateway_code, account_id, public_key_spki, key_fingerprint, status, enrolled_by_person, revoked_at)
       values (gen_random_uuid(), $1, gen_random_uuid(), encode(sha256(convert_to($1, 'UTF8')), 'base64'), encode(sha256(convert_to($1, 'UTF8')), 'hex'), $2, gen_random_uuid(),
               case when $2 = 'REVOKED' then clock_timestamp() end) returning id::text`,
      [`GW-${t}-${status}-${randomUUID().slice(0, 4)}`, status],
    )).rows[0]?.id as string;
  const w: World = { key: await key('ACTIVE'), otherKey: await key('ACTIVE'), revokedKey: await key('REVOKED'), devices: {}, bindings: {} };
  if (session) {
    await c.query("insert into tab.gateway_session (token_hash, session_id, gateway_key_id) values (encode(sha256(convert_to($1, 'UTF8')), 'hex'), $2, $3)", [randomUUID(), session, w.key]);
  }
  for (const [k, cls, status] of [
    ['A', 'INSTRUMENT', 'ACTIVE'],
    ['B', 'INSTRUMENT', 'BLOCKED'],
    ['S', 'SERVER', 'ACTIVE'],
    ['C', 'INSTRUMENT', 'ACTIVE'],
    ['X', 'INSTRUMENT', 'ACTIVE'],
    ['E', 'INSTRUMENT', 'ACTIVE'],
    ['F', 'INSTRUMENT', 'ACTIVE'],
    ['FREE', 'INSTRUMENT', 'ACTIVE'],
    ['FREE2', 'INSTRUMENT', 'ACTIVE'],
  ] as const) {
    w.devices[k] = await device(`DEV-${t}-${k}`, cls, status);
  }
  const bind = async (k: string, gw: string, serial: string, kind: string, ended = false): Promise<void> => {
    w.bindings[k] = (await c.query<{ id: string }>(
      `insert into tab.process_device (gateway_key_id, instrument_device_id, device_code, serial, equipment_kind, bound_by_person, ended_at)
       values ($1, $2, $3, $4, $5, gen_random_uuid(), case when $6 then clock_timestamp() end) returning id::text`,
      [gw, w.devices[k], `DEV-${t}-${k}`, serial, kind, ended],
    )).rows[0]?.id as string;
  };
  await bind('A', w.key, `SA-${t}`, 'PRESS');
  await bind('B', w.key, `SB-${t}`, 'PRESS');
  await bind('S', w.key, `SS-${t}`, 'PRESS');
  await bind('C', w.key, `SC-${t}`, 'COATER');
  await bind('X', w.otherKey, `SX-${t}`, 'PRESS');
  await bind('E', w.key, `SE-${t}`, 'PRESS', true);
  await bind('F', w.key, `SF-${t}`, 'PRESS');
  return w;
}

describe('process-device bindings (tablets 0820)', () => {
  it('[DI-31][DI-20] the system administrator binds an active INSTRUMENT of the registry to an active enrolment; ends an active binding once with a reason; a binding row starts active and never changes but by its end', async () => {
    await inActor(gmp, await adminActor(gmp), async (c) => {
      const w = await replica(c, () => world(c, null));
      const codeOfDevice = async (k: string) => (await c.query<{ c: string }>('select code as c from iam.device where id = $1', [w.devices[k]])).rows[0]?.c ?? '';
      const bind = async (key: string, device: string, s = `NEW-${tag()}`) => code(c, 'select tab.bind_process_device($1, $2, $3, $4)::text as r', [key, device, s, 'PRESS']);
      expect(await bind(randomUUID(), await codeOfDevice('FREE'))).toBe('EBMR-DEV-013');
      expect(await bind(w.revokedKey, await codeOfDevice('FREE'))).toBe('EBMR-DEV-013');
      expect(await bind(w.key, 'NO-SUCH-DEVICE')).toBe('EBMR-DEV-014');
      expect(await bind(w.key, await codeOfDevice('S'))).toBe('EBMR-DEV-014');
      expect(await bind(w.key, await codeOfDevice('B'))).toBe('EBMR-DEV-014');
      const id = await value<string>(c, 'select tab.bind_process_device($1, $2, $3, $4)::text as r', [w.key, await codeOfDevice('FREE'), 'NEW-1', 'COATER']);
      const row = (await c.query<Json>('select instrument_device_id::text as d, serial, equipment_kind as k, ended_at from tab.process_device where id = $1', [id])).rows[0];
      expect(row).toEqual({ d: w.devices['FREE'], serial: 'NEW-1', k: 'COATER', ended_at: null });
      // The end: a reason, an active binding by its id; once.
      expect(await code(c, "select tab.end_process_device($1, '', 'why') as r", [w.bindings['A']])).toBe('EBMR-DEV-009');
      expect(await code(c, "select tab.end_process_device($1, 'TEST', 'replaced') as r", [randomUUID()])).toBe('EBMR-DEV-120');
      expect(await code(c, "select tab.end_process_device($1, 'TEST', 'replaced') as r", [w.bindings['E']])).toBe('EBMR-DEV-120');
      expect(await code(c, "select tab.end_process_device($1, 'TEST', 'replaced') as r", [w.bindings['A']])).toBe('ok');
      const ended = (await c.query<{ id: string; r: string | null }>('select id::text, ended_reason as r from tab.process_device where ended_at is not null and id = any ($1)', [Object.values(w.bindings)])).rows;
      expect(ended.map((r) => r.id).sort()).toEqual([w.bindings['A'], w.bindings['E']].sort());
      expect(await code(c, "select tab.end_process_device($1, 'TEST', 'replaced') as r", [w.bindings['A']])).toBe('EBMR-DEV-120');
      // The row guard (as the owner would write it): an insert ended, a change of any column, an ended row, an end undone.
      await c.query('set local role ebmr_owner');
      const sql = (text: string, params: unknown[]) => code(c, text, params);
      expect(await sql("insert into tab.process_device (gateway_key_id, instrument_device_id, device_code, serial, equipment_kind, bound_by_person, ended_at) values ($1, $2, 'X', 'G-1', 'PRESS', gen_random_uuid(), clock_timestamp())", [w.key, w.devices['FREE']])).toBe('EBMR-DEV-120');
      expect(await sql("insert into tab.process_device (gateway_key_id, instrument_device_id, device_code, serial, equipment_kind, bound_by_person) values ($1, $2, 'X', 'G-2', 'PRESS', gen_random_uuid())", [w.key, w.devices['FREE2']])).toBe('ok');
      expect(await sql("update tab.process_device set serial = 'CHANGED' where id = $1", [w.bindings['F']])).toBe('EBMR-DEV-120');
      expect(await sql("update tab.process_device set ended_reason = 'x' where id = $1", [w.bindings['F']])).toBe('EBMR-DEV-120');
      expect(await sql('update tab.process_device set ended_at = null where id = $1', [w.bindings['E']])).toBe('EBMR-DEV-120');
      expect(await sql("update tab.process_device set ended_at = clock_timestamp(), ended_reason = 'again' where id = $1", [w.bindings['E']])).toBe('EBMR-DEV-120');
      expect(await sql("update tab.process_device set ended_at = clock_timestamp(), ended_reason = 'ended' where id = $1", [w.bindings['F']])).toBe('ok');
      await c.query('reset role');
    });
  });
});

describe('process readings from the gateway (tablets 0820)', () => {
  it('[DI-31][DI-20] a request is an object with a session id and 1 to 200 readings, nothing else; each reading in its form; a device of this enrolment that is an active instrument; a tag of its kind in its unit, scale and counter rules; a read-back only of a setpoint tag; the next sequence, or the same one again with the same content', async () => {
    const actor = await openServiceSession(gmp.db, gmp.seed, 'gateway');
    await inActor(gmp, actor, async (c) => {
      const w = await replica(c, () => world(c, actor.sessionId));
      const t = (await c.query<{ s: string }>('select serial as s from tab.process_device where id = $1', [w.bindings['A']])).rows[0]?.s ?? '';
      const sx = (k: string) => c.query<{ s: string }>('select serial as s from tab.process_device where id = $1', [w.bindings[k]]).then((r) => r.rows[0]?.s ?? '');
      const run = randomUUID();
      const reading = (seq: number, extra: Json = {}, s = t): Json => ({ deviceSerial: s, tag: 'stroke.count', value: '10', unit: 'count', quality: 'GOOD', sourceTime: '1', sequence: String(seq), kind: 'ACTUAL', ...extra });
      const ingest = (body: unknown) => attempt<{ readings: Json[] }>(c, 'select tab.ingest_process_readings($1) as r', [JSON.stringify(body)]);
      const codeOf = async (body: unknown) => {
        const o = await ingest(body);
        return o.ok ? 'ok' : (/EBMR-DEV-\d{3}/.exec(o.message)?.[0] ?? o.message);
      };
      const body = (readings: unknown, extra: Json = {}): Json => ({ sessionId: run, readings, ...extra });
      // The request.
      expect(await codeOf([reading(1)])).toBe('EBMR-DEV-121');
      expect(await codeOf(body([reading(1)], { sessionId: 'not-a-uuid' }))).toBe('EBMR-DEV-121');
      expect(await codeOf(body({ r: reading(1) }))).toBe('EBMR-DEV-121');
      expect(await codeOf(body([]))).toBe('EBMR-DEV-121');
      expect(await codeOf(body(Array.from({ length: 201 }, (_, i) => reading(i + 1))))).toBe('EBMR-DEV-121');
      expect(await codeOf(body([reading(1)], { extra: true }))).toBe('EBMR-DEV-121');
      // Each reading's form (one clause wrong at a time).
      for (const bad of [
        'x',
        { ...reading(1), extra: '1' },
        reading(1, { deviceSerial: 5 }),
        reading(1, { tag: 5 }),
        reading(1, { value: 10 }),
        reading(1, { value: '1e3' }),
        reading(1, { unit: 5 }),
        reading(1, { quality: undefined }),
        reading(1, { quality: 'FINE' }),
        reading(1, { kind: undefined }),
        reading(1, { kind: 'GUESS' }),
        reading(1, { sourceTime: '01' }),
        reading(1, { sequence: '0' }),
      ]) {
        const o = await ingest(body([bad]));
        expect(o.ok ? 'ok' : o.message, JSON.stringify(bad)).toMatch(/^EBMR-DEV-121 DI-31: reading 0 is not a process reading in the expected form$/);
      }
      // The device: of this enrolment, active binding, an active INSTRUMENT.
      expect(await codeOf(body([reading(1, {}, 'NO-SUCH')]))).toBe('EBMR-DEV-122');
      expect(await codeOf(body([reading(1, {}, await sx('X'))]))).toBe('EBMR-DEV-122');
      expect(await codeOf(body([reading(1, {}, await sx('E'))]))).toBe('EBMR-DEV-122');
      expect(await codeOf(body([reading(1, {}, await sx('B'))]))).toBe('EBMR-DEV-123');
      expect(await codeOf(body([reading(1, {}, await sx('S'))]))).toBe('EBMR-DEV-123');
      // The tag, its unit, scale and counter; a read-back only of a setpoint tag.
      expect(await codeOf(body([reading(1, { tag: 'no.such' })]))).toBe('EBMR-DEV-124');
      expect(await codeOf(body([reading(1, { tag: 'inlet.temp_C', unit: 'degC', value: '50.0' })]))).toBe('EBMR-DEV-124');
      expect(await codeOf(body([reading(1, { unit: 'pieces' })]))).toBe('EBMR-DEV-125');
      expect(await codeOf(body([reading(1, { tag: 'force.main_kN', unit: 'kN', value: '1.234' })]))).toBe('EBMR-DEV-126');
      expect(await codeOf(body([reading(1, { value: '10.0' })]))).toBe('EBMR-DEV-126');
      expect(await codeOf(body([reading(1, { value: '-1' })]))).toBe('EBMR-DEV-126');
      expect(await codeOf(body([reading(1, { kind: 'SETPOINT_READBACK' })]))).toBe('EBMR-DEV-127');
      // Taken: a counter of 0, a force at its scale and below zero, a read-back of a setpoint tag; in sequence.
      const ok = await ingest(body([
        reading(1, { value: '0' }),
        reading(2, { tag: 'force.main_kN', unit: 'kN', value: '1.23' }),
        reading(3, { tag: 'force.main_kN', unit: 'kN', value: '-1.5', kind: 'SETPOINT_READBACK' }),
        reading(4, { kind: 'ALARM' }),
        reading(1, { tag: 'inlet.temp_C', unit: 'degC', value: '50.0' }, await sx('C')),
      ]));
      expect(ok.ok ? ok.r.readings.map((r) => [r['deviceSerial'], r['sequence'], r['outcome']]) : ok.message).toEqual([
        [t, '1', 'INGESTED'], [t, '2', 'INGESTED'], [t, '3', 'INGESTED'], [t, '4', 'INGESTED'], [await sx('C'), '1', 'INGESTED'],
      ]);
      // A device's first reading may start anywhere; then the next one only; the same again with the same content is a
      // duplicate, with other content refused.
      const f = await sx('F');
      expect(await codeOf(body([reading(7, {}, f)]))).toBe('ok');
      expect(await codeOf(body([reading(9, {}, f)]))).toBe('EBMR-DEV-129');
      expect(await codeOf(body([reading(7, {}, f)]))).toBe('ok');
      const dup = await ingest(body([reading(7, {}, f), reading(8, {}, f)]));
      expect(dup.ok ? dup.r.readings.map((r) => r['outcome']) : dup.message).toEqual(['DUPLICATE', 'INGESTED']);
      expect(await codeOf(body([reading(8, { value: '11' }, f)]))).toBe('EBMR-DEV-128');
      expect(await codeOf(body([reading(4, { kind: 'ACTUAL' })]))).toBe('EBMR-DEV-128');
      expect(await codeOf(body([reading(5)]))).toBe('ok');
      const rows = (await c.query<{ n: string }>('select count(*)::text as n from tab.process_reading where gateway_key_id = $1', [w.key])).rows[0]?.n;
      expect(rows).toBe('8');
    });
  });
});

/** A G-06 step's content with its approved setpoints. */
const G06 = {
  procedure: {
    kind: 'procedure',
    id: 'proc',
    children: [
      { kind: 'phase', id: 'p-g06', block: { type: 'G-06', version: '1' }, config: { setpoints: [{ tag: 'force.main_kN', value: '12.50', unit: 'kN' }, { tag: 'turret.speed_rpm', value: '30.0', unit: 'rpm' }, { tag: 'stroke.count', value: '1', unit: 'count' }, { tag: 'fill.depth_mm', value: '1', unit: 'cm' }, { tag: 'force.main_kN', value: '99', unit: 'kN' }] } },
      { kind: 'phase', id: 'p-g04', block: { type: 'G-04', version: '1' } },
      { kind: 'phase', id: 'p-free', block: { type: 'G-06', version: '1' }, config: { setpoints: [{ tag: 'force.main_kN', value: '1', unit: 'kN' }] } },
      { kind: 'phase', id: 'p-ended', block: { type: 'G-06', version: '1' }, config: { setpoints: [{ tag: 'force.main_kN', value: '1', unit: 'kN' }] } },
    ],
  },
};

async function bindStep(c: PoolClient, batch: string, step: string, binding: string, ago = '1 hour'): Promise<void> {
  await c.query(
    `insert into tab.step_device (batch_id, step, process_device_id, person_id, account_id, session_id, correlation_id, bound_at)
     values ($1, $2, $3, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), clock_timestamp() - $4::interval)`,
    [batch, step, binding, ago],
  );
}

describe('setpoint downloads (tablets 0820)', () => {
  it('[PR-14][DI-31] a step asks for a setpoint its MBR approves (the first with that tag), of the device the step is bound to, a setpoint tag of its kind in the approved unit, one waiting download per tag and device', async () => {
    await inCommand(gmp, 'operator1', async (c) => {
      let B = '';
      let w: World = { key: '', otherKey: '', revokedKey: '', devices: {}, bindings: {} };
      await replica(c, async () => {
        w = await world(c, null);
        B = await batchWith(c, gmp.seed.siteCode, G06);
        await bindStep(c, B, 'p-g06', w.bindings['A'] ?? '');
        await bindStep(c, B, 'p-free', w.bindings['C'] ?? '');
        await bindStep(c, B, 'p-ended', w.bindings['E'] ?? '');
      });
      const ask = (step: string, t: string | null) => code(c, 'select tab.request_setpoint_download($1, $2, $3)::text as r', [B, step, t]);
      expect(await ask('p-g04', 'force.main_kN')).toBe('EBMR-DEV-130');
      const notApproved = (t: string | null) => attempt(c, 'select tab.request_setpoint_download($1, $2, $3)::text as r', [B, 'p-g06', t]).then((o) => (o.ok ? 'ok' : o.message));
      expect(await notApproved('tablet.count')).toBe('EBMR-DEV-132 PR-14: tablet.count is not a setpoint the MBR approves for step p-g06');
      expect(await notApproved(null)).toBe('EBMR-DEV-132 PR-14: NULL is not a setpoint the MBR approves for step p-g06');
      expect(await ask('p-g06', 'stroke.count')).toBe('EBMR-DEV-132');
      expect(await ask('p-g06', 'fill.depth_mm')).toBe('EBMR-DEV-132');
      expect(await ask('p-free', 'force.main_kN')).toBe('EBMR-DEV-132');
      expect(await ask('p-ended', 'force.main_kN')).toBe('EBMR-DEV-132');
      const id = await value<string>(c, 'select tab.request_setpoint_download($1, $2, $3)::text as r', [B, 'p-g06', 'force.main_kN']);
      const row = (await c.query<Json>('select step, process_device_id::text as d, tag, value, unit from tab.setpoint_download where id = $1', [id])).rows[0];
      expect(row).toEqual({ step: 'p-g06', d: w.bindings['A'], tag: 'force.main_kN', value: '12.50', unit: 'kN' });
      expect(await ask('p-g06', 'force.main_kN')).toBe('EBMR-DEV-134');
      expect(await ask('p-g06', 'turret.speed_rpm')).toBe('ok');
      // Acknowledged: another download of the tag may wait.
      await replica(c, async () => {
        await c.query("insert into tab.setpoint_download_ack (download_id, outcome, message, gateway_run_id, ingest_session_id, correlation_id) values ($1, 'FAILED', 'x', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())", [id]);
      });
      expect(await ask('p-g06', 'force.main_kN')).toBe('ok');
      // A step bound to no device.
      await replica(c, async () => {
        await c.query('delete from tab.step_device where batch_id = $1', [B]);
      });
      expect(await ask('p-g06', 'force.main_kN')).toBe('EBMR-DEV-133');
    });
  });

  it('[DI-31] the gateway fetches only its own devices\' waiting downloads (recording each first fetch) and acknowledges a download of its own: in form; a read-back the server holds as stated, received after the fetch, confirming no other; APPLIED exactly when it equals the download; the same acknowledgement again is a duplicate, another is refused', async () => {
    const actor = await openServiceSession(gmp.db, gmp.seed, 'gateway');
    await inActor(gmp, actor, async (c) => {
      let B = '';
      let w: World = { key: '', otherKey: '', revokedKey: '', devices: {}, bindings: {} };
      const d: Record<string, string> = {};
      const rb: Record<string, string> = {};
      let later: () => Promise<void> = () => Promise.resolve();
      await replica(c, async () => {
        w = await world(c, actor.sessionId);
        B = await batchWith(c, gmp.seed.siteCode, G06);
        const download = async (k: string, binding: string, t = 'force.main_kN', value = '12.50', unit = 'kN', ago = '10 minutes') => {
          d[k] = (await c.query<{ id: string }>(
            `insert into tab.setpoint_download (batch_id, step, process_device_id, tag, value, unit, person_id, account_id, session_id, correlation_id, requested_at)
             values ($1, 'p-g06', $2, $3, $4, $5, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), clock_timestamp() - $6::interval) returning id::text`,
            [B, binding, t, value, unit, ago],
          )).rows[0]?.id as string;
        };
        await download('a1', w.bindings['A'] ?? '', 'force.main_kN', '12.50', 'kN', '10 minutes');
        await download('a2', w.bindings['A'] ?? '', 'turret.speed_rpm', '30.0', 'rpm', '9 minutes');
        await download('a3', w.bindings['A'] ?? '', 'force.pre_kN', '2.00', 'kN', '8 minutes');
        await download('c1', w.bindings['C'] ?? '', 'inlet.temp_C', '50.0', 'degC', '7 minutes');
        await download('x1', w.bindings['X'] ?? '', 'force.main_kN', '12.50', 'kN', '6 minutes');
        await download('e1', w.bindings['E'] ?? '', 'force.main_kN', '12.50', 'kN', '5 minutes');
        await download('done', w.bindings['A'] ?? '', 'fill.depth_mm', '1.00', 'mm', '4 minutes');
        await c.query("insert into tab.setpoint_download_ack (download_id, outcome, message, gateway_run_id, ingest_session_id, correlation_id) values ($1, 'FAILED', 'x', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())", [d['done']]);
        // Read-backs of device A (the server holds them), one received before the fetch.
        const sa = (await c.query<{ s: string }>('select serial as s from tab.process_device where id = $1', [w.bindings['A']])).rows[0]?.s ?? '';
        let seq = 0;
        const reading = async (k: string, t: string, value: string, unit: string, ago: string, kind = 'SETPOINT_READBACK', binding = w.bindings['A'], s = sa) => {
          seq += 1;
          rb[k] = (await c.query<{ id: string }>(
            `insert into tab.process_reading (process_device_id, gateway_key_id, device_code, serial, tag, kind, value, unit, quality, source_time_us, seq, gateway_run_id,
                                              received_at, received_us, ingest_session_id, correlation_id)
             values ($1, $2, 'D', $3, $4, $5, $6, $7, 'GOOD', 77, $8, gen_random_uuid(), clock_timestamp() - $9::interval, 0, gen_random_uuid(), gen_random_uuid()) returning seq::text as id`,
            [binding, w.key, s, t, kind, value, unit, seq, ago],
          )).rows[0]?.id as string;
        };
        await reading('early', 'force.main_kN', '12.50', 'kN', '1 day');
        later = async () => {
          await reading('equal', 'force.main_kN', '12.5', 'kN', '0 seconds');
          await reading('speedOff', 'turret.speed_rpm', '31.0', 'rpm', '0 seconds');
          await reading('actual', 'force.pre_kN', '2.00', 'kN', '0 seconds', 'ACTUAL');
          await reading('pre', 'force.pre_kN', '2.00', 'kN', '0 seconds');
        };
      });
      // Before the fetch: the early read-back is checked against no fetch yet (received before infinity).
      const ack = (id: string, a: Json) => attempt<Json>(c, 'select tab.ack_setpoint_download($1, $2) as r', [id, JSON.stringify(a)]);
      const codeOf = async (id: string, a: Json) => {
        const o = await ack(id, a);
        return o.ok ? String(o.r['outcome']) : (/EBMR-DEV-\d{3}/.exec(o.message)?.[0] ?? o.message);
      };
      const session = randomUUID();
      const back = (seq: string, value: string, unit: string): Json => ({ sequence: seq, value, unit, sourceTime: '77' });
      expect(await codeOf(d['a1'] ?? '', { sessionId: session, outcome: 'APPLIED', readback: back(rb['early'] ?? '', '12.50', 'kN') })).toBe('EBMR-DEV-146');
      const pending = await value<{ downloads: Json[] }>(c, 'select tab.pending_setpoint_downloads() as r');
      expect(pending.downloads.map((x) => x['id'])).toEqual([d['a1'], d['a2'], d['a3'], d['c1']]);
      expect(pending.downloads[0]).toEqual({ id: d['a1'], deviceSerial: expect.stringMatching(/^SA-/) as unknown, tag: 'force.main_kN', value: '12.50', unit: 'kN' });
      expect((await c.query<{ n: string }>('select count(*)::text as n from tab.setpoint_download_pickup where download_id = any ($1)', [Object.values(d)])).rows[0]?.n).toBe('4');
      // The read-backs the gateway sends after its fetch.
      await replica(c, later);

      expect(await codeOf(randomUUID(), { sessionId: session, outcome: 'FAILED', message: 'x' })).toBe('EBMR-DEV-135');
      expect(await codeOf(d['x1'] ?? '', { sessionId: session, outcome: 'FAILED', message: 'x' })).toBe('EBMR-DEV-135');
      // The form: outcome, session, read-back exactly unless FAILED, a message when FAILED.
      // Without a session id the acknowledgement is refused too (by the row's not-null gateway run, not by the form check).
      expect((await ack(d['a1'] ?? '', { outcome: 'FAILED', message: 'x' })).ok).toBe(false);
      for (const bad of [
        { sessionId: 'run-1', outcome: 'FAILED', message: 'x' },
        { sessionId: session, message: 'x' },
        { sessionId: session, outcome: 'DONE', message: 'x' },
        { sessionId: session, outcome: 'FAILED' },
        { sessionId: session, outcome: 'FAILED', message: '  ' },
        { sessionId: session, outcome: 'FAILED', message: 'x', readback: back(rb['equal'] ?? '', '12.5', 'kN') },
        { sessionId: session, outcome: 'APPLIED' },
      ]) {
        expect(await codeOf(d['a1'] ?? '', bad), JSON.stringify(bad)).toBe('EBMR-DEV-136');
      }
      expect(await codeOf(d['a1'] ?? '', [] as unknown as Json)).toBe('EBMR-DEV-136');
      // The read-back as the server holds it: its sequence, a SETPOINT_READBACK, of the tag, value, unit, source time.
      for (const r of [
        back('999', '12.5', 'kN'),
        back(rb['actual'] ?? '', '2.00', 'kN'),
        back(rb['speedOff'] ?? '', '31.0', 'rpm'),
        back(rb['equal'] ?? '', '12.50', 'kN'),
        back(rb['equal'] ?? '', '12.5', 'N'),
        { ...back(rb['equal'] ?? '', '12.5', 'kN'), sourceTime: '78' },
      ]) {
        expect(await codeOf(d['a1'] ?? '', { sessionId: session, outcome: 'APPLIED', readback: r }), JSON.stringify(r)).toBe('EBMR-DEV-137');
      }
      // Equal: only APPLIED; different: only MISMATCH.
      const msg = async (id: string, a: Json) => {
        const o = await ack(id, a);
        return o.ok ? 'ok' : o.message;
      };
      expect(await msg(d['a1'] ?? '', { sessionId: session, outcome: 'MISMATCH', readback: back(rb['equal'] ?? '', '12.5', 'kN') })).toBe(
        `EBMR-DEV-138 DI-31: download ${d['a1'] ?? ''} of 12.50 kN read back 12.5 kN, which is equal, not mismatch`,
      );
      expect(await msg(d['a2'] ?? '', { sessionId: session, outcome: 'APPLIED', readback: back(rb['speedOff'] ?? '', '31.0', 'rpm') })).toBe(
        `EBMR-DEV-138 DI-31: download ${d['a2'] ?? ''} of 30.0 rpm read back 31.0 rpm, which is a mismatch, not applied`,
      );
      expect(await codeOf(d['a1'] ?? '', { sessionId: session, outcome: 'APPLIED', readback: back(rb['equal'] ?? '', '12.5', 'kN') })).toBe('ACKNOWLEDGED');
      expect(await codeOf(d['a1'] ?? '', { sessionId: session, outcome: 'APPLIED', readback: back(rb['equal'] ?? '', '12.5', 'kN') })).toBe('DUPLICATE');
      expect(await codeOf(d['a1'] ?? '', { sessionId: session, outcome: 'FAILED', message: 'x' })).toBe('EBMR-DEV-139');
      expect(await codeOf(d['a2'] ?? '', { sessionId: session, outcome: 'MISMATCH', readback: back(rb['speedOff'] ?? '', '31.0', 'rpm') })).toBe('ACKNOWLEDGED');
      // The read-back of one download confirms no other.
      expect(await codeOf(d['a3'] ?? '', { sessionId: session, outcome: 'APPLIED', readback: back(rb['pre'] ?? '', '2.00', 'kN') })).toBe('ACKNOWLEDGED');
      expect(await codeOf(d['c1'] ?? '', { sessionId: session, outcome: 'FAILED', message: 'coater offline' })).toBe('ACKNOWLEDGED');
      expect(await codeOf(d['c1'] ?? '', { sessionId: session, outcome: 'FAILED', message: 'coater offline' })).toBe('DUPLICATE');
      expect(await codeOf(d['c1'] ?? '', { sessionId: session, outcome: 'FAILED', message: 'other' })).toBe('EBMR-DEV-139');
      const acks = (await c.query<{ id: string; o: string }>('select download_id::text as id, outcome as o from tab.setpoint_download_ack where download_id = any ($1) order by acked_at', [[d['a1'], d['a2'], d['a3'], d['c1']]])).rows;
      expect(acks.map((a) => [a.id, a.o])).toEqual([[d['a1'], 'APPLIED'], [d['a2'], 'MISMATCH'], [d['a3'], 'APPLIED'], [d['c1'], 'FAILED']]);
      expect((await value<{ downloads: Json[] }>(c, 'select tab.pending_setpoint_downloads() as r')).downloads).toEqual([]);
    });
  });

  it('[DI-31] a read-back confirms one download only (one received at the very instant of the fetch counts as after it)', async () => {
    const actor = await openServiceSession(gmp.db, gmp.seed, 'gateway');
    await inActor(gmp, actor, async (c) => {
      const w = await replica(c, () => world(c, actor.sessionId));
      const B = await replica(c, () => batchWith(c, gmp.seed.siteCode, G06));
      const ids = await replica(c, async () => {
        const one = async () =>
          (await c.query<{ id: string }>(
            `insert into tab.setpoint_download (batch_id, step, process_device_id, tag, value, unit, person_id, account_id, session_id, correlation_id, requested_at)
             values ($1, 'p-g06', $2, 'force.main_kN', '5.00', 'kN', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), clock_timestamp() - interval '1 hour') returning id::text`,
            [B, w.bindings['A']],
          )).rows[0]?.id as string;
        const a = await one();
        const b = await one();
        await c.query("insert into tab.setpoint_download_pickup (download_id, ingest_session_id, picked_up_at) select unnest($1::uuid[]), gen_random_uuid(), '2026-01-01T00:00:00Z'::timestamptz", [[a, b]]);
        await c.query(
          `insert into tab.process_reading (process_device_id, gateway_key_id, device_code, serial, tag, kind, value, unit, quality, source_time_us, seq, gateway_run_id,
                                            received_at, received_us, ingest_session_id, correlation_id)
           select id, gateway_key_id, 'D', serial, 'force.main_kN', 'SETPOINT_READBACK', '5.00', 'kN', 'GOOD', 5, 1, gen_random_uuid(), '2026-01-01T00:00:00Z'::timestamptz, 0, gen_random_uuid(), gen_random_uuid()
             from tab.process_device where id = $1`,
          [w.bindings['A']],
        );
        return [a, b];
      });
      const ack = (id: string) => code(c, 'select tab.ack_setpoint_download($1, $2) as r', [id, JSON.stringify({ sessionId: randomUUID(), outcome: 'APPLIED', readback: { sequence: '1', value: '5.00', unit: 'kN', sourceTime: '5' } })]);
      expect(await ack(ids[0] ?? '')).toBe('ok');
      expect(await ack(ids[1] ?? '')).toBe('EBMR-DEV-147');
    });
  });
});

describe('alarm acknowledgements (tablets 0820)', () => {
  it('[DI-49] a person acknowledges, once and with a comment, an ALARM of the step\'s device received in the step\'s window that an accepted ALARM entry of the step recorded', async () => {
    await inCommand(gmp, 'operator1', async (c) => {
      let B = '';
      let B2 = '';
      const r: Record<string, string> = {};
      await replica(c, async () => {
        const w = await world(c, null);
        B = await batchWith(c, gmp.seed.siteCode, G06);
        B2 = await batchWith(c, gmp.seed.siteCode, G06);
        // Another step of the batch bound to another device first: the alarm's step is the one named.
        await bindStep(c, B, 'p-free', w.bindings['C'] ?? '', '2 hours');
        await bindStep(c, B, 'p-g06', w.bindings['A'] ?? '', '1 hour');
        // Another batch bound the same device 10 minutes ago: later readings are its own.
        await bindStep(c, B2, 'p-g06', w.bindings['A'] ?? '', '10 minutes');
        let seq = 0;
        const reading = async (k: string, kind: string, ago: string, binding = w.bindings['A']) => {
          seq += 1;
          r[k] = (await c.query<{ id: string }>(
            `insert into tab.process_reading (process_device_id, gateway_key_id, device_code, serial, tag, kind, value, unit, quality, source_time_us, seq, gateway_run_id,
                                              received_at, received_us, ingest_session_id, correlation_id)
             values ($1, $2, 'D', 'S', 'force.main_kN', $3, '1', 'kN', 'GOOD', 0, $4, gen_random_uuid(), clock_timestamp() - $5::interval, 0, gen_random_uuid(), gen_random_uuid()) returning id::text`,
            [binding, w.key, kind, seq, ago],
          )).rows[0]?.id as string;
        };
        await reading('alarm', 'ALARM', '30 minutes');
        await reading('alarm2', 'ALARM', '29 minutes');
        await reading('actual', 'ACTUAL', '30 minutes');
        await reading('before', 'ALARM', '2 hours');
        await reading('later', 'ALARM', '5 minutes');
        await reading('other', 'ALARM', '30 minutes', w.bindings['C']);
        await reading('unrecorded', 'ALARM', '28 minutes');
        await reading('refused', 'ALARM', '27 minutes');
        let n = 1;
        const entry = async (reading: string, accepted = true, kind = 'ALARM', step = 'p-g06', type = 'RECORD_ENTRY', batch = B) => {
          n += 1;
          await c.query(
            `insert into recipe.execution_command (batch_id, seq, kind, command_id, command_type, command, command_hash, actor_person, actor_account, actor_role, source,
                                                   session_id, device_class, now_us, accepted, refusal, state_version, state_hash, events_hash, event_count, prev_row_hash, row_hash,
                                                   correlation_id)
             values ($1, $2, 'COMMAND', gen_random_uuid(), $3, jsonb_build_object('step', $4::text, 'entry', jsonb_build_object('kind', $5::text, 'readingId', $6::text)), repeat('0', 64),
                     gen_random_uuid(), gen_random_uuid(), 'OPERATOR', 'UI', gen_random_uuid(), 'TERMINAL', 0, $7, case when $7 then null else '{"code": "X"}' end::jsonb, 1, repeat('0', 64), repeat('0', 64), 0, repeat('0', 64), repeat('0', 64),
                     gen_random_uuid())`,
            [batch, n, type, step, kind, reading, accepted],
          );
        };
        for (const k of ['alarm', 'alarm2', 'actual', 'before', 'later', 'other']) await entry(r[k] ?? '');
        await entry(r['refused'] ?? '', false);
        await entry(r['unrecorded'] ?? '', true, 'NOTE');
        await entry(r['unrecorded'] ?? '', true, 'ALARM', 'p-free');
        await entry(r['unrecorded'] ?? '', true, 'ALARM', 'p-g06', 'SIGN');
        await entry(r['unrecorded'] ?? '', true, 'ALARM', 'p-g06', 'RECORD_ENTRY', B2);
      });
      const ackA = (reading: string | null, comment: string | null = 'Checked the feeder; resumed') => code(c, 'select tab.acknowledge_process_alarm($1, $2, $3, $4) as r', [reading, B, 'p-g06', comment]);
      for (const k of ['actual', 'before', 'later', 'other', 'unrecorded', 'refused']) expect(await ackA(r[k] ?? ''), k).toBe('EBMR-DEV-141');
      expect(await ackA(randomUUID())).toBe('EBMR-DEV-141');
      expect(await code(c, 'select tab.acknowledge_process_alarm($1, $2, $3, $4) as r', [r['alarm'], B, 'p-free', 'x'])).toBe('EBMR-DEV-141');
      expect(await ackA(r['alarm'] ?? '', '  ')).toBe('EBMR-DEV-142');
      expect(await ackA(r['alarm'] ?? '')).toBe('ok');
      expect(await ackA(r['alarm'] ?? '')).toBe('EBMR-DEV-143');
      expect(await ackA(r['alarm2'] ?? '')).toBe('ok');
      expect((await c.query<{ n: string }>('select count(*)::text as n from tab.process_alarm_ack where batch_id = $1', [B])).rows[0]?.n).toBe('2');
    });
    // Not a person: the gateway's identity is refused.
    const gw = await openServiceSession(gmp.db, gmp.seed, 'gateway');
    await inActor(gmp, gw, async (c) => {
      const B = await replica(c, () => batchWith(c, gmp.seed.siteCode, G06));
      expect(await code(c, 'select tab.acknowledge_process_alarm($1, $2, $3, $4) as r', [randomUUID(), B, 'p-g06', 'x'])).toMatch(/^EBMR-(DEV-140|IAM-\d+)$/);
    });
  });
});

