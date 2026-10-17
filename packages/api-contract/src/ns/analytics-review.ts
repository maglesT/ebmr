/**
 * Namespace `analyticsReview` (Phase 6A slice 6A-5; interfaces slice-6A-0-interfaces.md section 5): the review
 * priority of a completed batch record. GMP only, SESSION, advisory. The priority orders the QA review queue and never
 * skips, narrows or completes a review (PR-61). `ReviewPriority` is the optional field the lead adds to review.queue
 * items (additive).
 */
import { z } from 'zod';
import { Instant, Uuid } from '../common.ts';
import { defineRoute } from '../route.ts';
import { AdvisoryEnvelope, AnalyticsReason, MethodRef, StatNumber } from './analytics.ts';

/** A batch record's review priority: its score, its top reasons, the method version and when it was scored. */
export const ReviewPriority = z.strictObject({
  score: StatNumber,
  reasons: z.array(AnalyticsReason).max(10),
  methodVersion: MethodRef,
  scoredAt: Instant,
});
export type ReviewPriority = z.infer<typeof ReviewPriority>;

export const ReviewPriorityView = z.strictObject({
  ...AdvisoryEnvelope,
  batchId: Uuid,
  /** Null for an unscored record, which heads the queue (D-6A-14). */
  priority: ReviewPriority.nullable(),
});
export type ReviewPriorityView = z.infer<typeof ReviewPriorityView>;

export const analyticsReview = {
  priority: defineRoute({
    id: 'analyticsReview.priority',
    method: 'GET',
    path: '/api/analytics/review-priority/:batchId',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The review priority of a completed batch record with its reasons; it orders the queue and never skips a review (PR-61; advisory)',
    params: z.strictObject({ batchId: Uuid }),
    response: ReviewPriorityView,
  }),
} as const;
