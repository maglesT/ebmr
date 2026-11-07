/**
 * The run overview offers the actions the server offers on a run-level exception (lead TODO T3 of the Phase 2 exit; PR-08,
 * PR-49): an exception raised at no step (raised from the run overview, or a run-level system fact) has no step screen,
 * so before this it could be neither linked to a deviation nor dispositioned by QA anywhere, and the batch could not
 * be closed. The overview now shows the server's "Link a deviation" and "Disposition the exception (QA)" on it,
 * greyed with the server's reason when this person cannot take them; the link goes through the plain-intent path and
 * the disposition through the signature ceremony, on the exception's own record.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ActionView, RunView } from '@ebmr/api-contract';
import { example } from '@ebmr/api-contract/examples';
import { fakeCeremony, renderFloor, RUN_ID, type Recorded } from './support.tsx';

const RUN_LEVEL = 'X-9';
const runWith = (actions: ActionView[]): RunView => {
  const base = structuredClone(example('run'));
  const exception = { ...base.exceptions[0]!, exceptionId: RUN_LEVEL, type: 'OPERATOR_RAISED', title: 'Wrong label roll delivered to the line', category: 'OPERATOR_RAISED', severity: 'ACTION', tier: null, expected: null, actual: null, blocking: true };
  return { ...base, exceptions: [exception] as RunView['exceptions'], actions: [...base.actions, ...actions] };
};
const link: ActionView = { action: 'ATTACH_DEVIATION', available: true, primary: false, requires: 'TAP', meaning: null, reason: null, target: RUN_LEVEL, whoCanHelp: [] };
const dispose = (available: boolean): ActionView => ({
  action: 'DISPOSITION_EXCEPTION',
  available,
  primary: false,
  requires: 'SIGNATURE',
  meaning: 'EXCEPTION_DISPOSITIONED',
  reason: available ? null : 'Only QA dispositions an exception (ENG-ROLE; PR-49)',
  target: RUN_LEVEL,
  whoCanHelp: [],
});
const commandPath = `/api/test-runs/${RUN_ID}/commands`;

describe('run-level exceptions on the run overview (T3)', () => {
  it('[PR-08][PR-49] a supervisor links a deviation to a run-level exception from the overview: one plain intent on the exception, at the run version shown', async () => {
    const run = runWith([link, dispose(false)]);
    const ui = renderFloor(`/runs/${RUN_ID}`, {
      session: { role: 'SHIFT_SUPERVISOR' },
      fixtures: { 'execution.run': run },
      intercept: (r: Recorded) => (r.path === commandPath ? { status: 200, body: { accepted: true, version: run.header.version + 1, step: null } } : undefined),
    });
    const exception = await screen.findByTestId(`exception-${RUN_LEVEL}`);
    // QA's disposition is shown, greyed, with the server's reason.
    expect(within(exception).getByRole('button', { name: 'Disposition the exception (QA)' }).hasAttribute('disabled')).toBe(true);
    expect(within(exception).getByTestId('reason-DISPOSITION_EXCEPTION').textContent).toContain('Only QA dispositions an exception');
    await userEvent.click(within(exception).getByRole('button', { name: 'Link a deviation' }));
    const dialog = await screen.findByRole('dialog', { name: /^Link a deviation to: Wrong label roll/ });
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Deviation number' }), 'DEV-TEST-0042');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send' }));
    expect(await within(dialog).findByText(/^Saved: /)).toBeTruthy();
    expect(ui.commands().map((c) => ({ expectedVersion: c.body?.['expectedVersion'], intent: c.body?.['intent'] }))).toEqual([
      { expectedVersion: run.header.version, intent: { type: 'ATTACH_DEVIATION', exception: RUN_LEVEL, deviationRef: 'DEV-TEST-0042' } },
    ]);
  });

  it('[PR-49][PR-08] on a GMP batch the link dialog raises a deviation of this installation, links it to the batch and fills its number, so the exception can be linked with the deviation screens off (owner report item 2)', async () => {
    const run = runWith([link, dispose(false)]);
    const raised = { ...example('quality-deviations').deviations[0]!, ref: 'DEV-2026-0099' };
    const ui = renderFloor(`/runs/${RUN_ID}`, {
      installation: 'GMP',
      session: { role: 'OPERATOR' },
      fixtures: { 'batches.batch': () => ({ ...run, header: { ...run.header, watermark: null } }) },
      intercept: (r: Recorded) =>
        r.method === 'POST' && r.path === '/api/quality/deviations'
          ? { status: 200, body: raised }
          : r.method === 'POST' && r.path === `/api/quality/deviations/${raised.deviationId}/links`
            ? { status: 200, body: raised }
            : r.path.endsWith('/commands')
              ? { status: 200, body: { accepted: true, version: run.header.version + 1, step: null } }
              : undefined,
    });
    const exception = await screen.findByTestId(`exception-${RUN_LEVEL}`);
    await userEvent.click(within(exception).getByRole('button', { name: 'Link a deviation' }));
    const dialog = await screen.findByRole('dialog', { name: /^Link a deviation to: Wrong label roll/ });
    const raise = within(dialog).getByRole('button', { name: 'Raise and link to this batch' });
    expect(raise.hasAttribute('disabled')).toBe(true);
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Major' }));
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Risk rationale' }), 'Blend time beyond the validated range');
    await userEvent.click(raise);
    expect((await within(dialog).findByTestId('deviation-raised')).textContent).toContain('DEV-2026-0099');
    expect(within(dialog).getByRole('textbox', { name: 'Deviation number' })).toHaveProperty('value', 'DEV-2026-0099');
    const posts = ui.requests.filter((r) => r.method === 'POST' && r.path.startsWith('/api/quality/deviations'));
    expect(posts.map((r) => [r.path, r.body])).toEqual([
      ['/api/quality/deviations', { kind: 'DEVIATION', title: 'Wrong label roll delivered to the line', classification: 'MAJOR', riskRationale: 'Blend time beyond the validated range' }],
      [`/api/quality/deviations/${raised.deviationId}/links`, { subjectKind: 'BATCH', subjectId: run.header.runId }],
    ]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send' }));
    expect(await within(dialog).findByText(/^Saved: /)).toBeTruthy();
    expect(ui.commands().map((c) => c.body?.['intent'])).toEqual([{ type: 'ATTACH_DEVIATION', exception: RUN_LEVEL, deviationRef: 'DEV-2026-0099' }]);
  });

  it('[PR-49] on a sandbox test run the link dialog offers no deviation to raise (its references are free text)', async () => {
    renderFloor(`/runs/${RUN_ID}`, { session: { role: 'SHIFT_SUPERVISOR' }, fixtures: { 'execution.run': runWith([link]) } });
    const exception = await screen.findByTestId(`exception-${RUN_LEVEL}`);
    await userEvent.click(within(exception).getByRole('button', { name: 'Link a deviation' }));
    const dialog = await screen.findByRole('dialog', { name: /^Link a deviation to: Wrong label roll/ });
    expect(within(dialog).queryByRole('button', { name: 'Raise and link to this batch' })).toBeNull();
  });

  it('[PR-49][DI-37] QA dispositions a run-level exception from the overview through the signature ceremony, on the exception\'s own record', async () => {
    const run = runWith([dispose(true)]);
    const ceremony = fakeCeremony({ status: 'SIGNED', manifestation: { ...example('manifestation'), meaning: 'EXCEPTION_DISPOSITIONED', meaningText: 'Dispositioned by' }, result: null });
    renderFloor(`/runs/${RUN_ID}`, { session: { role: 'QA_SHOP_FLOOR' }, fixtures: { 'execution.run': run }, ceremony });
    const exception = await screen.findByTestId(`exception-${RUN_LEVEL}`);
    await userEvent.click(within(exception).getByRole('button', { name: 'Disposition the exception (QA)' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('radio', { name: 'No impact' }));
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Justification' }), 'Correct roll fitted before any label was printed');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Continue to signature' }));
    await waitFor(() => expect(ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ceremony.sign.mock.calls[0]?.[0]).toEqual({
      aggregateType: 'batch_exception',
      aggregateId: `${RUN_ID}:${RUN_LEVEL}`,
      meaning: 'EXCEPTION_DISPOSITIONED',
      title: 'Disposition exception Wrong label roll delivered to the line',
      action: {
        kind: 'ENGINE_COMMAND',
        runId: RUN_ID,
        expectedVersion: run.header.version,
        intent: { type: 'DISPOSITION_EXCEPTION', exception: RUN_LEVEL, outcome: 'NO_IMPACT', justification: 'Correct roll fitted before any label was printed' },
      },
    });
    expect(await screen.findByText(/^Dispositioned by /)).toBeTruthy();
  });

  it('[PR-49] an exception with no action offered on it shows no buttons', async () => {
    renderFloor(`/runs/${RUN_ID}`, { fixtures: { 'execution.run': runWith([]) } });
    const exception = await screen.findByTestId(`exception-${RUN_LEVEL}`);
    expect(within(exception).queryAllByRole('button')).toEqual([]);
  });
});
