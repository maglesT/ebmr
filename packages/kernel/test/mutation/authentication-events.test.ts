/**
 * Authentication events and sessions, guard by guard (SQL mutation group "authentication-events":
 * iam.consume_auth_event, iam.use_auth_event_for_command, iam.open_session and the iam.session
 * guard in kernel 0160). The module tests in identity/ and esig/ go through the signing function
 * and the TypeScript wrappers; these tests call the database functions where each rule is enforced
 * and assert every refusal by its stable EBMR code, which names the rule that refused.
 *
 * Controls: DI-14 (individually assigned accounts; one active shop-floor session per person; a line
 * display's read-only account is not its owner's working session), DI-18 (break-glass accounts act
 * only inside an approved window and never for a GMP command), DI-20 (registered, active devices
 * only), DI-38 (re-authentication and session rules; the signing event is the signer's own, bound
 * to the challenge, fresh and unused); invariants INV-10 (a signature consumes one unused
 * authentication event of the same person for its challenge) and INV-40 (every command on a shared
 * device carries a fresh authentication event of the person and account it is attributed to).
 *
 * Raw writes to iam.session run as the table owner (superuser) and are always rolled back: they
 * prove that the session guard holds for every writer, not only for the iam.* functions.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toDbContext, withCommand, type ActorContext } from '../../src/db/command.ts';
import { activateAccount, createAccount, issueInitialSecret, registerDevice, setDeviceStatus, type AccountKind } from '../../src/identity/admin.ts';
import { authenticate, changeSecret, type AuthPurpose } from '../../src/identity/authentication.ts';
import { openSession, sessionState } from '../../src/identity/sessions.ts';
import { asDefinerCommand, asSuperuserTransaction, asTimeTraveller, expectRefused } from '../identity/helpers.ts';
import {
  attestDevice,
  freshAuthEvent,
  SEED_SITE,
  seedActor,
  seedAdministration,
  seedAuthn,
  seedServiceActor,
  withFreshAuth,
  withReason,
  type SeedAdministration,
  type SeededActor,
} from '../identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';

let db: TestDatabase;
let adm: SeedAdministration;
beforeAll(async () => {
  db = await createTestDatabase();
  adm = await seedAdministration(db);
});
afterAll(async () => {
  await db.drop();
});

type Work<T> = Parameters<typeof withCommand<T>>[2];
const asAdmin = <T>(work: Work<T>) => withCommand(db.app, withReason(adm.admin), work);
const asOwner = <T>(work: Work<T>) => withCommand(db.app, withReason(adm.owner), work);
const hex = (n = 4): string => randomBytes(n).toString('hex');
const fingerprint = (): string => randomBytes(32).toString('hex');
const newPassword = (): string => `Mut-${randomBytes(9).toString('base64url')}`;
const command = (a: SeededActor, extra: Partial<ActorContext> = {}): ActorContext => ({ ...a, correlationId: randomUUID(), ...extra });

const passwordAuth = (login: string, secret: string, fp: string, purpose: AuthPurpose) =>
  authenticate(seedAuthn(db), { method: 'PASSWORD', identifier: login, secret, deviceFingerprint: fp, purpose });

/** Simulates the passage of time: the event was recorded `seconds` ago (setup only, triggers off). */
const ageEvent = (authEventId: string, seconds: number) =>
  asTimeTraveller(db, 'update iam.auth_event set recorded_at = clock_timestamp() - make_interval(secs => $2) where id = $1', [authEventId, seconds]);

const usesOf = async (authEventId: string): Promise<string[]> =>
  (await db.admin.query<{ use_kind: string }>('select use_kind from iam.auth_event_use where auth_event_id = $1 order by use_kind', [authEventId])).rows.map(
    (r) => r.use_kind,
  );

/** One statement that must be refused with `code`, inside a savepoint of an open transaction. */
async function refusedIn(c: pg.PoolClient, sql: string, params: unknown[], code: string): Promise<void> {
  await c.query('savepoint refused');
  try {
    await expectRefused(c.query(sql, params), code);
  } finally {
    await c.query('rollback to savepoint refused');
  }
}

/** A further account of an existing person, active, with an initial password (issued by the administrator). */
async function extraAccount(personId: string, kind: AccountKind, breakGlass = false): Promise<{ accountId: string; login: string; initial: string }> {
  const login = `mut-${kind.toLowerCase().slice(0, 8)}-${hex()}`;
  return asAdmin(async (c) => {
    const accountId = await createAccount(c, { personId, loginName: login, kind, breakGlass });
    await activateAccount(c, accountId);
    const { secret } = await issueInitialSecret(c, accountId, 'PASSWORD');
    return { accountId, login, initial: secret };
  });
}

/** Replaces an initial password through the real flow (a restricted CREDENTIAL_CHANGE event) and returns the new one. */
async function replaceInitial(login: string, initial: string, fp: string): Promise<string> {
  const ev = await passwordAuth(login, initial, fp, 'LOGIN');
  expect(ev.purpose).toBe('CREDENTIAL_CHANGE');
  const password = newPassword();
  await changeSecret(seedAuthn(db), { authEventId: ev.authEventId, kind: 'PASSWORD', newSecret: password, loginName: login });
  return password;
}

describe('iam.consume_auth_event: the signer\'s own event, made for a signature, bound to this challenge, fresh and unused (INV-10)', () => {
  let signer: SeededActor;
  beforeAll(async () => {
    signer = await seedActor(db, { roleCode: 'VERIFIER' });
  });

  const consume = (c: pg.PoolClient, authEventId: string, challengeId: string | null, maxAge: string | null = '120 seconds') =>
    c.query<{ r: Record<string, unknown> }>('select iam.consume_auth_event($1, $2, $3, $4::interval) as r', [authEventId, signer.personId, challengeId, maxAge]);
  const consumeIn = (authEventId: string, challengeId: string | null, maxAge: string | null = '120 seconds', extra: Partial<ActorContext> = {}) =>
    asDefinerCommand(db, command(signer, extra), async (c) => (await consume(c, authEventId, challengeId, maxAge)).rows[0]?.r);

  it('[INV-10][DI-38] an event made to attribute a command or to log in is never consumed for a signature', async () => {
    const tap = await freshAuthEvent(db, signer, 'COMMAND');
    await expectRefused(consumeIn(tap, null), 'EBMR-IAM-096', /not made for a signature/);
    const login = await freshAuthEvent(db, signer, 'LOGIN');
    await expectRefused(consumeIn(login, null), 'EBMR-IAM-096');
    expect(await usesOf(tap)).toEqual([]);
    expect(await usesOf(login)).toEqual([]);
  });

  it('[INV-10][DI-38] an event bound to one challenge is never consumed for another challenge', async () => {
    const challenge = randomUUID();
    const ev = await freshAuthEvent(db, signer, 'SIGNATURE', challenge);
    await expectRefused(consumeIn(ev, randomUUID()), 'EBMR-IAM-094', /another challenge/);
    await expectRefused(consumeIn(ev, null), 'EBMR-IAM-094');
    expect(await usesOf(ev)).toEqual([]);
    // Its own challenge consumes it.
    expect(await consumeIn(ev, challenge)).toMatchObject({ auth_event_id: ev, person_id: signer.personId, challenge_id: challenge });
    expect(await usesOf(ev)).toEqual(['SIGNATURE']);
  });

  it('[INV-10][DI-38] an event older than the signing window, or than the policy maximum that caps it, is refused', async () => {
    const challenge = randomUUID();
    const ev = await freshAuthEvent(db, signer, 'SIGNATURE', challenge);
    await ageEvent(ev, 30);
    await expectRefused(consumeIn(ev, challenge, '10 seconds'), 'EBMR-IAM-092', /too old/);
    // A caller that names no window gets none.
    await expectRefused(consumeIn(ev, challenge, null), 'EBMR-IAM-092');
    // A longer window never extends the policy maximum (authn.event_max_age_seconds, 120 s by default).
    const late = randomUUID();
    const old = await freshAuthEvent(db, signer, 'SIGNATURE', late);
    await ageEvent(old, 125);
    await expectRefused(consumeIn(old, late, '1 hour'), 'EBMR-IAM-092');
    expect(await usesOf(ev)).toEqual([]);
    expect(await usesOf(old)).toEqual([]);
    // Within both windows the same event is accepted.
    expect(await consumeIn(ev, challenge, '60 seconds')).toMatchObject({ auth_event_id: ev });
  });

  it('[INV-10][INV-40] an event that attributed a command in an earlier transaction is not consumed later, even under the same correlation ID', async () => {
    const challenge = randomUUID();
    const ev = await freshAuthEvent(db, signer, 'SIGNATURE', challenge);
    const correlationId = randomUUID();
    // The event attributes a command, which commits.
    await asDefinerCommand(db, command(signer, { authEventId: ev, correlationId }), (c) => c.query('select 1'));
    expect(await usesOf(ev)).toEqual(['COMMAND']);
    // A later transaction replays the correlation ID: that is another command, and the event is spent.
    await expectRefused(consumeIn(ev, challenge, '120 seconds', { correlationId }), 'EBMR-IAM-091', /already been used/);
    expect(await usesOf(ev)).toEqual(['COMMAND']);
  });

  it('[INV-10][INV-40] an event that attributed one command is not consumed for another command in the same transaction', async () => {
    const challenge = randomUUID();
    const ev = await freshAuthEvent(db, signer, 'SIGNATURE', challenge);
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(command(signer, { authEventId: ev })))]);
      await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(command(signer)))]);
      await expectRefused(consume(c, ev, challenge), 'EBMR-IAM-091');
    } finally {
      await c.query('rollback');
      c.release();
    }
  });
});

describe('break-glass account of a kiosk operator (DI-18, INV-40)', () => {
  let holder: SeededActor;
  let bgLogin: string;
  let bgPassword: string;
  let windowId: string;
  beforeAll(async () => {
    // A system administrator working at a shared kiosk, who also holds a sealed break-glass account.
    holder = await seedActor(db, { roleCode: 'SYSTEM_ADMINISTRATOR', deviceClass: 'SHARED', acknowledgeEsig: false });
    const bg = await extraAccount(holder.personId, 'HUMAN', true);
    bgLogin = bg.login;
    windowId = await withCommand(db.app, await withFreshAuth(db, holder), async (c) =>
      (await c.query<{ id: string }>("select iam.request_break_glass($1, 'restore of the kiosk configuration', 30) as id", [bg.accountId])).rows[0]?.id ?? '');
    await asOwner((c) => c.query('select iam.approve_break_glass($1)', [windowId]));
    bgPassword = await replaceInitial(bg.login, bg.initial, holder.seed.deviceFingerprint);
  });

  it('[INV-40][DI-14][DI-18] an authentication event of the same person\'s break-glass account never attributes a command of their personal account', async () => {
    const bgTap = await passwordAuth(bgLogin, bgPassword, holder.seed.deviceFingerprint, 'COMMAND');
    expect(bgTap.personId).toBe(holder.personId);
    await expectRefused(withCommand(db.app, command(holder, { authEventId: bgTap.authEventId }), (c) => c.query('select 1')), 'EBMR-IAM-122', /another person or account/);
    expect(await usesOf(bgTap.authEventId)).toEqual([]);
    // The holder's own badge tap on the same kiosk attributes the command.
    await withCommand(db.app, await withFreshAuth(db, holder), (c) => c.query('select 1'));
  });

  it('[DI-18] a break-glass login made inside the window opens no session once the window has closed', async () => {
    const login = await passwordAuth(bgLogin, bgPassword, holder.seed.deviceFingerprint, 'LOGIN');
    await asTimeTraveller(db, "update iam.break_glass_window set valid_to = clock_timestamp() - interval '1 second' where id = $1", [windowId]);
    await expectRefused(openSession(db.app, login.authEventId, holder.seed.deviceFingerprint), 'EBMR-IAM-130', /window has closed/);
    expect(await usesOf(login.authEventId)).toEqual([]);
    // The holder's own kiosk session is untouched by the refused login.
    expect(await sessionState(db.app, holder.sessionId)).toBe('ACTIVE');
  });
});

describe('iam.open_session', () => {
  it('[DI-20] a login event opens no session from an unregistered or a blocked device', async () => {
    const op = await seedActor(db, { acknowledgeEsig: false });
    const ev = await freshAuthEvent(db, op, 'LOGIN');
    await expectRefused(openSession(db.app, ev, fingerprint()), 'EBMR-IAM-070', /not registered or not active/);
    // The device is blocked after the authentication and before the session opens.
    await asAdmin((c) => setDeviceStatus(c, op.deviceId, 'BLOCKED', 'terminal reported missing'));
    await expectRefused(openSession(db.app, ev, op.seed.deviceFingerprint), 'EBMR-IAM-071', /not registered or not active/);
    expect(await usesOf(ev)).toEqual([]);
    expect((await db.app.query('select count(*)::int as n from iam.session where opened_by_auth_event = $1', [ev])).rows[0]).toEqual({ n: 0 });
    // Once the device is active again the same event opens its session.
    await asAdmin((c) => setDeviceStatus(c, op.deviceId, 'ACTIVE', 'found and inspected, seal intact'));
    const s = await openSession(db.app, ev, op.seed.deviceFingerprint);
    expect(s.deviceId).toBe(op.deviceId);
  });

  it('[DI-38][DI-14] a login event older than the authentication window opens no session', async () => {
    const op = await seedActor(db, { acknowledgeEsig: false });
    const stale = await freshAuthEvent(db, op, 'LOGIN');
    await ageEvent(stale, 121);
    await expectRefused(openSession(db.app, stale, op.seed.deviceFingerprint), 'EBMR-IAM-092', /too old/);
    expect(await usesOf(stale)).toEqual([]);
    // Within the window (authn.event_max_age_seconds, 120 s by default) it opens.
    const recent = await freshAuthEvent(db, op, 'LOGIN');
    await ageEvent(recent, 100);
    const s = await openSession(db.app, recent, op.seed.deviceFingerprint);
    expect(await sessionState(db.app, s.sessionId)).toBe('ACTIVE');
  });

  it('[DI-14] a line display\'s read-only login does not count as its owner\'s shop-floor session: the owner\'s kiosk session stays open', async () => {
    const op = await seedActor(db, { deviceClass: 'SHARED', acknowledgeEsig: false });
    const displayFp = fingerprint();
    const displayDevice = await asAdmin((c) =>
      registerDevice(c, { code: `LSD-${hex(3)}`, deviceClass: 'SHARED', site: SEED_SITE, fingerprint: displayFp, description: 'line status display' }));
    await attestDevice(db, displayDevice, 'SHARED');
    const display = await extraAccount(op.personId, 'READONLY_DISPLAY');
    const password = await replaceInitial(display.login, display.initial, displayFp);
    const login = await passwordAuth(display.login, password, displayFp, 'LOGIN');
    const s = await openSession(db.app, login.authEventId, displayFp);
    expect(await sessionState(db.app, s.sessionId)).toBe('ACTIVE');
    const { rows } = await db.app.query<{ id: string; personal: boolean; end_reason: string | null }>(
      'select id, personal, end_reason from iam.session where id in ($1, $2) order by opened_at', [op.sessionId, s.sessionId]);
    expect(rows).toEqual([
      { id: op.sessionId, personal: true, end_reason: null },
      { id: s.sessionId, personal: false, end_reason: null },
    ]);
    expect(await sessionState(db.app, op.sessionId)).toBe('ACTIVE');
    await withCommand(db.app, await withFreshAuth(db, op), (c) => c.query('select 1'));
  });

  it('[DI-16][DI-19] a login event made while the account was usable opens no session once the account is suspended or locked out', async () => {
    // Suspended after the authentication (the person still active, the account not locked).
    const suspended = await seedActor(db, { acknowledgeEsig: false });
    const early = await freshAuthEvent(db, suspended, 'LOGIN');
    await asAdmin((c) => c.query("select iam.suspend_account($1, 'under investigation')", [suspended.accountId]));
    await expectRefused(openSession(db.app, early, suspended.seed.deviceFingerprint), 'EBMR-IAM-103', /no longer active or is locked/);
    expect(await usesOf(early)).toEqual([]);

    // Locked out by failed attempts after the authentication (the account and the person still ACTIVE).
    const locked = await seedActor(db, { acknowledgeEsig: false });
    const login = await freshAuthEvent(db, locked, 'LOGIN');
    let lockedOut = false;
    for (let i = 0; i < 5 && !lockedOut; i++) {
      const failure = await passwordAuth(locked.seed.loginName, `wrong-${hex()}`, locked.seed.deviceFingerprint, 'LOGIN').then(
        () => ({ locked: false, accepted: true }),
        (e: unknown) => e as { locked?: boolean },
      );
      expect(failure).not.toHaveProperty('accepted');
      lockedOut = failure.locked === true;
    }
    expect(lockedOut).toBe(true);
    expect((await db.admin.query('select status from iam.account where id = $1', [locked.accountId])).rows).toEqual([{ status: 'ACTIVE' }]);
    await expectRefused(openSession(db.app, login, locked.seed.deviceFingerprint), 'EBMR-IAM-103', /no longer active or is locked/);
    expect(await usesOf(login)).toEqual([]);
    expect((await db.app.query('select count(*)::int as n from iam.session where opened_by_auth_event in ($1, $2)', [early, login])).rows[0]).toEqual({ n: 0 });

    // Unlocked by the administrator, the account logs in again.
    await asAdmin((c) => c.query("select iam.unlock_account($1, 'identity confirmed in person')", [locked.accountId]));
    const again = await freshAuthEvent(db, locked, 'LOGIN');
    const s = await openSession(db.app, again, locked.seed.deviceFingerprint);
    expect(await sessionState(db.app, s.sessionId)).toBe('ACTIVE');
  });

  it('[DI-19][DI-20] a login holds its own account and terminal until it commits, and nothing else: a change to another person\'s account or terminal never holds it up', async () => {
    const op = await seedActor(db, { acknowledgeEsig: false });
    const other = await seedActor(db, { acknowledgeEsig: false });
    const ev = await freshAuthEvent(db, op, 'LOGIN');
    const changer = await db.admin.connect();
    const opener = await db.app.connect();
    /** Would a change of the row (a suspension, a lockout, a block: FOR NO KEY UPDATE) have to wait? */
    const changeWaits = async (table: 'iam.account' | 'iam.device', id: string): Promise<boolean> => {
      await changer.query('begin');
      try {
        await changer.query(`select 1 from ${table} where id = $1 for no key update nowait`, [id]);
        return false;
      } catch (error) {
        if ((error as { code?: string }).code === '55P03') return true;
        throw error;
      } finally {
        await changer.query('rollback');
      }
    };
    try {
      // Another person's account and terminal are being changed, uncommitted (as a lockout of that
      // account or a block of that terminal would hold them).
      await changer.query('begin');
      await changer.query('select 1 from iam.account where id = $1 for update', [other.accountId]);
      await changer.query('select 1 from iam.device where id = $1 for update', [other.deviceId]);
      // The login does not wait for them: a wait would end in the lock timeout (55P03) instead.
      await opener.query('begin');
      await opener.query("set local lock_timeout = '3s'");
      const s = await openSession(opener, ev, op.seed.deviceFingerprint);
      await changer.query('rollback');
      // Until the login commits, a change of its own account or terminal waits for it.
      expect(await changeWaits('iam.account', op.accountId)).toBe(true);
      expect(await changeWaits('iam.device', op.deviceId)).toBe(true);
      expect(await changeWaits('iam.account', other.accountId)).toBe(false);
      expect(await changeWaits('iam.device', other.deviceId)).toBe(false);
      await opener.query('commit');
      expect(await sessionState(db.app, s.sessionId)).toBe('ACTIVE');
    } finally {
      for (const c of [changer, opener]) {
        await c.query('rollback').catch(() => undefined);
        c.release();
      }
    }
  });

  it('[DI-14] a service identity\'s session is never a person\'s personal session', async () => {
    const svc = await seedServiceActor(db);
    const op = await seedActor(db, { acknowledgeEsig: false });
    const { rows } = await db.app.query<{ id: string; personal: boolean }>('select id, personal from iam.session where id in ($1, $2)', [svc.sessionId, op.sessionId]);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.personal]))).toEqual({ [svc.sessionId]: false, [op.sessionId]: true });
  });
});

describe('the iam.session guard: every writer, including the table owner', () => {
  const COLS = 'account_id, person_id, device_id, device_class, site_code, room_code, opened_by_auth_event, idle_timeout_seconds, absolute_timeout_seconds, personal';
  const copyOf = (extraCols = '', extraValues = '') =>
    `insert into iam.session (${COLS}${extraCols}) select ${COLS}${extraValues} from iam.session where id = $1 returning id`;

  it('[DI-38][DI-14] a session is recorded open and unlocked: no writer inserts one already locked or ended', async () => {
    const op = await seedActor(db, { acknowledgeEsig: false });
    await asSuperuserTransaction(db, async (c) => {
      await refusedIn(c, copyOf(', locked_at', ', clock_timestamp()'), [op.sessionId], 'EBMR-IAM-080');
      await refusedIn(c, copyOf(', ended_at, end_reason', ", clock_timestamp(), 'LOGOUT'"), [op.sessionId], 'EBMR-IAM-080');
      await refusedIn(c, copyOf(', locked_at, ended_at, end_reason', ", clock_timestamp(), clock_timestamp(), 'LOGOUT'"), [op.sessionId], 'EBMR-IAM-080');
      // The same row, open and unlocked, is accepted: the refusals are about the lock and end fields.
      expect((await c.query(copyOf(), [op.sessionId])).rowCount).toBe(1);
    });
  });

  it('[DI-38][DI-14] a session changes only its lock state and ends once, at server time; every other field is fixed', async () => {
    const op = await seedActor(db, { acknowledgeEsig: false });
    const otherEvent = await freshAuthEvent(db, op, 'LOGIN');
    const fixed: [string, unknown[]][] = [
      ['id = gen_random_uuid()', []],
      ['account_id = $2', [adm.admin.accountId]],
      ['person_id = $2', [adm.admin.personId]],
      ['device_id = $2', [adm.admin.deviceId]],
      ["device_class = 'SHARED'", []],
      ["site_code = 'SITE-2'", []],
      ["room_code = 'ROOM-Z9'", []],
      ['personal = not personal', []],
      ['opened_by_auth_event = $2', [otherEvent]],
      ["opened_at = opened_at - interval '1 hour'", []],
      ['idle_timeout_seconds = idle_timeout_seconds + 60', []],
      ['absolute_timeout_seconds = absolute_timeout_seconds + 60', []],
    ];
    await asSuperuserTransaction(db, async (c) => {
      const before = await c.query('select * from iam.session where id = $1', [op.sessionId]);
      expect(before.rows[0]).toMatchObject({ device_class: 'PERSONAL', room_code: null, personal: true, locked_at: null, ended_at: null });
      for (const [set, params] of fixed) await refusedIn(c, `update iam.session set ${set} where id = $1`, [op.sessionId, ...params], 'EBMR-IAM-081');
      // Locking and unlocking are the changes an open session allows.
      await c.query('update iam.session set locked_at = clock_timestamp() where id = $1', [op.sessionId]);
      await c.query('update iam.session set locked_at = null where id = $1', [op.sessionId]);
      // Ending records the server's time, whatever the writer supplies.
      await c.query("update iam.session set ended_at = '2000-01-01T00:00:00Z', end_reason = 'LOGOUT' where id = $1", [op.sessionId]);
      const ended = await c.query('select ended_at >= now() as server_time, end_reason from iam.session where id = $1', [op.sessionId]);
      expect(ended.rows[0]).toEqual({ server_time: true, end_reason: 'LOGOUT' });
      // An ended session never changes again: no lock, no second end, no other reason.
      for (const set of ['locked_at = clock_timestamp()', 'ended_at = clock_timestamp()', "end_reason = 'ADMIN_TERMINATED'"]) {
        await refusedIn(c, `update iam.session set ${set} where id = $1`, [op.sessionId], 'EBMR-IAM-081');
      }
    });
  });
});
