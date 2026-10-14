/**
 * Receipt routes of the `quality` namespace (Phase 6 slice 6a, builder A; additive; site services 0910 to 0915): the
 * approved-manufacturer register (PR-17 clause 3), a delivery received with its supplier batches (one lot each, PR-17
 * clause 2), the receipt record of a lot with its examination and corrections of WMS-captured values (PR-17 clause 4,
 * DI-31), and whether the lot may be issued (the database's issue gate). Every rule is the database's.
 *
 * The QA approval of a manufacturer is the signable action MATERIAL_SOURCE_ACT (MANUFACTURER_APPROVE, meaning
 * MANUFACTURER_APPROVED). Spread into `quality` by ns/quality.ts.
 */
import { z } from 'zod';
import { DecimalString, Instant, IntegerString, PersonRef, Uuid, withAttribution } from '../common.ts';
import { defineRoute } from '../route.ts';

const SourceCode = z.string().regex(/^[!-~]{1,64}$/, 'a code as the supplier or manufacturer writes it');
const MaterialCode = z.string().regex(/^[A-Z0-9][A-Z0-9/._-]{0,39}$/);
const lotParams = z.strictObject({ lotId: Uuid });
const approvedParams = z.strictObject({ approvedManufacturerId: Uuid });

export const ApprovedManufacturerState = z.enum(['PROPOSED', 'APPROVED', 'WITHDRAWN']);

/** One row of the approved-manufacturer register (site.approved_manufacturer and its approval and withdrawal). */
export const ApprovedManufacturerView = z.strictObject({
  approvedManufacturerId: Uuid,
  materialCode: z.string(),
  manufacturerCode: z.string(),
  manufacturerName: z.string(),
  manufacturingSite: z.string().nullable(),
  basis: z.string(),
  state: ApprovedManufacturerState,
  proposedBy: PersonRef,
  proposedAt: Instant,
  approvedBy: PersonRef.nullable(),
  approvedAt: Instant.nullable(),
  withdrawal: z.strictObject({ reason: z.string(), by: PersonRef, at: Instant }).nullable(),
});
export type ApprovedManufacturerView = z.infer<typeof ApprovedManufacturerView>;

/** The receipt record of a lot as it stands (site.lot_receipt_effective), its examination and what blocks its issue. */
export const LotReceiptView = z.strictObject({
  lotId: Uuid,
  lotCode: z.string(),
  materialCode: z.string(),
  deliveryId: z.string(),
  deliveryNoteName: z.string().nullable(),
  supplierCode: z.string(),
  supplierLot: z.string(),
  manufacturerCode: z.string(),
  containers: IntegerString,
  /** The quantity exactly as received (DI-31): decimal text and unit. */
  received: z.strictObject({ value: DecimalString, unit: z.string() }),
  source: z.enum(['MANUAL', 'INTERFACE']),
  /** The WMS message the receipt came in (INTERFACE). */
  inboundMessageId: Uuid.nullable(),
  manufacturerApprovedAtReceipt: z.boolean(),
  manufacturerApprovedNow: z.boolean(),
  examination: z.strictObject({ containersExamined: IntegerString, outcome: z.enum(['ACCEPTABLE', 'DEFECTS_FOUND']), remarks: z.string().nullable(), by: PersonRef, at: Instant }).nullable(),
  /** Corrections of interface-captured values: the original stays beside the corrected value (DI-31, DI-26). */
  corrections: z.array(z.strictObject({ field: z.string(), originalValue: z.string().nullable(), correctedValue: z.string(), reason: z.string(), by: PersonRef, at: Instant })),
  /** The WMS's last reported location of the lot. */
  location: z.strictObject({ location: z.string(), kind: z.string() }).nullable(),
  /** Why the lot cannot be issued now (the database's issue gate), or null. */
  issueProblem: z.string().nullable(),
});
export type LotReceiptView = z.infer<typeof LotReceiptView>;

export const SupplierBatchInput = z.strictObject({
  /** The internal lot code; the database numbers one (GR<yymmdd>-<n>) when none is given. */
  lotCode: MaterialCode.optional(),
  supplierLot: SourceCode,
  manufacturerCode: SourceCode,
  containers: z.string().regex(/^[1-9][0-9]{0,5}$/),
  quantity: z.strictObject({ value: DecimalString, unit: z.string().regex(/^[!-~]{1,32}$/) }),
  expiresAt: z.iso.datetime({ offset: true }),
  retestAt: z.iso.datetime({ offset: true }).optional(),
});

export const DeliveryReceivedView = z.strictObject({
  deliveryId: z.string(),
  lots: z.array(z.strictObject({ lotId: Uuid, lotCode: z.string(), supplierLot: z.string(), manufacturerCode: z.string(), manufacturerApproved: z.boolean() })),
});
export type DeliveryReceivedView = z.infer<typeof DeliveryReceivedView>;

export const receiptRoutes = {
  approvedManufacturers: defineRoute({
    id: 'quality.approvedManufacturers',
    method: 'GET',
    path: '/api/quality/approved-manufacturers',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The approved-manufacturer register of the site (PR-17), filtered by material',
    query: z.strictObject({ materialCode: MaterialCode.optional() }),
    response: z.strictObject({ manufacturers: z.array(ApprovedManufacturerView) }),
  }),
  proposeApprovedManufacturer: defineRoute({
    id: 'quality.proposeApprovedManufacturer',
    method: 'POST',
    path: '/api/quality/approved-manufacturers',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'QA proposes a manufacturer of a material with the basis of its approval; it takes effect once QA signs MANUFACTURER_APPROVED',
    body: withAttribution({
      materialCode: MaterialCode,
      manufacturerCode: SourceCode,
      manufacturerName: z.string().trim().min(1).max(200),
      manufacturingSite: z.string().trim().min(1).max(500).optional(),
      basis: z.string().trim().min(10).max(2000),
    }),
    response: ApprovedManufacturerView,
  }),
  withdrawManufacturerApproval: defineRoute({
    id: 'quality.withdrawManufacturerApproval',
    method: 'POST',
    path: '/api/quality/approved-manufacturers/:approvedManufacturerId/withdraw',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'QA withdraws a manufacturer\'s approval with the reason; its lots are no longer released or issued',
    params: approvedParams,
    body: withAttribution({ reason: z.string().trim().min(3).max(2000) }),
    response: ApprovedManufacturerView,
  }),
  receiveDelivery: defineRoute({
    id: 'quality.receiveDelivery',
    method: 'POST',
    path: '/api/quality/deliveries',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Stores receive a delivery: one lot in quarantine per supplier batch, each with its receipt record (PR-17)',
    body: withAttribution({
      deliveryId: SourceCode,
      materialCode: MaterialCode,
      supplierCode: SourceCode,
      deliveryNoteName: z.string().trim().min(1).max(500).optional(),
      remarks: z.string().trim().min(1).max(2000).optional(),
      supplierBatches: z.array(SupplierBatchInput).min(1).max(100),
    }),
    response: DeliveryReceivedView,
  }),
  lotReceipt: defineRoute({
    id: 'quality.lotReceipt',
    method: 'GET',
    path: '/api/lots/:lotId/receipt',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The receipt record of a lot, its examination, its corrections, its location and whether it may be issued',
    params: lotParams,
    response: LotReceiptView,
  }),
  recordLotReceipt: defineRoute({
    id: 'quality.recordLotReceipt',
    method: 'POST',
    path: '/api/lots/:lotId/receipt',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'The receipt record of a lot received without one (delivery, supplier, supplier batch, manufacturer, containers)',
    params: lotParams,
    body: withAttribution({
      deliveryId: SourceCode,
      supplierCode: SourceCode,
      supplierLot: SourceCode,
      manufacturerCode: SourceCode,
      containers: z.string().regex(/^[1-9][0-9]{0,5}$/),
      deliveryNoteName: z.string().trim().min(1).max(500).optional(),
      remarks: z.string().trim().min(1).max(2000).optional(),
    }),
    response: LotReceiptView,
  }),
  examineLotReceipt: defineRoute({
    id: 'quality.examineLotReceipt',
    method: 'POST',
    path: '/api/lots/:lotId/receipt/examination',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'The examiner records the examination of the lot\'s containers at receipt (labels, damage, seals, contamination)',
    params: lotParams,
    body: withAttribution({
      containersExamined: z.string().regex(/^[1-9][0-9]{0,5}$/),
      outcome: z.enum(['ACCEPTABLE', 'DEFECTS_FOUND']),
      remarks: z.string().trim().min(1).max(2000).optional(),
    }),
    response: LotReceiptView,
  }),
  correctLotReceipt: defineRoute({
    id: 'quality.correctLotReceipt',
    method: 'POST',
    path: '/api/lots/:lotId/receipt/corrections',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Correct a value the WMS sent for the receipt, with the person\'s reason; the original stays (DI-31)',
    params: lotParams,
    body: withAttribution({
      field: z.enum(['containers', 'supplierLot', 'manufacturerCode', 'deliveryNoteName']),
      value: z.string().trim().min(1).max(500),
      reason: z.string().trim().min(3).max(2000),
    }),
    response: LotReceiptView,
  }),
} as const;

/** The receipt routes' ids (each has an example in fixtures/receipt.json). */
export const RECEIPT_ROUTE_IDS = Object.values(receiptRoutes).map((r) => r.id);
