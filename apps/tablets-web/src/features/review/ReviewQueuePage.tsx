/**
 * The review queue (Phase 4 slice 1): GMP batch records at or after EXECUTION_COMPLETE (or ABORTED) with their review
 * state, as the server lists them (review.queue); a state filter narrows the list on the server.
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ReviewState, routes } from '@ebmr/api-contract';
import { floor, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { RefusalMessage } from '../../app/refusal.tsx';
import { stateTone, words } from './reads.ts';

const FILTERS = ['ALL', 'EXECUTION_COMPLETE', 'ABORTED', 'PRODUCTION_APPROVED', 'QA_REVIEWED'] as const;

export function ReviewQueuePage() {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('ALL');
  const state = ReviewState.safeParse(filter);
  const q = useApiQuery(routes.review.queue, { query: state.success ? { state: state.data } : {} });
  return (
    <>
      <h1>Batch record review</h1>
      <floor.ChoiceGroup label="Show" options={FILTERS.map((f) => ({ value: f, label: f === 'ALL' ? 'All' : words(f) }))} value={filter} onChange={(v) => setFilter(FILTERS.find((f) => f === v) ?? 'ALL')} />
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data && q.data.batches.length === 0 ? <p>No batch record is waiting for review.</p> : null}
      <ul data-testid="review-queue">
        {q.data?.batches.map((b) => (
          <li key={b.batchId} data-testid={`review-batch-${b.batchNumber}`}>
            <Link to="/review/$batchId" params={{ batchId: b.batchId }}>
              {b.batchNumber}
            </Link>{' '}
            {b.product} ({words(b.recordKind)} record, cycle {b.cycle}, markets {b.markets.join(', ')}) <StatusChip tone={stateTone(b.reviewState)} label={words(b.reviewState)} />
          </li>
        ))}
      </ul>
    </>
  );
}
