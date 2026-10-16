/**
 * Namespace `genealogy` (Phase 6 slice 6d-0, GMP; PR-57, IN-07, IN-29, PR-50, PR-49; recipe-core 1010 to 1012, site
 * services 0960, 0961): the genealogy explorer's trace, the complaint-to-lot lookup, the API supply-chain report of a
 * finished lot, the deviation impact query and the recurrence warning of the certification screen.
 *
 * Read-only. Every value is the database's: the trace is recipe.genealogy(kind, id, direction, as_of) over the
 * insert-only rows each business event wrote (D-P6d-1); "parent" is the node the traversal came from (in a BACKWARD
 * trace the downstream end of the edge, D-P6d-0-2); depth is the node's fewest steps from the start. The as-of point is
 * epoch microseconds as text (null: now); a trace repeated as of the same instant gives the same set. Quantities are
 * decimal text, never numbers.
 */
import { z } from 'zod';
import { DecimalString, EpochMicros, Instant, Uuid } from '../common.ts';
import { defineRoute } from '../route.ts';

/** TRANSFER (Phase 6 slice 6i, additive): a lot-transfer package between two site installations; the same node at both sites. */
export const GenealogyNodeKind = z.enum(['LOT', 'BATCH', 'CONTAINER', 'SHIPMENT', 'TRANSFER']);
export type GenealogyNodeKind = z.infer<typeof GenealogyNodeKind>;
export const GenealogyEdgeKind = z.enum([
  'CONSUMED', 'RETURNED', 'RECOVERED', 'SHIPPED', 'OUTPUT', 'MERGED', 'BULK_ISSUE', 'CHARGED', 'REPROCESSED',
  'REPROCESSING_ADDITION', 'RECOVERY_ADDITION', 'PACKAGING_ORDER', 'FINISHED',
  // Phase 6 slice 6i (recipe-core 1090): the lot left in a sealed package; the package became the receiving site's lot.
  'TRANSFERRED', 'TRANSFER_RECEIVED',
]);
export type GenealogyEdgeKind = z.infer<typeof GenealogyEdgeKind>;
export const GenealogyDirection = z.enum(['FORWARD', 'BACKWARD']);
export type GenealogyDirection = z.infer<typeof GenealogyDirection>;

/** One node with what the explorer shows of it (the lot number, batch number, container label or shipment number). */
export const GenealogyNodeView = z.strictObject({
  kind: GenealogyNodeKind,
  id: Uuid,
  label: z.string().min(1),
  /** The product (finished lots, batches, containers, shipments) or material code (other lots). */
  code: z.string().nullable(),
  name: z.string().nullable(),
  /** LOT: the material kind (API, EXCIPIENT, ..., FINISHED, RETURNED); BATCH: PROCESSING or PACKAGING; else null. */
  subKind: z.string().nullable(),
  /**
   * LOT: the lot state; BATCH: the record status; CONTAINER: the container state; SHIPMENT: the consignee code; TRANSFER:
   * SEALED (outbound) or the receipt's RECEIVED, ACCEPTED or REFUSED (inbound). A TRANSFER's label is the package number,
   * its code the origin installation, its name the destination installation and its subKind OUTBOUND or INBOUND.
   */
  state: z.string().nullable(),
});
export type GenealogyNodeView = z.infer<typeof GenealogyNodeView>;

export const GenealogyNodeRef = z.strictObject({ kind: GenealogyNodeKind, id: Uuid });

/** One row of recipe.genealogy: the node reached, the node it was reached from, the edge's kind and the node's depth. */
export const GenealogyEdgeView = z.strictObject({
  node: GenealogyNodeRef,
  parent: GenealogyNodeRef.nullable(),
  edgeKind: GenealogyEdgeKind.nullable(),
  depth: z.number().int().nonnegative(),
});
export type GenealogyEdgeView = z.infer<typeof GenealogyEdgeView>;

export const GenealogyTraceView = z.strictObject({
  start: GenealogyNodeView,
  direction: GenealogyDirection,
  asOf: Instant,
  nodes: z.array(GenealogyNodeView),
  edges: z.array(GenealogyEdgeView),
  counts: z.strictObject({
    lots: z.number().int().nonnegative(),
    batches: z.number().int().nonnegative(),
    containers: z.number().int().nonnegative(),
    shipments: z.number().int().nonnegative(),
    /** Phase 6 slice 6i (additive): the TRANSFER nodes. */
    transfers: z.number().int().nonnegative().optional(),
  }),
});
export type GenealogyTraceView = z.infer<typeof GenealogyTraceView>;

/**
 * One other site's part of a federated trace (Phase 6 slice 6i; D-P6i-0-7): the excerpt the installation at the other end
 * of a transfer answered, sealed by its key, from that TRANSFER node in the same direction. ANSWERED: as of the instant
 * asked. UNREACHABLE, REFUSED or WRONG_ANSWER: the last excerpt received before (its own, older as-of) or none; the
 * result is then incomplete. NOT_REGISTERED: the other installation is no longer a trusted peer.
 */
export const FederatedPartStatus = z.enum(['ANSWERED', 'UNREACHABLE', 'REFUSED', 'WRONG_ANSWER', 'NOT_REGISTERED']);
export type FederatedPartStatus = z.infer<typeof FederatedPartStatus>;
export const FederatedPartView = z.strictObject({
  transferId: Uuid,
  packageNo: z.string().min(1),
  peer: z.string().min(1),
  status: FederatedPartStatus,
  askedAsOf: Instant,
  /** The as-of point of the excerpt shown: the one asked when ANSWERED, an earlier one otherwise; null when none was ever received. */
  excerptAsOf: Instant.nullable(),
  detail: z.string().nullable(),
  nodes: z.array(GenealogyNodeView),
  edges: z.array(GenealogyEdgeView),
});
export type FederatedPartView = z.infer<typeof FederatedPartView>;
export const FederatedTraceView = z.strictObject({
  local: GenealogyTraceView,
  remote: z.array(FederatedPartView),
  /** True only when every transfer reached has an ANSWERED part and no part reaches a further transfer. */
  complete: z.boolean(),
  /** Transfers the other sites' excerpts reach that this site does not ask (one hop, D-P6i-0-7). */
  beyondOneHop: z.array(z.strictObject({ transferId: Uuid, packageNo: z.string().min(1), peer: z.string().min(1) })),
});
export type FederatedTraceView = z.infer<typeof FederatedTraceView>;

/** One distribution record (site.erp_shipment with the 6d fields; PR-57). */
export const DistributionRecordView = z.strictObject({
  shipmentId: Uuid,
  shipmentNo: z.string().min(1),
  lotId: Uuid,
  lotCode: z.string().min(1),
  productName: z.string().nullable(),
  strength: z.string().nullable(),
  dosageForm: z.string().nullable(),
  market: z.enum(['IN', 'US', 'EU']),
  consigneeCode: z.string().min(1),
  consigneeName: z.string().min(1),
  consigneeAddress: z.string().nullable(),
  quantity: DecimalString,
  unit: z.string().min(1),
  shippedAt: Instant,
  /** False for a record without the consignee's address (the Phase 4 ERP stub route; D-P6d-0-7). */
  complete: z.boolean(),
});
export type DistributionRecordView = z.infer<typeof DistributionRecordView>;

export const LookupDeviationView = z.strictObject({
  deviationId: Uuid,
  ref: z.string().min(1),
  kind: z.string().min(1),
  title: z.string().min(1),
  classification: z.string().min(1),
  state: z.string().min(1),
});
export type LookupDeviationView = z.infer<typeof LookupDeviationView>;

/** The complaint-to-lot lookup: the lot a complaint names, its record, genealogy both ways, deviations and shipments. */
export const ComplaintLookupView = z.strictObject({
  query: z.string().min(1),
  lot: GenealogyNodeView,
  /** The batches whose records make the lot (its packaging batch and the processing batch it packs). */
  batches: z.array(GenealogyNodeView),
  deviations: z.array(LookupDeviationView),
  shipments: z.array(DistributionRecordView),
  /** Every lot upstream of it (components, intermediates, returned goods) and downstream (returns, recovered material). */
  upstreamLots: z.array(GenealogyNodeView),
  downstreamLots: z.array(GenealogyNodeView),
});
export type ComplaintLookupView = z.infer<typeof ComplaintLookupView>;

/** A purchased or recovered lot upstream of a finished lot, with its supplier chain (the receipt record, PR-17). */
export const SupplyChainLineView = z.strictObject({
  lot: GenealogyNodeView,
  depth: z.number().int().positive(),
  supplier: z.string().nullable(),
  supplierLot: z.string().nullable(),
  manufacturerCode: z.string().nullable(),
  /** The batch numbers that consumed the lot on the way to the finished lot. */
  consumedBy: z.array(z.string()),
});
export const SupplyChainView = z.strictObject({
  lot: GenealogyNodeView,
  asOf: Instant,
  /** API lots first, then the other materials, each by lot number. */
  lines: z.array(SupplyChainLineView),
});
export type SupplyChainView = z.infer<typeof SupplyChainView>;

export const ImpactBatchView = z.strictObject({
  batchId: Uuid,
  batchNumber: z.string().min(1),
  productCode: z.string().nullable(),
  /** LINKED: named by the deviation; DOWNSTREAM: made from a linked subject; SHARED_LOT: consumed a lot a linked batch consumed (or downstream of one). */
  relation: z.enum(['LINKED', 'DOWNSTREAM', 'SHARED_LOT']),
});
export const DeviationImpactView = z.strictObject({
  deviationId: Uuid,
  ref: z.string().min(1),
  asOf: Instant,
  batches: z.array(ImpactBatchView),
});
export type DeviationImpactView = z.infer<typeof DeviationImpactView>;

export const RecurrenceItemView = z.strictObject({
  deviationId: Uuid,
  ref: z.string().min(1),
  title: z.string().min(1),
  /** The root-cause category of the deviation's latest finding; null before a finding (then nothing is counted). */
  rootCauseCategory: z.string().nullable(),
  productCode: z.string().min(1),
  /** Deviations of the product with that category raised in the window, this one included. */
  occurrences: z.number().int().nonnegative(),
  warning: z.boolean(),
  others: z.array(z.strictObject({ deviationId: Uuid, ref: z.string().min(1), raisedAt: Instant })),
});
export const RecurrenceView = z.strictObject({
  lotId: Uuid,
  threshold: z.number().int().positive(),
  windowDays: z.number().int().positive(),
  warning: z.boolean(),
  items: z.array(RecurrenceItemView),
});
export type RecurrenceView = z.infer<typeof RecurrenceView>;

const lotParams = z.strictObject({ lotId: Uuid });
const asOfQuery = { asOfUs: EpochMicros.optional() };

export const genealogy = {
  trace: defineRoute({
    id: 'genealogy.trace',
    method: 'GET',
    path: '/api/genealogy/trace',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The genealogy of a lot, batch, container or shipment, forward or backward, at any depth, as of an instant (PR-57)',
    query: z.strictObject({ kind: GenealogyNodeKind, id: Uuid, direction: GenealogyDirection, ...asOfQuery }),
    response: GenealogyTraceView,
  }),
  federatedTrace: defineRoute({
    id: 'genealogy.federatedTrace',
    method: 'GET',
    path: '/api/genealogy/federated-trace',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The genealogy across sites: the local trace and, for each transfer reached, the other site\'s sealed excerpt as of the instant, or the last one received, marked incomplete (L-41, PR-57)',
    query: z.strictObject({ kind: GenealogyNodeKind, id: Uuid, direction: GenealogyDirection, ...asOfQuery }),
    response: FederatedTraceView,
  }),
  lookup: defineRoute({
    id: 'genealogy.lookup',
    method: 'GET',
    path: '/api/genealogy/lookup',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Complaint-to-lot lookup by lot, batch or shipment number: the record, genealogy, deviations and shipments (PR-57)',
    query: z.strictObject({ code: z.string().trim().min(1).max(64) }),
    response: ComplaintLookupView,
  }),
  supplyChain: defineRoute({
    id: 'genealogy.supplyChain',
    method: 'GET',
    path: '/api/genealogy/lots/:lotId/supply-chain',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The API supply-chain traceability report of a finished lot: every purchased or recovered lot upstream, with supplier and manufacturer (PR-57)',
    params: lotParams,
    query: z.strictObject(asOfQuery),
    response: SupplyChainView,
  }),
  deviationImpact: defineRoute({
    id: 'genealogy.deviationImpact',
    method: 'GET',
    path: '/api/genealogy/deviations/:deviationId/impact',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The deviation impact query: the batches a deviation affects through its links and the genealogy (PR-50)',
    params: z.strictObject({ deviationId: Uuid }),
    query: z.strictObject(asOfQuery),
    response: DeviationImpactView,
  }),
  recurrence: defineRoute({
    id: 'genealogy.recurrence',
    method: 'GET',
    path: '/api/genealogy/lots/:lotId/recurrence',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The recurrence count of each deviation of a lot, with the warning from the third occurrence (PR-49; the certification screen)',
    params: lotParams,
    response: RecurrenceView,
  }),
} as const;
