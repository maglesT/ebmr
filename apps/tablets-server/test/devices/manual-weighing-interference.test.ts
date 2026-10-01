/**
 * Review finding P50, round-4 verification (tablets 0350, kernel 0970; controls DI-17, DI-18, DI-30, DI-31, DI-32,
 * PR-20): a holder of the application role's database credentials cannot make a working scale count as unusable, and
 * so open the manual two-person path beside it, by any of the levers below. A receipt or an answer of the gateway's
 * API that a database too loaded (or short of connections) cannot take in time is lost; since follow-up round 4 the
 * listener's ticks say so and the gate refuses instead of counting the scale silent (tablets 0350 item 6, kernel 0980;
 * decisions X36-X39; the describe "follow-up round 4" below, listener-watch.test.ts; the losses of answers and of idle
 * connections are also logged: report-pools-log.test.ts).
 *
 * The verifier's probes against tablets 0340, each ported here: one application-role connection held the room's
 * advisory lock ('tab.scale_room:DISP-1') and a second cancelled the gateway listener's heartbeats queued behind it, so
 * the scale read OFFLINE for want of heartbeats and a weight keyed by hand through the honest server was accepted (E4);
 * the same inside a forged weighing's own transaction (E3); a heartbeat saying OFFLINE committed under the live gateway
 * session's actor while the gateway reported ONLINE (X12); a report that the API cannot be reached held uncommitted for
 * the heartbeat window and counted as soon as it was committed (X11). Also: heartbeats held up in their command (the
 * live gateway session's row held), the gateway session ended, an upload held up so that the gateway says its scale
 * is not ready, every connection of the server's application pool taken, a report the API answers while the
 * monitor's reachable report is held up, a weighing reading an old snapshot, a database that lets the application role
 * signal backends again, and a heartbeat being written while the gate runs. Each case expects EBMR-EXE-074 with no
 * execution row and no basis row (or the heartbeats received and recorded). Also: receipts and answers are pruned after
 * an hour, and every tablets writer of GMP data refuses administrators (the surviving mutant p50_noadmin).
 *
 * Room DISP-1 holds TEST-BAL-01 (the enrolled gateway's scale) and TEST-BAL-00 (never ONLINE here).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { identity, toDbContext, type ActorContext } from '@ebmr/kernel';
import type { LoginResponse } from '@ebmr/integration-sdk/scale';
import { scaleStatusRows } from '../../src/features/devices/port.ts';
import { HEARTBEAT_ANSWER_MS, REPORTS_POOL_MAX, runtimeOf, UNVERIFIED_RECEIPTS_AT_ONCE } from '../../src/features/devices/runtime.ts';
import { withActorCommand } from '../../src/platform/db/commands.ts';
import { fakeGateway, loginAt } from './support.ts';
import {
  devicesOf,
  forgedWeighing,
  forgedWeighingRow,
  GATE_WINDOW_MS,
  handKeyed,
  monitorActor,
  newRun,
  reachPcm,
  RECORD_CONTACT_SQL,
  recordContact,
  report,
  standFor,
  startRig,
  statuses,
  stopRig,
  type Rig,
} from './room-scales-support.ts';
import { messageOf } from '../execution/db-guards-support.ts';
import { outcomeOf, refusalOf, rowsOf, violations, type RunDriver } from '../execution/support.ts';

let rig: Rig;

beforeAll(async () => {
  rig = await startRig();
}, 180_000);

afterAll(async () => {
  await stopRig(rig);
});

type States = Readonly<Record<string, 'ONLINE' | 'OFFLINE'>>;
const BESIDE: States = { 'TEST-BAL-00': 'OFFLINE', 'TEST-BAL-01': 'ONLINE' };
const BOTH_OFFLINE: States = { 'TEST-BAL-00': 'OFFLINE', 'TEST-BAL-01': 'OFFLINE' };
/** The advisory lock tablets 0310-0340 took for room DISP-1. */
const OLD_ROOM_LOCK = "hashtextextended('tab.scale_room:DISP-1', 0)";

// One run at the paracetamol weighing for the whole file (each run costs the kiosk some twenty device nonces).
let run: RunDriver | undefined;
async function pcmRun(): Promise<RunDriver> {
  if (!run) {
    run = await newRun(rig);
    await reachPcm(run);
  }
  return run;
}

afterEach(async () => {
  // Whatever a failed case left behind: the API reachable again, the gateway reporting as the next case expects.
  await recordContact(rig, true, 'test: clean-up');
  await report(rig, BESIDE);
});

/** The run's execution rows and the gate's basis rows, counted. */
async function counts(runId: string): Promise<{ rows: number; basis: number }> {
  const { rows } = await rig.server.db.admin.query<{ n: number }>('select count(*)::int as n from tab.manual_weighing_basis where batch_id = $1', [runId]);
  return { rows: (await rowsOf(rig.server, runId)).length, basis: rows[0]?.n ?? 0 };
}

type Device = { deviceCode: string; state: string; serial: string | null; notReady?: string | null };

/** One heartbeat of the gateway naming `devices`, as its uplink sends it; the HTTP status. */
async function heartbeatOf(devices: Device[]): Promise<number> {
  return (await rig.gw.post('/gw/v1/heartbeat', { gatewayTimeUs: '1790584618000000', devices, journal: { lastSeq: '0', ackedSeq: '0' } })).status;
}

/**
 * The site gateway's heartbeats as it sends them: one at a time, the next 3 s after the last began (at once when that
 * one took longer), each naming `devices`, until stop(); the HTTP status of each.
 */
function gatewayBeats(devices: Device[]): { stop(): Promise<number[]> } {
  let stopped = false;
  const answered: number[] = [];
  const loop = (async () => {
    while (!stopped) {
      const started = Date.now();
      answered.push(await heartbeatOf(devices));
      while (!stopped && Date.now() - started < 3000) await sleep(50);
    }
  })();
  return {
    async stop() {
      stopped = true;
      await loop;
      return answered;
    },
  };
}

/**
 * What a holder of the application role's credentials alone can build (as reading-proof.test.ts does): the actor of
 * the live gateway session, read through the application pool.
 */
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

/** One heartbeat as the gateway's uplink sent it: when (ms), how long until its answer (ms), and the answer. */
interface Beat {
  sentAt: number;
  ms: number;
  status: number;
  code: string | null;
}

/**
 * The site gateway's heartbeats with the real uplink's timing and login handling (apps/site-gateway/src/uplink.ts:
 * start, heartbeatNow, heartbeat, post, ensureLogin, logIn, readinessChanged), each naming `devices`, sent with the fake
 * gateway's token: an interval of `heartbeatMs` (5000, the gateway's default and its longest), one heartbeat at a time
 * (a tick while one is out sends the next as soon as that one is answered), each POST given up after 15 s. An answer
 * that says to log in again drops the token and starts a login (one at a time, loginAt); until a login succeeds the
 * heartbeats go on with the last login's token, unless a login was refused; once logged in, a heartbeat goes out at
 * once (at least 500 ms after the last one). stop() ends the interval and waits for the heartbeat and login in flight.
 */
function uplinkHeartbeats(devices: Device[], heartbeatMs = 5000): { stop(): Promise<Beat[]>; token(): string | null } {
  const beats: Beat[] = [];
  let token: string | null = rig.gw.token;
  let lastToken: string | null = rig.gw.token;
  let stopped = false;
  let running: Promise<void> | null = null;
  let again = false;
  let loggingIn: Promise<boolean> | null = null;
  let lastSentAt = Number.NEGATIVE_INFINITY;
  const readinessChanged = (): void => {
    setTimeout(() => void (stopped ? undefined : heartbeatNow()), Math.max(0, lastSentAt + 500 - Date.now()));
  };
  const ensureLogin = (): Promise<boolean> => {
    if (token) return Promise.resolve(true);
    loggingIn ??= (async () => {
      try {
        const r = await loginAt(rig.gw.base, rig.server);
        if (r.status !== 200) {
          lastToken = null;
          return false;
        }
        token = (r.body as LoginResponse).token;
        lastToken = token;
        if (!stopped) readinessChanged();
        return true;
      } catch {
        return false; // no answer: the heartbeats go on with the last token
      } finally {
        loggingIn = null;
      }
    })();
    return loggingIn;
  };
  const heartbeat = async (): Promise<void> => {
    const login = ensureLogin();
    if (token === null && lastToken === null && !(await login)) return;
    const used = token ?? lastToken;
    if (used === null) return;
    const sentAt = Date.now();
    const beat: Beat = { sentAt, ms: 0, status: 0, code: null };
    let relogin = false;
    try {
      const res = await fetch(`${rig.gw.base}/gw/v1/heartbeat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${used}` },
        body: JSON.stringify({ gatewayTimeUs: '1790584618000000', devices, journal: { lastSeq: '0', ackedSeq: '0', deliveredSeq: '0' } }),
        signal: AbortSignal.timeout(15_000),
      });
      beat.status = res.status;
      const text = await res.text();
      const body = (text ? JSON.parse(text) : null) as { error?: { code: string; relogin: boolean } } | null;
      beat.code = body?.error?.code ?? null;
      relogin = body?.error?.relogin === true;
    } catch {
      beat.status = 0; // not answered within 15 s, or the listener unreachable
    }
    beat.ms = Date.now() - sentAt;
    beats.push(beat);
    if (relogin && token === used) {
      token = null;
      void ensureLogin();
    }
  };
  const heartbeatNow = (): Promise<void> => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          lastSentAt = Date.now();
          await heartbeat();
        } while (again && !stopped);
      } finally {
        running = null;
      }
    })();
    return running;
  };
  const timer = setInterval(() => void heartbeatNow(), heartbeatMs);
  return {
    token: () => token,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
      await loggingIn;
      return beats;
    },
  };
}

/** The database's clock in epoch milliseconds. */
async function dbMs(): Promise<number> {
  return Number((await rig.server.db.admin.query<{ ms: string }>('select (extract(epoch from clock_timestamp()) * 1000)::text as ms')).rows[0]?.ms);
}

/**
 * The gaps (ms) between the heartbeats of TEST-GW-01 the listener received from `from` to `to` (dbMs), counted from
 * the last one received before `from` and up to `to`: what the gate's 10 s window sees.
 */
async function receiptGaps(from: number, to: number): Promise<number[]> {
  const { rows } = await rig.server.db.admin.query<{ ms: string }>(
    `select (extract(epoch from received_at) * 1000)::text as ms from tab.heartbeat_receipt
      where gateway_key_id = $1 and received_at between to_timestamp($2::float8 / 1000) - interval '15 seconds' and to_timestamp($3::float8 / 1000)
      order by received_at`,
    [rig.gw.login.chainId, from, to],
  );
  const times = rows.map((r) => Number(r.ms));
  const last = times.filter((t) => t <= from).at(-1);
  expect(last, 'a heartbeat received before the case').toBeDefined();
  const points = [last ?? from, ...times.filter((t) => t > from), to];
  return points.slice(1).map((t, i) => Math.round(t - (points[i] ?? t)));
}

/**
 * How the gate would count TEST-BAL-01 for a weight keyed by hand now (tab.manual_weighing_scales, read by the owner),
 * every 250 ms until stop(): status (ONLINE: not counted unusable) and why a reason shown does not count.
 */
function gateSampler(): { stop(): Promise<{ status: string; why: string | null }[]> } {
  const samples: { status: string; why: string | null }[] = [];
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const { rows } = await rig.server.db.admin.query<{ status: string; why: string | null }>(
        "select x ->> 'status' as status, x ->> 'why' as why from jsonb_array_elements(tab.manual_weighing_scales('DISP-1')) x where x ->> 'deviceCode' = 'TEST-BAL-01'",
      );
      samples.push(rows[0] ?? { status: 'MISSING', why: null });
      await sleep(250);
    }
  })();
  return {
    async stop() {
      stopped = true;
      await loop;
      return samples;
    },
  };
}

/** Sleeps until `Date.now()` reaches `at`. */
async function sleepUntil(at: number): Promise<void> {
  const left = at - Date.now();
  if (left > 0) await sleep(left);
}

/**
 * A command of the application role holding the live gateway session's row (kernel.begin_command locks it): that
 * session's id, and release(), which rolls the command back.
 */
async function holdGatewaySession(): Promise<{ sessionId: string; release(): Promise<void> }> {
  const actor = await stolenGatewayActor();
  const c = await rig.server.db.app.connect();
  await c.query('begin');
  await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(actor))]);
  let released = false;
  return {
    sessionId: actor.sessionId,
    async release() {
      if (released) return;
      released = true;
      await c.query('rollback').catch(() => undefined);
      c.release();
    },
  };
}

const HEARTBEAT_SQL = 'select tab.record_heartbeat($1::jsonb)';
const bal01Heartbeat = (state: 'ONLINE' | 'OFFLINE'): string =>
  JSON.stringify({ gatewayTimeUs: '1', devices: [{ deviceCode: 'TEST-BAL-01', state, serial: state === 'ONLINE' ? 'SIM-0001' : null, notReady: null }], journal: { lastSeq: '0', ackedSeq: '0' } });

const ONLINE_REFUSAL = /^Scale TEST-BAL-01 of room DISP-1 is online: the weight is captured from it, never keyed by hand.*\[EBMR-EXE-074\]$/;
const RECENT = /^Scale TEST-BAL-01 of room DISP-1 is shown offline \(the site gateway reports it OFFLINE\), but it has been reported offline for less than the 10 seconds before this weighing began, or reported ONLINE since, so that does not yet prove it cannot be used.*\[EBMR-EXE-074\]$/;
const UNRECORDED_WHY =
  /^Scale TEST-BAL-01 of room DISP-1 is shown offline \(no heartbeat from the site gateway in the last 10 seconds\), but heartbeats of the site gateway that name it have arrived since 10 seconds before this weighing began and were not recorded/;

describe('review P50, round 4: the application role\'s credentials cannot make a working scale count as unusable by the verifier\'s levers (tablets 0350, kernel 0970)', () => {
  it('[PR-20][DI-30][DI-32][DI-17] probe E4: an application-role connection holding the room\'s old advisory lock, and cancelling or ending the listener\'s heartbeats, changes nothing: every heartbeat is recorded, the scale stays ONLINE, and a weight keyed by hand through the server is refused', async () => {
    const d = await pcmRun();
    await report(rig, BESIDE);
    const before = await counts(d.runId);
    const holder = await rig.server.db.app.connect();
    const signaller = await rig.server.db.app.connect();
    const signals = { refused: 0, delivered: 0 };
    let beats: { stop(): Promise<number[]> } | undefined;
    try {
      // The room's lock is a row the application role cannot lock at all ...
      await expect(holder.query("select room_code from tab.scale_room_lock where room_code = 'DISP-1' for update")).rejects.toThrow(/permission denied for table scale_room_lock/);
      await expect(holder.query("select room_code from tab.scale_room_lock where room_code = 'DISP-1' for share")).rejects.toThrow(/permission denied for table scale_room_lock/);
      // ... and the advisory lock the heartbeats took until 0340 serialises nothing any more.
      await holder.query(`select pg_advisory_lock_shared(${OLD_ROOM_LOCK})`);
      beats = gatewayBeats(devicesOf(BESIDE));
      const until = Date.now() + 12_000;
      while (Date.now() < until) {
        for (const fn of ['pg_cancel_backend', 'pg_terminate_backend']) {
          await signaller
            .query(
              `select ${fn}(pid) from pg_stat_activity where datname = current_database() and usename = current_user and pid <> pg_backend_pid() and query like 'select tab.record_heartbeat%'`,
            )
            .then(
              () => (signals.delivered += 1),
              (error: unknown) => {
                expect(String(error)).toContain(`permission denied for function ${fn}`);
                signals.refused += 1;
              },
            );
        }
        await sleep(100);
      }
      const answered = await beats.stop();
      beats = undefined;
      expect(answered.length).toBeGreaterThanOrEqual(4);
      expect(answered).toEqual(answered.map(() => 200));
      expect({ delivered: signals.delivered, refused: signals.refused > 0 }).toEqual({ delivered: 0, refused: true });
      expect(await statuses(rig)).toEqual([['TEST-BAL-00', 'OFFLINE'], ['TEST-BAL-01', 'ONLINE']]);
      const viaServer = await d.command('operator1', handKeyed);
      expect(outcomeOf(viaServer)).toBe('422:EBMR-EXE-074');
      expect(await forgedWeighing(rig, d)).toBe('EBMR-EXE-074');
      expect(await counts(d.runId)).toEqual(before);
    } finally {
      await beats?.stop();
      await holder.query('select pg_advisory_unlock_all()').catch(() => undefined);
      holder.release();
      signaller.release();
    }
  }, 120_000);

  it('[PR-20][DI-30][DI-32] probe E3: a weighing written past the server whose own transaction holds the room\'s old advisory lock for 12 s changes nothing either: the heartbeats meanwhile are recorded and the weighing is refused beside the ONLINE scale', async () => {
    const d = await pcmRun();
    await report(rig, BESIDE);
    const before = await counts(d.runId);
    const answered: number[] = [];
    const refused = await messageOf(
      forgedWeighingRow(rig, d, {
        before: {
          work: async (c) => {
            await c.query(`select pg_advisory_xact_lock(${OLD_ROOM_LOCK})`);
            const beats = gatewayBeats(devicesOf(BESIDE));
            try {
              await sleep(12_000);
            } finally {
              answered.push(...(await beats.stop()));
            }
          },
        },
      }),
    );
    expect(answered.length).toBeGreaterThanOrEqual(4);
    expect(answered).toEqual(answered.map(() => 200));
    expect(refused).toMatch(ONLINE_REFUSAL);
    expect(await counts(d.runId)).toEqual(before);
  }, 120_000);

  it('[PR-20][DI-30][DI-32] heartbeats held up in the database (a command of the application role holding the live gateway session) never make the scale count as silent: it reads OFFLINE for want of recorded heartbeats, but a weight keyed by hand is refused while the gateway\'s heartbeats keep arriving', async () => {
    const d = await pcmRun();
    await report(rig, BESIDE);
    const before = await counts(d.runId);
    const holder = await rig.server.db.app.connect();
    let beats: { stop(): Promise<number[]> } | undefined;
    let answered: number[];
    try {
      await holder.query('begin');
      await holder.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(await stolenGatewayActor()))]);
      beats = gatewayBeats(devicesOf({ 'TEST-BAL-01': 'ONLINE' }));
      // TEST-BAL-00, named only in the report before, has fallen silent for the window the listener vouches for.
      await sleep(GATE_WINDOW_MS);
      // Nothing the gateway sent since was recorded: the scale reads OFFLINE for want of heartbeats ...
      expect(await statuses(rig)).toEqual([['TEST-BAL-00', 'OFFLINE'], ['TEST-BAL-01', 'OFFLINE']]);
      expect((await scaleStatusRows(rig.server.built.ctx, 'DISP-1')).find((s) => s.deviceCode === 'TEST-BAL-01')?.reason).toBe('no heartbeat from the site gateway in the last 10 seconds');
      // ... but the heartbeats arrived, so the silence is no proof that the scale cannot be used.
      const viaServer = await d.command('operator1', handKeyed);
      expect(outcomeOf(viaServer)).toBe('422:EBMR-EXE-074');
      expect(refusalOf(viaServer).why).toMatch(UNRECORDED_WHY);
      expect(await forgedWeighing(rig, d)).toBe('EBMR-EXE-074');
      expect(await counts(d.runId)).toEqual(before);
    } finally {
      await holder.query('rollback').catch(() => undefined);
      holder.release();
      answered = (await beats?.stop()) ?? [];
    }
    // Each heartbeat meanwhile was held up in its command (answered 503 after 3 s, the command ended within 4 s), so
    // more than one arrived.
    expect(answered.filter((s) => s !== 200).length).toBeGreaterThanOrEqual(2);
    // Released, the gateway's next heartbeat is recorded: ONLINE again.
    await report(rig, BESIDE);
    expect(await statuses(rig)).toEqual([['TEST-BAL-00', 'OFFLINE'], ['TEST-BAL-01', 'ONLINE']]);
  }, 120_000);

  it('[PR-20][DI-30][DI-32] a gateway that says its scale is not ready because the database held up its upload (the live gateway session held) opens nothing until that has been recorded for the heartbeat window', async () => {
    const d = await pcmRun();
    await report(rig, BESIDE);
    const before = await counts(d.runId);
    // While the application role holds the live gateway session, the gateway's upload fails, so its heartbeats say
    // TEST-BAL-01 is connected but not ready; none of them is recorded.
    const notReady: Device[] = [
      { deviceCode: 'TEST-BAL-00', state: 'OFFLINE', serial: null, notReady: null },
      { deviceCode: 'TEST-BAL-01', state: 'OFFLINE', serial: 'SIM-0001', notReady: 'the last upload to the server failed' },
    ];
    const holder = await rig.server.db.app.connect();
    let answered: number[];
    try {
      await holder.query('begin');
      await holder.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(await stolenGatewayActor()))]);
      const beats = gatewayBeats(notReady);
      await sleep(10_500);
      answered = await beats.stop();
    } finally {
      await holder.query('rollback').catch(() => undefined);
      holder.release();
    }
    expect(answered.length).toBeGreaterThanOrEqual(2);
    expect(answered.filter((s) => s === 200)).toEqual([]);
    // Released: the next heartbeat (still not ready) is recorded, and a weight is keyed by hand at once. The last report
    // that the scale was ONLINE is older than the window, but its not-ready state was recorded only now.
    expect(await heartbeatOf(notReady)).toBe(200);
    expect((await scaleStatusRows(rig.server.built.ctx, 'DISP-1')).find((s) => s.deviceCode === 'TEST-BAL-01')?.reason).toBe(
      'the site gateway cannot capture from it and deliver: the last upload to the server failed',
    );
    expect(await messageOf(forgedWeighingRow(rig, d))).toMatch(
      /^Scale TEST-BAL-01 of room DISP-1 is shown offline \(the site gateway cannot capture from it and deliver: the last upload to the server failed\), but it has been reported offline for less than the 10 seconds before this weighing began/,
    );
    expect(await counts(d.runId)).toEqual(before);
    // The gateway delivers again at its next flush and reports the scale ready: ONLINE.
    await report(rig, BESIDE);
    expect(await statuses(rig)).toEqual([['TEST-BAL-00', 'OFFLINE'], ['TEST-BAL-01', 'ONLINE']]);
  }, 120_000);

  it('[PR-20][DI-30][DI-32] ending the live gateway session, as the application role may, does not make its scales count as silent: the gateway\'s heartbeats with that session\'s token are refused (401) but still received, and a weight keyed by hand is refused', async () => {
    const d = await pcmRun();
    await report(rig, BESIDE);
    const before = await counts(d.runId);
    await identity.endSession(rig.server.db.app, (await stolenGatewayActor()).sessionId);
    try {
      const beats = gatewayBeats(devicesOf({ 'TEST-BAL-01': 'ONLINE' }));
      let answered: number[];
      try {
        await sleep(GATE_WINDOW_MS);
      } finally {
        answered = await beats.stop();
      }
      expect(answered.length).toBeGreaterThanOrEqual(3);
      expect(answered).toEqual(answered.map(() => 401));
      expect(await statuses(rig)).toEqual([['TEST-BAL-00', 'OFFLINE'], ['TEST-BAL-01', 'OFFLINE']]);
      expect(await messageOf(forgedWeighingRow(rig, d))).toMatch(UNRECORDED_WHY);
      expect(await counts(d.runId)).toEqual(before);
    } finally {
      // The gateway logs in again (a new session): its heartbeats are recorded, ONLINE.
      await rig.gw.close();
      rig.gw = await fakeGateway(rig.server);
    }
    await report(rig, BESIDE);
    expect(await statuses(rig)).toEqual([['TEST-BAL-00', 'OFFLINE'], ['TEST-BAL-01', 'ONLINE']]);
  }, 120_000);

  it('[DI-30] the heartbeats received and the answers of the gateway\'s API are kept for an hour: the next of each kind prunes older ones of its gateway', async () => {
    const key = rig.gw.login.chainId;
    const { admin } = rig.server.db;
    await admin.query(
      "insert into tab.heartbeat_receipt (gateway_key_id, received_at, devices) values ($1, clock_timestamp() - interval '61 minutes', '[]'), ($1, clock_timestamp() - interval '59 minutes', '[]')",
      [key],
    );
    await admin.query(
      "insert into tab.gateway_api_answer (gateway_key_id, answered_at, detail) values ($1, clock_timestamp() - interval '61 minutes', 'test: old'), ($1, clock_timestamp() - interval '59 minutes', 'test: kept')",
      [key],
    );
    const older = async () =>
      (
        await admin.query<{ receipts: number; answers: number }>(
          `select (select count(*)::int from tab.heartbeat_receipt where gateway_key_id = $1 and received_at < clock_timestamp() - interval '58 minutes') as receipts,
                  (select count(*)::int from tab.gateway_api_answer where gateway_key_id = $1 and answered_at < clock_timestamp() - interval '58 minutes') as answers`,
          [key],
        )
      ).rows[0];
    expect(await older()).toEqual({ receipts: 2, answers: 2 });
    await report(rig, BESIDE);
    // As the server records an answer of the gateway's API: on the receipts pool, the listener's own login (kernel 0980).
    await runtimeOf(rig.server.built.ctx).recordApiAnswer('TEST-GW-01', 'test: GET /v1/health answered for this server');
    expect(await older()).toEqual({ receipts: 1, answers: 1 });
  });

  it('[PR-20][DI-30][DI-32] with every connection of the server\'s application pool taken (its requests held up), the gateway\'s heartbeats are still received and recorded, on the pool of the gateway\'s reports', async () => {
    await report(rig, BESIDE);
    const pool = rig.server.db.app;
    const max = pool.options.max ?? 10;
    const held: pg.PoolClient[] = [];
    try {
      while (held.length < max) held.push(await pool.connect());
      expect(pool.totalCount).toBe(max);
      const before = (await rig.server.db.admin.query<{ n: number }>('select count(*)::int as n from tab.heartbeat_receipt')).rows[0]?.n ?? 0;
      const answered = await Promise.race([heartbeatOf(devicesOf(BESIDE)), sleep(15_000).then(() => 'WAITED' as const)]);
      expect(answered).toBe(200);
      const after = await rig.server.db.admin.query<{ n: number; fresh: boolean }>(
        `select (select count(*)::int from tab.heartbeat_receipt) as n,
                (select clock_timestamp() - h.reported_at < interval '5 seconds' from tab.instrument_heartbeat h join iam.device d on d.id = h.instrument_device_id where d.code = 'TEST-BAL-01') as fresh`,
      );
      expect(after.rows[0]).toEqual({ n: before + 1, fresh: true });
    } finally {
      for (const c of held) c.release();
    }
  }, 120_000);

  it('[PR-20][DI-30][DI-32] X12: a heartbeat saying OFFLINE, committed in its own transaction under the live gateway session\'s actor, does not open the manual path until the scale has been recorded not ONLINE for the heartbeat window with no heartbeat received since saying ONLINE; the gateway\'s own OFFLINE reports for the window do', async () => {
    const d = await pcmRun();
    const gw = await stolenGatewayActor();
    const beat = (state: 'ONLINE' | 'OFFLINE') => withActorCommand(rig.server.db.app, { ...gw, correlationId: randomUUID() }, (c) => c.query(HEARTBEAT_SQL, [bal01Heartbeat(state)]));
    const before = await counts(d.runId);

    // The verifier's probe: the gateway reports TEST-BAL-01 ONLINE (and TEST-BAL-00 OFFLINE, for the window), then a
    // forged heartbeat says TEST-BAL-01 is OFFLINE.
    await standFor(rig, 10_500, BESIDE);
    await beat('OFFLINE');
    expect(await statuses(rig)).toEqual([['TEST-BAL-00', 'OFFLINE'], ['TEST-BAL-01', 'OFFLINE']]);
    expect(await messageOf(forgedWeighingRow(rig, d))).toMatch(RECENT);

    // Recorded only: no heartbeat received in the window said ONLINE, but the recorded state turned from ONLINE to
    // OFFLINE only now (tab.instrument_heartbeat.offline_since).
    await standFor(rig, 10_500, BOTH_OFFLINE);
    await beat('ONLINE');
    await beat('OFFLINE');
    expect(await messageOf(forgedWeighingRow(rig, d))).toMatch(RECENT);

    // Received only: the recorded state has not been ONLINE for longer than the window, but a heartbeat received saying
    // ONLINE (the listener's first step) was never recorded.
    await standFor(rig, 10_500, BOTH_OFFLINE);
    const tokenHash = createHash('sha256').update(rig.gw.token, 'utf8').digest('hex');
    // Written as the listener writes a receipt: on its receipts pool, under its own login (kernel 0980).
    const receipt = await runtimeOf(rig.server.built.ctx).receipts().query<{ r: { received: boolean } }>('select tab.record_heartbeat_receipt($1, $2::jsonb) as r', [
      tokenHash,
      JSON.stringify({ gatewayTimeUs: '1', devices: devicesOf(BESIDE), journal: { lastSeq: '0', ackedSeq: '0' } }),
    ]);
    expect(receipt.rows[0]?.r.received).toBe(true);
    expect(await statuses(rig)).toEqual([['TEST-BAL-00', 'OFFLINE'], ['TEST-BAL-01', 'OFFLINE']]);
    expect(await messageOf(forgedWeighingRow(rig, d))).toMatch(RECENT);
    expect(await counts(d.runId)).toEqual(before);

    // Control: the gateway itself reports TEST-BAL-01 OFFLINE for the heartbeat window; the manual path opens.
    await standFor(rig, GATE_WINDOW_MS, BOTH_OFFLINE);
    expect(await forgedWeighing(rig, d)).toBe('ok');
    const { rows } = await rig.server.db.admin.query<{ scales: { deviceCode: string; status: string; reason: string }[] }>(
      'select scales from tab.manual_weighing_basis where batch_id = $1 order by row_seq desc limit 1',
      [d.runId],
    );
    expect(rows[0]?.scales.map((x) => [x.deviceCode, x.status, x.reason])).toEqual([
      ['TEST-BAL-00', 'OFFLINE', 'the site gateway reports it OFFLINE'],
      ['TEST-BAL-01', 'OFFLINE', 'the site gateway reports it OFFLINE'],
    ]);
    expect(await violations(rig.server)).toEqual([]);
  }, 180_000);

  it('[PR-20][DI-30][DI-32] X11: a report that the API cannot be reached, written under the monitor\'s live session and held uncommitted for the heartbeat window, does not open the manual path when it is committed; its window runs from when another transaction first sees it', async () => {
    const d = await pcmRun();
    const monitor = await monitorActor(rig);
    await report(rig, BESIDE);
    const before = await counts(d.runId);
    const tokenHash = createHash('sha256').update(rig.gw.token, 'utf8').digest('hex');
    /**
     * Writes the report in a transaction of the monitor's session on a connection of `pool` (default: the application
     * role's), runs `alsoInIt` there, holds it for the window, commits.
     */
    const heldReport = async (detail: string, alsoInIt: (c: { query: (sql: string, params: unknown[]) => Promise<unknown> }) => Promise<void>, pool: pg.Pool = rig.server.db.app) => {
      const holder = await pool.connect();
      try {
        await holder.query('begin');
        await holder.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext({ ...monitor, correlationId: randomUUID() }))]);
        expect((await holder.query(RECORD_CONTACT_SQL, [false, detail])).rows).toEqual([{ written: true }]);
        await alsoInIt(holder);
        await standFor(rig, 10_500, BESIDE);
        await holder.query('commit');
      } catch (error) {
        await holder.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        holder.release();
      }
      expect(await statuses(rig)).toEqual([['TEST-BAL-00', 'OFFLINE'], ['TEST-BAL-01', 'OFFLINE']]);
      return messageOf(forgedWeighingRow(rig, d));
    };
    const young = (detail: string) =>
      new RegExp(
        `^Scale TEST-BAL-01 of room DISP-1 is online by its heartbeat\\. The report that it cannot be used \\(the server cannot reach the site gateway's API \\(${detail}\\)\\) was made in this transaction, or had been seen by other transactions for less than 10 seconds when it began.*\\[EBMR-EXE-074\\]$`,
      );

    // The verifier's probe: written, held uncommitted for the window, committed, and at once a weight keyed by hand.
    expect(await heldReport('test: held uncommitted', () => Promise.resolve())).toMatch(young('test: held uncommitted'));
    expect(await recordContact(rig, true, 'test: the API answers', monitor)).toBe(true);
    // The same, with a heartbeat receipt in the report's own transaction: a report is never seen by the transaction that
    // wrote it. No login of the installation may do both any more (kernel 0980: only the listener's role may write a
    // receipt, and it may not write the report; the application role is refused the receipt, and could not read the
    // gateway's token hash anyway), so a superuser's connection stands in for one that could.
    const receiptSql = 'select tab.record_heartbeat_receipt($1, $2::jsonb)';
    const receiptParams = [tokenHash, JSON.stringify({ gatewayTimeUs: '1', devices: devicesOf(BESIDE), journal: { lastSeq: '0', ackedSeq: '0' } })];
    await expect(rig.server.db.app.query(receiptSql, receiptParams)).rejects.toThrow(/permission denied for function record_heartbeat_receipt/);
    expect(
      await heldReport(
        'test: seen in its own transaction',
        async (c) => {
          await c.query(receiptSql, receiptParams);
        },
        rig.server.db.admin,
      ),
    ).toMatch(young('test: seen in its own transaction'));
    expect(await counts(d.runId)).toEqual(before);
    expect(await recordContact(rig, true, 'test: the API answers', monitor)).toBe(true);
    await identity.endSession(rig.server.db.app, monitor.sessionId);
  }, 120_000);

  it('[PR-20][DI-30][DI-31] a report that the API cannot be reached does not open the manual path while the gateway\'s API answers the server, even when the monitor\'s report that it is reachable again never lands', async () => {
    const d = await pcmRun();
    const monitor = await monitorActor(rig);
    await report(rig, BESIDE);
    const before = await counts(d.runId);
    expect(await recordContact(rig, false, 'test: reported while the API answers', monitor)).toBe(true);
    // For the heartbeat window the gateway reports ONLINE (so the report is seen) and each of the server's probes of the
    // API is answered: the server records each answer on its own (DevicesRuntime.recordApiAnswer).
    const until = Date.now() + 10_500;
    while (Date.now() < until) {
      await report(rig, BESIDE);
      await runtimeOf(rig.server.built.ctx).recordApiAnswer('TEST-GW-01', 'test: GET /v1/health answered for this server');
      await sleep(3000);
    }
    await report(rig, BESIDE);
    expect(await statuses(rig)).toEqual([['TEST-BAL-00', 'OFFLINE'], ['TEST-BAL-01', 'OFFLINE']]);
    expect(await messageOf(forgedWeighingRow(rig, d))).toMatch(
      /^Scale TEST-BAL-01 of room DISP-1 is online by its heartbeat\. The report that it cannot be used \(the server cannot reach the site gateway's API \(test: reported while the API answers\)\) is answered: the gateway's API answered the server after that report was made.*\[EBMR-EXE-074\]$/,
    );
    expect(await counts(d.runId)).toEqual(before);
    expect(await recordContact(rig, true, 'test: the API answers', monitor)).toBe(true);
    await identity.endSession(rig.server.db.app, monitor.sessionId);
  }, 120_000);

  it('[PR-20][DI-30][DI-32] a weighing that reads an old snapshot (REPEATABLE READ, taken while the gateway was silent) is refused: the gate reads the reports as committed when the weighing is written, and the scale came online since', async () => {
    const d = await pcmRun();
    await report(rig, BESIDE);
    const before = await counts(d.runId);
    // The gateway falls silent for the heartbeat window: both scales read OFFLINE for want of heartbeats.
    await sleep(10_500);
    expect(await statuses(rig)).toEqual([['TEST-BAL-00', 'OFFLINE'], ['TEST-BAL-01', 'OFFLINE']]);
    const refused = await messageOf(
      forgedWeighingRow(rig, d, {
        isolation: 'repeatable read',
        before: {
          // The snapshot is taken (begin_command); then the gateway reports TEST-BAL-01 ONLINE again, committed.
          work: async () => {
            await report(rig, BESIDE);
          },
        },
      }),
    );
    expect(refused).toMatch(/^A weight keyed by hand is checked against the scales' reports as committed when it is written, but this transaction reads the database as its snapshot saw it \(isolation level repeatable read\).*\[EBMR-EXE-074\]$/);
    expect(await statuses(rig)).toEqual([['TEST-BAL-00', 'OFFLINE'], ['TEST-BAL-01', 'ONLINE']]);
    expect(await counts(d.runId)).toEqual(before);
  }, 120_000);

  it('[PR-20][DI-30][DI-17] while roles other than superusers may signal backends again (the policy of kernel 0970 lost), the database refuses every weight keyed by hand; once the policy is applied again the manual path opens', async () => {
    const d = await pcmRun();
    await standFor(rig, GATE_WINDOW_MS, BOTH_OFFLINE);
    const before = await counts(d.runId);
    await rig.server.db.admin.query('grant execute on function pg_catalog.pg_cancel_backend(integer) to public');
    try {
      expect(await messageOf(forgedWeighingRow(rig, d))).toMatch(
        /^Roles other than the database's superusers may cancel or end other connections in this database \(pg_cancel_backend, pg_terminate_backend, pg_signal_backend\), so the site gateway's reports could be silenced.*\[EBMR-EXE-074\]$/,
      );
      expect(await counts(d.runId)).toEqual(before);
    } finally {
      await rig.server.db.admin.query('select sandbox.apply_connect_policy()');
    }
    expect(await forgedWeighing(rig, d)).toBe('ok');
    expect(await counts(d.runId)).toEqual({ rows: before.rows + 1, basis: before.basis + 1 });
  }, 120_000);

  it('[PR-20][DI-30][DI-31] a weighing checked while a heartbeat of its room is being written (the room\'s row locked by tab.record_heartbeat, uncommitted) is refused at once, without waiting for the heartbeat', async () => {
    const d = await pcmRun();
    await report(rig, BESIDE);
    const before = await counts(d.runId);
    const heartbeat = await rig.server.db.app.connect();
    try {
      await heartbeat.query('begin');
      await heartbeat.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(await stolenGatewayActor()))]);
      await heartbeat.query(HEARTBEAT_SQL, [bal01Heartbeat('OFFLINE')]);
      const r = await Promise.race([messageOf(forgedWeighingRow(rig, d)), sleep(15_000).then(() => 'WAITED')]);
      expect(r).toMatch(/^A scale of room DISP-1 is reporting its status at this moment, so whether it is online is not yet known.*\[EBMR-EXE-074\]$/);
    } finally {
      await heartbeat.query('rollback').catch(() => undefined);
      heartbeat.release();
    }
    expect(await counts(d.runId)).toEqual(before);
  }, 120_000);
});

describe('review P50, follow-up round 2: the gateway\'s heartbeats are answered on time and received whatever holds up their commands (decisions X29-X31)', () => {
  // Each wait point is released 3.5 s after the one before, just inside the 4 s every wait and statement of the reports
  // pool may take (REPORT_STATEMENT_TIMEOUT_MS), so a heartbeat's command that meets them in turn waits 10.5 s in all.
  const HOLD_MS = 3500;

  it('[PR-20][DI-30] with the wait points of a heartbeat\'s command held one after another (a connection of the reports pool, the live gateway session\'s row, the room\'s row: 10.5 s in all), the gateway sending every 5 s one at a time is answered within 3 s each time, its heartbeats are received at most about 5 s apart, and the gate refuses a weight keyed by hand throughout', async () => {
    const d = await pcmRun();
    await report(rig, BESIDE);
    const before = await counts(d.runId);
    const runtime = runtimeOf(rig.server.built.ctx);
    const from = await dbMs();
    const started = Date.now();
    const uplink = uplinkHeartbeats(devicesOf(BESIDE));
    const gate = gateSampler();
    const pool: pg.PoolClient[] = [];
    let session: { sessionId: string; release(): Promise<void> } | undefined;
    let room: pg.PoolClient | undefined;
    let beats: Beat[];
    // The connections of the reports pool the gateway's commands hold at a time, once the case lets its own go.
    const reports = runtime.reports();
    let taken = 0;
    let most = 0;
    const onAcquire = (): void => {
      taken += 1;
      most = Math.max(most, taken);
    };
    const onRelease = (): void => {
      taken -= 1;
    };
    try {
      // Just before the gateway's second heartbeat (10 s), every wait point of its command is held.
      await sleepUntil(started + 2 * 5000 - 300);
      while (pool.length < REPORTS_POOL_MAX) pool.push(await reports.connect());
      session = await holdGatewaySession();
      // The room's row in share mode, as a weighing's check holds it (by the owner here: the application role holds no
      // privilege on tab.scale_room_lock).
      room = await rig.server.db.admin.connect();
      await room.query('begin');
      await room.query("select 1 from tab.scale_room_lock where room_code = 'DISP-1' for share");
      const heldAt = Date.now();
      await sleepUntil(heldAt + HOLD_MS);
      for (const c of pool.splice(0)) c.release();
      taken = reports.totalCount - reports.idleCount;
      most = taken;
      reports.on('acquire', onAcquire);
      reports.on('release', onRelease);
      // Nothing recorded since the first heartbeat: the scale reads OFFLINE for want of recorded heartbeats, but those
      // received keep the manual path shut.
      await sleepUntil(started + 5000 + 11_000);
      expect(await statuses(rig)).toEqual([['TEST-BAL-00', 'OFFLINE'], ['TEST-BAL-01', 'OFFLINE']]);
      expect(await forgedWeighing(rig, d)).toBe('EBMR-EXE-074');
      await sleepUntil(heldAt + 2 * HOLD_MS);
      await session.release();
      await sleepUntil(heldAt + 3 * HOLD_MS);
      await room.query('rollback');
      room.release();
      room = undefined;
      // Two more heartbeats after the last wait point is let go.
      await sleepUntil(started + 6 * 5000 + 1000);
    } finally {
      for (const c of pool.splice(0)) c.release();
      await session?.release();
      await room?.query('rollback').catch(() => undefined);
      room?.release();
      beats = await uplink.stop();
      reports.off('acquire', onAcquire);
      reports.off('release', onRelease);
    }
    const to = await dbMs();
    const samples = await gate.stop();
    // One command of the gateway at a time: the heartbeats that arrived while it was held up started none of their own.
    expect(most).toBe(1);

    // Received at most about one interval apart: well inside the gate's 10 s window.
    const gaps = await receiptGaps(from, to);
    expect(Math.max(...gaps), JSON.stringify(gaps)).toBeLessThan(7000);
    // The gate never counted the scale unusable, though its heartbeats were not recorded for more than 10 s.
    expect(samples.filter((s) => s.status !== 'ONLINE')).toEqual([]);
    expect(samples.some((s) => s.why === 'UNRECORDED')).toBe(true);
    expect(await counts(d.runId)).toEqual(before);
    // Every heartbeat answered within the deadline, below the gateway's interval; the held ones 503 HEARTBEAT_PENDING.
    expect(beats.length).toBeGreaterThanOrEqual(5);
    expect(beats.filter((b) => b.ms >= HEARTBEAT_ANSWER_MS + 1000)).toEqual([]);
    expect(beats.filter((b) => b.status === 503 && b.code === 'HEARTBEAT_PENDING').length).toBeGreaterThanOrEqual(2);
    expect(beats.filter((b) => b.status !== 200 && b.code !== 'HEARTBEAT_PENDING')).toEqual([]);
    expect(beats.at(-1)?.status).toBe(200);
    // The latest heartbeat was recorded: ONLINE.
    expect(await statuses(rig)).toEqual([['TEST-BAL-00', 'OFFLINE'], ['TEST-BAL-01', 'ONLINE']]);
  }, 120_000);

  it('[PR-20][DI-30] after a restart (no API token for the gateway), a gateway whose old session\'s row is held for 15 s is answered within 3 s, told to log in again at its next heartbeat, and, sending on with its last token while that login waits for the same row, received at most about 5 s apart throughout; the gate refuses a weight keyed by hand', async () => {
    const d = await pcmRun();
    await report(rig, BESIDE);
    const before = await counts(d.runId);
    const runtime = runtimeOf(rig.server.built.ctx);
    const from = await dbMs();
    const started = Date.now();
    const uplink = uplinkHeartbeats(devicesOf(BESIDE));
    const gate = gateSampler();
    let session: { sessionId: string; release(): Promise<void> } | undefined;
    let beats: Beat[];
    let token: string | null;
    let oldSession: string;
    try {
      await sleepUntil(started + 7000);
      // A restarted server process holds no gateway's API token and has handed out no bearer token.
      runtime.links.clear();
      runtime.issued.clear();
      // The old session's row, which ending it must wait for, held for longer than the heartbeat window.
      session = await holdGatewaySession();
      oldSession = session.sessionId;
      await sleepUntil(started + 16_500);
      expect(await forgedWeighing(rig, d)).toBe('EBMR-EXE-074');
      await sleepUntil(started + 22_000);
      await session.release();
      await sleepUntil(started + 6 * 5000 + 1000);
    } finally {
      await session?.release();
      beats = await uplink.stop();
      token = uplink.token();
    }
    const to = await dbMs();
    const samples = await gate.stop();
    try {
      const gaps = await receiptGaps(from, to);
      expect(Math.max(...gaps), JSON.stringify(gaps)).toBeLessThan(7000);
      expect(samples.filter((s) => s.status !== 'ONLINE')).toEqual([]);
      expect(await counts(d.runId)).toEqual(before);
      // The old token: 503 while its session is being ended, then 401 SESSION (unbound) while the new login is held
      // up as well (it waits for the gateway account's row); every answer within the deadline.
      expect(beats.filter((b) => b.ms >= HEARTBEAT_ANSWER_MS + 1000)).toEqual([]);
      expect(beats.map((b) => b.code)).toEqual(expect.arrayContaining(['HEARTBEAT_PENDING', 'SESSION']));
      expect(beats.at(-1)?.status).toBe(200);
      // The old session was ended once let go; the new one's heartbeats are recorded: ONLINE.
      const { rows } = await rig.server.db.admin.query<{ ended: boolean }>('select ended_at is not null as ended from iam.session where id = $1', [oldSession]);
      expect(rows).toEqual([{ ended: true }]);
      expect(await statuses(rig)).toEqual([['TEST-BAL-00', 'OFFLINE'], ['TEST-BAL-01', 'ONLINE']]);
    } finally {
      // The gateway's new session logs out; the test gateway logs in again for the cases that follow.
      if (token && token !== rig.gw.token) await rig.gw.post('/gw/v1/logout', {}, token);
      await rig.gw.close();
      rig.gw = await fakeGateway(rig.server);
    }
  }, 120_000);

  it('[PR-20][DI-30][DI-27] requests nobody authenticated (heartbeats with made-up tokens, other routes, unknown paths) hold at most one connection of the receipts pool at a time and never make it wait, and the gateway\'s own heartbeat meanwhile is received and recorded', async () => {
    await report(rig, BESIDE);
    const pool = runtimeOf(rig.server.built.ctx).receipts();
    let taken = 0;
    let most = 0;
    let waiting = 0;
    const onAcquire = (): void => {
      taken += 1;
      most = Math.max(most, taken);
      waiting = Math.max(waiting, pool.waitingCount);
    };
    const onRelease = (): void => {
      taken -= 1;
    };
    pool.on('acquire', onAcquire);
    pool.on('release', onRelease);
    const receipts = async (): Promise<number> =>
      (await rig.server.db.admin.query<{ n: number }>('select count(*)::int as n from tab.heartbeat_receipt where gateway_key_id = $1', [rig.gw.login.chainId])).rows[0]?.n ?? 0;
    try {
      const before = await receipts();
      const madeUp = (): string => randomBytes(32).toString('base64url');
      const body = { gatewayTimeUs: '1790584618000000', devices: devicesOf(BESIDE), journal: { lastSeq: '0', ackedSeq: '0' } };
      const flood = Promise.all([
        ...Array.from({ length: 60 }, () => rig.gw.post('/gw/v1/heartbeat', body, madeUp())),
        ...Array.from({ length: 30 }, () => rig.gw.post('/gw/v1/challenge', {}, madeUp())),
        ...Array.from({ length: 30 }, () => rig.gw.post('/gw/v1/no-such-route', {}, null)),
      ]);
      const own = await rig.gw.heartbeat(devicesOf(BESIDE));
      const answered = await flood;
      expect(own.status, JSON.stringify(own.body)).toBe(200);
      const codes = (from: number, n: number) => [...new Set(answered.slice(from, from + n).map((a) => `${a.status}:${(a.body as { error?: { code: string } } | null)?.error?.code ?? ''}`))].sort();
      expect(codes(0, 60).filter((c) => c !== '401:SESSION' && c !== '503:HEARTBEAT_PENDING')).toEqual([]);
      expect(codes(60, 30)).toEqual(['401:SESSION']);
      expect(codes(90, 30).every((c) => c.startsWith('404:'))).toBe(true);
      // At most the lane of unverified tokens and the gateway's own receipt at a time, and nobody waited for a connection.
      expect(waiting).toBe(0);
      expect(most).toBeLessThanOrEqual(UNVERIFIED_RECEIPTS_AT_ONCE + 1);
      // Only the gateway's own heartbeat was received: a made-up token leaves no receipt.
      expect(await receipts()).toBe(before + 1);
    } finally {
      pool.off('acquire', onAcquire);
      pool.off('release', onRelease);
    }
  }, 60_000);
});

describe('review P50, follow-up round 4: the gate fails closed when the gateway listener cannot put what it receives on record (tablets 0350 item 6, kernel 0980; decisions X36-X39)', () => {
  /** The database's refusal where the listener vouches for no window (the server's `why` is the same without the code). */
  const UNATTESTED_WHY =
    /^Scale TEST-BAL-0[01] of room DISP-1 is shown offline \(no heartbeat from the site gateway in the last 10 seconds\), but the gateway listener has not put on record that everything it received in the 10 seconds before this weighing began is recorded/;
  const UNATTESTED = new RegExp(`${UNATTESTED_WHY.source}.*\\[EBMR-EXE-074\\]$`);

  it('[PR-20][DI-30][DI-32] while the listener cannot write the heartbeats\' receipts (a superuser\'s lock on tab.heartbeat_receipt holds each past the receipts pool\'s 2 s limit) and the gateway keeps reporting its scale ONLINE, the scale reads OFFLINE for want of recorded heartbeats, but the database vouches for no window and refuses a weight keyed by hand throughout; released, the next heartbeat is recorded', async () => {
    const d = await pcmRun();
    await report(rig, BESIDE);
    const before = await counts(d.runId);
    const start = await dbMs();
    // Stands in for a database too loaded to take a receipt within its statement's limit: inserts wait, reads do not.
    const holder = await rig.server.db.admin.connect();
    let beats: { stop(): Promise<number[]> } | undefined;
    let sampler: { stop(): Promise<{ status: string; why: string | null }[]> } | undefined;
    let answered: number[];
    let samples: { status: string; why: string | null }[];
    try {
      await holder.query('begin');
      await holder.query('lock table tab.heartbeat_receipt in exclusive mode');
      beats = gatewayBeats(devicesOf(BESIDE));
      sampler = gateSampler();
      // Longer than the heartbeat window and the listener's vouching lag together: before tablets 0350 item 6 the gate
      // counted TEST-BAL-01 silent here, since no receipt had been written for 10 s.
      await sleep(GATE_WINDOW_MS + 2000);
      expect(await statuses(rig)).toEqual([['TEST-BAL-00', 'OFFLINE'], ['TEST-BAL-01', 'OFFLINE']]);
      expect((await scaleStatusRows(rig.server.built.ctx, 'DISP-1')).find((s) => s.deviceCode === 'TEST-BAL-01')?.reason).toBe('no heartbeat from the site gateway in the last 10 seconds');
      const viaServer = await d.command('operator1', handKeyed);
      expect(outcomeOf(viaServer)).toBe('422:EBMR-EXE-074');
      expect(refusalOf(viaServer).why).toMatch(UNATTESTED_WHY);
      expect(await messageOf(forgedWeighingRow(rig, d))).toMatch(UNATTESTED);
      expect(await counts(d.runId)).toEqual(before);
    } finally {
      samples = (await sampler?.stop()) ?? [];
      answered = (await beats?.stop()) ?? [];
      await holder.query('rollback').catch(() => undefined);
      holder.release();
    }
    // Every heartbeat meanwhile failed at its receipt (none was recorded), and more than the window's worth arrived.
    expect(answered.length).toBeGreaterThanOrEqual(4);
    expect(answered.filter((st) => st === 200)).toEqual([]);
    // The gate never counted the working scale unusable; once its recorded heartbeat had aged past the window, it was
    // refused because the listener vouched for nothing (it said so in its ticks).
    expect(samples.length).toBeGreaterThan(40);
    expect(samples.filter((x) => x.status !== 'ONLINE')).toEqual([]);
    expect(samples.at(-1)).toEqual({ status: 'ONLINE', why: 'UNATTESTED' });
    const ticks = await rig.server.db.admin.query<{ unclean: number }>(
      'select count(*)::int as unclean from tab.listener_tick where clean = false and ticked_at > to_timestamp($1::float8 / 1000)',
      [start],
    );
    expect(ticks.rows[0]?.unclean).toBeGreaterThanOrEqual(3);
    // Released: the gateway's next heartbeat is received and recorded, ONLINE.
    await report(rig, BESIDE);
    expect(await statuses(rig)).toEqual([['TEST-BAL-00', 'OFFLINE'], ['TEST-BAL-01', 'ONLINE']]);
  }, 120_000);

  it('[DI-17][DI-30] only the listener\'s own login writes what it receives: the application role is refused a receipt, an answer of the gateway\'s API and a tick, and the listener\'s receipts run on connections of that login', async () => {
    const tokenHash = createHash('sha256').update(rig.gw.token, 'utf8').digest('hex');
    const app = rig.server.db.app;
    await expect(app.query('select tab.record_heartbeat_receipt($1, $2::jsonb)', [tokenHash, JSON.stringify({ devices: [] })])).rejects.toThrow(/permission denied for function record_heartbeat_receipt/);
    await expect(app.query('select tab.record_gateway_api_answer($1, $2)', ['TEST-GW-01', 'test: forged answer'])).rejects.toThrow(/permission denied for function record_gateway_api_answer/);
    await expect(app.query('select tab.record_listener_tick($1, true)', [randomUUID()])).rejects.toThrow(/permission denied for function record_listener_tick/);
    const runtime = runtimeOf(rig.server.built.ctx);
    const who = await runtime.receipts().query<{ u: string }>('select session_user as u');
    expect(who.rows).toEqual([{ u: 'ebmr_sandbox_listener' }]);
    // The listener's login does nothing else: no command, no table.
    await expect(runtime.receipts().query(HEARTBEAT_SQL, [bal01Heartbeat('OFFLINE')])).rejects.toThrow(/permission denied for function record_heartbeat/);
    await expect(runtime.receipts().query('select count(*) from tab.listener_tick')).rejects.toThrow(/permission denied for table listener_tick/);
  });
});

describe('review P50, round 4: administrators are refused by every tablets writer of GMP data (DI-18)', () => {
  it('[DI-18][DI-17] every tablets function the application role may call that requires a GMP permission also refuses administrators (iam.assert_not_administrator), whatever the role catalogue says later', async () => {
    const { rows: perms } = await rig.server.db.admin.query<{ code: string; domain: string }>('select code, domain from iam.permission');
    const domain = new Map(perms.map((p) => [p.code, p.domain]));
    const { rows } = await rig.server.db.admin.query<{ fn: string; src: string }>(
      `select p.oid::regprocedure::text as fn, p.prosrc as src
         from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'tab' and p.prokind = 'f' and has_function_privilege('ebmr_app', p.oid, 'EXECUTE')
        order by 1`,
    );
    const gmp = rows.filter((r) => [...r.src.matchAll(/iam\.require_permission\('([A-Z0-9_.]+)'/g)].some((m) => domain.get(m[1] ?? '') === 'GMP'));
    expect(gmp.map((r) => r.fn)).toEqual(expect.arrayContaining(['tab.record_gateway_api_contact(text,boolean,text)', 'tab.record_heartbeat(jsonb)', 'tab.ingest_reading(jsonb,bigint,uuid,text)']));
    expect(gmp.filter((r) => !r.src.includes('iam.assert_not_administrator()')).map((r) => r.fn)).toEqual([]);
  });
});
