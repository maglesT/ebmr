/**
 * DI-22 catalog line: a failed login, a role change and a configuration change each appear in the
 * system log. Failed logins are in the protected authentication log (iam.authn_attempt, insert-only,
 * written before anyone is authenticated); role changes and configuration changes are audited rows
 * in the hash-chained audit trail.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '../../src/db/command.ts';
import { decideRoleGrant, requestRoleGrant, setPolicy } from '../../src/identity/admin.ts';
import { authenticate } from '../../src/identity/authentication.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { seedActor, seedAdministration, seedAuthn, withReason } from '../identity/seed.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});

describe('system log (DI-22)', () => {
  it('[DI-22] a failed login, a role change and a configuration change each appear in the system log', async () => {
    const { admin, owner } = await seedAdministration(db);
    const op = await seedActor(db, { acknowledgeEsig: false });

    // 1. Failed login.
    await expect(
      authenticate(seedAuthn(db), { method: 'PASSWORD', identifier: op.seed.loginName, secret: 'wrong password', deviceFingerprint: op.seed.deviceFingerprint, purpose: 'LOGIN' }),
    ).rejects.toThrow();
    const { rows: attempts } = await db.admin.query<{ outcome: string; reason: string; attempted_at: Date }>(
      "select outcome, reason, attempted_at from iam.authn_attempt where account_id = $1 and outcome <> 'SUCCESS' order by id desc limit 1",
      [op.accountId],
    );
    expect(attempts[0]?.outcome).toBe('FAILURE');
    expect(attempts[0]?.reason).not.toBe('');

    // 2. Role change: a new grant requested by one person and approved by another.
    const grantId = await withCommand(db.app, withReason(admin), (c) =>
      requestRoleGrant(c, { accountId: op.accountId, roleCode: 'VERIFIER', scope: {}, reason: 'cover for the night shift' }),
    );
    await withCommand(db.app, withReason(owner), (c) => decideRoleGrant(c, grantId, true, 'approved'));
    const { rows: grantEvents } = await db.admin.query<{ n: string }>(
      "select count(*)::text as n from kernel.audit_event where table_name like 'iam.%grant%' and (payload ->> 'record_id' = $1 or payload -> 'body' -> 'new' ->> 'grant_id' = $1 or payload -> 'body' -> 'new' ->> 'id' = $1)",
      [grantId],
    );
    expect(Number(grantEvents[0]?.n)).toBeGreaterThanOrEqual(2);

    // 3. Configuration change: a policy value.
    await withCommand(db.app, withReason(admin, 'POLICY_CHANGE', 'tighter lockout'), (c) => setPolicy(c, 'authn.lockout_threshold', '4', 'tighter lockout'));
    const { rows: policyEvents } = await db.admin.query<{ reason: string; person: string }>(
      "select payload ->> 'reason_code' as reason, payload -> 'actor' ->> 'person_id' as person from kernel.audit_event where chain_key = 'iam_policy:authn.lockout_threshold' and table_name = 'iam.policy_value' order by id desc limit 1",
    );
    expect(policyEvents[0]?.person).toBe(admin.personId);
    expect(policyEvents[0]?.reason).toBe('POLICY_CHANGE');
  });
});
