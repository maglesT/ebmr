/**
 * The India screens of Phase 4 slice 6a on the contract's examples (ns/india.ts): licences and export permissions with
 * the regulatory signer's record forms and QA's approval and suspension, the issue gate's words for a product, the
 * allocation register and a batch's label particulars with its H2 payload. What is sent is the person's input; what is
 * signed and decided is the server's.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { EXAMPLES, example } from '@ebmr/api-contract/examples';
import { apiState } from '../../src/api/client.ts';
import { renderOffice } from './support.tsx';

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

/** The india routes answered with their contract examples. */
const INDIA: Record<string, unknown> = Object.fromEntries(
  Object.values(EXAMPLES).flatMap((e) => ('routeId' in e && typeof e.routeId === 'string' && e.routeId.startsWith('india.') ? [[e.routeId, e.data] as const] : [])),
);
const office = (path: string, role: string) => renderOffice(path, { role, fixtures: INDIA });
const licences = example('india-licences').licences;
const label = example('india-label');

describe('licences and export permissions', () => {
  it('[IN-30] lists each licence with its state and endorsed products; the regulatory signer records one as typed, with its products and validity', async () => {
    const ui = office('/india', 'REGULATORY_SIGNER');
    const current = await screen.findByTestId(`licence-${licences[0]?.licenceNumber ?? ''}`);
    expect(current.textContent).toContain('Current');
    expect(current.textContent).toContain('PCM500 500 mg');
    expect(screen.getByTestId(`licence-${licences[1]?.licenceNumber ?? ''}`).getAttribute('data-state')).toBe('DRAFT');
    expect(screen.queryByRole('button', { name: /^Approve licence/ })).toBeNull();
    const form = screen.getByTestId('india-record-licence');
    const send = within(form).getByRole('button', { name: 'Record the licence' });
    expect(send.hasAttribute('disabled')).toBe(true);
    await userEvent.type(within(form).getByRole('textbox', { name: 'Licence number' }), 'MH/25/9');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Holder name' }), 'Deccan Pharma Ltd');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Holder address' }), 'Pune');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Valid from (YYYY-MM-DD)' }), '2026-01-01');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Endorsed products (code and strength, separated by ;)' }), 'PCM500 500 mg; PCM650 650 mg');
    await userEvent.click(send);
    await waitFor(() => expect(ui.posts('/api/india/licences')).toHaveLength(1));
    expect(ui.posts('/api/india/licences')[0]?.body).toEqual({
      licenceKind: 'MANUFACTURING', form: '25', licenceNumber: 'MH/25/9', holderName: 'Deccan Pharma Ltd', holderAddress: 'Pune', validFrom: '2026-01-01T00:00:00+05:30',
      products: [{ productCode: 'PCM500', strength: '500 mg' }, { productCode: 'PCM650', strength: '650 mg' }],
    });
  });

  it('[IN-30] QA is offered the approval of a draft licence and the suspension of an approved one, never the record forms', async () => {
    office('/india', 'QA_MBR_APPROVER');
    await screen.findByTestId(`licence-${licences[1]?.licenceNumber ?? ''}`);
    expect(screen.getByRole('button', { name: `Approve licence ${licences[1]?.licenceNumber ?? ''}` })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Record the suspension' }).length).toBeGreaterThan(0);
    expect(screen.queryByTestId('india-record-licence')).toBeNull();
    expect(screen.queryByTestId('india-record-permission')).toBeNull();
  });
});

describe('the allocation register and the label particulars', () => {
  it('[IN-18] the register shows every number with its date, product, batch size and use, a voided one with its reason', async () => {
    office('/india/register', 'QA_REVIEWER');
    const issued = await screen.findByTestId('allocation-PCM2600012');
    expect(issued.getAttribute('data-use')).toBe('ISSUED');
    expect(issued.textContent).toContain('2026-10-10');
    expect(issued.textContent).toContain('60.000 kg');
    expect(issued.textContent).toContain('MH/FDA/25/1234');
    const voided = screen.getByTestId('allocation-PCM2600013');
    expect(voided.textContent).toContain('ORDER_CANCELLED: ERP order cancelled before issue');
  });

  it('[IN-31] a batch\'s label particulars and its H2 payload are shown as the server computed them', async () => {
    office(`/india/batches/${label.batchId}`, 'QA_REVIEWER');
    expect((await screen.findByTestId('label-mfg')).textContent).toBe('10/2026');
    expect(screen.getByTestId('label-exp').textContent).toContain('09/2029');
    expect(screen.getByTestId('india-label').textContent).toContain('Mfg. Lic. No. MH/FDA/25/1234');
    expect(screen.getByTestId('h2-payload').textContent).toBe(label.h2.payload);
  });
});
