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
    expect(ui.tap.requestTap).not.toHaveBeenCalled();
    const started = example('plant-start-cleaning');
    const complete = within(section).getByTestId('complete-cleaning');
    await userEvent.click(await within(complete).findByRole('radio', { name: /^RMG-01|^[A-Z0-9-]+ \(/ }));
    await userEvent.click(within(complete).getByRole('button', { name: 'Complete the cleaning' }));
    await waitFor(() => expect(ui.posts(`/api/plant/cleanings/${started.cleaningId}/complete`)).toHaveLength(1));
  });

  it('on a shared kiosk the cleaning is sent with a fresh badge tap over exactly the request (INV-40); an office PC asks none', async () => {
    const ui = renderOffice('/plant', { role: 'MAINTENANCE_TECHNICIAN', attribution: 'TAP' });
    const section = await screen.findByTestId('cleaning');
    await userEvent.click(within(section).getByRole('radio', { name: 'AREA' }));
    await userEvent.type(within(section).getByRole('textbox', { name: 'Equipment or area code' }), 'GRAN-1');
    await userEvent.click(within(section).getByRole('radio', { name: 'MINOR' }));
    await userEvent.click(within(section).getByRole('button', { name: 'Start the cleaning' }));
    await waitFor(() => expect(ui.posts('/api/plant/cleanings')).toHaveLength(1));
    expect(ui.tap.requestTap.mock.calls[0]?.[1]).toEqual({ method: 'POST', path: '/api/plant/cleanings', body: { target: 'AREA', code: 'GRAN-1', level: 'MINOR' } });
    expect(ui.posts('/api/plant/cleanings')[0]?.body).toMatchObject({ target: 'AREA', code: 'GRAN-1', level: 'MINOR', attribution: { method: 'BADGE_TAP' } });
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

describe('calibration and press discharge (slice 7h, A7 and A9)', () => {
  const unit = example('plant-equipment').equipment[0];
  const units = unit ? { equipment: [{ ...unit, code: 'BAL-C1', name: 'Balance 6 kg', kind: 'INSTRUMENT' as const }, { ...unit, code: 'PRESS-01', name: 'Rotary press', kind: 'PROCESS' as const }] } : { equipment: [] };

  it('[PR-23] a technician records the calibration of a unit chosen from the plant list, with as found, as left, the certificate and the next due date', async () => {
    const ui = renderOffice('/plant', { role: 'MAINTENANCE_TECHNICIAN', fixtures: { 'plant.equipment': units } });
    const section = await screen.findByTestId('calibration');
    await userEvent.click(await within(section).findByRole('radio', { name: /^BAL-C1/ }));
    for (const name of ['As found', 'As left']) await userEvent.click(within(within(section).getByRole('radiogroup', { name })).getByRole('radio', { name: 'PASS' }));
    await userEvent.type(within(section).getByRole('textbox', { name: 'Certificate reference' }), 'CAL-2026-114');
    await userEvent.type(within(section).getByRole('textbox', { name: 'Next calibration due (YYYY-MM-DD)' }), '2027-10-19');
    await userEvent.click(within(section).getByRole('button', { name: 'Record the calibration of BAL-C1' }));
    await waitFor(() => expect(ui.posts('/api/plant/equipment/BAL-C1/calibrations')).toHaveLength(1));
    expect(ui.posts('/api/plant/equipment/BAL-C1/calibrations')[0]?.body).toEqual({ asFound: 'PASS', asLeft: 'PASS', reference: 'CAL-2026-114', dueDate: '2027-10-19' });
  });

  it('[PR-22] the steward configures whether each side of a press discharges into its own containers; only process units are offered', async () => {
    const ui = renderOffice('/plant', { role: 'MASTER_DATA_STEWARD', fixtures: { 'plant.equipment': units } });
    const section = await screen.findByTestId('press-discharge');
    await userEvent.click(await within(section).findByRole('radio', { name: /^PRESS-01/ }));
    expect(within(section).queryByRole('radio', { name: /^BAL-C1/ })).toBeNull();
    const yes = within(within(section).getByRole('radiogroup', { name: 'Each side discharges into its own containers' })).getAllByRole('radio')[0];
    if (!yes) throw new Error('no yes/no choice');
    await userEvent.click(yes);
    await userEvent.click(within(section).getByRole('button', { name: 'Configure the discharge of PRESS-01' }));
    await waitFor(() => expect(ui.posts('/api/plant/equipment/PRESS-01/press-discharge')).toHaveLength(1));
    expect(ui.posts('/api/plant/equipment/PRESS-01/press-discharge')[0]?.body).toEqual({ separateStreams: true });
  });
});
