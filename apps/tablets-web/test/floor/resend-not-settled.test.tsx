/**
 * A NOT SAVED entry stays NOT SAVED, under its idempotency key, until the server answers for that key (module C4;
 * decision D1; DI-28; INV-40; review P42). After a lost answer the first send may have committed. A refusal the
 * server gives before it claims the key (bind.ts sessionGate and commandGate, attribution.ts authenticateTap:
 * a badge or PIN not accepted, a locked session, a rate limit, a missing tap, the device proof, CSRF, the role
 * not chosen, another person's badge) says nothing about that first send, so it must not end the notice, retire
 * the key or unlock the form; only SAVED or the engine's own refusal (given after the claim) settles the entry.
 *
 * The fake server behaves like the real one: attribution is checked first, then the key is claimed (a known key
 * replays its stored result), then the engine checks the run version (ENG-STALE) and commits.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { RefusalEnvelope, StepScreenView } from '@ebmr/api-contract';
import { example } from '@ebmr/api-contract/examples';
import { ATTRIBUTION, envelope, fakeTap, OPERATOR, renderFloor, RUN_ID, stepPath, stepVariant, type Answer, type Recorded } from './support.tsx';

const G04 = example('step-g04-parameters');
const commandPath = `/api/test-runs/${RUN_ID}/commands`;
const stepGet = `/api/test-runs/${RUN_ID}/steps/${encodeURIComponent('p-blend@')}`;
const GOOD_PIN = '1234';

/** G-04 while the operator records, at the server's run version, with the blend times the server holds (computed for the operator). */
function viewAt(version: number, values: readonly string[]): StepScreenView {
  return stepVariant('step-g04-parameters', (v) => {
    v.run.version = version;
    v.run.identity = { personId: OPERATOR.personId ?? '', legalName: OPERATOR.legalName ?? '', loginName: OPERATOR.loginName ?? '', role: OPERATOR.role ?? '' };
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

/**
 * A server whose first command commits and loses its answer; later sends get `preClaim` (a refusal given before
 * the key is claimed) while it returns one, then the real path (attribution, claim, engine).
 */
function lostThenServer(preClaim: (r: Recorded, call: number) => Answer | undefined) {
  const server = { version: 7, recorded: [] as { key: string; value: string }[], stored: new Map<string, Answer>() };
  let calls = 0;
  const intercept = (r: Recorded): Answer | undefined => {
    if (r.method !== 'POST' || r.path !== commandPath) return undefined;
    calls += 1;
    const refused = calls > 1 ? preClaim(r, calls) : undefined;
    if (refused) return refused;
    const key = r.idempotencyKey ?? '';
    const replay = server.stored.get(key);
    if (replay) return replay;
    if (r.body?.['expectedVersion'] !== server.version) return { status: 409, body: envelope('STALE', 'ENG-STALE') };
    const intent = r.body?.['intent'] as { value: { value: string } };
    server.version += 1;
    server.recorded.push({ key, value: intent.value.value });
    const answer: Answer = { status: 200, body: { accepted: true, version: server.version, step: viewAt(server.version, server.recorded.map((x) => x.value)) } };
    server.stored.set(key, answer);
    return calls === 1 ? 'NETWORK_ERROR' : answer;
  };
  const fixtures = { 'execution.step': ({ params }: { params: Record<string, string> }) => (params['stepKey'] === 'p-blend@' ? viewAt(server.version, server.recorded.map((x) => x.value)) : { status: 404, body: envelope('NOT_ALLOWED', 'STEP-UNKNOWN') }) };
  return { server, intercept, fixtures };
}

async function typeSaveAndLose(value: string) {
  const input = await screen.findByRole('textbox', { name: 'Blend time' });
  await userEvent.type(input, value);
  await userEvent.click(screen.getByRole('button', { name: 'Save Blend time' }));
  return screen.findByRole('alertdialog');
}

describe('a NOT SAVED resend that the server refuses before it claims the key', () => {
  it('[D1][DI-28][INV-40] a PIN not accepted on the resend (401 EBMR-IAM-140) keeps the entry NOT SAVED under the same key, with the refusal inside the notice; the value is recorded once', async () => {
    const pins = [GOOD_PIN, '9999'];
    const tap = fakeTap();
    tap.requestTap.mockImplementation(() => Promise.resolve({ ...ATTRIBUTION, pin: pins.shift() ?? GOOD_PIN }));
    const { server, intercept, fixtures } = lostThenServer((r) => {
      const att = r.body?.['attribution'] as { pin?: string } | undefined;
      return att?.pin === GOOD_PIN ? undefined : { status: 401, body: envelope('AUTH_FAILED', 'EBMR-IAM-140', { whatHappened: 'The badge or PIN was not accepted.', whatYouCanDo: ['Tap your own badge and enter your PIN again.'] }, true) };
    });
    const ui = renderFloor(stepPath('p-blend@'), { session: { attribution: 'TAP_PIN' }, tap, fixtures, intercept });

    const dialog = await typeSaveAndLose('21');
    expect(within(dialog).getByTestId('not-saved-entry').textContent).toBe('Entry: Blend time: 21 min');
    expect(server.recorded).toHaveLength(1);
    // The first send is in the record, and the notice does not say otherwise: whether it is recorded is not known.
    expect(within(dialog).getByTestId('not-saved-body').textContent).toContain('it is not known whether this entry is in the record');
    expect(dialog.textContent).not.toMatch(/not in the record until/);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Send again' }));
    await waitFor(() => expect(ui.commands()).toHaveLength(2));
    await settle();
    const [first, second] = ui.commands();
    expect(second?.idempotencyKey).toBe(first?.idempotencyKey);
    // Still NOT SAVED, the refusal shown inside the notice, the form still locked with the value.
    const notice = screen.getByRole('alertdialog');
    expect(within(notice).getByTestId('not-saved-entry').textContent).toBe('Entry: Blend time: 21 min');
    expect(within(notice).getByTestId('not-saved-resend-refused').textContent).toContain('that refusal does not say whether the first send was recorded: it is still not known');
    expect(notice.textContent).not.toMatch(/not in the record until/);
    expect(within(notice).getByTestId('refusal').getAttribute('data-code')).toBe('EBMR-IAM-140');
    expect(within(notice).getByText('The badge or PIN was not accepted.')).toBeTruthy();

    // The 30 s poll reloads the view (the run is at version 8 on the server); the notice stays.
    await act(() => ui.qc.refetchQueries());
    await settle();
    expect(screen.queryByRole('alertdialog')).not.toBeNull();

    // The operator does what the screen offers next: "Send again" while NOT SAVED is shown, otherwise Save.
    const again = screen.queryByRole('button', { name: 'Send again' });
    await userEvent.click(again ?? screen.getByRole('button', { name: 'Save Blend time' }));
    await waitFor(() => expect(ui.commands()).toHaveLength(3));
    await settle();

    expect(server.recorded.map((x) => x.value), 'blend time was typed and confirmed once; the server must record it once').toEqual(['21']);
    expect(new Set(ui.commands().map((c) => c.idempotencyKey)).size, 'every send of the one NOT SAVED entry carries its original idempotency key (D1)').toBe(1);
    // The right PIN: the server replays the stored commit for the key; the entry is settled as saved.
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    const field = screen.getByTestId('field-blendTime');
    expect(await within(field).findByText(/Limit check: Outside the registered limit/)).toBeTruthy();
    expect(screen.getByText('Saved: Blend time: 21 min')).toBeTruthy();
  });

  const preClaimRefusals: [string, number, RefusalEnvelope][] = [
    ['session locked', 423, envelope('LOCKED', 'SESSION_LOCKED', { whatHappened: 'This session is locked.' })],
    ['rate limited', 429, envelope('NOT_ALLOWED', 'RATE_LIMITED', { whatHappened: 'Too many attempts.' }, true)],
    ['device proof', 403, envelope('NOT_ALLOWED', 'DEVICE_PROOF', { whatHappened: 'The device proof did not verify.' })],
    ['CSRF', 403, envelope('NOT_ALLOWED', 'CSRF', { whatHappened: 'The request was not bound to this session.' })],
    ['tap and PIN required', 428, envelope('NOT_ALLOWED', 'TAP_PIN_REQUIRED', { whatHappened: 'Tap your badge and enter your PIN.' })],
    ['role not chosen', 409, envelope('NOT_ALLOWED', 'ROLE_CHOICE_REQUIRED', { whatHappened: 'Choose the role you are working in before you continue.' })],
    ['account locked', 423, envelope('AUTH_FAILED', 'AUTH_LOCKED', { whatHappened: 'The account is locked.' })],
    ['a kernel refusal that may come before the claim', 403, envelope('NOT_ALLOWED', 'EBMR-IAM-040', { whatHappened: 'Not authorised.' })],
  ];
  for (const [what, status, refusal] of preClaimRefusals) {
    it(`[D1][DI-28] a resend refused before the key is claimed (${what}, ${status} ${refusal.refusal.code}) settles nothing: NOT SAVED stays, same key, the form stays locked with the value`, async () => {
      let refuse = true;
      const { server, intercept, fixtures } = lostThenServer(() => (refuse ? { status, body: refusal } : undefined));
      const ui = renderFloor(stepPath('p-blend@'), { fixtures, intercept });
      const dialog = await typeSaveAndLose('21');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Send again' }));
      await waitFor(() => expect(ui.commands()).toHaveLength(2));
      await settle();
      const notice = screen.getByRole('alertdialog');
      expect(within(notice).getByTestId('refusal').getAttribute('data-code')).toBe(refusal.refusal.code);
      expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Blend time' }).value).toBe('21');
      // Once the server answers for the key, the stored commit is replayed: recorded once, one key.
      refuse = false;
      await userEvent.click(within(notice).getByRole('button', { name: 'Send again' }));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      expect(new Set(ui.commands().map((c) => c.idempotencyKey)).size).toBe(1);
      expect(server.recorded.map((x) => x.value)).toEqual(['21']);
    });
  }

  it('[D1][DI-28][INV-40] another person\'s badge on the resend (409 SWITCH_USER) keeps the entry NOT SAVED and offers no switch; discarding it says it may be in the record and reloads the step', async () => {
    const other = envelope('SWITCH_USER', 'SWITCH_USER', { whatHappened: 'This badge belongs to TEST-Kavya Reddy.', details: { switchToLegalName: 'TEST-Kavya Reddy', switchToLoginName: 'test-verifier-1' } });
    const { server, intercept, fixtures } = lostThenServer(() => ({ status: 409, body: other }));
    const ui = renderFloor(stepPath('p-blend@'), { fixtures, intercept });
    const dialog = await typeSaveAndLose('21');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send again' }));
    await waitFor(() => expect(ui.commands()).toHaveLength(2));
    await settle();
    const notice = screen.getByRole('alertdialog');
    expect(within(notice).getByText('This badge belongs to TEST-Kavya Reddy.')).toBeTruthy();
    expect(ui.tap.offerSwitch).not.toHaveBeenCalled();
    expect(screen.queryByText(/The unsent entry was discarded/)).toBeNull();

    const readsBefore = ui.requests.filter((r) => r.method === 'GET' && r.path === stepGet).length;
    await userEvent.click(within(notice).getByRole('button', { name: 'Discard and check the record' }));
    expect(await screen.findByText(/it had been sent and may already be in the record/)).toBeTruthy();
    await waitFor(() => expect(ui.requests.filter((r) => r.method === 'GET' && r.path === stepGet).length).toBeGreaterThan(readsBefore));
    // The reload shows what the record holds: the first send's commit.
    const field = screen.getByTestId('field-blendTime');
    expect(await within(field).findByText(/Limit check: Outside the registered limit/)).toBeTruthy();
    expect(server.recorded).toHaveLength(1);
  });

  it('[DI-28] the engine\'s own refusal on a resend (given after the key was claimed) settles the entry: nothing was applied, the next save is a new entry', async () => {
    // The first send never reached the engine; the resend reaches it and is refused as stale (ENG-STALE).
    let calls = 0;
    const intercept = (r: Recorded): Answer | undefined => {
      if (r.path !== commandPath) return undefined;
      calls += 1;
      return calls === 1 ? 'NETWORK_ERROR' : { status: 409, body: envelope('STALE', 'ENG-STALE', { whatHappened: 'The run changed.' }) };
    };
    const ui = renderFloor(stepPath('p-blend@'), { fixtures: { 'execution.step': () => viewAt(7, []) }, intercept });
    const dialog = await typeSaveAndLose('16');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send again' }));
    expect(await screen.findByTestId('stale-changes')).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Save Blend time' }));
    await waitFor(() => expect(ui.commands()).toHaveLength(3));
    expect(ui.commands()[2]?.idempotencyKey).not.toBe(ui.commands()[0]?.idempotencyKey);
  });
});
