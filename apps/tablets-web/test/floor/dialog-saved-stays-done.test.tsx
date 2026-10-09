/**
 * A plain-intent dialog (raise an exception, hold the batch...) stays done once its send is saved, for as long as it is
 * open (DI-28, INV-40; Phase 2 exit review F57). The "Saved" note under an inline step form goes once the step on show is
 * past the save; that rule must not take a still-open dialog out of its done state: the form would come back, filled
 * with the same words, Send enabled and the button reading Cancel, and a second press would put a duplicate blocking
 * exception or a second hold into the batch record under a new idempotency key.
 *
 * The newer view arrives the way it does on the floor: the server answers the command with its post-commit view, then a
 * read of the step (what the 30 s poll does) brings the run's next version after another person's entry.
 */
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { StepScreenView } from '@ebmr/api-contract';
import { stepQueryKey } from '../../src/features/floor/queries.ts';
import { renderFloor, RUN_ID, stepPath, stepVariant } from './support.tsx';

const STEP = 'p-blend@';
const at = (version: number) =>
  stepVariant('step-g04-parameters', (v) => {
    v.step.status = 'IN_PROGRESS';
    v.step.statusText = 'In progress';
    v.fields[0]!.attempts = [];
    v.fields[1]!.attempts = [];
    v.exceptions = [];
    v.signatures = [];
    v.run.version = version;
    v.actions = [
      { action: 'RECORD_DATA', available: true, primary: true, requires: 'TAP', meaning: null, reason: null, target: null, whoCanHelp: [] },
      { action: 'RAISE_EXCEPTION', available: true, primary: false, requires: 'TAP', meaning: null, reason: null, target: null, whoCanHelp: [] },
      { action: 'HOLD_BATCH', available: true, primary: false, requires: 'TAP', meaning: null, reason: null, target: null, whoCanHelp: [] },
    ];
  });
const commandPath = `/api/test-runs/${RUN_ID}/commands`;

function setup(session?: { role: string }) {
  let current: StepScreenView = at(8);
  const ui = renderFloor(stepPath(STEP), {
    ...(session ? { session } : {}),
    fixtures: { 'execution.step': () => current },
    intercept: (r) => {
      if (r.path !== commandPath) return undefined;
      current = at(current.run.version + 1);
      return { status: 200, body: { accepted: true, version: current.run.version, step: current } };
    },
  });
  /** Another person's entry on the run, then the step's next read (the 30 s poll). */
  const newerRead = async () => {
    current = at(current.run.version + 1);
    await act(async () => {
      await ui.qc.refetchQueries({ queryKey: stepQueryKey(RUN_ID, STEP) });
    });
    await new Promise((r) => setTimeout(r, 50));
  };
  return { ui, newerRead };
}

async function openFromMore(item: RegExp, title: string) {
  await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
  await userEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: item }));
  return screen.findByRole('dialog', { name: title });
}

/** What the open dialog offers; a Send that is offered and enabled is pressed, as a person who sees the form back would. */
async function seenAndPressAgain(title: string) {
  const d = screen.getByRole('dialog', { name: title });
  const seen = {
    saved: within(d).queryByText(/^Saved: /) !== null,
    sendOffered: within(d).queryByRole('button', { name: 'Send' }) !== null,
    textboxes: within(d).queryAllByRole('textbox').length,
    closeOrCancel: within(d).queryByRole('button', { name: 'Close' }) ? 'Close' : within(d).queryByRole('button', { name: 'Cancel' }) ? 'Cancel' : null,
  };
  const again = within(d).queryByRole('button', { name: 'Send' });
  if (again && !again.hasAttribute('disabled')) {
    await userEvent.click(again);
    await new Promise((r) => setTimeout(r, 50));
  }
  return seen;
}

const DONE = { saved: true, sendOffered: false, textboxes: 0, closeOrCancel: 'Close' };

describe('a saved plain-intent dialog after a newer read of the step', () => {
  it('[DI-28][INV-40] Raise an exception: the open dialog stays done; the same words are not offered for a second Send', async () => {
    const { ui, newerRead } = setup();
    await screen.findByTestId('step-card');
    const dialog = await openFromMore(/Raise an exception/, 'Raise an exception');
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'What happened' }), 'Granules sticking to blender wall');
    await userEvent.click(within(dialog).getByRole('radio', { name: /Action \(stops the next steps/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send' }));
    expect(await within(dialog).findByText(/^Saved: /)).toBeTruthy();
    expect(ui.qc.getQueryData<StepScreenView>(stepQueryKey(RUN_ID, STEP))?.run.version).toBe(9);

    await newerRead();
    expect(ui.qc.getQueryData<StepScreenView>(stepQueryKey(RUN_ID, STEP))?.run.version).toBe(10);
    const seen = await seenAndPressAgain('Raise an exception');
    const commands = ui.commands();
    expect({ seen, intents: commands.map((c) => (c.body?.['intent'] as { type: string }).type), keys: new Set(commands.map((c) => c.idempotencyKey)).size }).toEqual({
      seen: DONE,
      intents: ['RAISE_EXCEPTION'],
      keys: 1,
    });
  });

  it('[DI-28][INV-40] Hold the batch (supervisor): the open dialog stays done; a second hold is not offered', async () => {
    const { ui, newerRead } = setup({ role: 'SHIFT_SUPERVISOR' });
    await screen.findByTestId('step-card');
    const dialog = await openFromMore(/Hold the batch/, 'Hold the batch');
    await userEvent.click(within(dialog).getByRole('radio', { name: 'QA hold' }));
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Blender noise, engineering to check');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send' }));
    expect(await within(dialog).findByText(/^Saved: /)).toBeTruthy();

    await newerRead();
    const seen = await seenAndPressAgain('Hold the batch');
    expect({ seen, intents: ui.commands().map((c) => (c.body?.['intent'] as { type: string }).type) }).toEqual({ seen: DONE, intents: ['HOLD_BATCH'] });
  });
});
