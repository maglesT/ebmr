/**
 * After a kiosk user switch (decision D2: the verifier takes over by badge and PIN) no floor view shows what the
 * server computed for the previous person (module C4; INV-40; DI-34; review P44): the run header's "You:" line
 * names the person now signed in, and the step's actions (availability and reasons) are theirs, without waiting
 * for the 30 s poll. The app drops every cached read when the person changes (app/session-reads.tsx); the floor
 * harness mounts it as the app does. After an unlock, the floor reads again what the locked session was refused.
 */
import { act, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { StepScreenView } from '@ebmr/api-contract';
import { SESSION_CHANGE_EVENT, type FloorSession } from '../../src/features/floor/session.tsx';
import { envelope, OPERATOR, renderFloor, stepPath, stepVariant, type Recorded } from './support.tsx';

const VERIFIER: FloorSession = {
  ...OPERATOR,
  personId: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e61',
  legalName: 'TEST-Kavya Reddy',
  loginName: 'test-verifier-1',
  role: 'VERIFIER',
};

const INV03_REASON = 'A different person must verify: you signed this step as performed (INV-03)';

/** The server's step view for whoever is signed in (identity and actions are per person). */
function viewFor(person: FloorSession): StepScreenView {
  return stepVariant('step-g04-parameters', (v) => {
    v.run.identity = { personId: person.personId ?? '', legalName: person.legalName ?? '', loginName: person.loginName ?? '', role: person.role ?? '' };
    const verify = v.actions.find((a) => a.action === 'VERIFY');
    if (!verify) throw new Error('fixture has no VERIFY action');
    verify.available = person.personId !== OPERATOR.personId;
    verify.reason = verify.available ? null : INV03_REASON;
  });
}

describe('the floor after a kiosk user switch', () => {
  it('[INV-40][DI-34] the run header names the newly signed-in person and the actions are theirs, without waiting for the 30 s poll', async () => {
    let signedIn: FloorSession = OPERATOR;
    const ui = renderFloor(stepPath('p-blend@'), {
      fixtures: { 'execution.step': ({ params }: { params: Record<string, string> }) => (params['stepKey'] === 'p-blend@' ? viewFor(signedIn) : { status: 404, body: {} }) },
    });
    await waitFor(() => expect(screen.getByTestId('run-identity').textContent).toContain('TEST-Arjun Das'));
    expect(screen.getByTestId('primary-action').hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('primary-reason').textContent).toContain(INV03_REASON);

    signedIn = VERIFIER;
    ui.switchTo(VERIFIER);
    await waitFor(
      () => {
        const you = screen.getByTestId('run-identity').textContent ?? '';
        expect(you).toContain('TEST-Kavya Reddy');
        expect(you).not.toContain('TEST-Arjun Das');
        expect(screen.getByTestId('primary-action').hasAttribute('disabled')).toBe(false);
      },
      { timeout: 3000 },
    );
    expect(screen.queryByText(INV03_REASON)).toBeNull();
  });

  it('[DI-28][DI-34] after an unlock the step is read again at once: the refusal of the locked session is not left on the screen until the poll', async () => {
    let locked = false;
    const intercept = (r: Recorded) => (locked && r.method === 'GET' ? { status: 423, body: envelope('LOCKED', 'SESSION_LOCKED', { whatHappened: 'This session is locked.' }) } : undefined);
    const ui = renderFloor(stepPath('p-blend@'), { fixtures: { 'execution.step': () => viewFor(OPERATOR) }, intercept });
    await screen.findByTestId('step-card');
    locked = true;
    await act(() => ui.qc.refetchQueries());
    expect(await screen.findByText('This session is locked.')).toBeTruthy();

    locked = false;
    act(() => {
      window.dispatchEvent(new CustomEvent(SESSION_CHANGE_EVENT, { detail: { reason: 'UNLOCK', personId: OPERATOR.personId } }));
    });
    await waitFor(() => expect(screen.queryByText('This session is locked.')).toBeNull(), { timeout: 3000 });
    expect(screen.getByTestId('step-card')).toBeTruthy();
  });
});
