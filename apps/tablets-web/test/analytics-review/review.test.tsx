/**
 * Web feature `analytics-review` and the review queue's priority (Phase 6A slice 6A-5; draft control PR-61) on the
 * contract examples: the queue shows each record's priority with its reasons under the advisory band, in the server's
 * order, lists every record the server lists, and says "not scored yet" for an unscored one; without the priority the
 * queue is as before. One record's priority page shows the score, every reason with what it points at, the method
 * version and the advisory band, and the way into the record's full review.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReviewPriority, ReviewSummaryView, SessionView } from '@ebmr/api-contract';
import { ANALYTICS_EXAMPLES, EXAMPLES } from '@ebmr/api-contract/examples';
import { apiState, setTransport } from '../../src/api/client.ts';
import { fixturesFromExamples } from '../../src/api/examples.ts';
import { createFixtureFetch, type FixtureMap } from '../../src/api/fixture-fetch.ts';
import * as analyticsReview from '../../src/features/analytics-review/index.tsx';
import * as review from '../../src/features/review/index.tsx';

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

function renderAt(path: string, fixtures: FixtureMap = {}) {
  apiState.installation = 'GMP';
  const session = { ...(EXAMPLES['session-office'].data as SessionView), role: 'QA_REVIEWER' };
  setTransport(createFixtureFetch({ ...fixturesFromExamples('GMP'), 'session.get': session, ...fixtures }, { installation: 'GMP' }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({ routeTree: root.addChildren([...(review.routes?.(root) ?? []), ...analyticsReview.routes(root)]), history: createMemoryHistory({ initialEntries: [path] }) });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const BASE = (EXAMPLES['review-queue'].data as { batches: ReviewSummaryView[] }).batches[0]!;
const PRIORITY = ANALYTICS_EXAMPLES['analytics-review-priority'].data.priority as ReviewPriority;
const record = (n: number, priority: ReviewPriority | null | undefined): ReviewSummaryView => ({
  ...BASE, batchId: `b6000000-0000-4000-8000-00000000000${String(n)}`, batchNumber: `B26-000${String(n)}`, reviewState: 'EXECUTION_COMPLETE',
  ...(priority === undefined ? {} : { priority }),
});

describe('the review queue ordered by the review priority (GMP)', () => {
  it('[PR-61] the review queue shows each record\'s priority with its reasons in the server\'s order, lists every record and marks an unscored one first', async () => {
    const low: ReviewPriority = { ...PRIORITY, score: 0, reasons: [] };
    const batches = [record(3, null), record(1, PRIORITY), record(2, low), { ...record(4, low), reviewState: 'QA_REVIEWED' as const }];
    renderAt('/review', { 'review.queue': { batches, ordering: { by: 'REVIEW_PRIORITY', advisory: true, notForGmpDecisions: true, dataAgeSeconds: 3600 } } });
    const band = await screen.findByTestId('review-priority-band');
    expect(band.textContent).toContain('Advisory analytics, not for GMP decisions');
    expect(band.textContent).toContain('every record is listed and still needs its full review');
    expect(band.textContent).toContain('Data age 3600 s');
    const items = within(screen.getByTestId('review-queue')).getAllByRole('listitem');
    // Every record the server listed, in the server's order.
    expect(items.map((li) => li.getAttribute('data-testid'))).toEqual(batches.map((b) => `review-batch-${b.batchNumber}`));
    expect(screen.getByTestId(`review-priority-${batches[0]!.batchId}`).getAttribute('data-scored')).toBe('false');
    expect(screen.getByTestId(`review-priority-${batches[0]!.batchId}`).textContent).toContain('not scored yet');
    expect(screen.getByTestId(`review-priority-${batches[0]!.batchId}`).textContent).not.toContain('listed first');
    const top = screen.getByTestId(`review-priority-${batches[1]!.batchId}`);
    expect(top.textContent).toContain('Priority 14 (advisory)');
    expect(screen.getByTestId(`review-priority-reasons-${batches[1]!.batchId}`).textContent).toBe(PRIORITY.reasons.map((r) => r.text).join('; '));
    expect(top.textContent).toContain('REVIEW.PRIORITY v1');
    expect(screen.getByTestId(`review-priority-${batches[2]!.batchId}`).textContent).toContain('Priority 0 (advisory) (no reason above zero)');
    // Each record still opens its review, whatever its priority.
    for (const b of batches) expect(within(screen.getByTestId(`review-batch-${b.batchNumber}`)).getByRole('link', { name: b.batchNumber }).getAttribute('href')).toBe(`/review/${b.batchId}`);
  });

  it('[PR-61] without the priority the queue is as before: no band, no priority, every record listed', async () => {
    const batches = [record(1, undefined), record(2, undefined)];
    renderAt('/review', { 'review.queue': { batches, ordering: { by: 'BATCH_NUMBER', advisory: false, notForGmpDecisions: false, dataAgeSeconds: null } } });
    await screen.findByTestId(`review-batch-${batches[1]!.batchNumber}`);
    expect(screen.queryByTestId('review-priority-band')).toBeNull();
    expect(screen.queryByTestId(`review-priority-${batches[0]!.batchId}`)).toBeNull();
    expect(within(screen.getByTestId('review-queue')).getAllByRole('listitem')).toHaveLength(2);
  });

  it('[PR-61] one record\'s priority page shows the advisory band, each reason, the method version and the way into the full review', async () => {
    const view = ANALYTICS_EXAMPLES['analytics-review-priority'].data;
    renderAt(`/analytics/review-priority/${view.batchId}`, { 'analyticsReview.priority': view });
    const detail = await screen.findByTestId('review-priority-detail-reasons');
    expect(within(detail).getAllByRole('listitem').map((li) => li.textContent)).toEqual(PRIORITY.reasons.map((r) => r.text));
    expect(screen.getByTestId('analytics-advisory').textContent).toContain('Method REVIEW.PRIORITY version 1');
    expect(screen.getByText(/still needs its full review/)).toBeDefined();
    expect(screen.getByRole('link', { name: "Open the record's review" }).getAttribute('href')).toBe(`/review/${view.batchId}`);
    cleanup();
    renderAt(`/analytics/review-priority/${view.batchId}`, { 'analyticsReview.priority': ANALYTICS_EXAMPLES['analytics-review-unscored'].data });
    expect(await screen.findByText(/not scored yet/)).toBeDefined();
  });
});
