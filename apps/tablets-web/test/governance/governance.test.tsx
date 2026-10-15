/**
 * The governance screens (Phase 6 slice 6f, builder B): vendor support grants (DI-08), the India DSC option (IN-10) and the
 * contract giver's read-only pages (IN-30).
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

describe('vendor support grants', () => {
  it('[DI-08] each grant shows its approvals and window; QA is offered its approval of a pending grant through the ceremony, never a second one', async () => {
    const ui = renderOffice('/governance/support', { role: 'QA_MBR_APPROVER' });
    const g = example('support-grants').grants;
    const rows = await screen.findAllByTestId(`support-grant-${g[1]?.loginName ?? ''}`);
    const pending = rows.find((r) => r.getAttribute('data-state') === 'PENDING')!;
    expect(pending).toBeTruthy();
    expect(within(pending).queryByRole('button', { name: /Approve for QA/ })).toBeNull();
    const active = rows.find((r) => r.getAttribute('data-state') === 'ACTIVE')!;
    expect(active.textContent).toContain('IT approved by');
    expect(active.textContent).toMatch(/Window .* to /);
    // A pending grant without QA's approval offers it.
    const fresh = { ...g[1]!, approvals: [] };
    cleanup();
    const ui2 = renderOffice('/governance/support', { role: 'QA_MBR_APPROVER', fixtures: { 'support.grants': { grants: [fresh], accounts: [] } } });
    await userEvent.click(await screen.findByRole('button', { name: `Approve for QA (${fresh.loginName})` }));
    await waitFor(() => expect(ui2.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui2.ceremony.sign.mock.calls[0]?.[0].action).toEqual({ kind: 'SUPPORT_ACT', act: 'QA_APPROVE', grantId: fresh.grantId });
    void ui;
  });

  it('[DI-08] IT\'s administrator requests a grant for a named engineer, for the hours stated', async () => {
    const ui = renderOffice('/governance/support', { role: 'SYSTEM_ADMINISTRATOR' });
    const form = await screen.findByTestId('support-request');
    const account = example('support-grants').accounts[0]!;
    await userEvent.click(within(form).getByRole('radio', { name: `${account.engineer.legalName} (${account.loginName})` }));
    await userEvent.type(within(form).getByRole('textbox', { name: 'Vendor' }), 'Acme MES Support');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Purpose of the access' }), 'Printer queue');
    await userEvent.click(within(form).getByRole('button', { name: 'Request the grant' }));
    await waitFor(() => expect(ui.posts('/api/support/grants')).toHaveLength(1));
    expect(ui.posts('/api/support/grants')[0]?.body).toEqual({ accountId: account.accountId, vendor: 'Acme MES Support', purpose: 'Printer queue', hours: 4 });
  });
});

describe('the India DSC option', () => {
  it('[IN-10] shows the mode, the test certificate authority with its banner and the meanings that need a DSC', async () => {
    renderOffice('/governance/dsc', { role: 'QA_MBR_APPROVER' });
    expect((await screen.findByTestId('dsc-mode')).textContent).toContain('test certificate authority');
    expect(screen.getByText('Test certificate authority: not legally valid')).toBeTruthy();
    expect(screen.getByTestId('dsc-configuration').textContent).toContain('APPROVED, MANUFACTURER_RELEASE');
  });
});

describe('the contract giver\'s reviewer', () => {
  it('[IN-30] the reviewer sees the batches of its loan licence and a record read-only, with no act offered', async () => {
    renderOffice('/contract-giver', { role: 'CONTRACT_GIVER_REVIEWER' });
    const b = example('contract-giver-batches').batches[0]!;
    expect((await screen.findByTestId(`cg-batch-${b.batchNumber}`)).textContent).toContain(b.loanLicenceNumber);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    cleanup();
    renderOffice(`/contract-giver/${b.batchId}`, { role: 'CONTRACT_GIVER_REVIEWER' });
    const record = await screen.findByTestId('contract-giver-record');
    expect(record.textContent).toContain('2.1 %');
    expect(within(record).queryAllByRole('button')).toHaveLength(0);
  });
});
