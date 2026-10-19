/**
 * The access-governance routes of slice 7g-5 (decision 0025; contract ns/access-governance.ts) over HTTP with real
 * sessions: the database decides every act. The system administrator requests a permission for a role and cannot approve
 * it; the process owner approves it; the administrator removes it at once. A holder of signing authority delegates a
 * meaning; the delegate, the delegator and the system administrator cannot approve it; the process owner does; the
 * delegate cannot pass it on. The US e-signature certification letter is recorded by the process owner, never by the
 * administrator, never dated in the future, and the kernel's status says whether US-market work is blocked.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type Result } from '@ebmr/api-contract';
import { withCommand } from '@ebmr/kernel';
import { passwordActor } from '@ebmr/test-kit';
import { startSigningServer } from '../esig/support.ts';
import { grantedPerson, loginOf } from '../support/granted-person.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { signAction } from '../support/signed-acts.ts';

const G = routes.accessGovernance;
let server: TestServer;
let admin: TestBrowser;
let owner: TestBrowser;
let approver: TestBrowser;

const valueOf = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`expected success, got ${JSON.stringify(r.error)}`);
  return r.value;
};
const codeOf = (r: Result<unknown>): string => (r.ok ? 'OK' : r.error.kind === 'REFUSAL' ? r.error.envelope.refusal.code : JSON.stringify(r.error));
const whyOf = (r: Result<unknown>): string => (!r.ok && r.error.kind === 'REFUSAL' ? r.error.envelope.refusal.why : '');
/** A change record covering `areas`, raised by the master-data steward and approved by QA's signature (DI-09). */
async function approvedChangeRecord(areas: string[]): Promise<string> {
  const number = `CR-ROLE-${randomUUID().slice(0, 8).toUpperCase()}`;
  const steward = await server.asPersona('steward');
  valueOf(await steward.call(routes.config.raiseChangeRecord, { body: { number, title: 'Role permissions', description: 'A permission added to a role and later removed', areas } }));
  const qa2 = await server.asPersona('qaApprover2');
  expect((await signAction(server, qa2, 'qaApprover2', { kind: 'CONFIG_CHANGE_ACT', act: 'APPROVE', number })).ok).toBe(true);
  return number;
}
const iso = (offsetMinutes: number): string => new Date(Date.now() + offsetMinutes * 60_000).toISOString();

beforeAll(async () => {
  server = await startSigningServer('GMP');
  admin = await loginOf(server, await grantedPerson(server, 'SYSTEM_ADMINISTRATOR', 'Ira Admin'));
  owner = await loginOf(server, await grantedPerson(server, 'PROCESS_OWNER', 'Omar Owner'));
  approver = await server.asPersona('approver');
}, 300_000);
afterAll(async () => {
  await server?.close();
});

describe('role-permission requests over HTTP', () => {
  it('[DI-16][DI-18][INV-11] the administrator requests a permission for a role and cannot decide it; a GMP role holder can neither read nor request; the process owner approves it; the administrator removes it at once', async () => {
    const before = valueOf(await admin.call(G.rolePermissions));
    const role = before.roles.find((r) => r.code === 'QA_REVIEWER')!;
    const perm = before.permissions.find((p) => p.domain === 'GMP' && p.effect === 'READ' && !role.permissions.includes(p.code)) ?? before.permissions.find((p) => p.domain === 'GMP' && !role.permissions.includes(p.code))!;
    const req = valueOf(await admin.call(G.requestRolePermission, { body: { roleCode: 'QA_REVIEWER', permissionCode: perm.code, reason: 'reviewers read the new register' } }));
    expect(req).toMatchObject({ status: 'REQUESTED', roleCode: 'QA_REVIEWER', permissionCode: perm.code, requestedBy: { legalName: 'Ira Admin' }, decidedBy: null });
    // A second identical request waits for the first; the requester never decides (DI-16).
    expect(codeOf(await admin.call(G.requestRolePermission, { body: { roleCode: 'QA_REVIEWER', permissionCode: perm.code, reason: 'again' } }))).toBe('EBMR-IAM-039');
    expect(codeOf(await admin.call(G.decideRolePermission, { params: { requestId: req.requestId }, body: { approve: true, reason: 'self' } }))).toBe('EBMR-IAM-032');
    // A GMP role holder holds no role-management right and reads nothing of it.
    expect(codeOf(await approver.call(G.requestRolePermission, { body: { roleCode: 'QA_REVIEWER', permissionCode: perm.code, reason: 'x' } }))).toBe('EBMR-IAM-040');
    expect(codeOf(await approver.call(G.decideRolePermission, { params: { requestId: req.requestId }, body: { approve: true, reason: 'x' } }))).toBe('EBMR-IAM-040');
    expect(codeOf(await approver.call(G.rolePermissions))).toBe('ROLE_NOT_ALLOWED');
    // INV-11: an administration permission is never added to a GMP role.
    const adminPerm = before.permissions.find((p) => p.domain === 'ADMINISTRATION')!;
    const mixed = await admin.call(G.requestRolePermission, { body: { roleCode: 'QA_REVIEWER', permissionCode: adminPerm.code, reason: 'x' } });
    expect(codeOf(mixed)).toBe('EBMR-IAM-033');
    expect(whyOf(mixed)).toContain('INV-11');
    // The process owner approves under an approved change record (a role's permissions are configuration, DI-09); only
    // then the role holds it. Without one the database refuses and nothing changes.
    const unrecorded = await owner.call(G.decideRolePermission, { params: { requestId: req.requestId }, body: { approve: true, reason: 'agreed with QA' } });
    expect(codeOf(unrecorded)).toBe('EBMR-CFG-001');
    const cr = await approvedChangeRecord(['ROLE_PERMISSION']);
    const decided = valueOf(await owner.call(G.decideRolePermission, { params: { requestId: req.requestId }, body: { approve: true, reason: 'agreed with QA', changeRecord: cr } }));
    expect(decided).toMatchObject({ status: 'APPROVED', decidedBy: { legalName: 'Omar Owner' }, decisionReason: 'agreed with QA' });
    expect(codeOf(await owner.call(G.decideRolePermission, { params: { requestId: req.requestId }, body: { approve: false, reason: 'twice' } }))).toBe('EBMR-IAM-039');
    const after = valueOf(await owner.call(G.rolePermissions));
    expect(after.roles.find((r) => r.code === 'QA_REVIEWER')!.permissions).toContain(perm.code);
    // Taking authority away needs no second person and is in force at once.
    const removed = valueOf(await admin.call(G.removeRolePermission, { body: { roleCode: 'QA_REVIEWER', permissionCode: perm.code, reason: 'register retired', changeRecord: cr } }));
    expect(removed.roles.find((r) => r.code === 'QA_REVIEWER')!.permissions).not.toContain(perm.code);
    expect(codeOf(await admin.call(G.removeRolePermission, { body: { roleCode: 'QA_REVIEWER', permissionCode: perm.code, reason: 'twice', changeRecord: cr } }))).toBe('EBMR-IAM-030');
  }, 120_000);

  it('[DI-16][DI-18] P7G-1: an administrator cannot approve a permission for a role they hold (it would grant themselves), even with a change record', async () => {
    // Only SYSTEM_ADMINISTRATOR holds IAM.ROLE_MANAGE and nobody requests for a role they hold, so the request of
    // another person for the administrator's own role is written directly (the trigger still checks it).
    const { rows } = await server.db.admin.query<{ code: string }>(
      "select p.code from iam.permission p where p.domain = 'ADMINISTRATION' and not exists (select 1 from iam.role_permission rp where rp.role_code = 'SYSTEM_ADMINISTRATOR' and rp.permission_code = p.code and rp.removed_at is null) order by p.code limit 1",
    );
    const permissionCode = rows[0]!.code;
    const requester = await passwordActor(server.db, server.seed.bootstrap.owner, server.seed.bootstrap.owner.fingerprint);
    const ctx = { ...requester, reasonCode: 'TEST_SETUP', reasonText: 'P7G-1 test set-up', correlationId: randomUUID() };
    const requestId = await withCommand(server.db.admin, ctx, async (c) => (await c.query<{ id: string }>(
      "insert into iam.role_permission_request (role_code, permission_code, reason, status, requested_by_person, requested_by_account) values ('SYSTEM_ADMINISTRATOR', $1, 'administrators acknowledge alerts', 'REQUESTED', $2, $3) returning id",
      [permissionCode, requester.personId, requester.accountId],
    )).rows[0]!.id);
    const cr = await approvedChangeRecord(['ROLE_PERMISSION']);
    const self = await admin.call(G.decideRolePermission, { params: { requestId }, body: { approve: true, reason: 'self', changeRecord: cr } });
    expect(codeOf(self)).toBe('EBMR-IAM-032');
    const after = valueOf(await owner.call(G.rolePermissions));
    expect(after.roles.find((r) => r.code === 'SYSTEM_ADMINISTRATOR')!.permissions).not.toContain(permissionCode);
  }, 120_000);
});

describe('delegations of signing authority over HTTP', () => {
  it('[IN-05][DI-35][DI-18] the authorised person delegates manufacturer release; the delegate, the delegator and the administrator cannot approve; the process owner approves; the delegate cannot pass it on; the delegator revokes it', async () => {
    const ap = await server.asPersona('qcuAuthoriser');
    const deputy = await server.asPersona('qaApprover2');
    const read = valueOf(await ap.call(G.delegations));
    expect(read.meanings.map((m) => m.code)).toContain('MANUFACTURER_RELEASE');
    const body = {
      delegateLoginName: 'arvind.rao', scope: {}, markets: ['IN' as const], meanings: ['MANUFACTURER_RELEASE'],
      validFrom: iso(-1), validTo: iso(7 * 24 * 60), sopRef: `SOP-QA-017-${randomUUID().slice(0, 4)}`, reason: 'annual leave of the authorised person',
    };
    const d = valueOf(await ap.call(G.requestDelegation, { body }));
    expect(d).toMatchObject({ status: 'REQUESTED', live: false, delegator: { legalName: 'Shalini Kapoor' }, delegate: { legalName: 'Arvind Rao' }, meanings: ['MANUFACTURER_RELEASE'], markets: ['IN'] });
    // Nobody but a third person decides it: the administrator holds no approval right, the delegate and delegator are refused.
    expect(codeOf(await admin.call(G.decideDelegation, { params: { delegationId: d.delegationId }, body: { approve: true, reason: 'x' } }))).toBe('EBMR-IAM-040');
    expect(codeOf(await ap.call(G.decideDelegation, { params: { delegationId: d.delegationId }, body: { approve: true, reason: 'x' } }))).toMatch(/^EBMR-IAM-(040|182)$/);
    expect(codeOf(await deputy.call(G.decideDelegation, { params: { delegationId: d.delegationId }, body: { approve: true, reason: 'x' } }))).toMatch(/^EBMR-IAM-(040|182)$/);
    // The administrator's read shows only their own delegations (none); the approver's shows it with the right to decide.
    expect(valueOf(await admin.call(G.delegations)).delegations.some((x) => x.delegationId === d.delegationId)).toBe(false);
    const ownerRead = valueOf(await owner.call(G.delegations));
    expect(ownerRead.mayApprove).toBe(true);
    expect(ownerRead.delegations.some((x) => x.delegationId === d.delegationId)).toBe(true);
    const approved = valueOf(await owner.call(G.decideDelegation, { params: { delegationId: d.delegationId }, body: { approve: true, reason: 'SOP followed' } }));
    expect(approved).toMatchObject({ status: 'APPROVED', live: true, decidedBy: { legalName: 'Omar Owner' } });
    // The delegate sees it, and cannot re-delegate a meaning held only by delegation (EBMR-IAM-181).
    expect(valueOf(await deputy.call(G.delegations)).delegations.some((x) => x.delegationId === d.delegationId)).toBe(true);
    const re = await deputy.call(G.requestDelegation, { body: { ...body, delegateLoginName: 'divya.menon' } });
    expect(codeOf(re)).toBe('EBMR-IAM-181');
    // A delegate who is the approver cannot approve their own delegation (EBMR-IAM-182, the table's guard).
    const toApprover = valueOf(await ap.call(G.requestDelegation, { body: { ...body, delegateLoginName: 'meera.iyer', meanings: ['MANUFACTURER_RELEASE'], sopRef: 'SOP-QA-018' } }));
    expect(codeOf(await approver.call(G.decideDelegation, { params: { delegationId: toApprover.delegationId }, body: { approve: true, reason: 'x' } }))).toBe('EBMR-IAM-182');
    expect(valueOf(await owner.call(G.decideDelegation, { params: { delegationId: toApprover.delegationId }, body: { approve: false, reason: 'one deputy is enough' } }))).toMatchObject({ status: 'REJECTED', live: false });
    // An unknown user ID is refused before anything is recorded; the delegator revokes.
    expect(codeOf(await ap.call(G.requestDelegation, { body: { ...body, delegateLoginName: 'nobody.here' } }))).toBe('EBMR-API-NOT-FOUND');
    const revoked = valueOf(await ap.call(G.revokeDelegation, { params: { delegationId: d.delegationId }, body: { reason: 'back from leave' } }));
    expect(revoked).toMatchObject({ status: 'REVOKED', live: false, revokedBy: { legalName: 'Shalini Kapoor' }, revocationReason: 'back from leave' });
    expect(codeOf(await ap.call(G.revokeDelegation, { params: { delegationId: d.delegationId }, body: { reason: 'twice' } }))).toBe('EBMR-IAM-180');
  }, 120_000);
});

describe('the US electronic-signature certification over HTTP', () => {
  it('[DI-15] the process owner records the certification letter; the administrator and a GMP role holder cannot; a future date is refused; the kernel says a legal entity without a letter is blocked', async () => {
    const entity = `Batchwright Pharma ${randomUUID().slice(0, 6)} Pvt Ltd`;
    const body = { legalEntity: entity, letterRef: 'CERT-2026-001', submittedOn: '2026-03-02' };
    expect(codeOf(await admin.call(G.recordUsEsigCertification, { body }))).toBe('EBMR-IAM-040');
    expect(codeOf(await approver.call(G.recordUsEsigCertification, { body }))).toBe('EBMR-IAM-040');
    expect(codeOf(await approver.call(G.usEsigCertifications, { query: {} }))).toBe('ROLE_NOT_ALLOWED');
    expect(codeOf(await owner.call(G.recordUsEsigCertification, { body: { ...body, submittedOn: '2999-01-01' } }))).toBe('EBMR-IAM-170');
    const before = valueOf(await owner.call(G.usEsigCertifications, { query: { legalEntity: entity } }));
    expect(before.status).toMatchObject({ legalEntity: entity, onFile: false, blocking: before.mode === 'BLOCK' });
    const c = valueOf(await owner.call(G.recordUsEsigCertification, { body: { ...body, agencyAcknowledgementRef: 'ACK-77' } }));
    expect(c).toMatchObject({ legalEntity: entity, letterRef: 'CERT-2026-001', submittedOn: '2026-03-02', agencyAcknowledgementRef: 'ACK-77', recordedBy: { legalName: 'Omar Owner' } });
    const after = valueOf(await admin.call(G.usEsigCertifications, { query: { legalEntity: entity } }));
    expect(after.status).toMatchObject({ onFile: true, blocking: false });
    expect(after.certifications.some((x) => x.certificationId === c.certificationId)).toBe(true);
  }, 120_000);
});
