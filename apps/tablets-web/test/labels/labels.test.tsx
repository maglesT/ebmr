/**
 * The label and serialisation screens (Phase 6 slice 6c; IN-16, IN-31, PR-16, PR-32, PR-34, PR-36, PR-42) on the
 * contract's examples. Every value and gate is the server's: the screens show the database's words and post what the
 * person typed or chose, nothing computed.
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

const packaging = example('labels-packaging');
const stopped = example('labels-packaging-stopped');
const noMfg = example('labels-template-no-mfg');
const templates = example('labels-templates');

describe('label and serialisation screens', () => {
  it('[IN-31] a draft India template shows why it cannot be approved (the database\'s words) and QA\'s approve button waits; the designer\'s screen names the India particulars not placed yet', async () => {
    renderOffice('/labels/templates', { role: 'QA_MBR_APPROVER', fixtures: { 'labels.templates': { templates: [...templates.templates.filter((t) => t.templateId !== noMfg.templateId), noMfg] } } });
    expect((await screen.findByTestId(`label-template-problem-${noMfg.ref}`)).textContent).toContain(noMfg.approvalProblem ?? '');
    const row = screen.getByTestId(`label-template-${noMfg.ref}`);
    expect(within(row).getByRole('button', { name: `Approve ${noMfg.ref}` }).hasAttribute('disabled')).toBe(true);
    cleanup();
    renderOffice('/labels/templates', { role: 'MBR_AUTHOR' });
    const designer = await screen.findByTestId('label-designer');
    expect((await within(designer).findByTestId('label-designer-missing')).textContent).toContain('Mfg date');
  });

  it('[IN-16] the packaging page offers the next coding specimen in order and posts what the operator read off it; [PR-16] it lists every printed item without its label specimen', async () => {
    const ui = renderOffice(`/labels/packaging/${packaging.batchId}`, { role: 'OPERATOR' });
    const form = await screen.findByTestId('coding-specimen-form');
    expect(form.textContent).toContain('middle');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Batch number on the specimen' }), 'PK26-0012');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Manufacture date on the specimen (YYYY-MM-DD)' }), '2026-10-01');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Expiry on the specimen (YYYY-MM)' }), '2028-09');
    await userEvent.click(within(form).getByRole('button', { name: 'Record the middle specimen' }));
    const path = `/api/labels/batches/${packaging.batchId}/steps/${encodeURIComponent('p-g21@')}/coding-specimens`;
    await waitFor(() => expect(ui.posts(path)).toHaveLength(1));
    expect(ui.posts(path)[0]?.body).toEqual({ position: 'MIDDLE', coded: { batch: 'PK26-0012', mfgDate: '2026-10-01', expiryDate: '2028-09' } });
    for (const item of ['LABEL', 'CARTON']) expect(screen.getByTestId(`label-specimen-${item}`).textContent).toContain('missing');
    expect(screen.getByTestId('packaging-completion-problem').textContent).toBe(packaging.completionProblem);
  });

  it('[PR-34] the post-use inspection posts the four answers the person gave; [PR-36] an open line stop shows and QA resolves it with a reason', async () => {
    const ui = renderOffice(`/labels/packaging/${stopped.batchId}`, { role: 'OPERATOR', fixtures: { 'labels.packaging': stopped } });
    const form = await screen.findByTestId('post-use-form');
    for (const label of ['No printed material of the order is left on the line', 'No product of the order is left on the line', 'No documents of the order are left on the line']) {
      await userEvent.click(within(within(form).getByRole('radiogroup', { name: label })).getByRole('radio', { name: 'Yes' }));
    }
    const record = within(form).getByRole('button', { name: 'Record the post-use inspection' });
    expect(record.hasAttribute('disabled')).toBe(true);
    await userEvent.click(within(within(form).getByRole('radiogroup', { name: 'The line is clean' })).getByRole('radio', { name: 'No' }));
    await userEvent.click(record);
    await waitFor(() => expect(ui.posts(`/api/labels/batches/${stopped.batchId}/post-use-inspections`)).toHaveLength(1));
    expect(ui.posts(`/api/labels/batches/${stopped.batchId}/post-use-inspections`)[0]?.body).toEqual({ checks: { noPrintedMaterial: true, noProduct: true, noDocuments: true, lineClean: false } });
    const stop = stopped.lineStops[0]!;
    expect(screen.getByTestId(`line-stop-${stop.stopId}`).getAttribute('data-open')).toBe('true');
    expect(within(screen.getByTestId(`line-stop-${stop.stopId}`)).queryByRole('button', { name: 'Resolve the line stop' })).toBeNull();
    cleanup();
    const qa = renderOffice(`/labels/packaging/${stopped.batchId}`, { role: 'QA_SHOP_FLOOR', fixtures: { 'labels.packaging': stopped } });
    const row = await screen.findByTestId(`line-stop-${stop.stopId}`);
    await userEvent.type(await within(row).findByRole('textbox', { name: 'What was found and corrected' }), 'Coder buffer held last month\'s expiry; cleared and re-loaded');
    await userEvent.click(within(row).getByRole('button', { name: 'Resolve the line stop' }));
    await waitFor(() => expect(qa.posts(`/api/labels/line-stops/${stop.stopId}/resolution`)).toHaveLength(1));
  });

  it('[PR-42] the serial lookup shows the record\'s lot, expiry and status; the pools of an order show a stale L3 mirror and why release waits', async () => {
    const lookup = example('serialisation-serial');
    renderOffice('/serialisation/serials', { role: 'QA_REVIEWER' });
    await userEvent.type(await screen.findByRole('textbox', { name: 'Serial number' }), lookup.serial);
    await userEvent.click(screen.getByRole('button', { name: 'Look up' }));
    expect((await screen.findByTestId('serial-lot')).textContent).toBe(lookup.lot);
    expect(screen.getByTestId('serial-expiry').textContent).toBe(lookup.expiry);
    expect(screen.getByTestId('serial-status').textContent).toBe('Commissioned');
    cleanup();
    const stale = example('serialisation-batch-pools-stale');
    renderOffice(`/serialisation/batches/${stale.batchId}`, { role: 'QA_REVIEWER', fixtures: { 'serialisation.batchPools': stale } });
    expect((await screen.findByTestId('l3-mirror')).getAttribute('data-stale')).toBe('true');
    expect(screen.getByText(`Release waits: ${stale.releaseProblem ?? ''}`)).toBeTruthy();
  });

  it('[PR-32] the label store offers its transactions to the label store only and posts what was entered', async () => {
    const store = example('labels-store');
    renderOffice(`/labels/store?lot=${store.lotId}`, { role: 'OPERATOR' });
    expect((await screen.findByTestId('label-store-balance')).textContent).toBe(store.balance);
    expect(screen.queryByTestId('label-store-transaction')).toBeNull();
    cleanup();
    const ui = renderOffice(`/labels/store?lot=${store.lotId}`, { role: 'WAREHOUSE_LABELLING' });
    const form = await screen.findByTestId('label-store-transaction');
    await userEvent.click(within(form).getByRole('radio', { name: 'Issue' }));
    await userEvent.type(within(form).getByRole('textbox', { name: 'Units' }), '500');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Packaging order (batch number)' }), 'PK26-0012');
    await userEvent.click(within(form).getByRole('button', { name: 'Record the transaction' }));
    await waitFor(() => expect(ui.posts('/api/labels/store/transactions')).toHaveLength(1));
    expect(ui.posts('/api/labels/store/transactions')[0]?.body).toEqual({ kind: 'ISSUE', lotId: store.lotId, quantity: '500', batchRef: 'PK26-0012' });
  });
});
