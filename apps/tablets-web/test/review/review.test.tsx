/**
 * The review screens (Phase 4 slice 1c) on the contract's examples: the record review with the gates in the server's
 * words, production approval, the audit-trail review with its high-water mark (full and delta), the QA review with the
 * evidence epoch it saw, the reopen with the person's reason; the exception register (recorded showing, keyboard "next
 * item", the tracked item detail, a disposition per item, grouped acceptance of non-critical items, production's answer to
 * a query). Every signed act goes through the ceremony with the signable action as sent; nothing builds an aggregate id.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { example } from '@ebmr/api-contract/examples';
import { apiState } from '../../src/api/client.ts';
import { nextItem } from '../../src/features/review/RegisterPage.tsx';
import { refusal, renderOffice } from '../office/support.tsx';

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

const batch = example('review-batch');
const register = example('review-register');
const report = example('review-audit-trail');
const B = batch.batchId;
const ready = { ready: true, problems: [] };
const complete = { ...batch, reviewState: 'EXECUTION_COMPLETE', acts: [], gates: { ...batch.gates, productionApprove: ready } };

describe('review queue', () => {
  it('lists the records with their review state; a filter asks the server for one state', async () => {
    const ui = renderOffice('/review', { role: 'QA_REVIEWER' });
    const row = await screen.findByTestId('review-batch-B26-0001');
    expect(row.textContent).toContain('Production approved');
    expect(within(row).getByRole('link', { name: 'B26-0001' }).getAttribute('href')).toBe(`/review/${B}`);
    await userEvent.click(screen.getByRole('radio', { name: 'QA reviewed' }));
    await waitFor(() => expect(ui.requests.some((r) => r.path === '/api/review/batches' && r.query['state'] === 'QA_REVIEWED')).toBe(true));
  });
});

describe('record review', () => {
  it('shows each gate\'s reasons in the server\'s words; the QA review cannot be pressed while they stand', async () => {
    renderOffice(`/review/${B}`, { role: 'QA_REVIEWER' });
    const qa = await screen.findByTestId('qa-review');
    expect(within(qa).getByTestId('qa-review-problems').textContent).toContain('exception EX-3 is not concluded in review (it is QUERIED)');
    expect((await within(qa).findByRole('button', { name: 'Sign the QA review' })).hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('review-state').textContent).toContain('evidence epoch 7');
    // Production's act is not offered to QA.
    expect(screen.queryByRole('button', { name: 'Approve the record (production)' })).toBeNull();
  });

  it('production approves an EXECUTION_COMPLETE record through the ceremony with the action as sent', async () => {
    const ui = renderOffice(`/review/${B}`, { role: 'HEAD_OF_PRODUCTION', fixtures: { 'review.batch': complete } });
    await userEvent.click(await screen.findByRole('button', { name: 'Approve the record (production)' }));
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual({ kind: 'REVIEW_ACT', act: 'PRODUCTION_APPROVE', batchId: B, input: {} });
    // What is signed is the server's description of that action.
    expect(ui.posts('/api/esig/describe')[0]?.body).toEqual({ action: { kind: 'REVIEW_ACT', act: 'PRODUCTION_APPROVE', batchId: B, input: {} } });
    expect(ui.ceremony.sign.mock.calls[0]?.[0]).toMatchObject({ aggregateType: 'test_aggregate', aggregateId: 'test-id', meaning: 'TEST_MEANING' });
  });

  it('the QA review sends the evidence epoch the reviewer saw; a refusal is shown in the server\'s words', async () => {
    const ui = renderOffice(`/review/${B}`, {
      role: 'QA_REVIEWER',
      fixtures: { 'review.batch': { ...batch, gates: { ...batch.gates, qaReview: ready } }, 'esig.describe': refusal('EBMR-REV-021', 'The record changed after you read it.', 'epoch 8 is newer than 7') },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Sign the QA review' }));
    expect(await screen.findByText('The record changed after you read it.')).toBeTruthy();
    expect(ui.posts('/api/esig/describe')[0]?.body).toEqual({ action: { kind: 'REVIEW_ACT', act: 'QA_REVIEW', batchId: B, input: { expectedEpoch: '7' } } });
    expect(ui.ceremony.sign).not.toHaveBeenCalled();
  });

  it('the audit-trail panel shows the scope, the high-water mark and the critical events, and signs the report\'s own review id', async () => {
    const ui = renderOffice(`/review/${B}`, { role: 'QA_REVIEWER' });
    const panel = await screen.findByTestId('audit-trail-review');
    const marks = await within(panel).findByTestId('audit-trail-marks');
    expect(within(marks).getByText('Batch B26-0001').closest('tr')?.textContent).toContain('412');
    expect(within(marks).getByText('Lot PCM-2026-031').closest('tr')?.textContent).toContain('9');
    expect(within(panel).getAllByText('Critical: changed shortly before use')).toHaveLength(report.events.filter((e) => e.critical).length);
    await userEvent.click(within(panel).getByRole('button', { name: 'Sign the audit-trail review' }));
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual({ kind: 'REVIEW_ACT', act: 'AUDIT_TRAIL_REVIEW', batchId: B, input: { reviewId: report.reviewId } });
  });

  it('a delta report is signed as the delta review from its last mark; a covered report offers no signature', async () => {
    const delta = { ...report, kind: 'DELTA', reviewId: `${B}/2`, fromMark: { [`batch:${B}`]: '400' } };
    const ui = renderOffice(`/review/${B}`, { role: 'QA_REVIEWER', fixtures: { 'review.auditTrail': delta } });
    const panel = await screen.findByTestId('audit-trail-review');
    expect((await within(panel).findByTestId('audit-trail-marks')).textContent).toContain('From (last mark)');
    await userEvent.click(within(panel).getByRole('button', { name: 'Sign the delta review' }));
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toMatchObject({ act: 'DELTA_REVIEW', input: { reviewId: `${B}/2` } });
    cleanup();
    renderOffice(`/review/${B}`, { role: 'QA_REVIEWER', fixtures: { 'review.auditTrail': { ...report, covered: true } } });
    const covered = await screen.findByTestId('audit-trail-review');
    expect(await within(covered).findByText('Covered by the last signed mark')).toBeTruthy();
    expect(within(covered).getByRole('button', { name: 'Sign the audit-trail review' }).hasAttribute('disabled')).toBe(true);
  });

  it('a reopen needs the person\'s reason, both halves, and names the cycle shown', async () => {
    const ui = renderOffice(`/review/${B}`, { role: 'QA_REVIEWER' });
    const box = await screen.findByTestId('reopen');
    const button = within(box).getByRole('button', { name: 'Reopen (QA signature)' });
    await userEvent.type(within(box).getByRole('textbox', { name: 'Reason code' }), 'LATE_RESULT');
    expect(button.hasAttribute('disabled')).toBe(true);
    await userEvent.type(within(box).getByRole('textbox', { name: 'Reason for the reopen' }), 'A late LIMS result changes the record');
    await userEvent.click(button);
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual({ kind: 'REVIEW_ACT', act: 'REOPEN', batchId: B, input: { reason: { code: 'LATE_RESULT', text: 'A late LIMS result changes the record' }, cycle: 1 } });
  });
});

describe('exception register', () => {
  const path = `/review/${B}/register`;

  it('"next item" picks the items that still need QA in order, wrapping round', () => {
    expect(nextItem(register.items, null, 1)).toBe('EX-1');
    expect(nextItem(register.items, 'EX-1', 1)).toBe('EX-2');
    // EX-3 waits for production's answer (QUERIED): the next one wraps round to EX-1.
    expect(nextItem(register.items, 'EX-2', 1)).toBe('EX-1');
    expect(nextItem(register.items, 'EX-1', -1)).toBe('EX-2');
    expect(nextItem(register.items.map((i) => ({ ...i, reviewStatus: 'ACCEPTED' as const })), null, 1)).toBeNull();
  });

  it('records the showing, moves to the next item with the keyboard and opens its detail (recorded)', async () => {
    const ui = renderOffice(path, { role: 'QA_REVIEWER' });
    expect((await screen.findByTestId('register-summary')).textContent).toContain('3 items');
    expect(ui.posts(`/api/review/batches/${B}/register`).length).toBeGreaterThanOrEqual(1);
    fireEvent.keyDown(window, { key: 'n' });
    await waitFor(() => expect(ui.posts(`/api/review/batches/${B}/items/EX-1/open`)).toHaveLength(1));
    expect(screen.getByTestId('item-EX-1').getAttribute('aria-current')).toBe('true');
    expect(await screen.findByTestId('raised-record')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'n' });
    await waitFor(() => expect(ui.posts(`/api/review/batches/${B}/items/EX-2/open`)).toHaveLength(1));
    // Typing in a field does not move.
    const before = ui.posts(`/api/review/batches/${B}/items/EX-1/open`).length;
    await userEvent.type(screen.getByRole('textbox', { name: 'Justification' }), 'n');
    expect(ui.posts(`/api/review/batches/${B}/items/EX-1/open`)).toHaveLength(before);
  });

  it('dispositions one item through the ceremony (escalation names its deviation)', async () => {
    const ui = renderOffice(path, { role: 'QA_REVIEWER' });
    await screen.findByTestId('register-summary');
    await userEvent.click(within(screen.getByTestId('item-EX-2')).getByRole('button', { name: 'EX-2' }));
    const box = await screen.findByTestId('item-disposition');
    await userEvent.click(within(box).getByRole('radio', { name: 'Escalate to a deviation' }));
    await userEvent.type(within(box).getByRole('textbox', { name: 'Reason for the escalation' }), 'Repeated gateway loss on the press');
    await userEvent.click(within(box).getByRole('button', { name: 'Sign the disposition of EX-2' }));
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual({
      kind: 'REVIEW_ACT',
      act: 'DISPOSE_ITEM',
      batchId: B,
      input: { items: ['EX-2'], disposition: 'ESCALATE', justification: 'Repeated gateway loss on the press', deviationRef: 'DEV-SITE-1-2026-00012' },
    });
  });

  it('accepts non-critical items together with one justification; a critical item is never offered in the group', async () => {
    const ui = renderOffice(path, { role: 'QA_REVIEWER', fixtures: { 'review.register': { ...register, items: register.items.map((i) => (i.exceptionId === 'EX-3' ? { ...i, reviewStatus: 'OPEN' } : i)) } } });
    const group = await screen.findByTestId('grouped-acceptance');
    expect(within(group).queryByRole('checkbox', { name: /EX-3/ })).toBeNull();
    const accept = within(group).getByRole('button', { name: /^Accept the/ });
    await userEvent.click(within(group).getByRole('checkbox', { name: /EX-1/ }));
    await userEvent.type(within(group).getByRole('textbox', { name: 'Justification for the group' }), 'Both covered by DEV-SITE-1-2026-00012, concluded');
    expect(accept.hasAttribute('disabled')).toBe(true);
    await userEvent.click(within(group).getByRole('checkbox', { name: /EX-2/ }));
    await userEvent.click(within(group).getByRole('button', { name: 'Accept the 2 items chosen' }));
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual({
      kind: 'REVIEW_ACT',
      act: 'DISPOSE_ITEM',
      batchId: B,
      input: { items: ['EX-1', 'EX-2'], disposition: 'ACCEPT', justification: 'Both covered by DEV-SITE-1-2026-00012, concluded' },
    });
  });

  it('production answers QA\'s query on an item; a refusal is shown in the server\'s words', async () => {
    const ui = renderOffice(path, { role: 'HEAD_OF_PRODUCTION', fixtures: { 'review.respond': refusal('EBMR-REV-040', 'The person who asked the query cannot answer it.') } });
    await screen.findByTestId('register-summary');
    await userEvent.click(within(screen.getByTestId('item-EX-3')).getByRole('button', { name: 'EX-3' }));
    const box = await screen.findByTestId('respond');
    expect(screen.queryByTestId('item-disposition')).toBeNull();
    await userEvent.type(within(box).getByRole('textbox', { name: "Production's answer to the query" }), 'LOD re-tested at 2.8 %');
    await userEvent.click(within(box).getByRole('button', { name: 'Send the answer' }));
    await waitFor(() => expect(ui.posts(`/api/review/batches/${B}/items/EX-3/response`)).toHaveLength(1));
    expect(ui.posts(`/api/review/batches/${B}/items/EX-3/response`)[0]?.body).toEqual({ text: 'LOD re-tested at 2.8 %' });
    expect(await screen.findByText('The person who asked the query cannot answer it.')).toBeTruthy();
  });
});
