/**
 * Refused signings, their misuse findings and the self-service secret change, rule by rule (SQL mutation group
 * "signing-failure-and-reasons": esig.signing_misuse in kernel 0950 and iam.change_event_check in kernel 0990; the
 * group's third function, platform.guard_reason_given, has no survivor). The module tests in esig/ and identity/ go
 * through the signing ceremony and the authentication service; these tests put each rule at the one input where it
 * alone decides, and assert what it leaves behind: the logged failure with its misuse code (or none), the security
 * alert (or none), the refusal with its stable EBMR code, and nothing written after a refusal.
 *
 * Controls: DI-19 (the security unit is alerted on signing misuse the database itself finds, naming the person who
 * authenticated; the application can neither accuse anybody nor hide the evidence; a secret is changed only by its
 * owner, through an authentication made for that and holding the current secret of that kind), DI-15 (the change
 * that replaces an initial or reset secret), DI-38 (the components a signing needs come from its own signature type;
 * pre-signing is an authentication before the challenge); invariants INV-10 (one authentication of the signer for its
 * challenge) and INV-40 (an event attributes one command; only the command kernel.begin_command validated can claim
 * its use as the attempt's own, K2).
 *
 * States the product never produces by itself (an authentication recorded at the very instant of its challenge, an
 * authentication with the private component alone) are arranged with the superuser (asTimeTraveller, a synthetic
 * event); a context installed by module code inside a command is installed as the owner does it, through
 * kernel.set_actor_context. The rules themselves are always exercised through esig.record_signing_failure (as the
 * application calls it) and the authentication service.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toDbContext, withCommand, type ActorContext } from '../../src/db/command.ts';
import { addMeaningType, configureMeaningType } from '../../src/esig/catalogue.ts';
import { logSigningFailure } from '../../src/esig/signing.ts';
import { authenticate, changeSecret, type AuthPurpose } from '../../src/identity/authentication.ts';
import {
  asTimeTraveller,
  challengeFor,
  cmd,
  createStub,
  dbCount,
  ensureSealKey,
  expectRefused,
  qaApprover,
  run,
  setPolicy,
  signatureAuth,
  signStub,
  signWith,
  syntheticAuthEvent,
  testActor,
} from '../esig/helpers.ts';
import { seedAuthn, type SeededActor } from '../identity/seed.ts';
import { ensureFixtureChangeRecord, underChange } from '../support/change-record.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  await ensureFixtureChangeRecord(db);
  await ensureSealKey(db);
});

afterAll(async () => {
  await db.drop();
});

const RECORD = 'select esig.record_signing_failure($1, $2, $3, $4)';

/** The attempt's own command: its actor carries the signature authentication, which attributes it (INV-40, K2). */
async function attemptContext(op: SeededActor, authEventId: string): Promise<ActorContext> {
  return { ...(await cmd(db, op)), authEventId, correlationId: randomUUID() };
}

/** A signing refused before signing, logged inside its own command, as the ceremony does it (K2). */
async function refusedAttempt(op: SeededActor, challengeId: string, authEventId: string): Promise<void> {
  await withCommand(db.app, await attemptContext(op, authEventId), async (c) => {
    await c.query(RECORD, [challengeId, authEventId, 'ESIG_STUB_ORDER', 'ESIG_STUB_ORDER refused before signing (test)']);
  });
}

interface Logged {
  code: string;
  misuse: string | null;
  event: string | null;
}

async function logged(challengeId: string): Promise<Logged[]> {
  const { rows } = await db.admin.query<Logged>(
    'select code, misuse_code as misuse, auth_event_id::text as event from esig.signing_failure where challenge_id = $1 order by id',
    [challengeId],
  );
  return rows;
}

/** The security unit's SIGNING_FAILED alerts about this challenge, whatever event they name. */
async function alertsOn(challengeId: string): Promise<{ severity: string; person_id: string | null; code: string }[]> {
  const { rows } = await db.admin.query<{ severity: string; person_id: string | null; code: string }>(
    `select severity, person_id::text, details ->> 'code' as code from iam.security_alert
      where kind = 'SIGNING_FAILED' and details ->> 'challenge_id' = $1 order by raised_at`,
    [challengeId],
  );
  return rows;
}

async function usesOf(authEventId: string): Promise<string[]> {
  const { rows } = await db.admin.query<{ use_kind: string }>('select use_kind from iam.auth_event_use where auth_event_id = $1 order by use_kind', [authEventId]);
  return rows.map((r) => r.use_kind);
}

describe('esig.signing_misuse: what a logged refusal accuses (DI-19, kernel 0950)', () => {
  it('[DI-19] a refusal reported without an authentication event, or with one the database does not know, is logged against its challenge and accuses nobody', async () => {
    const op = await testActor(db);
    const ch = await challengeFor(db, op, await createStub(db, op), { meaning: 'PERFORMED' });
    // A refusal before anybody authenticated (the challenge expired): the application reports no event.
    await logSigningFailure(db.app, ch.challengeId, new Error('EBMR-ESIG-033 the challenge expired; request a new one'));
    // An id that names no authentication event: the database finds no committed row, so no misuse.
    const unknown = randomUUID();
    await db.app.query(RECORD, [ch.challengeId, unknown, 'EBMR-IAM-090', 'EBMR-IAM-090 unknown authentication event (test)']);
    expect(await logged(ch.challengeId)).toEqual([
      { code: 'EBMR-ESIG-033', misuse: null, event: null },
      { code: 'EBMR-IAM-090', misuse: null, event: unknown },
    ]);
    expect(await dbCount(db, 'select 1 from esig.signing_failure where challenge_id = $1 and misuse_detail is not null', [ch.challengeId])).toBe(0);
    expect(await alertsOn(ch.challengeId)).toEqual([]);
    // The challenge itself is untouched: the signer can still sign it.
    await signWith(db, op, ch.challengeId, await signatureAuth(db, op, op, ch.challengeId));
    expect(await dbCount(db, 'select 1 from esig.signature where challenge_id = $1', [ch.challengeId])).toBe(1);
  });

  it('[DI-19][INV-40] only the command kernel.begin_command validated can claim the attempt\'s use: a context module code installs in that command\'s transaction cannot, even naming the same event and correlation id', async () => {
    const op = await testActor(db);
    const ch = await challengeFor(db, op, await createStub(db, op), { meaning: 'PERFORMED' });
    const ev = await signatureAuth(db, op, op, ch.challengeId, 'PASSWORD');
    const attempt = toDbContext(await attemptContext(op, ev));
    // What module SECURITY DEFINER code installs inside a command (here the command's context completed with a reason,
    // as recipe.push_reason and platform.engine_reason do): kernel code installed it last, but kernel.begin_command
    // did not validate it.
    const switched = { ...attempt, reason_code: 'SIGNING_REFUSED', reason_text: 'context installed by module code (test)' };
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(attempt)]);
      await c.query('select kernel.set_actor_context($1::jsonb)', [JSON.stringify(switched)]);
      const { rows } = await c.query<{ ev: string; corr: string; validated: boolean }>(
        "select kernel.current_actor() ->> 'auth_event_id' as ev, kernel.current_actor() ->> 'correlation_id' as corr, iam.actor_is_validated() as validated",
      );
      expect(rows[0]).toEqual({ ev, corr: attempt['correlation_id'], validated: false });
      await c.query(RECORD, [ch.challengeId, ev, 'ESIG_STUB_ORDER', 'reported under a context begin_command did not validate (test)']);
      await c.query('commit');
    } catch (error) {
      await c.query('rollback');
      throw error;
    } finally {
      c.release();
    }
    // The command committed its use of the event; the report could not claim it, so it is re-use, alerted once.
    expect(await usesOf(ev)).toEqual(['COMMAND']);
    expect(await logged(ch.challengeId)).toEqual([{ code: 'UNKNOWN', misuse: 'EBMR-IAM-091', event: ev }]);
    expect(await alertsOn(ch.challengeId)).toEqual([{ severity: 'HIGH', person_id: op.personId, code: 'EBMR-IAM-091' }]);
  });

  it('[DI-19][DI-38] an authentication recorded at the very instant of the challenge is not pre-signing: the attempt is logged without misuse, and such an event signs', async () => {
    const op = await testActor(db);
    const ch = await challengeFor(db, op, await createStub(db, op), { meaning: 'PERFORMED' });
    const atChallenge = (authEventId: string) =>
      asTimeTraveller(db, 'update iam.auth_event set recorded_at = (select recorded_at from esig.challenge where id = $2) where id = $1', [authEventId, ch.challengeId]);
    const ev = await signatureAuth(db, op, op, ch.challengeId, 'PASSWORD');
    await atChallenge(ev);
    expect(await dbCount(db, 'select 1 from iam.auth_event e, esig.challenge c where e.id = $1 and c.id = $2 and e.recorded_at = c.recorded_at', [ev, ch.challengeId])).toBe(1);
    await refusedAttempt(op, ch.challengeId, ev);
    expect(await usesOf(ev)).toEqual(['COMMAND']);
    expect(await logged(ch.challengeId)).toEqual([{ code: 'UNKNOWN', misuse: null, event: ev }]);
    expect(await alertsOn(ch.challengeId)).toEqual([]);
    // esig.sign draws the same line: an authentication at the challenge's instant is not before it.
    const next = await signatureAuth(db, op, op, ch.challengeId, 'PASSWORD');
    await atChallenge(next);
    await signWith(db, op, ch.challengeId, next);
    expect(await dbCount(db, 'select 1 from esig.signature where challenge_id = $1 and auth_event_id = $2', [ch.challengeId, next])).toBe(1);
  });

  it('[DI-19][DI-38] the components a signing needs come from the challenge\'s own signature type and version: the private component alone is misuse for a version that needs all components, not for one the relaxation covers', async () => {
    // A customer signature point whose newest version (3) tightened re-authentication to every component; its
    // versions 1 and 2 were relaxable. No other type of the catalogue has a version 3.
    const qa = underChange(await qaApprover(db));
    const code = `MUT_K2_${randomUUID().slice(0, 4).toUpperCase()}`;
    await run(db, qa, (c) => addMeaningType(c, code, {
      title: 'Line cleared', meaningText: 'I performed the line clearance before this step.', category: 'EXECUTION', roleClass: 'PERFORMER',
      permissions: ['STEP.SIGN_PERFORMED'], excludesPerformers: false, reauth: 'SESSION_RELAXABLE',
    }, 'site SOP adds a line clearance signature'));
    expect(await run(db, qa, (c) => configureMeaningType(c, code, { meaningText: 'I performed and recorded the line clearance before this step.' }, 'SOP revision'))).toBe(2);
    expect(await run(db, qa, (c) => configureMeaningType(c, code, { reauth: 'ALL_COMPONENTS' }, 'quality unit tightens re-authentication'))).toBe(3);
    expect(await dbCount(db, 'select 1 from esig.meaning_type where version = 3 and code <> $1', [code])).toBe(0);
    await setPolicy(db, 'esig.session_relaxation', 'true');
    try {
      const op = await testActor(db);
      // The first signing of the continuous session needs every component; later relaxable ones the private one.
      const first = await signStub(db, op, await createStub(db, op), { meaning: 'PERFORMED' });
      expect(first.componentsReason).toBe('FIRST_SIGNING_OF_CONTINUOUS_SESSION');
      const strict = await challengeFor(db, op, await createStub(db, op), { meaning: code });
      expect([strict.meaning.version, strict.requiredComponents, strict.requiredComponentsReason]).toEqual([3, 'ALL', 'MEANING_NEEDS_ALL_COMPONENTS']);
      const relaxed = await challengeFor(db, op, await createStub(db, op), { meaning: 'PERFORMED' });
      expect([relaxed.requiredComponents, relaxed.requiredComponentsReason]).toEqual(['PRIVATE', 'LATER_SIGNING_OF_CONTINUOUS_SESSION']);
      // The password alone, for the strict version: the authentication lacks what this signing needs.
      const strictEv = await syntheticAuthEvent(db, op, op, strict.challengeId, ['PASSWORD']);
      await refusedAttempt(op, strict.challengeId, strictEv);
      expect(await logged(strict.challengeId)).toEqual([{ code: 'UNKNOWN', misuse: 'EBMR-ESIG-038', event: strictEv }]);
      expect(await alertsOn(strict.challengeId)).toEqual([{ severity: 'HIGH', person_id: op.personId, code: 'EBMR-ESIG-038' }]);
      // The password alone, for a relaxable type in the same continuous session: no misuse, nobody alerted.
      const relaxedEv = await syntheticAuthEvent(db, op, op, relaxed.challengeId, ['PASSWORD']);
      await refusedAttempt(op, relaxed.challengeId, relaxedEv);
      expect(await logged(relaxed.challengeId)).toEqual([{ code: 'UNKNOWN', misuse: null, event: relaxedEv }]);
      expect(await alertsOn(relaxed.challengeId)).toEqual([]);
    } finally {
      await setPolicy(db, 'esig.session_relaxation', 'false');
    }
  });
});

describe('iam.change_event_check: which authentication may change a secret (DI-19, DI-15, kernel 0990)', () => {
  const authn = () => seedAuthn(db);
  const activeCredential = async (accountId: string, kind: 'PASSWORD' | 'PIN'): Promise<string[]> =>
    (await db.admin.query<{ id: string }>("select id::text from iam.credential where account_id = $1 and kind = $2 and status = 'ACTIVE'", [accountId, kind])).rows.map((r) => r.id);
  const credentialCount = async (accountId: string): Promise<number> => dbCount(db, 'select 1 from iam.credential where account_id = $1', [accountId]);

  it('[DI-19][DI-15] only an authentication made to change a secret can change one: a fresh, unused LOGIN, COMMAND or SESSION_UNLOCK event with the current password is refused (EBMR-IAM-096) and changes nothing', async () => {
    const op = await testActor(db, { acknowledgeEsig: false });
    const before = await activeCredential(op.accountId, 'PASSWORD');
    const count = await credentialCount(op.accountId);
    expect(before).toHaveLength(1);
    for (const purpose of ['LOGIN', 'COMMAND', 'SESSION_UNLOCK'] as AuthPurpose[]) {
      const ev = await authenticate(authn(), { method: 'PASSWORD', identifier: op.seed.loginName, secret: op.seed.password, deviceFingerprint: op.seed.deviceFingerprint, purpose });
      expect(ev).toMatchObject({ purpose, restricted: false });
      await expectRefused(changeSecret(authn(), { authEventId: ev.authEventId, kind: 'PASSWORD', newSecret: 'Chosen-Password-2026-k2', loginName: op.seed.loginName }),
                          'EBMR-IAM-096', /^EBMR-IAM-096 the authentication event was not made to change a secret$/);
      expect(await usesOf(ev.authEventId)).toEqual([]);
    }
    expect(await activeCredential(op.accountId, 'PASSWORD')).toEqual(before);
    expect(await credentialCount(op.accountId)).toBe(count);
    await expect(authenticate(authn(), { method: 'PASSWORD', identifier: op.seed.loginName, secret: 'Chosen-Password-2026-k2', deviceFingerprint: op.seed.deviceFingerprint, purpose: 'LOGIN' }))
      .rejects.toMatchObject({ reason: 'WRONG_SECRET' });
    // An event made for the change, with the same password, changes it.
    const change = await authenticate(authn(), { method: 'PASSWORD', identifier: op.seed.loginName, secret: op.seed.password, deviceFingerprint: op.seed.deviceFingerprint, purpose: 'CREDENTIAL_CHANGE' });
    await changeSecret(authn(), { authEventId: change.authEventId, kind: 'PASSWORD', newSecret: 'Chosen-Password-2026-k2', loginName: op.seed.loginName });
    expect(await activeCredential(op.accountId, 'PASSWORD')).not.toEqual(before);
    expect(await usesOf(change.authEventId)).toEqual(['CREDENTIAL_CHANGE']);
  });

  it('[DI-19][DI-15] changing the password needs an authentication with the current password: a badge-and-PIN change event is refused for it (EBMR-IAM-096), changes nothing, and still changes the PIN', async () => {
    const op = await testActor(db, { deviceClass: 'SHARED', withPin: true, acknowledgeEsig: false });
    const password = await activeCredential(op.accountId, 'PASSWORD');
    const pin = await activeCredential(op.accountId, 'PIN');
    const count = await credentialCount(op.accountId);
    const ev = await authenticate(authn(), { method: 'BADGE_PIN', identifier: op.seed.badgeUid ?? '', secret: op.seed.pin ?? '', deviceFingerprint: op.seed.deviceFingerprint, purpose: 'CREDENTIAL_CHANGE' });
    expect(ev).toMatchObject({ purpose: 'CREDENTIAL_CHANGE', components: ['BADGE', 'PIN'] });
    await expectRefused(changeSecret(authn(), { authEventId: ev.authEventId, kind: 'PASSWORD', newSecret: 'Kiosk-Password-2026-k2', loginName: op.seed.loginName }),
                        'EBMR-IAM-096', /^EBMR-IAM-096 changing the PASSWORD needs an authentication with the current PASSWORD$/);
    expect(await usesOf(ev.authEventId)).toEqual([]);
    expect(await activeCredential(op.accountId, 'PASSWORD')).toEqual(password);
    expect(await credentialCount(op.accountId)).toBe(count);
    // The same event, unused, changes the PIN it proves.
    await changeSecret(authn(), { authEventId: ev.authEventId, kind: 'PIN', newSecret: '730519' });
    expect(await activeCredential(op.accountId, 'PASSWORD')).toEqual(password);
    expect(await activeCredential(op.accountId, 'PIN')).not.toEqual(pin);
    expect(await usesOf(ev.authEventId)).toEqual(['CREDENTIAL_CHANGE']);
  });
});
