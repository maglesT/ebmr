/**
 * Credential protection: lockout, misuse alerts with acknowledgement and escalation, badges,
 * secrets never visible to administrators, aging (DI-19; DI-15 for initial secrets).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '../../src/db/command.ts';
import { activateBadge, issueBadge, recordBadgeTest, recordIdentityVerification, setPolicy } from '../../src/identity/admin.ts';
import { authenticate, changeSecret } from '../../src/identity/authentication.ts';
import { AuthenticationFailedError } from '../../src/identity/errors.ts';
import { openSession } from '../../src/identity/sessions.ts';
import { createTestDatabase, type TestDatabase, urlFor } from '../support/db.ts';
import { asTimeTraveller, expectPermissionDenied, expectRefused, pause } from './helpers.ts';
import { seedActor, seedAdministration, seedAuthn, seedServiceActor, withFreshAuth, withReason, type SeedAdministration, type SeededActor } from './seed.ts';

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
const policy = (key: string, value: string) => withCommand(db.app, withReason(adm.admin, 'POLICY_CHANGE'), (c) => setPolicy(c, key, value, 'test'));
const uid = (): string => randomBytes(7).toString('hex').toUpperCase();

const wrongSignature = (a: SeededActor) =>
  authenticate(seedAuthn(db), { method: 'PASSWORD', identifier: a.seed.loginName, secret: 'not-my-password', deviceFingerprint: a.seed.deviceFingerprint, purpose: 'SIGNATURE', challengeId: randomUUID() });
const rightLogin = (a: SeededActor) =>
  authenticate(seedAuthn(db), { method: 'PASSWORD', identifier: a.seed.loginName, secret: a.seed.password, deviceFingerprint: a.seed.deviceFingerprint, purpose: 'LOGIN' });

describe('lockout and misuse alerts (DI-19)', () => {
  it('[DI-19] five failed signing attempts lock the account and the security unit is alerted at once', async () => {
    const op = await seedActor(db, { roleCode: 'VERIFIER' });
    const listener = new pg.Client({ connectionString: urlFor(db.name) });
    await listener.connect();
    const received: { kind: string; account_id: string; at: number }[] = [];
    listener.on('notification', (n) => {
      const body = JSON.parse(n.payload ?? '{}') as { kind: string; account_id: string };
      received.push({ ...body, at: performance.now() });
    });
    await listener.query('listen ebmr_security_alert');
    try {
      for (let i = 1; i <= 4; i++) await expect(wrongSignature(op)).rejects.toMatchObject({ reason: 'WRONG_SECRET', locked: false });
      const fifth = performance.now();
      await expect(wrongSignature(op)).rejects.toMatchObject({ reason: 'WRONG_SECRET', locked: true });
      await pause(200);
      const locked = received.find((r) => r.kind === 'ACCOUNT_LOCKED' && r.account_id === op.accountId);
      expect(locked).toBeDefined();
      expect((locked?.at ?? Infinity) - fifth).toBeLessThan(2000);
    } finally {
      await listener.end();
    }
    const alerts = await db.app.query<{ kind: string; n: number }>(
      'select kind, count(*)::int as n from iam.security_alert where account_id = $1 group by kind order by kind',
      [op.accountId],
    );
    expect(alerts.rows).toEqual([{ kind: 'ACCOUNT_LOCKED', n: 1 }, { kind: 'SIGNING_FAILED', n: 5 }]);
    // Locked: the right password is refused and alerted, the open session is gone, commands fail.
    await expect(rightLogin(op)).rejects.toMatchObject({ reason: 'ACCOUNT_LOCKED' });
    const misuse = await db.app.query("select 1 from iam.security_alert where account_id = $1 and kind = 'LOCKED_ACCOUNT_USE'", [op.accountId]);
    expect(misuse.rowCount).toBe(1);
    await expectRefused(withCommand(db.app, op, (c) => c.query('select 1')), 'EBMR-IAM-105');
    // Unlock is an attributed administrator act on the account's audit chain; the count restarts.
    await expectRefused(withCommand(db.app, withReason(adm.admin), (c) => c.query("select iam.unlock_account($1, '')", [op.accountId])), 'EBMR-IAM-004');
    await asAdmin((c) => c.query("select iam.unlock_account($1, 'identity confirmed by phone call')", [op.accountId]));
    const chain = await db.app.query("select payload -> 'body' ->> 'message' as m from kernel.audit_event where chain_key = $1 and action = 'BUSINESS'", [`account:${op.accountId}`]);
    expect(chain.rows).toEqual([{ m: 'account unlocked' }]);
    await expect(wrongSignature(op)).rejects.toMatchObject({ locked: false });
    await expect(rightLogin(op)).resolves.toMatchObject({ purpose: 'LOGIN' });
  });

  it('[DI-19] the lockout threshold is a policy value allowed between 3 and 5', async () => {
    await expectRefused(policy('authn.lockout_threshold', '6'), 'EBMR-IAM-110');
    await expectRefused(policy('authn.lockout_threshold', '2'), 'EBMR-IAM-110');
    await policy('authn.lockout_threshold', '3');
    const op = await seedActor(db, { acknowledgeEsig: false });
    const bad = () =>
      authenticate(seedAuthn(db), { method: 'PASSWORD', identifier: op.seed.loginName, secret: 'wrong', deviceFingerprint: op.seed.deviceFingerprint, purpose: 'LOGIN' });
    await expect(bad()).rejects.toMatchObject({ locked: false });
    await expect(bad()).rejects.toMatchObject({ locked: false });
    await expect(bad()).rejects.toMatchObject({ locked: true });
    await policy('authn.lockout_threshold', '5');
  });

  it('[DI-19] unanswered alerts escalate; acknowledgement is tracked and never by the person concerned', async () => {
    await policy('alert.ack_deadline_seconds', '1');
    try {
      const qa = await seedActor(db, { roleCode: 'QA_SHOP_FLOOR' });
      await expect(
        authenticate(seedAuthn(db), { method: 'PASSWORD', identifier: qa.seed.loginName, secret: 'wrong', deviceFingerprint: qa.seed.deviceFingerprint, purpose: 'LOGIN' }),
      ).rejects.toThrow(AuthenticationFailedError);
      const alert = (await db.app.query<{ id: string }>("select id from iam.security_alert where account_id = $1 and kind = 'AUTHENTICATION_FAILED'", [qa.accountId])).rows[0]?.id ?? '';
      await pause(1100);
      const svc = await seedServiceActor(db);
      const n = await withCommand(db.app, svc, async (c) => (await c.query<{ n: number }>('select iam.escalate_overdue_alerts() as n')).rows[0]?.n ?? 0);
      expect(n).toBeGreaterThanOrEqual(1);
      const esc = await db.app.query('select by_person from iam.security_alert_action where alert_id = $1 and action = $2', [alert, 'ESCALATED']);
      expect(esc.rows).toEqual([{ by_person: svc.personId }]);
      expect((await db.app.query('select escalated from iam.open_security_alert where id = $1', [alert])).rows).toEqual([{ escalated: true }]);
      await expectRefused(withCommand(db.app, qa, (c) => c.query("select iam.acknowledge_alert($1, 'it was me')", [alert])), 'EBMR-IAM-003');
      await asAdmin((c) => c.query("select iam.acknowledge_alert($1, 'typing error confirmed with the user')", [alert]));
      expect((await db.app.query('select 1 from iam.open_security_alert where id = $1', [alert])).rowCount).toBe(0);
      await expectRefused(asAdmin((c) => c.query("select iam.acknowledge_alert($1, 'again')", [alert])), 'EBMR-IAM-150');
    } finally {
      await policy('alert.ack_deadline_seconds', '900');
    }
  });
});

describe('badges (DI-19)', () => {
  it('[DI-19] a revoked or lost badge cannot authenticate, and its use is alerted', async () => {
    const op = await seedActor(db, { deviceClass: 'SHARED', acknowledgeEsig: false });
    const tap = () => authenticate(seedAuthn(db), { method: 'BADGE_TAP', identifier: op.seed.badgeUid ?? '', deviceFingerprint: op.seed.deviceFingerprint, purpose: 'COMMAND' });
    await tap();
    await asAdmin((c) => c.query("select iam.revoke_badge($1, 'reported cloned')", [op.seed.badgeId]));
    await expect(tap()).rejects.toMatchObject({ reason: 'BADGE_REVOKED' });
    const s = await db.app.query('select end_reason from iam.session where id = $1', [op.sessionId]);
    expect(s.rows).toEqual([{ end_reason: 'BADGE_REVOKED' }]);

    const other = await seedActor(db, { deviceClass: 'SHARED', acknowledgeEsig: false });
    // The holder reports their own badge lost (a change, so the command carries a reason code).
    await withCommand(db.app, withReason(await withFreshAuth(db, other), 'BADGE_LOST', 'lost in the changing room'), (c) =>
      c.query("select iam.report_badge_lost($1, 'lost in the changing room')", [other.seed.badgeId]));
    await expect(
      authenticate(seedAuthn(db), { method: 'BADGE_TAP', identifier: other.seed.badgeUid ?? '', deviceFingerprint: other.seed.deviceFingerprint, purpose: 'COMMAND' }),
    ).rejects.toMatchObject({ reason: 'BADGE_LOST' });
    const alerts = await db.app.query("select count(*)::int as n from iam.security_alert where kind = 'BADGE_NOT_ACTIVE' and account_id in ($1, $2)", [op.accountId, other.accountId]);
    expect(alerts.rows[0]).toEqual({ n: 2 });
  });

  it('[DI-19] badge test records exist: activation needs a passing test at issue, and periodic tests are tracked', async () => {
    const op = await seedActor(db, { acknowledgeEsig: false });
    const badge = await asAdmin((c) =>
      issueBadge(c, { accountId: op.accountId, uid: uid(), technology: 'ISO14443_DESFIRE_EV3', label: 'B-1001', identityVerificationId: op.seed.identityVerificationId ?? '' }));
    await expectRefused(asAdmin((c) => activateBadge(c, badge)), 'EBMR-IAM-062');
    await asAdmin((c) => recordBadgeTest(c, badge, 'AT_ISSUE', 'FAIL', 'reader did not detect the card'));
    await expectRefused(asAdmin((c) => activateBadge(c, badge)), 'EBMR-IAM-062');
    await asAdmin((c) => recordBadgeTest(c, badge, 'AT_ISSUE', 'PASS'));
    await asAdmin((c) => activateBadge(c, badge));
    const tests = await db.app.query('select kind, result, tested_by_person from iam.badge_test where badge_id = $1 order by recorded_at', [badge]);
    expect(tests.rows).toEqual([
      { kind: 'AT_ISSUE', result: 'FAIL', tested_by_person: adm.admin.personId },
      { kind: 'AT_ISSUE', result: 'PASS', tested_by_person: adm.admin.personId },
    ]);
    const due = (at: string) => db.app.query<{ overdue: boolean }>(`select overdue from iam.badges_due_for_test(${at}) where badge_id = $1`, [badge]);
    expect((await due('null')).rows).toEqual([{ overdue: false }]);
    expect((await due("clock_timestamp() + interval '366 days'")).rows).toEqual([{ overdue: true }]);
    await asTimeTraveller(db, "update iam.badge_test set recorded_at = recorded_at - interval '400 days' where badge_id = $1", [badge]);
    expect((await due('null')).rows).toEqual([{ overdue: true }]);
    await asAdmin((c) => recordBadgeTest(c, badge, 'PERIODIC', 'PASS'));
    expect((await due('null')).rows).toEqual([{ overdue: false }]);
    await expectRefused(withCommand(db.app, op, (c) => c.query("select iam.record_badge_test($1, 'PERIODIC', 'PASS')", [badge])), 'EBMR-IAM-040');
  });

  it('[DI-19] a replacement badge is issued only after the identity is verified again', async () => {
    const op = await seedActor(db, { deviceClass: 'SHARED', acknowledgeEsig: false });
    await asAdmin((c) => c.query("select iam.report_badge_lost($1, 'lost')", [op.seed.badgeId]));
    const issue = (ivId: string) =>
      asAdmin((c) => issueBadge(c, { accountId: op.accountId, uid: uid(), technology: 'ISO14443_SEOS', label: 'B-2002', identityVerificationId: ivId, replacesBadgeId: op.seed.badgeId ?? '' }));
    await expectRefused(issue(op.seed.identityVerificationId ?? ''), 'EBMR-IAM-063', /re-verified/);
    const iv = await asAdmin((c) =>
      recordIdentityVerification(c, { personId: op.personId, purpose: 'BADGE_REPLACEMENT', method: 'IN_PERSON_DOCUMENT', documentType: 'Passport', evidenceRef: 'HR-R1', occurredAt: '2026-09-27T08:00:00Z' }));
    const badge = await issue(iv);
    await asAdmin(async (c) => {
      await recordBadgeTest(c, badge, 'AT_ISSUE', 'PASS');
      await activateBadge(c, badge);
    });
    expect((await db.app.query('select status from iam.badge where id = $1', [op.seed.badgeId])).rows).toEqual([{ status: 'LOST' }]);
  });

  it('[DI-19] clonable badge technology and reused badge UIDs are refused', async () => {
    const op = await seedActor(db, { deviceClass: 'SHARED', acknowledgeEsig: false });
    const iv = await asAdmin((c) =>
      recordIdentityVerification(c, { personId: op.personId, purpose: 'BADGE_REPLACEMENT', method: 'IN_PERSON_DOCUMENT', documentType: 'Passport', evidenceRef: 'HR-R2', occurredAt: '2026-09-27T08:00:00Z' }));
    await expectRefused(
      asAdmin((c) => issueBadge(c, { accountId: op.accountId, uid: uid(), technology: 'LF_125KHZ_PROX', label: 'B-3', identityVerificationId: iv })),
      'EBMR-IAM-060',
      /clonable/,
    );
    await expectRefused(
      asAdmin((c) => issueBadge(c, { accountId: op.accountId, uid: op.seed.badgeUid ?? '', technology: 'ISO14443_SEOS', label: 'B-4', identityVerificationId: iv })),
      'EBMR-IAM-060',
      /never issued again/,
    );
  });
});

describe('secrets (DI-19, DI-15)', () => {
  it('[DI-19] administrators never see secrets: verifiers are unreadable by the application and absent from the audit trail', async () => {
    await seedActor(db, { deviceClass: 'SHARED', withPin: true, acknowledgeEsig: false });
    await expectPermissionDenied(db.app.query('select * from iam.credential_secret'));
    await expectPermissionDenied(db.app.query('select * from iam.badge_secret'));
    await expectPermissionDenied(db.app.query('select * from iam.installation_secret'));
    await expectPermissionDenied(db.app.query('select * from iam.authn_attempt'));
    await expectPermissionDenied(db.app.query("select iam.authn_prepare('PASSWORD', 'x', 'y', 'LOGIN', null)"));
    await expectPermissionDenied(db.app.query("select iam.authn_secret_history(gen_random_uuid(), 'PASSWORD')"));
    const leaked = await db.admin.query(
      "select count(*)::int as n from kernel.audit_event where payload::text like '%$argon2id$%' or payload::text like '%\"verifier\":%' or payload::text like '%\"uid_hash\":%'",
    );
    expect(leaked.rows[0]).toEqual({ n: 0 });
    const cols = await db.app.query("select column_name from information_schema.columns where table_schema = 'iam' and table_name = 'credential'");
    expect(cols.rows.map((r: { column_name: string }) => r.column_name)).not.toContain('verifier');
    const stored = await db.admin.query<{ ok: boolean }>("select bool_and(verifier like '$argon2id$v=19$m=19456,t=2,p=1$%') as ok from iam.credential_secret");
    expect(stored.rows[0]?.ok).toBe(true);
  });

  it('[DI-19] a configuration with neither password aging nor compromised-password screening is refused', async () => {
    await expectRefused(policy('credential.password_max_age_days', '0'), 'EBMR-IAM-111', /DI-19/);
    await policy('credential.compromised_screening', 'true');
    await policy('credential.password_max_age_days', '0');
    await expectRefused(policy('credential.compromised_screening', 'false'), 'EBMR-IAM-111');
    await policy('credential.password_max_age_days', '90');
    await policy('credential.compromised_screening', 'false');
  });

  it('[DI-19] an aged password proves identity only to change it: no session and no signature until it is changed', async () => {
    const op = await seedActor(db, { roleCode: 'VERIFIER' });
    await asTimeTraveller(db, "update iam.credential set expires_at = clock_timestamp() - interval '1 day' where account_id = $1 and kind = 'PASSWORD' and status = 'ACTIVE'", [op.accountId]);
    const ev = await rightLogin(op);
    expect(ev).toMatchObject({ restricted: true, purpose: 'CREDENTIAL_CHANGE' });
    await expectRefused(openSession(db.app, ev.authEventId, op.seed.deviceFingerprint), 'EBMR-IAM-052');
    const can = await db.app.query<{ r: { reasons: string[] } }>('select iam.can_sign($1) as r', [op.accountId]);
    expect(can.rows[0]?.r.reasons).toEqual(['SECRET_MUST_BE_CHANGED']);
    await changeSecret(seedAuthn(db), { authEventId: ev.authEventId, kind: 'PASSWORD', newSecret: 'Renewed-password-2026' });
    await expect(authenticate(seedAuthn(db), { method: 'PASSWORD', identifier: op.seed.loginName, secret: 'Renewed-password-2026', deviceFingerprint: op.seed.deviceFingerprint, purpose: 'LOGIN' })).resolves.toMatchObject({ restricted: false });
  });

  it('[DI-19] a new secret must meet policy and differ from recent ones', async () => {
    const op = await seedActor(db, { acknowledgeEsig: false });
    const change = async (newSecret: string) => {
      const ev = await authenticate(seedAuthn(db), { method: 'PASSWORD', identifier: op.seed.loginName, secret: op.seed.password, deviceFingerprint: op.seed.deviceFingerprint, purpose: 'CREDENTIAL_CHANGE' });
      return changeSecret(seedAuthn(db), { authEventId: ev.authEventId, kind: 'PASSWORD', newSecret, loginName: op.seed.loginName });
    };
    await expectRefused(change(op.seed.password), 'EBMR-IAM-055', /recent/);
    await expectRefused(change('short'), 'EBMR-IAM-055', /shorter than 12/);
    await expectRefused(change(`${op.seed.loginName}-2026!`), 'EBMR-IAM-055', /login name/);
    await expectRefused(change('password123'), 'EBMR-IAM-055');
    await change('Another-Long-Secret-77');
  });

  it('[DI-19] a change-secret event is single-use and needs the current secret of that kind', async () => {
    const op = await seedActor(db, { deviceClass: 'SHARED', withPin: true, acknowledgeEsig: false });
    const authn = seedAuthn(db);
    const ev = await authenticate(authn, { method: 'PASSWORD', identifier: op.seed.loginName, secret: op.seed.password, deviceFingerprint: op.seed.deviceFingerprint, purpose: 'CREDENTIAL_CHANGE' });
    await expectRefused(changeSecret(authn, { authEventId: ev.authEventId, kind: 'PIN', newSecret: '482915' }), 'EBMR-IAM-096');
    await changeSecret(authn, { authEventId: ev.authEventId, kind: 'PASSWORD', newSecret: 'Fresh-Password-9911' });
    await expectRefused(changeSecret(authn, { authEventId: ev.authEventId, kind: 'PASSWORD', newSecret: 'Other-Password-9911' }), 'EBMR-IAM-091');
    const pinEv = await authenticate(authn, { method: 'BADGE_PIN', identifier: op.seed.badgeUid ?? '', secret: op.seed.pin ?? '', deviceFingerprint: op.seed.deviceFingerprint, purpose: 'CREDENTIAL_CHANGE' });
    await expectRefused(changeSecret(authn, { authEventId: pinEv.authEventId, kind: 'PIN', newSecret: '123456' }), 'EBMR-IAM-055', /sequence/);
    await changeSecret(authn, { authEventId: pinEv.authEventId, kind: 'PIN', newSecret: '482915' });
  });
});
