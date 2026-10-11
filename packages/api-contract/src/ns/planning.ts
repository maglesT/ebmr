/**
 * Namespace `planning` (Phase 3 slice 6, GMP): open ERP production orders of the session's site, each with the MBR
 * version effective for its product, strength and batch size, or the plain reason none matches. The plan itself is
 * `POST /api/batches` and the issue the GMP_BATCH_ISSUE signable action (unchanged); the database checks the order again
 * at issue (recipe.prepare_gmp_issue).
 */
import { z } from 'zod';
import { DecimalString, Uuid } from '../common.ts';
import { defineRoute } from '../route.ts';

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
    })
    .nullable(),
  /** Why no MBR matches (no effective version, no approved batch size of that quantity, BOM differs). */
  noMatch: z.string().nullable(),
  /** GMP batches already planned or issued for the order. */
  batches: z.array(z.strictObject({ batchId: Uuid, batchNumber: z.string(), status: z.string() })),
});
export type PlanningOrderView = z.infer<typeof PlanningOrderView>;

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
} as const;
