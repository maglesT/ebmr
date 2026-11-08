/**
 * G2 (owner ruling, 8 November 2026): a deviation exists only for a batch record. Its record opens only from the batch
 * (/review/<batch>/deviations/<id>), only when it is one of that batch's deviations; the review page lists the batch's
 * deviations; the list across batches (/quality/deviations) stays off where the Deviations product is disconnected,
 * and no list across batches is read.
 */
import { cleanup, screen, within } from '@testing-library/react';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { example } from '@ebmr/api-contract/examples';
import { apiState } from '../../src/api/client.ts';
import { renderOffice } from '../office/support.tsx';

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

const BATCH = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e';
const listed = example('quality-deviations');
const dev = listed.deviations[0];
if (!dev) throw new Error('the deviations example has one');
const disconnected = { ...example('meta-gmp'), disconnected: true };
const crossBatch = (r: { path: string; query: Record<string, string> }): boolean => r.path === '/api/quality/deviations' && r.query['batchId'] === undefined;

describe('[DI-17][PR-49] a deviation record opens only from its batch (G2, owner ruling)', () => {
  it('[DI-17][PR-49] the batch\'s deviation record opens at the batch\'s path with the investigation, and no list across batches is read', async () => {
    const ui = renderOffice(`/review/${BATCH}/deviations/${dev.deviationId}`, { role: 'QA_REVIEWER', fixtures: { 'meta.get': disconnected, 'quality.deviations': listed, 'quality.deviation': dev } });
    expect((await screen.findAllByText(new RegExp(dev.ref))).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'Back to the batch' }).getAttribute('href')).toBe(`/review/${BATCH}`);
    expect(screen.queryByTestId('cancel-deviation')).toBeNull();
    expect(ui.requests.some((r) => r.path === '/api/quality/deviations' && r.query['batchId'] === BATCH)).toBe(true);
    expect(ui.requests.filter(crossBatch)).toEqual([]);
  });

  it('[DI-17][PR-49] a deviation that is not linked to the batch is not shown', async () => {
    renderOffice(`/review/${BATCH}/deviations/${dev.deviationId}`, { role: 'QA_REVIEWER', fixtures: { 'meta.get': disconnected, 'quality.deviations': { deviations: [] }, 'quality.deviation': dev } });
    expect(await screen.findByTestId('batch-deviation-not-this-batch')).toBeTruthy();
    expect(screen.queryByText(dev.title)).toBeNull();
  });

  it('[DI-17] outside the list screen that stays off (/quality/deviations), every read of the deviation list names one batch', () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), '../../src');
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : /\.tsx?$/.test(e.name) ? [join(d, e.name)] : []));
    const reads: string[] = [];
    for (const file of walk(src)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/useApiQuery\(routes\.quality\.deviations,([^)]*)\)/g)) reads.push(`${relative(src, file)}: ${(m[1] ?? '').includes('batchId') ? 'batch' : 'across batches'}`);
    }
    expect(reads.filter((r) => r.endsWith('across batches'))).toEqual(['features/quality/DeviationsPage.tsx: across batches']);
    expect(reads.filter((r) => r.endsWith(': batch')).length).toBeGreaterThanOrEqual(3);
  });

  it('[DI-17][PR-49] the batch review lists the batch\'s deviations, each opening as the batch\'s record', async () => {
    const review = example('review-batch');
    renderOffice(`/review/${review.batchId}`, { role: 'QA_REVIEWER', fixtures: { 'meta.get': disconnected, 'quality.deviations': listed } });
    const section = await screen.findByTestId('batch-deviations');
    const link = await within(section).findByRole('link', { name: new RegExp(dev.ref) });
    expect(link.getAttribute('href')).toBe(`/review/${review.batchId}/deviations/${dev.deviationId}`);
  });
});
