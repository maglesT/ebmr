/**
 * A QA act offered to an operator (R10 #8, owner's rabeprazole demo): Arjun, an operator, saw "Disposition the exception
 * (QA)…" as the primary action of a step card. The server names who may take an act on an exception the viewer's role
 * may not take (whoCanHelp) and never makes it the primary; the card then offers it nowhere (neither the bar nor the
 * "More" menu nor the exception) and the exception says who can.
 */
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ActionView } from '@ebmr/api-contract';
import { renderFloor, stepFixtures, stepPath, stepVariant } from './support.tsx';

const WHO = ['QA operations (shop floor) (QA_SHOP_FLOOR)', 'Production supervisor (PRODUCTION_SUPERVISOR)'];
const notMine: ActionView = {
  action: 'DISPOSITION_EXCEPTION',
  available: false,
  primary: false,
  requires: 'SIGNATURE',
  meaning: 'EXCEPTION_DISPOSITIONED',
  reason: 'TEST-Arjun Das does not hold a role that may disposition exception X-3 (ENG-ROLE; DI-17, PR-15)',
  target: 'X-3',
  whoCanHelp: WHO,
};

describe('an act on an exception the operator\'s role may not take', () => {
  it('[DI-17] is offered nowhere on the step card; the exception names who can disposition it', async () => {
    const view = stepVariant('step-g04-parameters', (v) => {
      v.actions = [...v.actions.filter((a) => a.action !== 'DISPOSITION_EXCEPTION'), notMine];
    });
    renderFloor(stepPath('p-blend@'), { fixtures: stepFixtures(view) });
    const exception = await screen.findByTestId('exception-X-3');
    expect(within(exception).queryByRole('button', { name: /Disposition the exception/ })).toBeNull();
    const who = within(exception).getByTestId('who-DISPOSITION_EXCEPTION');
    expect(who.textContent).toContain('Disposition the exception (QA)');
    for (const w of WHO) expect(who.textContent).toContain(w);
    expect(screen.queryByRole('button', { name: /Disposition the exception/ })).toBeNull();
    const more = screen.queryByRole('button', { name: /More/ });
    if (more) {
      await userEvent.click(more);
      expect(screen.queryByRole('menuitem', { name: /Disposition the exception/ })).toBeNull();
    }
  });
});
