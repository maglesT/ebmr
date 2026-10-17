/**
 * Web feature `analytics` (Phase 6A slice 6A-1; ADR 0020; draft controls DI-51, DI-52; PR-60): on the contract examples,
 * every analytics screen shows the advisory band with the data age; the overview lists every method with "changes GMP
 * data: no"; the methods page shows each version with its validity and change record and the monitoring; QA records a
 * disposition (real issue, false alarm or not assessable) with a cause, and superseding asks for the reason.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { FetchLike, SessionView } from '@ebmr/api-contract';
import { ANALYTICS_EXAMPLES, EXAMPLES } from '@ebmr/api-contract/examples';
import { apiState, setTransport } from '../../src/api/client.ts';
import { fixturesFromExamples } from '../../src/api/examples.ts';
import { createFixtureFetch, type FixtureMap } from '../../src/api/fixture-fetch.ts';
import * as analytics from '../../src/features/analytics/index.tsx';
import type { Recorded } from '../office/support.tsx';

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

function renderAt(path: string, role = 'MBR_AUTHOR', fixtures: FixtureMap = {}) {
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
  const router = createRouter({ routeTree: root.addChildren(analytics.routes(root)), history: createMemoryHistory({ initialEntries: [path] }) });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { requests };
}

describe('analytics screens (GMP)', () => {
  it('[DI-51] every analytics screen shows the advisory band: not for GMP decisions, with the data age', async () => {
    for (const path of ['/analytics', '/analytics/methods', '/analytics/flags']) {
      renderAt(path);
      const band = await screen.findByTestId('analytics-advisory');
      expect(band.textContent, path).toContain('Advisory analytics, not for GMP decisions');
      expect(band.textContent, path).toMatch(/Data age \d+ s/);
      cleanup();
    }
  });

  it('[PR-60] the overview lists every method with its intended use and "changes GMP data: no"', async () => {
    renderAt('/analytics');
    const c = ANALYTICS_EXAMPLES['analytics-catalog'].data;
    for (const m of c.methods) {
      const line = await screen.findByTestId(`analytics-method-${m.id}`);
      expect(line.textContent).toContain(m.intendedUse);
      expect(line.textContent).toContain('Changes GMP data: no');
    }
    expect(screen.getByTestId('analytics-method-SPC.IMR').textContent).toContain('In force: version 1');
  });

  it('[DI-52] the methods page shows each version with its parameters hash, validation reference, validity and change record, and the monitoring as advisory statistics', async () => {
    renderAt('/analytics/methods');
    const v = ANALYTICS_EXAMPLES['analytics-methods'].data.versions[0]!;
    const line = await screen.findByTestId(`analytics-version-${v.method}-${v.version.toString()}-${v.status}`);
    for (const part of [v.intendedUse, v.parametersSha256, v.validationRef, v.validFrom.text, v.changeRecord ?? '']) expect(line.textContent).toContain(part);
    const m = ANALYTICS_EXAMPLES['analytics-monitor'].data.rows[0]!;
    const row = await screen.findByTestId(`analytics-monitor-${m.method}-${m.version.toString()}-${m.month}`);
    expect(row.textContent).toContain('(advisory)');
    // Only QA and the system owner are offered the change; the author is not.
    expect(screen.queryByTestId('analytics-make-effective')).toBeNull();
  });

  it('[DI-52] QA records a disposition with a cause; superseding the current one asks for the reason', async () => {
    const f = ANALYTICS_EXAMPLES['analytics-flags'].data.flags[0]!;
    const { requests } = renderAt('/analytics/flags', 'QA_REVIEWER');
    const line = await screen.findByTestId(`analytics-flag-${f.flagId}`);
    expect(line.textContent).toContain(f.subjectLabel);
    await userEvent.click(await within(line).findByRole('button', { name: 'Disposition' }));
    const dialog = await screen.findByTestId('analytics-disposition-dialog');
    const record = within(dialog).getByRole('button', { name: 'Record the disposition' });
    expect(record.hasAttribute('disabled') || record.getAttribute('aria-disabled') === 'true' || record.hasAttribute('data-disabled')).toBe(true);
    await userEvent.click(within(dialog).getByRole('radio', { name: 'False alarm' }));
    await userEvent.type(within(dialog).getByLabelText(/^Cause/), 'Gauge recalibrated before the batch');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record the disposition' }));
    await waitFor(() => expect(requests.some((r) => r.method === 'POST' && r.path === `/api/analytics/flags/${f.flagId}/dispositions`)).toBe(true));
    const sent = requests.find((r) => r.method === 'POST')!;
    expect(sent.body).toMatchObject({ verdict: 'FALSE_ALARM', cause: 'Gauge recalibrated before the batch', deviationRef: null });
    expect(sent.body).not.toHaveProperty('supersedes');
    cleanup();

    // A flag with a current disposition: the dialog asks for the reason and names the one it supersedes.
    const withDisposition = ANALYTICS_EXAMPLES['analytics-flag'].data.flag;
    const second = renderAt('/analytics/flags', 'QA_REVIEWER', { 'analytics.flags': { ...ANALYTICS_EXAMPLES['analytics-flags'].data, flags: [withDisposition] } });
    const l2 = await screen.findByTestId(`analytics-flag-${withDisposition.flagId}`);
    expect(within(l2).getByTestId(`analytics-flag-${withDisposition.flagId}-disposition`).textContent).toContain('Real issue');
    await userEvent.click(await within(l2).findByRole('button', { name: 'Supersede the disposition' }));
    const d2 = await screen.findByTestId('analytics-disposition-dialog');
    await userEvent.click(within(d2).getByRole('radio', { name: 'Not assessable' }));
    await userEvent.type(within(d2).getByLabelText(/^Cause/), 'The sensor log for the batch is missing');
    await userEvent.type(within(d2).getByLabelText(/^Reason for superseding/), 'New evidence from maintenance');
    await userEvent.click(within(d2).getByRole('button', { name: 'Record the disposition' }));
    await waitFor(() => expect(second.requests.some((r) => r.method === 'POST')).toBe(true));
    expect(second.requests.find((r) => r.method === 'POST')!.body).toMatchObject({
      verdict: 'NOT_ASSESSABLE', supersedes: withDisposition.disposition!.dispositionId, reason: 'New evidence from maintenance',
    });
  });

  it('the author sees the flags but is not offered the disposition', async () => {
    renderAt('/analytics/flags');
    const f = ANALYTICS_EXAMPLES['analytics-flags'].data.flags[0]!;
    const line = await screen.findByTestId(`analytics-flag-${f.flagId}`);
    expect(within(line).queryByRole('button', { name: 'Disposition' })).toBeNull();
  });
});
