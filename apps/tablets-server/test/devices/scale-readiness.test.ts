/**
 * Review finding P51, server side (round-1 verification; DI-30, DI-31, PR-20; tablets 0320).
 *
 * The server showed a scale ONLINE from the gateway's heartbeat alone. When the server could not reach the gateway's
 * API while the heartbeats still arrived, a capture answered "scale offline" and a hand-keyed weighing was refused
 * because the scale was online (EBMR-EXE-074): neither path could record the weighing, and the server kept no record
 * of why. The same held while the server refused a reading of the gateway's chain (every later reading queues behind
 * it). Now the database decides: the scale is OFFLINE, with the reason,
 *  - while the gateway's API is marked unreachable (a capture could not reach it), until a heartbeat's probe of the
 *    API is answered;
 *  - while the server has refused a reading of the gateway key's chain and has ingested none since, also after the
 *    gateway logs in again;
 *  - while the gateway says a connected scale is not ready (the reason is stored, each episode alarmed once).
 * The heartbeat's reconciliation by counts also takes what the gateway delivered when its watermark is behind. A
 * recovery that turns the scales ONLINE again waits for a hand-keyed weighing of their room being recorded, as a
 * heartbeat does (tablets 0310), so no scale turns ONLINE between that weighing's check and its commit.
 * Round 3 (tablets 0340): the server records what it observes of the API as its gateway API monitor identity (this
 * server holds it: its service-keys file has the monitor's entry), and a hand-keyed weighing beside a scale whose
 * heartbeat says ONLINE is accepted only once the API report (or the refusal) has stood for the heartbeat window.
 * Round 4 (tablets 0350): the window of the API report runs from when another transaction first saw it, the report
 * counts only while the API has not answered the server since it was made (the server records each answer on its
 * own, before the monitor's command), and the room locks are rows that only the database's own functions take.
 * Room DISP-1 holds TEST-BAL-01 (the enrolled gateway's scale) and TEST-BAL-00 (never reported).
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { identity, toDbContext, type ActorContext } from '@ebmr/kernel';
import { CaptureRequest, type CaptureResponse, type GatewayHealth } from '@ebmr/integration-sdk/scale';
import { scaleStatusRows } from '../../src/features/devices/port.ts';
import { fakeGateway } from './support.ts';
import { forgedWeighing, GATE_WINDOW_MS, handKeyed, monitorActor, newRun, reachPcm, recordContact, report, standFor, startRig, stopRig, type Rig } from './room-scales-support.ts';
import { outcomeOf, refusalOf, violations } from '../execution/support.ts';

let rig: Rig;
let api: Server;
/** 'down': the gateway API drops every connection (as a blocked port or a wrong address would). */
let apiMode: 'up' | 'down' = 'up';
const apiRequests: string[] = [];

async function startFakeApi(): Promise<string> {
  api = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      apiRequests.push(`${apiMode} ${req.method ?? ''} ${req.url ?? ''}`);
      if (apiMode === 'down') {
        req.socket.destroy();
        return;
      }
      if (req.headers.authorization !== `Bearer ${rig.gw.apiToken}`) {
        res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":{"code":"NOT_AUTHORISED","message":"no","relogin":false}}');
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/health') {
        const health: GatewayHealth = {
          gatewayCode: 'TEST-GW-01',
          loggedIn: true,
          chainId: rig.gw.login.chainId,
          journal: { lastSeq: '0', ackedSeq: '0' },
          devices: [{ deviceCode: 'TEST-BAL-01', state: 'ONLINE', serial: 'SIM-0001', notReady: null }],
        };
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(health));
        return;
      }
      const body = CaptureRequest.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const reading = rig.gw.next({ value: '12.503', raw: 'S S     12.503 kg', purpose: body.purpose });
      const up = await rig.gw.uplink([{ reading }]);
      const answer: CaptureResponse = { outcome: 'CAPTURED', reading, uplinked: up.body.refused === null };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
    })();
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
  const a = api.address();
  return `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
}

beforeAll(async () => {
  rig = await startRig({ EBMR_GATEWAY_URL: await startFakeApi() }, { monitor: true });
}, 180_000);

afterAll(async () => {
  await stopRig(rig);
  api?.closeAllConnections();
  await new Promise<void>((r) => api?.close(() => r()));
});

/** TEST-BAL-01 as tab.scale_status answers now: status and reason. */
async function bal01(): Promise<{ status: string; reason: string | null }> {
  const s = (await scaleStatusRows(rig.server.built.ctx, 'DISP-1')).find((x) => x.deviceCode === 'TEST-BAL-01');
  if (!s) throw new Error('TEST-BAL-01 is not a scale of DISP-1');
  return { status: s.status, reason: s.reason };
}

async function alarms(code: string): Promise<number> {
  const { rows } = await rig.server.db.admin.query<{ n: number }>('select count(*)::int as n from tab.device_alarm where code = $1', [code]);
  return rows[0]?.n ?? 0;
}

/** Polls `check` every 50 ms until it holds, at most `tries` times (no clock: the rig fakes `performance`). */
async function eventually(check: () => Promise<boolean>, tries = 160): Promise<boolean> {
  for (let i = 0; i < tries; i += 1) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/** Whether a statement starting with `statement` waits on a lock (a room's row of tab.scale_room_lock, tablets 0350), until `stop`. */
async function waitsOnRoomLock(statement: string, stop: () => boolean): Promise<boolean> {
  for (let i = 0; i < 300 && !stop(); i += 1) {
    const { rows } = await rig.server.db.admin.query<{ n: number }>(
      "select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like $1",
      [`${statement}%`],
    );
    if ((rows[0]?.n ?? 0) > 0) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

async function capture(d: Awaited<ReturnType<typeof newRun>>) {
  return d.browser('operator1').call(routes.devices.capture, { params: { code: 'TEST-BAL-01' }, body: { purpose: 'GROSS' } });
}

describe('review P51, server side: a scale is ONLINE only while a capture on it can reach the server (tablets 0320)', () => {
  it('[DI-31] the reconciliation by counts takes what the gateway delivered when its written watermark is behind (deliveredSeq)', async () => {
    const head = Number(rig.gw.login.head.seq);
    const before = await alarms('EBMR-DEV-070');
    // The gateway's watermark could not be written (ackedSeq stays at the head), but the server acknowledged two more
    // readings than it now holds (e.g. restored from a backup).
    const r = await rig.gw.post('/gw/v1/heartbeat', {
      gatewayTimeUs: '1790584618000000',
      devices: [{ deviceCode: 'TEST-BAL-01', state: 'OFFLINE', serial: null, notReady: null }],
      journal: { lastSeq: String(head + 2), ackedSeq: String(head), deliveredSeq: String(head + 2) },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await alarms('EBMR-DEV-070')).toBe(before + 1);
    const { rows } = await rig.server.db.admin.query<{ message: string }>("select message from tab.device_alarm where code = 'EBMR-DEV-070' order by id desc limit 1");
    expect(rows[0]?.message).toContain(`counts ${head + 2} readings the server acknowledged`);
  });

  it('[DI-30][PR-20][DI-31] while the server cannot reach the gateway API, the database shows the scale OFFLINE: the capture is refused, hand-keyed weights are accepted once that has stood for the heartbeat window, and a heartbeat\'s probe brings it back ONLINE once the API answers', async () => {
    const d = await newRun(rig);
    await reachPcm(d);
    await report(rig, { 'TEST-BAL-01': 'ONLINE' });
    expect(await bal01()).toEqual({ status: 'ONLINE', reason: null });

    // The gateway's API cannot be reached; its heartbeats still arrive and say ONLINE.
    apiMode = 'down';
    const refused = await capture(d);
    expect(outcomeOf(refused)).toBe('503:SCALE_OFFLINE');
    expect(refusalOf(refused).why).toMatch(/could not be reached/);
    await report(rig, { 'TEST-BAL-01': 'ONLINE' });
    const off = await bal01();
    expect(off.status).toBe('OFFLINE');
    expect(off.reason).toMatch(/cannot reach the site gateway's API/);
    expect(await rig.server.built.ctx.deviceReadings.scaleStatus('DISP-1')).toBeNull();
    expect(await alarms('EBMR-DEV-071')).toBe(1);
    // DI-14 (tablets 0340): the server recorded it as its gateway API monitor, in a session of that identity.
    const author = await rig.server.db.admin.query<{ login_name: string; role: string }>(
      `select acc.login_name, e.payload -> 'actor' ->> 'role_code' as role
         from tab.device_alarm a join iam.session s on s.id = a.session_id join iam.account acc on acc.id = s.account_id
         join kernel.audit_event e on e.chain_key = 'gateway_key:' || $1 and e.action = 'BUSINESS' and e.payload -> 'actor' ->> 'session_id' = a.session_id::text
        where a.code = 'EBMR-DEV-071'`,
      [rig.gw.login.chainId],
    );
    expect(author.rows).toEqual([{ login_name: 'test-gw-monitor', role: 'GATEWAY_API_MONITOR' }]);

    // A weight keyed by hand at once is refused: the report has not yet stood for the heartbeat window (tablets 0340).
    const early = await d.command('operator1', handKeyed);
    expect(outcomeOf(early)).toBe('422:EBMR-EXE-074');
    expect(refusalOf(early).why).toMatch(/had been seen by other transactions for less than 10 seconds when it began/);
    // Once it has (the heartbeats still arrive and say ONLINE, and each probe still finds the API down), the manual
    // two-person path is open: the hand-keyed weighing is recorded (before 0320: EBMR-EXE-074, the scale was shown
    // online, and the capture was refused too).
    await standFor(rig, 10_500, { 'TEST-BAL-01': 'ONLINE' });
    expect((await bal01()).status).toBe('OFFLINE');
    const keyed = await d.command('operator1', handKeyed);
    expect(outcomeOf(keyed)).toBe('ok');

    // A heartbeat while the API is still down has the server probe it: still unreachable, still OFFLINE, no new alarm.
    const probesBefore = apiRequests.filter((x) => x.endsWith('GET /v1/health')).length;
    const hb = await rig.gw.heartbeat([{ deviceCode: 'TEST-BAL-01', state: 'ONLINE', serial: 'SIM-0001' }]);
    expect(hb.status).toBe(200);
    // The answer is only what the gateway's contract allows (the probe request stays on the server).
    expect(Object.keys(hb.body as object).sort()).toEqual(['head', 'serverTimeUs']);
    expect(await eventually(() => Promise.resolve(apiRequests.filter((x) => x.endsWith('GET /v1/health')).length > probesBefore))).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect((await bal01()).status).toBe('OFFLINE');
    expect(await alarms('EBMR-DEV-071')).toBe(1);

    // The API answers again: the next heartbeat's probe marks it reachable, and the scale is ONLINE again.
    apiMode = 'up';
    await report(rig, { 'TEST-BAL-01': 'ONLINE' });
    expect(await eventually(async () => (await bal01()).status === 'ONLINE')).toBe(true);
    expect(await alarms('EBMR-DEV-072')).toBe(1);
    const captured = await capture(d);
    expect(outcomeOf(captured)).toBe('ok');
    // And hand-keyed weights are refused again beside the online scale.
    expect(outcomeOf(await d.command('operator1', handKeyed))).toBe('422:EBMR-EXE-074');
  });

  it('[DI-30][PR-20][DI-31] a reading of the gateway\'s chain refused by the server shows its scales OFFLINE until one is ingested, also after the gateway logs in again', async () => {
    await report(rig, { 'TEST-BAL-01': 'ONLINE' });
    expect(await bal01()).toEqual({ status: 'ONLINE', reason: null });
    // A reading the server refuses (not the registered serial): every later reading of the chain queues behind it.
    const bad = await rig.gw.uplink([{ reading: rig.gw.next({ serial: 'SIM-9999' }) }]);
    expect(bad.body.refused?.code).toBe('EBMR-DEV-048');
    await report(rig, { 'TEST-BAL-01': 'ONLINE' });
    const off = await bal01();
    expect(off.status).toBe('OFFLINE');
    expect(off.reason).toMatch(/refused a reading of gateway TEST-GW-01 \(EBMR-DEV-048\)/);

    // The gateway logs in again (a new session of the same key): still OFFLINE, nothing was ingested since.
    await rig.gw.close();
    rig.gw = await fakeGateway(rig.server);
    await report(rig, { 'TEST-BAL-01': 'ONLINE' });
    expect((await bal01()).status).toBe('OFFLINE');

    // A reading is ingested again: the chain moves, the scale is ONLINE.
    const good = await rig.gw.uplink([{ reading: rig.gw.next() }]);
    expect(good.body.refused).toBeNull();
    await report(rig, { 'TEST-BAL-01': 'ONLINE' });
    expect(await bal01()).toEqual({ status: 'ONLINE', reason: null });
  });

  it('[DI-30][DI-31][PR-20] the server stores why the gateway says a connected scale is not ready, alarms each episode once, and never shows it ONLINE meanwhile', async () => {
    const notReady = (reason: string | null, state = 'OFFLINE') =>
      rig.gw.post('/gw/v1/heartbeat', {
        gatewayTimeUs: '1790584618000000',
        devices: [{ deviceCode: 'TEST-BAL-01', state, serial: 'SIM-0001', notReady: reason }],
        journal: { lastSeq: rig.gw.login.head.seq, ackedSeq: '0' },
      });
    const before = await alarms('EBMR-DEV-073');
    expect((await notReady("the gateway's journal could not be written (ENOSPC)")).status).toBe(200);
    expect(await bal01()).toEqual({ status: 'OFFLINE', reason: "the site gateway cannot capture from it and deliver: the gateway's journal could not be written (ENOSPC)" });
    const stored = await rig.server.db.admin.query<{ not_ready: string | null; state: string }>(
      "select h.not_ready, h.state from tab.instrument_heartbeat h join iam.device d on d.id = h.instrument_device_id where d.code = 'TEST-BAL-01'",
    );
    expect(stored.rows).toEqual([{ not_ready: "the gateway's journal could not be written (ENOSPC)", state: 'OFFLINE' }]);
    // A state ONLINE that names a reason counts as not ready.
    expect((await notReady('readings journalled before the gateway logged in are not delivered yet', 'ONLINE')).status).toBe(200);
    expect((await bal01()).status).toBe('OFFLINE');
    // One alarm for the episode, however many heartbeats repeat it.
    expect(await alarms('EBMR-DEV-073')).toBe(before + 1);
    // Ready again, then a new episode: a second alarm.
    await report(rig, { 'TEST-BAL-01': 'ONLINE' });
    expect(await bal01()).toEqual({ status: 'ONLINE', reason: null });
    expect((await notReady('the last upload to the server failed')).status).toBe(200);
    expect(await alarms('EBMR-DEV-073')).toBe(before + 2);
    await report(rig, { 'TEST-BAL-01': 'ONLINE' });
  });
  it('[PR-20][DI-30][DI-31] a recovery that turns the scales ONLINE (the API answers again, a reading is ingested after a refusal) waits for a hand-keyed weighing of their room being recorded', async () => {
    const d = await newRun(rig);
    await reachPcm(d);
    await report(rig, { 'TEST-BAL-01': 'ONLINE' });
    const monitor = await monitorActor(rig);

    // The API is marked unreachable (by the monitor) and stays so for the heartbeat window: the heartbeats keep saying
    // ONLINE, and the server's probes find the API down. A hand-keyed weighing is written (its check passed: no scale
    // counts as online), and before it commits the API is found reachable again.
    apiMode = 'down';
    expect(await recordContact(rig, false, 'test: the API does not answer', monitor)).toBe(true);
    expect((await bal01()).status).toBe('OFFLINE');
    const probes = () => apiRequests.filter((x) => x.endsWith('GET /v1/health')).length;
    const probesBefore = probes();
    await standFor(rig, 10_500, { 'TEST-BAL-01': 'ONLINE' });
    // The probe of the last heartbeat has finished before the monitor's recovery below (it would record the API down).
    expect(await eventually(() => Promise.resolve(probes() > probesBefore))).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    apiMode = 'up';
    expect((await bal01()).status).toBe('OFFLINE');
    let recovered: Promise<unknown> | undefined;
    let recoveredDone = false;
    const api = { waited: false, doneBeforeCommit: true };
    const first = await forgedWeighing(rig, d, {
      during: async () => {
        recovered = recordContact(rig, true, 'test: the API answers', monitor);
        recovered.then(
          () => (recoveredDone = true),
          () => (recoveredDone = true),
        );
        api.waited = await waitsOnRoomLock('select tab.record_gateway_api_contact', () => recoveredDone);
        api.doneBeforeCommit = recoveredDone;
      },
    });
    await recovered;
    expect({ weighing: first, ...api }).toEqual({ weighing: 'ok', waited: true, doneBeforeCommit: false });
    expect((await bal01()).status).toBe('ONLINE');

    // A reading of the chain is refused; the gateway logs in again. A hand-keyed weighing is written, and before it
    // commits a reading of the chain is ingested (which ends the refusal's hold).
    expect((await rig.gw.uplink([{ reading: rig.gw.next({ serial: 'SIM-9999' }) }])).body.refused?.code).toBe('EBMR-DEV-048');
    await rig.gw.close();
    rig.gw = await fakeGateway(rig.server);
    await report(rig, { 'TEST-BAL-01': 'ONLINE' });
    expect((await bal01()).status).toBe('OFFLINE');
    // The refusal stands for the heartbeat window before a weight may be keyed by hand beside the scale (tablets 0340).
    await standFor(rig, 10_500, { 'TEST-BAL-01': 'ONLINE' });
    let upload: Promise<unknown> | undefined;
    let uploadDone = false;
    const ingest = { waited: false, doneBeforeCommit: true };
    const second = await forgedWeighing(rig, d, {
      during: async () => {
        upload = rig.gw.uplink([{ reading: rig.gw.next() }]);
        upload.then(
          () => (uploadDone = true),
          () => (uploadDone = true),
        );
        ingest.waited = await waitsOnRoomLock('select tab.ingest_reading', () => uploadDone);
        ingest.doneBeforeCommit = uploadDone;
      },
    });
    const uploaded = (await upload) as Awaited<ReturnType<Rig['gw']['uplink']>>;
    expect({ weighing: second, ...ingest, refused: uploaded.body.refused }).toEqual({ weighing: 'ok', waited: true, doneBeforeCommit: false, refused: null });
    await report(rig, { 'TEST-BAL-01': 'ONLINE' });
    expect((await bal01()).status).toBe('ONLINE');
    expect(await violations(rig.server)).toEqual([]);
  }, 120_000);

  it('[PR-20][DI-30][DI-31] review P50, round 4: once the API answers the server\'s probes again, the report that it could not be reached no longer opens the manual path, even while a holder of the application role\'s credentials holds up the monitor\'s report that it is reachable; a probe never waits for the monitor, so the next heartbeat probes again (tablets 0350)', async () => {
    const d = await newRun(rig);
    await reachPcm(d);
    apiMode = 'up';
    await report(rig, { 'TEST-BAL-01': 'ONLINE' });
    expect(await bal01()).toEqual({ status: 'ONLINE', reason: null });
    // A capture cannot reach the API: the server's monitor records it, in its own live session. The next heartbeat sees
    // the report committed, and its probe finds the API still down.
    apiMode = 'down';
    expect(outcomeOf(await capture(d))).toBe('503:SCALE_OFFLINE');
    expect((await bal01()).reason).toMatch(/cannot reach the site gateway's API/);
    const probes = () => apiRequests.filter((x) => x.endsWith('GET /v1/health')).length;
    const probesBefore = probes();
    await report(rig, { 'TEST-BAL-01': 'ONLINE' });
    expect(await eventually(() => Promise.resolve(probes() > probesBefore))).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    const seen = await rig.server.db.admin.query<{ seen: boolean }>('select seen_at is not null as seen from tab.gateway_api_contact');
    expect(seen.rows).toEqual([{ seen: true }]);
    // The API answers again. In a command of the monitor's own live session (read from tab.device_alarm and
    // iam.session), the application role holds the report's row, so the monitor cannot record the API reachable.
    apiMode = 'up';
    const holder = await rig.server.db.app.connect();
    try {
      await holder.query('begin');
      await holder.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(await liveMonitorActor()))]);
      await holder.query("select tab.record_gateway_api_contact('TEST-GW-01', false, 'test: held by the application role')");
      const answersBefore = await answers();
      // The gateway reports ONLINE; each heartbeat has the server probe the API, which answers.
      await standFor(rig, 19_500, { 'TEST-BAL-01': 'ONLINE' });
      expect(await answers()).toBeGreaterThanOrEqual(answersBefore + 2);
      // The server's monitor commands wait one at a time (the latest observation queued), never one per probe.
      const waiting = await rig.server.db.admin.query<{ n: number }>(
        "select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and (query like 'select kernel.begin_command%' or query like 'select tab.record_gateway_api_contact%')",
      );
      expect(waiting.rows[0]?.n).toBe(1);
      expect((await bal01()).status).toBe('OFFLINE');
      const keyed = await d.command('operator1', handKeyed);
      expect(outcomeOf(keyed)).toBe('422:EBMR-EXE-074');
      expect(refusalOf(keyed).why).toMatch(/^Scale TEST-BAL-01 of room DISP-1 is online by its heartbeat\. The report that it cannot be used \(.+\) is answered: the gateway's API answered the server after that report was made/);
    } finally {
      await holder.query('rollback').catch(() => undefined);
      holder.release();
    }
    // Released, the monitor records the answer: ONLINE again.
    await report(rig, { 'TEST-BAL-01': 'ONLINE' });
    expect(await eventually(async () => (await bal01()).status === 'ONLINE')).toBe(true);
    expect(await violations(rig.server)).toEqual([]);
  }, 120_000);

  it('[PR-20][DI-30][DI-31] review P50, follow-up round 4: while the answers of the gateway\'s API to the server\'s probes cannot be recorded (a superuser\'s lock on tab.gateway_api_answer holds each past the receipts pool\'s 2 s limit) and the monitor\'s report that the API is reachable is held up, the report that it could not be reached never opens the manual path beside the scale whose heartbeats say ONLINE: each answer lost leaves its tick unclean, and the database vouches for no window (tablets 0350 item 6)', async () => {
    const d = await newRun(rig);
    await reachPcm(d);
    apiMode = 'up';
    await report(rig, { 'TEST-BAL-01': 'ONLINE' });
    expect(await bal01()).toEqual({ status: 'ONLINE', reason: null });
    // A capture cannot reach the API: the monitor reports it; the next heartbeat sees the report, and its probe finds
    // the API still down.
    apiMode = 'down';
    expect(outcomeOf(await capture(d))).toBe('503:SCALE_OFFLINE');
    const probes = () => apiRequests.filter((x) => x === 'up GET /v1/health').length;
    const downProbes = () => apiRequests.filter((x) => x === 'down GET /v1/health').length;
    const downBefore = downProbes();
    await report(rig, { 'TEST-BAL-01': 'ONLINE' });
    expect(await eventually(() => Promise.resolve(downProbes() > downBefore))).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    expect((await rig.server.db.admin.query<{ seen: boolean }>('select seen_at is not null as seen from tab.gateway_api_contact')).rows).toEqual([{ seen: true }]);
    // The API answers again, but no answer can be recorded (inserts wait past the statement's limit; reads do not), and
    // the application role holds the report's row in a command of the monitor's live session.
    apiMode = 'up';
    const lock = await rig.server.db.admin.connect();
    const holder = await rig.server.db.app.connect();
    const samples: { status: string; why: string | null }[] = [];
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        const { rows } = await rig.server.db.admin.query<{ status: string; why: string | null }>(
          "select x ->> 'status' as status, x ->> 'why' as why from jsonb_array_elements(tab.manual_weighing_scales('DISP-1')) x where x ->> 'deviceCode' = 'TEST-BAL-01'",
        );
        samples.push(rows[0] ?? { status: 'MISSING', why: null });
        await new Promise((r) => setTimeout(r, 250));
      }
    })();
    try {
      await lock.query('begin');
      await lock.query('lock table tab.gateway_api_answer in exclusive mode');
      await holder.query('begin');
      await holder.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(await liveMonitorActor()))]);
      await holder.query("select tab.record_gateway_api_contact('TEST-GW-01', false, 'test: held by the application role')");
      const answersBefore = await answers();
      const probesBefore = probes();
      // Longer than the heartbeat window and the listener's vouching lag together: before tablets 0350 item 6 the report,
      // seen and unanswered on record, counted here.
      await standFor(rig, GATE_WINDOW_MS + 2000, { 'TEST-BAL-01': 'ONLINE' });
      expect(probes()).toBeGreaterThanOrEqual(probesBefore + 3);
      expect(await answers()).toBe(answersBefore);
      expect((await bal01()).reason).toMatch(/cannot reach the site gateway's API/);
      const keyed = await d.command('operator1', handKeyed);
      expect(outcomeOf(keyed)).toBe('422:EBMR-EXE-074');
      expect(refusalOf(keyed).why).toMatch(/^Scale TEST-BAL-0[01] of room DISP-1 is shown offline \(.+\), but the gateway listener has not put on record that everything it received in the 10 seconds before this weighing began is recorded/);
    } finally {
      sampling = false;
      await sampler;
      await lock.query('rollback').catch(() => undefined);
      lock.release();
      await holder.query('rollback').catch(() => undefined);
      holder.release();
    }
    expect(samples.length).toBeGreaterThan(40);
    expect(samples.filter((x) => x.status !== 'ONLINE')).toEqual([]);
    expect(samples.at(-1)).toEqual({ status: 'ONLINE', why: 'UNATTESTED' });
    // Released, the next probe's answer is recorded and the monitor records the API reachable: ONLINE again.
    await report(rig, { 'TEST-BAL-01': 'ONLINE' });
    expect(await eventually(async () => (await bal01()).status === 'ONLINE')).toBe(true);
  }, 120_000);

  it('[DI-30][PR-20][DI-31] review P50, round 4: a heartbeat held up in its command still has the server probe the gateway\'s API (the heartbeat as received asks for it), so an API that answers again is recorded reachable', async () => {
    apiMode = 'up';
    await report(rig, { 'TEST-BAL-01': 'ONLINE' });
    expect(await bal01()).toEqual({ status: 'ONLINE', reason: null });
    const monitor = await monitorActor(rig);
    expect(await recordContact(rig, false, 'test: the API did not answer', monitor)).toBe(true);
    expect((await bal01()).status).toBe('OFFLINE');
    const holder = await rig.server.db.app.connect();
    try {
      // The live gateway session is held in a command of the application role: the heartbeat's own command waits (it
      // ends after 4 s, in the background), the heartbeat is answered 503 when its 3 s are up (decision X29), but it
      // was received first and the server probes the API.
      await holder.query('begin');
      await holder.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(await stolenGatewayActor()))]);
      const answersBefore = await answers();
      const hb = await rig.gw.heartbeat([{ deviceCode: 'TEST-BAL-01', state: 'ONLINE', serial: 'SIM-0001' }]);
      expect(hb).toMatchObject({ status: 503, body: { error: { code: 'HEARTBEAT_PENDING', relogin: false } } });
      expect(await eventually(async () => (await answers()) > answersBefore)).toBe(true);
      expect(
        await eventually(async () => (await rig.server.db.admin.query<{ reachable: boolean }>('select reachable from tab.gateway_api_contact')).rows[0]?.reachable === true),
      ).toBe(true);
    } finally {
      await holder.query('rollback').catch(() => undefined);
      holder.release();
    }
    await report(rig, { 'TEST-BAL-01': 'ONLINE' });
    expect(await bal01()).toEqual({ status: 'ONLINE', reason: null });
    await identity.endSession(rig.server.db.app, monitor.sessionId);
  }, 120_000);
});

/** The answers of the gateway's API the server recorded (tab.gateway_api_answer, tablets 0350). */
async function answers(): Promise<number> {
  return (await rig.server.db.admin.query<{ n: number }>('select count(*)::int as n from tab.gateway_api_answer')).rows[0]?.n ?? 0;
}

/** The actor of the live gateway session, as a holder of the application role's credentials reads it (iam.session). */
async function stolenGatewayActor(): Promise<ActorContext> {
  const { rows } = await rig.server.db.app.query<{ id: string; person_id: string; account_id: string; device_id: string; legal_name: string }>(
    `select s.id, s.person_id, s.account_id, s.device_id, p.legal_name
       from iam.session s join iam.device d on d.id = s.device_id join iam.person p on p.id = s.person_id
      where d.code = 'TEST-GW-01' and s.ended_at is null order by s.opened_at desc limit 1`,
  );
  const s = rows[0];
  if (!s) throw new Error('SETUP: no live gateway session');
  return { personId: s.person_id, accountId: s.account_id, roleCode: 'SITE_GATEWAY', sessionId: s.id, deviceId: s.device_id, source: 'INTEGRATION', siteZone: rig.server.config.siteZone, legalName: s.legal_name, correlationId: randomUUID() };
}

/**
 * The actor of the session the server's own gateway API monitor records in (the session of its latest EBMR-DEV-071
 * alarm), as the application role can read it (tab.device_alarm, iam.session).
 */
async function liveMonitorActor(): Promise<ActorContext> {
  const { rows } = await rig.server.db.app.query<{ id: string; person_id: string; account_id: string; device_id: string; legal_name: string }>(
    `select s.id, s.person_id, s.account_id, s.device_id, p.legal_name
       from iam.session s join iam.person p on p.id = s.person_id
      where s.ended_at is null
        and s.id = (select a.session_id from tab.device_alarm a where a.code = 'EBMR-DEV-071' order by a.id desc limit 1)`,
  );
  const s = rows[0];
  if (!s) throw new Error('SETUP: the server has no live monitor session');
  return { personId: s.person_id, accountId: s.account_id, roleCode: 'GATEWAY_API_MONITOR', sessionId: s.id, deviceId: s.device_id, source: 'SYSTEM', siteZone: rig.server.config.siteZone, legalName: s.legal_name, correlationId: randomUUID() };
}
