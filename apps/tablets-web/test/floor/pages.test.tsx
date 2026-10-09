/**
 * Sandbox test-run pages (module C4): the cockpit keeps unavailable work visible with the server's reason; the
 * packages inbox shows hashes and origin and imports with a tap on a kiosk (none on the office PC); the issue
 * form offers approved sizes only and sends header inputs as text; the run overview replays the record.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { example } from '@ebmr/api-contract/examples';
import { envelope, renderFloor, RUN_ID, type Recorded } from './support.tsx';

const PACKAGE = example('test-packages').packages[0]!;
const notImported = { ...PACKAGE, imported: false, importedAt: null };

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

describe('cockpit ("What you can do now")', () => {
  it('[DI-34] lists the room\'s work; an item not available now stays visible, greyed, with the server\'s reason', async () => {
    renderFloor('/cockpit');
    const verify = await screen.findByTestId('work-p-blend@');
    expect(verify.getAttribute('data-available')).toBe('true');
    expect(within(verify).getByRole('link', { name: 'Open step 2.1.4' })).toBeTruthy();
    const later = screen.getByTestId('work-p-blend-out@');
    expect(later.getAttribute('data-available')).toBe('false');
    expect(within(later).getByTestId('work-reason').textContent).toContain('The QA hold point 2.2.1 must be released first');
    expect(within(later).getByRole('link', { name: 'View step 2.2.2' })).toBeTruthy();
    expect(screen.getByText('Room BLEND-1')).toBeTruthy();
  });

  it('opens the step screen from the queue', async () => {
    const ui = renderFloor('/cockpit');
    await userEvent.click(await screen.findByRole('link', { name: 'Open step 2.1.4' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Step 2.1.4 of 13 · Blend' })).toBeTruthy();
    expect(decodeURIComponent(ui.router.state.location.pathname)).toBe(`/runs/${RUN_ID}/steps/p-blend@`);
  });
});

describe('test-run packages', () => {
  it('shows each package with its hashes and GMP origin; importing on a kiosk takes a badge tap and an idempotency key', async () => {
    let imported = false;
    const ui = renderFloor('/packages', {
      fixtures: { 'execution.testPackages': () => ({ packages: [imported ? PACKAGE : notImported] }) },
      intercept: (r: Recorded) => {
        if (r.path !== `/api/test-packages/${PACKAGE.packageId}/import`) return undefined;
        imported = true;
        return { status: 200, body: PACKAGE };
      },
    });
    const item = await screen.findByTestId(`package-${PACKAGE.packageId}`);
    expect(item.textContent).toContain(PACKAGE.packageHash);
    expect(item.textContent).toContain(PACKAGE.contentHash);
    expect(item.textContent).toContain('Exported from GMP by Asha Rao (asha.rao)');
    await userEvent.click(within(item).getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(ui.requests.some((r) => r.path.endsWith('/import'))).toBe(true));
    const sent = ui.requests.find((r) => r.path.endsWith('/import'))!;
    expect(sent.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent.body?.['attribution']).toBeDefined();
    expect(ui.tap.requestTap).toHaveBeenCalledWith('Import the test package', { method: 'POST', path: `/api/test-packages/${PACKAGE.packageId}/import`, body: {} });
    expect(await screen.findByRole('link', { name: 'Issue a test batch' })).toBeTruthy();
  });

  it('on the office PC (no per-entry attribution) the import is sent without a tap; a package with a problem cannot be imported, with the server\'s reason', async () => {
    const problem = { ...notImported, packageId: 'aa'.repeat(32), packageHash: 'aa'.repeat(32), problem: 'The package hash does not match its content.' };
    const ui = renderFloor('/packages', {
      session: { attribution: 'NONE', deviceCode: 'TEST-PC-01', roomCode: null },
      fixtures: { 'execution.testPackages': { packages: [notImported, problem] } },
      intercept: (r: Recorded) => (r.path.endsWith('/import') ? { status: 200, body: PACKAGE } : undefined),
    });
    const bad = await screen.findByTestId(`package-${problem.packageId}`);
    expect(within(bad).getByText('The package hash does not match its content.')).toBeTruthy();
    expect(within(bad).getByRole('button', { name: 'Import' }).hasAttribute('disabled')).toBe(true);
    await userEvent.click(within(screen.getByTestId(`package-${PACKAGE.packageId}`)).getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(ui.requests.some((r) => r.path.endsWith('/import'))).toBe(true));
    expect(ui.tap.requestTap).not.toHaveBeenCalled();
    expect(ui.requests.find((r) => r.path.endsWith('/import'))?.body).toEqual({});
  });

  it('highlights the package named in the designer\'s link (/test-packages?package=<hash>)', async () => {
    renderFloor(`/test-packages?package=${PACKAGE.packageHash}`);
    const item = await screen.findByTestId(`package-${PACKAGE.packageId}`);
    expect(item.getAttribute('data-highlight')).toBe('true');
    expect(item.getAttribute('aria-current')).toBe('true');
  });
});

describe('issue a test batch', () => {
  it('offers approved sizes only, keeps the markets the MBR sets, sends tabletsPerBatch as a whole number in text, and opens the new run', async () => {
    const run = example('run');
    const ui = renderFloor(`/packages/${PACKAGE.packageId}/issue`, {
      fixtures: { 'execution.issueForm': ISSUE_FORM, 'execution.run': run },
      intercept: (r: Recorded) => (r.path === '/api/test-runs' && r.method === 'POST' ? { status: 200, body: run } : undefined),
    });
    const submit = await screen.findByRole('button', { name: 'Issue the test batch' });
    expect(submit.hasAttribute('disabled')).toBe(true);
    expect(screen.getAllByRole('radio').every((r) => !(r as HTMLInputElement).checked)).toBe(true);
    const inMarket = screen.getByRole('checkbox', { name: /IN \(set by the MBR\)/ });
    expect((inMarket as HTMLInputElement).checked).toBe(true);
    expect(inMarket.hasAttribute('disabled')).toBe(true);
    await userEvent.click(screen.getByRole('radio', { name: '100,000 tablets (100000 {tablets})' }));
    const count = screen.getByRole<HTMLInputElement>('textbox', { name: 'Tablets per batch' });
    await userEvent.type(count, '100000.5');
    expect(submit.hasAttribute('disabled')).toBe(true);
    await userEvent.clear(count);
    await userEvent.type(count, '100000');
    await userEvent.click(submit);
    await waitFor(() => expect(ui.requests.some((r) => r.path === '/api/test-runs' && r.method === 'POST')).toBe(true));
    const sent = ui.requests.find((r) => r.path === '/api/test-runs' && r.method === 'POST')!;
    const { attribution, ...body } = sent.body ?? {};
    expect(attribution).toBeDefined();
    expect(body).toEqual({ packageId: PACKAGE.packageId, batchSize: 'BS-100K', markets: ['IN'], variants: {}, inputs: { tabletsPerBatch: { kind: 'COUNT', value: '100000' } } });
    await waitFor(() => expect(ui.router.state.location.pathname).toBe(`/runs/${RUN_ID}`));
  });
});

describe('runs and the run overview', () => {
  it('lists test runs with status and opens the overview', async () => {
    renderFloor('/runs');
    const run = await screen.findByTestId('run-TEST-B26-0001');
    expect(run.textContent).toContain('In progress');
    expect(run.textContent).toContain('1 open exceptions');
    expect(within(run).getByRole('link', { name: 'Open run TEST-B26-0001' })).toBeTruthy();
  });

  it('shows stages and steps, the derived stage summary and sign-off, exceptions, the timeline, and "Verify record" reports identical or the first difference', async () => {
    let identical = true;
    renderFloor(`/runs/${RUN_ID}`, {
      fixtures: {
        'execution.timeline': {
          entries: [
            { seq: '1', kind: 'ISSUE', at: example('run').asOf, actor: null, summary: 'Issued TEST-B26-0001', accepted: true, refusal: null },
            { seq: '2', kind: 'COMMAND', at: example('run').asOf, actor: example('run').stages[0]!.signOff!.signer, summary: 'Verify 2.1.4', accepted: false, refusal: 'ENG-VERIFY-INDEPENDENCE' },
          ],
        },
      },
      intercept: (r: Recorded) =>
        r.path.endsWith('/verify-replay')
          ? {
              status: 200,
              body: identical
                ? { runId: RUN_ID, identical: true, rows: 42, firstDifference: null, invariantViolations: [], checkedAt: example('run').asOf }
                : { runId: RUN_ID, identical: false, rows: 42, firstDifference: { seq: '17', field: 'state_hash', expected: 'ab12', actual: 'cd34' }, invariantViolations: [], checkedAt: example('run').asOf },
            }
          : undefined,
    });
    expect(await screen.findByRole('heading', { name: 'Run TEST-B26-0001' })).toBeTruthy();
    expect(screen.getByTestId('outline-p-blend@').textContent).toContain('Performed, waiting for verification');
    const disp = screen.getByTestId('stage-S-DISP@');
    expect(disp.textContent).toContain('Completed per MBR');
    expect(disp.textContent).toContain('Stage signed off by TEST-Sanjay Kulkarni');
    expect(screen.getByTestId('exception-X-3')).toBeTruthy();
    expect(await screen.findByText(/Refused: ENG-VERIFY-INDEPENDENCE/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Audit trail of this run' }).getAttribute('href')).toBe(`/audit?chain=${encodeURIComponent(`batch:${RUN_ID}`)}`);
    await userEvent.click(screen.getByRole('button', { name: 'Verify record (replay)' }));
    expect((await screen.findByTestId('replay-result')).textContent).toContain('Replay identical: 42 rows replayed');
    identical = false;
    await userEvent.click(screen.getByRole('button', { name: 'Verify record (replay)' }));
    await waitFor(() => expect(screen.getByTestId('replay-result').textContent).toContain('Replay differs at row 17: state_hash expected ab12, found cd34.'));
  });

  it('a run that cannot be read shows the server\'s refusal', async () => {
    renderFloor(`/runs/${RUN_ID}`, { fixtures: { 'execution.run': { status: 403, body: envelope('NOT_ALLOWED', 'EBMR-IAM-140', { whatHappened: 'You may not open this run.' }) } } });
    expect(await screen.findByText('You may not open this run.')).toBeTruthy();
  });
});
