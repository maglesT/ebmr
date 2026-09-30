/**
 * The database is the gate of the manual two-person path (review finding P50, round-1 verification; tablets 0310;
 * controls DI-20, DI-30, DI-31, DI-32, PR-20).
 *
 * Hand-keyed tare and gross are the fallback for a scale that cannot be used: never accepted while a scale of the
 * step's room is ONLINE. The only guard was TypeScript (execution/intents.ts, EBMR-EXE-074), reading the statuses on
 * its own connection before the command's transaction, so a skeptic recorded a MANUAL weighing beside an ONLINE scale
 * twice: a scale that came online between the server's read and the commit (race), and a server check that answered
 * no scale (bypass). The database now refuses, inside the command, a hand-keyed weighing
 *  - while any scale of the terminal's room is ONLINE, read at insert time;
 *  - from a terminal registered to no room, or naming a balance that is not an active instrument of the room;
 *  - while a heartbeat of the room is being written (the heartbeat, in turn, waits for a weighing being recorded);
 * and a weighing whose source is neither DEVICE nor MANUAL. Room DISP-1 holds two balances, TEST-BAL-00 and TEST-BAL-01.
 *
 * Round-3 verification (tablets 0340): with the application role alone, a writer reported the gateway's API unreachable
 * inside the weighing's own transaction (tab.record_gateway_api_contact took no actor), wrote the MANUAL weighing
 * beside a scale whose heartbeat said ONLINE, reported the API reachable again and committed. The gate now counts the
 * server's reports (API unreachable, a refused reading of the chain) only when made before the weighing's transaction
 * and standing for the heartbeat window (10 s), refuses a heartbeat of the room written in the weighing's own
 * transaction, takes the API report only from the server's gateway API monitor identity, and records with the weighing
 * (tab.manual_weighing_basis) the status and reason of every scale of the room it counted.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { identity, toDbContext, withCommand, type ActorContext } from '@ebmr/kernel';
import type { ScaleStatusView } from '@ebmr/api-contract';
import { adminActor, fakeGateway } from './support.ts';
import {
  forgedWeighing,
  forgedWeighingRow,
  handKeyed,
  monitorActor,
  newRun,
  reachPcm,
  RECORD_CONTACT_SQL,
  recordContact,
  report,
  roomFreeDispensing,
  standFor,
  startRig,
  statuses,
  stopRig,
  type Rig,
} from './room-scales-support.ts';
import { actorOf, codeOf, messageOf } from '../execution/db-guards-support.ts';
import { outcomeOf, refusalOf, RunDriver, rowsOf, violations } from '../execution/support.ts';

let rig: Rig;

beforeAll(async () => {
  rig = await startRig();
}, 180_000);

afterAll(async () => {
  await stopRig(rig);
});

/** Polls `check` every 20 ms until it holds (true) or `stop` does, for at most `ms`; whether `check` held. */
async function until(check: () => Promise<boolean>, stop: () => boolean, ms = 15_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !stop()) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

/** Whether a gateway heartbeat of this database waits on a room's lock (tab.record_heartbeat, tablets 0310). */
async function heartbeatWaitsOnLock(): Promise<boolean> {
  const { rows } = await rig.server.db.admin.query<{ n: number }>(
    "select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and wait_event = 'advisory' and query like 'select tab.record_heartbeat%'",
  );
  return (rows[0]?.n ?? 0) > 0;
}

describe('review P50, round-1 verification: the database refuses hand-keyed weights beside an online scale of the room (tablets 0310)', () => {
  it('[PR-20][DI-30][DI-32] hand-keyed weights are refused by the database while a scale of the room is online, when the server read the statuses just before it came online (race) and when the server\'s check is skipped (bypass); nothing is recorded', async () => {
    const d = await newRun(rig);
    await reachPcm(d);
    await report(rig, { 'TEST-BAL-00': 'OFFLINE', 'TEST-BAL-01': 'OFFLINE' });
    const port = rig.server.built.ctx.deviceReadings;
    const original = port.scales.bind(port);
    const rowsBefore = (await rowsOf(rig.server, d.runId)).length;

    // Race: the server reads the statuses (none online), then TEST-BAL-01 comes online before the command commits.
    port.scales = async (room) => {
      const answer = await original(room);
      await report(rig, { 'TEST-BAL-01': 'ONLINE' });
      return answer;
    };
    const race = await d.command('operator1', handKeyed).finally(() => {
      port.scales = original;
    });
    // Bypass: the server's check answers no scale although TEST-BAL-01 is online (a server bug, or a writer skipping it).
    await report(rig, { 'TEST-BAL-01': 'ONLINE' });
    port.scales = () => Promise.resolve<ScaleStatusView[]>([]);
    const bypass = await d.command('operator1', handKeyed).finally(() => {
      port.scales = original;
    });

    expect({ race: outcomeOf(race), bypass: outcomeOf(bypass) }).toEqual({ race: '422:EBMR-EXE-074', bypass: '422:EBMR-EXE-074' });
    // The database refused them, with its own reason, where the server's check had let them through.
    expect(refusalOf(race).why).toMatch(/Scale TEST-BAL-01 of room DISP-1 is online/);
    expect(refusalOf(bypass).why).toMatch(/Scale TEST-BAL-01 of room DISP-1 is online/);
    expect((await rowsOf(rig.server, d.runId)).length).toBe(rowsBefore);
    expect(await violations(rig.server)).toEqual([]);
  }, 300_000);

  it('[PR-20][DI-20][DI-30][DI-32] written past the server, a hand-keyed weighing beside an online scale, naming a balance that is not an active instrument of the room, or with a source neither DEVICE nor MANUAL, is refused; MANUAL or a scale of the room is recorded when none is online', async () => {
    const d = await newRun(rig);
    await reachPcm(d);
    const { server } = rig;
    const bal00 = (await server.db.admin.query<{ id: string }>("select id from iam.device where code = 'TEST-BAL-00'")).rows[0]?.id ?? '';
    const setStatus = async (status: 'ACTIVE' | 'BLOCKED', reason: string) => withCommand(server.db.app, await adminActor(server, reason), (c) => identity.setDeviceStatus(c, bal00, status, reason));
    const weighing = (edit?: (e: Record<string, unknown>) => void) => forgedWeighing(rig, d, edit ? { edit } : {});
    const rowsBefore = (await rowsOf(server, d.runId)).length;

    await report(rig, { 'TEST-BAL-00': 'OFFLINE', 'TEST-BAL-01': 'ONLINE' });
    const besideOnline = {
      balanceManual: await weighing(),
      namingTheOfflineScale: await weighing((e) => {
        e['balance'] = 'TEST-BAL-00';
      }),
    };
    await report(rig, { 'TEST-BAL-00': 'OFFLINE', 'TEST-BAL-01': 'OFFLINE' });
    const noneOnline = {
      otherRoomBalance: await weighing((e) => {
        e['balance'] = 'TEST-BAL-02';
      }),
      notAnInstrument: await weighing((e) => {
        e['balance'] = 'TEST-KIOSK-DISP-1';
      }),
      noBalance: await weighing((e) => {
        delete e['balance'];
      }),
      scanned: await weighing((e) => {
        e['source'] = 'SCAN';
      }),
      noSource: await weighing((e) => {
        delete e['source'];
      }),
      blockedBalance: await (async () => {
        await setStatus('BLOCKED', 'Floor scale failed its daily check (test)');
        try {
          return await weighing((e) => {
            e['balance'] = 'TEST-BAL-00';
          });
        } finally {
          await setStatus('ACTIVE', 'Floor scale checked and released (test)');
        }
      })(),
    };
    expect({ besideOnline, noneOnline }).toEqual({
      besideOnline: { balanceManual: 'EBMR-EXE-074', namingTheOfflineScale: 'EBMR-EXE-074' },
      noneOnline: { otherRoomBalance: 'EBMR-EXE-074', notAnInstrument: 'EBMR-EXE-074', noBalance: 'EBMR-EXE-074', scanned: 'EBMR-EXE-121', noSource: 'EBMR-EXE-121', blockedBalance: 'EBMR-EXE-074' },
    });
    expect((await rowsOf(server, d.runId)).length).toBe(rowsBefore);

    // With no scale of the room online, MANUAL and an active scale of the room are recorded.
    const controls = {
      balanceManual: await weighing(),
      namingTheOfflineScale: await weighing((e) => {
        e['balance'] = 'TEST-BAL-00';
      }),
    };
    expect(controls).toEqual({ balanceManual: 'ok', namingTheOfflineScale: 'ok' });
    expect((await rowsOf(server, d.runId)).length).toBe(rowsBefore + 2);
    expect(await violations(server)).toEqual([]);
  }, 300_000);

  it('[PR-20][DI-20][DI-30] written past the server, a hand-keyed weighing from a terminal registered to no room is refused, even on a stage that names no room and with no scale online; from the kiosk of a room it is recorded', async () => {
    // The stage names no room, so its steps are accepted from any terminal (the room check of recipe-core 0300 lets
    // the office PC through); the gate of tablets 0310 alone refuses the hand-keyed weights there.
    const d = await newRun(rig, { content: roomFreeDispensing() });
    await reachPcm(d);
    await report(rig, { 'TEST-BAL-00': 'OFFLINE', 'TEST-BAL-01': 'OFFLINE' });
    const { server } = rig;
    const rowsBefore = (await rowsOf(server, d.runId)).length;
    // operator1 signs in on the office PC (TEST-PC-01, registered to no room).
    const office = new RunDriver(server, d.runId, { operator1: await server.asPersona('operator1', 'TEST-PC-01') });
    expect(office.browser('operator1').terminal).toBe('TEST-PC-01');
    const fromOffice = await messageOf(forgedWeighingRow(rig, office));
    expect(fromOffice).toMatch(/A weight keyed by hand is accepted only from a terminal registered to a room.*\[EBMR-EXE-074\]/);
    expect((await rowsOf(server, d.runId)).length).toBe(rowsBefore);
    // Control: the same weighing written past the server from the DISP-1 kiosk, where no scale is online.
    const kiosk = new RunDriver(server, d.runId, { operator1: await server.asPersona('operator1') });
    expect(await forgedWeighing(rig, kiosk)).toBe('ok');
    expect((await rowsOf(server, d.runId)).length).toBe(rowsBefore + 1);
    expect(await violations(server)).toEqual([]);
  }, 300_000);

  it('[PR-20][DI-30][DI-31] heartbeats and hand-keyed weighings of a room are serialised: a heartbeat waits for the weighing being recorded, and a weighing checked while a heartbeat of its room is being written is refused without waiting', async () => {
    const d = await newRun(rig);
    await reachPcm(d);
    // A second run in the same room, by operator2 on the DISP-1 kiosk (another person, another session).
    const other = await newRun(rig, { browsers: { issuer: d.browser('issuer'), operator2: await rig.server.asPersona('operator2', 'TEST-KIOSK-DISP-1'), verifier1: d.browser('verifier1') } });
    await reachPcm(other, 'operator2');
    await report(rig, { 'TEST-BAL-00': 'OFFLINE', 'TEST-BAL-01': 'OFFLINE' });

    let heartbeat: Promise<{ status: number; body: unknown }> | undefined;
    let heartbeatDone = false;
    const seen = { heartbeatWaited: false, heartbeatDoneBeforeCommit: true, otherWeighing: '' };
    // operator1's weighing is written (its check passed: no scale online); before it commits, TEST-BAL-01 reports ONLINE.
    const weighing = await forgedWeighing(rig, d, {
      during: async () => {
        heartbeat = rig.gw.heartbeat([{ deviceCode: 'TEST-BAL-01', state: 'ONLINE', serial: 'SIM-0001' }]);
        heartbeat.then(
          () => (heartbeatDone = true),
          () => (heartbeatDone = true),
        );
        seen.heartbeatWaited = await until(heartbeatWaitsOnLock, () => heartbeatDone);
        seen.heartbeatDoneBeforeCommit = heartbeatDone;
        // Meanwhile operator2 keys a weighing of the other run in the room by hand: whether a scale is online is not
        // known until the heartbeat is written, so it is refused at once (it never waits for the heartbeat).
        const r = await Promise.race([other.command('operator2', handKeyed), new Promise<'WAITED'>((res) => setTimeout(() => res('WAITED'), 20_000))]);
        seen.otherWeighing = r === 'WAITED' ? r : `${outcomeOf(r)} ${r.ok ? '' : refusalOf(r).why}`;
      },
    });
    const hb = await heartbeat;
    expect({ weighing, heartbeat: hb?.status, ...seen, otherWeighing: seen.otherWeighing.slice(0, 16) }).toEqual({
      weighing: 'ok',
      heartbeat: 200,
      heartbeatWaited: true,
      heartbeatDoneBeforeCommit: false,
      otherWeighing: '422:EBMR-EXE-074',
    });
    expect(seen.otherWeighing).toMatch(/A scale of room DISP-1 is reporting its status at this moment/);
    // The heartbeat was written once the weighing had committed: the scale is online now, and hand-keyed weights are
    // refused again.
    expect(await statuses(rig)).toEqual([
      ['TEST-BAL-00', 'OFFLINE'],
      ['TEST-BAL-01', 'ONLINE'],
    ]);
    expect(outcomeOf(await other.command('operator2', handKeyed))).toBe('422:EBMR-EXE-074');
    expect(await violations(rig.server)).toEqual([]);
  }, 300_000);
});

/** The execution rows' count of a run. */
async function rowCount(runId: string): Promise<number> {
  return (await rowsOf(rig.server, runId)).length;
}

async function alarms(code: string): Promise<number> {
  const { rows } = await rig.server.db.admin.query<{ n: number }>('select count(*)::int as n from tab.device_alarm where code = $1', [code]);
  return rows[0]?.n ?? 0;
}

/** What the gate recorded with the run's hand-keyed weighings (tab.manual_weighing_basis), with the row each belongs to. */
async function basisOf(runId: string): Promise<{ seq: string; source: string; room: string; scales: Record<string, unknown>[] }[]> {
  const { rows } = await rig.server.db.admin.query<{ seq: string; source: string; room: string; scales: Record<string, unknown>[] }>(
    `select b.row_seq::text as seq, c.command -> 'entry' ->> 'source' as source, b.room_code as room, b.scales
       from tab.manual_weighing_basis b join recipe.execution_command c on c.batch_id = b.batch_id and c.seq = b.row_seq
      where b.batch_id = $1 order by b.row_seq`,
    [runId],
  );
  return rows;
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

/** The heartbeat body TEST-BAL-01 in `state`, as tab.record_heartbeat takes it. */
const HEARTBEAT_SQL = 'select tab.record_heartbeat($1::jsonb)';
const bal01Heartbeat = (state: 'ONLINE' | 'OFFLINE'): string =>
  JSON.stringify({ gatewayTimeUs: '1', devices: [{ deviceCode: 'TEST-BAL-01', state, serial: state === 'ONLINE' ? 'SIM-0001' : null, notReady: null }], journal: { lastSeq: '0', ackedSeq: '0' } });

/** Installs `actor`'s context in the transaction of `c` (a later command of the same transaction). */
async function switchTo(c: { query(sql: string, params: unknown[]): Promise<unknown> }, actor: ActorContext): Promise<void> {
  await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext({ ...actor, correlationId: randomUUID() }))]);
}

/** The database's refusal of a weight keyed by hand while the report that the scale cannot be used is too young (group 1: that report). */
const YOUNG_REPORT = /Scale TEST-BAL-01 of room DISP-1 is online by its heartbeat\. The report that it cannot be used \((.+)\) was made in this transaction or less than 10 seconds before it began, so it does not open the manual path yet.*\[EBMR-EXE-074\]$/;
/** The same refusal as the server answers it (the code is the refusal's, not part of `why`). */
const YOUNG_REPORT_WHY = /^Scale TEST-BAL-01 of room DISP-1 is online by its heartbeat\. The report that it cannot be used \(the server cannot reach the site gateway's API \(test: the API does not answer\)\) was made in this transaction or less than 10 seconds before it began/;
const BESIDE: Readonly<Record<string, 'ONLINE' | 'OFFLINE'>> = { 'TEST-BAL-00': 'OFFLINE', 'TEST-BAL-01': 'ONLINE' };

describe('review P50/P51, round-3 verification: the gate opens only on reports committed before the weighing and standing for the heartbeat window (tablets 0340)', () => {
  // One run at the paracetamol weighing for the whole group (each run costs the kiosk some twenty device nonces, and the
  // server allows 120 a minute per terminal).
  let run: RunDriver | undefined;
  const pcmRun = async (): Promise<RunDriver> => {
    if (!run) {
      run = await newRun(rig);
      await reachPcm(run);
    }
    return run;
  };
  afterEach(async () => {
    // Whatever a failed case left behind: the API reachable again, both scales reported as the next case expects.
    await recordContact(rig, true, 'test: clean-up');
    await report(rig, BESIDE);
  });

  it('[PR-20][DI-30][DI-32] a report that the gateway API cannot be reached, made in the weighing\'s own transaction or less than the heartbeat window before it, never opens the manual path beside a scale whose heartbeat is ONLINE: refused (EBMR-EXE-074), nothing recorded', async () => {
    const d = await pcmRun();
    const monitor = await monitorActor(rig);
    const rowsBefore = await rowCount(d.runId);
    const alarmsBefore = { unreachable: await alarms('EBMR-DEV-071'), reachable: await alarms('EBMR-DEV-072') };

    // The skeptic's probe, with the monitor's own identity: unreachable, the weighing, reachable again, one transaction.
    await report(rig, BESIDE);
    expect(await statuses(rig)).toEqual([['TEST-BAL-00', 'OFFLINE'], ['TEST-BAL-01', 'ONLINE']]);
    expect(await forgedWeighing(rig, d)).toBe('EBMR-EXE-074');
    const toggled = await messageOf(
      forgedWeighingRow(rig, d, {
        before: {
          actor: monitor,
          work: async (c) => {
            expect((await c.query(RECORD_CONTACT_SQL, [false, 'test: reported in the weighing transaction'])).rows).toEqual([{ written: true }]);
          },
        },
        during: async (c) => {
          await switchTo(c, monitor);
          await c.query(RECORD_CONTACT_SQL, [true, 'test: reachable again']);
        },
      }),
    );
    expect(toggled).toMatch(YOUNG_REPORT);
    expect(YOUNG_REPORT.exec(toggled)?.[1]).toBe("the server cannot reach the site gateway's API (test: reported in the weighing transaction)");
    expect(await rowCount(d.runId)).toBe(rowsBefore);
    expect(await statuses(rig)).toEqual([['TEST-BAL-00', 'OFFLINE'], ['TEST-BAL-01', 'ONLINE']]);

    // A report committed just before the weighing: the scale is shown OFFLINE at once (a capture is refused), but the
    // manual path stays shut until the report has stood for the heartbeat window; also through the server.
    expect(await recordContact(rig, false, 'test: the API does not answer', monitor)).toBe(true);
    await report(rig, BESIDE);
    expect(await statuses(rig)).toEqual([['TEST-BAL-00', 'OFFLINE'], ['TEST-BAL-01', 'OFFLINE']]);
    const young = await messageOf(forgedWeighingRow(rig, d));
    expect(YOUNG_REPORT.exec(young)?.[1]).toBe("the server cannot reach the site gateway's API (test: the API does not answer)");
    const viaServer = await d.command('operator1', handKeyed);
    expect(outcomeOf(viaServer)).toBe('422:EBMR-EXE-074');
    expect(refusalOf(viaServer).why).toMatch(YOUNG_REPORT_WHY);
    expect(await rowCount(d.runId)).toBe(rowsBefore);
    expect(await basisOf(d.runId)).toEqual([]);

    expect(await recordContact(rig, true, 'test: the API answers', monitor)).toBe(true);
    expect(await statuses(rig)).toEqual([['TEST-BAL-00', 'OFFLINE'], ['TEST-BAL-01', 'ONLINE']]);
    // Only the committed episode left its alarms; the toggle rolled back with the refused weighing.
    expect({ unreachable: await alarms('EBMR-DEV-071'), reachable: await alarms('EBMR-DEV-072') }).toEqual({
      unreachable: alarmsBefore.unreachable + 1,
      reachable: alarmsBefore.reachable + 1,
    });
    await identity.endSession(rig.server.db.app, monitor.sessionId);
    expect(await violations(rig.server)).toEqual([]);
  }, 300_000);

  it('[DI-14][DI-17][DI-30] only the server\'s gateway API monitor records whether the gateway API is reached: outside a command, as the operator or as the gateway (built with the application role alone) the report is refused and nothing changes; the monitor\'s reports are audited under its name and their alarms carry its session', async () => {
    await report(rig, BESIDE);
    const contact = async () => (await rig.server.db.admin.query<{ reachable: boolean; detail: string; changed_at: string }>('select reachable, detail, changed_at::text from tab.gateway_api_contact')).rows;
    const before = { unreachable: await alarms('EBMR-DEV-071'), contact: await contact() };
    // operator1 in the group's run session on the DISP-1 kiosk (a new sign-in there would end that session).
    const operator = await actorOf(rig.server, (await pcmRun()).browser('operator1'), 'operator1');
    const refused = {
      noCommand: await codeOf(rig.server.db.app.query(RECORD_CONTACT_SQL, [false, 'test: no command'])),
      operator: await messageOf(withCommand(rig.server.db.app, operator, (c) => c.query(RECORD_CONTACT_SQL, [false, 'test: as the operator']))),
      gateway: await messageOf(withCommand(rig.server.db.app, await stolenGatewayActor(), (c) => c.query(RECORD_CONTACT_SQL, [false, 'test: as the gateway']))),
    };
    expect(refused.noCommand).toBe('EBMR-IAM-001');
    expect(refused.operator).toMatch(/EBMR-IAM-040 .* acting as OPERATOR lacks permission GATEWAY\.API_CONTACT_RECORD/);
    expect(refused.gateway).toMatch(/EBMR-IAM-040 .* acting as SITE_GATEWAY lacks permission GATEWAY\.API_CONTACT_RECORD/);
    expect({ unreachable: await alarms('EBMR-DEV-071'), contact: await contact() }).toEqual(before);
    expect(await statuses(rig)).toEqual([['TEST-BAL-00', 'OFFLINE'], ['TEST-BAL-01', 'ONLINE']]);

    // The monitor records both observations; each change is in the gateway key's audit chain under its name, and each
    // alarm carries its session.
    const monitor = await monitorActor(rig);
    expect(await recordContact(rig, false, 'test: monitor sees no answer', monitor)).toBe(true);
    expect(await recordContact(rig, false, 'test: monitor still sees no answer', monitor)).toBe(true);
    expect(await recordContact(rig, true, 'test: monitor sees an answer', monitor)).toBe(true);
    expect(await recordContact(rig, true, 'test: monitor sees an answer again', monitor)).toBe(false);
    const audit = await rig.server.db.admin.query<{ who: string; role: string; session: string; reachable: boolean; message: string }>(
      `select payload -> 'actor' ->> 'legal_name' as who, payload -> 'actor' ->> 'role_code' as role, payload -> 'actor' ->> 'session_id' as session,
              (payload -> 'body' -> 'details' ->> 'reachable')::boolean as reachable, payload -> 'body' ->> 'message' as message
         from kernel.audit_event where chain_key = $1 and action = 'BUSINESS' and payload -> 'actor' ->> 'session_id' = $2 order by id`,
      [`gateway_key:${rig.gw.login.chainId}`, monitor.sessionId],
    );
    expect(audit.rows).toEqual([
      { who: 'TEST-gw-monitor', role: 'GATEWAY_API_MONITOR', session: monitor.sessionId, reachable: false, message: 'The server cannot reach the API of gateway TEST-GW-01 (test: monitor sees no answer): its scales are shown offline' },
      { who: 'TEST-gw-monitor', role: 'GATEWAY_API_MONITOR', session: monitor.sessionId, reachable: true, message: 'The server reaches the API of gateway TEST-GW-01 again (test: monitor sees an answer): its scales follow their heartbeats again' },
    ]);
    expect((await rig.server.db.admin.query('select * from kernel.verify_chain($1)', [`gateway_key:${rig.gw.login.chainId}`])).rows).toEqual([]);
    const alarmSessions = await rig.server.db.admin.query<{ code: string; session_id: string }>(
      "select code, session_id from tab.device_alarm where code in ('EBMR-DEV-071', 'EBMR-DEV-072') order by id desc limit 2",
    );
    expect(alarmSessions.rows).toEqual([
      { code: 'EBMR-DEV-072', session_id: monitor.sessionId },
      { code: 'EBMR-DEV-071', session_id: monitor.sessionId },
    ]);
    await identity.endSession(rig.server.db.app, monitor.sessionId);
  }, 120_000);

  it('[PR-20][DI-30][DI-32] an unreachable report committed and standing for the heartbeat window opens the manual path beside a scale whose heartbeat is ONLINE, and the database records with the weighing the status and reason of every scale of the room it counted', async () => {
    const d = await pcmRun();
    const basisBefore = (await basisOf(d.runId)).length;
    await report(rig, BESIDE);
    const monitor = await monitorActor(rig);
    const rowsBefore = await rowCount(d.runId);
    expect(await recordContact(rig, false, 'test: the API has not answered for a while', monitor)).toBe(true);
    await standFor(rig, 10_500, BESIDE);

    expect(await forgedWeighing(rig, d)).toBe('ok');
    const rows = await rowsOf(rig.server, d.runId);
    expect(rows.length).toBe(rowsBefore + 1);
    const heartbeatUs = expect.stringMatching(/^[0-9]+$/) as unknown;
    expect((await basisOf(d.runId)).slice(basisBefore)).toEqual([
      {
        seq: rows.at(-1)?.seq,
        source: 'MANUAL',
        room: 'DISP-1',
        scales: [
          { deviceCode: 'TEST-BAL-00', gatewayCode: 'TEST-GW-01', status: 'OFFLINE', reason: 'the site gateway reports it OFFLINE', lastHeartbeatUs: heartbeatUs },
          { deviceCode: 'TEST-BAL-01', gatewayCode: 'TEST-GW-01', status: 'OFFLINE', reason: "the server cannot reach the site gateway's API (test: the API has not answered for a while)", lastHeartbeatUs: heartbeatUs },
        ],
      },
    ]);
    // The record is insert-only and in the batch's audit chain, under the weighing's actor; the application role
    // cannot write it.
    const audited = await rig.server.db.admin.query<{ who: string }>(
      "select payload -> 'actor' ->> 'legal_name' as who from kernel.audit_event where chain_key = $1 and table_name = 'tab.manual_weighing_basis' and action = 'INSERT' order by id",
      [`batch:${d.runId}`],
    );
    expect(audited.rows.slice(basisBefore)).toEqual([{ who: 'TEST-Priya Nair' }]);
    await expect(rig.server.db.admin.query("update tab.manual_weighing_basis set room_code = 'BLEND-1' where batch_id = $1", [d.runId])).rejects.toThrow();
    await expect(
      rig.server.db.app.query("insert into tab.manual_weighing_basis (batch_id, row_seq, room_code, scales) values ($1, 1, 'DISP-1', '[]')", [d.runId]),
    ).rejects.toThrow(/permission denied/);

    expect(await recordContact(rig, true, 'test: the API answers', monitor)).toBe(true);
    await identity.endSession(rig.server.db.app, monitor.sessionId);
    expect(await violations(rig.server)).toEqual([]);
  }, 300_000);

  it('[PR-20][DI-30][DI-31] a refused reading of the gateway\'s chain opens the manual path only once the refusal has stood for the heartbeat window; a refusal recorded in the weighing\'s own transaction never does', async () => {
    const d = await pcmRun();
    const basisBefore = (await basisOf(d.runId)).length;
    await report(rig, BESIDE);
    const rowsBefore = await rowCount(d.runId);
    const refusals = async () => (await rig.server.db.admin.query<{ n: number }>("select count(*)::int as n from tab.device_alarm where kind = 'READING_REFUSED'")).rows[0]?.n;
    const refusalsBefore = await refusals();

    // In the weighing's own transaction, recorded as the listener records a refusal (it needs a live gateway token).
    const tokenHash = createHash('sha256').update(rig.gw.token, 'utf8').digest('hex');
    const inTransaction = await messageOf(
      forgedWeighingRow(rig, d, {
        before: {
          work: async (c) => {
            await c.query('select tab.record_gateway_refusal($1, $2, $3, $4, $5, $6, $7::jsonb)', [tokenHash, 'TEST-GW-01', 'READING_REFUSED', 'EBMR-DEV-048', null, 'test: refused in the weighing transaction', '{}']);
          },
        },
      }),
    );
    expect(YOUNG_REPORT.exec(inTransaction)?.[1]).toBe('the server refused a reading of gateway TEST-GW-01 (EBMR-DEV-048) and has received none since, so no capture can reach it');
    expect(await refusals()).toBe(refusalsBefore);

    // A reading the server refuses (committed by the listener): OFFLINE at once, the manual path only 10 s later.
    const bad = await rig.gw.uplink([{ reading: rig.gw.next({ serial: 'SIM-9999' }) }]);
    expect(bad.body.refused?.code).toBe('EBMR-DEV-048');
    await report(rig, BESIDE);
    expect(await statuses(rig)).toEqual([['TEST-BAL-00', 'OFFLINE'], ['TEST-BAL-01', 'OFFLINE']]);
    expect(YOUNG_REPORT.exec(await messageOf(forgedWeighingRow(rig, d)))?.[1]).toMatch(/^the server refused a reading of gateway TEST-GW-01 \(EBMR-DEV-048\)/);
    expect(await rowCount(d.runId)).toBe(rowsBefore);

    await standFor(rig, 10_500, BESIDE);
    expect(await forgedWeighing(rig, d)).toBe('ok');
    expect((await basisOf(d.runId)).slice(basisBefore).map((b) => b.scales.map((x) => [x['deviceCode'], x['status'], x['reason']]))).toEqual([
      [
        ['TEST-BAL-00', 'OFFLINE', 'the site gateway reports it OFFLINE'],
        ['TEST-BAL-01', 'OFFLINE', 'the server refused a reading of gateway TEST-GW-01 (EBMR-DEV-048) and has received none since, so no capture can reach it'],
      ],
    ]);

    // A reading ingested again ends the hold (the gateway logs in again, as it does after a refusal).
    await rig.gw.close();
    rig.gw = await fakeGateway(rig.server);
    expect((await rig.gw.uplink([{ reading: rig.gw.next() }])).body.refused).toBeNull();
    await report(rig, BESIDE);
    expect(await statuses(rig)).toEqual([['TEST-BAL-00', 'OFFLINE'], ['TEST-BAL-01', 'ONLINE']]);
    expect(await violations(rig.server)).toEqual([]);
  }, 300_000);

  it('[PR-20][DI-30][DI-32] a heartbeat written in the weighing\'s own transaction under the live gateway session\'s actor (built with the application role alone), also inside a savepoint, never opens the manual path; the same heartbeat committed before the weighing is the gateway\'s report', async () => {
    const d = await pcmRun();
    await report(rig, BESIDE);
    const gw = await stolenGatewayActor();
    const rowsBefore = await rowCount(d.runId);
    const sameTransaction = /The status of scale TEST-BAL-01 of room DISP-1 was reported in the same transaction as this weight keyed by hand; the database takes a scale's status only from reports committed before.*\[EBMR-EXE-074\]$/;

    const plain = await messageOf(
      forgedWeighingRow(rig, d, {
        before: { actor: gw, work: async (c) => void (await c.query(HEARTBEAT_SQL, [bal01Heartbeat('OFFLINE')])) },
        during: async (c) => {
          await switchTo(c, gw);
          await c.query(HEARTBEAT_SQL, [bal01Heartbeat('ONLINE')]);
        },
      }),
    );
    const inSavepoint = await messageOf(
      forgedWeighingRow(rig, d, {
        before: {
          actor: gw,
          work: async (c) => {
            await c.query('savepoint heartbeat');
            await c.query(HEARTBEAT_SQL, [bal01Heartbeat('OFFLINE')]);
            await c.query('release savepoint heartbeat');
          },
        },
      }),
    );
    expect({ plain, inSavepoint }).toEqual({ plain: expect.stringMatching(sameTransaction) as unknown, inSavepoint: expect.stringMatching(sameTransaction) as unknown });
    expect(await rowCount(d.runId)).toBe(rowsBefore);
    expect(await statuses(rig)).toEqual([['TEST-BAL-00', 'OFFLINE'], ['TEST-BAL-01', 'ONLINE']]);

    // Control: the gateway reports TEST-BAL-01 OFFLINE in its own heartbeat, committed before the weighing.
    await report(rig, { 'TEST-BAL-00': 'OFFLINE', 'TEST-BAL-01': 'OFFLINE' });
    expect(await forgedWeighing(rig, d)).toBe('ok');
    expect(await rowCount(d.runId)).toBe(rowsBefore + 1);
    await report(rig, BESIDE);
    expect(await violations(rig.server)).toEqual([]);
  }, 300_000);
});
