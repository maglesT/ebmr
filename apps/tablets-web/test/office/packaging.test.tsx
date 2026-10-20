/**
 * Packaging-order screens (Phase 4 slice 2c): planning a packaging order from its ERP order and the processing batch it
 * packs, the site's packaging orders, and the bulk issue of one order. Every reason shown is the server's; the screen
 * sends the person's choice and nothing it computed.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { example } from '@ebmr/api-contract/examples';
import { apiState } from '../../src/api/client.ts';
import { refusal, renderOffice, TAPPED } from './support.tsx';

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

const PACK_ORDER = 'PO-2026-0103';
const bulk = example('planning-packaging-bulk');
const BULK_PATH = `/api/batches/${bulk.batchId}/bulk`;
const issued = { batchId: bulk.batchId, parentBatchId: bulk.parent?.batchId ?? '', containers: [{ label: 'OC-G2600001-1002', containerId: '2e9d7c4f-5a81-4dae-8fb0-718293041526', quantity: '24.800', unit: 'kg' as const }] };

describe('planning a packaging order', () => {
  it('a packaging order\'s card names its pack type and the processing batches it may pack, each with the server\'s reason it is not released for packing yet', async () => {
    renderOffice('/planning', { role: 'BATCH_ISSUER', fixtures: { 'plant.areas': { areas: [] } } });
    const card = await screen.findByTestId(`order-${PACK_ORDER}`);
    expect(within(card).getByTestId('match').textContent).toContain('packaging order, pack type ALU-PVC-BLISTER');
    const form = within(card).getByTestId('packaging-plan-form');
    expect(within(form).getByTestId('parent-G2600001').textContent).toContain('Released for packing.');
    expect(within(form).getByTestId('parent-G2600002').textContent).toContain('Not released for packing yet: QA has not signed its release for packing (H-PACK) APPROVED');
    // A processing order keeps its own form.
    expect(within(screen.getByTestId('order-PO-2026-0101')).queryByTestId('packaging-plan-form')).toBeNull();
  });

  it('plans the packaging order of the chosen processing batch with the approved pack size and the ERP order, then offers its issue', async () => {
    const ui = renderOffice('/planning', { role: 'BATCH_ISSUER', fixtures: { 'plant.areas': { areas: [] } } });
    const form = within(await screen.findByTestId(`order-${PACK_ORDER}`)).getByTestId('packaging-plan-form');
    const plan = within(form).getByRole('button', { name: `Plan a packaging order for ${PACK_ORDER}` });
    await userEvent.type(within(form).getByRole('textbox', { name: 'Site' }), 'SITE-1');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Line' }), 'PL1');
    expect(plan.hasAttribute('disabled')).toBe(true);
    await userEvent.click(within(within(form).getByTestId('parent-G2600001')).getByRole('radio'));
    await userEvent.click(plan);
    await waitFor(() => expect(ui.posts('/api/planning/packaging-orders')).toHaveLength(1));
    const match = example('planning-orders').orders.find((o) => o.orderNo === PACK_ORDER)?.match;
    expect(ui.posts('/api/planning/packaging-orders')[0]?.body).toEqual({
      familyId: match?.familyId, parentBatchId: match?.parents[0]?.batchId, markets: ['IN'], site: 'SITE-1', line: 'PL1', batchSize: 'PO-20K', erpOrder: PACK_ORDER,
    });
    expect(ui.posts('/api/batches')).toHaveLength(0);
    expect(within(await screen.findByTestId('issue-form')).getByRole('heading').textContent).toContain(example('planning-plan-packaging-order').batchNumber);
  });

  // Slice 7h (gap report D2): an order whose step prints variable data packs for one market (PR-36).
  it('[PR-36] the issuer narrows the markets the order packs for to those chosen, of the ones the master is authorised for; none chosen cannot be planned', async () => {
    const orders = example('planning-orders');
    const three = { orders: orders.orders.map((o) => (o.orderNo === PACK_ORDER && o.match ? { ...o, match: { ...o.match, markets: ['IN', 'US', 'EU'] } } : o)) };
    const ui = renderOffice('/planning', { role: 'BATCH_ISSUER', fixtures: { 'plant.areas': { areas: [] }, 'planning.orders': three } });
    const form = within(await screen.findByTestId(`order-${PACK_ORDER}`)).getByTestId('packaging-plan-form');
    const plan = within(form).getByRole('button', { name: `Plan a packaging order for ${PACK_ORDER}` });
    await userEvent.type(within(form).getByRole('textbox', { name: 'Site' }), 'SITE-1');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Line' }), 'PL1');
    await userEvent.click(within(within(form).getByTestId('parent-G2600001')).getByRole('radio'));
    const markets = within(form).getByTestId('packaging-markets');
    for (const m of ['IN', 'US', 'EU']) expect(within(markets).getByRole('checkbox', { name: m })).toHaveProperty('checked', true);
    for (const m of ['IN', 'US', 'EU']) await userEvent.click(within(markets).getByRole('checkbox', { name: m }));
    expect(plan.hasAttribute('disabled')).toBe(true);
    await userEvent.click(within(markets).getByRole('checkbox', { name: 'IN' }));
    await userEvent.click(plan);
    await waitFor(() => expect(ui.posts('/api/planning/packaging-orders')).toHaveLength(1));
    expect(ui.posts('/api/planning/packaging-orders')[0]?.body).toMatchObject({ markets: ['IN'], erpOrder: PACK_ORDER });
  });

  it('a refused plan is shown with the server\'s words (a master without its secondary packaging step)', async () => {
    renderOffice('/planning', {
      role: 'BATCH_ISSUER',
      fixtures: { 'plant.areas': { areas: [] }, 'planning.planPackagingOrder': refusal('EBMR-PLN-005', 'The packaging order cannot be planned.', 'its procedure has no TB-24 step') },
    });
    const form = within(await screen.findByTestId(`order-${PACK_ORDER}`)).getByTestId('packaging-plan-form');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Site' }), 'SITE-1');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Line' }), 'PL1');
    await userEvent.click(within(within(form).getByTestId('parent-G2600001')).getByRole('radio'));
    await userEvent.click(within(form).getByRole('button', { name: `Plan a packaging order for ${PACK_ORDER}` }));
    expect(await screen.findByText('The packaging order cannot be planned.')).toBeTruthy();
    expect(screen.queryByTestId('issue-form')).toBeNull();
  });
});

describe('packaging orders and their bulk', () => {
  it('lists the site\'s packaging orders with the processing batch, its release for packing and the bulk issued', async () => {
    renderOffice('/planning/packaging', { role: 'BATCH_ISSUER' });
    const [first, second] = example('planning-packaging-orders').orders;
    const row = await screen.findByTestId(`packaging-order-${first?.batchNumber ?? ''}`);
    expect(row.textContent).toContain('ALU-PVC-BLISTER');
    expect(row.textContent).toContain('Released for packing');
    expect(screen.getByTestId(`packaging-order-${second?.batchNumber ?? ''}`).textContent).toContain(`Not yet: ${second?.releaseForPackingProblem ?? 'missing'}`);
  });

  it('shows the bulk issued and each container of the processing batch with the server\'s reason it cannot be issued; only the usable ones can be chosen', async () => {
    renderOffice(`/planning/packaging/${bulk.batchId}`, { role: 'OPERATOR' });
    const issuedList = await screen.findByTestId('bulk-issued');
    expect(issuedList.textContent).toContain('OC-G2600001-1001: 25.500 kg, issued by Omar Operator');
    const free = screen.getByTestId('bulk-container-OC-G2600001-1002');
    expect(await within(free).findByRole('checkbox')).toBeTruthy();
    const held = screen.getByTestId('bulk-container-OC-G2600001-1003');
    expect(within(held).queryByRole('checkbox')).toBeNull();
    expect(held.textContent).toContain('cannot be issued: container OC-G2600001-1003 is HELD');
    expect(within(screen.getByTestId('bulk-container-OC-G2600001-1001')).queryByRole('checkbox')).toBeNull();
  });

  it('issues the chosen containers by their labels, on a shared terminal with a fresh badge tap, and reads the order again', async () => {
    const ui = renderOffice(`/planning/packaging/${bulk.batchId}`, { role: 'OPERATOR', attribution: 'TAP', fixtures: { 'batches.issueBulk': issued } });
    const button = await screen.findByRole('button', { name: 'Issue 0 containers' });
    expect(button.hasAttribute('disabled')).toBe(true);
    await userEvent.click(within(screen.getByTestId('bulk-container-OC-G2600001-1002')).getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'Issue 1 container' }));
    await waitFor(() => expect(ui.posts(BULK_PATH)).toHaveLength(1));
    expect(ui.posts(BULK_PATH)[0]?.body).toEqual({ labels: ['OC-G2600001-1002'], attribution: TAPPED });
    expect(ui.tap.requestTap).toHaveBeenCalledWith('issuing bulk to the packaging order', { method: 'POST', path: BULK_PATH, body: { labels: ['OC-G2600001-1002'] } });
    expect(await screen.findByText('Bulk issued.')).toBeTruthy();
    await waitFor(() => expect(ui.requests.filter((r) => r.method === 'GET' && r.path === `/api/planning/packaging-orders/${bulk.batchId}/bulk`).length).toBeGreaterThan(1));
  });

  it('a refused issue is shown with the server\'s words', async () => {
    renderOffice(`/planning/packaging/${bulk.batchId}`, { role: 'OPERATOR', fixtures: { 'batches.issueBulk': refusal('EBMR-PKG-005', 'Container OC-G2600001-1002 cannot be issued for packing.', 'it is HELD') } });
    await userEvent.click(await within(await screen.findByTestId('bulk-container-OC-G2600001-1002')).findByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'Issue 1 container' }));
    expect(await screen.findByText('Container OC-G2600001-1002 cannot be issued for packing.')).toBeTruthy();
  });

  it('a processing batch not released for packing offers no issue and says why, in the server\'s words', async () => {
    const waiting = { ...bulk, parent: { batchId: bulk.parent?.batchId ?? '', batchNumber: 'G2600001', releaseForPackingProblem: 'QA has not signed its release for packing (H-PACK) APPROVED' } };
    renderOffice(`/planning/packaging/${bulk.batchId}`, { role: 'OPERATOR', fixtures: { 'planning.packagingBulk': waiting } });
    expect(await screen.findByText('QA has not signed its release for packing (H-PACK) APPROVED')).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Issue / })).toBeNull();
  });
});
