/**
 * The trend viewer (Phase 6 slice 6b; DI-32): native series drawn from the chunks the server serves, with zoom and pan
 * over source time, for a batch (from the review) and for a unit over a window (every page by chunk number). The
 * "restored archive" case: the chunks a restored database serves are only the stored native rows (no image, no
 * aggregate), so the viewer is given exactly those and must draw, zoom and redraw them from scratch (D-P6b-L-2).
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { SeriesChunkView } from '@ebmr/api-contract';
import { example } from '@ebmr/api-contract/examples';
import { apiState } from '../../src/api/client.ts';
import { samplesOf, utcText } from '../../src/features/plant-status/TrendChart.tsx';
import { utcInputUs } from '../../src/features/plant-status/TrendsPage.tsx';
import { renderOffice } from '../office/support.tsx';

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

const base = example('equipment-data-batch-series').chunks[0]!;
const T0 = 1792000060000000n;
const sample = (dt: bigint, raw: string, value: string | null, status = '0x00000000', quality: 'GOOD' | 'UNCERTAIN' | 'BAD' = 'GOOD') => ({
  sourceTime: (T0 + dt).toString(), serverTime: null, raw, value, status, quality,
});
/** Two chunks of a batch as a restored database serves them: the stored rows, chunk 2 first. */
const restored: SeriesChunkView[] = [
  { ...base, seriesId: '0b9a2c4e-1111-4c9d-8e0f-1a2b3c4d5e6f', chunkNo: '2', fromUs: (T0 + 300_000n).toString(), toUs: (T0 + 500_000n).toString(),
    samples: [sample(300_000n, 'NaN', null, '0x80000000', 'BAD'), sample(400_000n, '12.70', '12.70'), sample(500_000n, '12.66', '12.66')] },
  { ...base, seriesId: '0b9a2c4e-2222-4c9d-8e0f-1a2b3c4d5e6f', chunkNo: '1', fromUs: T0.toString(), toUs: (T0 + 200_000n).toString(),
    samples: [sample(0n, '1.25E1', '12.50'), sample(100_000n, '12.61', '12.61', '0x40000000', 'UNCERTAIN'), sample(200_000n, '12.58', '12.58')] },
];
const BATCH = '6b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e';

describe('trend viewer (DI-32)', () => {
  it('[DI-32] trend data from a restored archive re-renders interactively', async () => {
    const path = `/trends?batchId=${BATCH}&tag=force.main_kN`;
    const ui = renderOffice(path, { role: 'QA_REVIEWER', fixtures: { 'equipmentData.batchSeries': { chunks: restored } } });
    const chart = await screen.findByTestId('trend-chart');
    expect(ui.requests.some((r) => r.path === `/api/equipment-data/batches/${BATCH}/series` && r.query['tag'] === 'force.main_kN')).toBe(true);
    // Every stored sample, in source-time order across the chunks; the BAD one is a gap in the line, not a point.
    expect(screen.getByTestId('trend-window').textContent).toContain('6 of 6 samples');
    expect(screen.getAllByTestId('trend-point')).toHaveLength(5);
    expect(screen.getAllByTestId('trend-run')).toHaveLength(2);
    const rows = within(screen.getByTestId('trend-samples')).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      `${utcText(T0)}1.25E112.500x00000000GOOD1`,
      `${utcText(T0 + 100_000n)}12.6112.610x40000000UNCERTAIN1`,
      `${utcText(T0 + 200_000n)}12.5812.580x00000000GOOD1`,
      `${utcText(T0 + 300_000n)}NaNNo value0x80000000BAD2`,
      `${utcText(T0 + 400_000n)}12.7012.700x00000000GOOD2`,
      `${utcText(T0 + 500_000n)}12.6612.660x00000000GOOD2`,
    ]);
    // Zoom in: the window halves around its middle and the chart and table show only the samples in it.
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(chart.getAttribute('data-from-us')).toBe((T0 + 125_000n).toString());
    expect(chart.getAttribute('data-to-us')).toBe((T0 + 375_000n).toString());
    expect(screen.getByTestId('trend-window').textContent).toContain('2 of 6 samples');
    expect(screen.getAllByTestId('trend-point').map((p) => p.getAttribute('data-source-time'))).toEqual([(T0 + 200_000n).toString()]);
    // Pan later, then earlier: the window keeps its span and stops at the ends of the data.
    await userEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(chart.getAttribute('data-from-us')).toBe((T0 + 250_000n).toString());
    expect(chart.getAttribute('data-to-us')).toBe((T0 + 500_000n).toString());
    expect(screen.getByRole('button', { name: 'Later' }).hasAttribute('disabled')).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Earlier' }));
    await userEvent.click(screen.getByRole('button', { name: 'Earlier' }));
    expect(chart.getAttribute('data-from-us')).toBe(T0.toString());
    // Show all: back to every sample.
    await userEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(screen.getByTestId('trend-window').textContent).toMatch(/^force\.main_kN \(kN\): 6 of 6 samples, .* \(all\)$/);
    // Opened again from scratch (another session on the restored copy): the same chart from the same rows.
    cleanup();
    renderOffice(path, { role: 'QA_REVIEWER', fixtures: { 'equipmentData.batchSeries': { chunks: restored } } });
    await screen.findByTestId('trend-chart');
    expect(screen.getAllByTestId('trend-point')).toHaveLength(5);
    expect(screen.getByTestId('trend-sample-' + T0.toString()).textContent).toContain('1.25E1');
  });

  it('[DI-32] a unit\'s window is read page by page by chunk number and drawn once every page is in', async () => {
    const [second, first] = restored as [SeriesChunkView, SeriesChunkView];
    const ui = renderOffice('/trends', {
      role: 'QA_REVIEWER',
      fixtures: { 'equipmentData.series': ({ query }: { query: Record<string, string> }) => (query['after'] === '1' ? { chunks: [second], nextAfter: null } : { chunks: [first], nextAfter: '1' }) },
    });
    await userEvent.click(await screen.findByRole('radio', { name: 'force.main_kN (kN)' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Unit code' }), 'press-01');
    await userEvent.type(screen.getByRole('textbox', { name: /^From/ }), '2026-10-14T17:00');
    await userEvent.type(screen.getByRole('textbox', { name: /^To/ }), '2026-10-14T18:00');
    await screen.findByTestId('trend-chart');
    const pages = ui.requests.filter((r) => r.path === '/api/equipment-data/series');
    expect(pages.map((r) => r.query['after'] ?? null)).toEqual([null, '1']);
    expect(pages[0]?.query).toMatchObject({ subjectKind: 'EQUIPMENT', subjectCode: 'PRESS-01', tag: 'force.main_kN', fromUs: utcInputUs('2026-10-14T17:00'), toUs: utcInputUs('2026-10-14T18:00') });
    await waitFor(() => expect(screen.getByTestId('trend-window').textContent).toContain('6 of 6 samples'));
  });

  it('[DI-32] samples are ordered by source time across chunks and times keep every microsecond', () => {
    expect(samplesOf(restored).map((s) => s.raw)).toEqual(['1.25E1', '12.61', '12.58', 'NaN', '12.70', '12.66']);
    expect(utcText(1792000060000001n)).toBe('2026-10-14T17:47:40.000001Z');
    expect(utcInputUs('2026-10-14T17:47')).toBe('1792000020000000');
    expect(utcInputUs('14/10/2026')).toBeNull();
  });
});
