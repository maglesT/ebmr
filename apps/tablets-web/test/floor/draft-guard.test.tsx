/**
 * Unsaved values and the reload prompt (features/floor/unsettled.ts): a form holding values not saved yet makes a
 * reload or closing the tab ask first, as an unsettled entry does; moving within the application is not held back
 * for it. Found in the owner's demo run: a reload silently dropped the values typed into a form.
 */
import { createBrowserHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { example } from '@ebmr/api-contract/examples';
import { anyDraft, useDraftGuard, useLeaveGuard } from '../../src/features/floor/unsettled.ts';
import { fakeScaleSlot, renderFloor, stepPath, type Answer, type Recorded } from './support.tsx';

afterEach(() => {
  cleanup();
});

/** Whether the page asks before it is unloaded (the browser shows its own "leave page?" question). */
function unloadAsks(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

/** A page with a leave guard and one form whose values are saved or not (the button toggles it). */
function Page() {
  const [unsaved, setUnsaved] = useState(false);
  useLeaveGuard();
  useDraftGuard(unsaved);
  return (
    <button type="button" onClick={() => setUnsaved(!unsaved)}>
      {unsaved ? 'unsaved' : 'saved'}
    </button>
  );
}

describe('unsaved values', () => {
  it('a reload asks while a form holds unsaved values, and not once they are gone', async () => {
    const root = createRootRoute({ component: Page });
    const router = createRouter({ routeTree: root, history: createBrowserHistory() });
    await router.load();
    render(<RouterProvider router={router} />);
    const toggle = await screen.findByRole('button', { name: 'saved' });
    expect(unloadAsks()).toBe(false);
    await userEvent.click(toggle);
    expect(anyDraft()).toBe(true);
    expect(unloadAsks()).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'unsaved' }));
    expect(anyDraft()).toBe(false);
    expect(unloadAsks()).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'saved' }));
    cleanup();
    expect(anyDraft()).toBe(false);
  });

  it('a form holds a draft from the first value given until it is saved', async () => {
    const commandPath = (r: Recorded) => r.path.endsWith('/commands');
    const ok = (r: Recorded): Answer | undefined => (commandPath(r) ? { status: 200, body: { accepted: true, version: 8, step: example('step-g22-output') } } : undefined);
    const ui = renderFloor(stepPath('p-blend-out@'), { scaleSlot: fakeScaleSlot({}, []), intercept: ok });
    const form = await screen.findByTestId('form-OUTPUT_CONTAINER');
    expect(anyDraft()).toBe(false);
    await userEvent.click(within(form).getByRole('radio', { name: 'Final blend' }));
    expect(anyDraft()).toBe(true);
    await userEvent.type(within(form).getByRole('textbox', { name: 'Tare (typed by hand)' }), '1.05');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Gross (typed by hand)' }), '26.10');
    await userEvent.click(within(form).getByRole('button', { name: 'Save: Weigh one output container' }));
    await waitFor(() => expect(ui.commands()).toHaveLength(1));
    await waitFor(() => expect(anyDraft()).toBe(false));
  });
});
