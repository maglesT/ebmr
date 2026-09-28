/**
 * The signing guards, rule by rule (SQL mutation group "signing": esig.required_components,
 * esig.component_problem, esig.check_independence, esig.check_witness, esig.create_challenge and
 * esig.sign in kernel 0230). These tests close the gaps the SQL mutation run (tools/sql-mutation)
 * found in the module tests of test/esig: every refusal is asserted by its stable EBMR code (the
 * rule that refused), and every boundary is proven from the side the rule lets through as well.
 *
 * Controls: DI-35 (catalogue meanings, independence, WITNESSED, delegation), DI-36 (manifestation:
 * signer, role, meaning, zone), DI-37 (what is signed is what was shown), DI-38 (components and
 * continuous sessions), DI-17 (stored segregation evaluations); invariants INV-03, INV-09, INV-10,
 * INV-26.
 *
 * States that the product never produces by itself (a record whose act terminal is missing, content
 * changed without a version bump, an authentication event of another account of the signer) are
 * arranged with the superuser, triggers off (asTimeTraveller) or by inserting a forged
 * authentication event; the control itself is always exercised through the signing functions.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toDbContext, withCommand } from '../../src/db/command.ts';
import { addMeaningType, configureMeaningType } from '../../src/esig/catalogue.ts';
import { sealMessage } from '../../src/esig/keys.ts';
import { contentForSigning, createChallenge, sign } from '../../src/esig/signing.ts';
import {
  acknowledgeEsigPolicy, activateAccount, createAccount, deactivateAccount, decideRoleGrant, issueInitialSecret, requestRoleGrant,
} from '../../src/identity/admin.ts';
import { authenticate, changeSecret, type AuthnDb } from '../../src/identity/authentication.ts';
import { ebmrCode } from '../../src/identity/errors.ts';
import { lockSession, openSession, unlockSession } from '../../src/identity/sessions.ts';
import { seedAdministration, seedAuthn, withReason, type SeededActor } from '../identity/seed.ts';
import { createTestDatabase, urlFor, type TestDatabase } from '../support/db.ts';
import {
  asSuperuserTransaction,
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
  shopFloor,
  signatureAuth,
  signStub,
  signWith,
  syntheticAuthEvent,
  testActor,
  testSealKey,
} from '../esig/helpers.ts';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  await ensureSealKey(db);
});

afterAll(async () => {
  await db.drop();
});

const hex = (n = 4): string => randomBytes(n).toString('hex');
const ref = (id: string): string => `esig_stub:${id}`;
const signaturesOn = (id: string, meaning: string): Promise<number> =>
  dbCount(db, 'select 1 from esig.signature where aggregate_ref = $1 and meaning_code = $2', [ref(id), meaning]);

/**
 * esig.sign with every argument passed exactly as given (NULL included), sealed as sign() does. On
 * a shop-floor terminal the signer's own signature event attributes the command (as signWith does).
 */
async function signRaw(actor: SeededActor, challengeId: string, authEventId: string,
                       args: { expectedState?: string | null; nextStepStarted?: boolean | null } = {}): Promise<string> {
  const ctx = shopFloor(actor) ? { ...(await cmd(db, actor)), authEventId } : await cmd(db, actor);
  return withCommand(db.app, ctx, async (c) => {
    const { rows } = await c.query<{ r: { signature_id: string; seal_payload: string } }>('select esig.sign($1, $2, $3, null, $4) as r', [
      challengeId,
      authEventId,
      args.expectedState === undefined ? 'OPEN' : args.expectedState,
      args.nextStepStarted === undefined ? false : args.nextStepStarted,
    ]);
    const r = rows[0]?.r;
    if (!r) throw new Error('esig.sign returned nothing');
    const seal = await testSealKey.seal(sealMessage(testSealKey.keyId, testSealKey.algorithm, r.seal_payload));
    await c.query('select esig.seal_signature($1, $2, $3, $4)', [r.signature_id, testSealKey.keyId, testSealKey.algorithm, Buffer.from(seal).toString('base64')]);
    return r.signature_id;
  });
}

/**
 * A pool over ONE open transaction of the connection `c`: every begin / commit / rollback that the
 * product's helpers (withCommand, authenticate, changeSecret) issue becomes a savepoint, and `role`,
 * when given, is taken with SET LOCAL ROLE at each begin. So a whole sequence of commands runs in one
 * database transaction through the product's own roles and public functions only.
 */
function withinTransaction(c: pg.PoolClient, role?: 'ebmr_app'): pg.Pool {
  const open: string[] = [];
  let n = 0;
  const client = {
    async query(sql: string, params?: unknown[]): Promise<unknown> {
      if (sql === 'begin') {
        const name = `sp_${role ?? 'any'}_${++n}`;
        open.push(name);
        await c.query(`savepoint ${name}`);
        if (role) await c.query(`set local role ${role}`);
        return { rows: [] };
      }
      if (sql === 'commit' || sql === 'rollback') {
        const name = open.pop() ?? '';
        if (sql === 'rollback') await c.query(`rollback to savepoint ${name}`);
        await c.query(`release savepoint ${name}`);
        return { rows: [] };
      }
      return c.query(sql, params);
    },
    release: (): void => undefined,
  };
  return { connect: () => Promise.resolve(client) } as unknown as pg.Pool;
}

/** A performer and a witness on GRADE_A_B terminals registered to the same room. */
async function witnessPair(room: string): Promise<{ performer: SeededActor; witness: SeededActor }> {
  const performer = await testActor(db, { deviceClass: 'GRADE_A_B', roomCode: room });
  const witness = await testActor(db, { roleCode: 'VERIFIER', deviceClass: 'GRADE_A_B', roomCode: room });
  return { performer, witness };
}

describe('DI-38: signature components (esig.component_problem, esig.required_components)', () => {
  it('[DI-38][INV-10] an identification component alone never meets the all-components rule: the refusal names the missing pair', async () => {
    const problem = async (requirement: string, components: string[]): Promise<string | null> =>
      (await db.app.query<{ p: string | null }>('select esig.component_problem($1, $2::text[]) as p', [requirement, components])).rows[0]?.p ?? null;
    // The two pairs the kernel accepts: user ID + password, badge + PIN.
    expect(await problem('ALL', ['USER_ID', 'PASSWORD'])).toBeNull();
    expect(await problem('ALL', ['BADGE', 'PIN'])).toBeNull();
    // An identification component alone (with or without MFA) is not a pair: all components are required.
    expect(await problem('ALL', ['USER_ID'])).toBe('ALL_COMPONENTS_REQUIRED');
    expect(await problem('ALL', ['BADGE'])).toBe('ALL_COMPONENTS_REQUIRED');
    expect(await problem('ALL', ['USER_ID', 'MFA'])).toBe('ALL_COMPONENTS_REQUIRED');
    expect(await problem('ALL', ['BADGE', 'MFA'])).toBe('ALL_COMPONENTS_REQUIRED');
    // Under the relaxation the private component is what is missing.
    expect(await problem('PRIVATE', ['USER_ID'])).toBe('PRIVATE_COMPONENT_REQUIRED');
    expect(await problem('PRIVATE', ['BADGE'])).toBe('PRIVATE_COMPONENT_REQUIRED');

    // The same rule at signing: a forged event with the identification component alone is refused for the missing pair.
    const op = await testActor(db);
    const id = await createStub(db, op);
    const ch = await challengeFor(db, op, id, { meaning: 'PERFORMED' });
    for (const [components, method] of [[['USER_ID'], 'PASSWORD'], [['BADGE'], 'BADGE_PIN']] as const) {
      const ev = await syntheticAuthEvent(db, op, op, ch.challengeId, [...components], method);
      await expectRefused(signWith(db, op, ch.challengeId, ev), 'EBMR-ESIG-038', /^EBMR-ESIG-038 ALL_COMPONENTS_REQUIRED/);
    }
    expect(await signaturesOn(id, 'PERFORMED')).toBe(0);
  });

  it('[DI-38] a full signing recorded at the very instant the continuous session restarted belongs to that session', async () => {
    await setPolicy(db, 'esig.session_relaxation', 'true');
    try {
      const op = await testActor(db);
      await lockSession(db.app, op.sessionId);
      const unlock = await authenticate(seedAuthn(db), {
        method: 'PASSWORD', identifier: op.seed.loginName, secret: op.seed.password, deviceFingerprint: op.seed.deviceFingerprint, purpose: 'SESSION_UNLOCK',
      });
      await unlockSession(db.app, op.sessionId, unlock.authEventId);
      const first = await signStub(db, op, await createStub(db, op), { meaning: 'PERFORMED' });
      expect(first.componentsReason).toBe('FIRST_SIGNING_OF_CONTINUOUS_SESSION');
      const next = await createStub(db, op);
      const moveUnlock = (offset: string) =>
        asTimeTraveller(db, `update iam.session_event set recorded_at = (select recorded_at from esig.signature where id = $2) + $3::interval
                              where session_id = $1 and event = 'UNLOCKED'`, [op.sessionId, first.signatureId, offset]);
      // The unlock and the full signing at the same instant: the signing is inside the continuous session.
      await moveUnlock('0 seconds');
      const same = await challengeFor(db, op, next, { meaning: 'PERFORMED' });
      expect([same.requiredComponents, same.requiredComponentsReason]).toEqual(['PRIVATE', 'LATER_SIGNING_OF_CONTINUOUS_SESSION']);
      // One microsecond later the session restarted after the signing: all components again.
      await moveUnlock('1 microsecond');
      const after = await challengeFor(db, op, next, { meaning: 'PERFORMED' });
      expect([after.requiredComponents, after.requiredComponentsReason]).toEqual(['ALL', 'FIRST_SIGNING_OF_CONTINUOUS_SESSION']);
      // Back at the boundary, the private component alone completes the later signing.
      await moveUnlock('0 seconds');
      const ch = await challengeFor(db, op, next, { meaning: 'PERFORMED' });
      const pw = await syntheticAuthEvent(db, op, op, ch.challengeId, ['PASSWORD']);
      const second = await signWith(db, op, ch.challengeId, pw);
      expect(second.componentsRequired).toBe('PRIVATE');
    } finally {
      await setPolicy(db, 'esig.session_relaxation', 'false');
    }
  });
});

describe('independence on the person (esig.check_independence)', () => {
  it('[DI-35][DI-17][INV-03] the stored segregation evaluations of a signing are exactly the rules of its type', async () => {
    const rules = async (subject: string) =>
      (await db.admin.query<{ rule_code: string; allowed: boolean; excluded_persons: string[] }>(
        'select rule_code, allowed, excluded_persons from iam.segregation_evaluation where subject = $1 order by rule_code', [subject])).rows;
    // PERFORMED has no independence, performer or involvement rule: nothing is evaluated, nothing stored.
    const op = await testActor(db);
    const verifier = await testActor(db, { roleCode: 'VERIFIER' });
    const id = await createStub(db, op);
    await signStub(db, op, id, { meaning: 'PERFORMED' });
    expect(await rules(ref(id))).toEqual([]);
    // VERIFIED excludes performers only: one INV-03 evaluation, no independence evaluation.
    await signStub(db, verifier, id, { meaning: 'VERIFIED' });
    expect(await rules(ref(id))).toEqual([{ rule_code: 'INV-03', allowed: true, excluded_persons: [op.personId] }]);
    // CHECKED is independent of PREPARED and excludes performers: both are evaluated and stored.
    const author = await testActor(db, { roleCode: 'MBR_AUTHOR' });
    const checker = await testActor(db, { roleCode: 'MBR_CHECKER' });
    const doc = await createStub(db, author, { kind: 'MASTER_DOCUMENT', title: 'MBR v7', value: 'text' });
    await signStub(db, author, doc, { meaning: 'PREPARED' });
    expect(await rules(ref(doc))).toEqual([]);
    await signStub(db, checker, doc, { meaning: 'CHECKED' });
    expect(await rules(ref(doc))).toEqual([
      { rule_code: 'ESIG.INDEPENDENT:CHECKED', allowed: true, excluded_persons: [author.personId] },
      { rule_code: 'INV-03', allowed: true, excluded_persons: [author.personId] },
    ]);
  });
});

describe('WITNESSED (esig.check_witness)', () => {
  it('[DI-35][INV-03] a record that names no act terminal or no act time cannot be witnessed; VERIFIED signs the recorded evidence instead', async () => {
    const { performer, witness } = await witnessPair('ROOM-W1');
    const noTerminal = await createStub(db, performer, { title: 'Manual pressure reading' });
    const noTime = await createStub(db, performer, { title: 'Manual temperature reading' });
    await asTimeTraveller(db, 'update esig.stub_signable set entered_device_id = null where id = $1', [noTerminal]);
    await asTimeTraveller(db, 'update esig.stub_signable set entered_at = null where id = $1', [noTime]);
    for (const id of [noTerminal, noTime]) {
      await expectRefused(signStub(db, witness, id, { meaning: 'WITNESSED' }), 'EBMR-ESIG-050', /names no witnessed act/);
      expect(await signaturesOn(id, 'WITNESSED')).toBe(0);
      await signStub(db, witness, id, { meaning: 'VERIFIED' });
    }
  });

  it('[DI-35] when the caller does not say whether the next step has started, witnessing is refused (unknown counts as started)', async () => {
    const { performer, witness } = await witnessPair('ROOM-W2');
    const id = await createStub(db, performer, { title: 'Filter integrity test' });
    const ch = await challengeFor(db, witness, id, { meaning: 'WITNESSED' });
    const ev = await signatureAuth(db, witness, witness, ch.challengeId);
    await expectRefused(signRaw(witness, ch.challengeId, ev, { nextStepStarted: null }), 'EBMR-ESIG-051');
    expect(await signaturesOn(id, 'WITNESSED')).toBe(0);
    // Stated explicitly that the next step has not started, the same event completes the witness signature.
    await signRaw(witness, ch.challengeId, ev, { nextStepStarted: false });
    expect(await signaturesOn(id, 'WITNESSED')).toBe(1);
  });
});

describe('challenge (esig.create_challenge)', () => {
  it('[DI-37][INV-10] a challenge naming an unknown signer account is refused as such, and nothing is issued', async () => {
    const op = await testActor(db);
    const id = await createStub(db, op);
    const content = await contentForSigning(db.app, 'esig_stub', id);
    await expectRefused(
      run(db, op, (c) => createChallenge(c, {
        aggregateType: 'esig_stub', aggregateId: id, contentVersion: '1', meaning: 'PERFORMED', clientContentHash: content.contentHash ?? '',
        signerAccountId: randomUUID(),
      })),
      'EBMR-ESIG-010', /unknown signer account/,
    );
    expect(await dbCount(db, 'select 1 from esig.challenge where aggregate_ref = $1', [ref(id)])).toBe(0);
  });

  it('[DI-36][DI-14][INV-10][INV-11] a context of the person\'s replaced account, still registered in the transaction, cannot issue a challenge for the person\'s new account', async () => {
    const { admin, owner } = await seedAdministration(db);
    // Account A of person P: a personal HUMAN account with an open session S_A, and a record to sign.
    const replaced = await testActor(db);
    const id = await createStub(db, replaced);
    const content = await contentForSigning(db.app, 'esig_stub', id);
    const staleCtx = JSON.stringify(toDbContext(await cmd(db, replaced)));
    const fp = replaced.seed.deviceFingerprint;

    // One transaction on one connection that acts only as ebmr_app and ebmr_authn, through the public
    // functions (no trigger bypass, no direct DML; the superuser only reads, to check the state); rolled
    // back at the end. Since kernel.set_actor_context keeps only the context installed last, the stale
    // context is refused as not validated (EBMR-IAM-002; a control below shows the restored text is
    // exactly the validated one); before that fix it got past iam.assert_validated_actor and the
    // session-owner guard (EBMR-ESIG-010) was what refused it.
    await asSuperuserTransaction(db, async (c) => {
      const app = withinTransaction(c, 'ebmr_app');
      const authn: AuthnDb = { pool: withinTransaction(c), setRole: 'ebmr_authn' };
      await c.query('set local role ebmr_app');
      // A's context is validated while A is ACTIVE.
      await c.query('select kernel.begin_command($1::jsonb)', [staleCtx]);
      // Control: the exact text put back below is the context validated here, so a later refusal as
      // not validated (EBMR-IAM-002) can only mean the context has gone stale, never a wrong restore.
      await c.query("select set_config('ebmr.ctx', $1, true)", [staleCtx]);
      const { rows: [fresh] } = await c.query<{ ok: boolean }>('select iam.actor_is_validated() as ok');
      expect(fresh?.ok, 'the context text the attack restores is the one begin_command validated').toBe(true);
      // The administrator replaces the account: A is disabled (S_A ends), B is created for P (INV-11 allows it
      // now that A is disabled), activated and granted OPERATOR by the process owner.
      await withCommand(app, withReason(admin), (x) => deactivateAccount(x, replaced.accountId, 'account replaced'));
      const login = `op-new-${hex()}`;
      const made = await withCommand(app, withReason(admin), async (x) => {
        const accountId = await createAccount(x, { personId: replaced.personId, loginName: login, kind: 'HUMAN' });
        const { secret } = await issueInitialSecret(x, accountId, 'PASSWORD');
        await activateAccount(x, accountId);
        const grantId = await requestRoleGrant(x, { accountId, roleCode: 'OPERATOR', scope: {}, reason: 'replacement account' });
        return { accountId, secret, grantId };
      });
      await withCommand(app, withReason(owner), (x) => decideRoleGrant(x, made.grantId, true, 'approved'));
      // P makes B ready to sign: the initial password is changed, B logs in and acknowledges the policy.
      const first = await authenticate(authn, { method: 'PASSWORD', identifier: login, secret: made.secret, deviceFingerprint: fp, purpose: 'LOGIN' });
      const password = `Mut-${randomBytes(9).toString('base64url')}`;
      await changeSecret(authn, { authEventId: first.authEventId, kind: 'PASSWORD', newSecret: password, loginName: login });
      const ev = await authenticate(authn, { method: 'PASSWORD', identifier: login, secret: password, deviceFingerprint: fp, purpose: 'LOGIN' });
      await c.query('set local role ebmr_app');
      const s = await openSession(c, ev.authEventId, fp);
      await withCommand(app, {
        personId: replaced.personId, accountId: made.accountId, roleCode: 'OPERATOR', sessionId: s.sessionId, deviceId: s.deviceId,
        source: 'UI', siteZone: replaced.siteZone, ...(replaced.legalName ? { legalName: replaced.legalName } : {}), correlationId: randomUUID(),
      }, (x) => acknowledgeEsigPolicy(x));

      // The state the guard is tested against: A is disabled, its session has ended, B can sign.
      await c.query('set local role none');
      const { rows: [state] } = await c.query<{ status: string; session: string; can_sign: boolean }>(
        `select (select status from iam.account where id = $1) as status, iam.session_state($2) as session,
                (iam.can_sign($3) ->> 'can_sign')::boolean as can_sign`, [replaced.accountId, replaced.sessionId, made.accountId]);
      expect(state).toEqual({ status: 'DISABLED', session: 'ENDED', can_sign: true });

      // The application role puts A's earlier context back and asks for a challenge for B.
      await c.query('set local role ebmr_app');
      await c.query("select set_config('ebmr.ctx', $1, true)", [staleCtx]);
      await c.query('savepoint attempt');
      let refusal: unknown;
      try {
        await c.query('select esig.create_challenge($1, $2, $3::bigint, $4, $5, $6)',
                      ['esig_stub', id, content.contentVersion, 'PERFORMED', content.contentHash, made.accountId]);
      } catch (error) {
        refusal = error;
      }
      await c.query('rollback to savepoint attempt');
      // Refused: as a context that is no longer the validated one, by the session-owner rule, or (if the
      // actor check re-validates the account) as a context of a disabled account or an ended session.
      expect(refusal, 'a challenge was issued for B on the ended session of the disabled account A').toBeDefined();
      const message = refusal instanceof Error ? refusal.message : String(refusal);
      expect(['EBMR-IAM-002', 'EBMR-ESIG-010', 'EBMR-IAM-103', 'EBMR-IAM-112']).toContain(ebmrCode(refusal));
      if (ebmrCode(refusal) === 'EBMR-ESIG-010') expect(message).toMatch(/the session owner signs with the account of the session/);
      await c.query('set local role none');
      const { rows: [issued] } = await c.query<{ n: string }>(
        'select count(*) as n from esig.challenge where aggregate_ref = $1 or signer_account = $2 or session_id = $3',
        [ref(id), made.accountId, replaced.sessionId]);
      expect(issued?.n).toBe('0');
    });
  });
});

describe('sign (esig.sign)', () => {
  it('[INV-10] an unknown challenge is refused as such', async () => {
    const op = await testActor(db);
    await expectRefused(run(db, op, (c) => c.query('select esig.sign($1, $2)', [randomUUID(), randomUUID()])), 'EBMR-ESIG-031');
  });

  it('[INV-10][DI-20] a challenge is completed only in its own session: another session of the same signer on the same terminal is refused', async () => {
    const op = await testActor(db);
    const id = await createStub(db, op);
    const ch = await challengeFor(db, op, id, { meaning: 'PERFORMED' });
    const ev = await signatureAuth(db, op, op, ch.challengeId);
    // The signer logs in a second time on the same (personal) terminal: same device, another session.
    const login = await authenticate(seedAuthn(db), {
      method: 'PASSWORD', identifier: op.seed.loginName, secret: op.seed.password, deviceFingerprint: op.seed.deviceFingerprint, purpose: 'LOGIN',
    });
    const second = await openSession(db.app, login.authEventId, op.seed.deviceFingerprint);
    expect(second.deviceId).toBe(op.deviceId);
    await expectRefused(signWith(db, { ...op, sessionId: second.sessionId }, ch.challengeId, ev), 'EBMR-ESIG-034');
    expect(await signaturesOn(id, 'PERFORMED')).toBe(0);
    // In the session that issued the challenge the same event completes it.
    await signWith(db, op, ch.challengeId, ev);
  });

  it('[DI-36][INV-10] a command that declares a time zone other than the site zone cannot sign', async () => {
    const op = await testActor(db);
    const id = await createStub(db, op);
    const ch = await challengeFor(db, op, id, { meaning: 'PERFORMED' });
    const ev = await signatureAuth(db, op, op, ch.challengeId);
    // Through the product path the command itself is refused when it starts (DI-27).
    await expectRefused(
      withCommand(db.app, await cmd(db, op, { siteZone: 'Europe/Berlin' }), (c) =>
        sign(c, { challengeId: ch.challengeId, authEventId: ev, expectedState: 'OPEN' }, testSealKey)),
      'EBMR-IAM-118', /declares the time zone Europe\/Berlin, but the site's time zone \(policy site\.zone\) is Asia\/Kolkata/,
    );
    // Defence in depth: a validated context declaring another zone that did not come through
    // kernel.begin_command (installed by owner-level code; here a superuser) is still refused by the
    // signing function's own zone check.
    await asSuperuserTransaction(db, async (c) => {
      const berlin = toDbContext(await cmd(db, op, { siteZone: 'Europe/Berlin' }));
      await c.query('select iam.set_internal_actor($1::jsonb)', [JSON.stringify(berlin)]);
      await c.query('set local role ebmr_app');
      const { rows: [validated] } = await c.query<{ ok: boolean }>('select iam.actor_is_validated() as ok');
      expect(validated?.ok, 'the Berlin context is a validated actor, so only the zone check can refuse it').toBe(true);
      await expectRefused(c.query("select esig.sign($1, $2, 'OPEN', null, false)", [ch.challengeId, ev]),
                          'EBMR-ESIG-035', /declares zone Europe\/Berlin but the site zone is Asia\/Kolkata/);
    });
    expect(await signaturesOn(id, 'PERFORMED')).toBe(0);
    const sig = await signWith(db, op, ch.challengeId, ev);
    expect(sig.manifestation.siteZone).toBe('Asia/Kolkata');
  });

  it('[INV-10] the authentication event must be made with the account the challenge names, even when it is the same person', async () => {
    const op = await testActor(db);
    const { admin } = await seedAdministration(db);
    // The same person's active break-glass account (another account of the person, never a signing one).
    const otherAccount = await withCommand(db.app, withReason(admin), async (c) => {
      const accountId = await createAccount(c, { personId: op.personId, loginName: `bg-${hex()}`, kind: 'HUMAN', breakGlass: true });
      await activateAccount(c, accountId);
      return accountId;
    });
    const id = await createStub(db, op);
    const ch = await challengeFor(db, op, id, { meaning: 'PERFORMED' });
    const { rows } = await db.admin.query<{ id: string }>(
      `insert into iam.auth_event (person_id, account_id, device_id, device_class, method, components, purpose, challenge_id)
       values ($1, $2, $3, 'PERSONAL', 'PASSWORD', '{USER_ID,PASSWORD}', 'SIGNATURE', $4) returning id`,
      [op.personId, otherAccount, op.deviceId, ch.challengeId]);
    await expectRefused(signWith(db, op, ch.challengeId, rows[0]?.id ?? ''), 'EBMR-ESIG-036', /another account than the challenge names/);
    expect(await signaturesOn(id, 'PERFORMED')).toBe(0);
  });

  it('[INV-10][DI-38] no pre-signing: an authentication recorded before its challenge is refused; one at the challenge instant completes it', async () => {
    const op = await testActor(db);
    const id = await createStub(db, op);
    const ch = await challengeFor(db, op, id, { meaning: 'PERFORMED' });
    const ev = await signatureAuth(db, op, op, ch.challengeId);
    const setEventTime = (offset: string) =>
      asTimeTraveller(db, 'update iam.auth_event set recorded_at = (select recorded_at from esig.challenge where id = $2) + $3::interval where id = $1',
                      [ev, ch.challengeId, offset]);
    await setEventTime('-1 microsecond');
    await expectRefused(signWith(db, op, ch.challengeId, ev), 'EBMR-ESIG-036', /before the challenge/);
    expect(await signaturesOn(id, 'PERFORMED')).toBe(0);
    await setEventTime('0 seconds');
    await signWith(db, op, ch.challengeId, ev);
    expect(await signaturesOn(id, 'PERFORMED')).toBe(1);
  });

  it('[DI-35][DI-36] a signature type that changed after the challenge cannot be signed with that challenge', async () => {
    const qa = await qaApprover(db);
    const code = `MUT_SEAL_${hex(2).toUpperCase()}`;
    await run(db, qa, (c) => addMeaningType(c, code, {
      title: 'Seal checked', meaningText: 'As second person, I checked the seal of this container.',
      category: 'VERIFICATION', roleClass: 'VERIFIER', permissions: ['STEP.VERIFY'], reauth: 'SESSION_RELAXABLE',
    }, 'site SOP adds a seal check'));
    const op = await testActor(db);
    const verifier = await testActor(db, { roleCode: 'VERIFIER' });
    const id = await createStub(db, op);
    const ch = await challengeFor(db, verifier, id, { meaning: code });
    expect(ch.meaning.version).toBe(1);
    const ev = await signatureAuth(db, verifier, verifier, ch.challengeId);
    // The quality unit changes what the signature means while the dialog is open.
    const v2 = await run(db, qa, (c) => configureMeaningType(c, code, { meaningText: 'As second person, I checked the seal and the label of this container.' }, 'SOP revision'));
    expect(v2).toBe(2);
    await expectRefused(signWith(db, verifier, ch.challengeId, ev), 'EBMR-ESIG-037');
    expect(await signaturesOn(id, code)).toBe(0);
    // A new challenge shows the new meaning and can be signed.
    const sig = await signStub(db, verifier, id, { meaning: code });
    expect(sig.manifestation.meaningText).toBe('As second person, I checked the seal and the label of this container.');
  });

  it('[INV-09][INV-10] a record that no longer exists cannot be signed, whatever state the caller expects', async () => {
    const op = await testActor(db);
    const id = await createStub(db, op);
    const ch = await challengeFor(db, op, id, { meaning: 'PERFORMED' });
    const ev = await signatureAuth(db, op, op, ch.challengeId);
    // The provider no longer finds the record (arranged: the row is removed with triggers off).
    await asTimeTraveller(db, 'delete from esig.stub_signable where id = $1', [id]);
    expect((await contentForSigning(db.app, 'esig_stub', id)).exists).toBe(false);
    await expectRefused(signWith(db, op, ch.challengeId, ev, { expectedState: 'OPEN' }), 'EBMR-ESIG-011', /no longer exists/);
    await expectRefused(signWith(db, op, ch.challengeId, ev, { expectedState: null }), 'EBMR-ESIG-011', /no longer exists/);
    expect(await dbCount(db, 'select 1 from esig.signature where challenge_id = $1', [ch.challengeId])).toBe(0);
  });

  it('[INV-09][DI-37] content changed after the challenge is refused even when its content version did not move', async () => {
    const op = await testActor(db);
    const id = await createStub(db, op, { value: '12.503' });
    const ch = await challengeFor(db, op, id, { meaning: 'PERFORMED' });
    const ev = await signatureAuth(db, op, op, ch.challengeId);
    await asTimeTraveller(db, "update esig.stub_signable set value = '12.530' where id = $1", [id]);
    const now = await contentForSigning(db.app, 'esig_stub', id);
    expect(now.contentVersion).toBe(ch.contentVersion);
    expect(now.contentHash).not.toBe(ch.contentHash);
    await expectRefused(signWith(db, op, ch.challengeId, ev), 'EBMR-ESIG-012', /changed after the challenge/);
    expect(await signaturesOn(id, 'PERFORMED')).toBe(0);
  });

  it('[DI-35] a non-delegable meaning is refused under a delegation, even an approved, valid one that names it', async () => {
    const { owner } = await seedAdministration(db);
    const delegator = await testActor(db, { roleCode: 'VERIFIER', legalName: 'Delegating Verifier' });
    const delegate = await testActor(db, { roleCode: 'VERIFIER', legalName: 'Delegate Verifier' });
    const op = await testActor(db);
    const id = await createStub(db, op);
    const delegationId = await run(db, delegator, async (c) =>
      (await c.query<{ id: string }>(
        "select iam.request_delegation($1, '{}'::jsonb, '{}', array['VERIFIED'], clock_timestamp() - interval '1 minute', clock_timestamp() + interval '1 day', 'SOP-QA-017', 'annual leave') as id",
        [delegate.personId])).rows[0]?.id ?? '');
    await withCommand(db.app, withReason(owner), (c) => c.query("select iam.decide_delegation($1, true, 'approved')", [delegationId]));
    // The delegation itself is valid for this person, meaning and scope ...
    const { rows } = await db.admin.query<{ v: { valid: boolean } }>("select iam.delegation_valid($1, $2, 'VERIFIED', '{}'::jsonb, null) as v", [delegationId, delegate.personId]);
    expect(rows[0]?.v.valid).toBe(true);
    // ... but VERIFIED is not a delegable meaning.
    await expectRefused(signStub(db, delegate, id, { meaning: 'VERIFIED', delegationId }), 'EBMR-ESIG-041', /cannot be signed under a delegation/);
    expect(await signaturesOn(id, 'VERIFIED')).toBe(0);
    // In their own right, without citing the delegation, the delegate verifies.
    const sig = await signStub(db, delegate, id, { meaning: 'VERIFIED' });
    expect(sig.manifestation.delegationId ?? null).toBeNull();
  });

  it('[DI-36][INV-26] the signature and its manifestation carry the role the authority evaluation granted', async () => {
    const op = await testActor(db);
    const verifier = await testActor(db, { roleCode: 'VERIFIER' });
    const id = await createStub(db, op);
    for (const [signer, meaning, role] of [[op, 'PERFORMED', 'OPERATOR'], [verifier, 'VERIFIED', 'VERIFIER']] as const) {
      const sig = await signStub(db, signer, id, { meaning });
      const { rows } = await db.admin.query(
        `select s.signer_role_code, s.signer_role_name, s.manifestation ->> 'role_code' as m_code, s.manifestation ->> 'role_name' as m_name,
                e.role_code as evaluated_role, r.name as role_name
           from esig.signature s join iam.authority_evaluation e on e.id = s.authority_evaluation_id join iam.role r on r.code = $2
          where s.id = $1`, [sig.signatureId, role]);
      const r = rows[0] as Record<string, string>;
      expect(r).toEqual({ signer_role_code: role, signer_role_name: r['role_name'], m_code: role, m_name: r['role_name'], evaluated_role: role, role_name: r['role_name'] });
      expect(sig.manifestationText).toContain(r['role_name']);
    }
  });

  it('[INV-10] the signing marks end with the transaction: the pooled connection carries no signing challenge and no unsealed signature afterwards', async () => {
    const single = new pg.Pool({ connectionString: urlFor(db.name, { name: 'ebmr_app', password: 'ebmr_app' }), max: 1 });
    try {
      const marks = async () =>
        (await single.query<{ challenge: string; unsealed: string }>(
          "select coalesce(current_setting('esig.signing_challenge', true), '') as challenge, coalesce(current_setting('esig.unsealed', true), '') as unsealed")).rows[0];
      const op = await testActor(db);
      const id = await createStub(db, op);
      const ch = await challengeFor(db, op, id, { meaning: 'PERFORMED' });
      const ev = await signatureAuth(db, op, op, ch.challengeId);
      const sig = await withCommand(single, await cmd(db, op), (c) => sign(c, { challengeId: ch.challengeId, authEventId: ev, expectedState: 'OPEN' }, testSealKey));
      expect(await signaturesOn(id, 'PERFORMED')).toBe(1);
      expect(sig.signatureId).toMatch(/^[0-9a-f-]{36}$/);
      // The next command on this connection starts clean: nothing names the challenge or the signature.
      expect(await marks()).toEqual({ challenge: '', unsealed: '' });
    } finally {
      await single.end();
    }
  });
});
