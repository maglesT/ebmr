/**
 * The full export and the periodic evaluation screens (Phase 7 slice 7g-3, WP1) on test answers: the export started
 * with a reason and followed while its job runs, each past export with its SHA-256 and manifest; the evaluation pack
 * generated for a period typed with its offset, and QA's signed sign-off.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { apiState } from '../../src/api/client.ts';
import { at, renderValidation, SHA, SHA2 } from './support.tsx';

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

const EXPORT = '6b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e';
const PACK = 'c0ffee00-1234-4abc-8def-0123456789ab';
const job = (state: 'IDLE' | 'RUNNING' | 'DONE' | 'FAILED', step: string | null = null) => ({ state, step, error: null, elapsedSeconds: state === 'IDLE' ? null : '2' });
const exported = { exportId: EXPORT, manifestSha256: SHA, recordCount: '12', fileCount: '40', by: 'Kavya Iyer', at: at('1760000000000001') };

describe('the full export', () => {
  it('[DI-08] lists each export with its SHA-256; one is started with a reason and followed until its job has ended', async () => {
    let calls = 0;
    const ui = renderValidation('/validation/full-export', {
      fixtures: {
        'validation.fullExports': () => (++calls < 3 ? { exports: [], job: calls === 1 ? job('IDLE') : job('RUNNING', 'exporting the closed records'), folder: '/var/ebmr/exports' } : { exports: [exported], job: job('DONE', 'done'), folder: '/var/ebmr/exports' }),
        'validation.startFullExport': { job: job('RUNNING', 'starting') },
        'validation.fullExportManifest': { exportId: EXPORT, manifestSha256: SHA, manifest: '{"format":"ebmr.full-export/1"}' },
      },
    });
    expect((await screen.findByTestId('full-export-job')).getAttribute('data-state')).toBe('IDLE');
    const start = screen.getByRole('button', { name: 'Start the full export' });
    expect(start.hasAttribute('disabled')).toBe(true);
    await userEvent.type(screen.getByRole('textbox', { name: 'Reason (recorded)' }), 'supplier exit test');
    await userEvent.click(start);
    await waitFor(() => expect(ui.posts('/api/validation/full-exports')).toHaveLength(1));
    expect(ui.posts('/api/validation/full-exports')[0]?.body).toEqual({ reason: 'supplier exit test' });
    const row = await screen.findByTestId(`full-export-${EXPORT}`, {}, { timeout: 6000 });
    expect(row.textContent).toContain(SHA);
    expect(row.textContent).toContain('12 closed records, 40 files');
    await userEvent.click(within(row).getByRole('button', { name: 'Download the manifest' }));
    await waitFor(() => expect(within(row).getByRole('link', { name: `Save manifest-${EXPORT}.json` })).toBeTruthy());
  });
});

describe('the periodic evaluation', () => {
  const pack = (approval: unknown = null) => ({
    packId: PACK, packSha256: SHA2, periodFrom: at('1760000000000002'), periodTo: at('1760000000000003'), entryCount: '57', sampleCount: '3', unreadableCount: '0',
    readabilitySeed: 'Q3-2026', sampleSize: '3', generatedBy: 'Kavya Iyer', at: at('1760000000000004'), approval,
  });

  it('[DI-11][DI-44] a pack is generated for a period typed with its offset, a seed and a sample size', async () => {
    const ui = renderValidation('/validation/evaluation-packs', { fixtures: { 'validation.evaluationPacks': { packs: [] }, 'validation.runEvaluationPack': pack() } });
    await screen.findByTestId('evaluation-run');
    const button = screen.getByRole('button', { name: 'Generate the evaluation pack' });
    await userEvent.type(screen.getByRole('textbox', { name: 'Period from (e.g. 2026-09-01T00:00+05:30)' }), '2026-07-01T00:00+05:30');
    await userEvent.type(screen.getByRole('textbox', { name: 'Period to (e.g. 2026-10-01T00:00+05:30)' }), '2026-10-01');
    await userEvent.type(screen.getByRole('textbox', { name: 'Readability sample seed' }), 'Q3-2026');
    expect(button.hasAttribute('disabled')).toBe(true);
    await userEvent.type(screen.getByRole('textbox', { name: 'Period to (e.g. 2026-10-01T00:00+05:30)' }), 'T00:00+05:30');
    await userEvent.click(button);
    await waitFor(() => expect(ui.posts('/api/validation/evaluation-packs')).toHaveLength(1));
    expect(ui.posts('/api/validation/evaluation-packs')[0]?.body).toEqual({ from: '2026-07-01T00:00:00+05:30', to: '2026-10-01T00:00:00+05:30', seed: 'Q3-2026', sampleSize: '10' });
    expect((await screen.findByText(/Pack stored: 57 entries, 3 records sampled, 0 unreadable/)).textContent).toBeTruthy();
  });

  it('[DI-11][DI-37] QA signs off a stored pack; a signed-off pack is not offered again', async () => {
    const ui = renderValidation('/validation/evaluation-packs', { fixtures: { 'validation.evaluationPacks': { packs: [pack()] } } });
    const row = await screen.findByTestId(`pack-${PACK}`);
    expect(row.getAttribute('data-state')).toBe('STORED');
    expect(row.textContent).toContain(SHA2);
    await userEvent.click(within(row).getByRole('button', { name: 'Sign off the pack (signature)' }));
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual({ kind: 'EVALUATION_PACK_APPROVE', packId: PACK });
    cleanup();
    renderValidation('/validation/evaluation-packs', { fixtures: { 'validation.evaluationPacks': { packs: [pack({ approvedBy: 'Divya Menon', at: at('1760000000000005'), signatureId: EXPORT })] } } });
    const signed = await screen.findByTestId(`pack-${PACK}`);
    expect(signed.textContent).toContain('Signed off by Divya Menon');
    expect(within(signed).queryByRole('button', { name: 'Sign off the pack (signature)' })).toBeNull();
  });
});
