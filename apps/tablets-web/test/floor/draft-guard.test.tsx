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
import type { FloorSession } from '../../src/features/floor/session.tsx';
import { anyDraft, useDraftGuard, useLeaveGuard } from '../../src/features/floor/unsettled.ts';
import { fakeScaleSlot, renderFloor, RUN_ID, stepFixtures, stepPath, stepVariant, type Answer, type Recorded } from './support.tsx';

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

// ---- Phase 2 exit review F63: the words and choices of the floor's dialogs and of the issue form ----------------------

const inProgress = stepVariant('step-g04-parameters', (v) => {
  v.step.status = 'IN_PROGRESS';
  v.step.statusText = 'In progress';
  v.exceptions = [];
  v.signatures = [];
  v.actions = [
    { action: 'RECORD_DATA', available: true, primary: true, requires: 'TAP', meaning: null, reason: null, target: null, whoCanHelp: [] },
    { action: 'RAISE_EXCEPTION', available: true, primary: false, requires: 'TAP', meaning: null, reason: null, target: null, whoCanHelp: [] },
    { action: 'HOLD_BATCH', available: true, primary: false, requires: 'TAP', meaning: null, reason: null, target: null, whoCanHelp: [] },
    { action: 'ATTACH_DEVIATION', available: true, primary: false, requires: 'TAP', meaning: null, reason: null, target: 'X-3', whoCanHelp: [] },
    { action: 'RELEASE_HOLD', available: true, primary: false, requires: 'TAP', meaning: null, reason: null, target: 'H-1', whoCanHelp: [] },
  ];
});
const commandPath = `/api/test-runs/${RUN_ID}/commands`;

async function openFromMore(item: RegExp, title: string | RegExp) {
  await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
  await userEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: item }));
  return screen.findByRole('dialog', { name: title });
}

const PACKAGE = example('test-packages').packages[0]!;
const ISSUE_FORM = {
  packageId: PACKAGE.packageId,
  product: PACKAGE.product,
  batchSizes: [
    { id: 'BS-50K', quantity: '50000', unit: '{tablets}', label: '50,000 tablets' },
    { id: 'BS-100K', quantity: '100000', unit: '{tablets}', label: '100,000 tablets' },
  ],
  markets: [
    { code: 'IN', locked: true },
    { code: 'US', locked: false },
  ],
  variants: [],
  inputs: [{ id: 'tabletsPerBatch', name: 'Tablets per batch', valueType: 'COUNT', unit: null, source: 'Batch header (issuer)', required: true }],
};
const ISSUER: Partial<FloorSession> = { role: 'BATCH_ISSUER', attribution: 'NONE', deviceCode: 'TEST-PC-01', roomCode: null };

describe('unsaved values outside the entry forms (F63)', () => {
  it('Raise an exception: the words alone hold a draft; a cancel lets it go', async () => {
    renderFloor(stepPath('p-blend@'), { fixtures: stepFixtures(inProgress) });
    await screen.findByTestId('step-card');
    const dialog = await openFromMore(/Raise an exception/, 'Raise an exception');
    expect(anyDraft()).toBe(false);
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'What happened' }), 'Granules sticking to blender wall');
    expect(anyDraft()).toBe(true);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Raise an exception' })).toBeNull());
    expect(anyDraft()).toBe(false);
  });

  it('Raise an exception: a severity chosen holds a draft until the exception is saved', async () => {
    const ui = renderFloor(stepPath('p-blend@'), {
      fixtures: stepFixtures(inProgress),
      intercept: (r) => (r.path === commandPath ? { status: 200, body: { accepted: true, version: 8, step: inProgress } } : undefined),
    });
    await screen.findByTestId('step-card');
    const dialog = await openFromMore(/Raise an exception/, 'Raise an exception');
    await userEvent.click(within(dialog).getByRole('radio', { name: /Action \(stops the next steps/ }));
    expect(anyDraft()).toBe(true);
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'What happened' }), 'Granules sticking to blender wall');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send' }));
    expect(await within(dialog).findByText(/^Saved: /)).toBeTruthy();
    expect(ui.commands()).toHaveLength(1);
    // Saved: the dialog is done, its words are in the record, and a reload has nothing to ask about.
    expect(anyDraft()).toBe(false);
  });

  it('Hold the batch: the hold type or the reason holds a draft', async () => {
    renderFloor(stepPath('p-blend@'), { fixtures: stepFixtures(inProgress) });
    await screen.findByTestId('step-card');
    let dialog = await openFromMore(/Hold the batch/, 'Hold the batch');
    await userEvent.click(within(dialog).getByRole('radio', { name: 'QA hold' }));
    expect(anyDraft()).toBe(true);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(anyDraft()).toBe(false));
    dialog = await openFromMore(/Hold the batch/, 'Hold the batch');
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Suspected cross-contamination');
    expect(anyDraft()).toBe(true);
  });

  it('Link a deviation and Release the hold: the number or the reason typed holds a draft', async () => {
    renderFloor(stepPath('p-blend@'), { fixtures: stepFixtures(inProgress) });
    await screen.findByTestId('step-card');
    let dialog = await openFromMore(/Link a deviation/, /^Link a deviation to/);
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Deviation number' }), 'DEV-TEST-0001');
    expect(anyDraft()).toBe(true);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(anyDraft()).toBe(false));
    dialog = await openFromMore(/Release the hold/, 'Release the hold');
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Reason for the release' }), 'Engineering checked the blender');
    expect(anyDraft()).toBe(true);
  });

  it('Hold point decision: the decision or the comment holds a draft; a cancel lets it go', async () => {
    renderFloor(stepPath('H-BLEND@'), { session: { role: 'QA_SHOP_FLOOR' } });
    await userEvent.click(await screen.findByRole('button', { name: 'Decide the hold point' }));
    const dialog = await screen.findByRole('dialog', { name: 'Decide the hold point' });
    expect(anyDraft()).toBe(false);
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Comment (optional)' }), 'Blend uniformity results reviewed');
    expect(anyDraft()).toBe(true);
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Released' }));
    expect(anyDraft()).toBe(true);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Decide the hold point' })).toBeNull());
    expect(anyDraft()).toBe(false);
  });

  it('QA disposition: the outcome or the justification holds a draft', async () => {
    const qa = stepVariant('step-g04-parameters', (v) => {
      v.actions = [{ action: 'DISPOSITION_EXCEPTION', available: true, primary: false, requires: 'SIGNATURE', meaning: 'EXCEPTION_DISPOSITIONED', reason: null, target: 'X-3', whoCanHelp: [] }];
    });
    renderFloor(stepPath('p-blend@'), { session: { role: 'QA_SHOP_FLOOR' }, fixtures: stepFixtures(qa) });
    const exception = await screen.findByTestId('exception-X-3');
    await userEvent.click(within(exception).getByRole('button', { name: 'Disposition the exception (QA)' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('radio', { name: 'No impact' }));
    expect(anyDraft()).toBe(true);
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Justification' }), 'Speed within validated range VR-BLEND-01');
    expect(anyDraft()).toBe(true);
  });

  it('Issue form: a batch size, a market or an input given holds a draft; the markets the MBR fixes alone do not', async () => {
    renderFloor(`/packages/${PACKAGE.packageId}/issue`, { session: ISSUER, fixtures: { 'execution.issueForm': ISSUE_FORM } });
    await screen.findByRole('radio', { name: '100,000 tablets (100000 {tablets})' });
    expect(anyDraft()).toBe(false);
    await userEvent.click(screen.getByRole('checkbox', { name: /^US/ }));
    expect(anyDraft()).toBe(true);
    await userEvent.click(screen.getByRole('checkbox', { name: /^US/ }));
    expect(anyDraft()).toBe(false);
    await userEvent.type(screen.getByRole('textbox', { name: 'Tablets per batch' }), '100000');
    expect(anyDraft()).toBe(true);
    await userEvent.click(screen.getByRole('radio', { name: '100,000 tablets (100000 {tablets})' }));
    expect(anyDraft()).toBe(true);
  });
});
