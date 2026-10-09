/**
 * A session change while an entry is on its way (module C4; decision D1; DI-28; review P45). The request is on the
 * wire under the person's own tap and may commit. The screen must never say that such an entry "will not be sent";
 * it says the entry may be in the record, reloads what the record holds, and reloads again when the late answer
 * arrives (the reload at the change can run before the commit, or be refused while the session is locked). A late
 * answer never puts back a step view older than the one on show, and never leaves the screen behind the record.
 * When the entry on its way was a resend after a lost answer, only an answer for its key (the replayed commit, or
 * the engine's refusal) says what happened to it; a refusal given before the key is claimed does not. A resend still
 * waiting for its badge tap when the session changes may be in the record too (its first send's answer was lost).
 *
 * The view in a command's or a signature's answer was computed for the person who sent it (INV-40, DI-34; review
 * P44): it is put in place only while that person is the one signed in, so a signature answered after a kiosk
 * switch never shows the next person the signer's "You" line and actions; the step is read again for them instead.
 *
 * The fake server behaves like the real one: kernel.begin_command takes the session row FOR UPDATE and
 * iam.lock_session updates it, so a command already running commits before the lock; while the session is locked
 * every read is refused with 423 (bind.ts); C1 announces LOCK and UNLOCK after the server answered them.
 */
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { Attribution, StepScreenView } from '@ebmr/api-contract';
import { example } from '@ebmr/api-contract/examples';
import { SESSION_CHANGE_EVENT, type FloorSession } from '../../src/features/floor/session.tsx';
import { ATTRIBUTION, envelope, fakeTap, OPERATOR, renderFloor, RUN_ID, stepPath, stepVariant, type Answer, type Recorded } from './support.tsx';

const G04 = example('step-g04-parameters');
const commandPath = `/api/test-runs/${RUN_ID}/commands`;
const stepGet = `/api/test-runs/${RUN_ID}/steps/${encodeURIComponent('p-blend@')}`;

const VERIFIER: FloorSession = { ...OPERATOR, personId: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e61', legalName: 'TEST-Kavya Reddy', loginName: 'test-verifier-1', role: 'VERIFIER' };

/** G-04 while the operator records, at the server's run version, with the blend times it holds, for `who`. */
function viewAt(version: number, values: readonly string[], who: FloorSession = OPERATOR): StepScreenView {
  return stepVariant('step-g04-parameters', (v) => {
    v.run.version = version;
    v.run.identity = { personId: who.personId ?? '', legalName: who.legalName ?? '', loginName: who.loginName ?? '', role: who.role ?? '' };
    v.step.status = 'IN_PROGRESS';
    v.step.statusText = 'In progress';
    v.fields[1]!.attempts = [];
    v.exceptions = [];
    v.signatures = [];
    v.actions = [
      { action: 'RECORD_DATA', available: true, primary: true, requires: 'TAP', meaning: null, reason: null, target: null, whoCanHelp: [] },
      { action: 'SIGN_PERFORMED', available: false, primary: false, requires: 'SIGNATURE', meaning: 'PERFORMED', reason: 'Record blend time and speed first (ENG-DATA-MISSING)', target: null, whoCanHelp: [] },
      { action: 'RAISE_EXCEPTION', available: true, primary: false, requires: 'TAP', meaning: null, reason: null, target: null, whoCanHelp: [] },
    ];
    v.fields[0]!.attempts = values.map((value, i) => ({
      ...G04.fields[0]!.attempts[0]!,
      pointId: `${G04.fields[0]!.attempts[0]!.pointId}-${i + 1}`,
      attempt: i + 1,
      value: { kind: 'DECIMAL', value, unit: 'min' },
      echo: `You entered ${value} min`,
      verdict: { tier: 'REGISTERED', failed: true, text: `Outside the registered limit 10 to 20 min (REG-PCM500): ${value} min` },
    }));
  });
}

const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 50)));

/** A server whose command answer travels back slowly: `answer()` delivers it. */
function slowServer() {
  const server = { version: 7, recorded: [] as string[], locked: false, who: OPERATOR };
  let deliver: (a: Answer) => void = () => undefined;
  const intercept = (r: Recorded): Answer | undefined | Promise<Answer | undefined> => {
    if (server.locked) return { status: 423, body: envelope('LOCKED', 'SESSION_LOCKED', { whatHappened: 'This session is locked.' }) };
    if (r.method === 'POST' && r.path === commandPath) {
      return new Promise<Answer>((resolve) => {
        deliver = resolve;
      });
    }
    return undefined;
  };
  const fixtures = { 'execution.step': ({ params }: { params: Record<string, string> }) => (params['stepKey'] === 'p-blend@' ? viewAt(server.version, server.recorded, server.who) : { status: 404, body: envelope('NOT_ALLOWED', 'STEP-UNKNOWN') }) };
  /** The command commits on the server (the answer is still on its way). */
  const commit = (value: string): Answer => {
    server.version += 1;
    server.recorded.push(value);
    return { status: 200, body: { accepted: true, version: server.version, step: viewAt(server.version, server.recorded, OPERATOR) } };
  };
  return { server, intercept, fixtures, commit, answer: (a: Answer) => deliver(a) };
}

async function typeAndSave(value: string) {
  const input = await screen.findByRole('textbox', { name: 'Blend time' });
  await userEvent.type(input, value);
  await userEvent.click(screen.getByRole('button', { name: 'Save Blend time' }));
}

const shownValues = () => {
  const list = screen.queryByRole('list', { name: 'Recorded values: Blend time' });
  return list ? within(list).queryAllByText(/^\d+ min$/).map((e) => e.textContent) : [];
};

/**
 * A server where another terminal can record on the same step, and whose step reads can be held on the wire:
 * `holdReads()` makes the next step reads wait until `releaseReads()`.
 */
function busyStepServer() {
  const s = slowServer();
  let held: (() => void)[] | null = null;
  let lose = 0;
  const intercept = (r: Recorded): Answer | undefined | Promise<Answer | undefined> => {
    if (lose > 0 && !s.server.locked && r.method === 'GET' && r.path === stepGet) {
      lose -= 1;
      return 'NETWORK_ERROR';
    }
    if (held && !s.server.locked && r.method === 'GET' && r.path === stepGet) {
      const queue = held;
      return new Promise<Answer | undefined>((resolve) => queue.push(() => resolve(undefined)));
    }
    return s.intercept(r);
  };
  return {
    ...s,
    intercept,
    /** Another terminal records a value on this step (the run moves on). */
    recordElsewhere: (value: string) => {
      s.server.version += 1;
      s.server.recorded.push(value);
    },
    holdReads: () => {
      held = [];
    },
    /** The next step read is lost on the network. */
    loseNextRead: () => {
      lose = 1;
    },
    releaseReads: () => {
      const queue = held ?? [];
      held = null;
      for (const go of queue) go();
    },
  };
}

/** Locks the terminal the way C1 does after the server answered the lock (commands already running commit first). */
function lock(s: { server: { locked: boolean } }) {
  s.server.locked = true;
  act(() => {
    window.dispatchEvent(new CustomEvent(SESSION_CHANGE_EVENT, { detail: { reason: 'LOCK', personId: OPERATOR.personId } }));
  });
}

function unlock(s: { server: { locked: boolean } }) {
  s.server.locked = false;
  act(() => {
    window.dispatchEvent(new CustomEvent(SESSION_CHANGE_EVENT, { detail: { reason: 'UNLOCK', personId: OPERATOR.personId } }));
  });
}

describe('a session change while an entry is on its way', () => {
  it('[D1][DI-28] LOCK while "Saving…" (the command commits before the lock): after unlocking, the screen neither says the entry "will not be sent" nor hides the recorded value', async () => {
    const s = slowServer();
    const ui = renderFloor(stepPath('p-blend@'), { fixtures: s.fixtures, intercept: s.intercept });
    await typeAndSave('21');
    await waitFor(() => expect(ui.commands()).toHaveLength(1));
    await screen.findByText('Saving…');

    // Lock pressed: the command commits first, then the lock is applied, then C1 announces LOCK.
    const answer = s.commit('21');
    s.server.locked = true;
    act(() => {
      window.dispatchEvent(new CustomEvent(SESSION_CHANGE_EVENT, { detail: { reason: 'LOCK', personId: OPERATOR.personId } }));
    });
    await settle();
    expect(screen.getByText(/The session on this terminal changed after this entry was sent\. It may already be in the record/)).toBeTruthy();

    // The command's answer (the post-commit view) arrives while the terminal is locked.
    await act(async () => {
      s.answer(answer);
      await Promise.resolve();
    });
    await settle();

    // The operator unlocks (same person): no 30 s poll yet.
    s.server.locked = false;
    act(() => {
      window.dispatchEvent(new CustomEvent(SESSION_CHANGE_EVENT, { detail: { reason: 'UNLOCK', personId: OPERATOR.personId } }));
    });
    await settle();

    expect(s.server.recorded, 'precondition: the entry is in the record').toEqual(['21']);
    expect(screen.queryByText(/It will not be sent/)).toBeNull();
    expect(shownValues()).toEqual(['21 min']);
    expect(screen.getByText('The answer for the discarded entry arrived afterwards: the entry is in the record. Do not enter it again.')).toBeTruthy();
    // Nothing was sent again, and the value typed is not offered again.
    expect(ui.commands()).toHaveLength(1);
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Blend time' }).value).toBe('');
  });

  it('[D1][DI-28] LOCK while "Saving…" when the engine refuses the entry: the late answer says nothing was recorded, and the step is read again', async () => {
    const s = slowServer();
    const ui = renderFloor(stepPath('p-blend@'), { fixtures: s.fixtures, intercept: s.intercept });
    await typeAndSave('21');
    await waitFor(() => expect(ui.commands()).toHaveLength(1));
    await screen.findByText('Saving…');
    act(() => {
      window.dispatchEvent(new CustomEvent(SESSION_CHANGE_EVENT, { detail: { reason: 'LOCK', personId: OPERATOR.personId } }));
    });
    await settle();
    const readsBefore = ui.requests.filter((r) => r.method === 'GET' && r.path === stepGet).length;
    await act(async () => {
      s.answer({ status: 422, body: envelope('NOT_ALLOWED', 'ENG-VALUE-REFUSED', { whatHappened: 'The value was refused.' }) });
      await Promise.resolve();
    });
    expect(await screen.findByText('The answer for the discarded entry arrived afterwards: the server refused it, so nothing was recorded.')).toBeTruthy();
    await waitFor(() => expect(ui.requests.filter((r) => r.method === 'GET' && r.path === stepGet).length).toBeGreaterThan(readsBefore));
    expect(shownValues()).toEqual([]);
  });

  it('[D1][DI-28][INV-40] a switch while "Saving…": the late answer reloads the step for the new person (the previous person\'s view is not put in place), and the committed value appears without the 30 s poll', async () => {
    const s = slowServer();
    const ui = renderFloor(stepPath('p-blend@'), { fixtures: s.fixtures, intercept: s.intercept });
    await typeAndSave('21');
    await waitFor(() => expect(ui.commands()).toHaveLength(1));
    await screen.findByText('Saving…');

    // The verifier takes over; the reads made at the switch run before the operator's command commits.
    s.server.who = VERIFIER;
    ui.switchTo(VERIFIER);
    await waitFor(() => expect(screen.getByTestId('run-identity').textContent).toContain('TEST-Kavya Reddy'));
    await settle();
    expect(shownValues()).toEqual([]);

    const readsBefore = ui.requests.filter((r) => r.method === 'GET' && r.path === stepGet).length;
    const answer = s.commit('21');
    await act(async () => {
      s.answer(answer);
      await Promise.resolve();
    });
    await waitFor(() => expect(ui.requests.filter((r) => r.method === 'GET' && r.path === stepGet).length).toBeGreaterThan(readsBefore));
    await waitFor(() => expect(shownValues()).toEqual(['21 min']));
    // The view on show is the one read for the verifier, never the operator's post-commit view.
    expect(screen.getByTestId('run-identity').textContent).toContain('TEST-Kavya Reddy');
    expect(screen.getByTestId('run-identity').textContent).not.toContain('TEST-Arjun Das');
    expect(screen.queryByText(/It will not be sent/)).toBeNull();
  });
  it('[D1][DI-28] a late answer that arrives after the unlock reload never puts an older step view in place: a value recorded meanwhile on another terminal stays on the screen', async () => {
    const s = busyStepServer();
    const ui = renderFloor(stepPath('p-blend@'), { fixtures: s.fixtures, intercept: s.intercept });
    await typeAndSave('21');
    await waitFor(() => expect(ui.commands()).toHaveLength(1));
    await screen.findByText('Saving…');

    // The command commits (run version 8), then the lock is applied; its answer is still on the wire.
    const answer = s.commit('21');
    lock(s);
    await settle();
    // Meanwhile another terminal records a second attempt (version 9); the operator unlocks and the step is read again.
    s.recordElsewhere('19');
    unlock(s);
    await waitFor(() => expect(shownValues()).toEqual(['21 min', '19 min']));

    // Only now does the answer of the discarded entry arrive, carrying the version 8 view.
    await act(async () => {
      s.answer(answer);
      await Promise.resolve();
    });
    await settle();
    expect(shownValues(), 'the version 9 view (both values) stays; the older version 8 view is never put back').toEqual(['21 min', '19 min']);
    expect(screen.getByText('The answer for the discarded entry arrived afterwards: the entry is in the record. Do not enter it again.')).toBeTruthy();
    expect(ui.commands()).toHaveLength(1);
  });

  it('[D1][DI-28] while the step is read again after a late answer, the screen keeps the newest view it has: the late answer\'s older view is not shown even for a moment', async () => {
    const s = busyStepServer();
    const ui = renderFloor(stepPath('p-blend@'), { fixtures: s.fixtures, intercept: s.intercept });
    await typeAndSave('21');
    await waitFor(() => expect(ui.commands()).toHaveLength(1));
    await screen.findByText('Saving…');
    const answer = s.commit('21');
    lock(s);
    await settle();
    s.recordElsewhere('19');
    unlock(s);
    await waitFor(() => expect(shownValues()).toEqual(['21 min', '19 min']));

    // The next step reads are slow: the late answer arrives and the step is read again, but that read is still on its way.
    s.holdReads();
    const readsBefore = ui.requests.filter((r) => r.method === 'GET' && r.path === stepGet).length;
    await act(async () => {
      s.answer(answer);
      await Promise.resolve();
    });
    await waitFor(() => expect(ui.requests.filter((r) => r.method === 'GET' && r.path === stepGet).length, 'the step is read again after the late answer').toBeGreaterThan(readsBefore));
    await settle();
    expect(shownValues(), 'while the read is on its way, the newest view (version 9) stays on the screen').toEqual(['21 min', '19 min']);

    s.releaseReads();
    await settle();
    expect(shownValues()).toEqual(['21 min', '19 min']);
  });

  it('[D1][DI-28] a late answer whose view is newer than the screen\'s is put in place and the step is still read again: the screen never stays behind what the record holds (here the unlock reload was lost on the network)', async () => {
    const s = busyStepServer();
    const ui = renderFloor(stepPath('p-blend@'), { fixtures: s.fixtures, intercept: s.intercept });
    await typeAndSave('21');
    await waitFor(() => expect(ui.commands()).toHaveLength(1));
    await screen.findByText('Saving…');
    const answer = s.commit('21');
    lock(s);
    await settle();
    s.recordElsewhere('19');
    // The reload after the unlock is lost: the screen still has the view from before the entry (version 7).
    s.loseNextRead();
    unlock(s);
    await settle();
    expect(shownValues()).toEqual([]);

    // The late answer carries version 8 (newer than the screen's, older than the record's version 9).
    await act(async () => {
      s.answer(answer);
      await Promise.resolve();
    });
    await waitFor(() => expect(shownValues(), 'the step is read again after the late answer: the value recorded on the other terminal is shown too').toEqual(['21 min', '19 min']));
    expect(screen.getByText('The answer for the discarded entry arrived afterwards: the entry is in the record. Do not enter it again.')).toBeTruthy();
  });

  /**
   * The first send's answer is lost (it committed, or it never reached the engine); the resend is on its way when the
   * terminal is locked, and then `resendAnswer` arrives.
   */
  async function lockWhileResendOnTheWire(resendAnswer: Answer, firstCommits: boolean) {
    const s = slowServer();
    let calls = 0;
    const intercept = (r: Recorded): Answer | undefined | Promise<Answer | undefined> => {
      if (r.method === 'POST' && r.path === commandPath && !s.server.locked) {
        calls += 1;
        if (calls === 1) {
          if (firstCommits) s.commit('21');
          return 'NETWORK_ERROR';
        }
      }
      return s.intercept(r);
    };
    const ui = renderFloor(stepPath('p-blend@'), { fixtures: s.fixtures, intercept });
    await typeAndSave('21');
    const notice = await screen.findByRole('alertdialog');
    await userEvent.click(within(notice).getByRole('button', { name: 'Send again' }));
    await waitFor(() => expect(ui.commands()).toHaveLength(2));
    await screen.findByText('Saving…');
    lock(s);
    await settle();
    expect(screen.getByText(/The session on this terminal changed after this entry was sent\. It may already be in the record/)).toBeTruthy();
    await act(async () => {
      s.answer(resendAnswer);
      await Promise.resolve();
    });
    await settle();
    return { s, ui };
  }

  it('[D1][DI-28] LOCK while a resend is on its way, and the resend is refused before the server claims the key (423 SESSION_LOCKED): the notice still says the entry may be in the record, never that nothing was recorded', async () => {
    const { s, ui } = await lockWhileResendOnTheWire({ status: 423, body: envelope('LOCKED', 'SESSION_LOCKED', { whatHappened: 'This session is locked.' }) }, true);
    expect(s.server.recorded, 'precondition: the first send is in the record').toEqual(['21']);
    expect(screen.queryByText(/nothing was recorded/)).toBeNull();
    expect(screen.queryByText(/the entry is in the record/)).toBeNull();
    expect(screen.getByText(/The session on this terminal changed after this entry was sent\. It may already be in the record/)).toBeTruthy();
    expect(screen.queryByText(/It will not be sent/)).toBeNull();
    expect(new Set(ui.commands().map((c) => c.idempotencyKey)).size).toBe(1);
  });

  it('[D1][DI-28] LOCK while a resend is on its way: an answer for the key itself settles what the notice says (the replayed commit: in the record; the engine\'s refusal after the claim: nothing recorded)', async () => {
    await lockWhileResendOnTheWire({ status: 200, body: { accepted: true, version: 8, step: viewAt(8, ['21']) } }, true);
    expect(screen.getByText('The answer for the discarded entry arrived afterwards: the entry is in the record. Do not enter it again.')).toBeTruthy();
    cleanup();
    const { s } = await lockWhileResendOnTheWire({ status: 422, body: envelope('NOT_ALLOWED', 'ENG-VALUE-REFUSED', { whatHappened: 'The value was refused.' }) }, false);
    expect(s.server.recorded).toEqual([]);
    expect(screen.getByText('The answer for the discarded entry arrived afterwards: the server refused it, so nothing was recorded.')).toBeTruthy();
  });

  it('[D1][DI-28] LOCK while a kiosk resend waits for its badge tap (the first send committed, its answer was lost): the notice says the entry may be in the record, never that it "will not be sent", and the step is read again', async () => {
    const s = slowServer();
    let calls = 0;
    const intercept = (r: Recorded): Answer | undefined | Promise<Answer | undefined> => {
      if (r.method === 'POST' && r.path === commandPath && !s.server.locked) {
        calls += 1;
        if (calls === 1) {
          s.commit('21');
          return 'NETWORK_ERROR';
        }
      }
      return s.intercept(r);
    };
    // The first send gets its tap; the resend's tap is never given (the operator walks away from the badge prompt).
    const tap = fakeTap();
    tap.requestTap.mockImplementationOnce(() => Promise.resolve(ATTRIBUTION)).mockImplementation(() => new Promise<Attribution | null>(() => undefined));
    const ui = renderFloor(stepPath('p-blend@'), { tap, fixtures: s.fixtures, intercept });
    await typeAndSave('21');
    const notice = await screen.findByRole('alertdialog');
    await userEvent.click(within(notice).getByRole('button', { name: 'Send again' }));
    await waitFor(() => expect(tap.requestTap).toHaveBeenCalledTimes(2));
    expect(ui.commands(), 'precondition: the resend is still waiting for its tap, not on the wire').toHaveLength(1);
    const readsBefore = ui.requests.filter((r) => r.method === 'GET' && r.path === stepGet).length;

    lock(s);
    await settle();
    expect(s.server.recorded, 'precondition: the first send is in the record').toEqual(['21']);
    expect(screen.queryByText(/It will not be sent/)).toBeNull();
    expect(screen.getByText(/The session on this terminal changed after this entry was sent\. It may already be in the record/)).toBeTruthy();
    // The reload at the change is made (refused while locked); after the unlock the record's value is shown.
    expect(ui.requests.filter((r) => r.method === 'GET' && r.path === stepGet).length).toBeGreaterThan(readsBefore);
    unlock(s);
    await waitFor(() => expect(shownValues()).toEqual(['21 min']));
    expect(ui.commands(), 'the resend was never sent').toHaveLength(1);
  });
});

/**
 * A kiosk switch while a signature is on its way (module C4 with the C1 ceremony; INV-40; DI-34; review P44). The
 * ceremony's answer carries the server's post-commit step view, computed for the person who signed: their "You" line
 * and the actions open to them. When it arrives after another person took over the terminal, it must not be put in
 * place for the new person; the step is read again for them instead.
 */
describe('a session change while a signature is on its way', () => {
  const INV03_REASON = 'A different person must verify: you signed this step as performed (INV-03)';

  /** G-04 as the server computes it for `who`: before the performer's signature (version 7) or after it (version 8). */
  function signView(signed: boolean, who: FloorSession): StepScreenView {
    return stepVariant('step-g04-parameters', (v) => {
      v.run.version = signed ? 8 : 7;
      v.run.identity = { personId: who.personId ?? '', legalName: who.legalName ?? '', loginName: who.loginName ?? '', role: who.role ?? '' };
      v.step.status = signed ? 'AWAITING_VERIFICATION' : 'IN_PROGRESS';
      v.signatures = signed ? [G04.signatures[0]!] : [];
      const operator = who.personId === OPERATOR.personId;
      v.actions = signed
        ? [{ action: 'VERIFY', available: !operator, primary: true, requires: 'SIGNATURE', meaning: 'VERIFIED', reason: operator ? INV03_REASON : null, target: null, whoCanHelp: [] }]
        : [
            { action: 'SIGN_PERFORMED', available: operator, primary: true, requires: 'SIGNATURE', meaning: 'PERFORMED', reason: operator ? null : 'Only the operator who recorded the step signs it as performed', target: null, whoCanHelp: [] },
            { action: 'VERIFY', available: false, primary: false, requires: 'SIGNATURE', meaning: 'VERIFIED', reason: 'The step is not signed as performed yet', target: null, whoCanHelp: [] },
          ];
    });
  }

  /**
   * The operator presses Sign as performed; the ceremony's answer (the operator's post-commit view) is held until
   * `deliver()`. `commitBeforeSwitch` says whether the signature commits before the verifier takes over (then the
   * verifier's first read already shows it, at the same run version as the answer) or after (then the answer is newer
   * than anything read for the verifier).
   */
  async function signThenSwitch(commitBeforeSwitch: boolean) {
    const server = { signed: false, who: OPERATOR };
    let deliver: (() => void) | null = null;
    const ui = renderFloor(stepPath('p-blend@'), {
      fixtures: { 'execution.step': () => signView(server.signed, server.who) },
      ceremony: {
        sign: () =>
          new Promise((resolve) => {
            deliver = () => resolve({ status: 'SIGNED', manifestation: G04.signatures[0]!, result: signView(true, OPERATOR) });
          }),
      },
    });
    await waitFor(() => expect(screen.getByTestId('run-identity').textContent).toContain('TEST-Arjun Das'));
    await userEvent.click(screen.getByRole('button', { name: 'Sign as performed' }));
    await waitFor(() => expect(deliver).not.toBeNull());

    if (commitBeforeSwitch) server.signed = true;
    server.who = VERIFIER;
    ui.switchTo(VERIFIER);
    await waitFor(() => expect(screen.getByTestId('run-identity').textContent).toContain('TEST-Kavya Reddy'));
    await settle();
    server.signed = true;
    const readsBefore = ui.requests.filter((r) => r.method === 'GET' && r.path === stepGet).length;
    await act(async () => {
      deliver?.();
      await new Promise<void>((r) => setTimeout(r, 50));
    });
    return { ui, readsBefore };
  }

  /** The step screen shows the verifier's own view after the performer's signature. */
  async function expectVerifiersView() {
    await waitFor(() => expect(screen.queryByTestId('signature-PERFORMED')).not.toBeNull());
    const you = screen.getByTestId('run-identity').textContent ?? '';
    expect(you).toContain('TEST-Kavya Reddy');
    expect(you).not.toContain('TEST-Arjun Das');
    expect(screen.getByTestId('primary-action').hasAttribute('disabled'), 'Verify is open to the verifier').toBe(false);
    expect(screen.queryByText(INV03_REASON)).toBeNull();
  }

  it('[INV-40][DI-34] the signature commits, the verifier takes over, then the signer\'s answer arrives (same run version as the verifier\'s read): the verifier\'s "You" line and actions stay on the screen', async () => {
    await signThenSwitch(true);
    await expectVerifiersView();
  });

  it('[INV-40][DI-34][DI-28] the verifier takes over, then the signature commits and the signer\'s answer arrives (newer than the verifier\'s read): it is not put in place, and the step is read again for the verifier at once (no 30 s poll)', async () => {
    const { ui, readsBefore } = await signThenSwitch(false);
    await waitFor(() => expect(ui.requests.filter((r) => r.method === 'GET' && r.path === stepGet).length).toBeGreaterThan(readsBefore));
    await expectVerifiersView();
  });
});

describe('a command answer computed for another person', () => {
  it('[INV-40][DI-34] a SAVED answer whose step view names someone other than the person signed in is not put in place: the step is read again for the person signed in', async () => {
    const server = { version: 7, recorded: [] as string[] };
    const intercept = (r: Recorded): Answer | undefined => {
      if (r.method !== 'POST' || r.path !== commandPath) return undefined;
      server.version += 1;
      server.recorded.push('21');
      // The view in the answer was computed for another person (their "You" line, their actions).
      return { status: 200, body: { accepted: true, version: server.version, step: viewAt(server.version, server.recorded, VERIFIER) } };
    };
    const ui = renderFloor(stepPath('p-blend@'), { fixtures: { 'execution.step': () => viewAt(server.version, server.recorded, OPERATOR) }, intercept });
    await typeAndSave('21');
    await waitFor(() => expect(ui.commands()).toHaveLength(1));
    await waitFor(() => expect(shownValues()).toEqual(['21 min']));
    await settle();
    const you = screen.getByTestId('run-identity').textContent ?? '';
    expect(you).toContain('TEST-Arjun Das');
    expect(you).not.toContain('TEST-Kavya Reddy');
  });
});
