/**
 * Issuing a test batch and importing a test package go through the same pending-entry path as a step entry
 * (module C4; decision D1; DI-28; INV-40; reviews P42, P43, P45):
 * - after a lost answer, only an answer for the entry's idempotency key settles it. The issue route checks the
 *   request with the engine before it claims the key (packages.ts checkIssue), so there even an engine refusal
 *   (ENG-ISSUE-...) keeps the issue NOT SAVED under the same key;
 * - a session change empties the issue form, so nothing one person chose or typed is offered to the next;
 * - an issue or import that may have reached the server and was discarded (by the person or a session change),
 *   or whose answer arrives late, makes the screens read again what the server holds.
 *
 * The fake server behaves like the real one: the request is checked, then the key is claimed (a known key
 * replays its stored result), then the batch is issued or the package imported.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { example } from '@ebmr/api-contract/examples';
import type { FloorSession } from '../../src/features/floor/session.tsx';
import { envelope, OPERATOR, renderFloor, type Answer, type Recorded } from './support.tsx';

const PACKAGE = example('test-packages').packages[0]!;
const notImported = { ...PACKAGE, imported: false, importedAt: null };
const RUN = example('run');
const importPath = `/api/test-packages/${PACKAGE.packageId}/import`;
const issuePath = '/api/test-runs';

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
const OTHER_ISSUER: FloorSession = { ...OPERATOR, ...ISSUER, personId: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e81', legalName: 'TEST-Neha Joshi', loginName: 'test-steward' };

const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 50)));

async function fillIssueForm() {
  await userEvent.click(await screen.findByRole('radio', { name: '100,000 tablets (100000 {tablets})' }));
  await userEvent.type(screen.getByRole('textbox', { name: 'Tablets per batch' }), '100000');
}

function issueFormSeen() {
  return {
    sizeChecked: screen
      .getAllByRole<HTMLInputElement>('radio')
      .filter((r) => r.checked)
      .map((r) => r.value),
    count: screen.getByRole<HTMLInputElement>('textbox', { name: 'Tablets per batch' }).value,
    submitEnabled: !screen.getByRole('button', { name: 'Issue the test batch' }).hasAttribute('disabled'),
  };
}

/** The runs list in the query cache: `isInvalidated` says it is marked to be read again. */
function runsListState(qc: ReturnType<typeof renderFloor>['qc']) {
  return qc.getQueryCache().findAll({ queryKey: [routes.execution.runs.id] })[0]?.state;
}

describe('issuing a test batch', () => {
  it('[D1][DI-28][INV-40] after a lost answer, an engine check the server makes before it claims the key (422 ENG-ISSUE-SIZE) settles nothing: the issue stays NOT SAVED under the same key and one batch is issued', async () => {
    const server = { issued: [] as string[], stored: new Map<string, Answer>(), checkFails: false };
    let calls = 0;
    const intercept = (r: Recorded): Answer | undefined => {
      if (r.method !== 'POST' || r.path !== issuePath) return undefined;
      calls += 1;
      // The request check (checkIssue) runs before the key is claimed.
      if (server.checkFails) return { status: 422, body: envelope('INVALID_INPUT', 'ENG-ISSUE-SIZE', { whatHappened: 'The batch cannot be issued with these values. Nothing was issued.' }) };
      const key = r.idempotencyKey ?? '';
      const replay = server.stored.get(key);
      if (replay) return replay;
      server.issued.push(key);
      const answer: Answer = { status: 200, body: RUN };
      server.stored.set(key, answer);
      return calls === 1 ? 'NETWORK_ERROR' : answer;
    };
    const ui = renderFloor(`/packages/${PACKAGE.packageId}/issue`, { session: ISSUER, fixtures: { 'execution.issueForm': ISSUE_FORM, 'execution.run': RUN }, intercept });
    await fillIssueForm();
    await userEvent.click(screen.getByRole('button', { name: 'Issue the test batch' }));
    const notice = await screen.findByRole('alertdialog');
    expect(server.issued).toHaveLength(1);

    server.checkFails = true;
    await userEvent.click(within(notice).getByRole('button', { name: 'Send again' }));
    await waitFor(() => expect(calls).toBe(2));
    await settle();
    // Still NOT SAVED: the refusal is shown inside the notice; the form stays locked with what was chosen.
    const still = screen.getByRole('alertdialog');
    expect(within(still).getByTestId('refusal').getAttribute('data-code')).toBe('ENG-ISSUE-SIZE');
    expect(issueFormSeen()).toEqual({ sizeChecked: ['BS-100K'], count: '100000', submitEnabled: false });

    // The check passes again: the resend under the same key replays the stored issue; the new run opens.
    server.checkFails = false;
    await userEvent.click(within(still).getByRole('button', { name: 'Send again' }));
    await waitFor(() => expect(ui.router.state.location.pathname).toBe(`/runs/${RUN.header.runId}`));
    const keys = ui.requests.filter((r) => r.method === 'POST' && r.path === issuePath).map((r) => r.idempotencyKey);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size, 'every send of the one issue carries its original idempotency key').toBe(1);
    expect(server.issued, 'one test batch issued').toHaveLength(1);
  });

  it('[INV-40][DI-14] a session change empties the issue form: nothing one person chose or typed is offered to the next person, even when the page stays mounted', async () => {
    const ui = renderFloor(`/packages/${PACKAGE.packageId}/issue`, { session: ISSUER, fixtures: { 'execution.issueForm': ISSUE_FORM }, resetReadsOnPersonChange: false });
    await fillIssueForm();
    await userEvent.click(screen.getByRole('checkbox', { name: /^US/ }));
    expect(issueFormSeen()).toEqual({ sizeChecked: ['BS-100K'], count: '100000', submitEnabled: true });

    ui.switchTo(OTHER_ISSUER);
    await waitFor(() => expect(issueFormSeen()).toEqual({ sizeChecked: [], count: '', submitEnabled: false }));
    // The market the MBR sets stays; the one chosen by the previous person does not.
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /IN \(set by the MBR\)/ }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /^US/ }).checked).toBe(false);
    expect(ui.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  });

  it('[D1][DI-28] discarding a NOT SAVED issue marks the runs list to be read again (the batch may have been issued)', async () => {
    const ui = renderFloor('/runs', { session: ISSUER, fixtures: { 'execution.issueForm': ISSUE_FORM }, intercept: (r) => (r.method === 'POST' && r.path === issuePath ? 'NETWORK_ERROR' : undefined) });
    await screen.findByRole('heading', { name: 'Test runs' });
    await waitFor(() => expect(runsListState(ui.qc)?.status).toBe('success'));
    await act(() => ui.router.navigate({ to: '/packages/$packageId/issue', params: { packageId: PACKAGE.packageId } }));
    await fillIssueForm();
    await userEvent.click(screen.getByRole('button', { name: 'Issue the test batch' }));
    const notice = await screen.findByRole('alertdialog');
    expect(runsListState(ui.qc)?.isInvalidated).toBe(false);
    await userEvent.click(within(notice).getByRole('button', { name: 'Discard and check the record' }));
    expect(await screen.findByText(/it had been sent and may already be in the record/)).toBeTruthy();
    await waitFor(() => expect(runsListState(ui.qc)?.isInvalidated).toBe(true));
  });

  it('[D1][DI-28] an issue answered after a switch of user marks the runs list to be read again, and says the batch is in the record', async () => {
    let deliver: (a: Answer) => void = () => undefined;
    const ui = renderFloor('/runs', {
      session: ISSUER,
      fixtures: { 'execution.issueForm': ISSUE_FORM },
      intercept: (r) =>
        r.method === 'POST' && r.path === issuePath
          ? new Promise<Answer>((resolve) => {
              deliver = resolve;
            })
          : undefined,
    });
    await screen.findByRole('heading', { name: 'Test runs' });
    await act(() => ui.router.navigate({ to: '/packages/$packageId/issue', params: { packageId: PACKAGE.packageId } }));
    await fillIssueForm();
    await userEvent.click(screen.getByRole('button', { name: 'Issue the test batch' }));
    await screen.findByText('Saving…');
    ui.switchTo(OTHER_ISSUER);
    await settle();
    // The switch dropped every cached read (app/session-reads.tsx); the runs list is not marked yet.
    await waitFor(() => expect(runsListState(ui.qc)?.isInvalidated).toBe(false));

    await act(async () => {
      deliver({ status: 200, body: RUN });
      await Promise.resolve();
    });
    await waitFor(() => expect(runsListState(ui.qc)?.isInvalidated).toBe(true));
    expect(await screen.findByText('The answer for the discarded entry arrived afterwards: the entry is in the record. Do not enter it again.')).toBeTruthy();
    // Nothing navigates the next person to the previous person's new run.
    expect(ui.router.state.location.pathname).toBe(`/packages/${PACKAGE.packageId}/issue`);
  });
});

describe('importing a test package', () => {
  /** A server where the package becomes imported once an import commits. */
  function importServer(answer: (commit: () => Answer) => Answer | Promise<Answer>) {
    const server = { imported: false };
    const commit = (): Answer => {
      server.imported = true;
      return { status: 200, body: PACKAGE };
    };
    return {
      server,
      fixtures: { 'execution.testPackages': () => ({ packages: [server.imported ? PACKAGE : notImported] }) },
      intercept: (r: Recorded): Answer | undefined | Promise<Answer> => (r.method === 'POST' && r.path === importPath ? answer(commit) : undefined),
    };
  }

  it('[D1][DI-28] discarding a NOT SAVED import reads the package list again: an import that did reach the server shows as imported, so it is not imported twice', async () => {
    const s = importServer((commit) => {
      commit();
      return 'NETWORK_ERROR';
    });
    renderFloor('/packages', { fixtures: s.fixtures, intercept: s.intercept });
    const item = await screen.findByTestId(`package-${PACKAGE.packageId}`);
    await userEvent.click(within(item).getByRole('button', { name: 'Import' }));
    const notice = await screen.findByRole('alertdialog');
    expect(s.server.imported).toBe(true);
    await userEvent.click(within(notice).getByRole('button', { name: 'Discard and check the record' }));
    const after = await screen.findByTestId(`package-${PACKAGE.packageId}`);
    expect(await within(after).findByRole('link', { name: 'Issue a test batch' })).toBeTruthy();
    expect(within(after).queryByRole('button', { name: 'Import' })).toBeNull();
  });

  it('[D1][DI-28] an import answered after a switch of user reads the package list again: the list read at the switch (before the commit) is not left on the screen', async () => {
    let deliver: () => void = () => undefined;
    const s = importServer(
      (commit) =>
        new Promise<Answer>((resolve) => {
          deliver = () => resolve(commit());
        }),
    );
    const ui = renderFloor('/packages', { fixtures: s.fixtures, intercept: s.intercept });
    const item = await screen.findByTestId(`package-${PACKAGE.packageId}`);
    await userEvent.click(within(item).getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(ui.requests.some((r) => r.path === importPath)).toBe(true));
    ui.switchTo({ ...OPERATOR, personId: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e61', legalName: 'TEST-Kavya Reddy', loginName: 'test-verifier-1', role: 'VERIFIER' });
    // The list read for the next person at the switch still shows the package as not imported.
    await waitFor(() => expect(within(screen.getByTestId(`package-${PACKAGE.packageId}`)).getByRole('button', { name: 'Import' })).toBeTruthy());

    await act(async () => {
      deliver();
      await Promise.resolve();
    });
    await waitFor(() => expect(within(screen.getByTestId(`package-${PACKAGE.packageId}`)).queryByRole('link', { name: 'Issue a test batch' })).not.toBeNull());
    expect(ui.requests.filter((r) => r.path === importPath)).toHaveLength(1);
  });
});
