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

  // Slice 7h (gap report D2): an instrument no status step names (a closure torque tester, TB23-TESTER).
  it('[PR-23][IN-25][INV-40] an operator checks an instrument chosen from the plant list for an open batch and books it, each with a fresh badge tap on a kiosk; only instruments are offered', async () => {
    const batch = example('batches-list').batches[0];
    if (!batch) throw new Error('no batch example');
    const ui = renderOffice('/plant', { role: 'OPERATOR', attribution: 'TAP', fixtures: { 'plant.equipment': units, 'batches.list': { batches: [{ ...batch, status: 'IN_PROGRESS' }] } } });
    const section = await screen.findByTestId('instrument-use');
    await userEvent.click(await within(section).findByRole('radio', { name: new RegExp(`^${batch.batchNumber} `) }));
    expect(within(section).queryByRole('radio', { name: /^PRESS-01/ })).toBeNull();
    await userEvent.click(within(section).getByRole('radio', { name: /^BAL-C1/ }));
    await userEvent.click(within(section).getByRole('button', { name: 'Per-use check of BAL-C1 passed' }));
    await waitFor(() => expect(ui.posts('/api/plant/instruments/BAL-C1/checks')).toHaveLength(1));
    expect(ui.posts('/api/plant/instruments/BAL-C1/checks')[0]?.body).toMatchObject({ result: 'PASS', reference: 'Per-use check', batchId: batch.runId, attribution: { method: 'BADGE_TAP' } });
    await userEvent.click(within(section).getByRole('button', { name: 'Book BAL-C1 for the batch' }));
    await waitFor(() => expect(ui.posts('/api/plant/instruments/BAL-C1/uses')).toHaveLength(1));
    expect(ui.posts('/api/plant/instruments/BAL-C1/uses')[0]?.body).toMatchObject({ batchId: batch.runId, plannedHours: '12', attribution: { method: 'BADGE_TAP' } });
    expect(ui.tap.requestTap).toHaveBeenCalledTimes(2);
  });
});

describe('units in use (demo report 13 November 2026, bug 4)', () => {
  const use = example('plant-open-equipment-uses').uses[0];
  if (!use) throw new Error('no open use example');
  const uses = { uses: [{ ...use, equipmentCode: 'BLPRESS-02', batchNumber: 'MGL260051' }, { ...use, useId: '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c99', equipmentCode: 'BLPRESS-01', batchNumber: 'MGL260101' }] };

  it('[INV-12][DI-17][INV-40] an operator ends, on the Plant screen, the use of a unit no step of the batch names, whatever the state of its batch, with a fresh badge tap on a kiosk', async () => {
    const ui = renderOffice('/plant', { role: 'OPERATOR', attribution: 'TAP', fixtures: { 'plant.openEquipmentUses': uses } });
    const section = await screen.findByTestId('units-in-use');
    const row = await within(section).findByTestId('unit-use-BLPRESS-01');
    expect(row.textContent).toContain('MGL260101');
    expect(within(section).getByTestId('unit-use-BLPRESS-02').textContent).toContain('MGL260051');
    await userEvent.click(within(row).getByRole('button', { name: 'End the use of BLPRESS-01' }));
    const path = '/api/plant/equipment-uses/7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c99/end';
    await waitFor(() => expect(ui.posts(path)).toHaveLength(1));
    expect(ui.tap.requestTap.mock.calls[0]?.[1]).toEqual({ method: 'POST', path, body: {} });
    expect(ui.posts(path)[0]?.body).toMatchObject({ attribution: { method: 'BADGE_TAP' } });
  });

  it('[DI-17] a person not offered the floor acts (a shift supervisor) sees the units in use but no end act, and is told who ends it; with none in use the screen says so', async () => {
    renderOffice('/plant', { role: 'SHIFT_SUPERVISOR', fixtures: { 'plant.openEquipmentUses': uses } });
    const section = await screen.findByTestId('units-in-use');
    await within(section).findByTestId('unit-use-BLPRESS-02');
    expect(within(section).queryByRole('button', { name: /^End the use of/ })).toBeNull();
    expect(section.textContent).toContain('An operator ends a unit\'s use');
    cleanup();
    renderOffice('/plant', { role: 'OPERATOR', fixtures: { 'plant.openEquipmentUses': { uses: [] } } });
    expect(await within(await screen.findByTestId('units-in-use')).findByText('No process unit is in use.')).toBeTruthy();
  });
});
