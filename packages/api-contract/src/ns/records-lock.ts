/**
 * Namespace `records` (Phase 4 slice 5b, GMP): record locking and amendment, the bulk reconciliation of a processing
 * record, and the maximum hold of bright stock (outline 5.2.10 "Locking"; INV-21, R-04, PR-38; defaults D-5-7, D-5-8;
 * recipe-core 0870 to 0889, tablets 1190 to 1199).
 *
 *  - A processing record (PROCESSING or REPROCESSING) locks when its bulk reconciliation is closed: every packaging
 *    order of its bulk is closed (completed, aborted or cancelled) and the bulk left over is formally held by the
 *    closure. A packaging record locks at its lot's first manufacturer disposition (release or rejection).
 *  - The database refuses every write to a locked record (engine commands, entries, corrections, voids, containers,
 *    bulk issue, the edition's device and line records). A locked record changes only through an amendment:
 *    LOCKED -> UNDER_AMENDMENT (QA's AMENDMENT_OPENED signature, a linked open deviation or a change record) ->
 *    LOCKED (QA's AMENDMENT_CLOSED signature). The amendment appends entries; it never edits the record. Opening it
 *    suspends the release of every released lot made from the record (recipe.suspend_release) and opens an AP
 *    market-impact task for each market already released.
 *  - PR-38: bulk is issued across several packaging orders, never more than is left; the product's maximum hold for
 *    bright stock (filled, unlabelled bulk, counted from the container's close) is checked at issue and at packaging
 *    start; past it, issue and start are refused unless a deviation linked to the order or its processing batch has
 *    been assessed by QA.
 *
 * Signed acts (signable action RECORD_LOCK_ACT, signable.ts), aggregate `record_lock`:
 *    AMENDMENT_OPEN   record_lock <batch>/<n>/OPEN/<DEVIATION|CHANGE_RECORD>/<basis id>   AMENDMENT_OPENED (QA), state LOCKED
 *    AMENDMENT_CLOSE  record_lock <batch>/<n>/CLOSE                                      AMENDMENT_CLOSED (QA), state UNDER_AMENDMENT
 * n is the record's amendment number (1, 2, ...).
 */
import { z } from 'zod';
import { DecimalString, Instant, PersonRef, Uuid, withAttribution } from '../common.ts';
import { defineRoute } from '../route.ts';

export const RecordLockState = z.enum(['UNLOCKED', 'LOCKED', 'UNDER_AMENDMENT']);
export type RecordLockState = z.infer<typeof RecordLockState>;

export const LockedRecordKind = z.enum(['PROCESSING', 'PACKAGING', 'REPROCESSING']);
export type LockedRecordKind = z.infer<typeof LockedRecordKind>;

/** Why the record locked: its bulk reconciliation was closed, or its lot had its first manufacturer disposition. */
export const LockCause = z.enum(['BULK_RECONCILIATION_CLOSED', 'FIRST_DISPOSITION']);
export type LockCause = z.infer<typeof LockCause>;

export const BulkUnit = z.enum(['kg', 'g', 'units']);
export const BulkQuantity = z.strictObject({ quantity: DecimalString, unit: BulkUnit });
export type BulkQuantity = z.infer<typeof BulkQuantity>;

/** A whole number of hours as text (1 to 99999): the maximum hold of bright stock. */
export const HoldHours = z.string().regex(/^[1-9][0-9]{0,4}$/, 'a whole number of hours as text');

/** The product's maximum hold for bright stock (latest version wins; none set: no maximum is checked, D-5b-2). */
export const BrightStockHoldView = z.strictObject({
  productCode: z.string().min(1),
  strength: z.string().min(1),
  maxHoldHours: HoldHours,
  reason: z.string().min(1),
  setBy: PersonRef,
  setAt: Instant,
});
export type BrightStockHoldView = z.infer<typeof BrightStockHoldView>;

/** One output container of the processing batch and where its bulk went. */
export const BulkContainerView = z.strictObject({
  containerId: Uuid,
  label: z.string().min(1),
  quantity: DecimalString.nullable(),
  unit: BulkUnit,
  state: z.string().min(1),
  closedAt: Instant.nullable(),
  /** ISSUED to a packaging order; LEFT (still the batch's: held by the closure once it is closed); CHARGED or MERGED elsewhere; REJECTED; OPEN. */
  disposition: z.enum(['ISSUED', 'LEFT', 'CHARGED', 'MERGED', 'REJECTED', 'OPEN']),
  orderBatchId: Uuid.nullable(),
  orderBatchNumber: z.string().nullable(),
  /** Hours since the container was closed (whole hours, as text), null while open. */
  heldHours: z.string().regex(/^(0|[1-9][0-9]*)$/).nullable(),
  /** Past the product's maximum hold for bright stock now. */
  pastMaxHold: z.boolean(),
});
export type BulkContainerView = z.infer<typeof BulkContainerView>;

export const BulkOrderView = z.strictObject({
  orderBatchId: Uuid,
  batchNumber: z.string().min(1),
  /** The order's execution status (ISSUED, IN_PROGRESS, EXECUTION_COMPLETE, ABORTED, CANCELLED, or PLANNED). */
  status: z.string().min(1),
  closed: z.boolean(),
  issued: z.array(BulkQuantity),
  containers: z.number().int().nonnegative(),
  /** Why the bulk issued to the order is past its maximum hold and no QA-assessed deviation covers it, or null. */
  holdProblem: z.string().nullable(),
});
export type BulkOrderView = z.infer<typeof BulkOrderView>;

export const BulkReconciliationView = z.strictObject({
  batchId: Uuid,
  batchNumber: z.string().min(1),
  recordKind: LockedRecordKind,
  /** Totals per unit: produced (closed containers not merged away), issued to packaging orders, left. */
  produced: z.array(BulkQuantity),
  issued: z.array(BulkQuantity),
  remaining: z.array(BulkQuantity),
  orders: z.array(BulkOrderView),
  containers: z.array(BulkContainerView),
  maxHold: BrightStockHoldView.nullable(),
  /** Why the reconciliation cannot be closed now ([] when it can). */
  closeProblems: z.array(z.string().min(1)),
  closure: z
    .strictObject({
      closedBy: PersonRef,
      closedAt: Instant,
      /** The reason the bulk left over is held (required when any is left). */
      remainingHeldReason: z.string().nullable(),
    })
    .nullable(),
  lockState: RecordLockState,
});
export type BulkReconciliationView = z.infer<typeof BulkReconciliationView>;

export const AmendmentEntryKind = z.enum(['LATE_ENTRY', 'CORRECTION', 'NOTE']);
export type AmendmentEntryKind = z.infer<typeof AmendmentEntryKind>;

export const AmendmentEntryView = z.strictObject({
  entryId: Uuid,
  seq: z.number().int().min(1),
  kind: AmendmentEntryKind,
  /** What in the record the entry amends (a step, data point or document reference, as text). */
  target: z.string().min(1),
  text: z.string().min(1),
  /** The value the entry records, as text, when it records one. */
  value: z.string().nullable(),
  reason: z.string().min(1),
  by: PersonRef,
  at: Instant,
});
export type AmendmentEntryView = z.infer<typeof AmendmentEntryView>;

/** An AP-owned market-impact assessment opened by an amendment for a market the lot was already released for (R-04). */
export const MarketImpactTaskView = z.strictObject({
  taskId: Uuid,
  lotId: Uuid,
  lotCode: z.string().min(1),
  market: z.enum(['IN', 'US', 'EU']),
  ownerRole: z.literal('AUTHORISED_PERSON'),
  /** OPEN while the lot's disposition for the market is still RELEASE_SUSPENDED (or the amendment is open); DONE after. */
  state: z.enum(['OPEN', 'DONE']),
  dispositionNow: z.string().nullable(),
  openedAt: Instant,
});
export type MarketImpactTaskView = z.infer<typeof MarketImpactTaskView>;

export const AmendmentView = z.strictObject({
  amendmentId: Uuid,
  number: z.number().int().min(1),
  batchId: Uuid,
  state: z.enum(['OPEN', 'CLOSED']),
  basis: z.strictObject({ kind: z.enum(['DEVIATION', 'CHANGE_RECORD']), id: Uuid, ref: z.string().min(1) }),
  reason: z.string().min(1),
  openedBy: PersonRef,
  openedAt: Instant,
  openSignatureId: Uuid,
  closedBy: PersonRef.nullable(),
  closedAt: Instant.nullable(),
  closeSignatureId: Uuid.nullable(),
  closingStatement: z.string().nullable(),
  entries: z.array(AmendmentEntryView),
  /** The released lots made from the record whose release the opening suspended. */
  suspendedLots: z.array(z.strictObject({ lotId: Uuid, lotCode: z.string().min(1) })),
  tasks: z.array(MarketImpactTaskView),
});
export type AmendmentView = z.infer<typeof AmendmentView>;

export const RecordLockView = z.strictObject({
  batchId: Uuid,
  batchNumber: z.string().min(1),
  recordKind: LockedRecordKind,
  state: RecordLockState,
  lockedAt: Instant.nullable(),
  cause: LockCause.nullable(),
  amendments: z.array(AmendmentView),
  /** The number the next amendment will have, and the open one's (null when none is open). */
  nextAmendmentNumber: z.number().int().min(1),
  openAmendmentNumber: z.number().int().min(1).nullable(),
  /** The released lots an amendment opened now would suspend (lots made from the record, manufacturer RELEASED). */
  releasedLots: z.array(z.strictObject({ lotId: Uuid, lotCode: z.string().min(1) })),
});
export type RecordLockView = z.infer<typeof RecordLockView>;

export const RecordLockSummaryView = z.strictObject({
  batchId: Uuid,
  batchNumber: z.string().min(1),
  recordKind: LockedRecordKind,
  state: z.enum(['LOCKED', 'UNDER_AMENDMENT']),
  lockedAt: Instant,
  cause: LockCause,
  openAmendmentNumber: z.number().int().min(1).nullable(),
});
export type RecordLockSummaryView = z.infer<typeof RecordLockSummaryView>;

const batchParams = z.strictObject({ batchId: Uuid });

export const records = {
  locks: defineRoute({
    id: 'records.locks',
    method: 'GET',
    path: '/api/records/locks',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The locked records (and those under amendment), newest lock first',
    query: z.strictObject({ state: z.enum(['LOCKED', 'UNDER_AMENDMENT']).optional() }),
    response: z.strictObject({ records: z.array(RecordLockSummaryView) }),
  }),
  lock: defineRoute({
    id: 'records.lock',
    method: 'GET',
    path: '/api/records/batches/:batchId/lock',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'One batch record: its lock state, its amendments with their entries and market-impact tasks, and the lots an amendment would suspend',
    params: batchParams,
    response: RecordLockView,
  }),
  bulk: defineRoute({
    id: 'records.bulk',
    method: 'GET',
    path: '/api/records/batches/:batchId/bulk-reconciliation',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The bulk reconciliation of a processing batch: produced, issued to each packaging order, left, the maximum hold, and why it cannot close yet',
    params: batchParams,
    response: BulkReconciliationView,
  }),
  closeBulk: defineRoute({
    id: 'records.closeBulk',
    method: 'POST',
    path: '/api/records/batches/:batchId/bulk-reconciliation',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Close the bulk reconciliation (head of production): the bulk left over is held and the processing record locks (INV-21)',
    params: batchParams,
    body: withAttribution({ remainingHeldReason: z.string().trim().min(10).max(2000).optional() }),
    response: BulkReconciliationView,
  }),
  appendAmendmentEntry: defineRoute({
    id: 'records.appendAmendmentEntry',
    method: 'POST',
    path: '/api/records/batches/:batchId/amendments/:number/entries',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Append an entry to the open amendment of a locked record (never an edit of the record)',
    params: z.strictObject({ batchId: Uuid, number: z.string().regex(/^[1-9][0-9]{0,5}$/, 'the amendment number') }),
    body: withAttribution({
      kind: AmendmentEntryKind,
      target: z.string().trim().min(1).max(200),
      text: z.string().trim().min(1).max(4000),
      value: z.string().trim().min(1).max(200).optional(),
      reason: z.string().trim().min(10).max(2000),
    }),
    response: AmendmentView,
  }),
  brightStockHolds: defineRoute({
    id: 'records.brightStockHolds',
    method: 'GET',
    path: '/api/records/bright-stock-holds',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The maximum hold of bright stock per product and strength (the latest version of each)',
    response: z.strictObject({ holds: z.array(BrightStockHoldView) }),
  }),
  setBrightStockHold: defineRoute({
    id: 'records.setBrightStockHold',
    method: 'POST',
    path: '/api/records/bright-stock-holds',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'Set a product\'s maximum hold for bright stock (master data; a new version, never an edit)',
    body: z.strictObject({
      productCode: z.string().regex(/^[A-Z0-9][A-Z0-9-]{0,31}$/),
      strength: z.string().trim().min(1).max(64),
      maxHoldHours: HoldHours,
      reason: z.string().trim().min(10).max(2000),
    }),
    response: BrightStockHoldView,
  }),
} as const;
