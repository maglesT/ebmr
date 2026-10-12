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
  /** Every output container of the processing batch, oldest first, each with why it cannot be issued now, or null. */
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
} as const;
