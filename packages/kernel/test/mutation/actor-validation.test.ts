/**
 * The actor-context check behind every command, rule by rule (SQL mutation group "actor-validation":
 * kernel.validate_actor_context, kernel 0190). The module tests in identity/ reach most refusals
 * through the normal life cycle, where an earlier rule often refuses first (a locked account's
 * sessions are already ended, and so are a blocked device's). These tests arrange the states in
 * which the rule under test is the only one that can refuse, and assert each refusal by its stable
 * EBMR code, which names the rule that refused.
 *
 * Controls: DI-14 (every GMP action needs an individually assigned, authenticated, active account
 * in its own live session), DI-16 (a leaver cannot act), DI-19 (a locked account cannot act until an
 * administrator unlocks it), DI-20 (registered, active devices only); invariant INV-40 (an
 * authentication event that attributes a command is the person's own, fresh and used once).
 *
 * Two of the states come from races between transactions the product can run at the same time: a
 * login that is opening its session while the account locks, or while its terminal is blocked. The
 * tests drive each race with explicit transactions. They never assert that the session survives the
 * race; they assert only that no command can run in it, whichever way the race ends.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { deactivateAccount, registerDevice, setDeviceStatus } from '../../src/identity/admin.ts';
import { authenticate, type AuthPurpose } from '../../src/identity/authentication.ts';
import { ebmrCode } from '../../src/identity/errors.ts';
import { openSession, sessionState } from '../../src/identity/sessions.ts';
import { asDefinerCommand, asTimeTraveller, expectRefused, pause } from '../identity/helpers.ts';
import { freshAuthEvent, SEED_SITE, seedActor, seedAdministration, seedAuthn, withReason, type SeedAdministration, type SeededActor } from '../identity/seed.ts';
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
const hex = (n = 4): string => randomBytes(n).toString('hex');
const fingerprint = (): string => randomBytes(32).toString('hex');
const command = (a: SeededActor, extra: Partial<ActorContext> = {}): ActorContext => ({ ...a, correlationId: randomUUID(), ...extra });
const insert = (ctx: ActorContext) =>
  withCommand(db.app, ctx, (c) => c.query('insert into testgmp.sample (batch_id, value) values ($1, 1)', [randomUUID()]));

const passwordAuth = (a: SeededActor, purpose: AuthPurpose, opts: { fp?: string; secret?: string } = {}) =>
  authenticate(seedAuthn(db), {
    method: 'PASSWORD', identifier: a.seed.loginName, secret: opts.secret ?? a.seed.password,
    deviceFingerprint: opts.fp ?? a.seed.deviceFingerprint, purpose,
  });

const policyInt = async (key: string): Promise<number> =>
  Number((await db.admin.query<{ n: string }>('select iam.policy_int($1) as n', [key])).rows[0]?.n);

const accountLocked = async (accountId: string): Promise<boolean> =>
  (await db.admin.query<{ l: boolean }>('select iam.account_locked($1) as l', [accountId])).rows[0]?.l ?? false;

/** Waits until the backend `pid` is waiting for a lock (a row another transaction holds). */
async function untilWaitingForLock(pid: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const { rows } = await db.admin.query<{ w: string | null }>('select wait_event_type as w from pg_stat_activity where pid = $1', [pid]);
    if (rows[0]?.w === 'Lock') return;
    await pause(25);
  }
  throw new Error(`backend ${pid} never waited for a lock`);
}

/**
 * A login that opens its session while `during` runs in other transactions. The session is opened
 * in a transaction that stays open until `during` has finished (or, if `during` itself has to wait
 * for that transaction, for at most three seconds). With `pauseAtDevice`, a third transaction holds
 * the terminal's registry row, so the login stops after its account checks, at the session's device
 * reference, and `during` runs inside that window. Returns the session, or null when the login was
 * refused.
 */
async function openSessionDuring(actor: SeededActor, loginEventId: string, during: () => Promise<unknown>, pauseAtDevice: boolean): Promise<string | null> {
  const holder = pauseAtDevice ? await db.admin.connect() : undefined;
  const opener = await db.app.connect();
  try {
    if (holder) {
      await holder.query('begin');
      await holder.query('select 1 from iam.device where id = $1 for update', [actor.deviceId]);
    }
    await opener.query('begin');
    const pid = (await opener.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]?.pid ?? 0;
    const opening = openSession(opener, loginEventId, actor.seed.deviceFingerprint).then(
      (s): string | null => s.sessionId,
      (error: unknown) => {
        if (ebmrCode(error) === undefined) throw error;
        return null;
      },
    );
    opening.catch(() => undefined);
    if (holder) await untilWaitingForLock(pid);
    else await opening;
    const other = during();
    await Promise.race([other.then(() => undefined, () => undefined), pause(3000)]);
    await holder?.query('rollback');
    const sessionId = await opening;
    await opener.query('commit');
    await other;
    return sessionId;
  } catch (error) {
    await opener.query('rollback').catch(() => undefined);
    await holder?.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    opener.release();
    holder?.release();
  }
}

/** No command can run in `sessionId`: refused as ended if the session was swept, otherwise with `code`. */
async function expectNoCommandIn(actor: SeededActor, sessionId: string | null, code: string): Promise<void> {
  if (sessionId === null) return; // the login itself was refused: there is no session to act in
  const expected = (await sessionState(db.app, sessionId)) === 'ENDED' ? 'EBMR-IAM-112' : code;
  await expectRefused(insert(command(actor, { sessionId })), expected);
}

describe('kernel.validate_actor_context: the person and the account (DI-14, DI-16, DI-19)', () => {
  it('[DI-16][DI-14] a person recorded as LEFT cannot act, even when a direct write left their account and session live', async () => {
    const op = await seedActor(db, { acknowledgeEsig: false });
    await insert(command(op));
    // A direct write by the table owner that bypasses iam.process_leaver: the person is LEFT, but the
    // account was not disabled and the session was not ended. The directory scan reports the state
    // as a finding; the command gate must refuse the person on its own.
    await asDefinerCommand(db, withReason(adm.admin), (c) => c.query("update iam.person set status = 'LEFT' where id = $1", [op.personId]));
    const scan = await db.app.query<{ finding: string }>('select finding from iam.directory_scan() where person_id = $1', [op.personId]);
    expect(scan.rows).toContainEqual({ finding: 'LEFT_PERSON_WITH_LIVE_ACCOUNT' });
    expect(await sessionState(db.app, op.sessionId)).toBe('ACTIVE');
    await expectRefused(insert(command(op)), 'EBMR-IAM-104');
    // Correcting the account removes the finding; the account is then refused as disabled.
    await asAdmin((c) => deactivateAccount(c, op.accountId, 'person left; account disabled after the directory scan finding'));
    expect((await db.app.query('select 1 from iam.directory_scan() where person_id = $1', [op.personId])).rowCount).toBe(0);
    await expectRefused(insert(command(op)), 'EBMR-IAM-103');
  });

  it('[DI-19][DI-14] a locked account cannot act, and the refusal names the lock (an administrator must unlock it; a new login is refused too)', async () => {
    const op = await seedActor(db, { acknowledgeEsig: false });
    await insert(command(op));
    const threshold = await policyInt('authn.lockout_threshold');
    for (let i = 1; i <= threshold; i++) {
      await expect(passwordAuth(op, 'LOGIN', { secret: 'wrong-password' })).rejects.toMatchObject({ reason: 'WRONG_SECRET', locked: i === threshold });
    }
    expect(await accountLocked(op.accountId)).toBe(true);
    await expectRefused(insert(command(op)), 'EBMR-IAM-105');
    await expect(passwordAuth(op, 'LOGIN')).rejects.toMatchObject({ reason: 'ACCOUNT_LOCKED' });
  });

  it('[DI-19][DI-14] a login that races the lockout gives no way to act: a session that escaped the sweep is refused as locked', async () => {
    const op = await seedActor(db, { acknowledgeEsig: false });
    // The failed attempts come from a second registered workstation of the same person.
    const fp2 = fingerprint();
    await asAdmin((c) =>
      registerDevice(c, { code: `PC-${hex()}`, deviceClass: 'PERSONAL', site: SEED_SITE, fingerprint: fp2, description: 'second workstation' }));
    const threshold = await policyInt('authn.lockout_threshold');
    const login = await passwordAuth(op, 'LOGIN');
    const fresh = await openSessionDuring(op, login.authEventId, async () => {
      for (let i = 1; i <= threshold; i++) {
        await expect(passwordAuth(op, 'LOGIN', { fp: fp2, secret: 'wrong-password' })).rejects.toMatchObject({ reason: 'WRONG_SECRET' });
      }
    }, true);

    expect(await accountLocked(op.accountId)).toBe(true);
    expect(await sessionState(db.app, op.sessionId)).toBe('ENDED');
    await expectNoCommandIn(op, fresh, 'EBMR-IAM-105');
  });
});

describe('kernel.validate_actor_context: the session device (DI-20)', () => {
  it('[DI-20][DI-14] a login that races the blocking of its terminal gives no way to act: a session that escaped the sweep is refused on the blocked device', async () => {
    const op = await seedActor(db, { acknowledgeEsig: false });
    const login = await passwordAuth(op, 'LOGIN');
    // An administrator blocks the terminal while the login is opening its session; the block ends
    // every session of the terminal it can see.
    const fresh = await openSessionDuring(op, login.authEventId, () => asAdmin((c) => setDeviceStatus(c, op.deviceId, 'BLOCKED', 'suspected tampering')), false);

    expect((await db.app.query('select status from iam.device where id = $1', [op.deviceId])).rows[0]).toEqual({ status: 'BLOCKED' });
    expect(await sessionState(db.app, op.sessionId)).toBe('ENDED');
    await expectNoCommandIn(op, fresh, 'EBMR-IAM-115');
  });
});

describe('kernel.validate_actor_context: an authentication event on a personal device (DI-14, INV-40)', () => {
  it('[DI-14][INV-40] a command on a personal device may carry an authentication event: it is checked, recorded and consumed as on a shared one', async () => {
    const op = await seedActor(db, { acknowledgeEsig: false });
    const colleague = await seedActor(db, { acknowledgeEsig: false });

    const ev = await freshAuthEvent(db, op);
    const ctx = command(op, { authEventId: ev });
    await insert(ctx);
    const log = await db.admin.query('select account_id, session_id, auth_event_id from iam.command_log where correlation_id = $1', [ctx.correlationId]);
    expect(log.rows).toEqual([{ account_id: op.accountId, session_id: op.sessionId, auth_event_id: ev }]);
    const uses = await db.admin.query('select use_kind, session_id from iam.auth_event_use where auth_event_id = $1', [ev]);
    expect(uses.rows).toEqual([{ use_kind: 'COMMAND', session_id: op.sessionId }]);
    // Used once: it cannot attribute another command.
    await expectRefused(insert(command(op, { authEventId: ev })), 'EBMR-IAM-126');

    // Another person's event, or an event older than authn.event_max_age_seconds, is refused and not consumed.
    const foreign = await freshAuthEvent(db, colleague);
    await expectRefused(insert(command(op, { authEventId: foreign })), 'EBMR-IAM-122');
    const stale = await freshAuthEvent(db, op);
    const maxAge = await policyInt('authn.event_max_age_seconds');
    await asTimeTraveller(db, 'update iam.auth_event set recorded_at = clock_timestamp() - make_interval(secs => $2) where id = $1', [stale, maxAge + 1]);
    await expectRefused(insert(command(op, { authEventId: stale })), 'EBMR-IAM-125');
    expect((await db.admin.query('select 1 from iam.auth_event_use where auth_event_id = any ($1::uuid[])', [[foreign, stale]])).rowCount).toBe(0);
  });
});
