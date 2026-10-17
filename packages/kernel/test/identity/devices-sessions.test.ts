/**
 * Device registry and server-side sessions (DI-20; DI-14 attribution on shared terminals;
 * DI-16 session end on access changes).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { registerDevice, setDeviceStatus, setPolicy } from '../../src/identity/admin.ts';
import { authenticate } from '../../src/identity/authentication.ts';
import {
  assertDeviceLocation,
  deviceFingerprint,
  endSession,
  keepSessionAlive,
  lockSession,
  openSession,
  resolveDevice,
  sessionState,
  unlockSession,
} from '../../src/identity/sessions.ts';
import { ensureFixtureChangeRecord, underChange } from '../support/change-record.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { asTimeTraveller, expectRefused } from './helpers.ts';
import { attestDevice, freshAuthEvent, SEED_SITE, seedActor, seedAdministration, seedAuthn, withFreshAuth, withReason, type SeedAdministration, type SeededActor } from './seed.ts';

let db: TestDatabase;
let adm: SeedAdministration;
beforeAll(async () => {
  db = await createTestDatabase();
  await ensureFixtureChangeRecord(db);
  adm = await seedAdministration(db);
});
afterAll(async () => {
  await db.drop();
});

type Work<T> = Parameters<typeof withCommand<T>>[2];
const asAdmin = <T>(work: Work<T>) => withCommand(db.app, withReason(adm.admin), work);
const fingerprint = (): string => randomBytes(32).toString('hex');
const insert = (ctx: Parameters<typeof withCommand>[1], batch = randomUUID()) =>
  withCommand(db.app, ctx, (c) => c.query('insert into testgmp.sample (batch_id, value) values ($1, 1)', [batch]));
const passwordAuth = (a: SeededActor, purpose: 'LOGIN' | 'SESSION_UNLOCK', fp = a.seed.deviceFingerprint) =>
  authenticate(seedAuthn(db), { method: 'PASSWORD', identifier: a.seed.loginName, secret: a.seed.password, deviceFingerprint: fp, purpose });

describe('device registry (DI-20)', () => {
  it('[DI-20] data arriving from an unregistered device is rejected with an alert', async () => {
    const fp = fingerprint();
    await expectRefused(resolveDevice(db.app, fp), 'EBMR-IAM-070');
    const op = await seedActor(db, { acknowledgeEsig: false });
    await expect(passwordAuth(op, 'LOGIN', fp)).rejects.toMatchObject({ reason: 'UNREGISTERED_DEVICE' });
    const alerts = await db.app.query("select count(*)::int as n from iam.security_alert where kind = 'UNREGISTERED_DEVICE' and details ->> 'fingerprint' = $1", [fp]);
    expect(alerts.rows[0]).toEqual({ n: 2 });
  });

  it('[DI-20] data from a relocated balance is rejected with an alert until the registry is updated', async () => {
    const fp = fingerprint();
    const balance = await asAdmin((c) =>
      registerDevice(c, { code: `BAL-${randomBytes(3).toString('hex')}`, deviceClass: 'INSTRUMENT', site: SEED_SITE, room: 'DISP-1', fingerprint: fp, description: 'dispensing balance' }));
    expect(await resolveDevice(db.app, fp)).toMatchObject({ deviceId: balance, deviceClass: 'INSTRUMENT', roomCode: 'DISP-1' });
    await assertDeviceLocation(db.app, balance, 'DISP-1');
    await expectRefused(assertDeviceLocation(db.app, balance, 'DISP-2'), 'EBMR-IAM-073');
    const alert = await db.app.query<{ details: Record<string, unknown> }>("select details from iam.security_alert where device_id = $1 and kind = 'DEVICE_LOCATION_MISMATCH'", [balance]);
    expect(alert.rows[0]?.details).toMatchObject({ registered_room: 'DISP-1', requested_room: 'DISP-2' });
    await asAdmin((c) => c.query("select iam.relocate_device($1, 'DISP-2', null, 'moved to booth 2 under change control CC-17')", [balance]));
    await assertDeviceLocation(db.app, balance, 'DISP-2');
    await expectRefused(assertDeviceLocation(db.app, balance, 'DISP-1'), 'EBMR-IAM-073');
    // An instrument is a data source, never a terminal a person logs in on.
    const op = await seedActor(db, { acknowledgeEsig: false });
    await expect(passwordAuth(op, 'LOGIN', fp)).rejects.toMatchObject({ reason: 'DEVICE_CLASS_MISUSE' });
  });

  it('[DI-20] a stored weight carries the registry ID of its source balance, resolved by the server from the balance key', async () => {
    // Stand-in until Phase 2 data points (which store source_device_id): the gateway presents the
    // balance's key fingerprint, the server resolves and location-checks it, and the value is stored
    // with the registry ID; the terminal that committed it is in the audit actor.
    const fp = fingerprint();
    const balance = await asAdmin((c) =>
      registerDevice(c, { code: `BAL-${randomBytes(3).toString('hex')}`, deviceClass: 'INSTRUMENT', site: SEED_SITE, room: 'DISP-3', fingerprint: fp, description: 'balance B-17' }));
    const op = await seedActor(db, { roomCode: 'DISP-3', acknowledgeEsig: false });
    const source = await resolveDevice(db.app, fp);
    await assertDeviceLocation(db.app, source.deviceId, 'DISP-3');
    const batch = randomUUID();
    await withCommand(db.app, op, (c) => c.query("insert into testgmp.sample (batch_id, value, note) values ($1, 12.503, 'source_device:' || $2)", [batch, source.deviceId]));
    const { rows } = await db.app.query<{ note: string; terminal: string }>(
      "select s.note, e.payload -> 'actor' ->> 'device_id' as terminal from testgmp.sample s join kernel.audit_event e on e.chain_key = 'batch:' || s.batch_id where s.batch_id = $1",
      [batch],
    );
    expect(rows).toEqual([{ note: `source_device:${balance}`, terminal: op.deviceId }]);
    expect(deviceFingerprint(Buffer.from('certificate-der'))).toBe(createHash('sha256').update('certificate-der').digest('hex'));
  });

  it('[DI-20] every entry stores the server-derived device; a client-claimed device is refused', async () => {
    const op = await seedActor(db, { acknowledgeEsig: false });
    const other = await seedActor(db, { acknowledgeEsig: false });
    await expectRefused(insert({ ...op, deviceId: other.deviceId }), 'EBMR-IAM-116', /DI-20/);
    await expectRefused(insert({ ...op, deviceId: randomUUID() }), 'EBMR-IAM-116');
    const noDevice: ActorContext = { ...op };
    delete noDevice.deviceId;
    await expectRefused(insert(noDevice), 'EBMR-IAM-116');
    const batch = randomUUID();
    await insert(op, batch);
    const { rows } = await db.app.query("select payload -> 'actor' ->> 'device_id' as d from kernel.audit_event where chain_key = $1", [`batch:${batch}`]);
    expect(rows).toEqual([{ d: op.deviceId }]);
    const s = await db.app.query('select device_id, device_class, site_code from iam.session where id = $1', [op.sessionId]);
    expect(s.rows[0]).toEqual({ device_id: op.deviceId, device_class: 'PERSONAL', site_code: SEED_SITE });
  });

  it('[DI-20] blocked and decommissioned devices are refused and their sessions end', async () => {
    const op = await seedActor(db, { deviceClass: 'SHARED', acknowledgeEsig: false });
    await asAdmin((c) => setDeviceStatus(c, op.deviceId ?? '', 'BLOCKED', 'suspected tampering'));
    expect(await sessionState(db.app, op.sessionId)).toBe('ENDED');
    await expect(freshAuthEvent(db, op)).rejects.toMatchObject({ reason: 'DEVICE_BLOCKED' });
    await expectRefused(resolveDevice(db.app, op.seed.deviceFingerprint), 'EBMR-IAM-071');
    expect((await db.app.query("select count(*)::int as n from iam.security_alert where device_id = $1 and kind = 'BLOCKED_DEVICE_USE'", [op.deviceId])).rows[0]).toEqual({ n: 2 });
    await asAdmin((c) => setDeviceStatus(c, op.deviceId ?? '', 'ACTIVE', 'inspected, seal intact'));
    const ev = await passwordAuth(op, 'LOGIN');
    await openSession(db.app, ev.authEventId, op.seed.deviceFingerprint);
    await asAdmin((c) => setDeviceStatus(c, op.deviceId ?? '', 'DECOMMISSIONED', 'replaced'));
    await expectRefused(asAdmin((c) => setDeviceStatus(c, op.deviceId ?? '', 'ACTIVE', 'undo')), 'EBMR-IAM-071');
  });

  it('[DI-20] a Grade A/B terminal is bound to its room', async () => {
    await expect(asAdmin((c) => registerDevice(c, { code: `GAB-${randomBytes(3).toString('hex')}`, deviceClass: 'GRADE_A_B', site: SEED_SITE, fingerprint: fingerprint(), description: 'no room' }))).rejects.toThrow(/device_check/);
    const op = await seedActor(db, { deviceClass: 'GRADE_A_B', roomCode: 'FILL-A1', acknowledgeEsig: false });
    const s = await db.app.query('select room_code, device_class from iam.session where id = $1', [op.sessionId]);
    expect(s.rows[0]).toEqual({ room_code: 'FILL-A1', device_class: 'GRADE_A_B' });
    await assertDeviceLocation(db.app, op.deviceId ?? '', 'FILL-A1');
    await expectRefused(assertDeviceLocation(db.app, op.deviceId ?? '', 'FILL-A2'), 'EBMR-IAM-073');
  });
});

describe('sessions on shared terminals (DI-14)', () => {
  it('[DI-14] a kiosk session locks after the idle timeout and only its own person can unlock it', async () => {
    const op = await seedActor(db, { deviceClass: 'SHARED', acknowledgeEsig: false });
    const colleague = await seedActor(db, { deviceClass: 'SHARED', acknowledgeEsig: false });
    expect((await db.app.query('select idle_timeout_seconds from iam.session where id = $1', [op.sessionId])).rows[0]).toEqual({ idle_timeout_seconds: 300 });
    const pol = (v: string) => withCommand(db.app, underChange(withReason(adm.admin, 'POLICY_CHANGE')), (c) => setPolicy(c, 'session.idle_timeout_seconds.SHARED', v, 'test'));
    await expectRefused(pol('30'), 'EBMR-IAM-110');
    await expectRefused(pol('1000'), 'EBMR-IAM-110');
    await asTimeTraveller(db, "update iam.session_activity set last_activity_at = clock_timestamp() - interval '301 seconds' where session_id = $1", [op.sessionId]);
    expect(await sessionState(db.app, op.sessionId)).toBe('IDLE_LOCKED');
    await expectRefused(insert(await withFreshAuth(db, op)), 'EBMR-IAM-113');
    const intruder = await passwordAuth(colleague, 'SESSION_UNLOCK', op.seed.deviceFingerprint);
    await expectRefused(unlockSession(db.app, op.sessionId, intruder.authEventId), 'EBMR-IAM-084');
    const own = await passwordAuth(op, 'SESSION_UNLOCK');
    await unlockSession(db.app, op.sessionId, own.authEventId);
    await insert(await withFreshAuth(db, op));
    await lockSession(db.app, op.sessionId);
    await expectRefused(insert(await withFreshAuth(db, op)), 'EBMR-IAM-113');
    await expectRefused(unlockSession(db.app, op.sessionId, own.authEventId), 'EBMR-IAM-091');
    await unlockSession(db.app, op.sessionId, (await passwordAuth(op, 'SESSION_UNLOCK')).authEventId);
    await insert(await withFreshAuth(db, op));
  });

  it('[DI-14] one active shop-floor session per person: a login on another terminal ends the old one', async () => {
    const op = await seedActor(db, { deviceClass: 'SHARED', acknowledgeEsig: false });
    const fp2 = fingerprint();
    await attestDevice(db, await asAdmin((c) => registerDevice(c, { code: `KSK-${randomBytes(3).toString('hex')}`, deviceClass: 'SHARED', site: SEED_SITE, fingerprint: fp2, description: 'second kiosk' })), 'SHARED');
    const s2 = await openSession(db.app, (await passwordAuth(op, 'LOGIN', fp2)).authEventId, fp2);
    expect((await db.app.query('select end_reason from iam.session where id = $1', [op.sessionId])).rows[0]).toEqual({ end_reason: 'SUPERSEDED' });
    await expectRefused(insert(await withFreshAuth(db, op)), 'EBMR-IAM-112');
    const live = await db.app.query('select count(*)::int as n from iam.session where person_id = $1 and shop_floor and ended_at is null', [op.personId]);
    expect(live.rows[0]).toEqual({ n: 1 });
    expect(await sessionState(db.app, s2.sessionId)).toBe('ACTIVE');
  });

  it('[DI-14] the absolute timeout ends a session whatever its activity; logout ends it at once', async () => {
    const op = await seedActor(db, { acknowledgeEsig: false });
    await asTimeTraveller(db, "update iam.session set opened_at = clock_timestamp() - interval '12 hours 1 second' where id = $1", [op.sessionId]);
    expect(await sessionState(db.app, op.sessionId)).toBe('EXPIRED');
    await expectRefused(insert(op), 'EBMR-IAM-114');
    await expectRefused(unlockSession(db.app, op.sessionId, (await passwordAuth(op, 'SESSION_UNLOCK')).authEventId), 'EBMR-IAM-081');
    const s = await openSession(db.app, (await passwordAuth(op, 'LOGIN')).authEventId, op.seed.deviceFingerprint);
    const again = { ...op, sessionId: s.sessionId };
    await insert(again);
    await endSession(db.app, s.sessionId);
    await expectRefused(insert(again), 'EBMR-IAM-112');
  });

  it('[DI-14] extending a shop-floor session before the lock needs a badge tap of the session owner', async () => {
    const op = await seedActor(db, { deviceClass: 'SHARED', acknowledgeEsig: false });
    await expectRefused(keepSessionAlive(db.app, op.sessionId), 'EBMR-IAM-120');
    await keepSessionAlive(db.app, op.sessionId, await freshAuthEvent(db, op));
    const personal = await seedActor(db, { acknowledgeEsig: false });
    await keepSessionAlive(db.app, personal.sessionId);
  });

  it('[DI-14] a login event opens one session only, on the device where it was made, and never after the secret must change', async () => {
    const op = await seedActor(db, { acknowledgeEsig: false });
    const other = await seedActor(db, { acknowledgeEsig: false });
    const ev = await passwordAuth(op, 'LOGIN');
    await expectRefused(openSession(db.app, ev.authEventId, other.seed.deviceFingerprint), 'EBMR-IAM-095');
    await openSession(db.app, ev.authEventId, op.seed.deviceFingerprint);
    await expectRefused(openSession(db.app, ev.authEventId, op.seed.deviceFingerprint), 'EBMR-IAM-091');
    const tap = await authenticate(seedAuthn(db), { method: 'PASSWORD', identifier: op.seed.loginName, secret: op.seed.password, deviceFingerprint: op.seed.deviceFingerprint, purpose: 'COMMAND' });
    await expectRefused(openSession(db.app, tap.authEventId, op.seed.deviceFingerprint), 'EBMR-IAM-096');
  });
});

// Slice 6j mutation triage (iam.authn_resolve): the method and purpose rules are refused before anything else is looked
// up; nothing later checks the method of a login event (iam.open_session checks only its purpose), so these are the
// only place a badge tap is kept from opening a session.
describe('authentication methods and purposes (DI-14, DI-38)', () => {
  const tryAuth = (method: string, purpose: string, challengeId?: string) =>
    authenticate(seedAuthn(db), {
      method: method as 'PASSWORD', identifier: `nobody-${randomBytes(4).toString('hex')}`, secret: 'x', deviceFingerprint: randomBytes(32).toString('hex'),
      purpose: purpose as 'LOGIN', ...(challengeId ? { challengeId } : {}),
    });

  it('[DI-14][DI-38] a badge tap only attributes an entry; a service key only logs in; a signature needs two components; an unknown method or purpose is refused', async () => {
    for (const purpose of ['LOGIN', 'CREDENTIAL_CHANGE', 'SESSION_UNLOCK']) await expectRefused(tryAuth('BADGE_TAP', purpose), 'EBMR-IAM-096', /badge tap/);
    await expectRefused(tryAuth('BADGE_TAP', 'SIGNATURE', randomUUID()), 'EBMR-IAM-096', /badge tap/);
    for (const purpose of ['COMMAND', 'SESSION_UNLOCK']) await expectRefused(tryAuth('SERVICE_KEY', purpose), 'EBMR-IAM-096', /cannot be used/);
    await expectRefused(tryAuth('FINGERPRINT', 'LOGIN'), 'EBMR-IAM-096', /unknown authentication method or purpose/);
    await expectRefused(tryAuth('PASSWORD', 'ADMIN'), 'EBMR-IAM-096', /unknown authentication method or purpose/);
    await expectRefused(tryAuth('PASSWORD', 'SIGNATURE'), 'EBMR-IAM-094');
    await expectRefused(tryAuth('PASSWORD', 'LOGIN', randomUUID()), 'EBMR-IAM-094');
  });

  it('[DI-14][DI-38] an account without an active credential of the method is refused before any secret is compared, whatever the secret', async () => {
    // A shop-floor person with a badge and no PIN issued: no PIN credential to verify against.
    const op = await seedActor(db, { deviceClass: 'SHARED', withPin: false, acknowledgeEsig: false });
    let caught: unknown;
    try {
      await authenticate(seedAuthn(db), { method: 'BADGE_PIN', identifier: op.seed.badgeUid ?? '', secret: '000000', deviceFingerprint: op.seed.deviceFingerprint, purpose: 'COMMAND' });
    } catch (error) {
      caught = error;
    }
    expect(String((caught as Error | undefined)?.message)).toContain('NO_ACTIVE_PIN');
    const { rows } = await db.admin.query('select 1 from iam.auth_event where account_id = $1 and method = $2', [op.accountId, 'BADGE_PIN']);
    expect(rows).toEqual([]);
  });
});

