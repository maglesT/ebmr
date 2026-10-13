/**
 * The print and serialisation gateway checks in the database alone (SQL mutation group
 * "packaging-printing-and-serialisation", tablets 0951, 0952; Phase 4 slice 7c, the "not twins" of the Phase 3 exit
 * run): the binding of a line printer or inspection device and its row guard; the jobs the gateway fetches, its
 * acknowledgement of a job (LOADED only on the record's own data) and its print events (taken whole or refused whole, in
 * sequence); the serial pool the step asks the L3 system for and records, the serial events the server sends and the L3
 * report it records (only what the server's own events leave). No engine check stands in front of these.
 *
 * The enrolments, devices, bindings, batches, execution states, jobs and pools each case needs are written by the
 * superuser with session_replication_role = replica in a transaction that is always rolled back; each function runs in
 * its caller's own validated command (the gateway's INTEGRATION identity bound to an enrolment written so, the system
 * administrator, operator1).
 *
 * Controls: PR-36 (no keying at the device: the job carries the record's data), PR-42 (serialisation reconciled),
 * IN-31, DI-31, DI-20, L-29.
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
  serials: Record<string, string>;
  codes: Record<string, string>;
}

async function world(c: PoolClient, session: string | null): Promise<World> {
  const t = tag();
  const site = (await c.query<{ s: string }>('select site_code as s from iam.device limit 1')).rows[0]?.s ?? 'SITE-1';
  const key = async (status: string): Promise<string> =>
    (await c.query<{ id: string }>(
      `insert into tab.gateway_key (gateway_device_id, gateway_code, account_id, public_key_spki, key_fingerprint, status, enrolled_by_person, revoked_at)
       values (gen_random_uuid(), $1, gen_random_uuid(), encode(sha256(convert_to($1, 'UTF8')), 'base64'), encode(sha256(convert_to($1, 'UTF8')), 'hex'), $2, gen_random_uuid(),
               case when $2 = 'REVOKED' then clock_timestamp() end) returning id::text`,
      [`GW-${t}-${status}-${randomUUID().slice(0, 4)}`, status],
    )).rows[0]?.id as string;
  const w: World = { key: await key('ACTIVE'), otherKey: await key('ACTIVE'), revokedKey: await key('REVOKED'), devices: {}, bindings: {}, serials: {}, codes: {} };
  if (session) {
    await c.query("insert into tab.gateway_session (token_hash, session_id, gateway_key_id) values (encode(sha256(convert_to($1, 'UTF8')), 'hex'), $2, $3)", [randomUUID(), session, w.key]);
  }
  for (const [k, cls, status] of [
    ['P', 'INSTRUMENT', 'ACTIVE'],
    ['R', 'INSTRUMENT', 'ACTIVE'],
    ['B', 'INSTRUMENT', 'BLOCKED'],
    ['S', 'SERVER', 'ACTIVE'],
    ['X', 'INSTRUMENT', 'ACTIVE'],
    ['E', 'INSTRUMENT', 'ACTIVE'],
    ['F', 'INSTRUMENT', 'ACTIVE'],
    ['FREE', 'INSTRUMENT', 'ACTIVE'],
    ['FREE2', 'INSTRUMENT', 'ACTIVE'],
  ] as const) {
    w.codes[k] = `PDEV-${t}-${k}`;
    w.devices[k] = (await c.query<{ id: string }>(
      `insert into iam.device (code, device_class, site_code, room_code, key_fingerprint, status, description, registered_by_person)
       values ($1, $2, $3, 'PACK-1', encode(sha256(convert_to($1, 'UTF8')), 'hex'), $4, 'kill test device', gen_random_uuid()) returning id::text`,
      [w.codes[k], cls, site, status],
    )).rows[0]?.id as string;
  }
  const bind = async (k: string, gw: string, kind: string, ended = false): Promise<void> => {
    w.serials[k] = `S${k}-${t}`;
    w.bindings[k] = (await c.query<{ id: string }>(
      `insert into tab.print_device (gateway_key_id, instrument_device_id, device_code, serial, kind, bound_by_person, ended_at)
       values ($1, $2, $3, $4, $5, gen_random_uuid(), case when $6 then clock_timestamp() end) returning id::text`,
      [gw, w.devices[k], w.codes[k], w.serials[k], kind, ended],
    )).rows[0]?.id as string;
  };
  await bind('P', w.key, 'PRINTER');
  await bind('R', w.key, 'READER');
  await bind('X', w.otherKey, 'PRINTER');
  await bind('E', w.key, 'PRINTER', true);
  await bind('F', w.key, 'VISION');
  return w;
}

const FIELDS = { batchNumber: 'B-1', expiry: '2028-05', manufactured: '2026-06-01' };

/** A job for printer binding `k` of world w (replica). */
async function job(c: PoolClient, w: World, batch: string, k: string, ago: string, fields: Json = FIELDS, gw = w.key): Promise<string> {
  const id = `JOB-${randomUUID().slice(0, 8)}`;
  await c.query(
    `insert into tab.print_job (id, batch_id, step_key, step, config_device, print_device_id, device_serial, gateway_key_id, packaging_order, artwork_set, occupancy_id,
                               fields, layout_ref, data_version, released_by_person, released_by_account, released_at, correlation_id)
     values ($1, $2, 'p-g21@1', 'p-g21', 'PR1', $3, $4, $5, 'PO-1', 'ART-1', gen_random_uuid(), $6, 'LAYOUT-1', 1, gen_random_uuid(), gen_random_uuid(),
             clock_timestamp() - $7::interval, gen_random_uuid())`,
    [id, batch, w.bindings[k], w.serials[k], gw, JSON.stringify(fields), ago],
  );
  return id;
}

const G21 = {
  procedure: {
    kind: 'procedure',
    id: 'proc',
    children: [
      {
        kind: 'phase',
        id: 'p-g21',
        block: { type: 'G-21', version: '1' },
        config: { unit: 'LINE-U1', markets: { EU: { gtin: '04012345678901' }, US: { gtin: '00312345678906' }, IN: { gtin: '08901234567890' } }, serialisation: { markets: ['EU', 'US', 'IN'] } },
      },
      { kind: 'phase', id: 'p-g04', block: { type: 'G-04', version: '1' } },
    ],
  },
};

describe('print device bindings (tablets 0951)', () => {
  it('[DI-31][DI-20] the system administrator binds an active INSTRUMENT of the registry to an active enrolment; ends an active binding once with a reason; a binding row starts active and never changes but by its end', async () => {
    await inActor(gmp, await adminActor(gmp), async (c) => {
      const w = await replica(c, () => world(c, null));
      const bind = (key: string, device: string) => code(c, 'select tab.bind_print_device($1, $2, $3, $4)::text as r', [key, device, `NEW-${tag()}`, 'PRINTER']);
      expect(await bind(randomUUID(), w.codes['FREE'] ?? '')).toBe('EBMR-DEV-013');
      expect(await bind(w.revokedKey, w.codes['FREE'] ?? '')).toBe('EBMR-DEV-013');
      expect(await bind(w.key, 'NO-SUCH-DEVICE')).toBe('EBMR-DEV-014');
      expect(await bind(w.key, w.codes['S'] ?? '')).toBe('EBMR-DEV-014');
      expect(await bind(w.key, w.codes['B'] ?? '')).toBe('EBMR-DEV-014');
      const id = await value<string>(c, 'select tab.bind_print_device($1, $2, $3, $4)::text as r', [w.key, w.codes['FREE'], 'NEW-1', 'CHECKWEIGHER']);
      expect((await c.query<Json>('select instrument_device_id::text as d, serial, kind, ended_at from tab.print_device where id = $1', [id])).rows[0]).toEqual({ d: w.devices['FREE'], serial: 'NEW-1', kind: 'CHECKWEIGHER', ended_at: null });
      expect(await code(c, "select tab.end_print_device($1, '', 'why') as r", [w.bindings['P']])).toBe('EBMR-DEV-009');
      expect(await code(c, "select tab.end_print_device($1, 'TEST', 'replaced') as r", [randomUUID()])).toBe('EBMR-DEV-140');
      expect(await code(c, "select tab.end_print_device($1, 'TEST', 'replaced') as r", [w.bindings['E']])).toBe('EBMR-DEV-140');
      expect(await code(c, "select tab.end_print_device($1, 'TEST', 'replaced') as r", [w.bindings['P']])).toBe('ok');
      const ended = (await c.query<{ id: string }>('select id::text from tab.print_device where ended_at is not null and id = any ($1)', [Object.values(w.bindings)])).rows.map((r) => r.id);
      expect(ended.sort()).toEqual([w.bindings['P'], w.bindings['E']].sort());
      expect(await code(c, "select tab.end_print_device($1, 'TEST', 'replaced') as r", [w.bindings['P']])).toBe('EBMR-DEV-140');
      await c.query('set local role ebmr_owner');
      expect(await code(c, "insert into tab.print_device (gateway_key_id, instrument_device_id, device_code, serial, kind, bound_by_person, ended_at) values ($1, $2, 'X', 'G-1', 'PRINTER', gen_random_uuid(), clock_timestamp())", [w.key, w.devices['FREE2']])).toBe('EBMR-DEV-140');
      expect(await code(c, "insert into tab.print_device (gateway_key_id, instrument_device_id, device_code, serial, kind, bound_by_person) values ($1, $2, 'X', 'G-2', 'PRINTER', gen_random_uuid())", [w.key, w.devices['FREE2']])).toBe('ok');
      expect(await code(c, "update tab.print_device set serial = 'CHANGED' where id = $1", [w.bindings['F']])).toBe('EBMR-DEV-140');
      expect(await code(c, "update tab.print_device set ended_reason = 'x' where id = $1", [w.bindings['F']])).toBe('EBMR-DEV-140');
      expect(await code(c, 'update tab.print_device set ended_at = null where id = $1', [w.bindings['E']])).toBe('EBMR-DEV-140');
      expect(await code(c, "update tab.print_device set ended_at = clock_timestamp(), ended_reason = 'again' where id = $1", [w.bindings['E']])).toBe('EBMR-DEV-140');
      expect(await code(c, "update tab.print_device set ended_at = clock_timestamp(), ended_reason = 'ended' where id = $1", [w.bindings['F']])).toBe('ok');
      await c.query('reset role');
    });
  });
});

describe('print jobs and events at the gateway (tablets 0951)', () => {
  it('[PR-36][IN-31][DI-31] the gateway fetches the released jobs of its own active printers; acknowledges a job of its own once, in form: LOADED only when the echo is the job\'s data (else REFUSED), MISMATCH and FAILED as reported; the same acknowledgement again is a duplicate', async () => {
    const actor = await openServiceSession(gmp.db, gmp.seed, 'gateway');
    await inActor(gmp, actor, async (c) => {
      const j: Record<string, string> = {};
      let w: World | undefined;
      let B = '';
      let held = '';
      await replica(c, async () => {
        w = await world(c, actor.sessionId);
        B = await batchWith(c, gmp.seed.siteCode, G21);
        // The step's line unit with an open output container of the batch: a voided job loaded by the printer holds it.
        await c.query("insert into plant.equipment (code, name, class_code, kind, recorded_by) values ('LINE-U1', 'Line', 'X', 'PROCESS', gen_random_uuid()) on conflict do nothing");
        held = (await c.query<{ id: string }>(
          `insert into plant.output_container (label_code, batch_id, batch_number, product_code, strength, stage, press_code, quantity_unit, opened_at, opened_by_person, opened_by_account)
           values ('OC-P' || substr(md5(random()::text), 1, 8) || '-0001', $1, 'B', 'P1', '1 mg', 'PACKING', 'LINE-U1', 'units', clock_timestamp() - interval '1 hour', gen_random_uuid(), gen_random_uuid())
           returning id::text`,
          [B],
        )).rows[0]?.id ?? '';
        j['a'] = await job(c, w, B, 'P', '10 minutes');
        j['b'] = await job(c, w, B, 'P', '9 minutes');
        j['c'] = await job(c, w, B, 'P', '8 minutes');
        j['d'] = await job(c, w, B, 'P', '7 minutes');
        j['e'] = await job(c, w, B, 'P', '6 minutes');
        j['other'] = await job(c, w, B, 'X', '5 minutes', FIELDS, w.otherKey);
        j['ended'] = await job(c, w, B, 'E', '5 minutes');
        j['acked'] = await job(c, w, B, 'P', '4 minutes');
        j['voided'] = await job(c, w, B, 'P', '3 minutes');
        await c.query("insert into tab.print_job_ack (job_id, outcome, echoed_fields, source_time_us, result, session_id) values ($1, 'FAILED', null, 1, 'FAILED', gen_random_uuid())", [j['acked']]);
        await c.query('insert into tab.print_job_void (job_id, data_version, held, voided_by) values ($1, 1, false, gen_random_uuid())', [j['voided']]);
      });
      const pending = await value<{ jobs: Json[] }>(c, 'select tab.pending_print_jobs() as r');
      expect(pending.jobs.map((x) => x['id'])).toEqual([j['a'], j['b'], j['c'], j['d'], j['e']]);
      expect(pending.jobs[0]).toEqual({ id: j['a'], deviceSerial: w?.serials['P'], packagingOrder: 'PO-1', artworkSet: 'ART-1', fields: FIELDS, layoutRef: 'LAYOUT-1' });

      const ack = (id: string, a: unknown) => attempt<Json>(c, 'select tab.ack_print_job($1, $2) as r', [id, JSON.stringify(a)]);
      const codeOf = async (id: string, a: unknown) => {
        const o = await ack(id, a);
        return o.ok ? `${String(o.r['state'])}${o.r['duplicate'] ? ' DUPLICATE' : ''}` : (/EBMR-DEV-\d{3}/.exec(o.message)?.[0] ?? o.message);
      };
      const s = randomUUID();
      const loaded = { sessionId: s, outcome: 'LOADED', echoedFields: FIELDS, sourceTime: '5' };
      expect(await codeOf('NO-SUCH-JOB', loaded)).toBe('EBMR-DEV-141');
      expect(await codeOf(j['other'] ?? '', loaded)).toBe('EBMR-DEV-141');
      for (const bad of [
        [loaded],
        { ...loaded, outcome: undefined },
        { ...loaded, outcome: 'PRINTED' },
        { ...loaded, sourceTime: '07' },
        { ...loaded, sessionId: 'run-1' },
        { ...loaded, echoedFields: undefined },
        { ...loaded, outcome: 'MISMATCH', echoedFields: undefined, message: 'x' },
        { ...loaded, message: 'x' },
        { ...loaded, outcome: 'MISMATCH' },
        { ...loaded, extra: 1 },
      ]) {
        expect(await codeOf(j['a'] ?? '', bad), JSON.stringify(bad)).toBe('EBMR-DEV-142');
      }
      expect(await codeOf(j['a'] ?? '', loaded)).toBe('LOADED');
      expect(await codeOf(j['a'] ?? '', loaded)).toBe('LOADED DUPLICATE');
      expect(await codeOf(j['a'] ?? '', { ...loaded, sourceTime: '6' })).toBe('EBMR-DEV-143');
      expect(await codeOf(j['b'] ?? '', { ...loaded, echoedFields: { ...FIELDS, expiry: '2028-06' } })).toBe('REFUSED');
      expect(await codeOf(j['c'] ?? '', { sessionId: s, outcome: 'MISMATCH', echoedFields: FIELDS, sourceTime: '5', message: 'echo differs' })).toBe('MISMATCH');
      expect(await codeOf(j['d'] ?? '', { sessionId: s, outcome: 'FAILED', sourceTime: '5', message: 'printer offline' })).toBe('FAILED');
      expect(await codeOf(j['d'] ?? '', { sessionId: s, outcome: 'FAILED', sourceTime: '5', message: 'other' })).toBe('EBMR-DEV-143');
      const rows = (await c.query<{ id: string; o: string; r: string }>('select job_id as id, outcome as o, result as r from tab.print_job_ack where job_id = any ($1) order by received_at', [[j['a'], j['b'], j['c'], j['d']]])).rows;
      expect(rows.map((r) => [r.id, r.o, r.r])).toEqual([[j['a'], 'LOADED', 'LOADED'], [j['b'], 'LOADED', 'REFUSED'], [j['c'], 'MISMATCH', 'MISMATCH'], [j['d'], 'FAILED', 'FAILED']]);
      expect((await value<{ jobs: Json[] }>(c, 'select tab.pending_print_jobs() as r')).jobs.map((x) => x['id'])).toEqual([j['e']]);
      // Only the voided job loaded by the printer records a FAIL check on the step's line unit (L-29): its hold row.
      expect((await c.query('select 1 from plant.ipc_check where batch_id = $1', [B])).rowCount).toBe(0);
      expect(await codeOf(j['voided'] ?? '', loaded)).toBe('VOIDED');
      const checks = (await c.query<{ p: string; r: string; ref: string }>('select press_code as p, result as r, reference as ref from plant.ipc_check where batch_id = $1', [B])).rows;
      expect(checks).toEqual([{ p: 'LINE-U1', r: 'FAIL', ref: `L-29: voided print job ${j['voided'] ?? ''} loaded by the printer` }]);
      expect((await c.query('select 1 from plant.container_hold where container_id = $1', [held])).rowCount).toBe(1);
      // The audit trail names a refused load as such.
      const audit = (await c.query<{ m: string }>("select payload -> 'body' ->> 'message' as m from kernel.audit_event where chain_key = $1 and action = 'BUSINESS' order by seq", [`batch:${B}`])).rows.map((r) => r.m);
      expect(audit).toContain(`Print job ${j['b'] ?? ''} on ${w?.serials['P'] ?? ''}: REFUSED (the printer's echo differs from the record's data: the load is refused)`);
      expect(audit).toContain(`Print job ${j['a'] ?? ''} on ${w?.serials['P'] ?? ''}: LOADED`);
    });
  });

  it('[DI-31][DI-20] print events: a request with a session id and 1 to 200 events, nothing else; each event in its form for its kind; a device of this enrolment; a job of that device (none only for a fault); the next sequence, or the same one again with the same content', async () => {
    const actor = await openServiceSession(gmp.db, gmp.seed, 'gateway');
    await inActor(gmp, actor, async (c) => {
      let w: World = { key: '', otherKey: '', revokedKey: '', devices: {}, bindings: {}, serials: {}, codes: {} };
      const j: Record<string, string> = {};
      await replica(c, async () => {
        w = await world(c, actor.sessionId);
        const B = await batchWith(c, gmp.seed.siteCode, G21);
        j['p'] = await job(c, w, B, 'P', '10 minutes');
        j['x'] = await job(c, w, B, 'X', '10 minutes', FIELDS, w.otherKey);
        j['r'] = await job(c, w, B, 'R', '10 minutes');
      });
      const run = randomUUID();
      const ev = (seq: number, extra: Json = {}): Json => ({ deviceSerial: w.serials['P'], jobId: j['p'], kind: 'PRINTED_COUNT', value: '10', sourceTime: '1', sequence: String(seq), ...extra });
      const ingest = (body: unknown) => attempt<{ events: Json[] }>(c, 'select tab.ingest_print_events($1) as r', [JSON.stringify(body)]);
      const codeOf = async (body: unknown) => {
        const o = await ingest(body);
        return o.ok ? 'ok' : (/EBMR-DEV-\d{3}/.exec(o.message)?.[0] ?? o.message);
      };
      const body = (events: unknown, extra: Json = {}): Json => ({ sessionId: run, events, ...extra });
      expect(await codeOf([ev(1)])).toBe('EBMR-DEV-144');
      expect(await codeOf(body([ev(1)], { sessionId: 'x' }))).toBe('EBMR-DEV-144');
      expect(await codeOf(body({ e: ev(1) }))).toBe('EBMR-DEV-144');
      expect(await codeOf(body([]))).toBe('EBMR-DEV-144');
      expect(await codeOf(body(Array.from({ length: 201 }, (_, i) => ev(i + 1))))).toBe('EBMR-DEV-144');
      expect(await codeOf(body([ev(1)], { extra: 1 }))).toBe('EBMR-DEV-144');
      for (const bad of [
        'x',
        { ...ev(1), extra: 1 },
        ev(1, { deviceSerial: 5 }),
        ev(1, { value: 10 }),
        ev(1, { kind: undefined }),
        ev(1, { kind: 'PRINTED' }),
        ev(1, { jobId: 5 }),
        ev(1, { jobId: null }),
        ev(1, { value: '01' }),
        ev(1, { kind: 'FAULT', value: 'jam' }),
        ev(1, { kind: 'READER_RESULT', value: 'OK' }),
        ev(1, { kind: 'VISION_RESULT', value: '1' }),
        ev(1, { kind: 'CHALLENGE_RESULT', value: 'PASSED' }),
        ev(1, { sourceTime: '01' }),
        ev(1, { sequence: '0' }),
      ]) {
        const o = await ingest(body([bad]));
        expect(o.ok ? 'ok' : o.message, JSON.stringify(bad)).toBe('EBMR-DEV-144 DI-31: event 0 is not a print event in the expected form');
      }
      expect(await codeOf(body([ev(1, { deviceSerial: 'NO-SUCH' })]))).toBe('EBMR-DEV-145');
      expect(await codeOf(body([ev(1, { deviceSerial: w.serials['X'], jobId: j['x'] })]))).toBe('EBMR-DEV-145');
      expect(await codeOf(body([ev(1, { deviceSerial: w.serials['E'] })]))).toBe('EBMR-DEV-145');
      expect(await codeOf(body([ev(1, { jobId: 'NO-SUCH-JOB' })]))).toBe('EBMR-DEV-146');
      expect(await codeOf(body([ev(1, { jobId: j['x'] })]))).toBe('EBMR-DEV-146');
      expect(await codeOf(body([ev(1, { jobId: j['r'] })]))).toBe('EBMR-DEV-146');
      const ok = await ingest(body([
        ev(1, { value: '0' }),
        ev(2, { kind: 'FAULT', jobId: null, value: 'RIBBON_OUT' }),
        ev(3, { kind: 'READER_RESULT', value: 'PASS' }),
        ev(4, { kind: 'VISION_RESULT', value: 'FAIL' }),
        ev(5, { kind: 'CHALLENGE_RESULT', value: 'PASS' }),
        ev(6, { kind: 'FAULT', value: 'HEAD_TEMP' }),
        ev(1, { deviceSerial: w.serials['R'], jobId: j['r'], kind: 'READER_RESULT', value: 'PASS' }),
      ]));
      expect(ok.ok ? ok.r.events.map((e) => [e['sequence'], e['outcome']]) : ok.message).toEqual([['1', 'INGESTED'], ['2', 'INGESTED'], ['3', 'INGESTED'], ['4', 'INGESTED'], ['5', 'INGESTED'], ['6', 'INGESTED'], ['1', 'INGESTED']]);
      expect(await codeOf(body([ev(8)]))).toBe('EBMR-DEV-148');
      const dup = await ingest(body([ev(6, { kind: 'FAULT', value: 'HEAD_TEMP' }), ev(7)]));
      expect(dup.ok ? dup.r.events.map((e) => e['outcome']) : dup.message).toEqual(['DUPLICATE', 'INGESTED']);
      expect(await codeOf(body([ev(7, { value: '11' })]))).toBe('EBMR-DEV-147');
      expect(await codeOf(body([ev(2, { kind: 'FAULT', jobId: j['p'], value: 'RIBBON_OUT' })]))).toBe('EBMR-DEV-147');
      expect(await codeOf(body([ev(8)]))).toBe('ok');
      expect((await c.query<{ n: string }>('select count(*)::text as n from tab.print_event where gateway_key_id = $1', [w.key])).rows[0]?.n).toBe('9');
    });
  });
});

/** A batch with its G-21 step instance p-g21@1 IN_PROGRESS (or `status`), markets EU, US, IN. */
async function g21Batch(c: PoolClient, status = 'IN_PROGRESS', markets = ['EU', 'US', 'IN']): Promise<string> {
  const B = await batchWith(c, gmp.seed.siteCode, G21);
  await c.query(
    "insert into recipe.execution_state (batch_id, state, state_version, state_hash, last_seq, last_row_hash, status) values ($1, $2, 1, repeat('0', 64), 1, repeat('0', 64), 'IN_PROGRESS')",
    [B, JSON.stringify({ header: { marketSet: markets }, steps: { 'p-g21@1': { step: 'p-g21', status }, 'p-g04@1': { step: 'p-g04', status: 'IN_PROGRESS' } } })],
  );
  return B;
}

describe('serial pools, events and reports (tablets 0952)', () => {
  it('[PR-42] a pool is asked and recorded for a serialised market of an open G-21 step: 1 to 100000 serials, the L3 answer a pool of exactly that quantity, once per step and market; the request and the row carry the record\'s order, L3 profile and GTIN', async () => {
    await inCommand(gmp, 'operator1', async (c) => {
      let B = '';
      let done = '';
      let euOnly = '';
      await replica(c, async () => {
        B = await g21Batch(c);
        done = await g21Batch(c, 'COMPLETED');
        euOnly = await g21Batch(c, 'IN_PROGRESS', ['EU']);
      });
      const ask = (b: string, key: string, market: string | null, q: string | null) => attempt<Json>(c, 'select tab.serial_pool_request($1, $2, $3, $4) as r', [b, key, market, q]);
      const codeOf = (o: Awaited<ReturnType<typeof ask>>) => (o.ok ? 'ok' : o.message.replace(/^.*\[(EBMR-[A-Z]+-\d{3})\]$/s, '$1'));
      expect(codeOf(await ask(done, 'p-g21@1', 'EU', '10'))).toBe('EBMR-EXE-296');
      expect(codeOf(await ask(B, 'p-g04@1', 'EU', '10'))).toBe('EBMR-EXE-296');
      expect(codeOf(await ask(euOnly, 'p-g21@1', 'US', '10'))).toBe('EBMR-EXE-297');
      expect(codeOf(await ask(B, 'p-g21@1', 'IN', '10'))).toBe('EBMR-EXE-297');
      for (const q of [null, '0', '1000000', '100001', '1.5']) expect(codeOf(await ask(B, 'p-g21@1', 'EU', q)), String(q)).toBe('EBMR-EXE-297');
      const req = await ask(B, 'p-g21@1', 'EU', '100000');
      expect(req.ok && req.r).toEqual({ packagingOrder: `B-${B.slice(0, 8).toUpperCase()}`, market: 'EU_FMD', gtin: '04012345678901', quantity: '100000' });
      expect((await ask(B, 'p-g21@1', 'US', '1')).ok).toBe(true);

      const rec = (b: string, market: string, q: string | null, answer: unknown) => attempt<Json>(c, 'select tab.record_serial_pool($1, $2, $3, $4, $5) as r', [b, 'p-g21@1', market, q, JSON.stringify(answer)]);
      const answer = { poolId: `POOL-${tag()}`, issued: '500', issuedAt: '1700000000000000' };
      expect(codeOf(await rec(done, 'EU', '500', answer))).toBe('EBMR-EXE-296');
      expect(codeOf(await rec(B, 'IN', '500', answer))).toBe('EBMR-EXE-297');
      for (const q of ['0', '100001']) expect(codeOf(await rec(B, 'EU', q, { ...answer, issued: q }))).toBe('EBMR-EXE-297');
      for (const bad of [[answer], { ...answer, poolId: '' }, { ...answer, poolId: 'a b' }, { ...answer, issued: '499' }, { ...answer, issuedAt: '01' }]) {
        expect(codeOf(await rec(B, 'EU', '500', bad)), JSON.stringify(bad)).toBe('EBMR-EXE-297');
      }
      const ok = await rec(B, 'EU', '500', answer);
      expect(ok.ok && ok.r).toEqual({ poolId: answer.poolId, market: 'EU', l3Market: 'EU_FMD', gtin: '04012345678901', quantity: '500' });
      expect(codeOf(await rec(B, 'EU', '500', { ...answer, poolId: `POOL-${tag()}` }))).toBe('EBMR-EXE-297');
      const us = await rec(B, 'US', '1', { poolId: `POOL-${tag()}`, issued: '1', issuedAt: '0' });
      expect(us.ok && us.r).toMatchObject({ l3Market: 'US_DSCSA', gtin: '00312345678906' });
      const row = (await c.query<Json>("select step, market, l3_market, gtin, quantity::text as q, issued_at_us::text as at from tab.serial_pool where batch_id = $1 and market = 'EU'", [B])).rows[0];
      expect(row).toEqual({ step: 'p-g21', market: 'EU', l3_market: 'EU_FMD', gtin: '04012345678901', q: '500', at: '1700000000000000' });
    });
  });

  it('[PR-42] serial events are counted per allowed state change as whole numbers and never move more serials out of a state than are in it; a report is in form, of this pool, counts the quantity issued and exactly the states and unexplained serials the server\'s own events leave', async () => {
    await inCommand(gmp, 'operator1', async (c) => {
      const pool = `POOL-${tag()}`;
      const other = `POOL-${tag()}`;
      await replica(c, async () => {
        const B = await g21Batch(c);
        for (const [p, m] of [[pool, 'EU'], [other, 'US']] as const) {
          await c.query(
            `insert into tab.serial_pool (pool_id, batch_id, step_key, step, market, l3_market, gtin, quantity, issued_at_us, requested_by_person, requested_by_account, correlation_id)
             values ($1, $2, 'p-g21@1', 'p-g21', $3, 'EU_FMD', '04012345678901', 100, 0, gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
            [p, B, m],
          );
        }
      });
      const events = (p: string, counts: unknown) => attempt(c, 'select tab.record_serial_events($1, $2)::text as r', [p, JSON.stringify(counts)]);
      const codeOf = (o: { ok: boolean; message?: string }) => (o.ok ? 'ok' : (o.message ?? '').replace(/^.*\[(EBMR-[A-Z]+-\d{3})\]$/s, '$1'));
      expect(codeOf(await events('NO-SUCH-POOL', { 'NONE>COMMISSIONED': '1' }))).toBe('EBMR-EXE-297');
      for (const bad of [[], {}, { 'NONE>SHIPPED': '1' }, { 'NONE>COMMISSIONED': 1 }, { 'NONE>COMMISSIONED': '0' }, { 'NONE>COMMISSIONED': '1', 'DESTROYED>NONE': '1' }]) {
        expect(codeOf(await events(pool, bad)), JSON.stringify(bad)).toBe('EBMR-EXE-297');
      }
      expect(codeOf(await events(pool, { 'COMMISSIONED>SAMPLE': '1' }))).toBe('EBMR-EXE-297');
      expect(codeOf(await events(pool, { 'NONE>COMMISSIONED': '101' }))).toBe('EBMR-EXE-297');
      expect(codeOf(await events(pool, { 'NONE>COMMISSIONED': '100' }))).toBe('ok');
      expect(codeOf(await events(pool, { 'COMMISSIONED>DESTROYED': '1', 'COMMISSIONED>SAMPLE': '2' }))).toBe('ok');
      expect(codeOf(await events(other, { 'NONE>COMMISSIONED': '40' }))).toBe('ok');
      // pool: NONE 0, COMMISSIONED 97, DESTROYED 1, SAMPLE 2.
      const counts = { issued: '100', COMMISSIONED: '97', DECOMMISSIONED: '0', DESTROYED: '1', SAMPLE: '2', UNUSED_RETURNED: '0' };
      const report = (p: string, extra: Json = {}, cnt: Json = counts): Json => ({ poolId: p, counts: cnt, unexplained: '0', reportHash: 'a'.repeat(64), ...extra });
      const rec = (p: string, r: unknown) => attempt<Json>(c, 'select tab.record_serial_report($1, $2) as r', [p, JSON.stringify(r)]);
      for (const bad of [
        [report(pool)],
        report(pool, { poolId: other }),
        report(pool, { counts: [] }),
        report(pool, {}, { ...counts, EXTRA: '0' }),
        report(pool, {}, { ...counts, SAMPLE: 2 }),
        report(pool, {}, { ...counts, SAMPLE: '02' }),
        report(pool, {}, { ...counts, SAMPLE: undefined, OTHER: '2' }),
        report(pool, { unexplained: '-1' }),
        report(pool, { reportHash: 'A'.repeat(64) }),
        report(pool, { reportHash: undefined }),
      ]) {
        expect(codeOf(await rec(pool, bad)), JSON.stringify(bad)).toBe('EBMR-EXE-297');
      }
      const msg = async (r: unknown) => {
        const o = await rec(pool, r);
        return o.ok ? 'ok' : o.message;
      };
      expect(await msg(report(pool, {}, { ...counts, issued: '99' }))).toMatch(/counts 99 serials issued for pool/);
      expect(await msg(report(pool, {}, { ...counts, COMMISSIONED: '96', SAMPLE: '3' }))).toMatch(/is not what the server's serial events leave/);
      expect(await msg(report(pool, {}, { ...counts, DESTROYED: '0', DECOMMISSIONED: '1' }))).toMatch(/is not what the server's serial events leave/);
      expect(await msg(report(pool, { unexplained: '1' }))).toMatch(/is not what the server's serial events leave/);
      const ok = await rec(pool, report(pool));
      expect(ok.ok && ok.r).toMatchObject({ kind: 'SERIAL_RECONCILIATION', poolId: pool });
      // The other pool: 60 serials without a state are unexplained.
      const otherCounts = { issued: '100', COMMISSIONED: '40', DECOMMISSIONED: '0', DESTROYED: '0', SAMPLE: '0', UNUSED_RETURNED: '0' };
      expect((await rec(other, report(other, { unexplained: '59' }, otherCounts))).ok).toBe(false);
      expect((await rec(other, report(other, { unexplained: '60' }, otherCounts))).ok).toBe(true);
      expect((await c.query<{ n: string }>('select count(*)::text as n from tab.serial_report where pool_id = any ($1)', [[pool, other]])).rows[0]?.n).toBe('2');
    });
  });
});
