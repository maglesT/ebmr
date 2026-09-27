/**
 * Unique personal accounts; no shared write-capable accounts; service accounts never sign (DI-14).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import {
  activateAccount,
  createAccount,
  createPerson,
  decideRoleGrant,
  issueInitialSecret,
  recordIdentityVerification,
  registerDevice,
  requestRoleGrant,
} from '../../src/identity/admin.ts';
import { authenticate, changeSecret } from '../../src/identity/authentication.ts';
import { evaluateAuthority } from '../../src/identity/authority.ts';
import { openSession } from '../../src/identity/sessions.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { asSuperuserTransaction, expectRefused } from './helpers.ts';
import { attestDevice, SEED_SITE, seedActor, seedAdministration, seedAuthn, seedServiceActor, withFreshAuth, withReason, type SeedAdministration } from './seed.ts';

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

/** A natural person (verified) with a shared or display account, not yet granted anything. */
async function sharedAccount(kind: 'HUMAN' | 'READONLY_DISPLAY', generic: boolean) {
  return asAdmin(async (c) => {
    const personId = await createPerson(c, 'NATURAL', `Line Owner ${hex(2)}`);
    await recordIdentityVerification(c, { personId, purpose: 'INITIAL', method: 'IN_PERSON_DOCUMENT', documentType: 'ID card', evidenceRef: 'HR-1', occurredAt: '2026-01-05T09:00:00Z' });
    const loginName = `line-${hex()}`;
    const accountId = await createAccount(c, { personId, loginName, kind, generic });
    const { secret } = await issueInitialSecret(c, accountId, 'PASSWORD');
    await activateAccount(c, accountId);
    return { personId, accountId, loginName, secret };
  });
}

describe('no shared write-capable accounts (DI-14)', () => {
  it('[DI-14] assigning a write permission to an account flagged generic is refused at assignment', async () => {
    const g = await sharedAccount('HUMAN', true);
    for (const role of ['OPERATOR', 'VERIFIER', 'SHIFT_SUPERVISOR', 'SYSTEM_ADMINISTRATOR', 'QA_SHOP_FLOOR']) {
      await expectRefused(asAdmin((c) => requestRoleGrant(c, { accountId: g.accountId, roleCode: role, reason: 'shared line login' })), 'EBMR-IAM-034', /DI-14/);
    }
    const ok = await asAdmin((c) => requestRoleGrant(c, { accountId: g.accountId, roleCode: 'STATUS_DISPLAY', reason: 'line status screen' }));
    await asOwner((c) => decideRoleGrant(c, ok, true, 'read-only'));
    const d = await evaluateAuthority(db.app, { personId: g.personId, accountId: g.accountId, permission: 'ALARM.ACKNOWLEDGE' });
    expect(d).toMatchObject({ allowed: false });
    expect(d.reasons).toContain('ACCOUNT_READ_ONLY');
  });

  it('[DI-14] a read-only display account can log in to view but is technically unable to start any command', async () => {
    const d = await sharedAccount('READONLY_DISPLAY', false);
    await expectRefused(asAdmin((c) => requestRoleGrant(c, { accountId: d.accountId, roleCode: 'OPERATOR', reason: 'x' })), 'EBMR-IAM-034');
    const g = await asAdmin((c) => requestRoleGrant(c, { accountId: d.accountId, roleCode: 'STATUS_DISPLAY', reason: 'line status screen' }));
    await asOwner((c) => decideRoleGrant(c, g, true, 'read-only'));
    const fp = randomBytes(32).toString('hex');
    await attestDevice(db, await asAdmin((c) => registerDevice(c, { code: `DSP-${hex()}`, deviceClass: 'SHARED', site: SEED_SITE, fingerprint: fp, description: 'line display' })), 'SHARED');
    const authn = seedAuthn(db);
    const first = await authenticate(authn, { method: 'PASSWORD', identifier: d.loginName, secret: d.secret, deviceFingerprint: fp, purpose: 'LOGIN' });
    const password = `Display-${hex(8)}`;
    await changeSecret(authn, { authEventId: first.authEventId, kind: 'PASSWORD', newSecret: password });
    const ev = await authenticate(authn, { method: 'PASSWORD', identifier: d.loginName, secret: password, deviceFingerprint: fp, purpose: 'LOGIN' });
    const s = await openSession(db.app, ev.authEventId, fp);
    const ctx: ActorContext = { personId: d.personId, accountId: d.accountId, roleCode: 'STATUS_DISPLAY', sessionId: s.sessionId, deviceId: s.deviceId, source: 'UI', siteZone: 'Asia/Kolkata' };
    await expectRefused(withCommand(db.app, ctx, (c) => c.query('select 1')), 'EBMR-IAM-106', /DI-14/);
    await expect(authenticate(authn, { method: 'PASSWORD', identifier: d.loginName, secret: password, deviceFingerprint: fp, purpose: 'COMMAND' })).rejects.toMatchObject({ reason: 'READ_ONLY_ACCOUNT' });
    await expect(authenticate(authn, { method: 'PASSWORD', identifier: d.loginName, secret: password, deviceFingerprint: fp, purpose: 'SIGNATURE', challengeId: randomUUID() })).rejects.toMatchObject({ reason: 'READ_ONLY_ACCOUNT' });
    const alerts = await db.app.query("select count(*)::int as n from iam.security_alert where account_id = $1 and kind = 'READ_ONLY_ACCOUNT_MISUSE'", [d.accountId]);
    expect(alerts.rows[0]).toEqual({ n: 2 });
    const can = await db.app.query<{ r: { reasons: string[] } }>('select iam.can_sign($1) as r', [d.accountId]);
    expect(can.rows[0]?.r.reasons).toContain('ACCOUNT_KIND_CANNOT_SIGN');
  });

  it('[DI-14] a line display owned by a shop-floor worker does not end the worker\'s personal kiosk session', async () => {
    const worker = await seedActor(db, { deviceClass: 'SHARED', acknowledgeEsig: false });
    const loginName = `disp-${hex()}`;
    const { accountId, secret } = await asAdmin(async (c) => {
      const id = await createAccount(c, { personId: worker.personId, loginName, kind: 'READONLY_DISPLAY' });
      const s = await issueInitialSecret(c, id, 'PASSWORD');
      await activateAccount(c, id);
      return { accountId: id, secret: s.secret };
    });
    const g = await asAdmin((c) => requestRoleGrant(c, { accountId, roleCode: 'STATUS_DISPLAY', reason: 'line status screen' }));
    await asOwner((c) => decideRoleGrant(c, g, true, 'read-only'));
    const fp = randomBytes(32).toString('hex');
    await attestDevice(db, await asAdmin((c) => registerDevice(c, { code: `DSP-${hex()}`, deviceClass: 'SHARED', site: SEED_SITE, fingerprint: fp, description: 'line display' })), 'SHARED');
    const authn = seedAuthn(db);
    const first = await authenticate(authn, { method: 'PASSWORD', identifier: loginName, secret, deviceFingerprint: fp, purpose: 'LOGIN' });
    const password = `Display-${hex(8)}`;
    await changeSecret(authn, { authEventId: first.authEventId, kind: 'PASSWORD', newSecret: password });
    const ev = await authenticate(authn, { method: 'PASSWORD', identifier: loginName, secret: password, deviceFingerprint: fp, purpose: 'LOGIN' });
    const displaySession = await openSession(db.app, ev.authEventId, fp);
    const states = await db.app.query<{ worker: string; display: string }>('select iam.session_state($1) as worker, iam.session_state($2) as display', [
      worker.sessionId,
      displaySession.sessionId,
    ]);
    expect(states.rows[0]).toEqual({ worker: 'ACTIVE', display: 'ACTIVE' });
    await withCommand(db.app, await withFreshAuth(db, worker), (c) => c.query('select 1'));
  });

  it('[DI-14] a service account attempting a signature is blocked everywhere', async () => {
    const svc = await seedServiceActor(db);
    await expectRefused(asAdmin((c) => requestRoleGrant(c, { accountId: svc.accountId, roleCode: 'VERIFIER', reason: 'auto-verify' })), 'EBMR-IAM-035', /DI-14/);
    const authn = seedAuthn(db);
    await expect(
      authenticate(authn, { method: 'SERVICE_KEY', identifier: svc.seed.loginName, secret: svc.seed.password, deviceFingerprint: svc.seed.deviceFingerprint, purpose: 'SIGNATURE', challengeId: randomUUID() }),
    ).rejects.toThrow('EBMR-IAM-096');
    await expect(
      authenticate(authn, { method: 'PASSWORD', identifier: svc.seed.loginName, secret: svc.seed.password, deviceFingerprint: svc.seed.deviceFingerprint, purpose: 'SIGNATURE', challengeId: randomUUID() }),
    ).rejects.toMatchObject({ reason: 'DEVICE_CLASS_MISUSE' });
    const op = await seedActor(db, { acknowledgeEsig: false });
    await expect(
      authenticate(authn, { method: 'PASSWORD', identifier: svc.seed.loginName, secret: svc.seed.password, deviceFingerprint: op.seed.deviceFingerprint, purpose: 'SIGNATURE', challengeId: randomUUID() }),
    ).rejects.toMatchObject({ reason: 'METHOD_NOT_FOR_ACCOUNT_KIND' });
    const alert = await db.app.query("select severity from iam.security_alert where account_id = $1 and kind = 'SERVICE_ACCOUNT_INTERACTIVE_USE'", [svc.accountId]);
    expect(alert.rows).toEqual([{ severity: 'HIGH' }]);
    const can = await db.app.query<{ r: { can_sign: boolean; reasons: string[] } }>('select iam.can_sign($1) as r', [svc.accountId]);
    expect(can.rows[0]?.r.reasons).toEqual(expect.arrayContaining(['ACCOUNT_KIND_CANNOT_SIGN', 'NO_SIGNING_PERMISSION']));
    const verify = await evaluateAuthority(db.app, { personId: svc.personId, accountId: svc.accountId, permission: 'STEP.VERIFY' });
    expect(verify.reasons).toContain('NON_INTERACTIVE_ACCOUNT_CANNOT_SIGN');
    await expectRefused(withCommand(db.app, { ...svc, source: 'UI' }, (c) => c.query('select 1')), 'EBMR-IAM-107');
  });

  it('[DI-14] on a shared terminal each entry belongs to the person who authenticated for that entry', async () => {
    const op1 = await seedActor(db, { deviceClass: 'SHARED', acknowledgeEsig: false });
    const op2 = await seedActor(db, { deviceClass: 'SHARED', acknowledgeEsig: false });
    // op2 switches to op1's terminal: a login there ends op2's other shop-floor session.
    const authn = seedAuthn(db);
    const login = await authenticate(authn, { method: 'PASSWORD', identifier: op2.seed.loginName, secret: op2.seed.password, deviceFingerprint: op1.seed.deviceFingerprint, purpose: 'LOGIN' });
    const s2 = await openSession(db.app, login.authEventId, op1.seed.deviceFingerprint);
    const old = await db.app.query('select end_reason from iam.session where id = $1', [op2.sessionId]);
    expect(old.rows[0]).toEqual({ end_reason: 'SUPERSEDED' });
    const tap2 = await authenticate(authn, { method: 'BADGE_TAP', identifier: op2.seed.badgeUid ?? '', deviceFingerprint: op1.seed.deviceFingerprint, purpose: 'COMMAND' });
    const op2Here: ActorContext = { ...op2, sessionId: s2.sessionId, deviceId: s2.deviceId, authEventId: tap2.authEventId, correlationId: randomUUID() };
    const batch = randomUUID();
    await expectRefused(
      withCommand(db.app, { ...op1, authEventId: tap2.authEventId, correlationId: randomUUID() }, (c) => c.query('insert into testgmp.sample (batch_id, value) values ($1, 1)', [batch])),
      'EBMR-IAM-122',
    );
    await withCommand(db.app, op2Here, (c) => c.query('insert into testgmp.sample (batch_id, value) values ($1, 2)', [batch]));
    await withCommand(db.app, await withFreshAuth(db, op1), (c) => c.query('insert into testgmp.sample (batch_id, value) values ($1, 3)', [batch]));
    const { rows } = await db.app.query<{ person: string; device: string }>(
      "select payload -> 'actor' ->> 'person_id' as person, payload -> 'actor' ->> 'device_id' as device from kernel.audit_event where chain_key = $1 order by seq",
      [`batch:${batch}`],
    );
    expect(rows).toEqual([
      { person: op2.personId, device: op1.deviceId },
      { person: op1.personId, device: op1.deviceId },
    ]);
  });

  it('[DI-14] a directory scan finds no generic account holding GMP permissions, and it would find one', async () => {
    const clean = await db.app.query('select * from iam.directory_scan()');
    expect(clean.rows).toEqual([]);
    // Prove the scan detects what the triggers prevent: plant a grant with triggers off (superuser, rolled back).
    const g = await sharedAccount('HUMAN', true);
    let found: unknown[] = [];
    await asSuperuserTransaction(db, async (c) => {
      await c.query('set local session_replication_role = replica');
      await c.query(
        `insert into iam.role_grant (account_id, person_id, role_code, valid_from, reason, status, requested_by_person, requested_by_account,
                                     decided_by_person, decided_by_account, decided_at)
         values ($1, $2, 'OPERATOR', now(), 'planted', 'APPROVED', $3, $4, $5, $6, now())`,
        [g.accountId, g.personId, adm.admin.personId, adm.admin.accountId, adm.owner.personId, adm.owner.accountId],
      );
      found = (await c.query<{ finding: string }>('select finding from iam.directory_scan()')).rows.map((r) => r.finding);
    });
    expect(found).toContain('GENERIC_OR_DISPLAY_ACCOUNT_WITH_NON_READ_PERMISSION');
  });
});
