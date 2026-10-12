/**
 * Namespace `review` (Phase 4 slice 1, GMP): production approval, the exception register in QA review, the audit-trail
 * review with its high-water mark and the delta review, reopening, the abort checklist and the free-text translations of
 * a GMP batch record (processing record or packaging record; outline 5.2.2, 5.2.4, 5.4, 7.3, 7.4; plan
 * docs/build-plan/phase-4/phase-4-plan.md, slice 1). Every rule is the database's (recipe-core 0710 to 0739).
 *
 * The signed acts are the signable action REVIEW_ACT (signable.ts):
 *   PRODUCTION_APPROVE  batch_review <batch>               PRODUCTION_APPROVED (processing) or PACKAGING_RECORD_APPROVED
 *   QA_REVIEW           batch_review <batch>               QA_REVIEWED, with the evidence epoch the reviewer saw
 *   AUDIT_TRAIL_REVIEW  batch_audit_review <batch>/<n>     AUDIT_TRAIL_REVIEWED (the full review of the cycle)
 *   DELTA_REVIEW        batch_audit_review <batch>/<n>     DELTA_AUDIT_TRAIL_REVIEWED (the events after the last mark)
 *   REOPEN              batch_review_reopen <batch>/<cycle> REVIEW_REOPENED (QA, with the person's reason)
 *   DISPOSE_ITEM        review_items <batch>/<disposition>/<text hash>/<ids>  REVIEW_ITEMS_DISPOSITIONED
 * The aggregate ids of the audit-trail review and of a disposition are the database's (recipe.audit_review_next_id,
 * recipe.review_items_aggregate_id); the screen never builds them.
 *
 * The unsigned routes below are attributed commands: showing the register (the "full list shown" fact grouped acceptance
 * needs), opening an item's detail (tracked; a critical item is accepted only after it), production's answer to a query,
 * the abort checklist (signed with the production approval of an aborted record) and the translations (D-P4-12).
 */
import { z } from 'zod';
import { Instant, IntegerString, PersonRef, Uuid } from '../common.ts';
import { defineRoute } from '../route.ts';

/** The record's place in its life (recipe.batch_review_state): the execution states, then the review states. */
export const ReviewState = z.enum(['ISSUED', 'IN_PROGRESS', 'ON_HOLD', 'CANCELLED', 'EXECUTION_COMPLETE', 'ABORTED', 'PRODUCTION_APPROVED', 'QA_REVIEWED']);
export type ReviewState = z.infer<typeof ReviewState>;

export const RecordKind = z.enum(['PROCESSING', 'PACKAGING']);

const batchParams = z.strictObject({ batchId: Uuid });
const itemParams = z.strictObject({ batchId: Uuid, exceptionId: z.string().min(1).max(128) });
const translationParams = z.strictObject({ translationId: Uuid });

/** A batch record as the review queue lists it. */
export const ReviewSummaryView = z.strictObject({
  batchId: Uuid,
  batchNumber: z.string(),
  recordKind: RecordKind,
  product: z.string(),
  executionStatus: z.string(),
  reviewState: ReviewState,
  /** The review cycle: 1, and one more after each reopen. */
  cycle: z.number().int().min(1),
  markets: z.array(z.string()),
});
export type ReviewSummaryView = z.infer<typeof ReviewSummaryView>;

/** Whether a signed act may be given now, and why not (the database's own reasons, in its words). */
export const ReviewGate = z.strictObject({ ready: z.boolean(), problems: z.array(z.string()) });

export const ReviewActRecord = z.strictObject({
  act: z.enum(['PRODUCTION_APPROVED', 'PACKAGING_RECORD_APPROVED', 'AUDIT_TRAIL_REVIEWED', 'DELTA_AUDIT_TRAIL_REVIEWED', 'QA_REVIEWED', 'REOPENED']),
  cycle: z.number().int().min(1),
  by: PersonRef,
  at: Instant,
  signatureId: Uuid,
  /** False once a reopen (or a later change) superseded it. */
  valid: z.boolean(),
  reason: z.string().nullable(),
});

export const FreeTextView = z.strictObject({
  /** Where the text is held, e.g. `exception:EX-3:disposition` (the database's key). */
  sourceRef: z.string(),
  source: z.string(),
  text: z.string(),
  /** D-P4-12: written in a script other than Latin on a batch with US or EU in its market set. */
  needsTranslation: z.boolean(),
  translation: z
    .strictObject({ translationId: Uuid, english: z.string(), translatedBy: PersonRef, verifiedBy: PersonRef.nullable(), verifiedAt: Instant.nullable() })
    .nullable(),
});

export const AbortChecklistInput = z.strictObject({
  materialsAccounted: z.string().trim().min(1).max(2000),
  outputsDispositioned: z.string().trim().min(1).max(2000),
  equipmentDirty: z.string().trim().min(1).max(2000),
  genealogyClosed: z.string().trim().min(1).max(2000),
  contingencyReconciled: z.string().trim().min(1).max(2000),
});

export const BatchReviewView = z.strictObject({
  batchId: Uuid,
  batchNumber: z.string(),
  recordKind: RecordKind,
  product: z.string(),
  executionStatus: z.string(),
  reviewState: ReviewState,
  cycle: z.number().int().min(1),
  /** The batch's evidence epoch (recipe.evidence_epoch); QA_REVIEW sends back the one the reviewer saw. */
  epoch: IntegerString,
  markets: z.array(z.string()),
  /** FULL: every item reviewed one by one; RBE: review by exception under a rule set (none validated yet: FULL). */
  mode: z.enum(['FULL', 'RBE']),
  /** PR-07: steps of the master whose review by exception is paused (three deviations), with their re-review task. */
  pausedSteps: z.array(z.strictObject({ stepId: z.string(), deviations: z.number().int(), taskId: Uuid })),
  acts: z.array(ReviewActRecord),
  gates: z.strictObject({ productionApprove: ReviewGate, auditTrailReview: ReviewGate, qaReview: ReviewGate, reopen: ReviewGate }),
  items: z.strictObject({ total: z.number().int(), open: z.number().int(), concluded: z.number().int(), critical: z.number().int() }),
  abortChecklist: AbortChecklistInput.extend({ recordedBy: PersonRef, recordedAt: Instant }).nullable(),
  freeText: z.array(FreeTextView),
  /** The record the production approval, the QA review and the reopen sign. */
  signable: z.strictObject({ aggregateType: z.literal('batch_review'), aggregateId: Uuid }),
});
export type BatchReviewView = z.infer<typeof BatchReviewView>;

export const ReviewItemView = z.strictObject({
  exceptionId: z.string(),
  type: z.string(),
  category: z.string(),
  severity: z.enum(['ALERT', 'ACTION', 'CRITICAL']),
  /** Critical items are dispositioned one by one, after their detail was opened, with a justification (PR-52). */
  critical: z.boolean(),
  stepKey: z.string().nullable(),
  title: z.string(),
  raisedAt: Instant,
  engineDisposition: z.strictObject({ outcome: z.enum(['NO_IMPACT', 'DEVIATION_RAISED']), by: PersonRef, note: z.string().nullable() }).nullable(),
  deviationRef: z.string().nullable(),
  reviewStatus: z.enum(['OPEN', 'QUERIED', 'RESPONDED', 'ACCEPTED', 'ESCALATED']),
  /** Items sharing one linked deviation: the group grouped acceptance may take together (non-critical only). */
  group: z.string().nullable(),
  detailOpened: z.boolean(),
  /** PR-07: the step's review by exception is paused, so the item is reviewed on its own. */
  pausedStep: z.boolean(),
});
export type ReviewItemView = z.infer<typeof ReviewItemView>;

export const RegisterView = z.strictObject({
  batchId: Uuid,
  items: z.array(ReviewItemView),
  /** When this person was shown the full list (recorded; grouped acceptance needs a showing after the last item). */
  shownAt: Instant,
  noExceptions: z.boolean(),
  byCategory: z.record(z.string(), z.number().int()),
});
export type RegisterView = z.infer<typeof RegisterView>;

export const ItemDetailView = z.strictObject({
  item: ReviewItemView,
  /** The exception exactly as raised (expected and actual, limit source, instruction as issued, raw device data). */
  raisedRecord: z.record(z.string(), z.unknown()),
  acts: z.array(z.strictObject({ act: z.string(), by: PersonRef, at: Instant, note: z.string().nullable() })),
  openedAt: Instant,
});
export type ItemDetailView = z.infer<typeof ItemDetailView>;

export const AuditScopeKind = z.enum(['BATCH', 'PACKAGING_ORDER', 'LOT', 'EQUIPMENT', 'ROOM', 'CONTAINER', 'PERSON', 'ACCOUNT', 'DEVIATION', 'LIMS', 'MBR', 'REVIEW']);

export const AuditTrailReportView = z.strictObject({
  batchId: Uuid,
  /** The aggregate id the next review signs (`<batch>/<n>`), or the last one when the record is covered. */
  reviewId: z.string(),
  kind: z.enum(['FULL', 'DELTA']),
  /** The previous mark of this cycle (delta review), per chain key: the last audit sequence number covered. */
  fromMark: z.record(z.string(), IntegerString).nullable(),
  highWater: z.record(z.string(), IntegerString),
  scope: z.array(z.strictObject({ chainKey: z.string(), kind: AuditScopeKind, label: z.string() })),
  events: z.array(
    z.strictObject({
      eventId: IntegerString,
      chainKey: z.string(),
      seq: IntegerString,
      at: Instant,
      action: z.string(),
      table: z.string().nullable(),
      recordId: z.string().nullable(),
      /** D-P4-16: a change to a linked record within the critical period (default 72 h) before its use. */
      critical: z.boolean(),
      linked: z.boolean(),
    }),
  ),
  eventCount: z.number().int(),
  truncated: z.boolean(),
  reportHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** INV-48: the last signed mark covers every in-scope event (false: a delta review is due). */
  covered: z.boolean(),
});
export type AuditTrailReportView = z.infer<typeof AuditTrailReportView>;

export const review = {
  queue: defineRoute({
    id: 'review.queue',
    method: 'GET',
    path: '/api/review/batches',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'GMP batch records at or after EXECUTION_COMPLETE (or ABORTED), with their review state',
    query: z.strictObject({ state: ReviewState.optional() }),
    response: z.strictObject({ batches: z.array(ReviewSummaryView) }),
  }),
  batch: defineRoute({
    id: 'review.batch',
    method: 'GET',
    path: '/api/review/batches/:batchId',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'One batch record in review: state, cycle, epoch, signed acts and the gates of each signed act',
    params: batchParams,
    response: BatchReviewView,
  }),
  register: defineRoute({
    id: 'review.register',
    method: 'POST',
    path: '/api/review/batches/:batchId/register',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'The exception register of the record, every mandatory type; records that this person was shown the full list',
    params: batchParams,
    body: z.strictObject({}),
    response: RegisterView,
  }),
  openItem: defineRoute({
    id: 'review.openItem',
    method: 'POST',
    path: '/api/review/batches/:batchId/items/:exceptionId/open',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'An item\'s detail; the opening is recorded (a critical item is dispositioned only after its detail was opened)',
    params: itemParams,
    body: z.strictObject({}),
    response: ItemDetailView,
  }),
  respond: defineRoute({
    id: 'review.respond',
    method: 'POST',
    path: '/api/review/batches/:batchId/items/:exceptionId/response',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'Production\'s answer to QA\'s open query on an item (not by the person who asked it)',
    params: itemParams,
    body: z.strictObject({ text: z.string().trim().min(1).max(4000) }),
    response: ReviewItemView,
  }),
  auditTrail: defineRoute({
    id: 'review.auditTrail',
    method: 'GET',
    path: '/api/review/batches/:batchId/audit-trail',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The batch audit-trail review report: the batch and packaging-order chains and the linked records, from the last mark of the cycle',
    params: batchParams,
    query: z.strictObject({ limit: z.string().regex(/^[1-9]\d{0,3}$/).optional() }),
    response: AuditTrailReportView,
  }),
  recordAbortChecklist: defineRoute({
    id: 'review.recordAbortChecklist',
    method: 'POST',
    path: '/api/review/batches/:batchId/abort-checklist',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'The abort checklist of an ABORTED record (L-20), signed afterwards with its production approval',
    params: batchParams,
    body: AbortChecklistInput,
    response: BatchReviewView,
  }),
  recordTranslation: defineRoute({
    id: 'review.recordTranslation',
    method: 'POST',
    path: '/api/review/batches/:batchId/translations',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'An English translation of a free text of the record (D-P4-12; both texts are kept)',
    params: batchParams,
    body: z.strictObject({ sourceRef: z.string().min(1).max(256), english: z.string().trim().min(1).max(4000) }),
    response: BatchReviewView,
  }),
  verifyTranslation: defineRoute({
    id: 'review.verifyTranslation',
    method: 'POST',
    path: '/api/review/translations/:translationId/verification',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'The verification of a translation by a second person (not the translator)',
    params: translationParams,
    body: z.strictObject({}),
    response: BatchReviewView,
  }),
} as const;
