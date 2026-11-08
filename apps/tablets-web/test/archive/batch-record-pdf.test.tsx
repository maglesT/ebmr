/**
 * Owner request (8 November 2026): one "Batch record (PDF)" button on a batch's review page and on its release page,
 * calling archive.pdf for that batch; shown only to a role the reviewed route-by-role matrix lets make that read
 * (readOffered); the /archive screen stays off. Basis: 21 CFR 211.188 and 211.180(c), EU GMP Annex 11 sections 8.1
 * and 8.2 (src/features/archive/BatchRecordPdf.tsx).
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { example } from '@ebmr/api-contract/examples';
import { apiState } from '../../src/api/client.ts';
import { screenOff } from '../../src/app/disconnected.tsx';
import { renderOffice } from '../office/support.tsx';

beforeEach(() => {
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:pdf'), revokeObjectURL: vi.fn() }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  apiState.installation = undefined;
});

const review = example('review-batch');
const lot = example('release-lot');
const pages = [
  ['review', `/review/${review.batchId}`, review.batchId],
  ['release', `/release/${lot.lotId}`, lot.batchId],
] as const;

describe('[DI-41] the batch record PDF on the review and release pages (owner request)', () => {
  it.each(pages)('[DI-41][IN-11] the %s page offers QA the batch\'s PDF/A-3 true copy and reads it for that batch', async (_page, path, batchId) => {
    const ui = renderOffice(path, { role: 'QA_REVIEWER' });
    const box = await screen.findByTestId('batch-record-pdf');
    await userEvent.click(within(box).getByRole('button', { name: 'Batch record (PDF)' }));
    await waitFor(() => expect(ui.requests.some((r) => r.method === 'GET' && r.path === `/api/archive/batches/${batchId}/pdf`)).toBe(true));
    expect(ui.requests.filter((r) => r.path.endsWith('/pdf')).every((r) => r.path === `/api/archive/batches/${batchId}/pdf`)).toBe(true);
  });

  it.each(pages)('[DI-41] the %s page shows no PDF button to a role the matrix refuses the read', async (_page, path) => {
    renderOffice(path, { role: 'EU_QP_READER', fixtures: { 'review.batch': review, 'release.lot': lot } });
    await waitFor(() => expect(screen.queryAllByRole('heading').length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('batch-record-pdf')).toBeNull();
  });

  it('[DI-41] the archive screen itself stays off where the extras are disconnected', () => {
    expect(screenOff('/archive', true, false)).toBe(true);
    expect(screenOff(`/review/${review.batchId}`, true, false)).toBe(false);
  });
});
