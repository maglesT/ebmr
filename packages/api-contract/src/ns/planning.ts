/**
 * Namespace `planning` (Phase 3 slice 6, GMP): open ERP production orders of the session's site, each with the MBR
 * version effective for its product, strength and batch size, or the plain reason none matches. The plan itself is
 * `POST /api/batches` and the issue the GMP_BATCH_ISSUE signable action (unchanged); the database checks the order again
 * at issue (recipe.prepare_gmp_issue).
 *
 * Phase 4 slice 2c: packaging orders. A packaging order is a GMP batch of a PACKAGING master that packs one issued
 * processing batch of the product (D-S4-2); it is planned with `POST /api/planning/packaging-orders` (its number is the
 * register's packaging number of that batch), issued like any batch, and takes bulk with `POST /api/batches/:id/bulk`
 * once QA released the processing batch for packing (H-PACK). Every reason shown (no release for packing yet, a
 * container that cannot be issued) is the database's own words (recipe-core 0762).
 */
import { z } from 'zod';
import { DecimalString, Instant, PersonRef, Uuid, withAttribution } from '../common.ts';
import { defineRoute } from '../route.ts';
import { PlannedBatchView } from './execution.ts';

/**
 * Phase 7 slice 7g (WP4, decision 0025): the site's batch-number allocation register (site services 0600; IN-18): every
 * number given, registered from outside or recovered after a restore, with its status; a number is never given again,
 * voided ones included. Registering an external number, voiding one (reason code and text) and recovering one in the
 * window a completed restore skipped are the issuer's acts (BATCH_NUMBER.*), each checked by the database.
 */
export const BatchNumberView = z.strictObject({
  allocationId: Uuid,
  batchNumber: z.string(),
  siteCode: z.string(),
  edition: z.string(),
  batchKind: z.enum(['PROCESSING', 'PACKAGING']),
  parentBatchNumber: z.string().nullable(),
  productCode: z.string(),
  productName: z.string(),
  batchSize: DecimalString,
  batchSizeUnit: z.string(),
  /** Site-local calendar date of the allocation (YYYY-MM-DD). */
  allocationDate: z.string(),
  source: z.enum(['GENERATED', 'EXTERNAL', 'RECOVERED_AFTER_RESTORE']),
  ruleCode: z.string().nullable(),
  serial: z.string().nullable(),
  externalReference: z.string().nullable(),
  status: z.enum(['ALLOCATED', 'VOIDED']),
  voidReasonCode: z.string().nullable(),
  voidReasonText: z.string().nullable(),
});
export type BatchNumberView = z.infer<typeof BatchNumberView>;

const BatchNumber = z.string().regex(/^[A-Z0-9][A-Z0-9/.-]{0,31}$/, '1-32 characters: capitals, digits, / . - (never changed for you)');
const numberIdentity = {
  productCode: z.string().trim().min(1).max(40),
  productName: z.string().trim().min(1).max(200),
  // API plan A1a: the API edition's code (kernel.edition_codes()); written out, the contract imports no kernel.
  edition: z.enum(['TABLETS', 'INJECTABLES', 'SUBSTANCE']),
  batchSize: DecimalString,
  batchSizeUnit: z.string().trim().min(1).max(20),
  parentBatchNumber: BatchNumber.optional(),
};

/**
 * Phase 7 slice 7h (WP-C, gap C1; IN-18): a numbering rule of the site (site.define_batch_number_rule, site services 0600):
 * the format of the numbers it gives (A-Z 0-9 / . - and the tokens {SITE} {PRODUCT} {YYYY} {YY} {MM} {SEQ:n} {PARENT}),
 * site-wide or for one product, for processing or packaging batches, from a date, with the person's reason. The site and
 * its zone are the session's; the database checks the right (BATCH_NUMBER.RULE_DEFINE) and every rule of the format.
 */
export const BatchNumberRuleView = z.strictObject({
  ruleId: Uuid,
  ruleCode: z.string(),
  siteCode: z.string(),
  productCode: z.string().nullable(),
  batchKind: z.enum(['PROCESSING', 'PACKAGING']),
  format: z.string(),
  siteZone: z.string(),
  effectiveFrom: Instant,
  reason: z.string(),
  definedBy: PersonRef,
  recordedAt: Instant,
});
export type BatchNumberRuleView = z.infer<typeof BatchNumberRuleView>;

/** A processing batch a packaging order may pack: issued, of the product, at the site (recipe-core 0582). */
export const PackagingParentView = z.strictObject({
  batchId: Uuid,
  batchNumber: z.string(),
  status: z.string(),
  /** Why QA has not released it for packing yet (H-PACK), or null: bulk is issued only then. */
  releaseForPackingProblem: z.string().nullable(),
  /** Its output containers usable now. */
  usableContainers: z.number().int().nonnegative(),
});
export type PackagingParentView = z.infer<typeof PackagingParentView>;

export const PlanningOrderView = z.strictObject({
  orderNo: z.string(),
  productCode: z.string(),
  strength: z.string(),
  productName: z.string().nullable(),
  batchSize: DecimalString,
  batchSizeUnit: z.string(),
  bom: z.array(z.strictObject({ materialCode: z.string(), quantity: DecimalString, unit: z.string() })),
  /** The matching effective MBR (family and version, the approved batch size it names), or null with `noMatch`. */
  match: z
    .strictObject({
      familyId: Uuid,
      familyCode: z.string(),
      versionId: Uuid,
      versionNumber: z.string(),
      batchSizeId: z.string(),
      markets: z.array(z.string()),
      /** PROCESSING, PACKAGING or REPROCESSING: a PACKAGING match plans a packaging order of one of `parents`. */
      recordKind: z.string(),
      /** A packaging family's pack type (D-P4-13), or null. */
      packType: z.string().nullable(),
      /** For a packaging match: the processing batches it may pack (newest first); otherwise empty. */
      parents: z.array(PackagingParentView),
    })
    .nullable(),
  /** Why no MBR matches (no effective version, no approved batch size of that quantity, BOM differs). */
  noMatch: z.string().nullable(),
  /** GMP batches already planned or issued for the order. */
  batches: z.array(z.strictObject({ batchId: Uuid, batchNumber: z.string(), status: z.string() })),
});
export type PlanningOrderView = z.infer<typeof PlanningOrderView>;

/** A packaging order of the site (planned or issued) with its processing batch and the bulk issued to it. */
export const PackagingOrderView = z.strictObject({
  batchId: Uuid,
  batchNumber: z.string(),
  status: z.string(),
  familyCode: z.string(),
  packType: z.string().nullable(),
  productCode: z.string(),
  strength: z.string(),
  line: z.string(),
  markets: z.array(z.string()),
  parentBatchId: Uuid.nullable(),
  parentBatchNumber: z.string().nullable(),
  /** Why the processing batch is not released for packing yet, or null. */
  releaseForPackingProblem: z.string().nullable(),
  /** Containers of bulk issued to the order. */
  bulkContainers: z.number().int().nonnegative(),
});
export type PackagingOrderView = z.infer<typeof PackagingOrderView>;

/** One packaging order for the bulk-issue screen (recipe-core 0762, recipe.packaging_order_bulk). */
export const PackagingBulkView = z.strictObject({
  batchId: Uuid,
  batchNumber: z.string(),
  status: z.string(),
  familyCode: z.string(),
  packType: z.string().nullable(),
  productCode: z.string(),
  strength: z.string(),
  line: z.string(),
  /** Why no bulk can be issued to the order now (it is not issued or running), or null. */
  orderProblem: z.string().nullable(),
  parent: z
    .strictObject({
      batchId: Uuid,
      batchNumber: z.string(),
      /** Why the processing batch is not released for packing (or not packable), or null. */
      releaseForPackingProblem: z.string().nullable(),
    })
    .nullable(),
  issued: z.array(z.strictObject({ label: z.string(), containerId: Uuid, quantity: DecimalString, unit: z.enum(['kg', 'g', 'units']), issuedBy: PersonRef, issuedAt: Instant })),
  /** The processing batch's bulk (its final output: its last stage's containers, never rejects; tablets 1770), oldest first, each with why it cannot be issued now, or null. */
  containers: z.array(
    z.strictObject({
      label: z.string(),
      containerId: Uuid,
      stage: z.string(),
      state: z.string(),
      netQuantity: DecimalString.nullable(),
      unit: z.enum(['kg', 'g', 'units']),
      issueProblem: z.string().nullable(),
    }),
  ),
  /** The finished lot posted for the order (site.finished_lot), or null: once posted it is shown, not offered again (R10 #12). */
  finishedLot: z.strictObject({ lotId: Uuid, lotCode: z.string() }).nullable(),
});
export type PackagingBulkView = z.infer<typeof PackagingBulkView>;

const orderParams = z.strictObject({ batchId: Uuid });

export const planning = {
  orders: defineRoute({
    id: 'planning.orders',
    method: 'GET',
    path: '/api/planning/orders',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Open ERP orders of the site with their matching effective MBR, or why none matches',
    response: z.strictObject({ orders: z.array(PlanningOrderView) }),
  }),
  packagingOrders: defineRoute({
    id: 'planning.packagingOrders',
    method: 'GET',
    path: '/api/planning/packaging-orders',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The packaging orders of the site with their processing batch, its release for packing and the bulk issued',
    response: z.strictObject({ orders: z.array(PackagingOrderView) }),
  }),
  planPackagingOrder: defineRoute({
    id: 'planning.planPackagingOrder',
    method: 'POST',
    path: '/api/planning/packaging-orders',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Plan a packaging order of an issued processing batch from the effective packaging MBR: the register\'s packaging number of that batch, pin and control recipe (issued once signed ISSUED)',
    body: withAttribution({
      familyId: Uuid,
      parentBatchId: Uuid,
      markets: z.array(z.string().min(1)).min(1),
      site: z.string().min(1),
      line: z.string().min(1),
      batchSize: z.string().min(1),
      /** The ERP order planned against (the oldest open one of the family's product and size when none is named). */
      erpOrder: z.string().min(1).max(64).optional(),
    }),
    response: PlannedBatchView,
  }),
  packagingBulk: defineRoute({
    id: 'planning.packagingBulk',
    method: 'GET',
    path: '/api/planning/packaging-orders/:batchId/bulk',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'A packaging order\'s bulk: its processing batch, the containers that can or cannot be issued (the database\'s reasons) and the bulk issued',
    params: orderParams,
    response: PackagingBulkView,
  }),
  // Phase 7 slice 7g (WP4): the batch-number register and the issuer's acts on it.
  batchNumbers: defineRoute({
    id: 'planning.batchNumbers',
    method: 'GET',
    path: '/api/planning/batch-numbers',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The batch-number allocation register of the session\'s site: every number given, registered or recovered, with its status (voided numbers stay listed and are never given again)',
    response: z.strictObject({ numbers: z.array(BatchNumberView) }),
  }),
  registerExternalBatchNumber: defineRoute({
    id: 'planning.registerExternalBatchNumber',
    method: 'POST',
    path: '/api/planning/batch-numbers/external',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Register a batch number issued outside the system (BATCH_NUMBER.REGISTER_EXTERNAL); a number already in the register, voided included, is refused',
    body: withAttribution({
      batchNumber: BatchNumber,
      batchKind: z.enum(['PROCESSING', 'PACKAGING']),
      externalReference: z.string().trim().min(1).max(200),
      ...numberIdentity,
    }),
    response: BatchNumberView,
  }),
  voidBatchNumber: defineRoute({
    id: 'planning.voidBatchNumber',
    method: 'POST',
    path: '/api/planning/batch-numbers/:allocationId/void',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Void a batch number of the register with a reason code and the person\'s text (BATCH_NUMBER.VOID); it stays in the register and is never given again',
    params: z.strictObject({ allocationId: Uuid }),
    body: withAttribution({ reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/, 'a reason code: capitals, digits and _'), reasonText: z.string().trim().min(1).max(2000) }),
    response: BatchNumberView,
  }),
  recoverBatchNumber: defineRoute({
    id: 'planning.recoverBatchNumber',
    method: 'POST',
    path: '/api/planning/batch-numbers/recovered',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Re-enter a number issued in the window a completed restore skipped, with the evidence that it was issued (BATCH_NUMBER.RECOVER); its serial must lie in the skipped range',
    body: withAttribution({
      restoreEventId: Uuid,
      ruleCode: z.string().trim().min(1).max(64),
      serial: z.string().regex(/^[1-9][0-9]{0,17}$/),
      batchNumber: BatchNumber,
      evidenceReference: z.string().trim().min(1).max(500),
      ...numberIdentity,
    }),
    response: BatchNumberView,
  }),
  // Phase 7 slice 7h (WP-C, gap C1): the site's numbering rules and the definition of one.
  batchNumberRules: defineRoute({
    id: 'planning.batchNumberRules',
    method: 'GET',
    path: '/api/planning/batch-number-rules',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The numbering rules of the session\'s site, each with its format, scope, kind and the date it takes effect',
    response: z.strictObject({ rules: z.array(BatchNumberRuleView) }),
  }),
  defineBatchNumberRule: defineRoute({
    id: 'planning.defineBatchNumberRule',
    method: 'POST',
    path: '/api/planning/batch-number-rules',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Define a numbering rule of the session\'s site (BATCH_NUMBER.RULE_DEFINE): its format with exactly one {SEQ:n}, site-wide or for a product, from now or a later date, with the reason',
    body: withAttribution({
      ruleCode: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{1,39}$/, '2-40 characters: capitals, digits, _ -'),
      productCode: z.string().regex(/^[A-Z0-9][A-Z0-9-]{0,31}$/).optional(),
      batchKind: z.enum(['PROCESSING', 'PACKAGING']),
      format: z.string().trim().min(1).max(64),
      effectiveFrom: z.iso.datetime({ offset: true }).optional(),
      reason: z.string().trim().min(1).max(2000),
    }),
    response: BatchNumberRuleView,
  }),
} as const;
