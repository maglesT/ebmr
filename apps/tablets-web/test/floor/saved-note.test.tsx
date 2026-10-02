/**
 * The "Saved" note under a form (useRunCommand): it speaks for the moment of the save and goes once the step on show
 * is past the run version the save produced. Found in the owner's demo run: "Saved: Start step" stayed under the
 * step after it had been signed.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { StepScreenView } from '@ebmr/api-contract';
import { example } from '@ebmr/api-contract/examples';
import { stepQueryKey } from '../../src/features/floor/queries.ts';
import { fakeScaleSlot, renderFloor, RUN_ID, stepPath, stepVariant, type Answer, type Recorded } from './support.tsx';

const STEP = 'p-blend-out@';
const saved = (r: Recorded): Answer | undefined =>
  r.method === 'POST' && r.path.endsWith('/commands') ? { status: 200, body: { accepted: true, version: 8, step: stepVariant('step-g22-output', (v) => void (v.run.version = 8)) } } : undefined;

async function saveOne() {
  const ui = renderFloor(stepPath(STEP), { scaleSlot: fakeScaleSlot({}, []), intercept: saved });
  const form = await screen.findByTestId('form-OUTPUT_CONTAINER');
  await userEvent.click(within(form).getByRole('radio', { name: 'Final blend' }));
  await userEvent.type(within(form).getByRole('textbox', { name: 'Tare (typed by hand)' }), '1.05');
  await userEvent.type(within(form).getByRole('textbox', { name: 'Gross (typed by hand)' }), '26.10');
  await userEvent.click(within(form).getByRole('button', { name: 'Save: Weigh one output container' }));
  await waitFor(() => expect(within(form).getByText(/^Saved: /)).toBeTruthy());
  return { ui, form };
}

const showVersion = (ui: Awaited<ReturnType<typeof saveOne>>['ui'], version: number) =>
  act(() => {
    ui.qc.setQueryData<StepScreenView>(stepQueryKey(RUN_ID, STEP), stepVariant('step-g22-output', (v) => void (v.run.version = version)));
  });

describe('the "Saved" note', () => {
  it('stays while the step on show is the version the save produced', async () => {
    const { ui, form } = await saveOne();
    expect(example('step-g22-output').run.runId).toBe(RUN_ID);
    showVersion(ui, 8);
    expect(within(form).getByText(/^Saved: /)).toBeTruthy();
  });

  it('goes once the step on show is past it (a signature or another entry since)', async () => {
    const { ui, form } = await saveOne();
    showVersion(ui, 9);
    await waitFor(() => expect(within(form).queryByText(/^Saved: /)).toBeNull());
  });
});
