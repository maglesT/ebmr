/**
 * R13 (owner's rabeprazole demo, 25 October 2026): a lot's potency on screen for anyone who sees the lot, QC's guided page
 * to change it by approved results (never typed), and the preview of what TB-01 will calculate at the lot's reservation.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { LotResultView, RouteResponse, routes } from '@ebmr/api-contract';
import { example } from '@ebmr/api-contract/examples';
import { apiState } from '../../src/api/client.ts';
import { renderOffice } from '../office/support.tsx';

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

const at = (text: string) => ({ us: '1792300000000000', text });
const base = example('quality-lots').lots[0];
if (!base) throw new Error('no lot example');
const lotPath = `/quality/lots/${base.lotId}`;
const quality: RouteResponse<typeof routes.execution.lotQuality> = {
  lotCode: base.lotCode,
  assay: {
    basis: 'ANHYDROUS_WATER',
    assay: '99.4',
    water: '0.6',
    lod: null,
    solvents: null,
    certificateRef: 'LIMS-RAB-0001',
    recordedAt: at('20-OCT-2026 10:00'),
    asIs: '98.8036',
    usable: true,
    sources: [
      { value: 'assay', resultId: '5d1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d01', testCode: 'ASSAY', result: '99.4', unit: '%', state: 'APPROVED' },
      { value: 'water', resultId: '5d1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d02', testCode: 'WATER', result: '0.6', unit: '%', state: 'APPROVED' },
    ],
  },
  artwork: null,
  history: [
    { basis: 'ANHYDROUS_WATER', assay: '99.4', water: '0.6', lod: null, solvents: null, asIs: '98.8036', certificateRef: 'LIMS-RAB-0001', reason: 'Re-assay at retest', by: 'Meera Iyer', recordedAt: at('20-OCT-2026 10:00'), current: true },
    { basis: 'ANHYDROUS_WATER', assay: '99.0', water: '0.5', lod: null, solvents: null, asIs: '98.505', certificateRef: 'COA-RAB-0001', reason: null, by: 'Meera Iyer', recordedAt: at('01-OCT-2026 09:00'), current: false },
  ],
};
const result = (resultId: string, testCode: string, value: string): LotResultView => ({ resultId, testCode, methodReference: 'STP-TEST-01', purpose: 'RETEST', value, unit: '%', lowerLimit: null, upperLimit: null, verdict: 'PASS', state: 'APPROVED' });
const NEW_ASSAY = '6d1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d01';
const NEW_WATER = '6d1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d02';

describe('R13: the potency of a lot', () => {
  it('[PR-19][DI-33] the lot shows its as-is potency, the approved results it came from and who changed it when and why; only QC is offered the change', async () => {
    renderOffice(lotPath, { role: 'WAREHOUSE_LABELLING', fixtures: { 'quality.lots': { lots: [base] }, 'quality.lotResults': { results: [] }, 'execution.lotQuality': quality } });
    const section = await screen.findByTestId('lot-potency');
    expect((await within(section).findByTestId('lot-potency-current')).textContent).toMatch(/As-is potency 98\.8036 %.*assay 99\.4 %, water 0\.6 %.*anhydrous/);
    expect(within(section).getByTestId('lot-potency-sources').textContent).toBe('From the approved results: ASSAY 99.4 % (approved), WATER 0.6 % (approved)');
    const rows = within(within(section).getByTestId('lot-potency-history')).getAllByRole('row');
    expect(rows[1]?.textContent).toMatch(/Meera Iyer.*98\.8036 %.*Re-assay at retest/);
    expect(rows[2]?.textContent).toMatch(/98\.505 %.*first result/);
    expect(screen.queryByTestId('update-potency')).toBeNull();
  });

  it('[PR-19][DI-33][DI-22] QC changes the potency on the guided page by choosing approved results and giving a reason; nothing is typed', async () => {
    const ui = renderOffice(`${lotPath}/potency`, {
      role: 'QC_ANALYST',
      fixtures: {
        'quality.lots': { lots: [base] },
        'quality.lotResults': { results: [result(NEW_ASSAY, 'ASSAY', '99.8'), result(NEW_WATER, 'WATER', '0.4')] },
        'execution.lotQuality': quality,
        'execution.recordLotAssay': quality,
      },
    });
    expect((await screen.findByTestId('potency-how')).textContent).toContain('nobody types a potency');
    const form = await screen.findByRole('form', { name: `New potency of lot ${base.lotCode}` });
    expect(within(form).queryByRole('textbox', { name: /assay|potency/i })).toBeNull();
    await userEvent.click(within(form).getByRole('radio', { name: 'ASSAY 99.8 % (RETEST)' }));
    await userEvent.click(within(form).getByRole('radio', { name: 'WATER 0.4 % (RETEST)' }));
    await userEvent.type(within(form).getByRole('textbox', { name: 'Certificate or result reference' }), 'LIMS-RAB-0002');
    const save = within(form).getByRole('button', { name: 'Save the new potency' });
    expect(save.hasAttribute('disabled')).toBe(true);
    await userEvent.type(within(form).getByRole('textbox', { name: 'Reason for the change' }), 'Re-assay at retest');
    await userEvent.click(save);
    await waitFor(() => expect(ui.posts(`/api/lots/${base.lotCode}/assay`)).toHaveLength(1));
    expect(ui.posts(`/api/lots/${base.lotCode}/assay`)[0]?.body).toEqual({ basis: 'ANHYDROUS_WATER', assayResultId: NEW_ASSAY, waterResultId: NEW_WATER, certificateRef: 'LIMS-RAB-0002', reason: 'Re-assay at retest' });
  });

  it('[PR-19] reserving the lot for a batch previews what the batch\'s potency-adjusted dispensing will calculate with it, marked as a preview', async () => {
    const listed = example('batches-list').batches[0];
    if (!listed) throw new Error('no batch example');
    const batches = { batches: [{ ...listed, batchNumber: 'RAB26004', status: 'ISSUED' as const }] };
    const preview = example('batches-potency-preview');
    renderOffice(lotPath, {
      role: 'WAREHOUSE_LABELLING',
      fixtures: { 'quality.lots': { lots: [base] }, 'quality.lotResults': { results: [] }, 'quality.lotHandling': { lotId: base.lotId, destruction: null, witness: null, reservations: [], locationExceptions: [] }, 'batches.list': batches, 'batches.potencyPreview': preview, 'execution.lotQuality': quality },
    });
    const form = await screen.findByTestId('reserve-lot');
    expect(within(form).queryByTestId('potency-preview')).toBeNull();
    await userEvent.click(await within(form).findByRole('radio', { name: /^RAB26004/ }));
    const p = await within(form).findByTestId('potency-preview');
    expect(p.textContent).toContain('preview: the weighing step recalculates');
    expect(within(p).getByTestId('potency-preview-lot-RAB-API-0001').textContent).toBe('Lot RAB-API-0001: as-is potency 98.8036 % → Rabeprazole sodium (MAT-RAB) 3.037 kg; Microcrystalline cellulose (MAT-MCC) 4.464 kg');
  });
});
