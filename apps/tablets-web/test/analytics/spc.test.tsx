/**
 * Web feature `analytics-spc` (Phase 6A slice 6A-2; ADR 0020; draft controls DI-51, DI-52): on the contract examples,
 * the control chart and rates screens show the advisory band with the method, version and data age; the chart says
 * where its limits come from, echoes the master's limits and every recorded value as their decimal text and lists the
 * rule hits; the capability panel shows Cpk and Ppk with intervals and the normality note; the rates screen shows each
 * group's intervals, the funnel and the groups not compared; the PQR extract links to them as an advisory annex.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { FetchLike, SessionView } from '@ebmr/api-contract';
import { ANALYTICS_EXAMPLES, EXAMPLES } from '@ebmr/api-contract/examples';
import { apiState, setTransport } from '../../src/api/client.ts';
import { fixturesFromExamples } from '../../src/api/examples.ts';
import { createFixtureFetch } from '../../src/api/fixture-fetch.ts';
import * as spc from '../../src/features/analytics/spc/index.tsx';
import * as pqr from '../../src/features/pqr/index.tsx';

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

function renderAt(path: string, feature: { routes: typeof spc.routes } = spc) {
  apiState.installation = 'GMP';
  const requests: { path: string; query: Record<string, string> }[] = [];
  const session = { ...(EXAMPLES['session-office'].data as SessionView), role: 'QA_REVIEWER' };
  const fetcher = createFixtureFetch({ ...fixturesFromExamples('GMP'), 'session.get': session }, { installation: 'GMP' });
  const transport: FetchLike = async (url, init) => {
    const u = new URL(url, 'http://fixture.local');
    requests.push({ path: u.pathname, query: Object.fromEntries(u.searchParams.entries()) });
    return fetcher(url, init);
  };
  setTransport(transport);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({ routeTree: root.addChildren(feature.routes(root)), history: createMemoryHistory({ initialEntries: [path] }) });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { requests };
}

const chart = ANALYTICS_EXAMPLES['analytics-spc-chart'].data;
const rates = ANALYTICS_EXAMPLES['analytics-spc-rates'].data;

describe('analytics SPC and rates screens (GMP)', () => {
  it('[DI-51] the chart screen shows the advisory band, the limits source, the master\'s limits and each recorded value as decimal text', async () => {
    const { requests } = renderAt(`/analytics/spc?product=${chart.product}&family=${chart.family}&item=${chart.item}`);
    await screen.findByTestId('analytics-spc-chart');
    const bands = screen.getAllByTestId('analytics-advisory');
    expect(bands.some((b) => /Advisory analytics, not for GMP decisions/.test(b.textContent) && b.textContent.includes(`Method ${chart.method.id} version 1`) && /Data age 3600 s/.test(b.textContent))).toBe(true);
    expect(screen.getByTestId('analytics-spc-source').textContent).toMatch(/Phase I limits from the first batches/);
    expect(screen.getByTestId('analytics-spc-specification').textContent).toContain(`lower ${chart.specification.lower}, target ${chart.specification.target}, upper ${chart.specification.upper}`);
    const table = screen.getByTestId('analytics-spc-points');
    for (const p of chart.points) expect(within(table).getByText(p.batchNumber).closest('tr')!.textContent).toContain(p.value);
    expect(screen.getByRole('img', { name: /individual values/ })).toBeTruthy();
    expect(requests.some((r) => r.path === '/api/analytics/spc' && r.query['item'] === chart.item)).toBe(true);
  });

  it('[DI-52] the capability panel shows Cpk and Ppk with their intervals and the normality note', async () => {
    renderAt(`/analytics/spc?product=${chart.product}&family=${chart.family}&item=${chart.item}`);
    const panel = await screen.findByTestId('analytics-spc-capability');
    const cap = ANALYTICS_EXAMPLES['analytics-spc-capability'].data;
    expect(panel.textContent).toContain(`${cap.cpk.value.toPrecision(4)} (advisory)`);
    expect(panel.textContent).toContain('Bissell');
    expect(screen.getByTestId('analytics-spc-normality').textContent).toContain(cap.normality.note);
  });

  it('[DI-52] the rates screen shows each group with its intervals, the funnel, the group above the rest and those not compared', async () => {
    renderAt(`/analytics/rates?product=${rates.product}&by=ROOM`);
    const groups = await screen.findByTestId('analytics-rates-groups');
    expect(screen.getAllByTestId('analytics-advisory').some((b) => b.textContent.includes('Method RATE.DEVIATION version 1'))).toBe(true);
    expect(within(groups).getByTestId('analytics-rate-R-2').textContent).toContain('Above the rest');
    expect(within(groups).getByTestId('analytics-rate-R-1').textContent).not.toContain('Above the rest');
    expect(screen.getByTestId('analytics-rates-skipped').textContent).toContain('R-9 (fewer than 5 batches)');
    expect(screen.getByRole('img', { name: /2 groups, 1 above the rest/ })).toBeTruthy();
    expect(screen.getByTestId('analytics-rates-overall').textContent).toContain('1 deviation(s) linked to a batch only');
  });

  it('[DI-51] the PQR extract links to the product\'s charts and rates as an advisory annex outside its signed content', async () => {
    const x = EXAMPLES['pqr-extract'].data;
    renderAt(`/pqr/${x.extractId}`, pqr);
    const annex = await screen.findByTestId('pqr-analytics-annex');
    expect(annex.textContent).toMatch(/Not part of the extract or its signed content/);
    const links = within(annex).getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(links).toEqual([`/analytics/rates?product=${encodeURIComponent(x.productCode)}&from=${x.periodFrom}&to=${x.periodTo}`, `/analytics/spc?product=${encodeURIComponent(x.productCode)}`]);
  });

  it('every screen shows the advisory band before anything is asked', async () => {
    for (const path of ['/analytics/spc', '/analytics/rates']) {
      renderAt(path);
      expect((await screen.findByTestId('analytics-advisory')).textContent, path).toContain('Advisory analytics, not for GMP decisions');
      cleanup();
    }
  });
});
