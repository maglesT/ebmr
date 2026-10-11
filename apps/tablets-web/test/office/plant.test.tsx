/** Plant screen (Phase 3 slice 6): cleaning start and complete, verification through the ceremony, refusals in words. */
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

describe('plant', () => {
  it('starts a cleaning, then completes the one started here', async () => {
    const ui = renderOffice('/plant', { role: 'OPERATOR' });
    const section = await screen.findByTestId('cleaning');
    await userEvent.click(within(section).getByRole('radio', { name: 'EQUIPMENT' }));
    await userEvent.type(within(section).getByRole('textbox', { name: 'Equipment or area code' }), 'RMG-01');
    await userEvent.click(within(section).getByRole('radio', { name: 'MAJOR' }));
    await userEvent.click(within(section).getByRole('button', { name: 'Start the cleaning' }));
    await waitFor(() => expect(ui.posts('/api/plant/cleanings')).toHaveLength(1));
    expect(ui.posts('/api/plant/cleanings')[0]?.body).toEqual({ target: 'EQUIPMENT', code: 'RMG-01', level: 'MAJOR' });
    const started = example('plant-start-cleaning');
    const complete = within(section).getByTestId('complete-cleaning');
    await userEvent.click(await within(complete).findByRole('radio', { name: /^RMG-01|^[A-Z0-9-]+ \(/ }));
    await userEvent.click(within(complete).getByRole('button', { name: 'Complete the cleaning' }));
    await waitFor(() => expect(ui.posts(`/api/plant/cleanings/${started.cleaningId}/complete`)).toHaveLength(1));
  });

  it('a second person verifies a completed cleaning through the ceremony (PLANT_VERIFY); an operator is not offered it', async () => {
    const ui = renderOffice('/plant', { role: 'SHIFT_SUPERVISOR' });
    const item = example('plant-pending-verifications').items[0];
    const row = await screen.findByTestId(`pending-${item?.act ?? ''}-${item?.subject ?? ''}`);
    await userEvent.click(within(row).getByRole('button', { name: `Verify the cleaning of ${item?.subject ?? ''}` }));
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.posts('/api/esig/describe')[0]?.body).toEqual({ action: { kind: 'PLANT_VERIFY', act: 'CLEANING', id: item?.id } });
    cleanup();
    renderOffice('/plant', { role: 'OPERATOR' });
    const again = await screen.findByTestId(`pending-${item?.act ?? ''}-${item?.subject ?? ''}`);
    expect(within(again).queryByRole('button')).toBeNull();
  });

  it('a refused verification (the person who cleaned) is shown with the server\'s words, nothing signed', async () => {
    const ui = renderOffice('/plant', { role: 'SHIFT_SUPERVISOR', fixtures: { 'esig.describe': refusal('EBMR-PLANT-020', 'The person who cleaned cannot verify the cleaning.') } });
    const item = example('plant-pending-verifications').items[0];
    const row = await screen.findByTestId(`pending-${item?.act ?? ''}-${item?.subject ?? ''}`);
    await userEvent.click(within(row).getByRole('button', { name: /^Verify/ }));
    expect(await within(row).findByText('The person who cleaned cannot verify the cleaning.')).toBeTruthy();
    expect(ui.ceremony.sign).not.toHaveBeenCalled();
  });
});
