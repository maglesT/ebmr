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
import { example } from '@ebmr/api-contract/examples';
import { apiState } from '../../src/api/client.ts';
import { envelope, fakeTap, renderFloor, RUN_ID, stepFixtures, stepPath, stepVariant } from './support.tsx';

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

  // Slice 7h (gap report D2): the coder's data and the printed packaging lot of a GMP printed-materials step.
  it('[IN-16] shows the record\'s coding the coder prints while no batch data is recorded', async () => {
    const view = stepOf('G-21@1', 'p-g21@');
    const packaging = example('labels-packaging');
    const base = packaging.steps[0];
    if (!base) throw new Error('no packaging step example');
    renderFloor(stepPath(view.step.stepKey), {
      installation: 'GMP',
      fixtures: {
        'batches.step': () => view,
        ...stepFixtures(view),
        'execution.packagingBatchData': { batchId: RUN_ID, stepKey: 'p-g21@', current: null, jobs: [] },
        'labels.packaging': { ...packaging, steps: [{ ...base, stepKey: 'p-g21@', expectedCoding: { batch: 'GBS260002/P02', mfgDate: '2026-10-20', expiryDate: '2028-09' } }] },
      },
    });
    const coding = await screen.findByTestId('record-coding');
    expect(coding.textContent).toBe('The coder prints the record\'s coding: batch GBS260002/P02 · manufactured 2026-10-20 · expiry 2028-09');
  });

  it('[PR-32][PR-33] takes a scanned printed packaging lot\'s facts from the register for the issue entry, and shows the server\'s refusal of a lot that is not one', async () => {
    const view = stepOf('G-21@1', 'p-g21@');
    const ui = renderFloor(stepPath(view.step.stepKey), {
      installation: 'GMP',
      fixtures: {
        'batches.step': () => view,
        ...stepFixtures(view),
        'execution.packagingBatchData': { batchId: RUN_ID, stepKey: 'p-g21@', current: null, jobs: [] },
        'batches.printedLot': ({ params }: { params: Record<string, string> }) =>
          params['code'] === 'GBT2-LBL-001'
            ? { id: 'GBT2-LBL-001', material: 'MAT-LBL-GBT02', status: 'RELEASED', artwork: 'ART-GBT02-LBL-1', expiresAtUs: '1877472000000000' }
            : { status: 404, body: envelope('NOT_ALLOWED', 'EXE_PRINTED_LOT_UNKNOWN', { whatHappened: `Lot ${params['code'] ?? ''} cannot be issued as printed material.`, why: 'It is no printed packaging lot.', controls: ['PR-32'] }) },
      },
    });
    const panel = await screen.findByTestId('printed-lot');
    await userEvent.type(within(panel).getByRole('textbox', { name: 'Scan the printed packaging lot' }), 'GBT2-MCC-001');
    await userEvent.click(within(panel).getByRole('button', { name: 'Take the lot from the register' }));
    expect(await within(panel).findByText('Lot GBT2-MCC-001 cannot be issued as printed material.')).toBeTruthy();
    await userEvent.clear(within(panel).getByRole('textbox', { name: 'Scan the printed packaging lot' }));
    await userEvent.type(within(panel).getByRole('textbox', { name: 'Scan the printed packaging lot' }), 'GBT2-LBL-001');
    await userEvent.click(within(panel).getByRole('button', { name: 'Take the lot from the register' }));
    expect((await within(panel).findByTestId('printed-lot-facts')).textContent).toContain('MAT-LBL-GBT02, artwork ART-GBT02-LBL-1: chosen for the issue entry');
    expect(ui.requests.some((r) => r.method === 'GET' && r.path === `/api/batches/${RUN_ID}/printed-lots/GBT2-LBL-001`)).toBe(true);
  });
});

describe('the detector challenge of a TB-17 step', () => {
  it('[IN-36] records a challenge with each test piece\'s result, shows whether it passed and opens the CHALLENGE entry naming the challenge (slice 7m: never a typed identifier)', async () => {
    const view = { ...structuredClone(example('batches-step-tb08')), entryForms: [] } as StepScreenView;
    view.step.block = 'TB-17@1';
    view.step.stepKey = 'p-tb17@';
    view.run.runId = RUN_ID;
    view.blockEntries = [{
      kind: 'CHALLENGE', title: 'Challenge', description: 'Challenge',
      schema: { type: 'object', description: 'Challenge', fields: {
        challengeId: { type: 'string', description: 'Challenge', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' },
        device: { type: 'string', description: 'Device', enum: ['METAL_DETECTOR', 'REJECT_GATE'] },
        timing: { type: 'string', description: 'When', enum: ['START', 'INTERVAL', 'AFTER_STOPPAGE', 'END'] },
        passed: { type: 'boolean', description: 'Passed' },
      } },
    }];
    const ui = renderFloor(stepPath(view.step.stepKey), {
      installation: 'GMP',
      fixtures: {
        'batches.step': () => view,
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
    const entry = await screen.findByTestId('block-form-CHALLENGE');
    await userEvent.click(within(entry).getByRole('button', { name: /^Save/ }));
    await waitFor(() => expect(ui.commands()).toHaveLength(1));
    expect((ui.commands().at(-1)?.body?.['intent'] as { entry: unknown } | undefined)?.entry).toEqual({
      kind: 'BLOCK_ENTRY', entryKind: 'CHALLENGE', data: { challengeId: '9d1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e', device: 'METAL_DETECTOR', timing: 'START', passed: false },
    });
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

describe('the reprocessing sources of a TB-08 step (slice 7m, R1)', () => {
  it('[PR-47][IN-19][INV-33] offers only the authorised uses at this step and opens the ADDITION entry with the container and the authorisation, never typed', async () => {
    const view = { ...structuredClone(example('batches-step-tb08')), entryForms: [] } as StepScreenView;
    view.step.block = 'TB-08@1';
    view.step.stepKey = 'p-rework@';
    view.run.runId = RUN_ID;
    const ID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    view.blockEntries = [{
      kind: 'ADDITION', title: 'Addition', description: 'Addition',
      schema: { type: 'object', description: 'Addition', fields: {
        container: { type: 'string', description: 'Container', pattern: ID },
        gross: { type: 'decimal', description: 'Gross' },
        tare: { type: 'decimal', description: 'Tare' },
        unit: { type: 'string', description: 'Unit', enum: ['kg', 'g'] },
        authorisation: { type: 'string', description: 'Authorisation', pattern: ID, optional: true },
      } },
    }];
    const auths = structuredClone(example('quality-reprocessing-authorisations'));
    const base = auths.authorisations[0];
    if (!base) throw new Error('the example has no authorisation');
    const residues = structuredClone(example('quality-residues'));
    const c = residues.containers[0];
    if (!c) throw new Error('the example has no residue');
    const ok = { ...base, authorisationId: '1d1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d01', batchId: RUN_ID, stepId: 'p-rework', scope: 'USE' as const, containerId: c.containerId, authorisedBy: base.proposedBy, authorisedAt: base.proposedAt };
    const unsigned = { ...ok, authorisationId: '1d1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d02', authorisedBy: null, authorisedAt: null };
    const otherStep = { ...ok, authorisationId: '1d1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d03', stepId: 'p-blend' };
    renderFloor(stepPath(view.step.stepKey), {
      installation: 'GMP',
      fixtures: {
        'batches.step': () => view,
        ...stepFixtures(view),
        'devices.stepBindings': { batchId: RUN_ID, stepKey: 'p-rework@', device: null, equipment: [], unitsInUse: [], devices: [], setpoints: [] },
        'quality.reprocessingAuthorisations': { authorisations: [ok, unsigned, otherStep] },
        'quality.residues': residues,
      },
    });
    const panel = await screen.findByTestId('reprocessing-sources');
    await within(panel).findByTestId(`source-${ok.authorisationId}`);
    expect(within(panel).queryByTestId(`source-${unsigned.authorisationId}`)).toBeNull();
    expect(within(panel).queryByTestId(`source-${otherStep.authorisationId}`)).toBeNull();
    await userEvent.click(within(panel).getByRole('button', { name: `Take from ${c.label}` }));
    const form = await screen.findByTestId('block-form-ADDITION');
    expect(within(form).getByTestId('chosen-container').textContent).toContain('Container');
    expect(within(form).getByTestId('chosen-authorisation').textContent).toContain('Authorisation');
  });
});
