/**
 * Review finding P49 (module C5; DI-20, INV-40): tab.claim_readings compared the instrument's registered room with
 * p_room, a plain argument from the application, and never with the room of the validated actor's session. The
 * kernel's scope rules take the location of a point-of-work action from the session (the room of the enrolled
 * terminal when the session opened), never from the caller, and the rule must hold when the application's database
 * credentials are misused. The claim now takes the room from the session; p_room must name that same room.
 *
 * Round-1 verification (tablets 0320): the durable alert of a refused claim compared the balance's room with the room
 * the caller named, so a claim through the port that named the balance's own room from a session in another room was
 * refused without any alert, and the application role could raise such alerts at will, with no session behind them.
 * Now, after the refused command rolls back, the port has a guarded command of its own run under the same actor, and
 * tab.alert_refused_claim takes the session, the person and the session's room from that validated actor. It alerts
 * both a balance outside the session's room and a claim that named another room than the session's, even for a
 * balance of the session's own room (the round-2 verification found the second case untested).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asAdmin, freshTap, openPersonaSession, openServiceSession } from '@ebmr/test-kit';
import { withActorCommand } from '../../src/platform/db/commands.ts';
import { startServer, type TestServer } from '../support/harness.ts';
import { enrol, fakeGateway, operatorActor, type FakeGateway } from './support.ts';

let server: TestServer;
let gw: FakeGateway;

async function ingest(overrides: Parameters<FakeGateway['next']>[0] = {}): Promise<string> {
  const r = gw.next(overrides);
  const res = await gw.uplink([{ reading: r, delayUs: '1000' }]);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body.refused, JSON.stringify(res.body.refused)).toBeNull();
  return r.readingId;
}

async function uses(id: string): Promise<{ room_code: string; session_id: string }[]> {
  return (await server.db.app.query<{ room_code: string; session_id: string }>('select room_code, session_id::text as session_id from tab.reading_use where reading_id = $1', [id])).rows;
}

async function locationAlerts(): Promise<number> {
  return asAdmin(server.database, async (c) =>
    Number((await c.query<{ n: string }>(`select count(*)::text as n from iam.security_alert where kind = 'DEVICE_LOCATION_MISMATCH'`)).rows[0]?.n),
  );
}

beforeAll(async () => {
  server = await startServer('SANDBOX');
  await enrol(server);
  gw = await fakeGateway(server);
}, 180_000);

afterAll(async () => {
  await gw?.close();
  await server?.close();
});

describe('P49: the reading claim takes the room from the actor\'s session, not from the caller (DI-20)', () => {
  it('[DI-20] a BLEND-1 kiosk session cannot claim a DISP-1 balance reading by naming room DISP-1', async () => {
    // Control: the DISP-1 operator on the DISP-1 kiosk claims a DISP-1 reading.
    const ok = await ingest();
    const op1 = await operatorActor(server, 'operator1');
    const claimed = await withActorCommand(server.db.app, op1, (c) => c.query("select tab.claim_readings(array[$1]::uuid[], 'DISP-1', 120000000, 'GROSS') as r", [ok]));
    expect(claimed.rowCount).toBe(1);
    expect(await uses(ok)).toEqual([{ room_code: 'DISP-1', session_id: op1.sessionId }]);

    // operator2's session is on the blending kiosk: its room, as the database knows it, is BLEND-1.
    const op2 = await operatorActor(server, 'operator2');
    const room = await asAdmin(server.database, (c) =>
      c.query<{ room_code: string | null; code: string }>('select s.room_code, d.code from iam.session s join iam.device d on d.id = s.device_id where s.id = $1', [op2.sessionId]),
    );
    expect(room.rows[0]).toEqual({ room_code: 'BLEND-1', code: 'TEST-KIOSK-BLEND-1' });

    // The application role, inside operator2's validated command with a fresh tap, names DISP-1 as the room.
    const id = await ingest();
    await expect(
      withActorCommand(server.db.app, op2, (c) => c.query("select tab.claim_readings(array[$1]::uuid[], 'DISP-1', 120000000, 'GROSS') as r", [id])),
    ).rejects.toThrow(/EBMR-DEV-103/);
    expect(await uses(id)).toEqual([]);
    // The reading is still unused: the DISP-1 operator can use it.
    await withActorCommand(server.db.app, await operatorActor(server, 'operator1'), (c) => c.query("select tab.claim_readings(array[$1]::uuid[], 'DISP-1', 120000000, 'GROSS')", [id]));
    expect((await uses(id)).map((u) => u.room_code)).toEqual(['DISP-1']);
  });

  it('[DI-20] the same through the DeviceReadingPort: a room other than the session\'s is refused, whatever the instrument\'s room', async () => {
    const id = await ingest();
    const op2 = await operatorActor(server, 'operator2');
    await expect(
      withActorCommand(server.db.app, op2, (c) => server.built.ctx.deviceReadings.claim(c, { readingIds: [id], room: 'DISP-1', maxAgeUs: 120_000_000n, purpose: 'GROSS' })),
    ).rejects.toThrow(/EBMR-DEV-103/);
    // The DISP-1 operator naming BLEND-1 (the room of no instrument of this reading, and not the session's) is refused too.
    const op1 = await operatorActor(server, 'operator1');
    await expect(
      withActorCommand(server.db.app, op1, (c) => server.built.ctx.deviceReadings.claim(c, { readingIds: [id], room: 'BLEND-1', maxAgeUs: 120_000_000n, purpose: 'GROSS' })),
    ).rejects.toThrow(/EBMR-DEV-103/);
    expect(await uses(id)).toEqual([]);
  });

  it('[DI-20] a session whose terminal has no room cannot claim, whatever room the caller names', async () => {
    const id = await ingest();
    // operator1 signed in on the office PC (TEST-PC-01, registered to no room).
    const pc = await openPersonaSession(server.db, server.seed, 'operator1', 'TEST-PC-01');
    await expect(
      withActorCommand(server.db.app, pc, (c) => c.query("select tab.claim_readings(array[$1]::uuid[], 'DISP-1', 120000000, 'GROSS')", [id])),
    ).rejects.toThrow(/EBMR-DEV-103/);
    expect(await uses(id)).toEqual([]);
  });

  it('[DI-20] no caller can attribute a refused claim to a session: the durable alert takes no session from the application', async () => {
    // After a refused claim rolls back, the database holds no evidence of which session made it. No alert function
    // takes a session, or the facts of the refusal, as an argument from the application role: the four-argument form
    // does not exist, and the 0250 three-argument form (the named room compared with the balance's) is no longer
    // executable by the application role (tablets 0320), which could raise such alerts at will.
    const id = await ingest();
    const op2 = await operatorActor(server, 'operator2');
    const alertsOf = (session: string) =>
      asAdmin(server.database, async (c) => Number((await c.query<{ n: string }>('select count(*)::text as n from iam.security_alert where session_id = $1', [session])).rows[0]?.n));
    const alarmsOf = (session: string) =>
      asAdmin(server.database, async (c) => Number((await c.query<{ n: string }>('select count(*)::text as n from tab.device_alarm where session_id = $1', [session])).rows[0]?.n));
    const [alertsBefore, alarmsBefore] = [await alertsOf(op2.sessionId), await alarmsOf(op2.sessionId)];
    await expect(
      server.db.app.query('select tab.alert_claim_refusal(array[$1]::uuid[], $2, $3, $4::uuid) as n', [id, 'DISP-1', 'EBMR-DEV-103', op2.sessionId]),
    ).rejects.toThrow(/does not exist|permission denied/);
    const unattributed = async () => (await server.db.app.query<{ n: string }>("select count(*)::text as n from tab.device_alarm where kind = 'CLAIM_REFUSED' and session_id is null")).rows[0]?.n;
    const unattributedBefore = await unattributed();
    await expect(server.db.app.query('select tab.alert_claim_refusal(array[$1]::uuid[], $2, $3) as n', [id, 'BLEND-1', 'EBMR-DEV-103'])).rejects.toThrow(/permission denied/);
    expect(await unattributed()).toBe(unattributedBefore);
    // The alert of tablets 0320 runs only inside a validated command of a person: not bare, not as the gateway.
    await expect(server.db.app.query("select tab.alert_refused_claim(array[$1]::uuid[], 'DISP-1')", [id])).rejects.toThrow(/EBMR-IAM-00[12]/);
    const gateway = { ...(await openServiceSession(server.db, server.seed, 'gateway')), correlationId: randomUUID() };
    await expect(withActorCommand(server.db.app, gateway, (c) => c.query("select tab.alert_refused_claim(array[$1]::uuid[], 'DISP-1')", [id]))).rejects.toThrow(/EBMR-(DEV-100|IAM-04[02])/);
    expect(await alertsOf(op2.sessionId)).toBe(alertsBefore);
    expect(await alarmsOf(op2.sessionId)).toBe(alarmsBefore);
    // In the product flow C3 names the room of the session's own terminal (roomOfStep), so a BLEND-1 session using
    // this DISP-1 balance names BLEND-1: refused and alerted durably through the port, attributed to that session.
    const before = await locationAlerts();
    await expect(
      withActorCommand(server.db.app, op2, (c) => server.built.ctx.deviceReadings.claim(c, { readingIds: [id], room: 'BLEND-1', maxAgeUs: 120_000_000n, purpose: 'GROSS' })),
    ).rejects.toThrow(/EBMR-DEV-103/);
    expect(await locationAlerts()).toBe(before + 1);
    expect(await alertsOf(op2.sessionId)).toBe(alertsBefore + 1);
    expect(await uses(id)).toEqual([]);
  });

  it('[DI-20][INV-40] a claim through the port that names the balance\'s own room from a session in another room raises a DEVICE_LOCATION_MISMATCH alert attributed from the validated actor, once per reading and session', async () => {
    const id = await ingest();
    const op2 = await operatorActor(server, 'operator2');
    const alertsOf = (session: string) =>
      asAdmin(server.database, async (c) =>
        (
          await c.query<{ kind: string; person_id: string; account_id: string; device_id: string; details: Record<string, unknown> }>(
            'select kind, person_id::text as person_id, account_id::text as account_id, device_id::text as device_id, details from iam.security_alert where session_id = $1 order by raised_at',
            [session],
          )
        ).rows,
      );
    const before = await locationAlerts();
    // operator2's session is on the BLEND-1 kiosk; the claim names DISP-1, the balance's own room.
    await expect(
      withActorCommand(server.db.app, op2, (c) => server.built.ctx.deviceReadings.claim(c, { readingIds: [id], room: 'DISP-1', maxAgeUs: 120_000_000n, purpose: 'GROSS' })),
    ).rejects.toThrow(/EBMR-DEV-103/);
    expect(await locationAlerts()).toBe(before + 1);
    const balance = await asAdmin(server.database, async (c) => (await c.query<{ id: string }>("select id::text as id from iam.device where code = 'TEST-BAL-01'")).rows[0]?.id);
    // The session, the person and the session's room come from the validated actor, the balance's room from the registry.
    expect(await alertsOf(op2.sessionId)).toEqual([
      {
        kind: 'DEVICE_LOCATION_MISMATCH',
        person_id: op2.personId,
        account_id: op2.accountId,
        device_id: balance,
        details: { reading_id: id, registered_room: 'DISP-1', session_room: 'BLEND-1', requested_room: 'DISP-1', status: 'ACTIVE' },
      },
    ]);
    const alarm = await server.db.app.query<{ code: string; session_id: string }>(
      "select code, session_id::text as session_id from tab.device_alarm where kind = 'CLAIM_REFUSED' and reading_id = $1",
      [id],
    );
    expect(alarm.rows).toEqual([{ code: 'EBMR-DEV-103', session_id: op2.sessionId }]);
    expect(await uses(id)).toEqual([]);
    // The same session tries again with a fresh tap: refused again, but no second alert for this reading (no flood).
    const again = { ...op2, authEventId: await freshTap(server.db, server.seed, 'operator2'), correlationId: randomUUID() };
    await expect(
      withActorCommand(server.db.app, again, (c) => server.built.ctx.deviceReadings.claim(c, { readingIds: [id], room: 'DISP-1', maxAgeUs: 120_000_000n, purpose: 'GROSS' })),
    ).rejects.toThrow(/EBMR-DEV-103/);
    expect(await locationAlerts()).toBe(before + 1);
  });

  it('[DI-20][INV-40] a claim through the port that names another room than the session\'s, for a balance of the session\'s own room, raises a DEVICE_LOCATION_MISMATCH alert once per reading and session; naming the session\'s room raises none', async () => {
    const id = await ingest(); // TEST-BAL-01, registered to DISP-1
    const op1 = await operatorActor(server, 'operator1'); // on the DISP-1 kiosk: the balance is of the session's own room
    const alertsOf = (reading: string) =>
      asAdmin(server.database, async (c) =>
        (
          await c.query<{ kind: string; session_id: string; person_id: string; details: Record<string, unknown> }>(
            "select kind, session_id::text as session_id, person_id::text as person_id, details from iam.security_alert where details ->> 'reading_id' = $1 order by raised_at",
            [reading],
          )
        ).rows,
      );
    const before = await locationAlerts();
    // The caller names BLEND-1 (not the session's room): refused for the room, and alerted although the balance is of
    // the session's room, because the claim named another.
    await expect(
      withActorCommand(server.db.app, op1, (c) => server.built.ctx.deviceReadings.claim(c, { readingIds: [id], room: 'BLEND-1', maxAgeUs: 120_000_000n, purpose: 'GROSS' })),
    ).rejects.toThrow(/EBMR-DEV-103/);
    expect(await locationAlerts()).toBe(before + 1);
    expect(await alertsOf(id)).toEqual([
      {
        kind: 'DEVICE_LOCATION_MISMATCH',
        session_id: op1.sessionId,
        person_id: op1.personId,
        details: { reading_id: id, registered_room: 'DISP-1', session_room: 'DISP-1', requested_room: 'BLEND-1', status: 'ACTIVE' },
      },
    ]);
    const alarm = await server.db.app.query<{ code: string; session_id: string; message: string }>(
      "select code, session_id::text as session_id, message from tab.device_alarm where kind = 'CLAIM_REFUSED' and reading_id = $1",
      [id],
    );
    expect(alarm.rows).toEqual([{ code: 'EBMR-DEV-103', session_id: op1.sessionId, message: expect.stringMatching(/the claim named room BLEND-1, not room DISP-1 of the session's terminal/) as unknown }]);
    // Again with a fresh tap in the same session: refused again, no second alert for this reading.
    const again = { ...op1, authEventId: await freshTap(server.db, server.seed, 'operator1'), correlationId: randomUUID() };
    await expect(
      withActorCommand(server.db.app, again, (c) => server.built.ctx.deviceReadings.claim(c, { readingIds: [id], room: 'BLEND-1', maxAgeUs: 120_000_000n, purpose: 'GROSS' })),
    ).rejects.toThrow(/EBMR-DEV-103/);
    expect(await locationAlerts()).toBe(before + 1);
    // Control: naming the session's room there is nothing to alert, and the claim itself is accepted.
    const other = await ingest();
    const control = { ...op1, authEventId: await freshTap(server.db, server.seed, 'operator1'), correlationId: randomUUID() };
    const alerted = await withActorCommand(server.db.app, control, async (c) => (await c.query<{ n: number }>("select tab.alert_refused_claim(array[$1]::uuid[], 'DISP-1') as n", [other])).rows[0]?.n);
    expect(alerted).toBe(0);
    const claimed = { ...op1, authEventId: await freshTap(server.db, server.seed, 'operator1'), correlationId: randomUUID() };
    await withActorCommand(server.db.app, claimed, (c) => server.built.ctx.deviceReadings.claim(c, { readingIds: [other], room: 'DISP-1', maxAgeUs: 120_000_000n, purpose: 'GROSS' }));
    expect(await uses(other)).toEqual([{ room_code: 'DISP-1', session_id: op1.sessionId }]);
    expect(await alertsOf(other)).toEqual([]);
    expect(await locationAlerts()).toBe(before + 1);
  });
});
