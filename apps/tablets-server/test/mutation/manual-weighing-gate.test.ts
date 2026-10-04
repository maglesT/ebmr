/**
 * The gate of hand-keyed weighings and the evidence it counts, rule by rule (SQL mutation group "manual-weighing-gate":
 * tablets 0320, 0340 and 0350). These tests close the gaps the SQL mutation run (tools/sql-mutation) found in the
 * group's server tests (test/devices/manual-weighing-gate.test.ts, scale-readiness.test.ts, room-scales.test.ts), which
 * drive the gate end to end through the honest gateway and a few forgeries:
 *   - tab.record_heartbeat: the rooms it locks (only those of the instruments it names that are bound to its key now),
 *     the DI-31 reconciliation alarm (only when the gateway counts more than the server holds, at most once a minute
 *     per gateway), an unknown state and a not-ready reason that is no text, the serial-mismatch alarm (once per
 *     episode), since when a scale has been recorded not ONLINE (a new episode under another key) and the probeApi
 *     answer;
 *   - tab.record_heartbeat_receipt and tab.record_gateway_api_answer (the listener's role): what an unknown token, a key
 *     that is not ACTIVE or an unknown gateway gets, how a heartbeat's instruments are kept, the pruning of the key's
 *     own old rows only, and the probeApi answer;
 *   - tab.record_gateway_api_contact (the server's gateway API monitor): a report that names no state, an unknown
 *     gateway, since when the API has been unreachable, and the rooms locked when it is reached again
 *     (tab.lock_gateway_rooms);
 *   - tab.lock_scale_rooms: a room's row is added when missing, a blank room never;
 *   - tab.scale_status and tab.manual_weighing_scales: each scale once, of its own ACTIVE key, of the room asked, with
 *     a binding that has not ended;
 *   - tab.manual_path_verdict, tab.scale_offline_reason_at and tab.chain_refusal_held: each reason at its boundary
 *     (the window's start, the report's change, the refusal's time), and the reason that names what was refused;
 *   - tab.manual_weighing_check: outside READ COMMITTED, while other roles may signal backends, while the room's row is
 *     held, for a room with no row yet, beside a scale whose heartbeats arrive but are not recorded, and the scale it
 *     names when the monitor's report is committed while it reads the room's scales (shown ONLINE first).
 * Heartbeats, receipts, answers and reports go through the functions the server and the listener call, with their own
 * roles (the gateway session's actor on the application role, the listener's login, the monitor's session); weighings
 * are written past the server with the application role, as the review reproducers do. Where only a state no product
 * path produces on demand reaches a rule (a report, a receipt or a refusal at the very microsecond of a boundary, an
 * earlier heartbeat of another key), the rows are written by the superuser in a transaction rolled back, and the
 * comment says so; where a commit must land between two reads of the gate, the superuser holds a table the gate reads
 * in between until it has; the private functions are called as the superuser, as the module tests do.
 *
 * Controls: DI-17, DI-20, DI-30, DI-31, DI-32, PR-20.
 */
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { identity, toDbContext, withCommand, type ActorContext } from '@ebmr/kernel';
import { execution, type engine } from '@ebmr/recipe-core';
import { endPool, openPool, SANDBOX_LISTENER_LOGIN, urlFor } from '@ebmr/test-kit';
import { withActorCommand } from '../../src/platform/db/commands.ts';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { adminActor, gatewayService } from '../devices/support.ts';
import {
  forgedWeighing,
  forgedWeighingRow,
  monitorActor,
  newRun,
  reachPcm,
  RECORD_CONTACT_SQL,
  roomFreeDispensing,
  startRig,
  stopRig,
  type Rig,
} from '../devices/room-scales-support.ts';
import { actorOf, messageOf } from '../execution/db-guards-support.ts';
import { personaIn, RunDriver, rowsOf, violations } from '../execution/support.ts';

type Json = Record<string, unknown>;

let rig: Rig;
/** The run every weighing below belongs to: a dc-mini whose dispensing stage names no room, at the paracetamol weighing. */
let run: RunDriver;
/** The gateway key of TEST-GW-01 (its chain id). */
let key1: string;
/** A second ACTIVE gateway key, of TEST-GW-02, with no instrument bound. */
let key2: string;
/** A connection of the gateway listener's own login (kernel 0980). */
let listener: pg.Pool;
let monitor: ActorContext;

beforeAll(async () => {
  rig = await startRig();
  key1 = rig.gw.login.chainId;
  const { server } = rig;
  const admin = await adminActor(server, 'manual-weighing-gate kill tests: bindings and a second gateway');
  const site = (await server.db.admin.query<{ site_code: string }>("select site_code from iam.device where code = 'TEST-GW-01'")).rows[0]?.site_code;
  const spki = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' });
  key2 = await identity.withGuardedCommand(server.db.app, admin, async (c) => {
    // The bindings' history: TEST-BAL-02 (BLEND-1) was bound to TEST-GW-01 and ended, TEST-BAL-00 (DISP-1) was bound
    // again (its first binding ended). So BLEND-1 holds no bound scale, DISP-1 holds TEST-BAL-00 and TEST-BAL-01.
    const b02 = (await c.query<{ id: string }>("select tab.bind_instrument($1, 'TEST-BAL-02', 'SIM-0002', 'kg', '0.01') as id", [key1])).rows[0]?.id;
    await c.query("select tab.end_instrument_binding($1, 'TEST_SETUP', 'moved to the blending line (test)')", [b02]);
    const b00 = (await c.query<{ id: string }>("select id from tab.gateway_instrument where device_code = 'TEST-BAL-00' and ended_at is null")).rows[0]?.id;
    await c.query("select tab.end_instrument_binding($1, 'TEST_SETUP', 'checked and bound again (test)')", [b00]);
    await c.query("select tab.bind_instrument($1, 'TEST-BAL-00', 'SIM-0000', 'kg', '0.01')", [key1]);
    // A second site gateway, enrolled: its key is ACTIVE, no instrument is bound to it.
    await c.query("select iam.register_device('TEST-GW-02', 'SERVER', $1, null, null, $2, 'Second site gateway (test)')", [site, createHash('sha256').update(spki).digest('hex')]);
    return (await c.query<{ id: string }>('select tab.enrol_gateway_key($1, $2, $3) as id', ['TEST-GW-02', spki.toString('base64'), gatewayService(server).loginName])).rows[0]?.id ?? '';
  });
  // Both rooms have their lock row (added by the first heartbeat or weighing of each room; here by hand).
  await server.db.admin.query("insert into tab.scale_room_lock (room_code) values ('DISP-1'), ('BLEND-1') on conflict do nothing");
  listener = openPool({ connectionString: urlFor(server.database, SANDBOX_LISTENER_LOGIN), max: 1 });
  monitor = await monitorActor(rig);
  run = await newRun(rig, { content: roomFreeDispensing() });
  await reachPcm(run);
}, 300_000);

afterAll(async () => {
  if (listener) await endPool(listener);
  await stopRig(rig);
});

// ---------------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------------

/** The actor of the live gateway session (TEST-GW-01), as the listener runs a heartbeat's command under it. */
async function gatewayActor(): Promise<ActorContext> {
  const { rows } = await rig.server.db.admin.query<{ id: string; person_id: string; account_id: string; device_id: string; legal_name: string }>(
    `select s.id, s.person_id, s.account_id, s.device_id, p.legal_name
       from iam.session s join iam.device d on d.id = s.device_id join iam.person p on p.id = s.person_id
      where d.code = 'TEST-GW-01' and s.ended_at is null order by s.opened_at desc limit 1`,
  );
  const s = rows[0];
  if (!s) throw new Error('SETUP: no live gateway session');
  return { personId: s.person_id, accountId: s.account_id, roleCode: 'SITE_GATEWAY', sessionId: s.id, deviceId: s.device_id, source: 'INTEGRATION', siteZone: rig.server.config.siteZone, legalName: s.legal_name, correlationId: randomUUID() };
}

interface Device {
  deviceCode: unknown;
  state?: unknown;
  serial?: unknown;
  notReady?: unknown;
}

/** A heartbeat body as the gateway sends it; the journal says the gateway holds `acked` readings the server acknowledged. */
function heartbeatBody(devices: unknown[], acked = '0'): Json {
  return { gatewayTimeUs: '1790584618000000', devices, journal: { lastSeq: acked, ackedSeq: acked } };
}

/** tab.record_heartbeat in a committed command of the gateway session; its answer. */
async function heartbeat(devices: unknown[], acked?: string): Promise<Json> {
  const body = heartbeatBody(devices, acked ?? (await head()));
  return withActorCommand(rig.server.db.app, await gatewayActor(), async (c) => (await c.query<{ r: Json }>('select tab.record_heartbeat($1::jsonb) as r', [JSON.stringify(body)])).rows[0]?.r ?? {});
}

/** The server's head of TEST-GW-01's chain (its last ingested reading's seq). */
async function head(): Promise<string> {
  return (await rig.server.db.admin.query<{ seq: string }>("select tab.chain_head($1) ->> 'seq' as seq", [key1])).rows[0]?.seq ?? '';
}

const online = (deviceCode: string, serial: string): Device => ({ deviceCode, state: 'ONLINE', serial, notReady: null });
const offline = (deviceCode: string): Device => ({ deviceCode, state: 'OFFLINE', serial: null, notReady: null });

/** The SHA-256 of the live gateway session's bearer token, as the listener hands it to tab.record_heartbeat_receipt. */
const tokenHash = (): string => createHash('sha256').update(rig.gw.token, 'utf8').digest('hex');

/** tab.record_heartbeat_receipt on the listener's own login; its answer. */
async function receipt(devices: unknown[], hash = tokenHash()): Promise<Json> {
  return (await listener.query<{ r: Json }>('select tab.record_heartbeat_receipt($1, $2::jsonb) as r', [hash, JSON.stringify(heartbeatBody(devices))])).rows[0]?.r ?? {};
}

/** The monitor's report of TEST-GW-01's API (or of `gateway`), in a committed command of its session; whether it was written. */
async function contact(reachable: boolean | null, detail: string, gateway = 'TEST-GW-01'): Promise<boolean> {
  return withActorCommand(rig.server.db.app, { ...monitor, correlationId: randomUUID() }, async (c) =>
    (await c.query<{ written: boolean }>('select tab.record_gateway_api_contact($1, $2, $3) as written', [gateway, reachable, detail])).rows[0]?.written ?? false,
  );
}

/** The rows of tab.gateway_api_contact, as text (microseconds kept). */
async function contactRows(): Promise<Json[]> {
  return (
    await rig.server.db.admin.query<Json>(
      'select gateway_key_id::text as key, reachable, detail, observed_at::text as observed, changed_at::text as changed from tab.gateway_api_contact order by gateway_key_id',
    )
  ).rows;
}

async function alarms(code: string): Promise<number> {
  return (await rig.server.db.admin.query<{ n: number }>('select count(*)::int as n from tab.device_alarm where code = $1', [code])).rows[0]?.n ?? 0;
}

/** Runs `work` on a superuser connection in a transaction that is rolled back; its result. */
async function rolledBack<T>(work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await rig.server.db.admin.connect();
  try {
    await c.query('begin');
    return await work(c);
  } finally {
    await c.query('rollback');
    c.release();
  }
}

/** Of `rooms`, those whose row of tab.scale_room_lock another transaction holds (a share lock without waiting fails). */
async function held(rooms: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const room of rooms) {
    const c = await rig.server.db.admin.connect();
    try {
      await c.query('begin');
      const r = await c.query('select 1 from tab.scale_room_lock where room_code = $1 for share nowait', [room]);
      if (r.rowCount !== 1) throw new Error(`SETUP: room ${room} has no lock row`);
    } catch (e) {
      if ((e as { code?: string }).code === '55P03') out.push(room);
      else throw e;
    } finally {
      await c.query('rollback');
      c.release();
    }
  }
  return out;
}

/** Runs `work` in an open command of `actor` on the application role, then `meanwhile` (the command still open), then rolls back. */
async function whileOpen<T>(actor: ActorContext, work: (c: pg.PoolClient) => Promise<unknown>, meanwhile: () => Promise<T>): Promise<T> {
  const c = await rig.server.db.app.connect();
  try {
    await c.query('begin');
    await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext({ ...actor, correlationId: randomUUID() }))]);
    await work(c);
    return await meanwhile();
  } finally {
    await c.query('rollback');
    c.release();
  }
}

/** The recorded heartbeat of `device` (state, serial, not-ready reason, key, offline_since). */
async function recorded(device: string): Promise<Json | undefined> {
  return (
    await rig.server.db.admin.query<Json>(
      `select h.state, h.serial, h.not_ready as "notReady", h.gateway_key_id::text as key, h.offline_since::text as "offlineSince",
              h.offline_since > clock_timestamp() - interval '1 minute' as "offlineRecently"
         from tab.instrument_heartbeat h join iam.device d on d.id = h.instrument_device_id where d.code = $1`,
      [device],
    )
  ).rows[0];
}

const dispScales = async (): Promise<Json[]> => (await rig.server.db.app.query<{ s: Json[] }>("select tab.scale_status('DISP-1') as s")).rows[0]?.s ?? [];

// ---------------------------------------------------------------------------------------------------------------------
// Heartbeats
// ---------------------------------------------------------------------------------------------------------------------

describe('heartbeats of the site gateway (tab.record_heartbeat, tablets 0350)', () => {
  it('[DI-30][PR-20] a heartbeat locks the rooms of the instruments it names that are bound to its key now, and no other: none for an instrument bound to no key', async () => {
    const gw = await gatewayActor();
    const call = (devices: Device[]) => (c: pg.PoolClient) => c.query('select tab.record_heartbeat($1::jsonb)', [JSON.stringify(heartbeatBody(devices, '0'))]);
    expect(await held(['DISP-1', 'BLEND-1'])).toEqual([]);
    expect(await whileOpen(gw, call([online('TEST-BAL-01', 'SIM-0001')]), () => held(['DISP-1', 'BLEND-1']))).toEqual(['DISP-1']);
    expect(await whileOpen(gw, call([offline('TEST-BAL-00')]), () => held(['DISP-1', 'BLEND-1']))).toEqual(['DISP-1']);
    // TEST-BAL-02's binding (BLEND-1) has ended, and TEST-NOPE is bound to nothing: no room is locked.
    expect(await whileOpen(gw, call([offline('TEST-BAL-02'), offline('TEST-NOPE')]), () => held(['DISP-1', 'BLEND-1']))).toEqual([]);
  });

  it('[DI-31] a gateway that counts more readings than the server holds raises EBMR-DEV-070 once a minute, whatever else it alarmed; one that counts what the server holds raises none', async () => {
    const before = await alarms('EBMR-DEV-070');
    const h = await head();
    // The gateway counts exactly what the server holds: no alarm.
    await heartbeat([online('TEST-BAL-01', 'SIM-0001')], h);
    expect(await alarms('EBMR-DEV-070')).toBe(before);
    // Another alarm of this gateway within the minute (an instrument bound to nothing) does not hold the reconciliation
    // alarm back.
    const unknown = await alarms('EBMR-DEV-046');
    await heartbeat([offline('TEST-NOPE')], h);
    expect(await alarms('EBMR-DEV-046')).toBe(unknown + 1);
    const ahead = (BigInt(h) + 2n).toString();
    await heartbeat([online('TEST-BAL-01', 'SIM-0001')], ahead);
    expect(await alarms('EBMR-DEV-070')).toBe(before + 1);
    const last = await rig.server.db.admin.query<{ gateway_code: string; message: string }>("select gateway_code, message from tab.device_alarm where code = 'EBMR-DEV-070' order by id desc limit 1");
    expect(last.rows).toEqual([
      { gateway_code: 'TEST-GW-01', message: `DI-31: the gateway counts ${ahead} readings the server acknowledged, the server holds ${h}; the gateway must send the missing readings again` },
    ]);
    // Within the minute it is not raised again.
    await heartbeat([online('TEST-BAL-01', 'SIM-0001')], ahead);
    expect(await alarms('EBMR-DEV-070')).toBe(before + 1);
    await heartbeat([online('TEST-BAL-01', 'SIM-0001')], h);
  });

  it('[DI-30][DI-20] a state the gateway does not name, or names outside its vocabulary, is recorded OFFLINE; a not-ready reason counts only as text that is not blank', async () => {
    await heartbeat([{ deviceCode: 'TEST-BAL-01', state: 'WARMING_UP', serial: 'SIM-0001', notReady: null }]);
    expect(await recorded('TEST-BAL-01')).toMatchObject({ state: 'OFFLINE', notReady: null });
    await heartbeat([{ deviceCode: 'TEST-BAL-01', serial: 'SIM-0001' }]);
    expect(await recorded('TEST-BAL-01')).toMatchObject({ state: 'OFFLINE', notReady: null });
    await heartbeat([{ deviceCode: 'TEST-BAL-01', state: 'ONLINE', serial: 'SIM-0001', notReady: 5 }]);
    expect(await recorded('TEST-BAL-01')).toMatchObject({ state: 'ONLINE', notReady: null });
    await heartbeat([{ deviceCode: 'TEST-BAL-01', state: 'ONLINE', serial: 'SIM-0001', notReady: '   ' }]);
    expect(await recorded('TEST-BAL-01')).toMatchObject({ state: 'ONLINE', notReady: null });
    await heartbeat([{ deviceCode: 'TEST-BAL-01', state: 'ONLINE', serial: 'SIM-0001', notReady: '  paper out ' }]);
    expect(await recorded('TEST-BAL-01')).toMatchObject({ state: 'OFFLINE', notReady: 'paper out' });
    await heartbeat([online('TEST-BAL-01', 'SIM-0001')]);
    expect(await recorded('TEST-BAL-01')).toMatchObject({ state: 'ONLINE', notReady: null });
  });

  it('[DI-20][DI-30] a serial that is not the registered one raises EBMR-DEV-048 once per episode, and the scale is shown with the serial it answers with; going ONLINE or OFFLINE raises nothing', async () => {
    await heartbeat([online('TEST-BAL-01', 'SIM-0001')]);
    const before = await alarms('EBMR-DEV-048');
    await heartbeat([offline('TEST-BAL-01')]);
    await heartbeat([online('TEST-BAL-01', 'SIM-0001')]);
    expect(await alarms('EBMR-DEV-048')).toBe(before);
    await heartbeat([online('TEST-BAL-01', 'SIM-9999')]);
    await heartbeat([online('TEST-BAL-01', 'SIM-9999')]);
    expect(await alarms('EBMR-DEV-048')).toBe(before + 1);
    expect(await recorded('TEST-BAL-01')).toMatchObject({ state: 'SERIAL_MISMATCH', serial: 'SIM-9999' });
    expect((await dispScales()).find((s) => s['deviceCode'] === 'TEST-BAL-01')).toMatchObject({ status: 'OFFLINE', reason: 'it answers with serial SIM-9999, not the registered SIM-0001' });
    await heartbeat([online('TEST-BAL-01', 'SIM-0001')]);
    expect(await alarms('EBMR-DEV-048')).toBe(before + 1);
  });

  it('[DI-30][PR-20] since when a scale has been recorded not ONLINE starts again when another gateway key reports it: an episode of an earlier key is not this one\'s', async () => {
    await heartbeat([offline('TEST-BAL-01')]);
    // As if TEST-BAL-01 had been bound to TEST-GW-02, which recorded it OFFLINE an hour ago and since (written by hand:
    // the instrument would have to be bound again under TEST-GW-01 for it to report the scale next).
    await rig.server.db.admin.query(
      `update tab.instrument_heartbeat set gateway_key_id = $1, state = 'OFFLINE', offline_since = clock_timestamp() - interval '1 hour'
        where instrument_device_id = (select id from iam.device where code = 'TEST-BAL-01')`,
      [key2],
    );
    await heartbeat([offline('TEST-BAL-01')]);
    const first = await recorded('TEST-BAL-01');
    expect(first).toMatchObject({ state: 'OFFLINE', key: key1, offlineRecently: true });
    // The same key reporting it OFFLINE again keeps the start; ONLINE clears it.
    await heartbeat([offline('TEST-BAL-01')]);
    expect(await recorded('TEST-BAL-01')).toMatchObject({ offlineSince: first?.['offlineSince'] });
    await heartbeat([online('TEST-BAL-01', 'SIM-0001')]);
    expect(await recorded('TEST-BAL-01')).toMatchObject({ state: 'ONLINE', offlineSince: null });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The monitor's reports, the API's answers and the receipts
// ---------------------------------------------------------------------------------------------------------------------

describe('the gateway API monitor\'s report and the probes it asks for (tab.record_gateway_api_contact, tablets 0350)', () => {
  it('[DI-30][DI-31] a report that says neither reached nor not reached is refused (EBMR-DEV-074); one of a gateway that has no ACTIVE key writes nothing and answers false', async () => {
    const before = await contactRows();
    expect(await messageOf(contact(null, 'test: no state'))).toMatch(/^EBMR-DEV-074 a contact with the gateway API was either reached or not$/);
    expect(await contact(false, 'test: an unknown gateway', 'TEST-GW-99')).toBe(false);
    expect(await contact(true, 'test: an unknown gateway', 'TEST-GW-99')).toBe(false);
    expect(await contactRows()).toEqual(before);
  });

  it('[DI-30][PR-20] the report keeps when the API was first found unreachable while it stays so, and both the heartbeat and its receipt ask for a probe only while the API of their own gateway is unreachable', async () => {
    expect(await contact(false, 'test: no answer')).toBe(true);
    const first = (await contactRows()).find((r) => r['key'] === key1);
    expect(await heartbeat([online('TEST-BAL-01', 'SIM-0001')])).toMatchObject({ probeApi: true });
    expect(await receipt([online('TEST-BAL-01', 'SIM-0001')])).toEqual({ received: true, probeApi: true });
    expect(await contact(false, 'test: still no answer')).toBe(true);
    const second = (await contactRows()).find((r) => r['key'] === key1);
    expect(second).toMatchObject({ reachable: false, detail: 'test: still no answer', changed: first?.['changed'] });
    expect(second?.['observed']).not.toBe(first?.['observed']);
    expect(await contact(true, 'test: answers')).toBe(true);
    const third = (await contactRows()).find((r) => r['key'] === key1);
    expect(third).toMatchObject({ reachable: true });
    expect(third?.['changed']).not.toBe(first?.['changed']);
    expect(await heartbeat([online('TEST-BAL-01', 'SIM-0001')])).toMatchObject({ probeApi: false });
    expect(await receipt([online('TEST-BAL-01', 'SIM-0001')])).toEqual({ received: true, probeApi: false });
  });

  it('[DI-30][PR-20] a report that the API is reached again locks the rooms of the instruments bound to the key now, and no other (tab.lock_gateway_rooms)', async () => {
    expect(await contact(false, 'test: no answer')).toBe(true);
    const lockedRooms = await whileOpen(monitor, (c) => c.query(RECORD_CONTACT_SQL, [true, 'test: answers again']), () => held(['DISP-1', 'BLEND-1']));
    expect(lockedRooms).toEqual(['DISP-1']);
    expect(await contact(true, 'test: answers')).toBe(true);
  });
});

describe('what the listener puts on record first (tab.record_heartbeat_receipt, tab.record_gateway_api_answer, tablets 0350)', () => {
  const receipts = async (key: string): Promise<number> => (await rig.server.db.admin.query<{ n: number }>('select count(*)::int as n from tab.heartbeat_receipt where gateway_key_id = $1', [key])).rows[0]?.n ?? 0;

  it('[DI-30][DI-31] a heartbeat with a token of no session is not received and asks for no probe; nothing is written', async () => {
    const before = await receipts(key1);
    expect(await receipt([online('TEST-BAL-01', 'SIM-0001')], 'f'.repeat(64))).toEqual({ received: false, probeApi: false });
    expect(await receipts(key1)).toBe(before);
  });

  it('[DI-30][DI-31] a heartbeat keeps the instruments it names as objects with a text code, each state, serial and not-ready reason only as non-blank text', async () => {
    const answer = await receipt([
      { deviceCode: 'TEST-BAL-01', state: 'ONLINE', serial: 'SIM-0001', notReady: '  paper out ' },
      { deviceCode: 'TEST-BAL-00', state: 'OFFLINE', serial: null, notReady: '   ' },
      { deviceCode: 'TEST-BAL-02', state: 7, serial: 8, notReady: 5 },
      { deviceCode: 9, state: 'ONLINE' },
      'TEST-BAL-03',
      { state: 'ONLINE' },
    ]);
    expect(answer).toEqual({ received: true, probeApi: false });
    const { rows } = await rig.server.db.admin.query<{ devices: Json[] }>('select devices from tab.heartbeat_receipt where gateway_key_id = $1 order by received_at desc limit 1', [key1]);
    expect(rows[0]?.devices).toEqual([
      { deviceCode: 'TEST-BAL-01', state: 'ONLINE', serial: 'SIM-0001', notReady: 'paper out' },
      { deviceCode: 'TEST-BAL-00', state: 'OFFLINE', serial: null, notReady: null },
      { deviceCode: 'TEST-BAL-02', state: null, serial: null, notReady: null },
    ]);
  });

  it('[DI-30][DI-31] a heartbeat of a session whose key is no longer ACTIVE is not received (key revoked in a transaction rolled back)', async () => {
    const admin = await adminActor(rig.server, 'revoke the gateway key (rolled back)');
    const answer = await rolledBack(async (c) => {
      await c.query('set local role ebmr_app');
      await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(admin))]);
      await c.query("select tab.revoke_gateway_key($1, 'TEST_SETUP', 'key retired (test, rolled back)')", [key1]);
      await c.query('reset role');
      await c.query('set local role ebmr_sandbox_listener');
      const r = (await c.query<{ r: Json }>('select tab.record_heartbeat_receipt($1, $2::jsonb) as r', [tokenHash(), JSON.stringify(heartbeatBody([online('TEST-BAL-01', 'SIM-0001')]))])).rows[0]?.r;
      await c.query('reset role');
      const n = (await c.query<{ n: number }>('select count(*)::int as n from tab.heartbeat_receipt where received_at >= transaction_timestamp()')).rows[0]?.n;
      return { r, n };
    });
    expect(answer).toEqual({ r: { received: false, probeApi: false }, n: 0 });
  });

  it('[DI-30] receipts and answers older than an hour are pruned for the key that writes, never another key\'s', async () => {
    // Rows of an hour ago, written by hand (the listener writes at the database's time).
    const old = async (table: 'heartbeat_receipt' | 'gateway_api_answer', key: string): Promise<string> =>
      (
        await rig.server.db.admin.query<{ id: string }>(
          table === 'heartbeat_receipt'
            ? "insert into tab.heartbeat_receipt (gateway_key_id, received_at, devices) values ($1, clock_timestamp() - interval '61 minutes', '[]') returning id"
            : "insert into tab.gateway_api_answer (gateway_key_id, answered_at, detail) values ($1, clock_timestamp() - interval '61 minutes', 'test: old answer') returning id",
          [key],
        )
      ).rows[0]?.id ?? '';
    const exists = async (table: string, id: string): Promise<boolean> => ((await rig.server.db.admin.query(`select 1 from tab.${table} where id = $1`, [id])).rowCount ?? 0) > 0;
    const r1 = await old('heartbeat_receipt', key1);
    const r2 = await old('heartbeat_receipt', key2);
    const a1 = await old('gateway_api_answer', key1);
    const a2 = await old('gateway_api_answer', key2);
    expect(await receipt([online('TEST-BAL-01', 'SIM-0001')])).toMatchObject({ received: true });
    expect((await listener.query<{ ok: boolean }>("select tab.record_gateway_api_answer('TEST-GW-01', '  ') as ok")).rows[0]?.ok).toBe(true);
    expect({ r1: await exists('heartbeat_receipt', r1), r2: await exists('heartbeat_receipt', r2), a1: await exists('gateway_api_answer', a1), a2: await exists('gateway_api_answer', a2) }).toEqual({
      r1: false,
      r2: true,
      a1: false,
      a2: true,
    });
    const latest = await rig.server.db.admin.query<{ detail: string }>('select detail from tab.gateway_api_answer where gateway_key_id = $1 order by answered_at desc limit 1', [key1]);
    expect(latest.rows).toEqual([{ detail: 'the gateway API answered' }]);
  });

  it('[DI-30] an answer of a gateway that has no ACTIVE key is not recorded', async () => {
    const count = async (): Promise<number> => (await rig.server.db.admin.query<{ n: number }>('select count(*)::int as n from tab.gateway_api_answer')).rows[0]?.n ?? 0;
    const before = await count();
    expect((await listener.query<{ ok: boolean }>("select tab.record_gateway_api_answer('TEST-GW-99', 'test: who answers') as ok")).rows[0]?.ok).toBe(false);
    expect(await count()).toBe(before);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Room locks and the scales of a room
// ---------------------------------------------------------------------------------------------------------------------

describe('room locks and the scales of a room (tablets 0320, 0350)', () => {
  it('[DI-30][PR-20] tab.lock_scale_rooms adds the row of a room that has none and locks it; a blank or missing room is skipped', async () => {
    const rows = await rolledBack(async (c) => {
      await c.query("select tab.lock_scale_rooms(array['TEST-ROOM-NEW', '  ', null, 'DISP-1'])");
      return (await c.query<{ room_code: string }>("select room_code from tab.scale_room_lock where room_code in ('TEST-ROOM-NEW', '  ', 'DISP-1') or btrim(room_code) = '' order by room_code")).rows;
    });
    expect(rows).toEqual([{ room_code: 'DISP-1' }, { room_code: 'TEST-ROOM-NEW' }]);
  });

  it('[DI-30][PR-20] the scales of a room are its instruments bound now to an ACTIVE key, each once, also with a second ACTIVE gateway key and an ended binding in the room', async () => {
    const codes = (list: Json[]) => list.map((s) => s['deviceCode']);
    expect(codes(await dispScales())).toEqual(['TEST-BAL-00', 'TEST-BAL-01']);
    expect(codes((await rig.server.db.app.query<{ s: Json[] }>('select tab.scale_status(null) as s')).rows[0]?.s ?? [])).toEqual(['TEST-BAL-00', 'TEST-BAL-01']);
    expect(codes((await rig.server.db.app.query<{ s: Json[] }>("select tab.scale_status('BLEND-1') as s")).rows[0]?.s ?? [])).toEqual([]);
    const gate = async (room: string) => codes((await rig.server.db.admin.query<{ s: Json[] }>('select tab.manual_weighing_scales($1) as s', [room])).rows[0]?.s ?? []);
    expect(await gate('DISP-1')).toEqual(['TEST-BAL-00', 'TEST-BAL-01']);
    expect(await gate('BLEND-1')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Each reason at its boundary
// ---------------------------------------------------------------------------------------------------------------------

/** `t` moved by `seconds` (microseconds kept), as text. */
async function shift(c: pg.ClientBase, t: string, seconds: number): Promise<string> {
  return (await c.query<{ t: string }>('select ($1::timestamptz + make_interval(secs => $2::float8))::text as t', [t, seconds])).rows[0]?.t ?? '';
}

/** A heartbeat row of TEST-BAL-01 under TEST-GW-01, as the composite tab.manual_path_verdict and the reasons take. */
function hb(fields: { state: string; serial?: string | null; reportedAt: string; offlineSince?: string | null; notReady?: string | null }): Json {
  return { state: fields.state, serial: fields.serial ?? null, reported_at: fields.reportedAt, offline_since: fields.offlineSince ?? null, not_ready: fields.notReady ?? null };
}

/** The composite arguments of TEST-BAL-01 (key, binding, device, heartbeat `h` or none) as SQL, $1 the heartbeat as JSON. */
const BAL01_ARGS = `k, b, d,
  case when $1::jsonb is null then null::tab.instrument_heartbeat
       else jsonb_populate_record(null::tab.instrument_heartbeat, $1::jsonb || jsonb_build_object('instrument_device_id', d.id, 'gateway_key_id', k.id)) end`;
const BAL01_FROM = `from tab.gateway_instrument b join tab.gateway_key k on k.id = b.gateway_key_id join iam.device d on d.id = b.instrument_device_id
  where b.device_code = 'TEST-BAL-01' and b.ended_at is null`;

/** tab.manual_path_verdict for TEST-BAL-01 with heartbeat `h`, a window from `from` and the listener vouching from `attested`. */
async function verdict(c: pg.ClientBase, h: Json | null, from: string, attested: string | null): Promise<Json> {
  const { rows } = await c.query<{ v: Json }>(`select tab.manual_path_verdict(${BAL01_ARGS}, $2::timestamptz, $3::timestamptz) as v ${BAL01_FROM}`, [h === null ? null : JSON.stringify(h), from, attested]);
  return rows[0]?.v ?? {};
}

/** tab.scale_offline_reason_at for TEST-BAL-01 with heartbeat `h`, counting the server's reports made before `before`. */
async function reasonAt(c: pg.ClientBase, h: Json | null, before: string): Promise<string | null> {
  const { rows } = await c.query<{ r: string | null }>(`select tab.scale_offline_reason_at(${BAL01_ARGS}, $2::timestamptz) as r ${BAL01_FROM}`, [h === null ? null : JSON.stringify(h), before]);
  return rows[0]?.r ?? null;
}

/** In a rolled-back transaction: no receipt, report or refusal of TEST-GW-01 left, and the database time `t`. */
async function cleanSlate(c: pg.ClientBase): Promise<string> {
  await c.query('delete from tab.heartbeat_receipt where gateway_key_id = $1', [key1]);
  await c.query('delete from tab.gateway_api_answer where gateway_key_id = $1', [key1]);
  await c.query('delete from tab.gateway_api_contact where gateway_key_id = $1', [key1]);
  return (await c.query<{ t: string }>('select clock_timestamp()::text as t')).rows[0]?.t ?? '';
}

/** A refusal of a reading of TEST-GW-01's chain raised at `at` with `code`, written by hand (as the listener records one). */
async function refusal(c: pg.ClientBase, at: string, code: string, kind = 'READING_REFUSED'): Promise<void> {
  await c.query(
    `insert into tab.device_alarm (raised_at, kind, code, gateway_code, session_id, message)
     values ($1, $2, $3, 'TEST-GW-01', (select session_id from tab.gateway_session where gateway_key_id = $4 order by bound_at desc limit 1), 'test: written by hand')`,
    [at, kind, code, key1],
  );
}

/** A receipt of a heartbeat naming `devices`, received at `at` (written by hand, as the listener writes one). */
async function receivedAt(c: pg.ClientBase, at: string, devices: Device[]): Promise<void> {
  await c.query('insert into tab.heartbeat_receipt (gateway_key_id, received_at, devices) values ($1, $2, $3::jsonb)', [key1, at, JSON.stringify(devices)]);
}

/** The monitor's report that TEST-GW-01's API is unreachable, changed at `changed` and first seen at `seen` (written by hand). */
async function unreachableSince(c: pg.ClientBase, changed: string, seen: string | null): Promise<void> {
  await c.query(
    "insert into tab.gateway_api_contact (gateway_key_id, reachable, detail, observed_at, changed_at, seen_at) values ($1, false, 'test: no answer', $2, $2, $3)",
    [key1, changed, seen],
  );
}

const API_REASON = "the server cannot reach the site gateway's API (test: no answer)";
const refused = (code: string) => `the server refused a reading of gateway TEST-GW-01 (${code}) and has received none since, so no capture can reach it`;

describe('whether the gate may count a scale unusable (tab.manual_path_verdict, tablets 0350)', () => {
  it('[DI-30][PR-20] a scale recorded ONLINE a second ago with nothing against it is ONLINE with no reason and no why, even when no heartbeat naming it was received in the window', async () => {
    const v = await rolledBack(async (c) => {
      const t = await cleanSlate(c);
      return verdict(c, hb({ state: 'ONLINE', serial: 'SIM-0001', reportedAt: await shift(c, t, -1) }), await shift(c, t, -10), await shift(c, t, -11));
    });
    expect(v).toEqual({ status: 'ONLINE', reason: null, why: null, detail: null });
  });

  it('[DI-30][PR-20] a scale never recorded is UNKNOWN only while no heartbeat naming it was received in the window; one received in it, also at the window\'s very start, keeps it UNRECORDED (not UNKNOWN, not offline)', async () => {
    const v = await rolledBack(async (c) => {
      const t = await cleanSlate(c);
      const from = await shift(c, t, -10);
      const attested = await shift(c, t, -11);
      const none = await verdict(c, null, from, attested);
      await receivedAt(c, await shift(c, t, -1), [online('TEST-BAL-01', 'SIM-0001')]);
      const received = await verdict(c, null, from, attested);
      await c.query('delete from tab.heartbeat_receipt where gateway_key_id = $1', [key1]);
      // Received at the very microsecond the window starts (written by hand), the listener vouching from then.
      await receivedAt(c, from, [offline('TEST-BAL-01')]);
      const atStart = await verdict(c, null, from, from);
      return { none, received, atStart };
    });
    const unrecorded = { status: 'ONLINE', reason: null, why: 'UNRECORDED', detail: null };
    expect(v).toEqual({ none: { status: 'UNKNOWN', reason: 'the site gateway has not reported it yet' }, received: unrecorded, atStart: unrecorded });
  });

  it('[DI-30][PR-20] a state recorded not ONLINE since before the window counts when no heartbeat in the window said ONLINE (none received at all included); since the window\'s very start it is RECENT', async () => {
    const v = await rolledBack(async (c) => {
      const t = await cleanSlate(c);
      const from = await shift(c, t, -10);
      const attested = await shift(c, t, -11);
      const reportedAt = await shift(c, t, -1);
      return {
        before: await verdict(c, hb({ state: 'OFFLINE', reportedAt, offlineSince: await shift(c, from, -0.000001) }), from, attested),
        atStart: await verdict(c, hb({ state: 'OFFLINE', reportedAt, offlineSince: from }), from, attested),
      };
    });
    expect(v).toEqual({
      before: { status: 'OFFLINE', reason: 'the site gateway reports it OFFLINE' },
      atStart: { status: 'ONLINE', reason: null, why: 'RECENT', detail: null },
    });
  });

  it('[DI-20][DI-30] a scale recorded with another serial counts with the serial it answers with, also when recorded ONLINE before its registered serial changed', async () => {
    const v = await rolledBack(async (c) => {
      const t = await cleanSlate(c);
      const from = await shift(c, t, -10);
      const attested = await shift(c, t, -11);
      const reportedAt = await shift(c, t, -1);
      const offlineSince = await shift(c, t, -60);
      return {
        mismatch: await verdict(c, hb({ state: 'SERIAL_MISMATCH', serial: 'SIM-9999', reportedAt, offlineSince }), from, attested),
        shown: await reasonAt(c, hb({ state: 'SERIAL_MISMATCH', serial: 'SIM-9999', reportedAt, offlineSince }), 'infinity'),
        // Recorded ONLINE with the serial then registered, which has changed since (an ONLINE row has no offline_since):
        // shown offline at once, not yet a reason to key by hand.
        onlineOtherSerial: await verdict(c, hb({ state: 'ONLINE', serial: 'SIM-9999', reportedAt }), from, attested),
        shownOnlineOtherSerial: await reasonAt(c, hb({ state: 'ONLINE', serial: 'SIM-9999', reportedAt }), 'infinity'),
      };
    });
    const reason = 'it answers with serial SIM-9999, not the registered SIM-0001';
    expect(v).toEqual({
      mismatch: { status: 'OFFLINE', reason },
      shown: reason,
      onlineOtherSerial: { status: 'ONLINE', reason: null, why: 'RECENT', detail: null },
      shownOnlineOtherSerial: reason,
    });
  });

  it('[DI-30][PR-20] the API report counts until the gateway\'s API answers: an answer before the report does not answer it, one at its very instant or after does (ANSWERED, tablets 0600); a report seen at the window\'s very start is YOUNG', async () => {
    const v = await rolledBack(async (c) => {
      const t = await cleanSlate(c);
      const from = await shift(c, t, -10);
      const attested = await shift(c, t, -11);
      const ok = hb({ state: 'ONLINE', serial: 'SIM-0001', reportedAt: await shift(c, t, -1) });
      const changed = await shift(c, t, -30);
      await unreachableSince(c, changed, await shift(c, t, -20));
      const answer = async (at: string) => c.query("insert into tab.gateway_api_answer (gateway_key_id, answered_at, detail) values ($1, $2, 'test: answered')", [key1, at]);
      const unanswered = await verdict(c, ok, from, attested);
      // Answers recorded a microsecond before the report, then at its very microsecond (written by hand: the listener and
      // the monitor read the database clock on two connections), then after it.
      await answer(await shift(c, changed, -0.000001));
      const before = await verdict(c, ok, from, attested);
      await answer(changed);
      const sameInstant = await verdict(c, ok, from, attested);
      await c.query('delete from tab.gateway_api_answer where gateway_key_id = $1', [key1]);
      await answer(await shift(c, changed, 0.000001));
      const after = await verdict(c, ok, from, attested);
      await c.query('delete from tab.gateway_api_answer where gateway_key_id = $1', [key1]);
      await c.query('update tab.gateway_api_contact set seen_at = $2 where gateway_key_id = $1', [key1, from]);
      const seenAtStart = await verdict(c, ok, from, attested);
      return { unanswered, before, sameInstant, after, seenAtStart };
    });
    const answered = { status: 'ONLINE', reason: null, why: 'ANSWERED', detail: API_REASON };
    expect(v).toEqual({
      unanswered: { status: 'OFFLINE', reason: API_REASON },
      before: { status: 'OFFLINE', reason: API_REASON },
      sameInstant: answered,
      after: answered,
      seenAtStart: { status: 'ONLINE', reason: null, why: 'YOUNG', detail: API_REASON },
    });
  });

  it('[DI-30][DI-31] a refusal held since before the window is named by the code of the latest refusal raised before the window, not one raised at its very start', async () => {
    const v = await rolledBack(async (c) => {
      const t = await cleanSlate(c);
      await refusal(c, await shift(c, t, -0.002), 'EBMR-DEV-048');
      await refusal(c, t, 'EBMR-DEV-049');
      return verdict(c, hb({ state: 'ONLINE', serial: 'SIM-0001', reportedAt: await shift(c, t, -1) }), t, await shift(c, t, -1));
    });
    expect(v).toEqual({ status: 'OFFLINE', reason: refused('EBMR-DEV-048') });
  });
});

describe('the reasons a scale is shown offline and a refused reading (tab.scale_offline_reason_at, tab.chain_refusal_held, tablets 0340)', () => {
  it('[DI-30][PR-20] the API report counts only when its change was made before the bound given, not at it', async () => {
    const v = await rolledBack(async (c) => {
      const t = await cleanSlate(c);
      const ok = hb({ state: 'ONLINE', serial: 'SIM-0001', reportedAt: await shift(c, t, -1) });
      const changed = await shift(c, t, -5);
      await unreachableSince(c, changed, null);
      return { at: await reasonAt(c, ok, changed), after: await reasonAt(c, ok, await shift(c, changed, 0.000001)) };
    });
    expect(v).toEqual({ at: null, after: API_REASON });
  });

  it('[DI-30][DI-31] a refused reading is named by the latest refusal of the gateway\'s chain raised before the bound: not by a later alarm of another kind, nor by a refusal raised at the bound', async () => {
    const v = await rolledBack(async (c) => {
      const t = await cleanSlate(c);
      const ok = hb({ state: 'ONLINE', serial: 'SIM-0001', reportedAt: await shift(c, t, -1) });
      const r1 = await shift(c, t, -0.003);
      const r2 = await shift(c, t, -0.002);
      await refusal(c, r1, 'EBMR-DEV-048');
      await refusal(c, r2, 'EBMR-DEV-049');
      // A later alarm of the gateway's own session, of another kind.
      await refusal(c, await shift(c, t, -0.001), 'EBMR-DEV-046', 'UNKNOWN_INSTRUMENT');
      return { shown: await reasonAt(c, ok, 'infinity'), beforeSecond: await reasonAt(c, ok, r2) };
    });
    expect(v).toEqual({ shown: refused('EBMR-DEV-049'), beforeSecond: refused('EBMR-DEV-048') });
  });

  it('[DI-30][DI-31] a refusal holds the chain only when raised after its last ingested reading, and from a bound only when raised before it', async () => {
    // The chain's last ingested reading.
    expect((await rig.gw.uplink([{ reading: rig.gw.next() }])).body.refused).toBeNull();
    const heldBy = async (c: pg.ClientBase, before: string) => (await c.query<{ h: boolean }>('select tab.chain_refusal_held($1, $2::timestamptz) as h', [key1, before])).rows[0]?.h;
    // A refusal raised at the very microsecond the last reading was recorded, and one just after (written by hand).
    const sinceReading = await rolledBack(async (c) => {
      await cleanSlate(c);
      const last = (await c.query<{ t: string }>('select recorded_at::text as t from tab.device_reading where chain_id = $1 order by seq desc limit 1', [key1])).rows[0]?.t ?? '';
      await refusal(c, last, 'EBMR-DEV-048');
      const atReading = await heldBy(c, 'infinity');
      await refusal(c, await shift(c, last, 0.000001), 'EBMR-DEV-048');
      return { atReading, afterReading: await heldBy(c, 'infinity') };
    });
    // A refusal raised at a bound holds the chain only from a later bound.
    const fromBound = await rolledBack(async (c) => {
      const at = await shift(c, await cleanSlate(c), -0.001);
      await refusal(c, at, 'EBMR-DEV-048');
      return { before: await heldBy(c, at), after: await heldBy(c, await shift(c, at, 0.000001)) };
    });
    expect({ ...sinceReading, ...fromBound }).toEqual({ atReading: false, afterReading: true, before: false, after: true });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------------------------------------------------

/** The rows of tab.manual_weighing_basis of the run, with the room and the scales counted. */
async function basis(): Promise<{ room: string; scales: Json[] }[]> {
  return (await rig.server.db.admin.query<{ room: string; scales: Json[] }>('select room_code as room, scales from tab.manual_weighing_basis where batch_id = $1 order by row_seq', [run.runId])).rows;
}

/** Holds room `room`'s row of tab.scale_room_lock as a heartbeat of the room does (FOR UPDATE), while `work` runs. */
async function whileRoomHeld<T>(room: string, work: () => Promise<T>): Promise<T> {
  const c = await rig.server.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('select 1 from tab.scale_room_lock where room_code = $1 for update', [room]);
    return await work();
  } finally {
    await c.query('rollback');
    c.release();
  }
}

/**
 * Waits until the application role's write of an execution row (recipe.append_execution, where the gate runs) waits for
 * a lock on `relation`; fails when `settled` says the write ended first, or after 30 seconds.
 */
async function untilGateWaitsOn(relation: string, settled: () => boolean): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const { rows } = await rig.server.db.admin.query<{ n: number }>(
      `select count(*)::int as n from pg_catalog.pg_locks l join pg_catalog.pg_stat_activity a on a.pid = l.pid
        where a.datname = current_database() and a.query like 'select recipe.append_execution(%'
          and l.locktype = 'relation' and l.relation = $1::regclass and not l.granted`,
      [relation],
    );
    if ((rows[0]?.n ?? 0) > 0) return;
    if (settled()) throw new Error(`SETUP: the weighing ended before it waited on ${relation}`);
    if (Date.now() > deadline) throw new Error(`SETUP: the weighing never waited on ${relation}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * The scales of DISP-1 as recorded, written by hand as the gateway's heartbeats would have left them: TEST-BAL-00
 * OFFLINE for a minute and reported now (it counts as unusable), TEST-BAL-01 ONLINE with its serial and last reported
 * `bal01AgoS` seconds ago; no receipt and no API report of TEST-GW-01 left.
 */
async function craftDisp1(bal01AgoS: number): Promise<void> {
  await rig.server.db.admin.query('delete from tab.heartbeat_receipt where gateway_key_id = $1', [key1]);
  await rig.server.db.admin.query('delete from tab.gateway_api_answer where gateway_key_id = $1', [key1]);
  await rig.server.db.admin.query('delete from tab.gateway_api_contact where gateway_key_id = $1', [key1]);
  await rig.server.db.admin.query(
    `insert into tab.instrument_heartbeat (instrument_device_id, gateway_key_id, state, serial, reported_at, not_ready, written_xact, offline_since)
     select d.id, $1, case d.code when 'TEST-BAL-00' then 'OFFLINE' else 'ONLINE' end, case d.code when 'TEST-BAL-00' then null else 'SIM-0001' end,
            case d.code when 'TEST-BAL-00' then clock_timestamp() else clock_timestamp() - make_interval(secs => $2::float8) end, null, null,
            case d.code when 'TEST-BAL-00' then clock_timestamp() - interval '1 minute' end
       from iam.device d where d.code in ('TEST-BAL-00', 'TEST-BAL-01')
     on conflict (instrument_device_id) do update
       set gateway_key_id = excluded.gateway_key_id, state = excluded.state, serial = excluded.serial, reported_at = excluded.reported_at,
           not_ready = null, written_xact = null, offline_since = excluded.offline_since`,
    [key1, bal01AgoS],
  );
}

describe('the gate of hand-keyed weighings (tab.manual_weighing_check, tablets 0350)', () => {
  it('[DI-30][PR-20] a hand-keyed weighing written in a REPEATABLE READ or SERIALIZABLE transaction is refused (EBMR-EXE-074): the scales\' reports are read as committed when it is written; nothing is recorded', async () => {
    const before = (await rowsOf(rig.server, run.runId)).length;
    for (const isolation of ['repeatable read', 'serializable'] as const) {
      expect(await messageOf(forgedWeighingRow(rig, run, { isolation }))).toMatch(
        new RegExp(
          `A weight keyed by hand is checked against the scales' reports as committed when it is written, but this transaction reads the database as its snapshot saw it \\(isolation level ${isolation}\\), so whether a scale of room DISP-1 came online since is not known\\. Record it in a READ COMMITTED transaction \\(DI-30, PR-20\\)\\. \\[EBMR-EXE-074\\]$`,
        ),
      );
    }
    expect((await rowsOf(rig.server, run.runId)).length).toBe(before);
  });

  it('[DI-17][DI-30][PR-20] while a role other than the superusers may cancel or end other connections in this database, every hand-keyed weighing is refused (EBMR-EXE-074); nothing is recorded', async () => {
    const before = (await rowsOf(rig.server, run.runId)).length;
    // The policy lost in this database (e.g. by a restore): the application role may cancel backends again.
    await rig.server.db.admin.query('grant execute on function pg_catalog.pg_cancel_backend(integer) to ebmr_app');
    try {
      expect((await rig.server.db.admin.query<{ r: boolean }>('select kernel.backend_signals_restricted() as r')).rows[0]?.r).toBe(false);
      expect(await messageOf(forgedWeighingRow(rig, run))).toMatch(
        /Roles other than the database's superusers may cancel or end other connections in this database \(pg_cancel_backend, pg_terminate_backend, pg_signal_backend\), so the site gateway's reports could be silenced and a scale that works could look offline\. Nothing is keyed by hand until the database's operator takes that right away again \(sandbox\.apply_connect_policy, kernel 0970\) \(DI-17, DI-30, PR-20\)\. \[EBMR-EXE-074\]$/,
      );
    } finally {
      await rig.server.db.admin.query('revoke execute on function pg_catalog.pg_cancel_backend(integer) from ebmr_app');
    }
    expect((await rig.server.db.admin.query<{ r: boolean }>('select kernel.backend_signals_restricted() as r')).rows[0]?.r).toBe(true);
    expect((await rowsOf(rig.server, run.runId)).length).toBe(before);
  });

  it('[DI-30][PR-20] while a heartbeat of the room is being written (its lock row held), a hand-keyed weighing is refused at once (EBMR-EXE-074); nothing is recorded', async () => {
    const before = (await rowsOf(rig.server, run.runId)).length;
    const message = await whileRoomHeld('DISP-1', () => messageOf(forgedWeighingRow(rig, run)));
    expect(message).toMatch(/A scale of room DISP-1 is reporting its status at this moment, so whether it is online is not yet known; nothing is keyed by hand until it is\. Try again \(DI-30, PR-20\)\. \[EBMR-EXE-074\]$/);
    expect((await rowsOf(rig.server, run.runId)).length).toBe(before);
  });

  it('[DI-30][PR-20] beside a scale whose heartbeats arrive but are not recorded (held up or cut off on their way), a hand-keyed weighing is refused (EBMR-EXE-074); nothing is recorded', async () => {
    const before = (await rowsOf(rig.server, run.runId)).length;
    // TEST-BAL-00 recorded OFFLINE for a minute (counts); TEST-BAL-01 last recorded a minute ago, while the listener
    // keeps receiving heartbeats naming it (written by hand: the gateway's heartbeats cannot be held up on demand).
    await craftDisp1(60);
    expect(await receipt([online('TEST-BAL-01', 'SIM-0001')])).toMatchObject({ received: true });
    expect(await messageOf(forgedWeighingRow(rig, run))).toMatch(
      /Scale TEST-BAL-01 of room DISP-1 is shown offline \(no heartbeat from the site gateway in the last 10 seconds\), but heartbeats of the site gateway that name it have arrived since 10 seconds before this weighing began and were not recorded, and a heartbeat held up or cut off on its way into the record is no proof that the scale cannot be used\. Nothing is keyed by hand until its heartbeats are recorded again or have stopped arriving for 10 seconds \(DI-30, PR-20\)\. \[EBMR-EXE-074\]$/,
    );
    expect((await rowsOf(rig.server, run.runId)).length).toBe(before);
    await heartbeat([online('TEST-BAL-01', 'SIM-0001'), offline('TEST-BAL-00')]);
  });

  it('[DI-30][PR-20] beside a scale whose heartbeat is ONLINE, the report that the gateway API cannot be reached does not open the manual path once the API answered at the very instant the report was made (EBMR-EXE-074, ANSWERED; tablets 0600); nothing is recorded', async () => {
    const before = (await rowsOf(rig.server, run.runId)).length;
    // TEST-BAL-00 counts as unusable, TEST-BAL-01 reported ONLINE a second ago. The monitor's report changed 30 s ago and
    // was seen 20 s ago; the listener recorded an answer of the API at the very microsecond of the report (written by
    // hand: the two transactions read the database clock on two connections).
    await craftDisp1(1);
    await rig.server.db.admin.query(
      `with t as (select clock_timestamp() - interval '30 seconds' as changed)
       insert into tab.gateway_api_contact (gateway_key_id, reachable, detail, observed_at, changed_at, seen_at) select $1, false, 'test: no answer', changed, changed, changed + interval '10 seconds' from t`,
      [key1],
    );
    await rig.server.db.admin.query("insert into tab.gateway_api_answer (gateway_key_id, answered_at, detail) select gateway_key_id, changed_at, 'test: answered' from tab.gateway_api_contact where gateway_key_id = $1", [key1]);
    try {
      expect(await messageOf(forgedWeighingRow(rig, run))).toMatch(
        new RegExp(
          `Scale TEST-BAL-01 of room DISP-1 is online by its heartbeat\\. The report that it cannot be used \\(${API_REASON.replace(/[()]/g, '\\$&')}\\) is answered: the gateway's API answered the server after that report was made, so it does not open the manual path; capture the weight from the scale \\(DI-30, PR-20\\)\\. \\[EBMR-EXE-074\\]$`,
        ),
      );
      expect((await rowsOf(rig.server, run.runId)).length).toBe(before);
    } finally {
      await rig.server.db.admin.query('delete from tab.gateway_api_answer where gateway_key_id = $1', [key1]);
      await rig.server.db.admin.query('delete from tab.gateway_api_contact where gateway_key_id = $1', [key1]);
    }
  });

  it('[DI-30][PR-20] a scale shown ONLINE when the gate read it is named online first, also when the report that the gateway API cannot be reached was committed while the gate read the room\'s scales (EBMR-EXE-074); once the report stands for both, a scale is named with it (YOUNG); nothing is recorded', async () => {
    const before = (await rowsOf(rig.server, run.runId)).length;
    const basisBefore = (await basis()).length;
    // Both scales of DISP-1 reported ONLINE with their registered serials a moment ago, by the gateway's heartbeat; no
    // receipt, answer or report of TEST-GW-01's API.
    await craftDisp1(1);
    await heartbeat([online('TEST-BAL-00', 'SIM-0000'), online('TEST-BAL-01', 'SIM-0001')]);
    // tab.manual_weighing_scales reads, for each scale of the room in turn, what tab.scale_status shows (shownReason) and
    // then the verdict (why), each statement as committed when it runs (READ COMMITTED). It reads the bindings in their
    // physical order (a bitmap scan of those not ended): TEST-BAL-01's first, as TEST-BAL-00 was bound again in
    // beforeAll. The superuser holds tab.device_reading, which the shown status reads after the API report
    // (tab.chain_refusal_held), so the gate waits there for TEST-BAL-01 once it has read no report; the monitor's report
    // is committed meanwhile, then the table is let go. TEST-BAL-01 is then shown ONLINE (no shownReason) while its
    // verdict finds the report young (why YOUNG); TEST-BAL-00, read after, shows the report and finds it young.
    const lock = await rig.server.db.admin.connect();
    let settled = false;
    let weighing: Promise<string> | undefined;
    try {
      await lock.query('begin');
      await lock.query('lock table tab.device_reading in access exclusive mode');
      weighing = messageOf(forgedWeighingRow(rig, run)).finally(() => {
        settled = true;
      });
      await untilGateWaitsOn('tab.device_reading', () => settled);
      expect(await contact(false, 'test: no answer')).toBe(true);
    } finally {
      await lock.query('rollback');
      lock.release();
    }
    try {
      expect(await weighing).toMatch(/^Scale TEST-BAL-01 of room DISP-1 is online: the weight is captured from it, never keyed by hand \(DI-30, PR-20\)\. \[EBMR-EXE-074\]$/);
      // The same weighing now, the report standing for both scales and seen for less than 10 seconds: TEST-BAL-00 is
      // named, with the report that does not count yet.
      expect(await messageOf(forgedWeighingRow(rig, run))).toMatch(
        new RegExp(
          `^Scale TEST-BAL-00 of room DISP-1 is online by its heartbeat\\. The report that it cannot be used \\(${API_REASON.replace(/[()]/g, '\\$&')}\\) was made in this transaction, or had been seen by other transactions for less than 10 seconds when it began, so it does not open the manual path yet: capture the weight from the scale, or key it by hand once the report has stood for 10 seconds \\(DI-30, PR-20\\)\\. \\[EBMR-EXE-074\\]$`,
        ),
      );
      expect((await rowsOf(rig.server, run.runId)).length).toBe(before);
      expect((await basis()).length).toBe(basisBefore);
    } finally {
      await rig.server.db.admin.query('delete from tab.gateway_api_contact where gateway_key_id = $1', [key1]);
    }
  });

  it('[DI-30][DI-32][PR-20] the gate reads the entry of a RECORD_ENTRY command only: a start of the step the engine refused, whose command carries an `entry` member naming a weighing of another source, is never refused by the gate', async () => {
    const ctx = await runContext(rig.server.db.admin, run.runId);
    const operator = await actorOf(rig.server, run.browser('operator1'), 'operator1');
    const outcome = await messageOf(
      withCommand(rig.server.db.app, operator, async (c) => {
        const tx = await execution.ExecutionTx.open(c, ctx.def, run.runId);
        const roles = await engineRoles(c);
        const actor = engineActor(personaIn(rig.server, 'operator1').personId, roles);
        // Written past the server: the step is in progress, so the engine refuses its start (ENG-STEP-STATUS); the stray
        // member is stored with the command as it was given.
        const command = { type: 'START_STEP', commandId: randomUUID(), actor, step: 'p-disp-pcm', context: [], entry: { kind: 'CONTAINER_WEIGHING', source: 'SCAN', balance: 'MANUAL' } };
        const r = await tx.command(command as unknown as engine.Command, roles);
        expect(r.accepted).toBe(false);
      }),
    );
    // Where recipe-core 0335 holds every command to the members its type declares (its trigger zz_execution_row_shape,
    // checked once the row is written, after this gate), the stray member is refused there (EBMR-EXE-126); before it,
    // the row is recorded with the engine's refusal. Either way the gate (BEFORE INSERT) lets the row through.
    const rowShape = ((await rig.server.db.admin.query("select 1 from pg_catalog.pg_trigger where tgname = 'zz_execution_row_shape'")).rowCount ?? 0) > 0;
    if (rowShape) {
      expect(outcome).toMatch(/\[EBMR-EXE-126\]/);
      return;
    }
    expect(outcome).toBe('ok');
    const last = (await rowsOf(rig.server, run.runId)).at(-1);
    const row = await rig.server.db.admin.query<{ type: string; accepted: boolean; code: string; entry: Json }>(
      "select command_type as type, accepted, refusal ->> 'code' as code, command -> 'entry' as entry from recipe.execution_command where batch_id = $1 and seq = $2",
      [run.runId, last?.seq],
    );
    expect(row.rows).toEqual([{ type: 'START_STEP', accepted: false, code: 'ENG-STEP-STATUS', entry: { kind: 'CONTAINER_WEIGHING', source: 'SCAN', balance: 'MANUAL' } }]);
    expect(await violations(rig.server)).toEqual([]);
  });

  it('[DI-30][PR-20] a weighing of a room with no lock row yet adds the row and locks only its own room: a heartbeat of another room being written does not hold it up', async () => {
    // BLEND-1 has no bound scale (TEST-BAL-02's binding ended) and, here, no lock row yet.
    await rig.server.db.admin.query("delete from tab.scale_room_lock where room_code = 'BLEND-1'");
    // operator1 signs in on the BLEND-1 kiosk (the stage names no room); that ends the session on the DISP-1 kiosk,
    // which is opened again at the end.
    const blend = new RunDriver(rig.server, run.runId, { operator1: await rig.server.asPersona('operator1', 'TEST-KIOSK-BLEND-1') });
    try {
      const basisBefore = (await basis()).length;
      expect(await whileRoomHeld('DISP-1', () => forgedWeighing(rig, blend))).toBe('ok');
      expect((await rig.server.db.admin.query("select 1 from tab.scale_room_lock where room_code = 'BLEND-1'")).rowCount).toBe(1);
      expect((await basis()).slice(basisBefore)).toEqual([{ room: 'BLEND-1', scales: [] }]);
      expect(await violations(rig.server)).toEqual([]);
    } finally {
      run = new RunDriver(rig.server, run.runId, { operator1: await rig.server.asPersona('operator1') });
    }
  });
});
