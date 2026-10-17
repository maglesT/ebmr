/**
 * Web feature `analytics-audit` (Phase 6A slice 6A-4; draft controls DI-53, DI-25) on the contract examples: the
 * audit-trail flags screens show the advisory band and that a flag is not a finding, each flag with its reasons and
 * the audit entries behind it, and the disposition only to the data-integrity reviewer; in the batch audit-trail
 * review panel a data-integrity reviewer sees the flagged entries first and highlighted, every entry still listed, and
 * anyone else sees the panel as before (no read of the flags at all).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditTrailReportView, FetchLike, SessionView } from '@ebmr/api-contract';
import { ANALYTICS_EXAMPLES, EXAMPLES } from '@ebmr/api-contract/examples';
import { apiState, setTransport } from '../../src/api/client.ts';
import { fixturesFromExamples } from '../../src/api/examples.ts';
import { createFixtureFetch, type FixtureMap } from '../../src/api/fixture-fetch.ts';
import * as audit from '../../src/features/analytics-audit/index.tsx';
import { AuditTrailPanel } from '../../src/features/review/AuditTrailPanel.tsx';
import type { Recorded } from '../office/support.tsx';

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

const REPORT = EXAMPLES['review-audit-trail'].data as AuditTrailReportView;

function renderAt(path: string, role: string, fixtures: FixtureMap = {}, panel = false) {
  apiState.installation = 'GMP';
  const requests: Recorded[] = [];
  const session = { ...(EXAMPLES['session-office'].data as SessionView), role };
  const fetcher = createFixtureFetch({ ...fixturesFromExamples('GMP'), 'session.get': session, ...fixtures }, { installation: 'GMP' });
  const transport: FetchLike = async (url, init) => {
    const u = new URL(url, 'http://fixture.local');
    requests.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams.entries()), body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined });
    return fetcher(url, init);
  };
  setTransport(transport);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  const root = createRootRoute({ component: () => <Outlet /> });
  const children = panel
    ? [createRoute({ getParentRoute: () => root, path: '/panel', component: () => <AuditTrailPanel batchId={REPORT.batchId} gate={{ ready: true, problems: [] }} offered={false} /> })]
    : audit.routes(root);
  const router = createRouter({ routeTree: root.addChildren(children), history: createMemoryHistory({ initialEntries: [path] }) });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { requests };
}

const rowsOf = (): HTMLTableRowElement[] => [...screen.getByTestId('audit-trail-events').querySelectorAll('tbody tr')] as HTMLTableRowElement[];

describe('audit-trail flags (GMP)', () => {
  it('[DI-25] the audit-trail review panel orders flagged entries first and still lists every entry', async () => {
    // The example report lists a material-lot entry, then a batch entry; a flag names the batch entry.
    const last = REPORT.events[REPORT.events.length - 1]!;
    const entries = { ...ANALYTICS_EXAMPLES['analytics-audit-entries'].data, batchId: REPORT.batchId,
      entries: [{ eventId: last.eventId, chainKey: last.chainKey, flags: [{ flagId: 'f6000000-0000-4000-8000-000000000004', rule: 'LATE_ENTRY', severity: 'INFO' as const, verdict: null }] }] };
    const { requests } = renderAt('/panel', 'CSV_DI_LEAD', { 'review.auditTrail': REPORT, 'analyticsAudit.entries': entries }, true);
    await screen.findByTestId('audit-trail-flagged-note');
    const rows = rowsOf();
    expect(rows).toHaveLength(REPORT.events.length);
    expect(rows[0]!.getAttribute('data-flagged')).toBe('true');
    expect(rows[0]!.textContent).toContain(String(last.seq));
    expect(rows[0]!.textContent).toContain('Audit-trail flag (advisory): Late entry, open');
    expect(rows.slice(1).every((r) => r.getAttribute('data-flagged') === null)).toBe(true);
    // The others keep the report's order, and the review act itself is the report's (its id and hash are unchanged).
    expect(rows.slice(1).map((r) => r.cells[2]?.textContent)).toEqual(REPORT.events.slice(0, -1).map((e) => e.seq));
    expect(screen.getByText(REPORT.reportHash)).toBeDefined();
    expect(requests.some((r) => r.path === `/api/analytics/audit-flags/batches/${REPORT.batchId}/entries`)).toBe(true);
    cleanup();
    // A QA reviewer without the data-integrity review sees the panel as before and the flags are not read at all.
    const qa = renderAt('/panel', 'QA_REVIEWER', { 'review.auditTrail': REPORT, 'analyticsAudit.entries': entries }, true);
    await waitFor(() => expect(rowsOf()).toHaveLength(REPORT.events.length));
    expect(rowsOf().map((r) => r.cells[2]?.textContent)).toEqual(REPORT.events.map((e) => e.seq));
    expect(screen.queryByTestId('audit-trail-flagged-note')).toBeNull();
    expect(qa.requests.some((r) => r.path.includes('/api/analytics/audit-flags'))).toBe(false);
  });

  it('[DI-53] the audit-trail flags show the advisory band, that a flag is no finding, each flag\'s reasons and the entries behind it; only the data-integrity reviewer is offered the disposition', async () => {
    const list = ANALYTICS_EXAMPLES['analytics-audit-flags'].data;
    renderAt('/analytics/audit-flags', 'CSV_DI_LEAD');
    const band = await screen.findByTestId('analytics-advisory');
    expect(band.textContent).toContain('Advisory analytics, not for GMP decisions');
    expect(screen.getByText('A flag is not a finding')).toBeDefined();
    const f = list.flags[0]!;
    const line = await screen.findByTestId(`audit-flag-${f.flagId}`);
    expect(line.textContent).toContain('Late entry');
    expect(line.textContent).toContain(f.reasons[0]!.text);
    expect(line.textContent).toContain('raised 3 times since');
    cleanup();
    renderAt(`/analytics/audit-flags/${f.flagId}`, 'CSV_DI_LEAD');
    const entries = await screen.findByTestId('audit-flag-entries');
    const e = ANALYTICS_EXAMPLES['analytics-audit-flag'].data.entries[0]!;
    expect(screen.getByTestId(`audit-flag-entry-${e.eventId}`).textContent).toContain(e.terminal ?? '');
    expect(entries.textContent).toContain(e.chainKey);
    expect(screen.getByTestId('audit-flag-dispositions').textContent).toContain('False alarm');
    // The example flag has no current disposition yet: the reviewer is offered the first one.
    expect(screen.getByRole('button', { name: 'Disposition' })).toBeDefined();
    cleanup();
    renderAt(`/analytics/audit-flags/${f.flagId}`, 'QA_REVIEWER');
    await screen.findByTestId('audit-flag-entries');
    expect(screen.queryByRole('button', { name: /disposition/i })).toBeNull();
  });
});
