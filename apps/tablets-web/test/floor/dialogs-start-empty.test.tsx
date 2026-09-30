/**
 * The floor's dialogs never carry one person's words or choice to the next opening (module C4; INV-40; DI-14;
 * review P43): not to the next person after a kiosk switch (even on a screen that stays mounted), not to the same
 * person after a cancel or a saved send, and a session change while a dialog is open empties it. Nothing is
 * pre-selected, so Send stays disabled until the person gives everything themselves.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { SESSION_CHANGE_EVENT, type FloorSession } from '../../src/features/floor/session.tsx';
import { OPERATOR, renderFloor, RUN_ID, stepFixtures, stepPath, stepVariant } from './support.tsx';

/** G-04 in progress, with "Raise an exception" and "Hold the batch" offered by the server in the More menu. */
const inProgress = stepVariant('step-g04-parameters', (v) => {
  v.step.status = 'IN_PROGRESS';
  v.step.statusText = 'In progress';
  v.fields[0]!.attempts = [];
  v.fields[1]!.attempts = [];
  v.exceptions = [];
  v.signatures = [];
  v.actions = [
    { action: 'RECORD_DATA', available: true, primary: true, requires: 'TAP', meaning: null, reason: null, target: null, whoCanHelp: [] },
    { action: 'RAISE_EXCEPTION', available: true, primary: false, requires: 'TAP', meaning: null, reason: null, target: null, whoCanHelp: [] },
    { action: 'HOLD_BATCH', available: true, primary: false, requires: 'TAP', meaning: null, reason: null, target: null, whoCanHelp: [] },
  ];
});

const SUPERVISOR_B: FloorSession = {
  ...OPERATOR,
  personId: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e71',
  legalName: 'TEST-Sanjay Kulkarni',
  loginName: 'test-supervisor-1',
  role: 'SHIFT_SUPERVISOR',
};

const commandPath = `/api/test-runs/${RUN_ID}/commands`;

async function openFromMore(item: RegExp, title: string) {
  await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
  await userEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: item }));
  return screen.findByRole('dialog', { name: title });
}

async function close(dialog: HTMLElement, title: string, button: 'Cancel' | 'Close' = 'Cancel') {
  await userEvent.click(within(dialog).getByRole('button', { name: button }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: title })).toBeNull());
}

async function fillException(dialog: HTMLElement) {
  await userEvent.type(within(dialog).getByRole('textbox', { name: 'What happened' }), 'Granules sticking to blender wall');
  await userEvent.click(within(dialog).getByRole('radio', { name: /Action \(stops the next steps/ }));
}

async function fillHold(dialog: HTMLElement) {
  await userEvent.click(within(dialog).getByRole('radio', { name: 'QA hold' }));
  await userEvent.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Suspected cross-contamination');
}

function exceptionSeen(dialog: HTMLElement) {
  return {
    description: within(dialog).getByRole<HTMLInputElement>('textbox', { name: 'What happened' }).value,
    severityChecked: within(dialog)
      .getAllByRole<HTMLInputElement>('radio')
      .filter((r) => r.checked)
      .map((r) => r.value),
    sendEnabled: !within(dialog).getByRole('button', { name: 'Send' }).hasAttribute('disabled'),
  };
}

function holdSeen(dialog: HTMLElement) {
  return {
    reason: within(dialog).getByRole<HTMLInputElement>('textbox', { name: 'Reason' }).value,
    holdTypeChecked: within(dialog)
      .getAllByRole<HTMLInputElement>('radio')
      .filter((r) => r.checked)
      .map((r) => r.value),
    sendEnabled: !within(dialog).getByRole('button', { name: 'Send' }).hasAttribute('disabled'),
  };
}

const EMPTY_EXCEPTION = { description: '', severityChecked: [], sendEnabled: false };
const EMPTY_HOLD = { reason: '', holdTypeChecked: [], sendEnabled: false };

describe('floor command dialogs start empty', () => {
  it('[INV-40][DI-14] after a kiosk switch the next person opens "Raise an exception" and "Hold the batch" empty, even when the step screen stays mounted: no earlier text, nothing pre-selected, Send disabled', async () => {
    // The screen's reads survive the switch here, so the dialogs themselves must not keep what A gave.
    const ui = renderFloor(stepPath('p-blend@'), { fixtures: stepFixtures(inProgress), resetReadsOnPersonChange: false });
    await screen.findByTestId('step-card');

    let dialog = await openFromMore(/Raise an exception/, 'Raise an exception');
    await fillException(dialog);
    await close(dialog, 'Raise an exception');
    dialog = await openFromMore(/Hold the batch/, 'Hold the batch');
    await fillHold(dialog);
    await close(dialog, 'Hold the batch');

    ui.switchTo(SUPERVISOR_B);
    await screen.findByTestId('step-card');

    dialog = await openFromMore(/Raise an exception/, 'Raise an exception');
    const exception = exceptionSeen(dialog);
    await close(dialog, 'Raise an exception');
    dialog = await openFromMore(/Hold the batch/, 'Hold the batch');
    const hold = holdSeen(dialog);
    await close(dialog, 'Hold the batch');

    expect({ exception, hold }).toEqual({ exception: EMPTY_EXCEPTION, hold: EMPTY_HOLD });
    expect(ui.commands()).toHaveLength(0);
  });

  it('[INV-40] the same person reopening after a cancel finds the dialogs empty', async () => {
    renderFloor(stepPath('p-blend@'), { fixtures: stepFixtures(inProgress) });
    await screen.findByTestId('step-card');
    let dialog = await openFromMore(/Raise an exception/, 'Raise an exception');
    await fillException(dialog);
    await close(dialog, 'Raise an exception');
    dialog = await openFromMore(/Hold the batch/, 'Hold the batch');
    await fillHold(dialog);
    await close(dialog, 'Hold the batch');

    dialog = await openFromMore(/Raise an exception/, 'Raise an exception');
    expect(exceptionSeen(dialog)).toEqual(EMPTY_EXCEPTION);
    await close(dialog, 'Raise an exception');
    dialog = await openFromMore(/Hold the batch/, 'Hold the batch');
    expect(holdSeen(dialog)).toEqual(EMPTY_HOLD);
  });

  it('[INV-40] after a saved exception, reopening the dialog does not offer the same words and severity again (two taps would raise a duplicate blocking exception)', async () => {
    const ui = renderFloor(stepPath('p-blend@'), {
      fixtures: stepFixtures(inProgress),
      intercept: (r) => (r.path === commandPath ? { status: 200, body: { accepted: true, version: 8, step: inProgress } } : undefined),
    });
    await screen.findByTestId('step-card');
    let dialog = await openFromMore(/Raise an exception/, 'Raise an exception');
    await fillException(dialog);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send' }));
    expect(await within(dialog).findByText(/^Saved: /)).toBeTruthy();
    await close(dialog, 'Raise an exception', 'Close');
    expect(ui.commands()).toHaveLength(1);

    dialog = await openFromMore(/Raise an exception/, 'Raise an exception');
    expect(exceptionSeen(dialog)).toEqual(EMPTY_EXCEPTION);
  });

  it('[INV-40][DI-14] a session change while a dialog is open empties what was typed and chosen', async () => {
    renderFloor(stepPath('p-blend@'), { fixtures: stepFixtures(inProgress) });
    await screen.findByTestId('step-card');
    const dialog = await openFromMore(/Raise an exception/, 'Raise an exception');
    await fillException(dialog);
    act(() => {
      window.dispatchEvent(new CustomEvent(SESSION_CHANGE_EVENT, { detail: { reason: 'LOCK', personId: OPERATOR.personId } }));
    });
    await waitFor(() => expect(exceptionSeen(screen.getByRole('dialog', { name: 'Raise an exception' }))).toEqual(EMPTY_EXCEPTION));
  });
  const lockNow = () =>
    act(() => {
      window.dispatchEvent(new CustomEvent(SESSION_CHANGE_EVENT, { detail: { reason: 'LOCK', personId: OPERATOR.personId } }));
    });

  it('[INV-40][DI-14] the hold-point decision: a session change while the dialog is open empties the decision and the comment; the next opening starts empty too', async () => {
    renderFloor(stepPath('H-BLEND@'), { session: { role: 'QA_SHOP_FLOOR' } });
    await userEvent.click(await screen.findByRole('button', { name: 'Decide the hold point' }));
    let dialog = await screen.findByRole('dialog', { name: 'Decide the hold point' });
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Released' }));
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Comment (optional)' }), 'Blend uniformity results reviewed');
    expect(within(dialog).getByRole('button', { name: 'Continue to signature' }).hasAttribute('disabled')).toBe(false);

    lockNow();
    const seen = (d: HTMLElement) => ({
      checked: within(d)
        .getAllByRole<HTMLInputElement>('radio')
        .filter((r) => r.checked)
        .map((r) => r.value),
      comment: within(d).getByRole<HTMLInputElement>('textbox', { name: 'Comment (optional)' }).value,
      continueEnabled: !within(d).getByRole('button', { name: 'Continue to signature' }).hasAttribute('disabled'),
    });
    const empty = { checked: [], comment: '', continueEnabled: false };
    await waitFor(() => expect(seen(screen.getByRole('dialog', { name: 'Decide the hold point' }))).toEqual(empty));

    await userEvent.click(within(screen.getByRole('dialog', { name: 'Decide the hold point' })).getByRole('radio', { name: 'Released' }));
    await close(screen.getByRole('dialog', { name: 'Decide the hold point' }), 'Decide the hold point');
    await userEvent.click(screen.getByRole('button', { name: 'Decide the hold point' }));
    dialog = await screen.findByRole('dialog', { name: 'Decide the hold point' });
    expect(seen(dialog)).toEqual(empty);
  });

  it('[INV-40][DI-14] the QA disposition of an exception: a session change while the dialog is open empties the outcome and the justification', async () => {
    const qa = stepVariant('step-g04-parameters', (v) => {
      v.actions = [{ action: 'DISPOSITION_EXCEPTION', available: true, primary: false, requires: 'SIGNATURE', meaning: 'EXCEPTION_DISPOSITIONED', reason: null, target: 'X-3', whoCanHelp: [] }];
    });
    renderFloor(stepPath('p-blend@'), { session: { role: 'QA_SHOP_FLOOR' }, fixtures: stepFixtures(qa) });
    const exception = await screen.findByTestId('exception-X-3');
    await userEvent.click(within(exception).getByRole('button', { name: 'Disposition the exception (QA)' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('radio', { name: 'No impact' }));
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Justification' }), 'Speed within validated range VR-BLEND-01');
    expect(within(dialog).getByRole('button', { name: 'Continue to signature' }).hasAttribute('disabled')).toBe(false);

    lockNow();
    await waitFor(() => {
      const d = screen.getByRole('dialog');
      expect({
        checked: within(d)
          .getAllByRole<HTMLInputElement>('radio')
          .filter((r) => r.checked)
          .map((r) => r.value),
        justification: within(d).getByRole<HTMLInputElement>('textbox', { name: 'Justification' }).value,
        continueEnabled: !within(d).getByRole('button', { name: 'Continue to signature' }).hasAttribute('disabled'),
      }).toEqual({ checked: [], justification: '', continueEnabled: false });
    });
  });
});
