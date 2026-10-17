/**
 * The review priority on screen (Phase 6A slice 6A-5; draft control PR-61): one record's score with its top reasons, as
 * the review queue shows it beside each record, and the band above the queue when it is ordered by priority. The
 * priority is advisory: it orders the queue, and never removes a record, marks anything reviewed or shortens what the
 * review asks for (every record is still reviewed in full).
 */
import { Link } from '@tanstack/react-router';
import type { ReviewPriority, ReviewQueueOrdering } from '@ebmr/api-contract';
import { Banner } from '@ebmr/ui-kit';

/** The score and its top reasons; "not scored yet" for a record without a score (it is listed first, D-6A-14). */
export function PriorityNote({ batchId, priority }: { batchId: string; priority: ReviewPriority | null }) {
  if (priority === null) {
    return (
      <span data-testid={`review-priority-${batchId}`} data-scored="false">
        Priority: not scored yet (listed first; review in full as every record).
      </span>
    );
  }
  return (
    <span data-testid={`review-priority-${batchId}`} data-scored="true">
      <Link to="/analytics/review-priority/$batchId" params={{ batchId }}>
        Priority {priority.score.toString()} (advisory)
      </Link>
      {priority.reasons.length > 0 ? ': ' : ' (no reason above zero)'}
      <span data-testid={`review-priority-reasons-${batchId}`}>{priority.reasons.map((r) => r.text).join('; ')}</span>
      {` · ${priority.methodVersion.id} v${priority.methodVersion.version.toString()}, scored ${priority.scoredAt.text}`}
    </span>
  );
}

/** The band above a queue ordered by priority: what the order means and what it never does. */
export function QueueOrderingBand({ ordering }: { ordering: ReviewQueueOrdering | undefined }) {
  if (!ordering || ordering.by !== 'REVIEW_PRIORITY') return null;
  return (
    <div data-testid="review-priority-band">
      <Banner tone="info" title="Advisory analytics, not for GMP decisions">
        Records awaiting QA review are ordered by review priority: records not scored yet first, then the higher scores, ties by completion time; QA-reviewed records
        follow. The priority only orders the queue: every record is listed and still needs its full review, the disposition of every exception and the audit-trail review
        before release. Data age {ordering.dataAgeSeconds === null ? 'n/a (no record scored yet)' : `${ordering.dataAgeSeconds.toString()} s`}.
      </Banner>
    </div>
  );
}
