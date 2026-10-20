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

const receiptOnlyRoutes = {
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
export const RECEIPT_ROUTE_IDS = Object.values(receiptOnlyRoutes).map((r) => r.id);

/**
 * Phase 7 slice 7g (WP4, decision 0025): what is done with a material lot besides its receipt and release (site services
 * 0712, 0740, 0911): the witnessed destruction of a rejected, returned or recalled lot (the performer records it, a
 * witness other than the performer signs MATERIAL_DESTRUCTION_WITNESSED through the signable action
 * LOT_DESTRUCTION_WITNESS, then the performer destroys the lot with that signature: IN-24 (a)), a reservation cancelled
 * with the person's reason, a stock-location exception closed by QA with a deviation linked to the lot (PR-46), the OOS
 * record of an approved failing result (IN-20), and the vendor-history routes QA enabled and may disable with the reason
 * (IN-24 (c)). Every rule and right is the database's.
 */
export const LotHandlingView = z.strictObject({
  lotId: Uuid,
  destruction: z
    .strictObject({
      destructionId: Uuid,
      method: z.string(),
      reason: z.string(),
      quantity: DecimalString,
      unit: z.string(),
      performedBy: PersonRef,
      recordedAt: Instant,
    })
    .nullable(),
  /** The witness's valid MATERIAL_DESTRUCTION_WITNESSED signature on the lot as it is now, for the performer's destroy. */
  witness: z.strictObject({ signatureId: Uuid, signedBy: PersonRef }).nullable(),
  reservations: z.array(
    z.strictObject({
      reservationId: Uuid,
      batchNumber: z.string(),
      quantity: DecimalString,
      unit: z.string(),
      expiresAt: Instant,
      reservedBy: PersonRef,
      reservedAt: Instant,
      revoked: z.strictObject({ kind: z.string(), reason: z.string().nullable(), by: PersonRef, at: Instant }).nullable(),
    }),
  ),
  locationExceptions: z.array(
    z.strictObject({
      exceptionId: Uuid,
      problem: z.string(),
      raisedAt: Instant,
      resolved: z.strictObject({ deviationId: Uuid, note: z.string(), by: PersonRef, at: Instant }).nullable(),
    }),
  ),
});
export type LotHandlingView = z.infer<typeof LotHandlingView>;

export const VendorRouteView = z.strictObject({
  routeId: Uuid,
  siteCode: z.string(),
  materialCode: z.string(),
  justification: z.string(),
  statisticalReference: z.string(),
  proposedBy: PersonRef,
  proposedAt: Instant,
  enabled: z.strictObject({ by: PersonRef, at: Instant }).nullable(),
  disabled: z.strictObject({ reason: z.string(), by: PersonRef, at: Instant }).nullable(),
});
export type VendorRouteView = z.infer<typeof VendorRouteView>;

const PersonsReason = z.string().trim().min(1).max(2000);

export const lotHandlingRoutes = {
  lotHandling: defineRoute({
    id: 'quality.lotHandling',
    method: 'GET',
    path: '/api/lots/:lotId/handling',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'A lot\'s destruction record and witness signature, its reservations and its stock-location exceptions',
    params: lotParams,
    response: LotHandlingView,
  }),
  recordLotDestruction: defineRoute({
    id: 'quality.recordLotDestruction',
    method: 'POST',
    path: '/api/lots/:lotId/destruction',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Record the destruction of a rejected, returned or recalled lot with its method and the person\'s reason (MATERIAL.HANDLE); the recorder is its performer',
    params: lotParams,
    body: withAttribution({ method: z.string().trim().min(1).max(500), reason: PersonsReason }),
    response: LotHandlingView,
  }),
  destroyLot: defineRoute({
    id: 'quality.destroyLot',
    method: 'POST',
    path: '/api/lots/:lotId/destroy',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'The performer of the recorded destruction destroys the lot with the witness\'s MATERIAL_DESTRUCTION_WITNESSED signature (a witness other than the performer, IN-24)',
    params: lotParams,
    body: withAttribution({ expectedVersion: IntegerString, witnessSignatureId: Uuid }),
    response: LotHandlingView,
  }),
  // Phase 7 slice 7h (WP-A, gap report A1): stores reserve a released lot for a GMP batch (the batch named by its number).
  reserveLot: defineRoute({
    id: 'quality.reserveLot',
    method: 'POST',
    path: '/api/lots/:lotId/reservations',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Reserve a quantity of a released lot, in the lot\'s unit, for a batch named by its number, until a date no later than the lot\'s retest or expiry (MATERIAL.HANDLE; INV-13, PR-18)',
    params: lotParams,
    body: withAttribution({
      batchNumber: z.string().trim().min(1).max(64),
      quantity: DecimalString,
      /** The last day of the reservation (site date); by default 30 days, or the lot's retest or expiry when sooner. */
      expiresOn: z.iso.date().optional(),
    }),
    response: LotHandlingView,
  }),
  cancelReservation: defineRoute({
    id: 'quality.cancelReservation',
    method: 'POST',
    path: '/api/quality/reservations/:reservationId/cancel',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Cancel an open reservation of a lot with the person\'s own reason (MATERIAL.HANDLE; DI-22)',
    params: z.strictObject({ reservationId: Uuid }),
    body: withAttribution({ reason: PersonsReason }),
    response: LotHandlingView,
  }),
  resolveLotLocationException: defineRoute({
    id: 'quality.resolveLotLocationException',
    method: 'POST',
    path: '/api/quality/location-exceptions/:exceptionId/resolve',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'QA closes a stock-location exception of a lot with a deviation linked to the lot and what was done (MATERIAL.QA_DISPOSITION; PR-46)',
    params: z.strictObject({ exceptionId: Uuid }),
    body: withAttribution({ deviationId: Uuid, note: PersonsReason }),
    response: LotHandlingView,
  }),
  linkLotTestOos: defineRoute({
    id: 'quality.linkLotTestOos',
    method: 'POST',
    path: '/api/quality/lot-results/:resultId/oos',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Link the OOS record (a deviation-lite record of kind OOS linked to the lot) to an approved failing result (QC.RESULT_RECORD; IN-20)',
    params: z.strictObject({ resultId: Uuid }),
    body: withAttribution({ deviationId: Uuid }),
    response: z.strictObject({ resultId: Uuid, deviationId: Uuid }),
  }),
  vendorRoutes: defineRoute({
    id: 'quality.vendorRoutes',
    method: 'GET',
    path: '/api/quality/vendor-routes',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The vendor-history routes of excipients: proposed, enabled by QA with the signed justification, or disabled with the reason',
    response: z.strictObject({ routes: z.array(VendorRouteView) }),
  }),
  disableVendorRoute: defineRoute({
    id: 'quality.disableVendorRoute',
    method: 'POST',
    path: '/api/quality/vendor-routes/:routeId/disable',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'QA disables an enabled vendor-history route with the reason (MATERIAL.QA_DISPOSITION; IN-24 (c)); its lots need the identity test again',
    params: z.strictObject({ routeId: Uuid }),
    body: withAttribution({ reason: PersonsReason }),
    response: VendorRouteView,
  }),
  // Reprocessing proposals (recipe-core 0621, 0624; PR-47, IN-19): the quality unit then signs each (REPROCESSING_ACT).
  proposeReprocessingAuthorisation: defineRoute({
    id: 'quality.proposeReprocessingAuthorisation',
    method: 'POST',
    path: '/api/quality/reprocessing/authorisations',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Ask the quality unit to authorise a reprocessing or recovery step of a batch in execution, citing the investigation and the risk evaluation; one use of a closed container of an earlier batch when the step adds material (REPROCESSING.AUTHORISE)',
    body: withAttribution({
      batchId: Uuid,
      step: z.string().trim().min(1).max(200),
      containerId: Uuid.optional(),
      investigationRef: z.string().trim().min(1).max(200),
      riskEvaluationRef: z.string().trim().min(1).max(200),
    }),
    response: z.strictObject({ authorisationId: Uuid }),
  }),
  proposeReprocessingRequest: defineRoute({
    id: 'quality.proposeReprocessingRequest',
    method: 'POST',
    path: '/api/quality/reprocessing/requests',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Ask for the authorisation of a whole-batch reprocessing on a REPROCESSING master: its parent batches, the investigation and the stored risk evaluation (BATCH.ISSUE); the quality unit then signs it',
    body: withAttribution({
      familyId: Uuid,
      site: z.string().trim().min(1).max(16),
      parentBatchIds: z.array(Uuid).min(1).max(20),
      investigationRef: z.string().trim().min(1).max(200),
      riskEvaluationId: Uuid,
    }),
    response: z.strictObject({ requestId: Uuid }),
  }),
} as const;

/** Spread into `quality` by ns/quality.ts. */
export const receiptRoutes = { ...receiptOnlyRoutes, ...lotHandlingRoutes } as const;
