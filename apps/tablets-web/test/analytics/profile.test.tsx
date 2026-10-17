/**
 * Web screens of the golden batch profile (Phase 6A slice 6A-6; /analytics/profiles and the trend viewer's overlay;
 * draft controls DI-51, DI-52; DI-32; D-6A-6-8): on the contract examples, the profiles page lists the model
 * candidates with the batches they leave out and lets QA make one the reference set under a change record; the overlay
 * shows the advisory band, the band chart with the batch curve, the flags, and the samples exactly as recorded; the
 * trend viewer shows the same overlay under its chart.
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
import * as plantStatus from '../../src/features/plant-status/index.tsx';
import type { Recorded } from '../office/support.tsx';

/** The analytics and plant-status screens on the GMP examples, as `role`, recording every request. */
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
  const router = createRouter({ routeTree: root.addChildren([...analytics.routes(root), ...plantStatus.routes(root)]), history: createMemoryHistory({ initialEntries: [path] }) });
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

const profile = ANALYTICS_EXAMPLES['analytics-profile-batch'].data;
const candidates = ANALYTICS_EXAMPLES['analytics-profile-candidates'].data;
const query = `batch=${profile.batchId}&step=${profile.step}&tag=${profile.tag}`;

describe('golden batch profile screens (GMP)', () => {
  it('[DI-32] the overlay shows the raw values as recorded', async () => {
    const ui = renderOffice(`/analytics/profiles?${query}`, { role: 'QA_REVIEWER' });
    const overlay = await screen.findByTestId('profile-overlay');
    expect(ui.requests.some((r) => r.path === '/api/analytics/profiles' && r.query['batch'] === profile.batchId && r.query['tag'] === profile.tag)).toBe(true);
    // Every sample as received: source time, raw text (an exponent stays an exponent), shown decimal, status code, quality.
    const rows = within(within(overlay).getByTestId('profile-samples')).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.textContent)).toEqual(profile.samples.map((s) => `${s.sourceUs}${s.raw}${s.value ?? '(none)'}${s.statusCode}${s.quality}`));
    expect(rows.map((r) => r.textContent)).toContain('17916114020000001.35E113.50x00000000GOOD');
    expect(rows.map((r) => r.textContent)).toContain('1791611401000000NaN(none)0x80000000BAD');
    expect(within(overlay).getByText(/1 BAD dropped/)).toBeTruthy();
  });

  it('[DI-51] the profile screens show the advisory band, the method and the data age, and label every statistic', async () => {
    renderOffice(`/analytics/profiles?${query}`, { role: 'QA_REVIEWER' });
    const overlay = await screen.findByTestId('profile-overlay');
    const band = within(overlay).getByTestId('analytics-advisory');
    expect(band.textContent).toContain('Advisory analytics, not for GMP decisions');
    expect(band.textContent).toContain('Method GBP.DTW_BAND version 1.');
    expect(band.textContent).toContain(`Data age ${profile.dataAgeSeconds.toString()} s.`);
    const chart = within(overlay).getByTestId('profile-band-chart');
    expect(chart.textContent).toContain('Advisory statistics, not GMP values');
    expect(within(chart).getByTestId('profile-band')).toBeTruthy();
    expect(within(chart).getByTestId('profile-reference')).toBeTruthy();
    expect(within(chart).getByTestId('profile-curve')).toBeTruthy();
    for (const s of within(within(overlay).getByTestId('profile-stats')).getAllByTitle('Advisory, not a GMP value')) expect(s.textContent).toMatch(/\(advisory\)$/);
    expect(within(overlay).getByTestId('profile-no-flag')).toBeTruthy();
    // The page itself carries the band too (the candidates span several runs: each names its own).
    const page = screen.getAllByTestId('analytics-advisory')[0]!;
    expect(page.textContent).toContain('Each item names its own method and version.');
  });

  it('[DI-52] the candidates list the batches they leave out; QA makes one the reference set under a change record', async () => {
    const c = candidates.candidates[0]!;
    const ui = renderOffice('/analytics/profiles', { role: 'QA_REVIEWER' });
    const line = await screen.findByTestId(`profile-candidate-${c.outputId}`);
    expect(line.textContent).toContain(`${c.productCode} · ${c.familyCode} · ${c.equipmentType} · ${c.step} · ${c.tag}`);
    expect(line.textContent).toContain(`Left out: ${c.skipped[0]!.reason}`);
    expect(line.textContent).toContain('not a reference set');
    await userEvent.type(await within(line).findByLabelText(/^Change-record number/), 'CR-GBP-0001');
    await userEvent.type(within(line).getByLabelText(/^Reason/), 'Twenty released press curves');
    await userEvent.click(within(line).getByRole('button', { name: 'Make it the reference set' }));
    await waitFor(() => expect(ui.requests.some((r) => r.method === 'POST' && r.path === '/api/analytics/reference-sets')).toBe(true));
    expect(ui.requests.find((r) => r.method === 'POST')!.body).toMatchObject({
      method: 'GBP.DTW_BAND', batchIds: c.batchIds, candidateOutput: c.outputId, status: 'EFFECTIVE', changeRecord: 'CR-GBP-0001', reason: 'Twenty released press curves',
      scope: { productCode: c.productCode, familyCode: c.familyCode, equipmentType: c.equipmentType, step: c.step, tag: c.tag },
    });
  });

  it('the trend viewer shows the golden profile overlay of a batch step under its chart', async () => {
    renderOffice(`/trends?batchId=${profile.batchId}&tag=${profile.tag}&step=${profile.step}`, { role: 'QA_REVIEWER' });
    await screen.findByTestId('trend-batch');
    expect(screen.queryByTestId('profile-overlay')).toBeNull();
    await userEvent.click(await screen.findByRole('button', { name: 'Show the golden profile (advisory)' }));
    const overlay = await screen.findByTestId('profile-overlay');
    expect(within(overlay).getByTestId('analytics-advisory').textContent).toContain('not for GMP decisions');
    expect(within(overlay).getByTestId('profile-band-chart')).toBeTruthy();
  });
});
