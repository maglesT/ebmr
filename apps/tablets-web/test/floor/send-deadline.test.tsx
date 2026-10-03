/**
 * A floor entry whose request the server never answers (Phase 2 exit review F60; DI-28, decision D1): a connection
 * that stalls without a reset, a request queued behind the browser's connections, a handler waiting on a lock. The
 * send is given up and aborted after SEND_DEADLINE_MS and counts as a lost answer: the entry becomes NOT SAVED, with
 * Send again under the same idempotency key and Discard, never "Saving..." without end.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { callWithDeadline, SEND_DEADLINE_MS } from '../../src/api/deadline.ts';
import { renderFloor, RUN_ID, stepFixtures, stepPath, stepVariant, type Answer } from './support.tsx';

const commandPath = `/api/test-runs/${RUN_ID}/commands`;
const inProgress = stepVariant('step-g04-parameters', (v) => {
  v.step.status = 'IN_PROGRESS';
  v.fields[0]!.attempts = [];
  v.fields[1]!.attempts = [];
  v.exceptions = [];
  v.signatures = [];
  v.actions = [{ action: 'RECORD_DATA', available: true, primary: true, requires: 'TAP', meaning: null, reason: null, target: null, whoCanHelp: [] }];
});

afterEach(() => {
  vi.useRealTimers();
});

const advance = (ms: number) =>
  act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  });

describe('a floor entry the server never answers (F60)', () => {
  it('[DI-28] becomes NOT SAVED once the deadline passes; Send again resends the same entry under the same key', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let sends = 0;
    const ui = renderFloor(stepPath('p-blend@'), {
      fixtures: stepFixtures(inProgress),
      intercept: (r) => {
        if (r.method !== 'POST' || r.path !== commandPath) return undefined;
        sends += 1;
        return sends === 1 ? new Promise<Answer>(() => undefined) : { status: 200, body: { accepted: true, version: 8, step: null } };
      },
    });
    const field = await screen.findByTestId(`field-${inProgress.fields[0]!.item}`);
    await userEvent.type(within(field).getAllByRole('textbox')[0]!, '15');
    await userEvent.click(within(field).getByRole('button', { name: /^Save/ }));
    expect(await screen.findByText('Saving…')).toBeTruthy();

    await advance(SEND_DEADLINE_MS - 1_000);
    expect({ saving: screen.queryByText('Saving…') !== null, notSaved: screen.queryByTestId('not-saved-body') !== null }).toEqual({ saving: true, notSaved: false });

    await advance(1_000);
    expect(await screen.findByTestId('not-saved-body')).toBeTruthy();
    expect(screen.queryByText('Saving…')).toBeNull();
    expect(screen.getByRole('button', { name: 'Discard and check the record' })).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Send again' }));
    await waitFor(() => expect(ui.commands()).toHaveLength(2));
    const [first, second] = ui.commands();
    expect({ sameKey: first?.idempotencyKey === second?.idempotencyKey, sameBody: JSON.stringify(first?.body) === JSON.stringify(second?.body) }).toEqual({ sameKey: true, sameBody: true });
    expect(await within(field).findByText(/^Saved: /)).toBeTruthy();
  });
});

describe('callWithDeadline (F60)', () => {
  it('[DI-28] gives up a call the server has not answered within the deadline: a NETWORK error, and the request is aborted', async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    const pending = callWithDeadline(30_000, (signal) => {
      seen = signal;
      return new Promise(() => undefined);
    });
    vi.advanceTimersByTime(29_999);
    expect(seen?.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(await pending).toEqual({ ok: false, error: { kind: 'NETWORK', message: 'The server did not answer in time.' } });
    expect(seen?.aborted).toBe(true);
  });

  it('[DI-28] an answer within the deadline is the answer, and nothing is aborted', async () => {
    let seen: AbortSignal | undefined;
    const r = await callWithDeadline(30_000, (signal) => {
      seen = signal;
      return Promise.resolve({ ok: true as const, value: 'x', status: 200 });
    });
    expect(r).toEqual({ ok: true, value: 'x', status: 200 });
    expect(seen?.aborted).toBe(false);
  });
});
