/**
 * Plant status screens (Phase 6 slice 6b, builder B) on the contract's examples: the plant alarm list and its
 * acknowledgment (DI-49), the batch alarm log on the review and floor step screens, the equipment status board (PR-22),
 * the line station display (PR-35) and the rooms with their conditions and spills (PR-15, PR-25, PR-27). Every value
 * and gate is the server's.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { StepScreenView } from '@ebmr/api-contract';
import { example } from '@ebmr/api-contract/examples';
import { apiState } from '../../src/api/client.ts';
import { refusal, renderOffice, TAPPED } from '../office/support.tsx';
import { renderFloor, RUN_ID, stepFixtures, stepPath } from '../floor/support.tsx';

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

const list = example('alarms-list');
const critical = list.alarms[1]!;
const acknowledged = example('alarms-acknowledge');

describe('plant alarms (DI-49)', () => {
  it('[DI-49] the list shows open alarms with source times and the GMP-critical flag; the filters go to the server', async () => {
    const ui = renderOffice('/alarms', { role: 'QA_REVIEWER' });
    const row = await screen.findByTestId(`alarm-${critical.alarmId}`);
    expect(row.getAttribute('data-gmp-critical')).toBe('true');
    expect(row.textContent).toContain('GMP-critical');
    expect(row.textContent).toContain(critical.raisedAtSource.text);
    expect(row.textContent).toContain(critical.clearedAtSource!.text);
    expect(row.textContent).toContain('18.40 kN against High limit 18.00 kN');
    expect(ui.requests.some((r) => r.path === '/api/alarms' && r.query['state'] === 'OPEN')).toBe(true);
    await userEvent.click(screen.getByRole('radio', { name: 'EMS' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Unit or room code' }), 'RM-COMP-1');
    await waitFor(() => expect(ui.requests.some((r) => r.path === '/api/alarms' && r.query['source'] === 'EMS' && r.query['subjectCode'] === 'RM-COMP-1')).toBe(true));
  });

  it('[DI-49] the acknowledgment of a GMP-critical alarm needs a comment before it is sent; on a kiosk it is sent with a fresh tap', async () => {
    const ui = renderOffice('/alarms', { role: 'OPERATOR', attribution: 'TAP' });
    await userEvent.click(within(await screen.findByTestId(`alarm-${critical.alarmId}`)).getByRole('button', { name: 'Acknowledge' }));
    const dialog = await screen.findByTestId(`ack-dialog-${critical.alarmId}`);
    const send = within(dialog).getByRole('button', { name: 'Acknowledge the alarm' });
    await userEvent.type(within(dialog).getByRole('textbox', { name: /^Action taken/ }), 'Press stopped, tooling checked');
    expect(send.hasAttribute('disabled')).toBe(true);
    await userEvent.type(within(dialog).getByRole('textbox', { name: /^Comment \(required/ }), 'Force back in range after re-set');
    expect(send.hasAttribute('disabled')).toBe(false);
    await userEvent.click(send);
    const path = `/api/alarms/${critical.alarmId}/acknowledge`;
    await waitFor(() => expect(ui.posts(path)).toHaveLength(1));
    expect(ui.tap.requestTap).toHaveBeenCalledTimes(1);
    expect(ui.posts(path)[0]?.body).toEqual({ actionTaken: 'Press stopped, tooling checked', comment: 'Force back in range after re-set', attribution: TAPPED });
  });

  it('[DI-49] an alarm whose configuration requires a deviation waits for its reference; a refusal is shown in the server\'s words', async () => {
    const needsDeviation = { ...critical, gmpCritical: false, deviationRequired: true };
    const ui = renderOffice('/alarms', {
      role: 'QA_REVIEWER',
      fixtures: { 'alarms.list': { alarms: [needsDeviation] }, 'alarms.acknowledge': () => refusal('EBMR-PLANT-930', 'The alarm is already acknowledged.') },
    });
    await userEvent.click(within(await screen.findByTestId(`alarm-${critical.alarmId}`)).getByRole('button', { name: 'Acknowledge' }));
    const dialog = await screen.findByTestId(`ack-dialog-${critical.alarmId}`);
    const send = within(dialog).getByRole('button', { name: 'Acknowledge the alarm' });
    await userEvent.type(within(dialog).getByRole('textbox', { name: /^Action taken/ }), 'Line stopped');
    expect(send.hasAttribute('disabled')).toBe(true);
    await userEvent.type(within(dialog).getByRole('textbox', { name: /^Deviation reference/ }), 'DEV-26-0042');
    await userEvent.click(send);
    expect(await within(dialog).findByText('The alarm is already acknowledged.')).toBeTruthy();
    expect(ui.posts(`/api/alarms/${critical.alarmId}/acknowledge`)[0]?.body).toEqual({ actionTaken: 'Line stopped', deviationRef: 'DEV-26-0042' });
  });

  it('[DI-49] the batch review shows the batch alarm log with the acknowledgment: time, person, action, comment, deviation', async () => {
    const B = example('review-batch').batchId;
    const ui = renderOffice(`/review/${B}`, { role: 'QA_REVIEWER', fixtures: { 'alarms.batchLog': { alarms: [acknowledged] } } });
    const log = await screen.findByTestId('batch-alarm-log');
    const k = acknowledged.acknowledgement!;
    const cell = await within(log).findByTestId(`ack-${acknowledged.alarmId}`);
    expect(cell.textContent).toContain(k.at.text);
    expect(cell.textContent).toContain(k.by.legalName);
    expect(cell.textContent).toContain(k.actionTaken);
    expect(log.textContent).toContain('GMP-critical');
    expect(ui.requests.some((r) => r.path === `/api/alarms/by-batch/${B}` && r.query['step'] === undefined)).toBe(true);
  });

  it('[DI-49] the GMP floor step screen shows the alarms of that step', async () => {
    const view: StepScreenView = structuredClone(example('batches-step-tb08'));
    const ui = renderFloor(stepPath(view.step.stepKey), { installation: 'GMP', fixtures: { 'batches.step': () => view, ...stepFixtures(view) } });
    const log = await screen.findByTestId('batch-alarm-log');
    expect(log.textContent).toContain('Alarms at this step');
    await within(log).findByTestId(`batch-alarm-${critical.alarmId}`);
    expect(ui.requests.some((r) => r.method === 'GET' && r.path === `/api/alarms/by-batch/${RUN_ID}`)).toBe(true);
  });
});

describe('plant displays and rooms', () => {
  it('[PR-22] the status board shows each unit and room with its state, batch, cleaning state, open alarms and the read time', async () => {
    const board = example('equipment-displays-status-board');
    const ui = renderOffice('/status-board', { role: 'QA_REVIEWER' });
    const press = await screen.findByTestId('board-PRESS-01');
    expect(press.textContent).toContain('In product');
    expect(press.textContent).toContain('PCM500-26-0042');
    expect(press.textContent).toContain('1 open');
    expect(screen.getByTestId('board-RM-COMP-1').textContent).toContain('Clean');
    expect(screen.getByTestId('status-board-read-at').textContent).toContain(board.readAt.text);
    const reads = () => ui.requests.filter((r) => r.path === '/api/equipment-data/status-board').length;
    const before = reads();
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
  });

  it('[PR-35] the line station shows the product, its name, the batch, stage, packaging order and artwork set', async () => {
    renderOffice('/line-station/LN-BLIS-1', { role: 'OPERATOR' });
    const b = await screen.findByTestId('line-station-batch');
    for (const s of ['PCM-500', 'Paracetamol tablets 500 mg', 'PCM500-26-0042', 'Packaging', 'PO-26-0107', 'ART-IN-v3']) expect(b.textContent).toContain(s);
  });

  it('[PR-25][PR-27][PR-15] rooms show cleaning state, clean hold, controlled area and open spills; a room shows its conditions and records a spill', async () => {
    const ui = renderOffice('/rooms', { role: 'OPERATOR' });
    const pot = await screen.findByTestId('room-RM-POT-1');
    expect(pot.getAttribute('data-cleaning')).toBe('CLEANING_REQUIRED');
    expect(pot.textContent).toContain('72 h');
    expect(pot.textContent).toContain('area authorisation needed');
    expect(pot.textContent).toContain('1 open');
    await userEvent.click(within(screen.getByTestId('room-RM-COMP-1')).getByRole('button', { name: /RM-COMP-1/ }));
    const rh = await screen.findByTestId('room-tag-room.rh_pct');
    expect(rh.textContent).toContain('41.3 %RH');
    expect(rh.textContent).toContain('GOOD (0x00000000)');
    expect(screen.getByTestId('room-tag-room.temp_C').textContent).toContain('No sample');
    expect(screen.getByTestId('room-conditions').textContent).toContain('Room humidity above 60 %RH');
    await userEvent.click(screen.getByRole('button', { name: 'Record a spill' }));
    const dialog = await screen.findByTestId('spill-dialog');
    const send = within(dialog).getByRole('button', { name: 'Record the spill' });
    expect(send.hasAttribute('disabled')).toBe(true);
    await userEvent.type(within(dialog).getByRole('textbox', { name: /^What was spilled/ }), 'Granules at press 1 hopper');
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Material (optional)' }), 'PCM granules');
    await userEvent.click(send);
    await waitFor(() => expect(ui.posts('/api/plant-rules/rooms/RM-COMP-1/spills')).toHaveLength(1));
    expect(ui.posts('/api/plant-rules/rooms/RM-COMP-1/spills')[0]?.body).toEqual({ description: 'Granules at press 1 hopper', material: 'PCM granules' });
  });
});
