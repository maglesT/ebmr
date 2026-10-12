/**
 * PQR screens (Phase 4 slice 6c) on the contract's examples: the list of extracts, the run of a new one by QA, one
 * extract with its hash, whether it reproduces, the reconciliation to the registers, the export-only SKU and the market
 * removal, the deviations with CAPA as recorded, and the AP's sign-off offered to the AP only. Every value and gate is the
 * server's.
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

const x = example('pqr-extract');

describe('PQR extract screens (IN-01, PR-58)', () => {
  it('[IN-01] lists the extracts and lets QA run one for a product and period; the AP sign-off state is shown', async () => {
    const ui = renderOffice('/pqr', { role: 'QA_REVIEWER' });
    const row = await screen.findByTestId(`pqr-extract-${x.extractId}`);
    expect(row.textContent).toContain('Not signed off');
    const box = screen.getByTestId('pqr-run');
    const button = within(box).getByRole('button', { name: 'Run the extract' });
    await userEvent.type(within(box).getByRole('textbox', { name: 'Product code' }), 'GBT01');
    await userEvent.type(within(box).getByRole('textbox', { name: 'First issue day (YYYY-MM-DD)' }), '2025-10-01');
    expect(button.hasAttribute('disabled')).toBe(true);
    await userEvent.type(within(box).getByRole('textbox', { name: 'Last issue day (YYYY-MM-DD)' }), '2026-09-30');
    await userEvent.click(button);
    await waitFor(() => expect(ui.posts('/api/pqr/extracts')).toHaveLength(1));
    expect(ui.posts('/api/pqr/extracts')[0]?.body).toEqual({ productCode: 'GBT01', periodFrom: '2025-10-01', periodTo: '2026-09-30' });
  });

  it('[IN-01][PR-58] an extract shows its hash, that it reproduces, the reconciliation, the export-only batch and the market removal, and the deviations with CAPA', async () => {
    renderOffice(`/pqr/${x.extractId}`, { role: 'QA_REVIEWER' });
    expect((await screen.findByTestId('pqr-hash')).textContent).toBe(x.resultSha256);
    expect(screen.getByTestId('pqr-reproduces').getAttribute('data-reproduces')).toBe('true');
    expect(screen.getByTestId('pqr-reconciliation').textContent).toContain('Reconciled');
    const exportOnly = x.batches.find((b) => b.exportOnly);
    if (!exportOnly) throw new Error('the example has an export-only batch');
    expect(screen.getByTestId(`pqr-batch-${exportOnly.batchNumber}`).getAttribute('data-export-only')).toBe('true');
    const removed = x.batches.find((b) => b.marketRemovals.length > 0);
    if (!removed) throw new Error('the example has a market removal');
    expect(screen.getByTestId(`pqr-batch-${removed.batchNumber}`).textContent).toContain(removed.marketRemovals[0]!.market);
    expect(screen.getByTestId('pqr-deviations').textContent).toContain(x.deviations[0]!.capaRefs[0]!);
    // QA sees no sign-off button.
    expect(within(screen.getByTestId('pqr-sign-off')).queryByRole('button')).toBeNull();
  });

  it('[IN-01] the AP signs off the extract through the ceremony (PQR_SIGN_OFF names the extract only)', async () => {
    const ui = renderOffice(`/pqr/${x.extractId}`, { role: 'AUTHORISED_PERSON' });
    const button = await within(await screen.findByTestId('pqr-sign-off')).findByRole('button', { name: 'Sign off the extract' });
    await userEvent.click(button);
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual({ kind: 'PQR_SIGN_OFF', extractId: x.extractId });
  });

  it('[IN-01] a signed-off extract shows who signed it off and offers no second sign-off', async () => {
    const signed = example('pqr-extract-signed-off');
    renderOffice(`/pqr/${x.extractId}`, { role: 'AUTHORISED_PERSON', fixtures: { 'pqr.extract': signed } });
    expect((await screen.findByTestId('pqr-signed-off')).textContent).toContain(signed.signOff!.signedBy.legalName);
    expect(within(screen.getByTestId('pqr-sign-off')).queryByRole('button')).toBeNull();
  });
});
