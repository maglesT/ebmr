/**
 * Access life cycle, authority at the moment of action and segregation of duties
 * (DI-16, DI-17, DI-18, INV-11).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toDbContext, withCommand, type ActorContext } from '../../src/db/command.ts';
import {
  activateAccount,
  createAccount,
  decideRoleGrant,
  decideRolePermission,
  issueInitialSecret,
  processLeaver,
  removeRolePermission,
  requestRoleGrant,
  requestRolePermission,
  revokeRoleGrant,
  setPolicy,
} from '../../src/identity/admin.ts';
import { authenticate, changeSecret } from '../../src/identity/authentication.ts';
import { authorize, evaluateAuthority, requirePermission, withGuardedCommand } from '../../src/identity/authority.ts';
import { AuthenticationFailedError } from '../../src/identity/errors.ts';
import { openSession } from '../../src/identity/sessions.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { asDefinerCommand, asSuperuserTransaction, asTimeTraveller, dbNow, expectPermissionDenied, expectRefused, pause } from './helpers.ts';
import {
  freshAuthEvent,
  seedActor,
  seedAdministration,
  seedAuthn,
  seedServiceActor,
  withFreshAuth,
  withReason,
  type SeedAdministration,
  type SeededActor,
} from './seed.ts';

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

async function grantRole(account: string, role: string, scope = {}): Promise<string> {
  const id = await asAdmin((c) => requestRoleGrant(c, { accountId: account, roleCode: role, scope, reason: `needs ${role}` }));
  await asOwner((c) => decideRoleGrant(c, id, true, 'approved'));
  return id;
}

const sampleInsert = (ctx: ActorContext, batch = randomUUID()) =>
  withCommand(db.app, ctx, async (c) => {
    const { rows } = await c.query<{ id: string }>('insert into testgmp.sample (batch_id, value) values ($1, 1) returning id', [batch]);
    return rows[0]?.id ?? '';
  });

describe('access life cycle (DI-16)', () => {
  it('[DI-16] the role list as of a past date reconciles with the access-request records', async () => {
    const a = await seedActor(db, { roleCode: 'QC_ANALYST', acknowledgeEsig: false });
    const t1 = await dbNow(db);
    const b = await seedActor(db, { roleCode: 'QC_ANALYST', acknowledgeEsig: false });
    const t2 = await dbNow(db);
    await asAdmin((c) => revokeRoleGrant(c, a.seed.grantId, 'moved to another department'));
    const t3 = await dbNow(db);

    const list = async (t: string) =>
      (await db.app.query<{ account_id: string; grant_id: string; role_code: string; effective: boolean }>('select * from iam.access_list($1)', [t])).rows;
    const holders = async (t: string) => (await list(t)).filter((r) => r.role_code === 'QC_ANALYST').map((r) => r.account_id);
    expect(await holders(t1)).toContain(a.accountId);
    expect(await holders(t1)).not.toContain(b.accountId);
    expect(await holders(t2)).toEqual(expect.arrayContaining([a.accountId, b.accountId]));
    expect(await holders(t3)).toContain(b.accountId);
    expect(await holders(t3)).not.toContain(a.accountId);

    // Every row at t2 is backed by an access-request record with a requester, a different approver,
    // a reason and an approval before t2, and by the request and approval events in the audit trail.
    for (const row of await list(t2)) {
      const g = (await db.app.query('select * from iam.role_grant where id = $1', [row.grant_id])).rows[0] as Record<string, unknown>;
      expect(g['requested_by_person']).not.toBe(g['decided_by_person']);
      expect(g['person_id']).not.toBe(g['decided_by_person']);
      expect(String(g['reason'])).not.toBe('');
      expect((g['decided_at'] as Date).getTime()).toBeLessThanOrEqual(new Date(t2).getTime());
      const audit = await db.app.query<{ action: string; person: string }>(
        "select action, payload -> 'actor' ->> 'person_id' as person from kernel.audit_event where table_name = 'iam.role_grant' and record_id = $1 order by seq",
        [row.grant_id],
      );
      const bootstrap = await db.app.query("select 1 from kernel.audit_event where record_id = $1 and payload -> 'actor' ->> 'role_code' = 'INSTALLATION_BOOTSTRAP'", [row.grant_id]);
      expect(audit.rows[0]).toEqual({ action: 'INSERT', person: g['requested_by_person'] });
      // Bootstrap approvals are recorded by the installation-qualification identity on the IQ protocol's authority.
      expect(audit.rows[1]).toEqual({ action: 'UPDATE', person: bootstrap.rowCount ? g['requested_by_person'] : g['decided_by_person'] });
    }
    // And the list is complete: nothing held at t2 is missing from it.
    const direct = await db.app.query<{ n: number }>(
      'select count(*)::int as n from iam.role_grant g where iam.grant_held_at(g.status, g.decided_at, g.valid_from, g.valid_to, g.revoked_at, $1)',
      [t2],
    );
    expect((await list(t2)).length).toBe(direct.rows[0]?.n);
  });

  it('[DI-16] a disabled leaver can neither log in nor sign, and loses sessions, grants and badges at once', async () => {
    const op = await seedActor(db, { roleCode: 'VERIFIER', deviceClass: 'SHARED' });
    await asDefinerCommand(db, op, (c) => c.query('select iam.assert_can_sign($1)', [op.accountId]));
    await asAdmin((c) => processLeaver(c, op.personId, 'resigned'));
    const authn = seedAuthn(db);
    const base = { method: 'PASSWORD' as const, identifier: op.seed.loginName, secret: op.seed.password, deviceFingerprint: op.seed.deviceFingerprint };
    await expect(authenticate(authn, { ...base, purpose: 'LOGIN' })).rejects.toMatchObject({ reason: 'ACCOUNT_PERSON_LEFT' });
    await expect(authenticate(authn, { ...base, purpose: 'SIGNATURE', challengeId: randomUUID() })).rejects.toThrow(AuthenticationFailedError);
    await expectRefused(asDefinerCommand(db, adm.admin, (c) => c.query('select iam.assert_can_sign($1)', [op.accountId])), 'EBMR-IAM-054');
    await expectRefused(sampleInsert(op), 'EBMR-IAM-103');
    const state = await db.app.query(
      `select (select end_reason from iam.session where id = $1) as session_end,
              (select bool_and(revoked_at is not null) from iam.role_grant where account_id = $2 and status <> 'REJECTED') as grants_revoked,
              (select status from iam.badge where account_id = $2) as badge,
              (select count(*)::int from iam.security_alert where account_id = $2 and kind = 'DISABLED_ACCOUNT_USE') as alerts`,
      [op.sessionId, op.accountId],
    );
    expect(state.rows[0]).toEqual({ session_end: 'PERSON_LEFT', grants_revoked: true, badge: 'REVOKED', alerts: 2 });
  });

  it('[DI-16][DI-18] the requester never approves, nobody approves their own grant, nobody requests a role for themselves', async () => {
    const op = await seedActor(db, { acknowledgeEsig: false });
    const g = await asAdmin((c) => requestRoleGrant(c, { accountId: op.accountId, roleCode: 'VERIFIER', reason: 'second person checks' }));
    await expectRefused(asAdmin((c) => decideRoleGrant(c, g, true, 'self-approved')), 'EBMR-IAM-032');
    await expectRefused(asAdmin((c) => requestRoleGrant(c, { accountId: adm.admin.accountId, roleCode: 'AUDITOR_READONLY', reason: 'x' })), 'EBMR-IAM-003');
    const forOwner = await asAdmin((c) => requestRoleGrant(c, { accountId: adm.owner.accountId, roleCode: 'AUDITOR_READONLY', reason: 'x' }));
    await expectRefused(asOwner((c) => decideRoleGrant(c, forOwner, true, 'mine')), 'EBMR-IAM-032');
    await asOwner((c) => decideRoleGrant(c, g, true, 'approved'));
  });

  it('[DI-16] revocation is effective immediately: the next command and authority check fail', async () => {
    const op = await seedActor(db, { acknowledgeEsig: false });
    await sampleInsert(op);
    await asAdmin((c) => revokeRoleGrant(c, op.seed.grantId, 'access no longer needed'));
    await expectRefused(sampleInsert(op), 'EBMR-IAM-108');
    const d = await evaluateAuthority(db.app, { personId: op.personId, accountId: op.accountId, permission: 'STEP.EXECUTE' });
    expect(d).toMatchObject({ allowed: false, reasons: ['NO_GRANT_FOR_PERMISSION_IN_SCOPE'] });
    await expectRefused(asAdmin((c) => revokeRoleGrant(c, op.seed.grantId, 'again')), 'EBMR-IAM-037');
  });

  it('[DI-16] recertification records reviewer, outcome, last activity and the due date; a REVOKED outcome removes access at once', async () => {
    const op = await seedActor(db, { acknowledgeEsig: false });
    await sampleInsert(op);
    const id = await asOwner(async (c) => (await c.query<{ id: string }>("select iam.recertify_account($1, 'CONFIRMED', 'still on the line') as id", [op.accountId])).rows[0]?.id);
    const r = (await db.app.query('select * from iam.access_recertification where id = $1', [id])).rows[0] as Record<string, unknown>;
    expect(r).toMatchObject({ reviewer_person: adm.owner.personId, outcome: 'CONFIRMED', grants_reviewed: [op.seed.grantId] });
    expect(r['last_activity_at']).toBeInstanceOf(Date);
    const recorded = r['recorded_at'] as Date;
    const due = r['next_due_at'] as Date;
    expect(due.getUTCMonth()).toBe((recorded.getUTCMonth() + 6) % 12);
    const dueNow = await db.app.query('select overdue from iam.recertification_due() where account_id = $1', [op.accountId]);
    expect(dueNow.rows[0]).toEqual({ overdue: false });
    const dueLater = await db.app.query("select overdue from iam.recertification_due(clock_timestamp() + interval '7 months') where account_id = $1", [op.accountId]);
    expect(dueLater.rows[0]).toEqual({ overdue: true });
    await asOwner((c) => c.query("select iam.recertify_account($1, 'REVOKED', 'left the line')", [op.accountId]));
    await expectRefused(sampleInsert(op), 'EBMR-IAM-108');
    await expectRefused(asOwner((c) => c.query("select iam.recertify_account($1, 'CONFIRMED', 'me')", [adm.owner.accountId])), 'EBMR-IAM-003');
  });

  it('[DI-16] the recertification interval is a policy value allowed between 3 and 12 months', async () => {
    const set = (v: string) => withCommand(db.app, withReason(adm.admin, 'POLICY_CHANGE'), (c) => setPolicy(c, 'recertification.interval_months', v, 'test'));
    await expectRefused(set('2'), 'EBMR-IAM-110');
    await expectRefused(set('13'), 'EBMR-IAM-110');
    await set('3');
    expect((await db.app.query("select iam.policy_int('recertification.interval_months') as v")).rows[0]).toEqual({ v: '3' });
    await set('6');
  });
});

describe('authority at the moment of action (DI-17)', () => {
  it('[DI-17] permission matrix: every kernel role allows exactly its permissions and nothing else', async () => {
    const roles = (await db.app.query<{ code: string }>('select code from iam.role where is_kernel order by code')).rows.map((r) => r.code);
    expect(roles).toHaveLength(31);
    for (const role of roles) {
      const actor = role === 'SERVICE_ACCOUNT' ? await seedServiceActor(db) : await seedActor(db, { roleCode: role, acknowledgeEsig: false });
      const { rows } = await db.app.query<{ code: string; allowed: boolean; expected: boolean }>(
        `select p.code, (iam.evaluate_authority($1, $2, p.code, '{}'::jsonb, null, null) ->> 'allowed')::boolean as allowed,
                exists (select 1 from iam.role_permission rp where rp.role_code = $3 and rp.permission_code = p.code and rp.removed_at is null) as expected
         from iam.permission p order by p.code`,
        [actor.personId, actor.accountId, role],
      );
      const wrong = rows.filter((r) => r.allowed !== r.expected).map((r) => `${role}/${r.code}: allowed=${r.allowed}`);
      expect(wrong).toEqual([]);
      expect(rows.some((r) => r.allowed)).toBe(true);
      expect(rows.some((r) => !r.allowed)).toBe(true);
    }
  });

  it('[DI-17] a role without the quality-unit release function cannot sign "Approved for release"', async () => {
    const ap = await seedActor(db, { roleCode: 'AUTHORISED_PERSON', acknowledgeEsig: false });
    expect((await evaluateAuthority(db.app, { personId: ap.personId, accountId: ap.accountId, permission: 'RELEASE.MANUFACTURER' })).allowed).toBe(true);
    for (const role of ['QA_REVIEWER', 'HEAD_OF_PRODUCTION', 'HEAD_OF_QC', 'SYSTEM_ADMINISTRATOR', 'OPERATOR']) {
      const a = await seedActor(db, { roleCode: role, acknowledgeEsig: false });
      const d = await evaluateAuthority(db.app, { personId: a.personId, accountId: a.accountId, permission: 'RELEASE.MANUFACTURER' });
      expect(d, role).toMatchObject({ allowed: false, reasons: ['NO_GRANT_FOR_PERMISSION_IN_SCOPE'] });
    }
  });

  it('[DI-17] data is isolated between sites: a grant covers only its own site, area and product', async () => {
    const op = await seedActor(db, { scope: { site: 'SITE-1' }, acknowledgeEsig: false });
    const can = async (scope: object) => (await evaluateAuthority(db.app, { personId: op.personId, accountId: op.accountId, permission: 'STEP.EXECUTE', scope })).allowed;
    expect(await can({ site: 'SITE-1' })).toBe(true);
    expect(await can({ site: 'SITE-1', area: 'ROOM-7', product: 'ATV-10' })).toBe(true);
    expect(await can({ site: 'SITE-2' })).toBe(false);
    expect(await can({})).toBe(false);
    const roomOnly = await seedActor(db, { scope: { site: 'SITE-1', area: 'ROOM-7' }, acknowledgeEsig: false });
    const canRoom = async (scope: object) => (await evaluateAuthority(db.app, { personId: roomOnly.personId, accountId: roomOnly.accountId, permission: 'STEP.EXECUTE', scope })).allowed;
    expect(await canRoom({ site: 'SITE-1', area: 'ROOM-7' })).toBe(true);
    expect(await canRoom({ site: 'SITE-1', area: 'ROOM-8' })).toBe(false);
    expect(await canRoom({ site: 'SITE-1' })).toBe(false);
  });

  it('[DI-17] a failed authority check blocks the action and is logged', async () => {
    const op = await seedActor(db, { acknowledgeEsig: false });
    await expectRefused(withGuardedCommand(db.app, op, (c) => requirePermission(c, 'RELEASE.MANUFACTURER')), 'EBMR-IAM-040');
    const { rows } = await db.app.query(
      "select allowed, reasons, role_filter from iam.authority_evaluation where person_id = $1 and permission_code = 'RELEASE.MANUFACTURER'",
      [op.personId],
    );
    expect(rows).toEqual([{ allowed: false, reasons: ['ROLE_NOT_HELD_WITH_PERMISSION_IN_SCOPE'], role_filter: 'OPERATOR' }]);
  });

  it('[DI-17] the performer of an entry cannot verify it (segregation on the person)', async () => {
    const op = await seedActor(db, { acknowledgeEsig: false });
    await grantRole(op.accountId, 'VERIFIER');
    const verifier = await seedActor(db, { roleCode: 'VERIFIER', acknowledgeEsig: false });
    const id = await sampleInsert(op);
    const verify = (ctx: ActorContext) =>
      withGuardedCommand(db.app, ctx, async (c) => {
        await requirePermission(c, 'STEP.VERIFY');
        await c.query("select iam.assert_segregated('S5_PERFORMER_NOT_VERIFIER', iam.record_entry_persons('testgmp.sample', $1), $2)", [id, `testgmp.sample ${id}`]);
      });
    await expectRefused(verify({ ...op, roleCode: 'VERIFIER' }), 'EBMR-IAM-041', /S5_PERFORMER_NOT_VERIFIER/);
    await verify(verifier);
    const logged = await db.app.query('select allowed from iam.segregation_evaluation where person_id = $1', [op.personId]);
    expect(logged.rows).toEqual([{ allowed: false }]);
  });

  it('[DI-17] a person who executed a step of a batch cannot sign that batch\'s disposition', async () => {
    const op = await seedActor(db, { acknowledgeEsig: false });
    await grantRole(op.accountId, 'AUTHORISED_PERSON');
    const ap = await seedActor(db, { roleCode: 'AUTHORISED_PERSON', acknowledgeEsig: false });
    const batch = randomUUID();
    await sampleInsert(op, batch);
    const dispose = (ctx: ActorContext) =>
      withGuardedCommand(db.app, ctx, async (c) => {
        await requirePermission(c, 'RELEASE.MANUFACTURER');
        await c.query("select iam.assert_segregated('S10_INVOLVED_NOT_DISPOSER', iam.chain_persons($1), $1)", [`batch:${batch}`]);
      });
    await expectRefused(dispose({ ...op, roleCode: 'AUTHORISED_PERSON' }), 'EBMR-IAM-041');
    await dispose(ap);
  });
});

describe('administrator separation (DI-18, INV-11)', () => {
  it('[DI-18][INV-11] assigning an administrator role to a person who holds a QA role is refused, and the reverse', async () => {
    const qa = await seedActor(db, { roleCode: 'QA_REVIEWER', acknowledgeEsig: false });
    await expectRefused(asAdmin((c) => requestRoleGrant(c, { accountId: qa.accountId, roleCode: 'SYSTEM_ADMINISTRATOR', reason: 'help desk' })), 'EBMR-IAM-033');
    const admin2 = await seedActor(db, { roleCode: 'SYSTEM_ADMINISTRATOR', acknowledgeEsig: false });
    await expectRefused(asAdmin((c) => requestRoleGrant(c, { accountId: admin2.accountId, roleCode: 'QA_REVIEWER', reason: 'cover' })), 'EBMR-IAM-033');
  });

  it('[DI-18][INV-11] the rule spans every account of the person: a GMP user\'s break-glass account cannot be an administrator', async () => {
    const qa = await seedActor(db, { roleCode: 'QA_REVIEWER', acknowledgeEsig: false });
    const bg = await asAdmin(async (c) => {
      const id = await createAccount(c, { personId: qa.personId, loginName: `bg-${randomBytes(4).toString('hex')}`, kind: 'HUMAN', breakGlass: true });
      await activateAccount(c, id);
      return id;
    });
    await expectRefused(asAdmin((c) => requestRoleGrant(c, { accountId: bg, roleCode: 'BREAK_GLASS_ADMIN', reason: 'emergency' })), 'EBMR-IAM-033');
  });

  it('[DI-18] an administrator\'s attempt to change a GMP value is refused and logged', async () => {
    await expectRefused(withGuardedCommand(db.app, adm.admin, (c) => requirePermission(c, 'STEP.EXECUTE', { site: 'SITE-1' })), 'EBMR-IAM-040');
    await expect(authorize(db.app, adm.admin, 'MASTERDATA.CHANGE')).rejects.toThrow('EBMR-IAM-040');
    const { rows } = await db.app.query<{ permission_code: string; allowed: boolean }>(
      "select permission_code, allowed from iam.authority_evaluation where person_id = $1 and permission_code in ('STEP.EXECUTE', 'MASTERDATA.CHANGE') order by 1",
      [adm.admin.personId],
    );
    expect(rows).toEqual([
      { permission_code: 'MASTERDATA.CHANGE', allowed: false },
      { permission_code: 'STEP.EXECUTE', allowed: false },
    ]);
    const gmp = await db.app.query("select count(*)::int as n from iam.role_permission rp join iam.permission p on p.code = rp.permission_code where rp.role_code = 'SYSTEM_ADMINISTRATOR' and p.domain = 'GMP'");
    expect(gmp.rows[0]).toEqual({ n: 0 });
  });

  it('[DI-18] GMP data write paths refuse every administrator role, whatever the permission check says', async () => {
    const guarded = (ctx: ActorContext) =>
      withCommand(db.app, ctx, async (c) => {
        await c.query('select iam.assert_not_administrator()');
        await c.query('insert into testgmp.sample (batch_id, value) values ($1, 1)', [randomUUID()]);
      });
    await expectRefused(guarded(adm.admin), 'EBMR-IAM-042', /DI-18/);
    const vendor = await seedActor(db, { roleCode: 'VENDOR_SUPPORT', acknowledgeEsig: false });
    await expectRefused(guarded(vendor), 'EBMR-IAM-042');
    await guarded(await seedActor(db, { acknowledgeEsig: false }));
  });

  it('[DI-18] a break-glass login needs a second person\'s approval, raises an alarm, cannot sign and is reviewed afterwards', async () => {
    const admin2 = await seedActor(db, { roleCode: 'SYSTEM_ADMINISTRATOR', acknowledgeEsig: false });
    const bgLogin = `bg-${randomBytes(4).toString('hex')}`;
    const { bg, secret, grant } = await asAdmin(async (c) => {
      const id = await createAccount(c, { personId: admin2.personId, loginName: bgLogin, kind: 'HUMAN', breakGlass: true });
      await activateAccount(c, id);
      const s = await issueInitialSecret(c, id, 'PASSWORD');
      const g = await requestRoleGrant(c, { accountId: id, roleCode: 'BREAK_GLASS_ADMIN', reason: 'sealed emergency access' });
      return { bg: id, secret: s.secret, grant: g };
    });
    // Break-glass never holds a GMP role, nor one that signs or acknowledges (SYSTEM_ADMINISTRATOR approves grants).
    await expectRefused(asAdmin((c) => requestRoleGrant(c, { accountId: bg, roleCode: 'OPERATOR', reason: 'x' })), 'EBMR-IAM-036');
    await expectRefused(asAdmin((c) => requestRoleGrant(c, { accountId: bg, roleCode: 'SYSTEM_ADMINISTRATOR', reason: 'x' })), 'EBMR-IAM-036');
    await asOwner((c) => decideRoleGrant(c, grant, true, 'approved'));
    const authn = seedAuthn(db);
    const req = { method: 'PASSWORD' as const, identifier: bgLogin, deviceFingerprint: admin2.seed.deviceFingerprint };
    await expect(authenticate(authn, { ...req, secret, purpose: 'LOGIN' })).rejects.toMatchObject({ reason: 'BREAK_GLASS_NOT_AUTHORISED' });

    const windowId = await withCommand(db.app, admin2, async (c) =>
      (await c.query<{ id: string }>("select iam.request_break_glass($1, 'database restore after outage', 30) as id", [bg])).rows[0]?.id ?? '');
    await expectRefused(withCommand(db.app, admin2, (c) => c.query('select iam.approve_break_glass($1)', [windowId])), 'EBMR-IAM-040');
    await asOwner((c) => c.query('select iam.approve_break_glass($1)', [windowId]));

    const change = await authenticate(authn, { ...req, secret, purpose: 'LOGIN' });
    const password = `Glass-${randomBytes(9).toString('base64url')}`;
    await changeSecret(authn, { authEventId: change.authEventId, kind: 'PASSWORD', newSecret: password });
    const ev = await authenticate(authn, { ...req, secret: password, purpose: 'LOGIN' });
    const alarms = await db.app.query("select severity from iam.security_alert where account_id = $1 and kind = 'BREAK_GLASS_USED'", [bg]);
    expect(alarms.rows).toEqual([{ severity: 'CRITICAL' }, { severity: 'CRITICAL' }]);
    await expect(authenticate(authn, { ...req, secret: password, purpose: 'SIGNATURE', challengeId: randomUUID() })).rejects.toMatchObject({ reason: 'BREAK_GLASS_CANNOT_SIGN' });
    const can = await db.app.query<{ r: { reasons: string[] } }>('select iam.can_sign($1) as r', [bg]);
    expect(can.rows[0]?.r.reasons).toContain('BREAK_GLASS_CANNOT_SIGN');

    const s = await openSession(db.app, ev.authEventId, admin2.seed.deviceFingerprint);
    const bgCtx: ActorContext = { ...admin2, accountId: bg, sessionId: s.sessionId, roleCode: 'BREAK_GLASS_ADMIN' };
    await expectRefused(withCommand(db.app, bgCtx, (c) => requirePermission(c, 'STEP.EXECUTE')), 'EBMR-IAM-040');
    await expectRefused(asOwner((c) => c.query("select iam.review_break_glass($1, 'NO_FINDINGS', 'too early')", [windowId])), 'EBMR-IAM-130');
    await asTimeTraveller(db, "update iam.break_glass_window set valid_to = clock_timestamp() - interval '1 second' where id = $1", [windowId]);
    await expectRefused(withCommand(db.app, bgCtx, (c) => c.query('select 1')), 'EBMR-IAM-130');
    await asOwner((c) => c.query("select iam.review_break_glass($1, 'NO_FINDINGS', 'restore only; audit trail reviewed')", [windowId]));
  });
});

describe('INV-11 bypass attempts', () => {
  it('[INV-11] bypass: the application role cannot write grants, roles or permissions directly', async () => {
    const op = await seedActor(db, { acknowledgeEsig: false });
    await expectPermissionDenied(
      db.app.query(
        "insert into iam.role_grant (account_id, person_id, role_code, valid_from, reason, status, requested_by_person, requested_by_account) values ($1, $2, 'SYSTEM_ADMINISTRATOR', now(), 'x', 'REQUESTED', gen_random_uuid(), gen_random_uuid())",
        [op.accountId, op.personId],
      ),
    );
    await expectPermissionDenied(db.app.query("update iam.role_grant set role_code = 'SYSTEM_ADMINISTRATOR' where id = $1", [op.seed.grantId]));
    await expectPermissionDenied(db.app.query("insert into iam.role_permission (role_code, permission_code) values ('SYSTEM_ADMINISTRATOR', 'STEP.EXECUTE')"));
    await expectPermissionDenied(db.app.query("update iam.permission set domain = 'READ_ONLY', effect = 'READ' where code = 'STEP.EXECUTE'"));
    await expectPermissionDenied(db.app.query('delete from iam.role_grant'));
  });

  it('[INV-11] bypass: even the table owner cannot insert a grant that makes a GMP user an administrator, or rewrite an approved grant', async () => {
    const qa = await seedActor(db, { roleCode: 'QA_REVIEWER', acknowledgeEsig: false });
    const ctx = JSON.stringify({ person_id: randomUUID(), account_id: randomUUID(), correlation_id: randomUUID(), reason_code: 'ATTACK' });
    await expect(
      asSuperuserTransaction(db, async (c) => {
        await c.query("select set_config('ebmr.ctx', $1, true)", [ctx]);
        await c.query(
          "insert into iam.role_grant (account_id, person_id, role_code, valid_from, reason, status, requested_by_person, requested_by_account) values ($1, $2, 'SYSTEM_ADMINISTRATOR', now(), 'x', 'REQUESTED', gen_random_uuid(), gen_random_uuid())",
          [qa.accountId, qa.personId],
        );
      }),
    ).rejects.toThrow('EBMR-IAM-033');
    await expect(
      asSuperuserTransaction(db, async (c) => {
        await c.query("select set_config('ebmr.ctx', $1, true)", [ctx]);
        await c.query("update iam.role_grant set role_code = 'SYSTEM_ADMINISTRATOR' where id = $1", [qa.seed.grantId]);
      }),
    ).rejects.toThrow('EBMR-IAM-038');
    await expect(
      asSuperuserTransaction(db, (c) => c.query("update iam.permission set domain = 'READ_ONLY', effect = 'READ' where code = 'RECORD.QA_REVIEW'")),
    ).rejects.toThrow('EBMR-IAM-007');
  });

  it('[INV-11] bypass: the catalogue cannot be used to merge administration and GMP permissions', async () => {
    const asAdminRoles = <T>(work: Work<T>) => withCommand(db.app, withReason(adm.admin, 'ROLE_CHANGE'), work);
    await expectRefused(asAdminRoles((c) => c.query("select iam.add_role_permission('SYSTEM_ADMINISTRATOR', 'STEP.EXECUTE')")), 'EBMR-IAM-033');
    const code = `SITE_VIEWER_${randomBytes(2).toString('hex').toUpperCase()}`;
    const read = await asAdminRoles(async (c) => {
      await c.query("select iam.create_role($1, 'Site viewer', 'ADMINISTRATION_SECURITY', 'custom read-only role', array['HUMAN'])", [code]);
      return requestRolePermission(c, { roleCode: code, permission: 'RECORD.READ' });
    });
    await asOwner((c) => decideRolePermission(c, read, true, 'read-only role for site visitors'));
    const qa = await seedActor(db, { roleCode: 'QA_REVIEWER', acknowledgeEsig: false });
    await grantRole(qa.accountId, code);
    await expectRefused(asAdminRoles((c) => c.query("select iam.add_role_permission($1, 'IAM.ACCOUNT_MANAGE')", [code])), 'EBMR-IAM-033');
  });

  it('[DI-16][DI-18][DI-17] a permission reaches a role only when a second person approves the request; nobody requests or approves one for a role they hold', async () => {
    const asAdminRoles = <T>(work: Work<T>) => withCommand(db.app, withReason(adm.admin, 'ROLE_CHANGE', 'extend the verifier bundle'), work);
    const op = await seedActor(db, { roleCode: 'VERIFIER', acknowledgeEsig: false });
    // A process owner (who approves access requests) who is also a verifier.
    const verifierApprover = await seedActor(db, { roleCode: 'PROCESS_OWNER', acknowledgeEsig: false });
    await grantRole(verifierApprover.accountId, 'VERIFIER');
    const canSupervise = async () => (await evaluateAuthority(db.app, { personId: op.personId, accountId: op.accountId, permission: 'STEP.SUPERVISE' })).allowed;
    const live = async () =>
      (await db.app.query("select 1 from iam.role_permission where role_code = 'VERIFIER' and permission_code = 'STEP.SUPERVISE' and removed_at is null")).rowCount;

    // A lone administrator's request changes nothing yet: the reason is the command's reason text.
    const req = await asAdminRoles((c) => requestRolePermission(c, { roleCode: 'VERIFIER', permission: 'STEP.SUPERVISE' }));
    expect(await live()).toBe(0);
    expect(await canSupervise()).toBe(false);
    const { rows } = await db.app.query('select status, reason, requested_by_person, role_permission_id from iam.role_permission_request where id = $1', [req]);
    expect(rows[0]).toEqual({ status: 'REQUESTED', reason: 'extend the verifier bundle', requested_by_person: adm.admin.personId, role_permission_id: null });
    await expectRefused(asAdminRoles((c) => requestRolePermission(c, { roleCode: 'VERIFIER', permission: 'STEP.SUPERVISE' })), 'EBMR-IAM-039', /already requested/);

    // The requester never approves; a holder of the role never approves (it would extend their own
    // authority); approving needs IAM.GRANT_APPROVE; the application cannot write the rows.
    await expectRefused(asAdmin((c) => decideRolePermission(c, req, true, 'self-approved')), 'EBMR-IAM-032');
    await expectRefused(withCommand(db.app, withReason(verifierApprover), (c) => decideRolePermission(c, req, true, 'for my own role')), 'EBMR-IAM-032');
    await expectRefused(withCommand(db.app, withReason(op), (c) => decideRolePermission(c, req, true, 'mine')), 'EBMR-IAM-040');
    await expectPermissionDenied(db.app.query("update iam.role_permission_request set status = 'APPROVED' where id = $1", [req]));
    await expectPermissionDenied(db.app.query("insert into iam.role_permission (role_code, permission_code) values ('VERIFIER', 'STEP.SUPERVISE')"));
    expect(await canSupervise()).toBe(false);

    // A second person who does not hold the role approves: the permission is live for every holder from then on.
    await asOwner((c) => decideRolePermission(c, req, true, 'verifiers supervise hand-over on line 2'));
    expect(await live()).toBe(1);
    expect(await canSupervise()).toBe(true);
    const decided = (await db.app.query<{ status: string; decided_by_person: string; role_permission_id: string | null }>(
      'select status, decided_by_person, role_permission_id from iam.role_permission_request where id = $1', [req])).rows[0];
    expect(decided).toMatchObject({ status: 'APPROVED', decided_by_person: adm.owner.personId });
    const catalogue = await db.app.query('select role_code, permission_code from iam.role_permission where id = $1', [decided?.role_permission_id]);
    expect(catalogue.rows).toEqual([{ role_code: 'VERIFIER', permission_code: 'STEP.SUPERVISE' }]);
    await expectRefused(withCommand(db.app, withReason(adm.owner), (c) => decideRolePermission(c, req, false, 'too late')), 'EBMR-IAM-039', /already approved/);

    // A rejected request never becomes live. Removing a permission takes it away at once.
    const rejected = await asAdminRoles((c) => requestRolePermission(c, { roleCode: 'VERIFIER', permission: 'DEVIATION.APPROVE_INLINE' }));
    await asOwner((c) => decideRolePermission(c, rejected, false, 'not a verifier duty'));
    expect((await evaluateAuthority(db.app, { personId: op.personId, accountId: op.accountId, permission: 'DEVIATION.APPROVE_INLINE' })).allowed).toBe(false);
    await asAdminRoles((c) => removeRolePermission(c, 'VERIFIER', 'STEP.SUPERVISE'));
    expect(await canSupervise()).toBe(false);

    // Nobody requests a permission for a role they hold, nor approves one for a role they hold.
    await expectRefused(asAdminRoles((c) => requestRolePermission(c, { roleCode: 'SYSTEM_ADMINISTRATOR', permission: 'PLATFORM.ALARM_CLEAR' })), 'EBMR-IAM-003');
    const forOwners = await asAdminRoles((c) => requestRolePermission(c, { roleCode: 'PROCESS_OWNER', permission: 'RECORD.EXPORT' }));
    await expectRefused(asOwner((c) => decideRolePermission(c, forOwners, true, 'for my own role')), 'EBMR-IAM-032');
    expect((await db.app.query("select 1 from iam.role_permission where role_code = 'PROCESS_OWNER' and permission_code = 'RECORD.EXPORT'")).rowCount).toBe(0);
  });

  it('[DI-18][INV-11] bypass: even the table owner, inside a command, adds a permission to a role only through an approved request', async () => {
    const insert = (id: string) =>
      asDefinerCommand(db, withReason(adm.admin, 'ROLE_CHANGE'), (c) =>
        c.query("insert into iam.role_permission (id, role_code, permission_code) values ($1, 'OPERATOR', 'RECORD.LEGAL_HOLD')", [id]));
    await expectRefused(insert(randomUUID()), 'EBMR-IAM-039', /approved by a second person/);
    // Nor can a request be born approved, or a decision be forged by the requester.
    const forged = (sql: string, params: unknown[]) => asDefinerCommand(db, withReason(adm.admin, 'ROLE_CHANGE'), (c) => c.query(sql, params));
    await expectRefused(
      forged(
        `insert into iam.role_permission_request (role_code, permission_code, reason, status, requested_by_person, requested_by_account, decided_by_person, decided_at, role_permission_id)
         values ('OPERATOR', 'RECORD.LEGAL_HOLD', 'x', 'APPROVED', $1, $2, $3, clock_timestamp(), gen_random_uuid())`,
        [adm.admin.personId, adm.admin.accountId, adm.owner.personId],
      ),
      'EBMR-IAM-039',
    );
    const req = await withCommand(db.app, withReason(adm.admin, 'ROLE_CHANGE'), (c) => requestRolePermission(c, { roleCode: 'OPERATOR', permission: 'RECORD.LEGAL_HOLD' }));
    await expectRefused(
      forged("update iam.role_permission_request set reason = 'widened' where id = $1", [req]),
      'EBMR-IAM-039',
      /never changes/,
    );
    await expectRefused(
      forged("update iam.role_permission_request set status = 'APPROVED', decided_by_person = $2, role_permission_id = gen_random_uuid() where id = $1", [req, adm.admin.personId]),
      'EBMR-IAM-032',
    );
    await withCommand(db.app, withReason(adm.owner), (c) => decideRolePermission(c, req, false, 'operators never place legal holds'));
    expect((await db.app.query("select 1 from iam.role_permission where role_code = 'OPERATOR' and permission_code = 'RECORD.LEGAL_HOLD'")).rowCount).toBe(0);
  });

  it('[INV-11] bypass: two concurrent approvals cannot give one person both an administrator and a GMP role', async () => {
    const p = await seedActor(db, { roleCode: 'AUDITOR_READONLY', acknowledgeEsig: false });
    const owner2 = await seedActor(db, { roleCode: 'PROCESS_OWNER', acknowledgeEsig: false });
    const gQa = await asAdmin((c) => requestRoleGrant(c, { accountId: p.accountId, roleCode: 'QA_REVIEWER', reason: 'r1' }));
    const gAdm = await asAdmin((c) => requestRoleGrant(c, { accountId: p.accountId, roleCode: 'SYSTEM_ADMINISTRATOR', reason: 'r2' }));
    const c1 = await db.app.connect();
    const c2 = await db.app.connect();
    try {
      await c1.query('begin');
      await c1.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(withReason(adm.owner)))]);
      await c1.query("select iam.decide_role_grant($1, true, 'first')", [gQa]);
      await c2.query('begin');
      await c2.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(withReason(owner2)))]);
      const second = c2.query("select iam.decide_role_grant($1, true, 'second')", [gAdm]).then(
        () => 'approved',
        (e: Error) => e.message,
      );
      await pause(300);
      await c1.query('commit');
      expect(await second).toMatch(/^EBMR-IAM-033/);
      await c2.query('rollback');
    } finally {
      c1.release();
      c2.release();
    }
    const scan = await db.app.query('select * from iam.directory_scan()');
    expect(scan.rows).toEqual([]);
  });

  it('[INV-11] the invariant query (directory scan) returns zero rows after all of the above', async () => {
    const { rows } = await db.app.query('select * from iam.directory_scan()');
    expect(rows).toEqual([]);
  });
});

describe('shared-device actors keep working after identity changes', () => {
  it('[DI-16] a newly granted role is usable at once and appears in the access list', async () => {
    const op: SeededActor = await seedActor(db, { deviceClass: 'SHARED', acknowledgeEsig: false });
    await grantRole(op.accountId, 'VERIFIER');
    await withCommand(db.app, { ...(await withFreshAuth(db, op)), roleCode: 'VERIFIER' }, (c) => requirePermission(c, 'STEP.VERIFY'));
    expect(await freshAuthEvent(db, op)).toMatch(/[0-9a-f-]{36}/);
    const { rows } = await db.app.query("select role_code from iam.access_list() where account_id = $1 order by 1", [op.accountId]);
    expect(rows).toEqual([{ role_code: 'OPERATOR' }, { role_code: 'VERIFIER' }]);
  });
});
