/**
 * Namespaces `support` and `contractGiver` (Phase 6 slice 6f, GMP; plan docs/build-plan/phase-6/phase-6-plan.md slice 6f).
 *
 * `support` (kernel 1202, DI-08): a vendor support engineer (an account holding VENDOR_SUPPORT) logs in only inside a
 * customer-approved, time-boxed grant. IT's administrator requests it for one named account; QA and IT approve it with
 * two signatures through the ceremony (signable action SUPPORT_ACT QA_APPROVE / IT_APPROVE, support_grant <grant id>);
 * the second one opens the window, which ends by itself. Any party may end it early.
 *
 * `contractGiver` (kernel 1204, recipe-core 1060, IN-30): QA grants the contract giver's reviewer (role
 * CONTRACT_GIVER_REVIEWER, read permissions only) a time-boxed read of the batches made under one loan licence. The
 * reviewer's own routes are the only ones its session reaches (bind.ts); every batch it opens is logged.
 */
import { z } from 'zod';
import { Instant, PersonRef, Uuid, withAttribution } from '../common.ts';
import { defineRoute } from '../route.ts';

const Text = (max: number) => z.string().trim().min(1).max(max);

export const SupportGrantState = z.enum(['PENDING', 'ACTIVE', 'ENDED', 'REVOKED']);

export const SupportGrantView = z.strictObject({
  grantId: Uuid,
  accountId: Uuid,
  loginName: z.string(),
  engineer: PersonRef,
  vendor: z.string(),
  purpose: z.string(),
  validHours: z.number().int().positive(),
  requestedBy: PersonRef,
  requestedAt: Instant,
  state: SupportGrantState,
  approvals: z.array(z.strictObject({ kind: z.enum(['QA', 'IT']), by: PersonRef, at: Instant, signatureId: Uuid })),
  /** The window, once both approvals are recorded. */
  validFrom: Instant.nullable(),
  validTo: Instant.nullable(),
  revocation: z.strictObject({ reason: z.string(), by: PersonRef, at: Instant }).nullable(),
  /** Support sessions opened under the grant. */
  sessions: z.number().int().nonnegative(),
});
export type SupportGrantView = z.infer<typeof SupportGrantView>;

export const SupportAccountView = z.strictObject({ accountId: Uuid, loginName: z.string(), engineer: PersonRef });
export type SupportAccountView = z.infer<typeof SupportAccountView>;

const grantParams = z.strictObject({ grantId: Uuid });

export const support = {
  grants: defineRoute({
    id: 'support.grants',
    method: 'GET',
    path: '/api/support/grants',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Vendor support grants, latest first, with their approvals, window and sessions (DI-08)',
    response: z.strictObject({ grants: z.array(SupportGrantView), accounts: z.array(SupportAccountView) }),
  }),
  requestGrant: defineRoute({
    id: 'support.requestGrant',
    method: 'POST',
    path: '/api/support/grants',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Request a time-boxed support grant for one named vendor support account (IT administrator; QA and IT then approve)',
    body: withAttribution({ accountId: Uuid, vendor: Text(200), purpose: Text(2000), hours: z.number().int().min(1).max(72) }),
    response: SupportGrantView,
  }),
  revokeGrant: defineRoute({
    id: 'support.revokeGrant',
    method: 'POST',
    path: '/api/support/grants/:grantId/revoke',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'End a pending or active support grant early (QA, IT); its support sessions end with it',
    params: grantParams,
    body: withAttribution({ reason: Text(2000) }),
    response: SupportGrantView,
  }),
} as const;

export const ContractGiverAccessView = z.strictObject({
  accessId: Uuid,
  loanLicenceId: Uuid,
  loanLicenceNumber: z.string(),
  holderName: z.string(),
  accountId: Uuid,
  loginName: z.string(),
  reviewer: PersonRef,
  validFrom: Instant,
  validTo: Instant,
  reason: z.string(),
  grantedBy: PersonRef,
  live: z.boolean(),
  reads: z.number().int().nonnegative(),
});
export type ContractGiverAccessView = z.infer<typeof ContractGiverAccessView>;

export const ContractGiverBatchView = z.strictObject({
  batchId: Uuid,
  batchNumber: z.string(),
  productCode: z.string().nullable(),
  productName: z.string().nullable(),
  status: z.string().nullable(),
  reviewState: z.string().nullable(),
  loanLicenceNumber: z.string(),
  hostLicenceNumber: z.string(),
  issuedAt: Instant,
  accessValidTo: Instant,
});
export type ContractGiverBatchView = z.infer<typeof ContractGiverBatchView>;

export const ContractGiverRecordView = ContractGiverBatchView.omit({ accessValidTo: true }).extend({
  batchSize: z.string(),
  technicalAgreement: z.string().nullable(),
  loanHolderName: z.string().nullable(),
  /** The stage summaries and steps of the record as executed, read-only. */
  stages: z.array(z.strictObject({ key: z.string(), name: z.string().nullable(), status: z.string().nullable() })),
  steps: z.array(z.strictObject({ key: z.string(), name: z.string().nullable(), status: z.string().nullable() })),
  values: z.array(z.strictObject({ item: z.string(), step: z.string(), value: z.string(), status: z.string() })),
  stateHash: z.string().nullable(),
});
export type ContractGiverRecordView = z.infer<typeof ContractGiverRecordView>;

const accessParams = z.strictObject({ accessId: Uuid });

export const contractGiver = {
  accesses: defineRoute({
    id: 'contractGiver.accesses',
    method: 'GET',
    path: '/api/contract-giver/accesses',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The contract givers\' read accesses, with their reads (QA; IN-30)',
    response: z.strictObject({ accesses: z.array(ContractGiverAccessView) }),
  }),
  grantAccess: defineRoute({
    id: 'contractGiver.grantAccess',
    method: 'POST',
    path: '/api/contract-giver/accesses',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Grant a reviewer account a time-boxed, read-only access to the batches of one loan licence (QA)',
    body: withAttribution({ loanLicenceId: Uuid, accountId: Uuid, validTo: z.iso.datetime({ offset: true }), reason: Text(2000) }),
    response: ContractGiverAccessView,
  }),
  revokeAccess: defineRoute({
    id: 'contractGiver.revokeAccess',
    method: 'POST',
    path: '/api/contract-giver/accesses/:accessId/revoke',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'End a contract-giver access early (QA)',
    params: accessParams,
    body: withAttribution({ reason: Text(2000) }),
    response: ContractGiverAccessView,
  }),
  batches: defineRoute({
    id: 'contractGiver.batches',
    method: 'GET',
    path: '/api/contract-giver/batches',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The reviewer\'s own view: the batches made under the loan licence of a live access (read-only)',
    response: z.strictObject({ batches: z.array(ContractGiverBatchView) }),
  }),
  batch: defineRoute({
    id: 'contractGiver.batch',
    method: 'GET',
    path: '/api/contract-giver/batches/:batchId',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'One batch record for the reviewer, read-only; the read is logged',
    params: z.strictObject({ batchId: Uuid }),
    response: ContractGiverRecordView,
  }),
} as const;
