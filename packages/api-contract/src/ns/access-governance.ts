/**
 * Namespace `accessGovernance` (Phase 7 slice 7g-5, decision 0025): the three acts of access governance that had a
 * database function and no route, so no screen. Every route runs the kernel's own `iam.*` function under the person's
 * named account, and the database decides every rule:
 *  - a permission is added to a role on request (the system administrator, IAM.ROLE_MANAGE; `iam.add_role_permission`)
 *    and in force only once a second person approves it (IAM.GRANT_APPROVE; `iam.decide_role_permission`; never the
 *    requester, never a holder of the role, and the role never combines administration and GMP permissions: INV-11,
 *    DI-16, DI-18); a removal (`iam.remove_role_permission`) takes authority away at once. A role's permissions are
 *    configuration (area ROLE_PERMISSION, kernel 1196): the approval and the removal are written under a change record
 *    QA approved (DI-09), named by its number;
 *  - a delegation of signing authority is requested by its delegator, who must hold signing authority
 *    (`iam.request_delegation`), and approved by someone who is neither the delegator, the delegate nor the requester
 *    (IAM.DELEGATION_APPROVE; `iam.decide_delegation`); it is revoked by its delegator or an approver
 *    (`iam.revoke_delegation`); nobody re-delegates what they hold only by delegation;
 *  - the legal entity's certification to the US agency that its electronic signatures are the legally binding
 *    equivalent of handwritten ones (21 CFR 11.100(c), paraphrased) is recorded with its letter reference and
 *    submission date (IAM.CERTIFICATION_RECORD; `iam.record_us_esig_certification`); the read says whether the policy
 *    blocks US-market work without one (`iam.us_esig_certification_status`).
 */
import { z } from 'zod';
import { Instant, PersonRef, Uuid, withAttribution } from '../common.ts';
import { defineRoute } from '../route.ts';
import { ChangeRecordNumber } from './config.ts';

const Text = (max: number) => z.string().trim().min(1).max(max);
const Code = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'a code of letters, digits, dot, underscore or hyphen');
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date as YYYY-MM-DD');
const Market = z.enum(['IN', 'US', 'EU']);

export const RolePermissionRequestStatus = z.enum(['REQUESTED', 'APPROVED', 'REJECTED']);

/** A request to add a permission to a role, with its decision. */
export const RolePermissionRequestView = z.strictObject({
  requestId: Uuid,
  roleCode: z.string(),
  permissionCode: z.string(),
  reason: z.string(),
  status: RolePermissionRequestStatus,
  requestedBy: PersonRef,
  requestedAt: Instant,
  decidedBy: PersonRef.nullable(),
  decidedAt: Instant.nullable(),
  decisionReason: z.string().nullable(),
});
export type RolePermissionRequestView = z.infer<typeof RolePermissionRequestView>;

/** The roles with the permissions they hold now, the permission catalogue and every request (open ones first). */
export const RolePermissionsView = z.strictObject({
  roles: z.array(
    z.strictObject({
      code: z.string(),
      name: z.string(),
      group: z.string(),
      accountKinds: z.array(z.string()),
      permissions: z.array(z.string()),
    }),
  ),
  permissions: z.array(z.strictObject({ code: z.string(), domain: z.string(), effect: z.string(), description: z.string() })),
  requests: z.array(RolePermissionRequestView),
});
export type RolePermissionsView = z.infer<typeof RolePermissionsView>;

export const DelegationStatus = z.enum(['REQUESTED', 'APPROVED', 'REJECTED', 'REVOKED']);

/** A delegation of signing authority (kernel 0170): who delegates which meanings to whom, where and until when. */
export const DelegationView = z.strictObject({
  delegationId: Uuid,
  delegator: PersonRef,
  delegate: PersonRef,
  scope: z.strictObject({ site: z.string().nullable(), area: z.string().nullable(), product: z.string().nullable() }),
  /** Empty: every market. */
  markets: z.array(Market),
  meanings: z.array(z.string()),
  validFrom: Instant,
  validTo: Instant,
  sopRef: z.string(),
  reason: z.string(),
  status: DelegationStatus,
  /** Approved, not revoked, and inside its window now. */
  live: z.boolean(),
  requestedBy: PersonRef,
  requestedAt: Instant,
  decidedBy: PersonRef.nullable(),
  decidedAt: Instant.nullable(),
  decisionReason: z.string().nullable(),
  revokedBy: PersonRef.nullable(),
  revokedAt: Instant.nullable(),
  revocationReason: z.string().nullable(),
});
export type DelegationView = z.infer<typeof DelegationView>;

/** A recorded US electronic-signature certification letter of a legal entity. */
export const UsEsigCertificationView = z.strictObject({
  certificationId: Uuid,
  legalEntity: z.string(),
  letterRef: z.string(),
  /** The date the letter was submitted (a calendar date, as written on it). */
  submittedOn: IsoDate,
  agencyAcknowledgementRef: z.string().nullable(),
  recordedBy: PersonRef,
  recordedAt: Instant,
});
export type UsEsigCertificationView = z.infer<typeof UsEsigCertificationView>;

const requestParams = z.strictObject({ requestId: Uuid });
const delegationParams = z.strictObject({ delegationId: Uuid });

export const accessGovernance = {
  rolePermissions: defineRoute({
    id: 'accessGovernance.rolePermissions',
    method: 'GET',
    path: '/api/admin/role-permissions',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: false,
    summary: 'The roles with the permissions they hold now, the permission catalogue and the requests to add one (administration roles)',
    response: RolePermissionsView,
  }),
  requestRolePermission: defineRoute({
    id: 'accessGovernance.requestRolePermission',
    method: 'POST',
    path: '/api/admin/role-permissions/requests',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Request that a permission be added to a role (IAM.ROLE_MANAGE); it is in force only once a second person approves it',
    body: withAttribution({ roleCode: Code, permissionCode: Code, reason: Text(2000) }),
    response: RolePermissionRequestView,
  }),
  decideRolePermission: defineRoute({
    id: 'accessGovernance.decideRolePermission',
    method: 'POST',
    path: '/api/admin/role-permissions/requests/:requestId/decision',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Approve or refuse a requested role permission (IAM.GRANT_APPROVE; never the requester, never a holder of the role)',
    params: requestParams,
    /** An approval writes the role's permission: it names the approved change record covering ROLE_PERMISSION (DI-09). */
    body: withAttribution({ approve: z.boolean(), reason: Text(2000), changeRecord: ChangeRecordNumber.optional() }),
    response: RolePermissionRequestView,
  }),
  removeRolePermission: defineRoute({
    id: 'accessGovernance.removeRolePermission',
    method: 'POST',
    path: '/api/admin/role-permissions/removal',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Remove a permission from a role at once (IAM.ROLE_MANAGE), under an approved change record covering ROLE_PERMISSION; taking authority away needs no second person',
    body: withAttribution({ roleCode: Code, permissionCode: Code, reason: Text(2000), changeRecord: ChangeRecordNumber }),
    response: RolePermissionsView,
  }),
  delegations: defineRoute({
    id: 'accessGovernance.delegations',
    method: 'GET',
    path: '/api/admin/delegations',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: false,
    summary: 'Delegations of signing authority: all of them for a role that approves delegations, otherwise the ones the person delegated, received or requested',
    response: z.strictObject({
      delegations: z.array(DelegationView),
      /** The signature meanings that may be delegated (the e-signature catalogue's delegable types). */
      meanings: z.array(z.strictObject({ code: z.string(), title: z.string() })),
      /** The session's role holds IAM.DELEGATION_APPROVE (display only: the database decides). */
      mayApprove: z.boolean(),
    }),
  }),
  requestDelegation: defineRoute({
    id: 'accessGovernance.requestDelegation',
    method: 'POST',
    path: '/api/admin/delegations',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'The delegator requests a delegation of signing authority to a named delegate (a holder of signing authority; a second person approves it)',
    body: withAttribution({
      /** The delegate's user ID; the database delegates to the person behind it, an active natural person. */
      delegateLoginName: z.string().trim().min(1).max(100),
      scope: z.strictObject({ site: Code.optional(), area: Code.optional(), product: Code.optional() }),
      markets: z.array(Market).max(3),
      meanings: z.array(Code).min(1).max(20),
      validFrom: z.iso.datetime({ offset: true }),
      validTo: z.iso.datetime({ offset: true }),
      sopRef: Text(200),
      reason: Text(2000),
    }),
    response: DelegationView,
  }),
  decideDelegation: defineRoute({
    id: 'accessGovernance.decideDelegation',
    method: 'POST',
    path: '/api/admin/delegations/:delegationId/decision',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Approve or refuse a requested delegation (IAM.DELEGATION_APPROVE; never the delegator, the delegate or the requester)',
    params: delegationParams,
    body: withAttribution({ approve: z.boolean(), reason: Text(2000) }),
    response: DelegationView,
  }),
  revokeDelegation: defineRoute({
    id: 'accessGovernance.revokeDelegation',
    method: 'POST',
    path: '/api/admin/delegations/:delegationId/revocation',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Revoke an approved delegation (its delegator, or a holder of IAM.DELEGATION_APPROVE)',
    params: delegationParams,
    body: withAttribution({ reason: Text(2000) }),
    response: DelegationView,
  }),
  usEsigCertifications: defineRoute({
    id: 'accessGovernance.usEsigCertifications',
    method: 'GET',
    path: '/api/admin/us-esig-certifications',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: false,
    summary: 'The US electronic-signature certification letters on file, the policy mode, and for a legal entity whether US-market work is blocked',
    query: z.strictObject({ legalEntity: z.string().trim().min(1).max(200).optional() }),
    response: z.strictObject({
      /** Policy esig.us_certification_mode: BLOCK refuses US-market batch issue without a letter on file, FLAG reports it. */
      mode: z.enum(['BLOCK', 'FLAG']),
      certifications: z.array(UsEsigCertificationView),
      status: z.strictObject({ legalEntity: z.string(), onFile: z.boolean(), blocking: z.boolean() }).nullable(),
    }),
  }),
  recordUsEsigCertification: defineRoute({
    id: 'accessGovernance.recordUsEsigCertification',
    method: 'POST',
    path: '/api/admin/us-esig-certifications',
    installation: 'ANY',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: "Record the legal entity's certification letter to the US agency on electronic signatures (IAM.CERTIFICATION_RECORD; not dated in the future)",
    body: withAttribution({
      legalEntity: Text(200),
      letterRef: Text(200),
      submittedOn: IsoDate,
      agencyAcknowledgementRef: Text(200).optional(),
    }),
    response: UsEsigCertificationView,
  }),
} as const;
