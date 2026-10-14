/**
 * Receipt screens (Phase 6 slice 6a, builder A; PR-17, DI-31) on the contract's examples: a delivery received with its
 * supplier batches, the approved-manufacturer register (QA proposes, approves through the ceremony, withdraws with a
 * reason), and a lot's receipt record (the issue check as the server decides it, the examination, a correction of a WMS
 * value with its reason).
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { example } from '@ebmr/api-contract/examples';
import { apiState } from '../../src/api/client.ts';
import { renderOffice } from '../office/support.tsx';

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

const register = example('quality-approved-manufacturers').manufacturers;
const incomplete = example('quality-lot-receipt-incomplete');
const blocked = example('quality-lot-receipt-blocked');

describe('receipt screens (PR-17)', () => {
  it('[PR-17] stores receive a delivery with two supplier batches: one lot each, sent with the manufacturer and containers of each', async () => {
    const ui = renderOffice('/quality/receipt', { role: 'WAREHOUSE_LABELLING' });
    const box = await screen.findByTestId('delivery-receipt');
    const type = async (label: string, value: string, scope: HTMLElement = box) => userEvent.type(within(scope).getByRole('textbox', { name: label }), value);
    await type('Delivery (goods receipt note)', 'GRN-77812');
    await type('Material code', 'MAT-PCM');
    await type('Supplier code', 'SUP-GRAN');
    await userEvent.click(within(box).getByRole('button', { name: 'Add a supplier batch' }));
    for (const [i, lot] of [[0, 'PCM2610A'], [1, 'PCM2610B']] as const) {
      const b = screen.getByTestId(`supplier-batch-${i.toString()}`);
      await type('Supplier batch number', lot, b);
      await type('Manufacturer code (from the label)', 'MFR-GRANULES', b);
      await type('Number of containers', '2', b);
      await type('Quantity', '50.000', b);
      await type('Expiry date (YYYY-MM-DD)', '2029-06-30', b);
    }
    await userEvent.click(within(box).getByRole('button', { name: 'Receive the delivery' }));
    await waitFor(() => expect(ui.posts('/api/quality/deliveries')).toHaveLength(1));
    expect(ui.posts('/api/quality/deliveries')[0]?.body).toEqual({
      deliveryId: 'GRN-77812', materialCode: 'MAT-PCM', supplierCode: 'SUP-GRAN',
      supplierBatches: ['PCM2610A', 'PCM2610B'].map((supplierLot) => ({ supplierLot, manufacturerCode: 'MFR-GRANULES', containers: '2', quantity: { value: '50.000', unit: 'kg' }, expiresAt: '2029-06-30T00:00:00+05:30' })),
    });
    // The lots the server numbered, one with its manufacturer not approved (blocked).
    const lots = await screen.findByTestId('delivery-lots');
    expect(lots.textContent).toContain('GR261014-0003');
    expect(lots.textContent).toContain('Manufacturer not approved: lot blocked');
  });

  it('[PR-17] QA keeps the approved-manufacturer register: a proposal is approved through the ceremony (MATERIAL_SOURCE_ACT), an approval is withdrawn with a reason', async () => {
    const ui = renderOffice('/quality/approved-manufacturers', { role: 'QA_REVIEWER' });
    const proposed = register.find((m) => m.state === 'PROPOSED')!;
    const row = await screen.findByTestId(`manufacturer-${proposed.approvedManufacturerId}`);
    await userEvent.click(within(row).getByRole('button', { name: `Approve ${proposed.manufacturerCode}` }));
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual({ kind: 'MATERIAL_SOURCE_ACT', act: 'MANUFACTURER_APPROVE', approvedManufacturerId: proposed.approvedManufacturerId });
    const approved = register.find((m) => m.state === 'APPROVED')!;
    const approvedRow = screen.getByTestId(`manufacturer-${approved.approvedManufacturerId}`);
    expect(approvedRow.getAttribute('data-state')).toBe('APPROVED');
    await userEvent.type(within(approvedRow).getByRole('textbox', { name: 'Reason for withdrawing' }), 'Audit found gaps');
    await userEvent.click(within(approvedRow).getByRole('button', { name: `Withdraw ${approved.manufacturerCode}` }));
    await waitFor(() => expect(ui.posts(`/api/quality/approved-manufacturers/${approved.approvedManufacturerId}/withdraw`)).toHaveLength(1));
    const box = screen.getByTestId('propose-manufacturer');
    await userEvent.type(within(box).getByRole('textbox', { name: 'Material code' }), 'MAT-PCM');
    await userEvent.type(within(box).getByRole('textbox', { name: 'Manufacturer code' }), 'MFR-NEW');
    await userEvent.type(within(box).getByRole('textbox', { name: 'Manufacturer name' }), 'New Chem');
    await userEvent.type(within(box).getByRole('textbox', { name: 'Basis of the approval (qualification or audit reference)' }), 'Audit AR-2026-12 satisfactory');
    await userEvent.click(within(box).getByRole('button', { name: 'Propose the manufacturer' }));
    await waitFor(() => expect(ui.posts('/api/quality/approved-manufacturers')).toHaveLength(1));
    expect(ui.posts('/api/quality/approved-manufacturers')[0]?.body).toEqual({ materialCode: 'MAT-PCM', manufacturerCode: 'MFR-NEW', manufacturerName: 'New Chem', basis: 'Audit AR-2026-12 satisfactory' });
  });

  it('[PR-17][DI-31] a lot\'s receipt record shows why it cannot be issued; stores examine its containers and correct a WMS value with a reason, the original kept', async () => {
    const ui = renderOffice(`/quality/lots/${incomplete.lotId}/receipt`, { role: 'WAREHOUSE_LABELLING', fixtures: { 'quality.lotReceipt': incomplete } });
    expect((await screen.findByTestId('receipt-issue')).textContent).toContain('EBMR-SITE-917');
    expect(screen.getByTestId('receipt-corrections').textContent).toContain('containers: 2 corrected to 3');
    const exam = screen.getByTestId('receipt-examine');
    await userEvent.click(within(exam).getByRole('button', { name: 'Record the examination' }));
    await waitFor(() => expect(ui.posts(`/api/lots/${incomplete.lotId}/receipt/examination`)).toHaveLength(1));
    expect(ui.posts(`/api/lots/${incomplete.lotId}/receipt/examination`)[0]?.body).toEqual({ containersExamined: '3', outcome: 'ACCEPTABLE' });
    const fix = screen.getByTestId('receipt-correct');
    await userEvent.click(within(fix).getByRole('radio', { name: 'supplierLot' }));
    await userEvent.type(within(fix).getByRole('textbox', { name: 'Corrected value' }), 'PCM2610B-1');
    await userEvent.type(within(fix).getByRole('textbox', { name: 'Reason' }), 'label reads PCM2610B-1');
    await userEvent.click(within(fix).getByRole('button', { name: 'Correct the value' }));
    await waitFor(() => expect(ui.posts(`/api/lots/${incomplete.lotId}/receipt/corrections`)).toHaveLength(1));
    expect(ui.posts(`/api/lots/${incomplete.lotId}/receipt/corrections`)[0]?.body).toEqual({ field: 'supplierLot', value: 'PCM2610B-1', reason: 'label reads PCM2610B-1' });
  });

  it('[PR-17] a lot from an unapproved manufacturer shows it blocked', async () => {
    renderOffice(`/quality/lots/${blocked.lotId}/receipt`, { role: 'QA_REVIEWER', fixtures: { 'quality.lotReceipt': blocked } });
    expect((await screen.findByTestId('receipt-issue')).textContent).toContain('EBMR-SITE-918');
    expect(screen.getByTestId('receipt-record').textContent).toContain('Not approved');
  });
});
