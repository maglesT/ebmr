/**
 * What the floor sends and says about scans, scales and who may verify (round-1 verification item
 * execution-refusal-guidance-and-room-ux; review findings P34, P50 and P46 follow-ups):
 *  - a value read by a scanner on the terminal is sent as a hand entry, never as a SCAN claim the server cannot
 *    attest, and the field says it is recorded as one (flagged, an exception, a second person);
 *  - a weighing is offered on every ONLINE scale of the step's room, and keying by hand only while none is online;
 *  - a greyed verification shows who may verify, as the server names it.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ScaleStatusView, StepScreenView } from '@ebmr/api-contract';
import { example } from '@ebmr/api-contract/examples';
import type { ScaleCaptureSlotProps } from '../../src/app/ports.tsx';
import { fakeScaleSlot, renderFloor, RUN_ID, stepFixtures, stepPath, stepVariant, type Answer, type Recorded } from './support.tsx';

const commandPath = `/api/test-runs/${RUN_ID}/commands`;
const ok = (r: Recorded, step: StepScreenView): Answer | undefined => (r.path === commandPath ? { status: 200, body: { accepted: true, version: 8, step } } : undefined);

const scaleOf = (deviceCode: string, status: ScaleStatusView['status']): ScaleStatusView => ({ ...(example('step-g07-weighing').run.scale as ScaleStatusView), deviceCode, status });

describe('a value read by a scanner', () => {
  const withScannedLabel = stepVariant('step-g10-clearance', (v) => {
    v.fields.push({ item: 'labelCode', name: 'Booth label', valueType: 'TEXT', unit: null, precision: null, categories: null, capture: 'SCAN', target: null, limits: [], attempts: [], computed: false, required: true });
    v.actions.push({ action: 'RECORD_DATA', available: true, primary: false, requires: 'TAP', meaning: null, reason: null, target: null, whoCanHelp: [] });
  });

  it('[DI-30][DI-32][PR-14] is sent as a hand entry, never as a scan the server cannot attest, and the field says it is recorded as one with a second person', async () => {
    const ui = renderFloor(stepPath('p-disp-clear@'), { fixtures: stepFixtures(withScannedLabel), intercept: (r) => ok(r, withScannedLabel) });
    const field = await screen.findByTestId('field-labelCode');
    expect(within(field).getByTestId('scan-as-hand-entry-labelCode').textContent).toBe(
      'A scan on this terminal is recorded as a hand entry: the value is marked as keyed by hand, an exception is raised, and a second person checks the step.',
    );
    await userEvent.type(within(field).getByRole('textbox', { name: 'Booth label' }), 'LBL-BOOTH-7{Enter}');
    await userEvent.click(within(field).getByRole('button', { name: 'Save Booth label' }));
    await waitFor(() => expect(ui.commands()).toHaveLength(1));
    expect(ui.commands()[0]?.body?.['intent']).toEqual({ type: 'RECORD_DATA', stepKey: 'p-disp-clear@', item: 'labelCode', value: { kind: 'TEXT', value: 'LBL-BOOTH-7' }, source: { mode: 'MANUAL' } });
  });

  it('a value keyed by hand carries no such note', async () => {
    renderFloor(stepPath('p-disp-clear@'), {
      fixtures: stepFixtures(
        stepVariant('step-g10-clearance', (v) => {
          v.fields.push({ item: 'boothNote', name: 'Booth note', valueType: 'TEXT', unit: null, precision: null, categories: null, capture: 'MANUAL', target: null, limits: [], attempts: [], computed: false, required: true });
          v.actions.push({ action: 'RECORD_DATA', available: true, primary: false, requires: 'TAP', meaning: null, reason: null, target: null, whoCanHelp: [] });
        }),
      ),
    });
    const field = await screen.findByTestId('field-boothNote');
    expect(within(field).queryByTestId('scan-as-hand-entry-boothNote')).toBeNull();
  });
});

describe('the scales a weighing is offered on', () => {
  it('[DI-32][PR-20] every ONLINE scale of the step\'s room is offered for the capture, and keying by hand is not', async () => {
    const seen: ScaleCaptureSlotProps[] = [];
    const view = stepVariant('step-g07-weighing', (v) => {
      v.run.scale = scaleOf('TEST-BAL-01', 'ONLINE');
      v.run.scales = [scaleOf('TEST-BAL-00', 'OFFLINE'), scaleOf('TEST-BAL-01', 'ONLINE'), scaleOf('TEST-BAL-03', 'ONLINE')];
    });
    renderFloor(stepPath('p-disp-api@'), { scaleSlot: fakeScaleSlot({}, seen), fixtures: stepFixtures(view) });
    const form = await screen.findByTestId('form-CONTAINER_WEIGHING');
    expect(within(form).getByRole('button', { name: 'Capture tare on TEST-BAL-01, TEST-BAL-03' })).toBeTruthy();
    expect(new Set(seen.map((p) => p.deviceCodes.join(',')))).toEqual(new Set(['TEST-BAL-01,TEST-BAL-03']));
    expect(within(form).queryByText('Manual weighing: two-person rule')).toBeNull();
  });

  it('[PR-20] while no scale of the room is online the weights are keyed by hand, two-person, and no capture is offered', async () => {
    const seen: ScaleCaptureSlotProps[] = [];
    const view = stepVariant('step-g07-weighing', (v) => {
      v.run.scale = null;
      v.run.scales = [scaleOf('TEST-BAL-01', 'OFFLINE'), scaleOf('TEST-BAL-03', 'UNKNOWN')];
    });
    renderFloor(stepPath('p-disp-api@'), { scaleSlot: fakeScaleSlot({}, seen), fixtures: stepFixtures(view) });
    const form = await screen.findByTestId('form-CONTAINER_WEIGHING');
    expect(within(form).getByText('Manual weighing: two-person rule')).toBeTruthy();
    expect(seen).toHaveLength(0);
  });
});

describe('who may verify', () => {
  it('[INV-03] a verification greyed for the person who performed the step shows who may verify, as the server names it', async () => {
    const who = ['Verifier / checker (VERIFIER)', 'Not TEST-Priya Nair: a person who performed, entered data in or corrected the step never checks it (INV-03)'];
    const view = stepVariant('step-g10-clearance', (v) => {
      v.step.status = 'AWAITING_VERIFICATION';
      v.actions = [
        { action: 'VERIFY', available: false, primary: true, requires: 'SIGNATURE', meaning: 'LINE_CLEARANCE_VERIFIED', reason: 'TEST-Priya Nair does not hold a role that may verify p-disp-clear (ENG-ROLE; DI-17)', target: null, whoCanHelp: who },
        { action: 'RAISE_EXCEPTION', available: true, primary: false, requires: 'TAP', meaning: null, reason: null, target: null, whoCanHelp: [] },
      ];
    });
    renderFloor(stepPath('p-disp-clear@'), { fixtures: stepFixtures(view) });
    expect(await screen.findByTestId('primary-reason')).toBeTruthy();
    expect(screen.getByTestId('primary-who').textContent).toBe(`Who can do it: ${who.join('; ')}`);
  });

  it('an action that is available names nobody', async () => {
    renderFloor(stepPath('p-disp-clear@'), { fixtures: stepFixtures(example('step-g10-clearance')) });
    await screen.findByTestId('action-bar');
    expect(screen.queryByTestId('primary-who')).toBeNull();
  });
});
