/**
 * One record's review priority (Phase 6A slice 6A-5; draft control PR-61; analyticsReview.priority): the score, every
 * reason it carries with what it points at, the method version and when it was scored, under the advisory band. The
 * record's review is opened from here as from the queue, and asks for everything it always asks for.
 */
import { Link, useParams } from '@tanstack/react-router';
import { routes } from '@ebmr/api-contract';
import { useApiQuery } from '../../api/hooks.ts';
import { Section } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { AdvisoryBand } from '../analytics/shared.tsx';

export function ReviewPriorityPage() {
  const params: { batchId?: string } = useParams({ strict: false });
  const batchId = params.batchId ?? '';
  const q = useApiQuery(routes.analyticsReview.priority, { params: { batchId } });
  const p = q.data?.priority ?? null;
  return (
    <>
      <h1>Review priority</h1>
      {q.data ? <AdvisoryBand v={q.data} /> : null}
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      <Section title="Score" testId="review-priority-detail">
        {q.data && p === null ? <p>This record is not scored yet. Unscored records head the review queue.</p> : null}
        {p ? (
          <>
            <p>
              Score {p.score.toString()} (advisory), {p.methodVersion.id} version {p.methodVersion.version.toString()}, scored {p.scoredAt.text}.
            </p>
            <ul data-testid="review-priority-detail-reasons">
              {p.reasons.map((r) => (
                <li key={r.code}>
                  {r.text}
                  {r.evidence && r.evidence.length > 0 ? ` (${r.evidence.map((e) => e.ref).join(', ')})` : ''}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        <p>
          The priority orders the review queue only. The record still needs its full review: every exception dispositioned, the audit-trail review and the QA review before
          release.
        </p>
        <Link to="/review/$batchId" params={{ batchId }}>
          Open the record's review
        </Link>
      </Section>
    </>
  );
}
