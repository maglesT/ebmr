/**
 * Identity administration (DI-14..DI-21). Thin typed wrappers over the iam.* SQL functions. Each
 * runs inside a command (withCommand / withGuardedCommand) whose actor holds the permission the
 * function requires; the database enforces every rule (segregation, requester is not approver,
 * nobody administers themselves, identity verified before activation and before credentials).
 * Functions that change an existing row need a reason code in the actor context (audit rule).
 */
import type pg from 'pg';
import type { Scope } from './authority.ts';
import { IdentityError } from './errors.ts';
import { generateSecret, hashSecret, readSecretPolicy, type SecretKind } from './secrets.ts';
import type { DeviceClass } from './sessions.ts';

export type PersonKind = 'NATURAL' | 'SYSTEM';
export type AccountKind = 'HUMAN' | 'SERVICE' | 'INTEGRATION' | 'READONLY_DISPLAY';

async function scalar<T>(client: pg.PoolClient, sql: string, params: unknown[]): Promise<T> {
  const { rows } = await client.query<{ v: T }>(sql, params);
  const row = rows[0];
  if (!row) throw new IdentityError('EBMR-IAM-004', 'the database returned no value');
  return row.v;
}

export function createPerson(client: pg.PoolClient, kind: PersonKind, legalName: string, employeeRef?: string): Promise<string> {
  return scalar(client, 'select iam.create_person($1, $2, $3) as v', [kind, legalName, employeeRef ?? null]);
}

export function renamePerson(client: pg.PoolClient, personId: string, legalName: string): Promise<void> {
  return scalar(client, 'select iam.rename_person($1, $2) as v', [personId, legalName]);
}

export interface IdentityVerificationInput {
  personId: string;
  purpose: 'INITIAL' | 'REHIRE' | 'BADGE_REPLACEMENT' | 'CREDENTIAL_RECOVERY' | 'PERIODIC';
  method: 'IN_PERSON_DOCUMENT' | 'HR_ONBOARDING_RECORD' | 'VIDEO_WITH_DOCUMENT';
  documentType: string;
  evidenceRef: string;
  /** When the check took place (ISO instant); stored as a user-claimed time beside the server time. */
  occurredAt: string;
}

export function recordIdentityVerification(client: pg.PoolClient, v: IdentityVerificationInput): Promise<string> {
  return scalar(client, 'select iam.record_identity_verification($1, $2, $3, $4, $5, $6::timestamptz) as v', [
    v.personId,
    v.purpose,
    v.method,
    v.documentType,
    v.evidenceRef,
    v.occurredAt,
  ]);
}

export interface AccountInput {
  personId: string;
  loginName: string;
  kind: AccountKind;
  generic?: boolean;
  breakGlass?: boolean;
}

export function createAccount(client: pg.PoolClient, a: AccountInput): Promise<string> {
  return scalar(client, 'select iam.create_account($1, $2, $3, $4, $5) as v', [a.personId, a.loginName, a.kind, a.generic ?? false, a.breakGlass ?? false]);
}

export function activateAccount(client: pg.PoolClient, accountId: string): Promise<void> {
  return scalar(client, 'select iam.activate_account($1) as v', [accountId]);
}

export function deactivateAccount(client: pg.PoolClient, accountId: string, reason: string): Promise<void> {
  return scalar(client, 'select iam.deactivate_account($1, $2) as v', [accountId, reason]);
}

export function processLeaver(client: pg.PoolClient, personId: string, reason: string): Promise<void> {
  return scalar(client, 'select iam.process_leaver($1, $2) as v', [personId, reason]);
}

export interface GrantRequest {
  accountId: string;
  roleCode: string;
  scope?: Scope;
  validFrom?: string;
  validTo?: string;
  reason: string;
}

export function requestRoleGrant(client: pg.PoolClient, g: GrantRequest): Promise<string> {
  return scalar(client, 'select iam.request_role_grant($1, $2, $3::jsonb, $4::timestamptz, $5::timestamptz, $6) as v', [
    g.accountId,
    g.roleCode,
    JSON.stringify(g.scope ?? {}),
    g.validFrom ?? null,
    g.validTo ?? null,
    g.reason,
  ]);
}

export function decideRoleGrant(client: pg.PoolClient, grantId: string, approve: boolean, reason: string): Promise<void> {
  return scalar(client, 'select iam.decide_role_grant($1, $2, $3) as v', [grantId, approve, reason]);
}

export function revokeRoleGrant(client: pg.PoolClient, grantId: string, reason: string): Promise<void> {
  return scalar(client, 'select iam.revoke_role_grant($1, $2) as v', [grantId, reason]);
}

export interface RolePermissionRequest {
  roleCode: string;
  permission: string;
  /** Defaults to the reason text of the command. */
  reason?: string;
}

/**
 * Request that a permission be added to a role (IAM.ROLE_MANAGE). It takes effect only when a second
 * person approves it with decideRolePermission (IAM.GRANT_APPROVE); neither may hold the role.
 * Returns the request id.
 */
export function requestRolePermission(client: pg.PoolClient, r: RolePermissionRequest): Promise<string> {
  return scalar(client, 'select iam.add_role_permission($1, $2, $3) as v', [r.roleCode, r.permission, r.reason ?? null]);
}

export function decideRolePermission(client: pg.PoolClient, requestId: string, approve: boolean, reason: string): Promise<void> {
  return scalar(client, 'select iam.decide_role_permission($1, $2, $3) as v', [requestId, approve, reason]);
}

/** Remove a permission from a role (IAM.ROLE_MANAGE); effective at once, like a revocation. */
export function removeRolePermission(client: pg.PoolClient, roleCode: string, permission: string): Promise<void> {
  return scalar(client, 'select iam.remove_role_permission($1, $2) as v', [roleCode, permission]);
}

export interface DeviceInput {
  code: string;
  deviceClass: DeviceClass;
  site: string;
  room?: string;
  line?: string;
  fingerprint: string;
  description: string;
}

export function registerDevice(client: pg.PoolClient, d: DeviceInput): Promise<string> {
  return scalar(client, 'select iam.register_device($1, $2, $3, $4, $5, $6, $7) as v', [
    d.code,
    d.deviceClass,
    d.site,
    d.room ?? null,
    d.line ?? null,
    d.fingerprint,
    d.description,
  ]);
}

export function setDeviceStatus(client: pg.PoolClient, deviceId: string, status: 'ACTIVE' | 'BLOCKED' | 'DECOMMISSIONED', reason: string): Promise<void> {
  return scalar(client, 'select iam.set_device_status($1, $2, $3) as v', [deviceId, status, reason]);
}

/**
 * Issue an initial or reset secret (administrator action). The service generates the secret and
 * stores only its argon2id verifier; the plaintext is returned for delivery to the account owner
 * through a channel the administrator cannot read (sealed letter, the owner's enrolment session).
 * It is single-use and must be changed before the account can sign.
 */
export async function issueInitialSecret(client: pg.PoolClient, accountId: string, kind: SecretKind): Promise<{ credentialId: string; secret: string }> {
  const policy = await readSecretPolicy(client);
  const secret = generateSecret(kind, policy);
  const credentialId = await scalar<string>(client, 'select iam.issue_credential($1, $2, $3) as v', [accountId, kind, await hashSecret(secret)]);
  return { credentialId, secret };
}

export interface BadgeInput {
  accountId: string;
  uid: string;
  technology: string;
  label: string;
  identityVerificationId: string;
  replacesBadgeId?: string;
}

export function issueBadge(client: pg.PoolClient, b: BadgeInput): Promise<string> {
  return scalar(client, 'select iam.issue_badge($1, $2, $3, $4, $5, $6) as v', [
    b.accountId,
    b.uid,
    b.technology,
    b.label,
    b.identityVerificationId,
    b.replacesBadgeId ?? null,
  ]);
}

export function recordBadgeTest(client: pg.PoolClient, badgeId: string, kind: 'AT_ISSUE' | 'PERIODIC', result: 'PASS' | 'FAIL', notes?: string): Promise<string> {
  return scalar(client, 'select iam.record_badge_test($1, $2, $3, $4) as v', [badgeId, kind, result, notes ?? null]);
}

export function activateBadge(client: pg.PoolClient, badgeId: string): Promise<void> {
  return scalar(client, 'select iam.activate_badge($1) as v', [badgeId]);
}

export function acknowledgeEsigPolicy(client: pg.PoolClient, initials?: string): Promise<string> {
  return scalar(client, 'select iam.acknowledge_esig_policy($1) as v', [initials ?? null]);
}

export function recordQualification(
  client: pg.PoolClient,
  q: { personId: string; qualification: string; validFrom: string; validTo?: string; source?: string; sourceRef?: string },
): Promise<string> {
  return scalar(client, 'select iam.record_qualification($1, $2, $3::timestamptz, $4::timestamptz, $5, $6) as v', [
    q.personId,
    q.qualification,
    q.validFrom,
    q.validTo ?? null,
    q.source ?? 'INTERNAL',
    q.sourceRef ?? null,
  ]);
}

export function setPolicy(client: pg.PoolClient, key: string, value: string, reason: string): Promise<void> {
  return scalar(client, 'select iam.set_policy($1, $2, $3) as v', [key, value, reason]);
}
