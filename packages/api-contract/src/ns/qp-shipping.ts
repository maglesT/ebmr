/**
 * Namespaces `qpPackage` and `erpShipping` (Phase 4 slice 4b, GMP): the EU QP batch package with the read-only,
 * time-boxed QP access, and the ERP shipping interlock (outline 4.6, 5.2.6, 5.2.9; plan docs/build-plan/phase-4/
 * phase-4-plan.md slice 4b). Every rule is the database's (kernel 1160: the package register and the QP access;
 * site services 0870: the interlock, INV-42).
 *
 * The package is assembled by the server (true-copy bundles of the processing and packaging records, the review, the
 * release and the deviations; documents for the audit-trail review summary, the post-entry change list, the per-market
 * deviation assessments and the CoA), registered with its SHA-256 (the database computes it again) and issued by QA's
 * signature: signable action QP_PACKAGE_ACT ISSUE, qp_package <package id>, TRUE_COPY_VERIFIED (signable.ts).
 *
 * The QP's routes (/api/qp/*) answer only an account holding the EU_QP_READER role and read permissions only, inside a
 * live access to the lot. The ERP routes (/api/erp/shipments*) are the ERP stub's: it authenticates with its service
 * identity in the body (DEMO stub, like quality.erpImport) and asks before it ships.
 */
import { z } from 'zod';
import { Instant, PersonRef, Uuid } from '../common.ts';
import { defineRoute } from '../route.ts';

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const lotParams = z.strictObject({ lotId: Uuid });
const packageParams = z.strictObject({ packageId: Uuid });
const accessParams = z.strictObject({ accessId: Uuid });

export const QpSectionRole = z.enum(['PROCESSING_RECORD', 'PACKAGING_RECORD', 'AUDIT_TRAIL_REVIEW', 'POST_ENTRY_CHANGES', 'DEVIATIONS', 'RELEASE', 'COA', 'OTHER']);

export const QpSectionView = z.strictObject({
  name: z.string().min(1).max(100),
  role: QpSectionRole,
  kind: z.enum(['TRUE_COPY', 'DOCUMENT']),
  title: z.string().min(1),
  /** The audit chain of a true copy (e.g. batch:<id>); null for a document. */
  chainKey: z.string().nullable(),
  sha256: Sha256,
  bytes: z.number().int().nonnegative(),
});
export type QpSectionView = z.infer<typeof QpSectionView>;

export const QpPackageView = z.strictObject({
  packageId: Uuid,
  lotId: Uuid,
  label: z.string().min(1),
  /** ASSEMBLED until QA's TRUE_COPY_VERIFIED signature issues it. */
  state: z.enum(['ASSEMBLED', 'ISSUED']),
  /** SHA-256 of the package manifest, computed by the server and again by the database. */
  packageSha256: Sha256,
  contentBytes: z.number().int().positive(),
  sections: z.array(QpSectionView),
  assembledBy: PersonRef,
  assembledAt: Instant,
  issuedBy: PersonRef.nullable(),
  issuedAt: Instant.nullable(),
  signatureId: Uuid.nullable(),
});
export type QpPackageView = z.infer<typeof QpPackageView>;

export const QpAccessView = z.strictObject({
  accessId: Uuid,
  lotId: Uuid,
  qp: PersonRef,
  accountId: Uuid,
  validFrom: Instant,
  validTo: Instant,
  reason: z.string(),
  grantedBy: PersonRef,
  /** LIVE inside its window, EXPIRED after it, REVOKED when ended early. */
  state: z.enum(['LIVE', 'EXPIRED', 'REVOKED']),
  reads: z.number().int().nonnegative(),
});
export type QpAccessView = z.infer<typeof QpAccessView>;

export const LotQpView = z.strictObject({
  lotId: Uuid,
  /** Why a package cannot be assembled now (EU not in the set, no manufacturer release); empty when it can. */
  assembleProblems: z.array(z.string()),
  packages: z.array(QpPackageView),
  accesses: z.array(QpAccessView),
});
export type LotQpView = z.infer<typeof LotQpView>;

export const QpReaderPackageView = z.strictObject({
  packageId: Uuid,
  lotId: Uuid,
  label: z.string().min(1),
  packageSha256: Sha256,
  contentBytes: z.number().int().positive(),
  issuedAt: Instant,
  accessValidTo: Instant,
});
export type QpReaderPackageView = z.infer<typeof QpReaderPackageView>;

export const QpPackageFileView = z.strictObject({
  packageId: Uuid,
  packageSha256: Sha256,
  contentSha256: Sha256,
  /** The package file (ebmr.qp-batch-package/1): verify offline with the kernel's package verifier. */
  content: z.string().min(1),
});
export type QpPackageFileView = z.infer<typeof QpPackageFileView>;

export const ShipmentMarket = z.enum(['IN', 'US', 'EU']);

const ErpCredentials = {
  loginName: z.string().min(1).max(128),
  serviceKey: z.string().min(1).max(512),
  fingerprint: z.string().min(1).max(256),
};

export const ShipmentRequest = z.strictObject({
  lotId: Uuid,
  market: ShipmentMarket,
  consigneeCode: z.string().regex(/^[A-Z0-9][A-Z0-9-]{1,31}$/),
  consigneeName: z.string().trim().min(1).max(200),
  /** Exact decimal as text. */
  quantity: z.string().regex(/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,9})?$/),
  unit: z.string().regex(/^[!-~]{1,32}$/),
  quarantine: z.boolean(),
});
export type ShipmentRequest = z.infer<typeof ShipmentRequest>;

export const ShipmentCheckView = z.strictObject({
  allowed: z.boolean(),
  /** The interlock's reasons, in the database's words (INV-42). */
  problems: z.array(z.string()),
});
export type ShipmentCheckView = z.infer<typeof ShipmentCheckView>;

export const ShipmentView = z.strictObject({
  shipmentId: Uuid,
  shipmentNo: z.string().min(1),
  lotId: Uuid,
  market: ShipmentMarket,
  consigneeCode: z.string(),
  consigneeName: z.string(),
  quantity: z.string(),
  unit: z.string(),
  quarantine: z.boolean(),
  /** The states the interlock saw when it let the shipment through. */
  manufacturerState: z.string(),
  dispositionState: z.string(),
  euImporterId: Uuid.nullable(),
  erpReference: z.string(),
  recordedAt: Instant,
});
export type ShipmentView = z.infer<typeof ShipmentView>;

export const qpPackage = {
  lot: defineRoute({
    id: 'qpPackage.lot',
    method: 'GET',
    path: '/api/qp-package/lots/:lotId',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The EU QP batch packages of a finished lot and the QP accesses to them',
    params: lotParams,
    response: LotQpView,
  }),
  assemble: defineRoute({
    id: 'qpPackage.assemble',
    method: 'POST',
    path: '/api/qp-package/lots/:lotId/packages',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'QA assembles the EU QP batch package of a released lot (true copies registered, hash computed and stored); QA then signs it to issue it',
    params: lotParams,
    body: z.strictObject({}),
    response: QpPackageView,
  }),
  grantAccess: defineRoute({
    id: 'qpPackage.grantAccess',
    method: 'POST',
    path: '/api/qp-package/packages/:packageId/accesses',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'QA grants a QP account read-only access to the issued packages of this lot until a time (one lot at a time)',
    params: packageParams,
    body: z.strictObject({ accountId: Uuid, validToUs: z.string().regex(/^[1-9][0-9]{0,17}$/), reason: z.string().trim().min(1).max(500) }),
    response: QpAccessView,
  }),
  revokeAccess: defineRoute({
    id: 'qpPackage.revokeAccess',
    method: 'POST',
    path: '/api/qp-package/accesses/:accessId/revocation',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'QA ends a QP access early, with the reason',
    params: accessParams,
    body: z.strictObject({ reason: z.string().trim().min(1).max(500) }),
    response: QpAccessView,
  }),
  readerPackages: defineRoute({
    id: 'qpPackage.readerPackages',
    method: 'GET',
    path: '/api/qp/packages',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The QP\'s own view: the issued packages of the lot a live access names',
    response: z.strictObject({ packages: z.array(QpReaderPackageView) }),
  }),
  readerFile: defineRoute({
    id: 'qpPackage.readerFile',
    method: 'GET',
    path: '/api/qp/packages/:packageId',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The QP downloads one issued package (each read is logged)',
    params: packageParams,
    response: QpPackageFileView,
  }),
} as const;

export const erpShipping = {
  check: defineRoute({
    id: 'erpShipping.check',
    method: 'POST',
    path: '/api/erp/shipments/check',
    installation: 'GMP',
    auth: 'NONE',
    mutating: false,
    idempotency: 'NONE',
    summary: 'The ERP asks before it ships: may this lot go to this consignee for this market now? (INV-42; DEMO stub)',
    body: z.strictObject({ ...ErpCredentials, shipment: ShipmentRequest }),
    response: ShipmentCheckView,
  }),
  record: defineRoute({
    id: 'erpShipping.record',
    method: 'POST',
    path: '/api/erp/shipments',
    installation: 'GMP',
    auth: 'NONE',
    mutating: true,
    idempotency: 'NONE',
    summary: 'The ERP records a shipment; the database refuses it unless the interlock lets it through (INV-42; DEMO stub)',
    body: z.strictObject({
      ...ErpCredentials,
      shipment: ShipmentRequest.extend({ shipmentNo: z.string().regex(/^[A-Z0-9][A-Z0-9/._-]{0,39}$/), erpReference: z.string().trim().min(1).max(64) }),
    }),
    response: ShipmentView,
  }),
  lot: defineRoute({
    id: 'erpShipping.lot',
    method: 'GET',
    path: '/api/erp/lots/:lotId/shipments',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The shipments of a finished lot, with the states the interlock saw',
    params: lotParams,
    response: z.strictObject({ shipments: z.array(ShipmentView) }),
  }),
} as const;
