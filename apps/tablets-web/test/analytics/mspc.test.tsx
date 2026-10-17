/**
 * Web screens of slice 6A-3 (Phase 6A; /analytics/mspc, /analytics/mspc/batches/:batchId; draft controls DI-51, DI-52;
 * DI-09; D-6A-3-*): on the contract examples, the multivariate screen shows the advisory band, the T-squared and Q
 * charts and the scores plot, the flagged batch and its reasons; a batch's page shows its contributions as bars and a
 * table with the recorded values as decimal text and drills to the batch record; QA makes a model candidate the
 * reference set under a change record; the SPC chart offers its Phase I limits as a reference set; the open flags list
 * says how often a hit was raised.
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
import { createFixtureFetch } from '../../src/api/fixture-fetch.ts';
import * as analytics from '../../src/features/analytics/index.tsx';
import * as mspc from '../../src/features/analytics/mspc/index.tsx';
import * as spc from '../../src/features/analytics/spc/index.tsx';
import type { Recorded } from '../office/support.tsx';

function renderOffice(path: string, opts: { role: string }) {
  apiState.installation = 'GMP';
  const requests: Recorded[] = [];
  const session = { ...(EXAMPLES['session-office'].data as SessionView), role: opts.role, roles: [opts.role] };
  const fetcher = createFixtureFetch({ ...fixturesFromExamples('GMP'), 'session.get': session }, { installation: 'GMP' });
  const transport: FetchLike = async (url, init) => {
    const u = new URL(url, 'http://fixture.local');
    requests.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams.entries()), body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined });
    return fetcher(url, init);
  };
  setTransport(transport);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({ routeTree: root.addChildren([...analytics.routes(root), ...spc.routes(root), ...mspc.routes(root)]), history: createMemoryHistory({ initialEntries: [path] }) });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { requests };
}

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

const chart = ANALYTICS_EXAMPLES['analytics-mspc-chart'].data;
const batch = ANALYTICS_EXAMPLES['analytics-mspc-batch'].data;
const candidates = ANALYTICS_EXAMPLES['analytics-mspc-candidates'].data;

describe('multivariate monitoring screens (GMP)', () => {
  it('[DI-51] the multivariate screen shows the advisory band, the T-squared and Q charts, the scores plot and the flagged batch, every statistic labelled', async () => {
    const ui = renderOffice(`/analytics/mspc?product=${chart.product}&family=${chart.family}`, { role: 'QA_REVIEWER' });
    const model = await screen.findByTestId('analytics-mspc-model');
    expect(ui.requests.some((r) => r.path === '/api/analytics/mspc' && r.query['product'] === chart.product && r.query['family'] === chart.family)).toBe(true);
    expect(model.textContent).toContain(`Reference set ${chart.referenceSet} in force`);
    expect(model.textContent).toContain(chart.variables.join(', '));
    const band = screen.getAllByTestId('analytics-advisory')[0]!;
    expect(band.textContent).toContain('Advisory analytics, not for GMP decisions');
    expect(band.textContent).toContain('Method MSPC.PCA version 1.');
    for (const id of ['analytics-mspc-t2', 'analytics-mspc-q', 'analytics-mspc-scores']) expect(screen.getByTestId(id).textContent).toContain('advisory statistics, not GMP values');
    expect(screen.getByTestId('analytics-mspc-t2').querySelector('svg')!.getAttribute('aria-label')).toBe(`Hotelling T-squared: ${chart.batches.length.toString()} batches, 1 above the limit`);
    const flagged = chart.batches.find((b) => b.flagged)!;
    const row = screen.getByTestId(`analytics-mspc-batch-${flagged.batchId}`);
    expect(row.textContent).toContain('new');
    expect(within(row).getByRole('link', { name: flagged.batchNumber }).getAttribute('href')).toBe(flagged.drill);
    for (const s of within(row).getAllByTitle('Advisory, not a GMP value')) expect(s.textContent).toMatch(/\(advisory\)$/);
    expect(screen.getByTestId('analytics-mspc-flag-T2_ABOVE').textContent).toContain(chart.flags[0]!.reasons[0]!.text);
  });

  it('[DI-51] a batch\'s contributions show each recorded value as decimal text, largest first, and drill to the batch record', async () => {
    renderOffice(`/analytics/mspc/batches/${batch.batchId}`, { role: 'QA_REVIEWER' });
    const table = await screen.findByTestId('analytics-mspc-contribution-table');
    const rows = within(table).getAllByRole('row').slice(1) as HTMLTableRowElement[];
    expect(rows.map((r) => r.cells[0]!.textContent)).toEqual(batch.contributions.map((c) => c.variable));
    expect(rows.map((r) => r.cells[1]!.textContent)).toEqual(batch.contributions.map((c) => c.value ?? `mean of ${c.readings.join(', ')}`));
    for (const c of batch.contributions) expect(screen.getByTestId(`analytics-mspc-contributions-${c.variable}`)).toBeTruthy();
    expect(screen.getByTestId('analytics-mspc-batch-record').getAttribute('href')).toBe(batch.drill);
    expect(screen.getByTestId('analytics-advisory').textContent).toContain('not for GMP decisions');
  });

  it('[DI-52] the candidates list the batches they leave out; QA makes one the reference set under a change record', async () => {
    const c = candidates.candidates[0]!;
    const ui = renderOffice('/analytics/mspc', { role: 'QA_REVIEWER' });
    const line = await screen.findByTestId(`mspc-candidate-${c.outputId}`);
    expect(line.textContent).toContain(`${c.product} · ${c.family}`);
    expect(line.textContent).toContain(`Left out: ${c.skipped[0]!.reason}`);
    expect(line.textContent).toContain('not a reference set');
    await userEvent.type(await within(line).findByLabelText(/^Change-record number/), 'CR-MSPC-0001');
    await userEvent.type(within(line).getByLabelText(/^Reason/), 'Eighteen released batches');
    await userEvent.click(within(line).getByRole('button', { name: 'Make it the reference set' }));
    await waitFor(() => expect(ui.requests.some((r) => r.method === 'POST' && r.path === '/api/analytics/reference-sets')).toBe(true));
    expect(ui.requests.find((r) => r.method === 'POST')!.body).toMatchObject({
      method: 'MSPC.PCA', scope: { product: c.product, family: c.family }, batchIds: c.batchIds, candidateOutput: c.outputId, status: 'EFFECTIVE', changeRecord: 'CR-MSPC-0001',
      reason: 'Eighteen released batches',
    });
  });

  it('[DI-52] an SPC chart with Phase I limits offers them as its reference set under a change record', async () => {
    const spcChart = ANALYTICS_EXAMPLES['analytics-spc-chart'].data;
    const ui = renderOffice(`/analytics/spc?product=${spcChart.product}&family=${spcChart.family}&item=${spcChart.item}`, { role: 'QA_REVIEWER' });
    const panel = await screen.findByTestId('analytics-spc-candidate');
    expect(panel.textContent).toContain(`first ${spcChart.candidate.batches.toString()} batches`);
    await userEvent.type(await within(panel).findByLabelText(/^Change-record number/), 'CR-SPC-0001');
    await userEvent.type(within(panel).getByLabelText(/^Reason/), 'Phase I limits approved');
    await userEvent.click(within(panel).getByRole('button', { name: 'Make these limits the reference set' }));
    await waitFor(() => expect(ui.requests.some((r) => r.method === 'POST' && r.path === '/api/analytics/reference-sets')).toBe(true));
    expect(ui.requests.find((r) => r.method === 'POST')!.body).toMatchObject({
      method: 'SPC.IMR', scope: { product: spcChart.product, family: spcChart.family, item: spcChart.item, chart: 'IMR' }, batchIds: spcChart.candidate.batchIds,
      candidateOutput: spcChart.candidate.outputId, status: 'EFFECTIVE', changeRecord: 'CR-SPC-0001',
    });
  });

  it('[DI-52] the open flags list says how often later runs raised the same hit', async () => {
    const f = ANALYTICS_EXAMPLES['analytics-flags'].data.flags[0]!;
    renderOffice('/analytics/flags', { role: 'QA_REVIEWER' });
    const line = await screen.findByTestId(`analytics-flag-${f.flagId}`);
    expect(within(line).getByTestId('analytics-flag-repeats').textContent).toBe(` (raised ${f.raisedCount.toString()} times since ${f.firstRaisedAt.text})`);
  });
});
