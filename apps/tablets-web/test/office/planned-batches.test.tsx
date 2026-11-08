/**
 * A planned batch is issued from any session (owner report item 14, G4): an order card lists each batch planned and not
 * yet issued, and its issue form opens from the server's record of it (execution.plannedBatch), not only right after
 * "Plan a batch" in the same browser session.
 */
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { example } from '@ebmr/api-contract/examples';
import { renderOffice } from './support.tsx';

afterEach(() => cleanup());

describe('planned batches on the planning page (G4)', () => {
  it('[IN-18][DI-17] after a reload, an order\'s planned batch offers its issue; the issue form opens from the planned batch the server reads back, and no second plan is offered', async () => {
    const orders = example('planning-orders');
    const order = orders.orders.find((o) => o.match?.recordKind !== 'PACKAGING' && o.match !== null) ?? orders.orders[0]!;
    const planned = { ...example('planning-plan-packaging-order'), batchNumber: 'MGL260001' };
    const withPlanned = { orders: orders.orders.map((o) => (o.orderNo === order.orderNo ? { ...o, batches: [{ batchId: planned.batchId, batchNumber: 'MGL260001', status: 'PLANNED' }] } : o)) };
    const ui = renderOffice('/planning', { role: 'BATCH_ISSUER', fixtures: { 'plant.areas': { areas: [] }, 'planning.orders': withPlanned, 'execution.plannedBatch': planned } });
    const card = await screen.findByTestId(`order-${order.orderNo}`);
    expect(within(card).queryByTestId('plan-form')).toBeNull();
    const row = within(card).getByTestId('planned-MGL260001');
    await userEvent.click(within(row).getByRole('button', { name: 'Issue MGL260001' }));
    expect(within(await within(row).findByTestId('issue-form')).getByRole('heading').textContent).toContain('MGL260001');
    expect(ui.requests.some((r) => r.method === 'GET' && r.path === `/api/batches/${planned.batchId}/planned`)).toBe(true);
  });
});
