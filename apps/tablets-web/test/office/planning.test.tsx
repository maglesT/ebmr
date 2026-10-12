/** Planning screens (Phase 3 slice 6): orders with their match or the server's reason, plan, issue through the ceremony. */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { example } from '@ebmr/api-contract/examples';
import { apiState } from '../../src/api/client.ts';
import { refusal, renderOffice } from './support.tsx';

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

const planned = {
  batchId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
  batchNumber: 'B26-0101',
  familyCode: 'GBT01-WG',
  product: { code: 'GBT01', name: 'GB-T-01', strength: '500 mg' },
  versionNumber: '1.0',
  contentHash: 'a'.repeat(64),
  markets: ['IN'],
  site: 'SITE-1',
  line: 'LINE-1',
  batchSize: '200000',
  controlRecipeId: 'c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f',
  variants: [],
  inputs: [],
};

describe('planning', () => {
  it('lists the orders with their matching MBR, or the server\'s reason none matches', async () => {
    renderOffice('/planning', { role: 'BATCH_ISSUER' });
    const matched = await screen.findByTestId('order-PO-2026-0101');
    expect(within(matched).getByTestId('match').textContent).toContain('GBT01-WG version 1.0');
    const unmatched = screen.getByTestId('order-PO-2026-0102');
    expect(unmatched.textContent).toContain(example('planning-orders').orders[1]?.noMatch ?? 'missing');
  });

  it('plans a batch from an order and issues it with the ISSUED ceremony and the issuer\'s own reason', async () => {
    const ui = renderOffice('/planning', { role: 'BATCH_ISSUER', fixtures: { 'execution.planBatch': planned, 'plant.areas': { areas: [] } } });
    const order = await screen.findByTestId('order-PO-2026-0101');
    await userEvent.type(within(order).getByRole('textbox', { name: 'Site' }), 'SITE-1');
    await userEvent.type(within(order).getByRole('textbox', { name: 'Line' }), 'LINE-1');
    await userEvent.click(within(order).getByRole('button', { name: 'Plan a batch for PO-2026-0101' }));
    await waitFor(() => expect(ui.posts('/api/batches')).toHaveLength(1));
    const match = example('planning-orders').orders[0]?.match;
    expect(ui.posts('/api/batches')[0]?.body).toEqual({ familyId: match?.familyId, markets: ['IN'], site: 'SITE-1', line: 'LINE-1', batchSize: match?.batchSizeId });
    const issue = await screen.findByTestId('issue-form');
    const sign = within(issue).getByRole('button', { name: 'Sign and issue' });
    expect(sign.hasAttribute('disabled')).toBe(true);
    await userEvent.type(within(issue).getByRole('textbox', { name: 'Reason code' }), 'PLAN');
    await userEvent.type(within(issue).getByRole('textbox', { name: 'Reason' }), 'Order PO-2026-0101 due this week');
    await userEvent.click(sign);
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.posts('/api/esig/describe')[0]?.body).toEqual({ action: { kind: 'GMP_BATCH_ISSUE', batchId: planned.batchId, reason: { code: 'PLAN', text: 'Order PO-2026-0101 due this week' }, variants: {}, inputs: {} } });
    expect(ui.ceremony.sign.mock.calls[0]?.[0]).toMatchObject({ aggregateType: 'test_aggregate', meaning: 'TEST_MEANING', action: { kind: 'GMP_BATCH_ISSUE' } });
  });

  it('a refused plan is shown with the server\'s words', async () => {
    renderOffice('/planning', { role: 'BATCH_ISSUER', fixtures: { 'execution.planBatch': refusal('EBMR-EXE-200', 'The batch size is not an approved size.', 'PR-01'), 'plant.areas': { areas: [] } } });
    const order = await screen.findByTestId('order-PO-2026-0101');
    await userEvent.type(within(order).getByRole('textbox', { name: 'Site' }), 'SITE-1');
    await userEvent.type(within(order).getByRole('textbox', { name: 'Line' }), 'LINE-1');
    await userEvent.click(within(order).getByRole('button', { name: 'Plan a batch for PO-2026-0101' }));
    expect(await screen.findByText('The batch size is not an approved size.')).toBeTruthy();
  });

  it('an operator is not offered planning', async () => {
    renderOffice('/planning', { role: 'OPERATOR' });
    await screen.findByTestId('order-PO-2026-0101');
    expect(screen.queryByTestId('plan-form')).toBeNull();
  });

  it('the batch list shows each batch with its state', async () => {
    renderOffice('/planning/batches');
    const first = example('batches-list').batches[0];
    const row = await screen.findByTestId(`batch-${first?.batchNumber ?? ''}`);
    expect(row.textContent).toContain(first?.statusText ?? 'missing');
  });
});
