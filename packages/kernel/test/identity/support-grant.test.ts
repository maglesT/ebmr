/**
 * Vendor support only inside a customer-approved, time-boxed grant (kernel 1202; DI-08, D-P6f-2). Everything runs as
 * the application role (ebmr_app) and the authentication service role, with bypass attempts.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '../../src/db/command.ts';
import { sign } from '../../src/esig/signing.ts';
import { decideRoleGrant, requestRoleGrant } from '../../src/identity/admin.ts';
import { authenticate } from '../../src/identity/authentication.ts';
import { AuthenticationFailedError } from '../../src/identity/errors.ts';
import { openSession } from '../../src/identity/sessions.ts';
import { challengeFor, cmd, ensureSealKey, signatureAuth, testSealKey } from '../esig/helpers.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { asTimeTraveller, expectPermissionDenied, expectRefused } from './helpers.ts';
import { seedActor, seedAdministration, seedAuthn, withReason, type SeededActor } from './seed.ts';
import {
  approveSupportGrant,
  openSupportGrant,
  requestSupportGrant,
  seedSupportEngineer,
  supportApprovers,
  supportLogin,
  type SupportEngineer,
} from './support-grant.ts';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db?.drop();
});

const count = async (sql: string, params: unknown[]): Promise<number> => {
  const { rows } = await db.admin.query<{ n: string }>(`select count(*)::text as n from (${sql}) x`, params);
  return Number(rows[0]?.n ?? '0');
};

async function loginRefused(engineer: SupportEngineer, reason: string): Promise<void> {
  let caught: unknown;
  try {
    await authenticate(seedAuthn(db), { method: 'PASSWORD', identifier: engineer.loginName, secret: engineer.password, deviceFingerprint: engineer.fingerprint, purpose: 'LOGIN' });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AuthenticationFailedError);
  expect(String((caught as Error).message)).toContain(reason);
}

describe('vendor support grants (kernel 1202; DI-08)', () => {
  it('[DI-08] a support login without a time-boxed grant is refused, and the refusal is logged with a HIGH alert', async () => {
    const engineer = await seedSupportEngineer(db);
    await loginRefused(engineer, 'SUPPORT_NO_LIVE_GRANT');
    expect(await count(`select 1 from iam.authn_attempt where account_id = $1 and outcome = 'REFUSED' and reason = 'SUPPORT_NO_LIVE_GRANT'`, [engineer.accountId])).toBe(1);
    expect(await count(`select 1 from iam.security_alert where account_id = $1 and kind = 'SUPPORT_ACCESS_REFUSED' and severity = 'HIGH'`, [engineer.accountId])).toBe(1);
    // A pending grant (one signature only) is no grant.
    const { qa } = await supportApprovers(db);
    const grant = await requestSupportGrant(db, engineer);
    expect(await approveSupportGrant(db, qa, grant, 'SUPPORT_ACCESS_QA_APPROVED')).toBe('PENDING');
    await loginRefused(engineer, 'SUPPORT_NO_LIVE_GRANT');
    expect(await count(`select 1 from iam.session where account_id = $1`, [engineer.accountId])).toBe(0);
  });

  it('[DI-08] with QA and IT approvals the named engineer logs in inside the window; each use raises an alert for review', async () => {
    const engineer = await seedSupportEngineer(db);
    const grant = await openSupportGrant(db, engineer, 2);
    const { rows } = await db.app.query<{ s: string; h: string }>(
      `select iam.support_grant_state($1) as s, extract(epoch from (a.valid_to - a.valid_from))::bigint::text as h from iam.support_grant_activation a where a.grant_id = $1`, [grant]);
    expect(rows[0]).toEqual({ s: 'ACTIVE', h: '7200' });
    const support = await supportLogin(db, engineer);
    expect(await count(`select 1 from iam.support_session where session_id = $1 and grant_id = $2`, [support.sessionId, grant])).toBe(1);
    expect(await count(`select 1 from iam.security_alert where account_id = $1 and kind = 'SUPPORT_ACCESS_USED'`, [engineer.accountId])).toBeGreaterThanOrEqual(2);
    // Inside the grant, support still never touches GMP data (VENDOR_SUPPORT is an administration role; DI-18).
    await expectRefused(withCommand(db.app, { ...support, correlationId: randomUUID() }, (c) => c.query('select iam.assert_not_administrator()')), 'EBMR-IAM-042');
    // ...and never signs.
    let caught: unknown;
    try {
      await authenticate(seedAuthn(db), { method: 'PASSWORD', identifier: engineer.loginName, secret: engineer.password, deviceFingerprint: engineer.fingerprint, purpose: 'SIGNATURE', challengeId: randomUUID() });
    } catch (error) {
      caught = error;
    }
    expect(String((caught as Error).message)).toContain('SUPPORT_CANNOT_SIGN');
  });

  it('[DI-08] the grant ends by itself: the open session expires, commands are refused and a new login is refused', async () => {
    const engineer = await seedSupportEngineer(db);
    const grant = await openSupportGrant(db, engineer, 1);
    const support = await supportLogin(db, engineer);
    await withCommand(db.app, { ...support, correlationId: randomUUID() }, () => Promise.resolve(undefined));
    await asTimeTraveller(db, `update iam.support_grant_activation set valid_from = valid_from - interval '2 hours', valid_to = valid_to - interval '2 hours' where grant_id = $1`, [grant]);
    const { rows } = await db.app.query<{ s: string; g: string }>('select iam.session_state($1) as s, iam.support_grant_state($2) as g', [support.sessionId, grant]);
    expect(rows[0]).toEqual({ s: 'EXPIRED', g: 'ENDED' });
    await expectRefused(withCommand(db.app, { ...support, correlationId: randomUUID() }, () => Promise.resolve(undefined)), 'EBMR-IAM-114');
    await loginRefused(engineer, 'SUPPORT_NO_LIVE_GRANT');
  });

  it('[DI-08] a revoked grant ends at once; a session opened from an older login event is refused', async () => {
    const engineer = await seedSupportEngineer(db);
    const grant = await openSupportGrant(db, engineer);
    const support = await supportLogin(db, engineer);
    const ev = await authenticate(seedAuthn(db), { method: 'PASSWORD', identifier: engineer.loginName, secret: engineer.password, deviceFingerprint: engineer.fingerprint, purpose: 'LOGIN' });
    const { qa } = await supportApprovers(db);
    await expectRefused(withCommand(db.app, { ...qa, correlationId: randomUUID() }, (c) => c.query('select iam.revoke_support_grant($1, $2)', [grant, ' '])), 'EBMR-IAM-189');
    await withCommand(db.app, { ...qa, correlationId: randomUUID() }, (c) => c.query('select iam.revoke_support_grant($1, $2)', [grant, 'work finished early']));
    const { rows } = await db.app.query<{ s: string; g: string }>('select iam.session_state($1) as s, iam.support_grant_state($2) as g', [support.sessionId, grant]);
    expect(rows[0]).toEqual({ s: 'EXPIRED', g: 'REVOKED' });
    await expectRefused(openSession(db.app, ev.authEventId, engineer.fingerprint), 'EBMR-IAM-180');
  });

  it('[DI-08] two distinct customer people approve; neither the requester nor the engineer; the window is bounded; one grant at a time', async () => {
    const { admin } = await seedAdministration(db);
    const { qa, it: itOwner } = await supportApprovers(db);
    const engineer = await seedSupportEngineer(db);
    const asAdmin = (sql: string, params: unknown[]) => withCommand(db.app, { ...admin, correlationId: randomUUID() }, (c) => c.query(sql, params));
    await expectRefused(asAdmin('select iam.request_support_grant($1, $2, $3, $4)', [engineer.accountId, 'Acme', 'x', 73]), 'EBMR-IAM-184');
    await expectRefused(asAdmin('select iam.request_support_grant($1, $2, $3, $4)', [engineer.accountId, 'Acme', ' ', 2]), 'EBMR-IAM-183');
    await expectRefused(asAdmin('select iam.request_support_grant($1, $2, $3, $4)', [qa.accountId, 'Acme', 'x', 2]), 'EBMR-IAM-181');
    // A QA person may not request one (administration permission).
    await expectRefused(withCommand(db.app, { ...qa, correlationId: randomUUID() }, (c) => c.query('select iam.request_support_grant($1, $2, $3, $4)', [engineer.accountId, 'Acme', 'x', 2])), 'EBMR-IAM-040');
    const grant = await requestSupportGrant(db, engineer);
    await expectRefused(requestSupportGrant(db, engineer), 'EBMR-IAM-185');
    // The IT approver cannot give the QA signature (no QA permission); each kind is signed once.
    await expectRefused(approveSupportGrant(db, itOwner, grant, 'SUPPORT_ACCESS_QA_APPROVED'), 'EBMR-ESIG-040');
    const both = await seedActor(db, { roleCode: 'QA_MBR_APPROVER', legalName: 'Both Hats' });
    expect(await approveSupportGrant(db, both, grant, 'SUPPORT_ACCESS_QA_APPROVED')).toBe('PENDING');
    await expectRefused(approveSupportGrant(db, qa, grant, 'SUPPORT_ACCESS_QA_APPROVED'), 'EBMR-IAM-187');
    expect(await approveSupportGrant(db, itOwner, grant, 'SUPPORT_ACCESS_IT_APPROVED')).toBe('ACTIVE');
    await expectRefused(approveSupportGrant(db, itOwner, grant, 'SUPPORT_ACCESS_IT_APPROVED'), 'EBMR-ESIG-039');
  });

  it('[DI-08] bypass attempts as the application role: no direct writes, no approval without its signature', async () => {
    const engineer = await seedSupportEngineer(db);
    const grant = await requestSupportGrant(db, engineer);
    const { qa } = await supportApprovers(db);
    await expectPermissionDenied(db.app.query(`insert into iam.support_grant_activation (grant_id, valid_from, valid_to) values ($1, now(), now() + interval '1 hour')`, [grant]));
    await expectPermissionDenied(db.app.query(`insert into iam.support_grant_approval (grant_id, kind, signature_id, person_id, account_id, correlation_id) values ($1, 'QA', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`, [grant]));
    await expectPermissionDenied(db.app.query(`update iam.support_grant set valid_hours = 72 where id = $1`, [grant]));
    await expectPermissionDenied(db.app.query(`insert into iam.support_session (session_id, grant_id) select id, $1 from iam.session limit 1`, [grant]));
    await expectRefused(withCommand(db.app, { ...qa, correlationId: randomUUID() }, (c) => c.query('select iam.approve_support_grant($1, $2)', [grant, randomUUID()])), 'EBMR-IAM-186');
    await loginRefused(engineer, 'SUPPORT_NO_LIVE_GRANT');
    // Even the owner cannot change a recorded request (protected rows).
    await expect(db.admin.query(`update iam.support_grant set valid_hours = 72 where id = $1`, [grant])).rejects.toThrow();
  });
  // Slice 6j mutation triage (iam.request_support_grant, iam.approve_support_grant, iam.revoke_support_grant): checks that
  // only these functions enforce, each proved by an input that reaches it.
  it('[DI-08] the time box is 1 to the configured maximum of hours, both ends included; IT\'s administrator may end a grant early', async () => {
    const { admin } = await seedAdministration(db);
    const engineer = await seedSupportEngineer(db);
    const asAdmin = (sql: string, params: unknown[]) => withCommand(db.app, { ...admin, correlationId: randomUUID() }, (c) => c.query(sql, params));
    await expectRefused(asAdmin('select iam.request_support_grant($1, $2, $3, $4)', [engineer.accountId, 'Acme', 'x', 0]), 'EBMR-IAM-184');
    await expectRefused(asAdmin('select iam.request_support_grant($1, $2, $3, $4)', [engineer.accountId, 'Acme', 'x', null]), 'EBMR-IAM-184');
    const { rows: max } = await db.admin.query<{ h: number }>("select platform.setting_numeric('iam.support_grant_max_hours')::integer as h");
    const grant = await requestSupportGrant(db, engineer, max[0]!.h);
    // The administrator holds neither approval permission; it ends the grant through SUPPORT.GRANT_REQUEST.
    await asAdmin('select iam.revoke_support_grant($1, $2)', [grant, 'request withdrawn']);
    const { rows } = await db.app.query<{ g: string }>('select iam.support_grant_state($1) as g', [grant]);
    expect(rows[0]).toEqual({ g: 'REVOKED' });
    const one = await requestSupportGrant(db, engineer, 1);
    const { it: itOwner } = await supportApprovers(db);
    await withCommand(db.app, { ...itOwner, correlationId: randomUUID() }, (c) => c.query('select iam.revoke_support_grant($1, $2)', [one, 'not needed']));
  });

  it('[DI-08][INV-11] an approval is recorded by its own signer; the requester, an administrator, can never hold a role that approves', async () => {
    const engineer = await seedSupportEngineer(db);
    const grant = await requestSupportGrant(db, engineer);
    const { qa } = await supportApprovers(db);
    const qa2 = await seedActor(db, { roleCode: 'QA_MBR_APPROVER', legalName: 'Second Quality Head' });
    await ensureSealKey(db);
    const signOnly = async (signer: SeededActor, grantId: string, meaning: string): Promise<string> => {
      const ch = await challengeFor(db, signer, grantId, { meaning, aggregateType: 'support_grant' });
      const ev = await signatureAuth(db, signer, signer, ch.challengeId);
      return withCommand(db.app, await cmd(db, signer), async (c) =>
        (await sign(c, { challengeId: ch.challengeId, authEventId: ev, expectedState: 'PENDING' }, testSealKey)).signatureId);
    };
    // qa signs; qa2 (holding the same permission) cannot record qa's signature as an approval.
    const qaSig = await signOnly(qa, grant, 'SUPPORT_ACCESS_QA_APPROVED');
    await expectRefused(withCommand(db.app, { ...qa2, correlationId: randomUUID() }, (c) => c.query('select iam.approve_support_grant($1, $2)', [grant, qaSig])), 'EBMR-IAM-186');
    expect(await count('select 1 from iam.support_grant_approval where grant_id = $1', [grant])).toBe(0);

    // The requester (IT's administrator, SYSTEM_ADMINISTRATOR) can never also hold an approver role: every role holding
    // SUPPORT.APPROVE_QA or SUPPORT.APPROVE_IT is a GMP role, which the static segregation refuses to an administrator's
    // person (INV-11, kernel 0120). That rule, not EBMR-IAM-188, keeps the requester out of the approvals; the support
    // engineer (VENDOR_SUPPORT, an administration role) likewise, and a support account never signs (SUPPORT_CANNOT_SIGN).
    const { admin, owner } = await seedAdministration(db);
    const requester = await seedActor(db, { roleCode: 'SYSTEM_ADMINISTRATOR', legalName: 'IT Administrator' });
    const { rows: approverRoles } = await db.admin.query<{ role_code: string }>(
      "select distinct role_code from iam.role_permission where permission_code in ('SUPPORT.APPROVE_QA', 'SUPPORT.APPROVE_IT') and removed_at is null order by 1");
    expect(approverRoles.map((r) => r.role_code)).toEqual(['AUTHORISED_PERSON', 'PROCESS_OWNER', 'QA_MBR_APPROVER']);
    for (const { role_code: roleCode } of approverRoles) {
      await expectRefused(withCommand(db.app, withReason(admin), (c) =>
        requestRoleGrant(c, { accountId: requester.accountId, roleCode, reason: 'also an approver' })).then(async (id) =>
        withCommand(db.app, withReason(owner), (c) => decideRoleGrant(c, id, true, 'approved for test'))), 'EBMR-IAM-033');
    }
  });
});
