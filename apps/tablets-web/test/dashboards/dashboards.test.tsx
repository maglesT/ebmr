/**
 * Web feature `dashboards` and `training` (Phase 6 slice 6g): the dashboards on the contract examples (data age,
 * refresh, drill links, PR-05 overdue reviews, DI-49 alarm trend), the change-impact explorer, and the training page on
 * the sandbox with its TEST, NOT GMP watermark (DI-05).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { FetchLike, SessionView } from '@ebmr/api-contract';
import { EXAMPLES, example } from '@ebmr/api-contract/examples';
import { apiState, setTransport } from '../../src/api/client.ts';
import { fixturesFromExamples } from '../../src/api/examples.ts';
import { createFixtureFetch, type FixtureMap } from '../../src/api/fixture-fetch.ts';
import * as dashboards from '../../src/features/dashboards/index.tsx';
import * as training from '../../src/features/training/index.tsx';
import type { Recorded } from '../office/support.tsx';

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

function renderAt(path: string, installation: 'GMP' | 'SANDBOX', fixtures: FixtureMap = {}) {
  apiState.installation = installation;
  const requests: Recorded[] = [];
  const session = EXAMPLES['session-office'].data as SessionView;
  const fetcher = createFixtureFetch({ ...fixturesFromExamples(installation), 'session.get': session, ...fixtures }, { installation });
  const transport: FetchLike = async (url, init) => {
    const u = new URL(url, 'http://fixture.local');
    requests.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams.entries()), body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined });
    return fetcher(url, init);
  };
  setTransport(transport);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  const root = createRootRoute({ component: () => <Outlet /> });
  const tree = root.addChildren([...dashboards.routes(root), ...training.routes(root)]);
  const router = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: [path] }) });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { requests };
}

describe('dashboards (GMP)', () => {
  it('[PR-05] an overdue review appears on the dashboard, drilling to the MBR version', async () => {
    renderAt('/dashboards', 'GMP');
    const v = example('dashboards-overdue-reviews').versions[0]!;
    const row = await screen.findByTestId(`dash-overdue-${v.documentId}`);
    expect(row.textContent).toContain(`due ${v.reviewDue}`);
    expect(row.textContent).toContain(`${v.daysOverdue.toString()} day(s) overdue`);
    expect(within(row).getByRole('link', { name: v.documentId }).getAttribute('href')).toBe(`/mbr/versions/${v.versionId}`);
  });

  it('[DI-49] the alarm trend shows the count of every alarm of the period, by day and code', async () => {
    renderAt('/dashboards', 'GMP');
    const v = example('dashboards-alarm-trend');
    const total = await screen.findByTestId('dash-alarms-total');
    expect(total.textContent).toContain(`${v.total.toString()} alarm(s), ${v.gmpCritical.toString()} GMP-critical`);
    expect(screen.getByTestId('dash-alarms-FORCE_HIGH').textContent).toBe('FORCE_HIGH111');
  });

  it('dashboards show their data age and refresh it', async () => {
    const { requests } = renderAt('/dashboards', 'GMP');
    const age = await screen.findByTestId('dash-overdue-age');
    const v = example('dashboards-overdue-reviews');
    expect(age.textContent).toBe(`Data as of ${v.dataAsOf.text} (age 0 s); read ${v.readAt.text}.`);
    for (const tile of ['dash-rft', 'dash-pareto', 'dash-cycle', 'dash-ageing', 'dash-hold', 'dash-oee', 'dash-alarms']) await screen.findByTestId(`${tile}-age`);
    expect(screen.getByText(/never used for GMP decisions/)).toBeTruthy();
    const before = requests.filter((r) => r.path === '/api/dashboards/overdue-reviews').length;
    await userEvent.click(screen.getByRole('button', { name: 'Refresh now' }));
    await waitFor(() => expect(requests.filter((r) => r.path === '/api/dashboards/overdue-reviews').length).toBeGreaterThan(before));
  });

  it('a period is sent as site dates; a malformed date is not sent', async () => {
    const { requests } = renderAt('/dashboards', 'GMP');
    const period = await screen.findByTestId('dashboards-period');
    await userEvent.type(within(period).getByRole('textbox', { name: /^From/ }), '2026-07-01');
    await userEvent.type(within(period).getByRole('textbox', { name: /^To/ }), '2026-09-30');
    await userEvent.click(within(period).getByRole('button', { name: 'Show' }));
    await waitFor(() => expect(requests.some((r) => r.path === '/api/dashboards/alarm-trend' && r.query['from'] === '2026-07-01' && r.query['to'] === '2026-09-30')).toBe(true));
    await userEvent.type(within(period).getByRole('textbox', { name: /^From/ }), 'x');
    expect(within(period).getByRole('button', { name: 'Show' }).hasAttribute('disabled')).toBe(true);
  });
});

describe('change impact (GMP)', () => {
  it('asks for the kind and code, shows each list with drill links and offers the export with the content hash', async () => {
    const { requests } = renderAt('/change-impact', 'GMP');
    const ask = await screen.findByTestId('impact-ask');
    await userEvent.click(within(ask).getByRole('radio', { name: 'Equipment' }));
    await userEvent.type(within(ask).getByRole('textbox', { name: 'Equipment code' }), 'PRESS-01');
    await userEvent.click(within(ask).getByRole('button', { name: 'Show impact' }));
    await screen.findByTestId('impact-result');
    expect(requests.find((r) => r.path === '/api/change-impact')?.query).toEqual({ kind: 'EQUIPMENT', ref: 'PRESS-01' });
    const v = example('change-impact-material');
    expect(screen.getByTestId('impact-summary').textContent).toContain(v.contentHash);
    expect(within(screen.getByTestId('impact-batches')).getAllByRole('listitem')).toHaveLength(v.openBatches.length);
    expect(within(screen.getByTestId('impact-versions')).getByRole('link', { name: v.versions[0]!.label }).getAttribute('href')).toBe(v.versions[0]!.drill);
    const href = screen.getByTestId('impact-export').getAttribute('href') ?? '';
    expect((JSON.parse(decodeURIComponent(href.slice(href.indexOf(',') + 1))) as { contentHash: string }).contentHash).toBe(v.contentHash);
  });
});

describe('training (SANDBOX)', () => {
  it('[DI-05] the training screen carries the TEST, NOT GMP watermark', async () => {
    renderAt('/training', 'SANDBOX');
    const band = await screen.findByTestId('watermark-band');
    expect(band.getAttribute('aria-label')).toBe('TEST, NOT GMP');
    expect(screen.getByText(/never becomes a GMP record/)).toBeTruthy();
    expect(screen.getByTestId('training-personas').textContent).toContain('TEST-Priya Nair');
  });

  it('[DI-05] a step is marked done in the person\'s own attempt; a new exercise is started by its code', async () => {
    const { requests } = renderAt('/training', 'SANDBOX');
    const ex = await screen.findByTestId('training-EX-FLOOR-DISPENSE');
    expect(within(ex).getByTestId('training-EX-FLOOR-DISPENSE-step-1').getAttribute('data-done')).toBe('true');
    await userEvent.click(within(within(ex).getByTestId('training-EX-FLOOR-DISPENSE-step-2')).getByRole('button', { name: 'Mark done' }));
    await waitFor(() => expect(requests.some((r) => r.method === 'POST' && r.path.endsWith('/steps'))).toBe(true));
    const post = requests.find((r) => r.method === 'POST' && r.path.endsWith('/steps'));
    expect(post?.path).toBe(`/api/training/attempts/${example('training-start').attemptId}/steps`);
    expect(post?.body).toEqual({ step: 2 });
    expect(within(ex).getAllByRole('link', { name: 'Open the screen' }).map((a) => a.getAttribute('href'))).toEqual(['/packages', '/runs']);
  });
});
