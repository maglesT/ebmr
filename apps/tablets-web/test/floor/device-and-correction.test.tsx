/**
 * Phase 4 slice 1c on the step screen: a process value taken from the equipment names the reading it stands on and
 * nothing else (D-P4-10; the server copies tag, value, unit and quality from the stored reading and the screen shows the
 * reading as the server lists it), or is keyed by hand; and the correction of a recorded value (CORRECT_ENTRY) with the
 * person's reason, evidence by its SHA-256 and the approval signed first (CORRECTION_APPROVAL), each described by the
 * server before it is signed.
 */
import { createHash } from 'node:crypto';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { BlockEntryFormView, StepScreenView } from '@ebmr/api-contract';
import { example } from '@ebmr/api-contract/examples';
import { apiState } from '../../src/api/client.ts';
import { correctedValue } from '../../src/features/floor/dialogs/CorrectEntryDialog.tsx';
import { fakeCeremony, renderFloor, RUN_ID, stepFixtures, stepPath, stepVariant } from './support.tsx';

afterEach(() => {
  apiState.installation = undefined;
});

const ACTUAL: BlockEntryFormView = {
  kind: 'ACTUAL',
  title: 'Actual value',
  description: 'A collected process value',
  schema: {
    type: 'object',
    description: 'A collected process value',
    fields: {
      tag: { type: 'string', description: 'Tag' },
      value: { type: 'decimal', description: 'Value as decimal text in the tag unit' },
      unit: { type: 'string', description: 'Unit' },
      source: { type: 'string', enum: ['EQUIPMENT', 'MANUAL'], description: 'Where the value comes from' },
      readingId: { type: 'string', optional: true, serverFilled: true, description: 'The process reading' },
      quality: { type: 'string', optional: true, serverFilled: true, description: 'Quality' },
      receivedAtUs: { type: 'string', optional: true, serverFilled: true, description: 'Received' },
    },
  },
};

function gmpStep(view: StepScreenView) {
  return { 'batches.step': () => view, ...stepFixtures(view) };
}

describe('an entry from the equipment (D-P4-10)', () => {
  const view = (): StepScreenView => ({ ...structuredClone(example('batches-step-tb08')), blockEntries: [ACTUAL] });
  const readings = example('devices-process-readings');
  const r = readings.readings[0];

  it('names only the reading picked from the step\'s device; the value shown is the server\'s and is never typed', async () => {
    const v = view();
    const ui = renderFloor(stepPath(v.step.stepKey), { installation: 'GMP', fixtures: gmpStep(v) });
    await userEvent.click(await screen.findByRole('button', { name: 'Record: Actual value' }));
    const form = screen.getByTestId('block-form-ACTUAL');
    const save = within(form).getByRole('button', { name: 'Save: Actual value' });
    expect(save.hasAttribute('disabled')).toBe(true);
    await userEvent.click(within(form).getByRole('radio', { name: 'From the equipment (pick a reading)' }));
    const picker = await within(form).findByTestId('device-readings');
    expect(picker.textContent).toContain(readings.deviceCode ?? 'x');
    // No input for what the reading carries.
    expect(within(form).queryByRole('textbox', { name: 'Tag' })).toBeNull();
    expect(within(form).queryByRole('textbox', { name: 'Value' })).toBeNull();
    await userEvent.click(within(picker).getByRole('radio', { name: new RegExp(`^${(r?.tag ?? 'x').replace('.', '\\.')}: ${r?.value ?? ''} ${r?.unit ?? ''}`) }));
    await userEvent.click(save);
    await waitFor(() => expect(ui.commands()).toHaveLength(1));
    expect(ui.commands()[0]?.body?.['intent']).toEqual({ type: 'RECORD_ENTRY', stepKey: v.step.stepKey, entry: { kind: 'BLOCK_ENTRY', entryKind: 'ACTUAL', data: { source: 'EQUIPMENT', readingId: r?.readingId } } });
    const asked = ui.requests.find((q) => q.method === 'GET' && q.path === '/api/devices/process-readings');
    expect(asked).toBeTruthy();
  });

  it('a reading already used or outside the step window cannot be picked', async () => {
    const v = view();
    const used = { ...readings, readings: [{ ...r, used: true }, { ...r, readingId: '7e8f9a0b-1c2d-4e3f-8a4b-5c6d7e8f9a02', current: false }] };
    renderFloor(stepPath(v.step.stepKey), { installation: 'GMP', fixtures: { ...gmpStep(v), 'devices.processReadings': used } });
    await userEvent.click(await screen.findByRole('button', { name: 'Record: Actual value' }));
    const form = screen.getByTestId('block-form-ACTUAL');
    await userEvent.click(within(form).getByRole('radio', { name: 'From the equipment (pick a reading)' }));
    const picker = await within(form).findByTestId('device-readings');
    await waitFor(() => expect(picker.textContent).toContain('already used by an entry'));
    expect(picker.textContent).toContain('outside the step window');
    expect(within(picker).queryAllByRole('radio')).toHaveLength(0);
  });

  it('keyed by hand: the value is typed and sent as a MANUAL entry', async () => {
    const v = view();
    const ui = renderFloor(stepPath(v.step.stepKey), { installation: 'GMP', fixtures: gmpStep(v) });
    await userEvent.click(await screen.findByRole('button', { name: 'Record: Actual value' }));
    const form = screen.getByTestId('block-form-ACTUAL');
    await userEvent.click(within(form).getByRole('radio', { name: 'Keyed by hand (manual-entry alert)' }));
    await userEvent.type(within(form).getByRole('textbox', { name: 'Tag' }), 'force.main_kN');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Value' }), '12.5');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Unit' }), 'kN');
    await userEvent.click(within(form).getByRole('button', { name: 'Save: Actual value' }));
    await waitFor(() => expect(ui.commands()).toHaveLength(1));
    expect(ui.commands()[0]?.body?.['intent']).toMatchObject({ entry: { kind: 'BLOCK_ENTRY', entryKind: 'ACTUAL', data: { tag: 'force.main_kN', value: '12.5', unit: 'kN', source: 'MANUAL' } } });
  });
});

describe('the correction of a recorded value (CORRECT_ENTRY)', () => {
  const withAttempt = stepVariant('step-g04-parameters', (v) => {
    v.step = { ...v.step, status: 'IN_PROGRESS', statusText: 'In progress' };
  });

  it('keeps the original kind of value: decimal text with the unit, never a number', () => {
    expect(correctedValue({ kind: 'DECIMAL', value: '15', unit: 'min' }, '16.0')).toEqual({ value: { kind: 'DECIMAL', value: '16.0', unit: 'min' }, problem: null });
    expect(correctedValue({ kind: 'DECIMAL', value: '15', unit: 'min' }, '1x').value).toBeNull();
    expect(correctedValue({ kind: 'COUNT', value: '3' }, '4.5').problem).toBe('a whole number is needed');
  });

  it('the approval is signed first on the point, then the correction names it, with the evidence\'s SHA-256; both are described by the server', async () => {
    const view = { ...withAttempt, blockEntries: [] };
    const manifestation = example('manifestation');
    const ceremony = fakeCeremony({ status: 'SIGNED', manifestation, result: null });
    const described: unknown[] = [];
    const describe = ({ body }: { body: unknown }) => {
      described.push(body);
      const a = (body as { action: { kind: string } }).action;
      return a.kind === 'CORRECTION_APPROVAL'
        ? { kind: a.kind, aggregateType: 'batch_point', aggregateId: `${RUN_ID}:D-5`, meaning: 'CORRECTION_APPROVED', expectedState: 'VALID' }
        : { kind: a.kind, aggregateType: 'batch_point', aggregateId: `${RUN_ID}:D-5`, meaning: 'CORRECTED', expectedState: 'VALID' };
    };
    renderFloor(stepPath(view.step.stepKey), { installation: 'GMP', fixtures: { ...gmpStep(view), 'esig.describe': describe }, ceremony });
    await userEvent.click(await screen.findByRole('button', { name: 'Correct an entry (with a reason)' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('button', { name: /delete/i })).toBeNull();
    await userEvent.click(within(dialog).getByRole('radio', { name: /^Blend time/ }));
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Corrected value (min)' }), '16');
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Reason for the correction/ }), 'Transcription error, timer printout shows 16 min');
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Printout' }));
    const sign = within(dialog).getByRole('button', { name: 'Sign the correction' });
    // Evidence named but not given yet: nothing can be signed.
    expect(sign.hasAttribute('disabled')).toBe(true);
    const file = new File(['timer printout 16 min'], 'printout.txt', { type: 'text/plain' });
    await userEvent.upload(within(dialog).getByLabelText(/Evidence document/), file);
    const hash = (await within(dialog).findByTestId('evidence-hash')).textContent?.match(/[0-9a-f]{64}/)?.[0];
    expect(hash).toBe(createHash('sha256').update('timer printout 16 min').digest('hex'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Approver: approve the correction (signature)' }));
    await within(dialog).findByText(new RegExp(`Correction approved by ${manifestation.signer.legalName}`));
    expect(ceremony.sign.mock.calls[0]?.[0]).toMatchObject({ aggregateType: 'batch_point', meaning: 'CORRECTION_APPROVED', action: { kind: 'CORRECTION_APPROVAL', batchId: RUN_ID, point: 'D-5' } });
    await userEvent.click(sign);
    await waitFor(() => expect(ceremony.sign).toHaveBeenCalledTimes(2));
    const intent = { type: 'CORRECT_ENTRY', point: 'D-5', value: { kind: 'DECIMAL', value: '16', unit: 'min' }, reason: 'Transcription error, timer printout shows 16 min', evidence: { kind: 'PRINTOUT', sha256: hash }, approvalSignatureId: manifestation.signatureId };
    expect(ceremony.sign.mock.calls[1]?.[0]).toMatchObject({ aggregateType: 'batch_point', meaning: 'CORRECTED', action: { kind: 'ENGINE_COMMAND', runId: RUN_ID, expectedVersion: view.run.version, intent } });
    expect(described).toEqual([{ action: { kind: 'CORRECTION_APPROVAL', batchId: RUN_ID, point: 'D-5' } }, { action: { kind: 'ENGINE_COMMAND', runId: RUN_ID, expectedVersion: view.run.version, intent } }]);
  });
});
