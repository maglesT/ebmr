/**
 * DI-38: signature components, re-authentication and session rules (outline 5.5 "Components and
 * sessions"; 21 CFR 11.200(a) paraphrased: two distinct components; the first signing of a
 * continuous session uses all of them, later ones by the same person at least the private one).
 *
 * Default: every signing needs every component. The QA-approvable relaxation (policy
 * esig.session_relaxation, default off) lets routine signings by the session owner after a first
 * full signing in one continuous session use the private component alone; never disposition,
 * certification or master-record approval, never anyone but the session owner. The continuous
 * session ends at lock, inactivity timeout, logout or terminal change.
 *
 * The authentication service always records both components for a signature, so events with the
 * private component alone are inserted directly (syntheticAuthEvent) to exercise the rule.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '../../src/db/command.ts';
import { lockSession, unlockSession } from '../../src/identity/sessions.ts';
import { authenticate } from '../../src/identity/authentication.ts';
import { seedAdministration, seedAuthn } from '../identity/seed.ts';
import { ensureFixtureChangeRecord, underChange } from '../support/change-record.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import {
  asTimeTraveller,
  challengeFor,
  cmd,
  createStub,
  dbCount,
  ensureSealKey,
  expectPermissionDenied,
  expectRefused,
  qaApprover,
  run,
  setPolicy,
  signatureAuth,
  signStub,
  signWith,
  syntheticAuthEvent,
  testActor,
} from './helpers.ts';
import { setEsigPolicy } from '../../src/esig/catalogue.ts';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  await ensureSealKey(db);
  await ensureFixtureChangeRecord(db);
});

afterAll(async () => {
  await db.drop();
});

/** Challenge + an event with chosen components + sign, all at the actor's terminal. */
async function signWithComponents(actor: Awaited<ReturnType<typeof testActor>>, id: string, meaning: string, components: string[], method: 'PASSWORD' | 'BADGE_PIN' = 'PASSWORD') {
  const ch = await challengeFor(db, actor, id, { meaning });
  const ev = await syntheticAuthEvent(db, actor, actor, ch.challengeId, components, method);
  return signWith(db, actor, ch.challengeId, ev);
}

describe('default: all components at every signing', () => {
  it('[DI-38] sign twice in one session: with the relaxation off, the second signing again needs both components', async () => {
    const op = await testActor(db);
    const first = await signStub(db, op, await createStub(db, op), { meaning: 'PERFORMED' });
    expect(first.componentsRequired).toBe('ALL');
    const id = await createStub(db, op);
    const ch = await challengeFor(db, op, id, { meaning: 'PERFORMED' });
    expect(ch.requiredComponents).toBe('ALL');
    expect(ch.requiredComponentsReason).toBe('ALL_COMPONENTS_AT_EVERY_SIGNING');
    const passwordOnly = await syntheticAuthEvent(db, op, op, ch.challengeId, ['PASSWORD']);
    await expectRefused(signWith(db, op, ch.challengeId, passwordOnly), 'EBMR-ESIG-038', /ALL_COMPONENTS_REQUIRED/);
    const full = await signatureAuth(db, op, op, ch.challengeId);
    const second = await signWith(db, op, ch.challengeId, full);
    expect(second.componentsRequired).toBe('ALL');
  });
});

describe('the QA-approved relaxation (policy esig.session_relaxation)', () => {
  beforeAll(async () => {
    await setPolicy(db, 'esig.session_relaxation', 'true');
  });
  afterAll(async () => {
    await setPolicy(db, 'esig.session_relaxation', 'false');
  });

  it('[DI-38] sign twice in one session: the first signing needs all components, the second needs at least the password', async () => {
    const op = await testActor(db);
    const a = await createStub(db, op);
    // First signing of the continuous session: the private component alone is not enough.
    await expectRefused(signWithComponents(op, a, 'PERFORMED', ['PASSWORD']), 'EBMR-ESIG-038', /FIRST_SIGNING_OF_CONTINUOUS_SESSION/);
    const first = await signStub(db, op, a, { meaning: 'PERFORMED' });
    expect(first.componentsRequired).toBe('ALL');
    // Second signing: the password alone suffices ...
    const b = await createStub(db, op);
    const ch = await challengeFor(db, op, b, { meaning: 'PERFORMED' });
    expect(ch.requiredComponents).toBe('PRIVATE');
    const idOnly = await syntheticAuthEvent(db, op, op, ch.challengeId, ['USER_ID']);
    // ... but at least the password is needed: the identification component alone is refused.
    await expectRefused(signWith(db, op, ch.challengeId, idOnly), 'EBMR-ESIG-038', /PRIVATE_COMPONENT_REQUIRED/);
    const pw = await syntheticAuthEvent(db, op, op, ch.challengeId, ['PASSWORD']);
    const second = await signWith(db, op, ch.challengeId, pw);
    expect(second.componentsRequired).toBe('PRIVATE');
    expect(second.componentsReason).toBe('LATER_SIGNING_OF_CONTINUOUS_SESSION');
  });

  it('[DI-38] after an inactivity timeout both components are needed again', async () => {
    const op = await testActor(db);
    await signStub(db, op, await createStub(db, op), { meaning: 'PERFORMED' });
    await signWithComponents(op, await createStub(db, op), 'PERFORMED', ['PASSWORD']);
    const id = await createStub(db, op);
    // The session idles past its timeout: it locks, and a command is refused until it is unlocked.
    await asTimeTraveller(db, "update iam.session_activity set last_activity_at = last_activity_at - interval '2 hours' where session_id = $1", [op.sessionId]);
    await expectRefused(challengeFor(db, op, id, { meaning: 'PERFORMED' }), 'EBMR-IAM-113');
    const unlock = await authenticate(seedAuthn(db), {
      method: 'PASSWORD', identifier: op.seed.loginName, secret: op.seed.password, deviceFingerprint: op.seed.deviceFingerprint, purpose: 'SESSION_UNLOCK',
    });
    await unlockSession(db.app, op.sessionId, unlock.authEventId);
    // A new continuous session: the private component alone is refused, both components work.
    await expectRefused(signWithComponents(op, id, 'PERFORMED', ['PASSWORD']), 'EBMR-ESIG-038', /FIRST_SIGNING_OF_CONTINUOUS_SESSION/);
    const again = await signStub(db, op, id, { meaning: 'PERFORMED' });
    expect(again.componentsRequired).toBe('ALL');
    expect(again.componentsReason).toBe('FIRST_SIGNING_OF_CONTINUOUS_SESSION');
  });

  it('[DI-38] a lock of the terminal, a logout or another terminal also ends the continuous session', async () => {
    const op = await testActor(db);
    await signStub(db, op, await createStub(db, op), { meaning: 'PERFORMED' });
    await lockSession(db.app, op.sessionId);
    const unlock = await authenticate(seedAuthn(db), {
      method: 'PASSWORD', identifier: op.seed.loginName, secret: op.seed.password, deviceFingerprint: op.seed.deviceFingerprint, purpose: 'SESSION_UNLOCK',
    });
    await unlockSession(db.app, op.sessionId, unlock.authEventId);
    await expectRefused(signWithComponents(op, await createStub(db, op), 'PERFORMED', ['PASSWORD']), 'EBMR-ESIG-038', /FIRST_SIGNING_OF_CONTINUOUS_SESSION/);
    // Another terminal is another session: its first signing needs all components too.
    const anotherSession = await testActor(db);
    await expectRefused(signWithComponents(anotherSession, await createStub(db, anotherSession), 'PERFORMED', ['PASSWORD']), 'EBMR-ESIG-038');
  });

  it('[DI-38] the relaxation never applies to master-record approval, disposition or certification', async () => {
    const author = await testActor(db, { roleCode: 'MBR_AUTHOR' });
    const qa = await testActor(db, { roleCode: 'QA_MBR_APPROVER' });
    const doc1 = await createStub(db, author, { kind: 'MASTER_DOCUMENT', title: 'MBR v3', value: 'content' });
    const doc2 = await createStub(db, author, { kind: 'MASTER_DOCUMENT', title: 'MBR v4', value: 'content' });
    const first = await signStub(db, qa, doc1, { meaning: 'APPROVED' });
    expect(first.componentsRequired).toBe('ALL');
    const ch = await challengeFor(db, qa, doc2, { meaning: 'APPROVED' });
    expect(ch.requiredComponentsReason).toBe('MEANING_NEEDS_ALL_COMPONENTS');
    await expectRefused(signWithComponents(qa, doc2, 'APPROVED', ['PASSWORD']), 'EBMR-ESIG-038', /MEANING_NEEDS_ALL_COMPONENTS/);
    const { rows } = await db.app.query<{ code: string }>(
      "select code from esig.meaning_catalogue where (category in ('MASTER_RECORD', 'RELEASE') or role_class = 'RELEASE') and reauth <> 'ALL_COMPONENTS'");
    expect(rows).toEqual([]);
  });
});

describe('a verifier at the performer\'s terminal (co-signature)', () => {
  it('[DI-38] the verifier\'s signature cannot be applied through the performer\'s session: the performer\'s credentials and a PIN alone are refused', async () => {
    await setPolicy(db, 'esig.session_relaxation', 'true');
    try {
      const performer = await testActor(db, { deviceClass: 'SHARED', withPin: true, legalName: 'Kiosk Performer' });
      const verifier = await testActor(db, { roleCode: 'VERIFIER', deviceClass: 'SHARED', withPin: true, legalName: 'Kiosk Verifier' });
      const id = await createStub(db, performer);
      await signStub(db, performer, id, { meaning: 'PERFORMED', method: 'BADGE_PIN' });
      // The performer signs a second time in the continuous session with the PIN alone (relaxation) ...
      await signWithComponents(performer, await createStub(db, performer), 'PERFORMED', ['PIN'], 'BADGE_PIN');
      // ... but the verifier's signature at this terminal is a co-signature: it always needs all components.
      const ch = await challengeFor(db, performer, id, { meaning: 'VERIFIED', signer: verifier });
      expect(ch.cosignature).toBe(true);
      expect(ch.requiredComponents).toBe('ALL');
      expect(ch.requiredComponentsReason).toBe('NOT_THE_SESSION_OWNER');
      const pinOnly = await syntheticAuthEvent(db, verifier, performer, ch.challengeId, ['PIN'], 'BADGE_PIN');
      await expectRefused(signWith(db, performer, ch.challengeId, pinOnly, { signer: verifier }), 'EBMR-ESIG-038', /NOT_THE_SESSION_OWNER/);
      // The performer's own authentication can never supply the verifier's signature (no proxy signing).
      const performersEvent = await signatureAuth(db, performer, performer, ch.challengeId, 'BADGE_PIN');
      await expectRefused(signWith(db, performer, ch.challengeId, performersEvent, { signer: verifier }), 'EBMR-IAM-093');
      // Nor can the performer sign VERIFIED in their own name (no verifier authority; INV-03 would exclude them anyway).
      await expectRefused(challengeFor(db, performer, id, { meaning: 'VERIFIED' }).then(async (own) =>
        signWith(db, performer, own.challengeId, await signatureAuth(db, performer, performer, own.challengeId, 'BADGE_PIN'))), 'EBMR-ESIG-040');
      expect(await dbCount(db, "select 1 from esig.signature where aggregate_id = $1 and meaning_code = 'VERIFIED'", [id])).toBe(0);
      // The verifier with their own badge and PIN in the same dialog: accepted, attributed to the verifier.
      const own = await signatureAuth(db, verifier, performer, ch.challengeId, 'BADGE_PIN');
      const sig = await signWith(db, performer, ch.challengeId, own, { signer: verifier });
      expect(sig.cosignature).toBe(true);
      expect(sig.componentsRequired).toBe('ALL');
      const { rows } = await db.admin.query<{ person: string; ev: string }>(
        `select e.payload -> 'actor' ->> 'person_id' as person, e.payload -> 'actor' ->> 'auth_event_id' as ev
           from kernel.audit_event e where e.table_name = 'esig.signature' and e.record_id = $1`, [sig.signatureId]);
      expect(rows).toEqual([{ person: verifier.personId, ev: own }]);
      const row = await db.admin.query('select signer_person, session_person, device_id from esig.signature where id = $1', [sig.signatureId]);
      expect(row.rows[0]).toEqual({ signer_person: verifier.personId, session_person: performer.personId, device_id: performer.deviceId });
    } finally {
      await setPolicy(db, 'esig.session_relaxation', 'false');
    }
  });
});

describe('policy values', () => {
  it('[DI-38] MFA at signing can be switched on: then a signing without an MFA component is refused', async () => {
    await setPolicy(db, 'esig.mfa_at_signing', 'true');
    try {
      const op = await testActor(db);
      const id = await createStub(db, op);
      await expectRefused(signStub(db, op, id, { meaning: 'PERFORMED' }), 'EBMR-ESIG-038', /MFA_REQUIRED/);
      const sig = await signWithComponents(op, id, 'PERFORMED', ['USER_ID', 'PASSWORD', 'MFA']);
      expect(sig.componentsRequired).toBe('ALL');
    } finally {
      await setPolicy(db, 'esig.mfa_at_signing', 'false');
    }
  });

  it('[DI-38] only the quality unit changes a signing policy, with a reason and a change reference, within the allowed range', async () => {
    const { admin } = await seedAdministration(db);
    const operator = await testActor(db);
    await expectRefused(withCommand(db.app, underChange(await cmd(db, admin)), (c) =>
      setEsigPolicy(c, 'esig.session_relaxation', 'true', 'admin tries', 'CC-1')), 'EBMR-IAM-040');
    await expectRefused(run(db, underChange(operator), (c) => setEsigPolicy(c, 'esig.session_relaxation', 'true', 'operator tries', 'CC-1')), 'EBMR-IAM-040');
    const qa = underChange(await qaApprover(db));
    await expectRefused(run(db, qa, (c) => setEsigPolicy(c, 'esig.challenge_validity_seconds', '600', 'longer', 'CC-2')), 'EBMR-ESIG-005');
    await expectRefused(run(db, qa, (c) => setEsigPolicy(c, 'esig.session_relaxation', 'true', '', 'CC-3')), 'EBMR-ESIG-005');
    await expectRefused(run(db, qa, (c) => setEsigPolicy(c, 'esig.india_dsc', 'ON', 'not yet', 'CC-4')), 'EBMR-ESIG-005');
    const before = await dbCount(db, "select 1 from kernel.audit_event where chain_key = 'esig_policy:esig.witness_window_seconds'");
    await run(db, qa, (c) => setEsigPolicy(c, 'esig.witness_window_seconds', '240', 'SOP update', 'CC-5'));
    expect(await dbCount(db, "select 1 from kernel.audit_event where chain_key = 'esig_policy:esig.witness_window_seconds'")).toBe(before + 1);
    await expectPermissionDenied(db.app.query("update esig.policy_value set value = 'true'"));
  });
});
