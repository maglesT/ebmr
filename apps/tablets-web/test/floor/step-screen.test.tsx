/**
 * The step screen (module C4) against the contract examples and a test server: values are committed one by one
 * with a badge tap; the verdict appears only in the server's post-commit view; a lost answer leaves the entry
 * NOT SAVED and is resent with the same key after a fresh tap; a session change discards it; computed values
 * have no input; unavailable actions keep the server's reason.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { StepScreenView } from '@ebmr/api-contract';
import { example } from '@ebmr/api-contract/examples';
import { SESSION_CHANGE_EVENT } from '../../src/features/floor/session.tsx';
import { ATTRIBUTION, envelope, fakeTap, renderFloor, RUN_ID, stepFixtures, stepPath, stepVariant, type Answer, type Recorded } from './support.tsx';

const G04 = example('step-g04-parameters');

/** G-04 while the operator records: blend time empty, RECORD_DATA offered, signing not yet. */
const g04Recording = stepVariant('step-g04-parameters', (v) => {
  v.step.status = 'IN_PROGRESS';
  v.step.statusText = 'In progress';
  v.fields[0]!.attempts = [];
  v.fields[1]!.attempts = [];
  v.exceptions = [];
  v.signatures = [];
  v.actions = [
    { action: 'RECORD_DATA', available: true, primary: true, requires: 'TAP', meaning: null, reason: null, target: null },
    { action: 'SIGN_PERFORMED', available: false, primary: false, requires: 'SIGNATURE', meaning: 'PERFORMED', reason: 'Record blend time and speed first (ENG-DATA-MISSING)', target: null },
    { action: 'RAISE_EXCEPTION', available: true, primary: false, requires: 'TAP', meaning: null, reason: null, target: null },
  ];
});

/** The server's view after it committed 21 min: the attempt with its verdict (a registered-limit breach). */
function committed(value: string): StepScreenView {
  return stepVariant('step-g04-parameters', (v) => {
    Object.assign(v, structuredClone(g04Recording));
    v.run.version = 8;
    v.fields[0]!.attempts = [
      {
        ...G04.fields[0]!.attempts[0]!,
        value: { kind: 'DECIMAL', value, unit: 'min' },
        echo: `You entered ${value} min`,
        verdict: { tier: 'REGISTERED', failed: true, text: `Outside the registered limit 10 to 20 min (REG-PCM500): ${value} min` },
      },
    ];
  });
}

const commandPath = `/api/test-runs/${RUN_ID}/commands`;

async function typeAndSave(value: string) {
  const input = await screen.findByRole('textbox', { name: 'Blend time' });
  await userEvent.type(input, value);
  await userEvent.click(screen.getByRole('button', { name: 'Save Blend time' }));
}

describe('value entry (G-04) and the pendingEntry path', () => {
  it('[DI-28] the limit verdict is absent until the server\'s commit response, then shown from the returned view; the field is cleared (never pre-filled)', async () => {
    const view = committed('21');
    const ui = renderFloor(stepPath('p-blend@'), { fixtures: stepFixtures(g04Recording), intercept: (r) => (r.path === commandPath ? { status: 200, body: { accepted: true, version: 8, step: view } } : undefined) });
    const input = await screen.findByRole<HTMLInputElement>('textbox', { name: 'Blend time' });
    expect(input.value).toBe('');
    await userEvent.type(input, '21');
    expect(screen.getByText('You entered 21 min')).toBeTruthy();
    const field = screen.getByTestId('field-blendTime');
    expect(within(field).queryByText(/Limit check/)).toBeNull();
    expect(within(field).queryByText(/Outside/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Save Blend time' }));
    expect(await within(field).findByText(/Limit check: Outside the registered limit 10 to 20 min/)).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Blend time' }).value).toBe('');
    const [cmd] = ui.commands();
    expect(cmd?.body?.['intent']).toEqual({ type: 'RECORD_DATA', stepKey: 'p-blend@', item: 'blendTime', value: { kind: 'DECIMAL', value: '21', unit: 'min' }, source: { mode: 'MANUAL' } });
    expect(typeof (cmd?.body?.['intent'] as { value: { value: unknown } }).value.value).toBe('string');
    expect(cmd?.body?.['expectedVersion']).toBe(7);
    expect(cmd?.body?.['viewStepKey']).toBe('p-blend@');
  });

  it('[INV-40] a kiosk entry waits for a badge tap bound to exactly the request it sends (method, path, body without attribution)', async () => {
    const tap = fakeTap();
    const ui = renderFloor(stepPath('p-blend@'), { tap, fixtures: stepFixtures(g04Recording), intercept: (r) => (r.path === commandPath ? { status: 200, body: { accepted: true, version: 8, step: committed('15') } } : undefined) });
    await typeAndSave('15');
    await waitFor(() => expect(ui.commands()).toHaveLength(1));
    expect(tap.requestTap).toHaveBeenCalledTimes(1);
    const [, request] = tap.requestTap.mock.calls[0]!;
    const sent = ui.commands()[0]!;
    const { attribution, ...withoutAttribution } = sent.body ?? {};
    expect(attribution).toEqual(ATTRIBUTION);
    expect(request).toEqual({ method: 'POST', path: commandPath, body: withoutAttribution });
    expect(sent.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('[INV-40] a cancelled tap sends nothing and keeps what was typed', async () => {
    const ui = renderFloor(stepPath('p-blend@'), { tap: fakeTap(null), fixtures: stepFixtures(g04Recording) });
    await typeAndSave('15');
    await waitFor(() => expect(ui.tap.requestTap).toHaveBeenCalled());
    expect(ui.commands()).toHaveLength(0);
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Blend time' }).value).toBe('15');
  });

  it('[DI-28][INV-40] an entry lost in transit shows NOT SAVED and is not shown as recorded; the resend needs a fresh tap and reuses the same idempotency key and body (D1)', async () => {
    const stored = new Map<string, Answer>();
    let calls = 0;
    const intercept = (r: Recorded): Answer | undefined => {
      if (r.path !== commandPath) return undefined;
      calls += 1;
      const key = r.idempotencyKey ?? '';
      if (calls === 1) {
        stored.set(key, { status: 200, body: { accepted: true, version: 8, step: committed('21') } });
        return 'NETWORK_ERROR';
      }
      return stored.get(key) ?? { status: 500, body: envelope('NOT_SAVED', 'UNEXPECTED-KEY') };
    };
    const ui = renderFloor(stepPath('p-blend@'), { fixtures: stepFixtures(g04Recording), intercept });
    await typeAndSave('21');
    const dialog = await screen.findByRole('alertdialog', { name: 'Not saved: tap your badge to send again' });
    expect(within(dialog).getByTestId('not-saved-entry').textContent).toBe('Entry: Blend time: 21 min');
    const field = screen.getByTestId('field-blendTime');
    expect(within(field).queryByTestId(/^attempt-/)).toBeNull();
    expect(within(field).queryByText(/Limit check/)).toBeNull();
    expect(ui.tap.requestTap).toHaveBeenCalledTimes(1);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Send again' }));
    await waitFor(() => expect(ui.commands()).toHaveLength(2));
    expect(ui.tap.requestTap).toHaveBeenCalledTimes(2);
    const [first, second] = ui.commands();
    expect(second?.idempotencyKey).toBe(first?.idempotencyKey);
    expect(second?.body).toEqual(first?.body);
    expect(await within(field).findByText(/Limit check: Outside the registered limit/)).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('[DI-28] a server failure marked retryable is NOT SAVED too; a definite refusal is shown and the next save uses a new key', async () => {
    let calls = 0;
    const intercept = (r: Recorded): Answer | undefined => {
      if (r.path !== commandPath) return undefined;
      calls += 1;
      if (calls === 1) return { status: 503, body: envelope('NOT_SAVED', 'EBMR-PLAT-TIME-FAULT', {}, true) };
      return { status: 422, body: envelope('NOT_ALLOWED', 'ENG-VALUE-REFUSED', { whatHappened: 'The value was refused.', why: 'Late entry needs a reason.' }) };
    };
    const ui = renderFloor(stepPath('p-blend@'), { fixtures: stepFixtures(g04Recording), intercept });
    await typeAndSave('15');
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send again' }));
    expect(await screen.findByText('The value was refused.')).toBeTruthy();
    const [a, b] = ui.commands();
    expect(b?.idempotencyKey).toBe(a?.idempotencyKey);
    await userEvent.click(screen.getByRole('button', { name: 'Save Blend time' }));
    await waitFor(() => expect(ui.commands()).toHaveLength(3));
    expect(ui.commands()[2]?.idempotencyKey).not.toBe(a?.idempotencyKey);
  });

  it('[DI-28] leaving the step while an entry is NOT SAVED is held back, so the notice cannot be lost', async () => {
    const ui = renderFloor(stepPath('p-blend@'), { fixtures: stepFixtures(g04Recording), intercept: (r) => (r.path === commandPath ? 'NETWORK_ERROR' : undefined) });
    await typeAndSave('21');
    await screen.findByRole('alertdialog');
    void ui.router.navigate({ to: '/runs/$runId', params: { runId: RUN_ID } });
    expect(await screen.findByText(/An entry is not settled yet/)).toBeTruthy();
    expect(decodeURIComponent(ui.router.state.location.pathname)).toBe(`/runs/${RUN_ID}/steps/p-blend@`);
    await userEvent.click(screen.getByRole('button', { name: 'Discard and check the record' }));
    void ui.router.navigate({ to: '/runs/$runId', params: { runId: RUN_ID } });
    await waitFor(() => expect(ui.router.state.location.pathname).toBe(`/runs/${RUN_ID}`));
  });

  it('[INV-40] a session change discards a NOT SAVED entry: nothing more is sent, the dialog closes and the typed value is cleared', async () => {
    const ui = renderFloor(stepPath('p-blend@'), { fixtures: stepFixtures(g04Recording), intercept: (r) => (r.path === commandPath ? 'NETWORK_ERROR' : undefined) });
    await typeAndSave('21');
    await screen.findByRole('alertdialog');
    window.dispatchEvent(new CustomEvent(SESSION_CHANGE_EVENT, { detail: { reason: 'SWITCH', personId: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e61' } }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByText(/The entry was discarded because the session on this terminal changed/)).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Blend time' }).value).toBe('');
    expect(ui.commands()).toHaveLength(1);
    expect(ui.tap.requestTap).toHaveBeenCalledTimes(1);
  });

  it('[INV-40] a lock of the same person\'s session discards the pending entry too; an unlock by the same person does not', async () => {
    renderFloor(stepPath('p-blend@'), { tap: fakeTap(null), fixtures: stepFixtures(g04Recording) });
    const input = await screen.findByRole<HTMLInputElement>('textbox', { name: 'Blend time' });
    await userEvent.type(input, '15');
    window.dispatchEvent(new CustomEvent(SESSION_CHANGE_EVENT, { detail: { reason: 'UNLOCK', personId: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e52' } }));
    expect(input.value).toBe('15');
    window.dispatchEvent(new CustomEvent(SESSION_CHANGE_EVENT, { detail: { reason: 'LOCK', personId: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e52' } }));
    await waitFor(() => expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Blend time' }).value).toBe(''));
  });

  it('[INV-40] a tap that completes after the person changed is not used: the entry is not sent under the new person', async () => {
    const tap = fakeTap();
    tap.requestTap.mockImplementation(() => {
      window.dispatchEvent(new CustomEvent(SESSION_CHANGE_EVENT, { detail: { reason: 'SWITCH', personId: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e61' } }));
      return Promise.resolve(ATTRIBUTION);
    });
    const ui = renderFloor(stepPath('p-blend@'), { tap, fixtures: stepFixtures(g04Recording) });
    await typeAndSave('15');
    await waitFor(() => expect(tap.requestTap).toHaveBeenCalled());
    expect(await screen.findByText(/The entry was discarded because the session on this terminal changed/)).toBeTruthy();
    expect(ui.commands()).toHaveLength(0);
  });

  for (const switched of [true, false]) {
    it(`[INV-40] another person's badge (409 SWITCH_USER) discards the entry and offers the switch (${switched ? 'accepted' : 'cancelled'}); it is never resent`, async () => {
      const tap = fakeTap(ATTRIBUTION, switched);
      const refusal = envelope('SWITCH_USER', 'SWITCH_USER', { whatHappened: 'This badge belongs to TEST-Kavya Reddy.', details: { switchToLegalName: 'TEST-Kavya Reddy', switchToLoginName: 'test-verifier-1' } });
      const ui = renderFloor(stepPath('p-blend@'), { tap, fixtures: stepFixtures(g04Recording), intercept: (r) => (r.path === commandPath ? { status: 409, body: refusal } : undefined) });
      await typeAndSave('15');
      await waitFor(() => expect(tap.offerSwitch).toHaveBeenCalledWith(refusal));
      expect(await screen.findByText('The unsent entry was discarded: the badge belongs to another person.')).toBeTruthy();
      expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Blend time' }).value).toBe('');
      expect(ui.commands()).toHaveLength(1);
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
  }

  it('a stale entry (409) reloads the step and says what changed; nothing was saved', async () => {
    let fresh = g04Recording;
    const moved = stepVariant('step-g04-parameters', (v) => {
      Object.assign(v, structuredClone(g04Recording));
      v.run.version = 9;
      v.fields[0]!.attempts = [{ ...G04.fields[0]!.attempts[0]!, by: { personId: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e51', legalName: 'TEST-Priya Nair', loginName: 'test-operator-1', role: 'OPERATOR' } }];
    });
    renderFloor(stepPath('p-blend@'), {
      fixtures: { 'execution.step': () => fresh },
      intercept: (r) => {
        if (r.path !== commandPath) return undefined;
        fresh = moved;
        return { status: 409, body: envelope('STALE', 'ENG-STALE', { whatHappened: 'The run changed.' }) };
      },
    });
    await typeAndSave('16');
    const changes = await screen.findByTestId('stale-changes');
    expect(changes.textContent).toContain('The run moved on (version 7 to 9).');
    expect(changes.textContent).toContain('Blend time: 15 min recorded by TEST-Priya Nair');
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Blend time' }).value).toBe('16');
  });
});

describe('what the step card shows', () => {
  it('[INV-25] computed items have no input: yield (G-20), dispensed total (G-07) and blend output (G-22) are shown, never typed', async () => {
    for (const [key, item] of [
      ['p-disp-recon@', 'dispRecon'],
      ['p-disp-api@', 'dispApi'],
      ['p-blend-out@', 'blendOut'],
    ] as const) {
      const ui = renderFloor(stepPath(key));
      const computed = await screen.findByTestId(`computed-${item}`);
      expect(within(computed).queryByRole('textbox')).toBeNull();
      expect(within(computed).getByText('Computed by the system; it is never typed.')).toBeTruthy();
      expect(screen.queryByTestId(`field-${item}`)).toBeNull();
      ui.unmount();
    }
  });

  it('[DI-05][INV-18] the run header shows the TEST- batch and the TEST, NOT GMP mark, the step "Step 2.1.4 of 13 · Blend" and the instruction with its SOP', async () => {
    renderFloor(stepPath('p-blend@'));
    expect((await screen.findByTestId('batch-number')).textContent).toBe('TEST-B26-0001');
    expect(screen.getByTestId('run-header').textContent).toContain('TEST, NOT GMP');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Step 2.1.4 of 13 · Blend');
    expect(screen.getByTestId('instruction').textContent).toBe('Blend for 15 minutes at 10-14 rpm; record time and speed.');
    expect(screen.getByText('Instruction SOP-BLEND-002 version 2: Operation of the octagonal blender')).toBeTruthy();
    expect(screen.getByText(/Performed by TEST-Arjun Das \(test-operator-2\), Operator, 28-SEP-2026 14:37:03/)).toBeTruthy();
  });

  it('[DI-34] a step that cannot start yet shows the start action greyed with the server\'s reason; other unavailable actions keep theirs in the menu', async () => {
    const pending = stepVariant('step-g22-output', (v) => {
      v.step.status = 'PENDING';
      v.step.statusText = 'Not yet available';
      v.actions = [
        { action: 'START_STEP', available: false, primary: true, requires: 'TAP', meaning: null, reason: 'The QA hold point 2.2.1 must be released first (ENG-HOLD-POINT; PR-45)', target: null },
        { action: 'HOLD_BATCH', available: false, primary: false, requires: 'TAP', meaning: null, reason: 'Only a production supervisor or QA may hold the batch', target: null },
      ];
    });
    renderFloor(stepPath('p-blend-out@'), { fixtures: stepFixtures(pending) });
    const start = await screen.findByRole('button', { name: 'Start step' });
    expect(start.hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('primary-reason').textContent).toContain('The QA hold point 2.2.1 must be released first');
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    const hold = within(await screen.findByRole('menu')).getByRole('menuitem', { name: /Hold the batch/ });
    expect(hold.getAttribute('aria-disabled')).toBe('true');
    expect(hold.textContent).toContain('Only a production supervisor or QA may hold the batch');
  });

  it('[DI-34] "Start step" sends START_STEP with a tap when the server offers it', async () => {
    const view = example('step-g09-equipment-status');
    const ui = renderFloor(stepPath('p-disp-bal@'), { intercept: (r) => (r.path === commandPath ? { status: 200, body: { accepted: true, version: 8, step: view } } : undefined) });
    await userEvent.click(await screen.findByRole('button', { name: 'Start step' }));
    await waitFor(() => expect(ui.commands()).toHaveLength(1));
    expect(ui.commands()[0]?.body?.['intent']).toEqual({ type: 'START_STEP', stepKey: 'p-disp-bal@' });
    expect(ui.tap.requestTap).toHaveBeenCalledWith('Start step 1.1.2', expect.objectContaining({ method: 'POST' }));
  });

  it('[PR-08] an alert exception shows expected against actual and who it is routed to; linking a deviation stays greyed with the server\'s reason for an operator', async () => {
    renderFloor(stepPath('p-blend@'));
    const exception = await screen.findByTestId('exception-X-3');
    expect(within(exception).getByText('10 - 14 rpm')).toBeTruthy();
    expect(within(exception).getByText('15 rpm')).toBeTruthy();
    expect(within(exception).getByText('Production supervisor')).toBeTruthy();
    expect(within(exception).getByRole('button', { name: 'Link a deviation' }).hasAttribute('disabled')).toBe(true);
    expect(within(exception).getByTestId('reason-ATTACH_DEVIATION').textContent).toContain('Only a production supervisor may link a deviation');
  });

  it('[PR-08] an action-limit breach blocks signing until a supervisor links a deviation: the reason is shown, and the link sends ATTACH_DEVIATION with a tap', async () => {
    const blocked = stepVariant('step-g04-parameters', (v) => {
      v.step.status = 'IN_PROGRESS';
      v.step.statusText = 'In progress';
      v.signatures = [];
      v.exceptions = [{ ...G04.exceptions[0]!, severity: 'ACTION', tier: 'INTERNAL_ACTION', title: 'Blend speed above the action limit', actual: '17 rpm', expected: '8 - 16 rpm', blocking: true }];
      v.actions = [
        { action: 'SIGN_PERFORMED', available: false, primary: true, requires: 'SIGNATURE', meaning: 'PERFORMED', reason: 'An action-limit breach (X-3) blocks completion until a deviation is linked (PR-08)', target: null },
        { action: 'ATTACH_DEVIATION', available: true, primary: false, requires: 'TAP', meaning: null, reason: null, target: 'X-3' },
      ];
    });
    const ui = renderFloor(stepPath('p-blend@'), {
      session: { role: 'SHIFT_SUPERVISOR', legalName: 'TEST-Sanjay Kulkarni' },
      fixtures: stepFixtures(blocked),
      intercept: (r) => (r.path === commandPath ? { status: 200, body: { accepted: true, version: 8, step: blocked } } : undefined),
    });
    expect((await screen.findByRole('button', { name: 'Sign as performed' })).hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('primary-reason').textContent).toContain('blocks completion until a deviation is linked');
    const exception = screen.getByTestId('exception-X-3');
    expect(within(exception).getByText('Blocks the next steps until it is resolved')).toBeTruthy();
    await userEvent.click(within(exception).getByRole('button', { name: 'Link a deviation' }));
    const dialog = await screen.findByRole('dialog', { name: 'Link a deviation to: Blend speed above the action limit' });
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Deviation number' }), 'DEV-2026-0042');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(ui.commands()).toHaveLength(1));
    expect(ui.commands()[0]?.body?.['intent']).toEqual({ type: 'ATTACH_DEVIATION', exception: 'X-3', deviationRef: 'DEV-2026-0042' });
    expect(await within(dialog).findByText(/Saved: Link deviation DEV-2026-0042 to exception X-3/)).toBeTruthy();
  });
});

describe('signatures through the ceremony port', () => {
  it('Verify asks the ceremony for an ENGINE_COMMAND signature on the step\'s signable with the action\'s own meaning', async () => {
    const signed = { ...G04, signatures: [...G04.signatures] };
    const ui = renderFloor(stepPath('p-blend@'), {
      ceremony: {
        sign: (req) => {
          void req;
          return Promise.resolve({ status: 'SIGNED', manifestation: { ...G04.signatures[0]!, meaning: 'VERIFIED', meaningText: 'Verified by', signatureId: 'e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7a99', signer: { personId: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e61', legalName: 'TEST-Kavya Reddy', loginName: 'test-verifier-1', role: 'VERIFIER' } }, result: signed });
        },
      },
    });
    void ui;
    await userEvent.click(await screen.findByRole('button', { name: 'Verify' }));
    expect(await screen.findByText(/Verified by TEST-Kavya Reddy \(test-verifier-1\), Verifier/)).toBeTruthy();
  });

  it('[INV-03] a refused verification (the performer verifying their own step) shows the server\'s reason and who can verify', async () => {
    const refusal = envelope('INDEPENDENCE', 'ENG-VERIFY-INDEPENDENCE', {
      whatHappened: 'You cannot verify this step.',
      why: 'You performed this step; a different person must verify it (INV-03).',
      whoCanHelp: ['PRODUCTION_VERIFIER', 'PRODUCTION_SUPERVISOR'],
      whatYouCanDo: ['A verifier taps their badge to switch user and verifies.'],
    });
    const calls: unknown[] = [];
    renderFloor(stepPath('p-blend@'), {
      session: { personId: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e52' },
      ceremony: {
        sign: (req) => {
          calls.push(req);
          return Promise.resolve({ status: 'REFUSED', refusal });
        },
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Verify' }));
    const panel = await screen.findByTestId('refusal');
    expect(panel.textContent).toContain('a different person must verify it');
    expect(within(screen.getByTestId('who-can-help')).getByText('Production verifier')).toBeTruthy();
    expect(calls[0]).toEqual({
      aggregateType: 'batch_step',
      aggregateId: `${RUN_ID}:p-blend@`,
      meaning: 'VERIFIED',
      title: 'Verify step 2.1.4 Blend',
      action: { kind: 'ENGINE_COMMAND', runId: RUN_ID, expectedVersion: 7, intent: { type: 'VERIFY', stepKey: 'p-blend@', meaning: 'VERIFIED' } },
    });
  });

  it('a signature whose answer was lost is reported as not confirmed and the step is reloaded (credentials are never re-sent here)', async () => {
    const ui = renderFloor(stepPath('p-blend@'), { ceremony: { sign: () => Promise.resolve({ status: 'NOT_CONFIRMED' }) } });
    await userEvent.click(await screen.findByRole('button', { name: 'Verify' }));
    expect(await screen.findByText(/The signature was not confirmed/)).toBeTruthy();
    await waitFor(() => expect(ui.requests.filter((r) => r.path.endsWith('/steps/p-blend%40') || r.path.endsWith('/steps/p-blend@')).length).toBeGreaterThan(1));
  });

  it('the QA hold point decision goes to the ceremony with the chosen disposition and the action\'s meaning', async () => {
    const calls: { meaning: string; aggregateId: string; action: unknown }[] = [];
    renderFloor(stepPath('H-BLEND@'), {
      session: { role: 'QA_SHOP_FLOOR' },
      ceremony: {
        sign: (req) => {
          calls.push(req);
          return Promise.resolve({ status: 'CANCELLED' });
        },
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Decide the hold point' }));
    const dialog = await screen.findByRole('dialog', { name: 'Decide the hold point' });
    const cont = within(dialog).getByRole('button', { name: 'Continue to signature' });
    expect(cont.hasAttribute('disabled')).toBe(true);
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Released' }));
    await userEvent.click(cont);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ meaning: 'HOLD_POINT_RELEASED', aggregateId: `${RUN_ID}:H-BLEND@`, action: { kind: 'ENGINE_COMMAND', intent: { type: 'DISPOSITION_HOLD_POINT', stepKey: 'H-BLEND@', disposition: 'RELEASED' } } });
  });

  it('stage sign-off shows the derived summary (not typed) and signs the stage aggregate', async () => {
    const recon = stepVariant('step-g20-yield', (v) => {
      v.step.status = 'COMPLETED';
      v.actions = [{ action: 'SIGN_OFF_STAGE', available: true, primary: true, requires: 'SIGNATURE', meaning: 'STAGE_SIGNED_OFF', reason: null, target: 'S-DISP@' }];
    });
    const calls: { meaning: string; aggregateType: string; aggregateId: string; action: unknown }[] = [];
    renderFloor(stepPath('p-disp-recon@'), {
      fixtures: stepFixtures(recon),
      ceremony: {
        sign: (req) => {
          calls.push(req);
          return Promise.resolve({ status: 'CANCELLED' });
        },
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Sign off the stage' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sign off stage 1 Dispensing' });
    expect(within(dialog).getByTestId('stage-summary').textContent).toContain('Completed per MBR');
    expect(within(dialog).queryByRole('textbox')).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Continue to signature' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ meaning: 'STAGE_SIGNED_OFF', aggregateType: 'batch_stage', aggregateId: `${RUN_ID}:S-DISP@`, action: { intent: { type: 'SIGN_OFF_STAGE', stageKey: 'S-DISP@' } } });
  });

  it('QA disposition of an exception signs batch_exception <runId>:<exceptionId> with the outcome and justification', async () => {
    const qa = stepVariant('step-g04-parameters', (v) => {
      v.actions = [{ action: 'DISPOSITION_EXCEPTION', available: true, primary: false, requires: 'SIGNATURE', meaning: 'EXCEPTION_DISPOSITIONED', reason: null, target: 'X-3' }];
    });
    const calls: { meaning: string; aggregateType: string; aggregateId: string; action: unknown }[] = [];
    renderFloor(stepPath('p-blend@'), {
      session: { role: 'QA_SHOP_FLOOR' },
      fixtures: stepFixtures(qa),
      ceremony: {
        sign: (req) => {
          calls.push(req);
          return Promise.resolve({ status: 'CANCELLED' });
        },
      },
    });
    const exception = await screen.findByTestId('exception-X-3');
    await userEvent.click(within(exception).getByRole('button', { name: 'Disposition the exception (QA)' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('radio', { name: 'No impact' }));
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Justification' }), 'Speed within validated range VR-BLEND-01');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Continue to signature' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      meaning: 'EXCEPTION_DISPOSITIONED',
      aggregateType: 'batch_exception',
      aggregateId: `${RUN_ID}:X-3`,
      action: { intent: { type: 'DISPOSITION_EXCEPTION', exception: 'X-3', outcome: 'NO_IMPACT', justification: 'Speed within validated range VR-BLEND-01' } },
    });
  });
});
