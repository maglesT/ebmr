/**
 * Segregation of duties and role grants, as enforced in the database (DI-14, DI-16, DI-17, DI-18,
 * INV-11): the static segregation check, the role-grant and role-permission guards and the
 * request / decide functions (kernel 0120). These tests close the gaps the SQL mutation run
 * (tools/sql-mutation, group segregation-and-grants) found in the module tests.
 *
 * Raw writes run as the table owner (superuser) inside a real command and are always rolled back:
 * they prove that the guards hold for every writer, not only for the iam.* functions. Refusals are
 * asserted by their stable EBMR code, which identifies the rule that refused.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toDbContext, withCommand, type ActorContext } from '../../src/db/command.ts';
import {
  activateAccount,
  createAccount,
  createPerson,
  deactivateAccount,
  decideRoleGrant,
  recordIdentityVerification,
  requestRoleGrant,
  revokeRoleGrant,
  type AccountKind,
} from '../../src/identity/admin.ts';
import { evaluateAuthority } from '../../src/identity/authority.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { dbNow, expectPermissionDenied, expectRefused, pause } from '../identity/helpers.ts';
import { SEED_SITE, seedActor, seedAdministration, seedServiceActor, withReason, type SeedAdministration } from '../identity/seed.ts';

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
const asRoleAdmin = <T>(work: Work<T>) => withCommand(db.app, withReason(adm.admin, 'ROLE_CHANGE'), work);
const asOwner = <T>(work: Work<T>) => withCommand(db.app, withReason(adm.owner), work);
const hex = (n = 4): string => randomBytes(n).toString('hex');

async function request(accountId: string, roleCode: string, scope = {}): Promise<string> {
  return asAdmin((c) => requestRoleGrant(c, { accountId, roleCode, scope, reason: `needs ${roleCode}` }));
}

async function grantRole(accountId: string, roleCode: string, scope = {}): Promise<string> {
  const id = await request(accountId, roleCode, scope);
  await asOwner((c) => decideRoleGrant(c, id, true, 'approved'));
  return id;
}

/** A customer role with the given permissions (created and filled through the iam functions). */
async function customRole(permissions: string[], kinds: AccountKind[] = ['HUMAN'], group = 'EXECUTION'): Promise<string> {
  const code = `MUT_${hex(3).toUpperCase()}`;
  await asRoleAdmin(async (c) => {
    await c.query('select iam.create_role($1, $2, $3, $4, $5)', [code, `Role ${code}`, group, 'customer role of a segregation test', kinds]);
    for (const p of permissions) await c.query('select iam.add_role_permission($1, $2)', [code, p]);
  });
  return code;
}

const addPermission = (role: string, permission: string) =>
  asRoleAdmin((c) => c.query('select iam.add_role_permission($1, $2)', [role, permission]));

async function permissionsOf(role: string, at?: string): Promise<string[]> {
  const { rows } = await db.app.query<{ p: string[] }>('select iam.role_permissions_at($1, coalesce($2::timestamptz, clock_timestamp())) as p', [role, at ?? null]);
  return [...(rows[0]?.p ?? [])].sort();
}

/** An active account of a verified person: a new person unless `personId` names an existing one. */
async function account(opts: { kind: AccountKind; generic?: boolean; breakGlass?: boolean; personId?: string }): Promise<{ personId: string; accountId: string }> {
  return asAdmin(async (c) => {
    let personId = opts.personId;
    if (!personId) {
      personId = await createPerson(c, 'NATURAL', `Segregation Person ${hex(2)}`);
      await recordIdentityVerification(c, {
        personId, purpose: 'INITIAL', method: 'IN_PERSON_DOCUMENT', documentType: 'ID card', evidenceRef: `HR-${hex()}`, occurredAt: '2026-01-05T09:00:00Z',
      });
    }
    const accountId = await createAccount(c, { personId, loginName: `seg-${hex()}`, kind: opts.kind, generic: opts.generic ?? false, breakGlass: opts.breakGlass ?? false });
    await activateAccount(c, accountId);
    return { personId, accountId };
  });
}

/** One raw statement by the table owner (superuser) inside a real command; always rolled back. */
async function asTableOwner(ctx: ActorContext, sql: string, params: unknown[] = []): Promise<void> {
  const c = await db.admin.connect();
  try {
    await c.query('begin');
    await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(ctx))]);
    await c.query(sql, params);
  } finally {
    await c.query('rollback');
    c.release();
  }
}

interface Command {
  ctx: ActorContext;
  sql: string;
  params: unknown[];
}

/**
 * Runs `first` in an open transaction, then starts `second` on another connection. Once `second`
 * has finished or waits for a lock, `first` commits; returns how `second` ended ('done' or the
 * error message). `second` is always rolled back.
 */
async function race(first: Command, second: Command): Promise<string> {
  const c1 = await db.app.connect();
  const c2 = await db.app.connect();
  try {
    await c1.query('begin');
    await c1.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(first.ctx))]);
    await c1.query(first.sql, first.params);
    await c2.query('begin');
    await c2.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(second.ctx))]);
    const pid = (await c2.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]?.pid;
    const state = { settled: false };
    const outcome = c2.query(second.sql, second.params).then(
      () => 'done',
      (e: Error) => e.message,
    );
    void outcome.then(() => {
      state.settled = true;
    });
    for (let i = 0; i < 500; i++) {
      if (state.settled) break;
      const { rows } = await db.admin.query<{ w: string | null }>('select wait_event_type as w from pg_stat_activity where pid = $1', [pid]);
      if (rows[0]?.w === 'Lock') break;
      await pause(20);
    }
    await c1.query('commit');
    return await outcome;
  } finally {
    await c2.query('rollback').catch(() => undefined);
    await c1.query('rollback').catch(() => undefined);
    c1.release();
    c2.release();
  }
}

async function grantRow(id: string): Promise<Record<string, unknown>> {
  const { rows } = await db.app.query<Record<string, unknown>>(
    'select status, decided_by_person, decided_by_account, decided_at, decision_reason, revoked_at from iam.role_grant where id = $1',
    [id],
  );
  return rows[0] ?? {};
}

describe('grant requests and decisions (DI-16, DI-14)', () => {
  it('[DI-16] requests and decisions name a real account and a real grant; the static check fails closed', async () => {
    await expectRefused(request(randomUUID(), 'AUDITOR_READONLY'), 'EBMR-IAM-022');
    await expectRefused(asOwner((c) => decideRoleGrant(c, randomUUID(), true, 'approved')), 'EBMR-IAM-031');
    // The static segregation check itself refuses an account it cannot find instead of passing it,
    // and it is not exposed to the application role.
    await expectRefused(db.admin.query("select iam.check_static_segregation($1, 'OPERATOR', null)", [randomUUID()]), 'EBMR-IAM-022');
    await expectPermissionDenied(db.app.query("select iam.check_static_segregation($1, 'OPERATOR', null)", [randomUUID()]));
  });

  it('[DI-16][DI-14] a disabled account receives no grant: neither a new request nor the approval of one pending when it was disabled', async () => {
    const p = await seedActor(db, { roleCode: 'AUDITOR_READONLY', acknowledgeEsig: false });
    const pending = await request(p.accountId, 'STATUS_DISPLAY');
    await asAdmin((c) => deactivateAccount(c, p.accountId, 'left the company'));
    await expectRefused(request(p.accountId, 'CONTRACT_GIVER_REVIEWER'), 'EBMR-IAM-026');
    await expectRefused(asOwner((c) => decideRoleGrant(c, pending, true, 'approved')), 'EBMR-IAM-026');
    expect(await grantRow(pending)).toMatchObject({ status: 'REQUESTED', decided_by_person: null });
    const { rows } = await db.app.query('select role_code from iam.access_list() where account_id = $1', [p.accountId]);
    expect(rows).toEqual([]);
  });

  it('[DI-14] a role is granted only to the account kinds it is made for', async () => {
    const op = await seedActor(db, { acknowledgeEsig: false });
    await expectRefused(request(op.accountId, 'SERVICE_ACCOUNT'), 'EBMR-IAM-036', /not for HUMAN accounts/);
    const display = await account({ kind: 'READONLY_DISPLAY', personId: op.personId });
    await expectRefused(request(display.accountId, 'AUDITOR_READONLY'), 'EBMR-IAM-036', /not for READONLY_DISPLAY accounts/);
    await grantRole(display.accountId, 'STATUS_DISPLAY');
  });

  it('[DI-16][DI-18] nobody revokes their own grant: an administrator cannot revoke their own administrator grant', async () => {
    const admin2 = await seedActor(db, { roleCode: 'SYSTEM_ADMINISTRATOR', acknowledgeEsig: false });
    await expectRefused(
      withCommand(db.app, withReason(admin2), (c) => revokeRoleGrant(c, admin2.seed.grantId, 'my own access')),
      'EBMR-IAM-003',
      /nobody revokes their own grant/,
    );
    expect(await grantRow(admin2.seed.grantId)).toMatchObject({ status: 'APPROVED', revoked_at: null });
    await asAdmin((c) => revokeRoleGrant(c, admin2.seed.grantId, 'second administrator no longer needed'));
    expect(await grantRow(admin2.seed.grantId)).toMatchObject({ status: 'REVOKED' });
  });

  it('[DI-16] a decided grant is never decided again: a rejected or revoked grant is not approved later, an approval is not re-dated or withdrawn', async () => {
    const p = await seedActor(db, { roleCode: 'AUDITOR_READONLY', acknowledgeEsig: false });
    const owner2 = await seedActor(db, { roleCode: 'PROCESS_OWNER', acknowledgeEsig: false });
    const asOwner2 = <T>(work: Work<T>) => withCommand(db.app, withReason(owner2), work);

    const rejected = await request(p.accountId, 'STATUS_DISPLAY');
    await asOwner((c) => decideRoleGrant(c, rejected, false, 'not needed'));
    await expectRefused(asOwner((c) => decideRoleGrant(c, rejected, true, 'changed my mind')), 'EBMR-IAM-037');
    await expectRefused(asOwner2((c) => decideRoleGrant(c, rejected, true, 'second opinion')), 'EBMR-IAM-037');
    expect(await grantRow(rejected)).toMatchObject({ status: 'REJECTED', decided_by_person: adm.owner.personId, decision_reason: 'not needed' });

    const approved = await grantRole(p.accountId, 'CONTRACT_GIVER_REVIEWER');
    const before = await grantRow(approved);
    await expectRefused(asOwner((c) => decideRoleGrant(c, approved, true, 'approved again')), 'EBMR-IAM-037');
    await expectRefused(asOwner2((c) => decideRoleGrant(c, approved, false, 'withdrawn')), 'EBMR-IAM-037');
    expect(await grantRow(approved)).toEqual(before);

    await asAdmin((c) => revokeRoleGrant(c, approved, 'no longer needed'));
    await expectRefused(asOwner2((c) => decideRoleGrant(c, approved, true, 'reinstated')), 'EBMR-IAM-037');
    expect(await grantRow(approved)).toMatchObject({ status: 'REVOKED', decided_by_person: adm.owner.personId });
    const { rows } = await db.app.query('select grant_id from iam.access_list() where account_id = $1 order by role_code', [p.accountId]);
    expect(rows).toEqual([{ grant_id: p.seed.grantId }]);
  });
});

describe('the role-grant guard holds for every writer (DI-16, DI-18, INV-11)', () => {
  it('[DI-16][DI-18] bypass: even the table owner can only insert a grant as a plain request of the account\'s own person', async () => {
    const p = await seedActor(db, { roleCode: 'AUDITOR_READONLY', acknowledgeEsig: false });
    const ctx = withReason(adm.admin);
    const insert = (status: string, cols: string, vals: string, extra: unknown[] = [], person = p.personId) =>
      asTableOwner(
        ctx,
        `insert into iam.role_grant (account_id, person_id, role_code, valid_from, reason, status, requested_by_person, requested_by_account${cols})
         values ($1, $2, 'STATUS_DISPLAY', clock_timestamp(), 'raw request', $3, $4, $5${vals})`,
        [p.accountId, person, status, adm.admin.personId, adm.admin.accountId, ...extra],
      );
    // A plain request is accepted (and rolled back): the refusals below are about the forged parts.
    await insert('REQUESTED', '', '');
    await expectRefused(
      insert('APPROVED', ', decided_by_person, decided_by_account, decided_at', ', $6, $7, clock_timestamp()', [adm.owner.personId, adm.owner.accountId]),
      'EBMR-IAM-037',
    );
    await expectRefused(insert('APPROVED', '', ''), 'EBMR-IAM-037');
    await expectRefused(insert('REQUESTED', ', decided_by_person', ', $6', [adm.owner.personId]), 'EBMR-IAM-037');
    await expectRefused(insert('REQUESTED', ', decided_at', ', clock_timestamp()'), 'EBMR-IAM-037');
    await expectRefused(insert('REQUESTED', ', revoked_by_person', ', $6', [adm.owner.personId]), 'EBMR-IAM-037');
    await expectRefused(insert('REQUESTED', ', revoked_at', ", clock_timestamp() + interval '1 day'"), 'EBMR-IAM-037');
    // The grant's person is always the account's person.
    await expectRefused(insert('REQUESTED', '', '', [], adm.owner.personId), 'EBMR-IAM-031');
  });

  it('[DI-16][DI-17] bypass: what was requested never changes when it is approved, even for the table owner', async () => {
    const p = await seedActor(db, { roleCode: 'AUDITOR_READONLY', acknowledgeEsig: false });
    const display = await account({ kind: 'READONLY_DISPLAY', personId: p.personId });
    const g = await request(p.accountId, 'STATUS_DISPLAY', { site: SEED_SITE });
    const ctx = withReason(adm.owner);
    const approve = "update iam.role_grant set status = 'APPROVED', decided_by_person = $2, decided_by_account = $3, decision_reason = 'approved'";
    const approveWith = (set: string, extra: unknown[] = []) =>
      asTableOwner(ctx, `${approve}${set} where id = $1`, [g, adm.owner.personId, adm.owner.accountId, ...extra]);
    await approveWith('');
    const changes: [string, unknown[]][] = [
      [', id = gen_random_uuid()', []],
      [', account_id = $4', [display.accountId]],
      [", scope_site = 'SITE-2'", []],
      [", scope_area = 'ROOM-9'", []],
      [", scope_product = 'PRODUCT-9'", []],
      [", valid_from = valid_from - interval '1 day'", []],
      [", valid_to = clock_timestamp() + interval '5 years'", []],
      [", reason = 'widened after the request'", []],
      [', requested_by_person = $4', [randomUUID()]],
      [', requested_by_account = $4', [randomUUID()]],
      [", requested_at = requested_at - interval '1 hour'", []],
    ];
    for (const [set, extra] of changes) {
      await expectRefused(approveWith(set, extra), 'EBMR-IAM-038', /never changes/);
    }
    // A decision never carries a revocation.
    await expectRefused(approveWith(', revoked_by_person = $4', [adm.admin.personId]), 'EBMR-IAM-037', /does not revoke/);
    await expectRefused(approveWith(", revoked_at = clock_timestamp() + interval '1 day'"), 'EBMR-IAM-037', /does not revoke/);
    await expectRefused(approveWith(', revoked_by_person = $4, revoked_at = clock_timestamp()', [adm.admin.personId]), 'EBMR-IAM-037');
    expect(await grantRow(g)).toMatchObject({ status: 'REQUESTED', decided_by_person: null, revoked_at: null });
  });

  it('[DI-16] bypass: the approval behind a grant never changes when it is revoked, even for the table owner', async () => {
    const p = await seedActor(db, { roleCode: 'AUDITOR_READONLY', acknowledgeEsig: false });
    const g = p.seed.grantId;
    const ctx = withReason(adm.admin);
    const revoke = "update iam.role_grant set status = 'REVOKED', revoked_by_person = $2, revoked_by_account = $3, revocation_reason = 'no longer needed'";
    const revokeWith = (set: string) => asTableOwner(ctx, `${revoke}${set} where id = $1`, [g, adm.admin.personId, adm.admin.accountId]);
    await revokeWith('');
    for (const set of [
      ', decided_by_person = gen_random_uuid()',
      ', decided_by_account = gen_random_uuid()',
      ", decided_at = decided_at - interval '1 hour'",
      ", decision_reason = 'rewritten'",
    ]) {
      await expectRefused(revokeWith(set), 'EBMR-IAM-038', /approval of a grant never changes/);
    }
    expect(await grantRow(g)).toMatchObject({ status: 'APPROVED', decided_by_person: adm.owner.personId, revoked_at: null });
  });

  it('[DI-16] bypass: the table owner cannot turn an approved grant into a rejected one, which would erase it from past access lists', async () => {
    const p = await seedActor(db, { roleCode: 'AUDITOR_READONLY', acknowledgeEsig: false });
    const t = await dbNow(db);
    await expectRefused(
      asTableOwner(withReason(adm.owner), "update iam.role_grant set status = 'REJECTED' where id = $1", [p.seed.grantId]),
      'EBMR-IAM-037',
      /cannot go from APPROVED to REJECTED/,
    );
    const { rows } = await db.app.query('select grant_id from iam.access_list($1) where account_id = $2', [t, p.accountId]);
    expect(rows).toEqual([{ grant_id: p.seed.grantId }]);
  });
});

describe('the role catalogue cannot be used to bypass segregation (DI-14, DI-18, INV-11)', () => {
  it('[DI-17][DI-16] removing a permission from a role takes effect at once; the role\'s past permissions stay on record', async () => {
    const role = await customRole(['QC.RESULT_RECORD', 'RECORD.READ'], ['HUMAN'], 'QUALITY_RELEASE');
    const op = await seedActor(db, { acknowledgeEsig: false });
    await grantRole(op.accountId, role);
    const can = async () => (await evaluateAuthority(db.app, { personId: op.personId, accountId: op.accountId, permission: 'QC.RESULT_RECORD' })).allowed;
    expect(await can()).toBe(true);
    const before = await dbNow(db);
    await asRoleAdmin((c) => c.query("select iam.remove_role_permission($1, 'QC.RESULT_RECORD')", [role]));
    expect(await can()).toBe(false);
    expect(await permissionsOf(role)).toEqual(['RECORD.READ']);
    expect(await permissionsOf(role, before)).toEqual(['QC.RESULT_RECORD', 'RECORD.READ']);
    await expectRefused(asRoleAdmin((c) => c.query("select iam.remove_role_permission($1, 'QC.RESULT_RECORD')", [role])), 'EBMR-IAM-030');
  });

  it('[DI-16][INV-11] bypass: a role-permission row can only be removed, once, even by the table owner', async () => {
    const role = await customRole(['RECORD.READ', 'RECORD.EXPORT'], ['HUMAN'], 'ADMINISTRATION_SECURITY');
    const other = await customRole(['RECORD.READ'], ['HUMAN'], 'ADMINISTRATION_SECURITY');
    await asRoleAdmin((c) => c.query("select iam.remove_role_permission($1, 'RECORD.EXPORT')", [role]));
    const { rows } = await db.app.query<{ id: string; permission_code: string }>('select id, permission_code from iam.role_permission where role_code = $1', [role]);
    const live = rows.find((r) => r.permission_code === 'RECORD.READ')?.id;
    const removed = rows.find((r) => r.permission_code === 'RECORD.EXPORT')?.id;
    const ctx = withReason(adm.admin, 'ROLE_CHANGE');
    const update = (id: string | undefined, set: string, extra: unknown[] = []) =>
      asTableOwner(ctx, `update iam.role_permission set ${set} where id = $1`, [id, ...extra]);
    // A plain removal is what iam.remove_role_permission does (accepted, and rolled back).
    await update(live, 'removed_at = clock_timestamp()');
    for (const [set, extra] of [
      ['id = gen_random_uuid(), removed_at = clock_timestamp()', []],
      ['role_code = $2, removed_at = clock_timestamp()', [other]],
      ["permission_code = 'RECORD.EXPORT', removed_at = clock_timestamp()", []],
      ["added_at = added_at - interval '1 day', removed_at = clock_timestamp()", []],
      ['removed_at = null', []],
    ] as [string, unknown[]][]) {
      await expectRefused(update(live, set, extra), 'EBMR-IAM-007');
    }
    await expectRefused(update(removed, 'removed_at = clock_timestamp()'), 'EBMR-IAM-007');
    await expectRefused(update(removed, 'removed_at = null'), 'EBMR-IAM-007');
    expect(await permissionsOf(role)).toEqual(['RECORD.READ']);
  });

  it('[INV-11][DI-18] a role never mixes administration and GMP permissions, even before anyone holds it', async () => {
    const adminRole = await customRole(['IAM.UNLOCK'], ['HUMAN'], 'ADMINISTRATION_SECURITY');
    const gmpRole = await customRole(['STEP.EXECUTE']);
    await expectRefused(addPermission(adminRole, 'STEP.EXECUTE'), 'EBMR-IAM-033', /INV-11/);
    await expectRefused(addPermission(gmpRole, 'IAM.UNLOCK'), 'EBMR-IAM-033', /INV-11/);
    // Within one domain, and with read-only or governance permissions, bundles grow freely.
    await addPermission(adminRole, 'IAM.DEVICE_MANAGE');
    await addPermission(adminRole, 'RECORD.EXPORT');
    await addPermission(gmpRole, 'STEP.VERIFY');
    await addPermission(gmpRole, 'RECORD.READ');
    expect(await permissionsOf(adminRole)).toEqual(['IAM.DEVICE_MANAGE', 'IAM.UNLOCK', 'RECORD.EXPORT']);
    expect(await permissionsOf(gmpRole)).toEqual(['RECORD.READ', 'STEP.EXECUTE', 'STEP.VERIFY']);
  });

  it('[DI-14] a permission added to a role is checked against its holders: generic and display accounts keep READ permissions only, pending requests included', async () => {
    const g = await account({ kind: 'HUMAN', generic: true });
    const d = await account({ kind: 'READONLY_DISPLAY' });
    const genericRole = await customRole(['RECORD.READ']);
    const displayRole = await customRole(['RECORD.READ'], ['READONLY_DISPLAY']);
    await grantRole(g.accountId, genericRole);
    await grantRole(d.accountId, displayRole);
    await expectRefused(addPermission(genericRole, 'QC.RESULT_RECORD'), 'EBMR-IAM-034', /DI-14/);
    await expectRefused(addPermission(genericRole, 'IAM.ALERT_ACKNOWLEDGE'), 'EBMR-IAM-034', /DI-14/);
    await expectRefused(addPermission(displayRole, 'QC.RESULT_RECORD'), 'EBMR-IAM-034', /DI-14/);
    await addPermission(genericRole, 'RECORD.EXPORT');
    await addPermission(displayRole, 'RECORD.EXPORT');

    const g2 = await account({ kind: 'HUMAN', generic: true });
    const pendingRole = await customRole(['RECORD.READ']);
    await request(g2.accountId, pendingRole);
    await expectRefused(addPermission(pendingRole, 'QC.RESULT_RECORD'), 'EBMR-IAM-034', /DI-14/);
    expect(await permissionsOf(pendingRole)).toEqual(['RECORD.READ']);
    expect((await db.app.query('select * from iam.directory_scan()')).rows).toEqual([]);
  });

  it('[DI-14] a signing or acknowledging permission is never added to a role a service account holds', async () => {
    const svc = await seedServiceActor(db);
    const svcRole = await customRole(['INTERFACE.WRITE'], ['SERVICE', 'INTEGRATION']);
    await grantRole(svc.accountId, svcRole);
    await expectRefused(addPermission(svcRole, 'STEP.VERIFY'), 'EBMR-IAM-035', /DI-14/);
    await expectRefused(addPermission(svcRole, 'ALARM.ACKNOWLEDGE'), 'EBMR-IAM-035', /DI-14/);
    await expectRefused(addPermission(svcRole, 'IAM.ALERT_ACKNOWLEDGE'), 'EBMR-IAM-035', /DI-14/);
    // Machine-to-machine writing stays possible.
    await addPermission(svcRole, 'QC.RESULT_RECORD');
    expect(await permissionsOf(svcRole)).toEqual(['INTERFACE.WRITE', 'QC.RESULT_RECORD']);
  });

  it('[DI-18] a GMP, signing or acknowledging permission is never added to a role a break-glass account holds', async () => {
    const q = await seedActor(db, { roleCode: 'AUDITOR_READONLY', acknowledgeEsig: false });
    const bg = await account({ kind: 'HUMAN', personId: q.personId, breakGlass: true });
    const bgRole = await customRole(['RECORD.READ'], ['HUMAN'], 'ADMINISTRATION_SECURITY');
    await grantRole(bg.accountId, bgRole);
    await expectRefused(addPermission(bgRole, 'MASTERDATA.CHANGE'), 'EBMR-IAM-036', /DI-18/);
    await expectRefused(addPermission(bgRole, 'SYSTEM.PERIODIC_REVIEW'), 'EBMR-IAM-036', /DI-18/);
    await expectRefused(addPermission(bgRole, 'IAM.ALERT_ACKNOWLEDGE'), 'EBMR-IAM-036', /DI-18/);
    // Emergency administration is what break-glass is for.
    await addPermission(bgRole, 'IAM.UNLOCK');
    expect(await permissionsOf(bgRole)).toEqual(['IAM.UNLOCK', 'RECORD.READ']);
  });

  it('[DI-17][INV-11] a GMP permission added to a GMP role reaches its holder, whoever else holds administrator or display roles', async () => {
    const op = await seedActor(db, { acknowledgeEsig: false });
    const g = await account({ kind: 'HUMAN', generic: true });
    await grantRole(g.accountId, 'STATUS_DISPLAY');
    const role = await customRole(['QC.RESULT_RECORD'], ['HUMAN'], 'QUALITY_RELEASE');
    await grantRole(op.accountId, role);
    await addPermission(role, 'QC.RESULT_APPROVE');
    await addPermission(role, 'RECORD.EXPORT');
    const d = await evaluateAuthority(db.app, { personId: op.personId, accountId: op.accountId, permission: 'QC.RESULT_APPROVE' });
    expect(d).toMatchObject({ allowed: true, roleCode: role });
    expect((await db.app.query('select * from iam.directory_scan()')).rows).toEqual([]);
  });
});

describe('concurrent changes are serialised on the person (INV-11)', () => {
  const addUnlock = (role: string): Command => ({ ctx: withReason(adm.admin, 'ROLE_CHANGE'), sql: "select iam.add_role_permission($1, 'IAM.UNLOCK')", params: [role] });
  const approve = (grant: string): Command => ({ ctx: withReason(adm.owner), sql: "select iam.decide_role_grant($1, true, 'approved')", params: [grant] });

  it('[INV-11][DI-18] bypass: approving a GMP grant while a role the grantee holds gains an administration permission is refused', async () => {
    const p = await seedActor(db, { roleCode: 'AUDITOR_READONLY', acknowledgeEsig: false });
    const role = await customRole(['RECORD.READ'], ['HUMAN'], 'ADMINISTRATION_SECURITY');
    await grantRole(p.accountId, role);
    const qa = await request(p.accountId, 'QA_REVIEWER');
    expect(await race(addUnlock(role), approve(qa))).toMatch(/^EBMR-IAM-033/);
    expect(await grantRow(qa)).toMatchObject({ status: 'REQUESTED' });
    expect((await db.app.query('select * from iam.directory_scan()')).rows).toEqual([]);
  });

  it('[INV-11][DI-18] bypass: adding an administration permission to a role while its holder is approved for a GMP role is refused', async () => {
    const p = await seedActor(db, { roleCode: 'AUDITOR_READONLY', acknowledgeEsig: false });
    const role = await customRole(['RECORD.READ'], ['HUMAN'], 'ADMINISTRATION_SECURITY');
    await grantRole(p.accountId, role);
    const qa = await request(p.accountId, 'QA_REVIEWER');
    expect(await race(approve(qa), addUnlock(role))).toMatch(/^EBMR-IAM-033/);
    expect(await permissionsOf(role)).toEqual(['RECORD.READ']);
    expect((await db.app.query('select * from iam.directory_scan()')).rows).toEqual([]);
  });
});
