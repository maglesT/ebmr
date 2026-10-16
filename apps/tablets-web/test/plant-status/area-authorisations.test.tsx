/**
 * Area authorisations in the qualification matrix (Phase 6 slice 6b; PR-15) on the contract's examples: each controlled
 * area with its records and whether each counts now; define, record and withdraw go to the server as typed; a refusal is
 * shown in the server's words.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { example } from '@ebmr/api-contract/examples';
import { apiState } from '../../src/api/client.ts';
import { refusal, renderOffice } from '../office/support.tsx';

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

const matrix = example('plant-rules-area-authorisations');
const [defined, undefinedArea] = matrix.areas as [(typeof matrix.areas)[number], (typeof matrix.areas)[number]];
const [current, withdrawn] = defined.records as [(typeof defined.records)[number], (typeof defined.records)[number]];

describe('area authorisations (PR-15)', () => {
  it('[PR-15] the qualification matrix shows each controlled area\'s authorisations, records a person and withdraws with a reason', async () => {
    const ui = renderOffice('/area-authorisations', { role: 'TRAINING_COORDINATOR' });
    const area = await screen.findByTestId(`area-auth-${defined.code}`);
    expect(screen.getByTestId(`area-auth-row-${current.recordId}`).getAttribute('data-current')).toBe('true');
    expect(screen.getByTestId(`area-auth-row-${current.recordId}`).textContent).toContain('Authorised');
    expect(screen.getByTestId(`area-auth-row-${withdrawn.recordId}`).textContent).toContain(`Withdrawn at ${withdrawn.withdrawnAt!.text}: Moved to the packaging hall`);
    // An area without its type offers the definition and no record form.
    const other = screen.getByTestId(`area-auth-${undefinedArea.code}`);
    expect(within(other).queryByTestId(`area-auth-record-${undefinedArea.code}`)).toBeNull();
    await userEvent.click(within(other).getByRole('button', { name: 'Define the authorisation' }));
    await waitFor(() => expect(ui.posts('/api/plant-rules/area-authorisations')).toHaveLength(1));
    expect(ui.posts('/api/plant-rules/area-authorisations')[0]?.body).toMatchObject({ area: undefinedArea.code, name: undefinedArea.name });
    // Record a person with an end; a malformed end keeps the act disabled.
    const form = within(area).getByTestId(`area-auth-record-${defined.code}`);
    await userEvent.type(within(form).getByRole('textbox', { name: /^User id/ }), 'ravi.kumar');
    const send = within(form).getByRole('button', { name: 'Record the authorisation' });
    await userEvent.type(within(form).getByRole('textbox', { name: /^Valid to/ }), '13/10/2027');
    expect(send.hasAttribute('disabled')).toBe(true);
    await userEvent.clear(within(form).getByRole('textbox', { name: /^Valid to/ }));
    await userEvent.type(within(form).getByRole('textbox', { name: /^Valid to/ }), '2027-10-13T18:00:00+05:30');
    await userEvent.click(send);
    const path = `/api/plant-rules/area-authorisations/${defined.code}/records`;
    await waitFor(() => expect(ui.posts(path)).toHaveLength(1));
    expect(ui.posts(path)[0]?.body).toMatchObject({ loginName: 'ravi.kumar', validTo: '2027-10-13T18:00:00+05:30' });
    // Withdraw needs the reason.
    const row = screen.getByTestId(`area-auth-row-${current.recordId}`);
    await userEvent.click(within(row).getByRole('button', { name: 'Withdraw…' }));
    const w = within(row).getByRole('button', { name: 'Withdraw' });
    expect(w.hasAttribute('disabled')).toBe(true);
    await userEvent.type(within(row).getByRole('textbox', { name: /^Reason/ }), 'Moved to the packaging hall');
    await userEvent.click(w);
    const wpath = `/api/plant-rules/area-authorisation-records/${current.recordId}/withdraw`;
    await waitFor(() => expect(ui.posts(wpath)).toHaveLength(1));
    expect(ui.posts(wpath)[0]?.body).toMatchObject({ reason: 'Moved to the packaging hall' });
  });

  it('[PR-15] recording oneself is refused by the server and the refusal is shown', async () => {
    renderOffice('/area-authorisations', { role: 'TRAINING_COORDINATOR', fixtures: { 'plantRules.recordAreaAuthorisation': () => refusal('EBMR-IAM-003', 'Nobody records their own qualification or area authorisation.') } });
    const form = await screen.findByTestId(`area-auth-record-${defined.code}`);
    await userEvent.type(within(form).getByRole('textbox', { name: /^User id/ }), 'meena.shah');
    await userEvent.click(within(form).getByRole('button', { name: 'Record the authorisation' }));
    expect(await within(form).findByText(/Nobody records their own qualification/)).toBeTruthy();
  });
});
