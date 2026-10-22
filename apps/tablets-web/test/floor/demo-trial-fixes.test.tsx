/**
 * Hosted-demo trial fixes on the floor and at issue (Phase 7 slice 7k; R3.1, R3.2, R3.6, R3.7): a saved entry form closes
 * and shows the saved entry, offering "Add another" only where the step expects several; a lot code is taken when the
 * field is left as when Enter is pressed, with its spaces normalised; the issue form says when a tablet count is further
 * from the master's than the tolerance. The browser tests (tools/e2e/specs/phase7/presenter-floor.spec.ts) walk the same
 * screens on the real stack.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { floor } from '@ebmr/ui-kit';
import { expectsSeveral } from '../../src/features/floor/repeatable.ts';
import { farFrom } from '../../src/features/planning/PlanningPage.tsx';
import { fakeScaleSlot, renderFloor, stepPath, stepVariant, type Answer, type Recorded } from './support.tsx';

const STEP = 'p-blend-out@';
const saved = (r: Recorded): Answer | undefined =>
  r.method === 'POST' && r.path.endsWith('/commands') ? { status: 200, body: { accepted: true, version: 8, step: stepVariant('step-g22-output', (v) => void (v.run.version = 8)) } } : undefined;

describe('R3.2: a saved entry form closes and shows the saved entry', () => {
  it('after Save the form shows "Saved: ..." and no inputs; "Add another" opens it again, empty', async () => {
    renderFloor(stepPath(STEP), { scaleSlot: fakeScaleSlot({}, []), intercept: saved });
    const form = await screen.findByTestId('form-OUTPUT_CONTAINER');
    await userEvent.click(within(form).getByRole('radio', { name: 'Final blend' }));
    await userEvent.type(within(form).getByRole('textbox', { name: 'Tare (typed by hand)' }), '1.05');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Gross (typed by hand)' }), '26.10');
    await userEvent.click(within(form).getByRole('button', { name: 'Save: Weigh one output container' }));
    const closed = await screen.findByTestId('form-OUTPUT_CONTAINER');
    await waitFor(() => expect(within(closed).getByText(/^Saved: /)).toBeTruthy());
    expect(closed.getAttribute('data-closed')).toBe('true');
    expect(within(closed).queryByRole('button', { name: /^Save: / })).toBeNull();
    expect(within(closed).queryByRole('textbox')).toBeNull();
    await userEvent.click(within(closed).getByRole('button', { name: 'Add another: Weigh one output container' }));
    const again = await screen.findByTestId('form-OUTPUT_CONTAINER');
    expect(within(again).getByRole<HTMLInputElement>('textbox', { name: 'Tare (typed by hand)' }).value).toBe('');
  });

  it('only kinds a step records several of offer "Add another"', () => {
    for (const k of ['CONTAINER_WEIGHING', 'OUTPUT_CONTAINER', 'WEIGHT_CHECK', 'EQUIPMENT_USE', 'ADDITION']) expect(expectsSeveral(k)).toBe(true);
    for (const k of ['AREA_OCCUPANCY', 'CLEARANCE_CHECK', 'YIELD', 'RUN_START', 'RECONCILIATION']) expect(expectsSeveral(k)).toBe(false);
  });
});

function Scan() {
  const [value, setValue] = useState<string | null>(null);
  return (
    <>
      <floor.ScanField label="Lot" name="lotCode" value={value} onChange={setValue} hint="Press Enter to check the lot." />
      <button type="button">elsewhere</button>
    </>
  );
}

describe('R3.6, R3.7: a lot code taken on leaving the field, its spaces normalised', () => {
  it('a code typed and left (Tab) is taken as with Enter; spaces at the ends and doubled inside are dropped', async () => {
    render(<Scan />);
    expect(screen.getByText(/Press Enter to check the lot\./)).toBeTruthy();
    await userEvent.type(screen.getByRole('textbox', { name: 'Lot' }), '  GBT02  MCC 01 ');
    await userEvent.tab();
    expect((await screen.findByTestId('scanned-lotCode')).textContent).toContain('GBT02 MCC 01');
    expect(floor.normaliseCode('\tA  B  ')).toBe('A B');
  });
});

describe('R3.1: the tablet count against the master at issue', () => {
  it('a count more than the tolerance away from the master\'s is flagged before signing (whole numbers, no floating point)', () => {
    expect(farFrom('100000', '100000', '10')).toBe(false);
    expect(farFrom('110000', '100000', '10')).toBe(false);
    expect(farFrom('110001', '100000', '10')).toBe(true);
    expect(farFrom('10000', '100000', '10')).toBe(true);
    expect(farFrom('1,00,000', '100000', '10')).toBe(false);
  });
});
