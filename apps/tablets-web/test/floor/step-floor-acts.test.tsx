/**
 * The floor acts of Phase 7 slice 7g, WP4 (decision 0025: every act has a screen), on the step screen and the run
 * overview: the process step's device and equipment and the setpoint download, the packaging step's batch data, the
 * second person's check and the print job, the TB-17 detector challenge, and the merge of two scanned containers (GMP).
 * What is offered is the server's answer; each act is one call of the signed-in person with a fresh badge tap.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { PackagingBatchDataView, StepBindingsView, StepScreenView } from '@ebmr/api-contract';
import { apiState } from '../../src/api/client.ts';
import { fakeTap, renderFloor, RUN_ID, stepFixtures, stepPath, stepVariant } from './support.tsx';

afterEach(() => {
  apiState.installation = undefined;
});

const at = (text: string) => ({ us: '1792300000000000', text });
const OP = { personId: '7a1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e11', legalName: 'Priya Nair', loginName: 'priya.nair', role: 'OPERATOR' };

function stepOf(block: string, stepKey: string): StepScreenView {
  return stepVariant('step-g03-acknowledge', (v) => {
    v.step.block = block;
    v.step.stepKey = stepKey;
    v.run.runId = RUN_ID;
  });
}

const posts = (ui: ReturnType<typeof renderFloor>, path: string) => ui.requests.filter((r) => r.method === 'POST' && r.path === path);

describe('the device and equipment of a process step', () => {
  it('[PR-14] offers the server\'s devices and units in use, binds the chosen device, and downloads an MBR setpoint with a badge tap', async () => {
    const view = stepOf('G-06@1', 'p-press@');
    const unbound: StepBindingsView = {
      batchId: RUN_ID, stepKey: 'p-press@', device: null, equipment: [], unitsInUse: [{ code: 'PRESS-1', name: 'Rotary press 1' }],
      devices: [{ code: 'TEST-PRESS-01', equipmentKind: 'PRESS', unitCode: 'PRESS-1' }], setpoints: [{ tag: 'force.main_kN', value: '12.50', unit: 'kN', waiting: false }],
    };
    const bound: StepBindingsView = { ...unbound, device: { code: 'TEST-PRESS-01', boundBy: OP, boundAt: at('18-OCT-2026 10:00') }, equipment: [{ code: 'PRESS-1', name: 'Rotary press 1', boundBy: OP, boundAt: at('18-OCT-2026 10:00') }] };
    let current = unbound;
    const tap = fakeTap();
    const ui = renderFloor(stepPath(view.step.stepKey), {
      tap,
      fixtures: {
        ...stepFixtures(view),
        'devices.stepBindings': () => current,
        'devices.bindStepDevice': () => (current = bound),
        'devices.requestSetpointDownload': () => (current = { ...bound, setpoints: [{ tag: 'force.main_kN', value: '12.50', unit: 'kN', waiting: true }] }),
      },
    });
    const panel = await screen.findByTestId('step-device');
    // No device bound: the download waits for one.
    const download = await within(panel).findByRole('button', { name: 'Download force.main_kN to the device' });
    expect(download.hasAttribute('disabled') || download.getAttribute('aria-disabled') === 'true').toBe(true);
    await userEvent.click(within(panel).getByRole('radio', { name: /TEST-PRESS-01/ }));
    await userEvent.click(within(panel).getByRole('button', { name: 'Bind the device' }));
    await waitFor(() => expect(posts(ui, '/api/devices/step-bindings/device')).toHaveLength(1));
    expect(posts(ui, '/api/devices/step-bindings/device')[0]?.body).toMatchObject({ batchId: RUN_ID, stepKey: 'p-press@', deviceCode: 'TEST-PRESS-01' });
    expect(await screen.findByTestId('step-device-bound')).toBeTruthy();
    await userEvent.click(within(screen.getByTestId('step-device')).getByRole('button', { name: 'Download force.main_kN to the device' }));
    await waitFor(() => expect(posts(ui, '/api/devices/setpoint-downloads')).toHaveLength(1));
    expect(posts(ui, '/api/devices/setpoint-downloads')[0]?.body).toMatchObject({ batchId: RUN_ID, stepKey: 'p-press@', tag: 'force.main_kN' });
    expect(await screen.findByText('Waiting for the gateway')).toBeTruthy();
  });
});

describe('the batch data of a packaging step', () => {
  it('[IN-31][PR-36] records the batch data with the MRP, offers the second person\'s check of the version, asks a reason for a new version, and releases a print job', async () => {
    const view = stepOf('G-21@1', 'p-g21@');
    const v1: PackagingBatchDataView = {
      batchId: RUN_ID, stepKey: 'p-g21@',
      current: { version: 1, fields: { batch: 'B26-0001', mfgDate: '2026-10-18', expiryDate: '2028-09', mrp: '45.50' }, reason: null, recordedBy: OP, recordedAt: at('18-OCT-2026 10:00'), checkedBy: null, checkedAt: null },
      jobs: [],
    };
    let current: PackagingBatchDataView = { batchId: RUN_ID, stepKey: 'p-g21@', current: null, jobs: [] };
    const ui = renderFloor(stepPath(view.step.stepKey), {
      fixtures: {
        ...stepFixtures(view),
        'execution.packagingBatchData': () => current,
        'execution.recordPackagingBatchData': () => (current = v1),
        'execution.checkPackagingBatchData': () => current,
        'execution.releasePrintJob': () => current,
      },
    });
    const panel = await screen.findByTestId('packaging-batch-data');
    await userEvent.type(within(panel).getByRole('textbox', { name: 'MRP in rupees (only where the pack shows it)' }), '45.50');
    await userEvent.click(within(panel).getByRole('button', { name: 'Record the batch data' }));
    await waitFor(() => expect(posts(ui, '/api/steps/packaging-batch-data')).toHaveLength(1));
    expect(posts(ui, '/api/steps/packaging-batch-data')[0]?.body).toMatchObject({ batchId: RUN_ID, stepKey: 'p-g21@', mrp: '45.50' });
    expect(posts(ui, '/api/steps/packaging-batch-data')[0]?.body).not.toHaveProperty('reason');
    const after = screen.getByTestId('packaging-batch-data');
    expect((await within(after).findByTestId('batch-data-current')).getAttribute('data-version')).toBe('1');
    await userEvent.click(within(after).getByRole('button', { name: 'Check the MRP of version 1' }));
    await waitFor(() => expect(posts(ui, '/api/steps/packaging-batch-data/check')).toHaveLength(1));
    expect(posts(ui, '/api/steps/packaging-batch-data/check')[0]?.body).toMatchObject({ version: 1 });
    // A new version needs the person's reason before it can be sent.
    expect(within(after).getByRole('button', { name: 'Record a new version of the batch data' }).getAttribute('aria-disabled') === 'true' || within(after).getByRole('button', { name: 'Record a new version of the batch data' }).hasAttribute('disabled')).toBe(true);
    await userEvent.type(within(after).getByRole('textbox', { name: 'Printer of the step' }), 'CODER');
    await userEvent.type(within(after).getByRole('textbox', { name: 'Layout reference' }), 'LAYOUT-IN-1');
    await userEvent.click(within(after).getByRole('button', { name: 'Release the print job' }));
    await waitFor(() => expect(posts(ui, '/api/steps/print-jobs')).toHaveLength(1));
    expect(posts(ui, '/api/steps/print-jobs')[0]?.body).toMatchObject({ batchId: RUN_ID, stepKey: 'p-g21@', device: 'CODER', layout: 'LAYOUT-IN-1' });
  });
});

describe('the detector challenge of a TB-17 step', () => {
  it('[IN-36] records a challenge with each test piece\'s result and shows whether it passed and the challenge to name in the entry', async () => {
    const view = stepOf('TB-17@1', 'p-tb17@');
    const ui = renderFloor(stepPath(view.step.stepKey), {
      fixtures: {
        ...stepFixtures(view),
        'devices.stepBindings': { batchId: RUN_ID, stepKey: 'p-tb17@', device: null, equipment: [], unitsInUse: [], devices: [], setpoints: [] },
        'execution.recordDetectorChallenge': { challengeId: '9d1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e', passed: false, held: ['OC-B26-0001-0007'] },
      },
    });
    const panel = await screen.findByTestId('detector-challenge');
    await userEvent.type(within(panel).getByRole('textbox', { name: 'Press (equipment code)' }), 'PRESS-1');
    await userEvent.click(within(panel).getByRole('radio', { name: 'Metal detector' }));
    await userEvent.type(within(panel).getByRole('textbox', { name: 'Device code' }), 'MD-01');
    await userEvent.click(within(panel).getByRole('radio', { name: 'Start' }));
    await userEvent.type(within(panel).getByRole('textbox', { name: 'Test pieces (codes of the register, separated by commas)' }), 'TP-FE-08, TP-SS-12');
    const fe = within(panel).getByRole('radiogroup', { name: 'Test piece TP-FE-08' });
    await userEvent.click(within(fe).getByRole('radio', { name: 'Not detected' }));
    const ss = within(panel).getByRole('radiogroup', { name: 'Test piece TP-SS-12' });
    await userEvent.click(within(ss).getByRole('radio', { name: 'Detected and rejected' }));
    await userEvent.click(within(panel).getByRole('button', { name: 'Record the challenge' }));
    await waitFor(() => expect(posts(ui, '/api/detector-challenges')).toHaveLength(1));
    expect(posts(ui, '/api/detector-challenges')[0]?.body).toMatchObject({
      batchId: RUN_ID, press: 'PRESS-1', device: 'METAL_DETECTOR', deviceCode: 'MD-01', timing: 'START',
      pieces: [{ piece: 'TP-FE-08', detected: false, rejected: false }, { piece: 'TP-SS-12', detected: true, rejected: true }],
    });
    const result = await screen.findByTestId('challenge-result');
    expect(result.getAttribute('data-passed')).toBe('no');
    expect(result.textContent).toContain('OC-B26-0001-0007');
    expect(result.textContent).toContain('9d1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e');
  });
});

describe('the merge of two containers on the GMP run overview', () => {
  it('[IN-26] sends both scanned labels and shows the target the server answered', async () => {
    const ui = renderFloor(`/runs/${RUN_ID}`, { installation: 'GMP' });
    const panel = await screen.findByTestId('merge-containers');
    await userEvent.type(within(panel).getByRole('textbox', { name: 'Scan the container poured out (source label)' }), 'OC-B26-0001-0003');
    await userEvent.type(within(panel).getByRole('textbox', { name: 'Scan the open container poured into (target label)' }), 'OC-B26-0001-0005');
    await userEvent.click(within(panel).getByRole('button', { name: 'Merge the containers' }));
    await waitFor(() => expect(posts(ui, '/api/containers/merge')).toHaveLength(1));
    expect(posts(ui, '/api/containers/merge')[0]?.body).toMatchObject({ sourceLabel: 'OC-B26-0001-0003', targetLabel: 'OC-B26-0001-0005' });
    expect((await screen.findByTestId('merge-result')).textContent).toMatch(/Merged into OC-B26-0001-0003 \(open\)/);
  });
});
