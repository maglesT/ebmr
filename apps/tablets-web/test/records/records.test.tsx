/**
 * Record locking and amendment screens (Phase 4 slice 5c) on the contract's examples: the list of locked records, one
 * record's lock state, the bulk reconciliation with its close by the head of production, QA's signed opening of an
 * amendment under a deviation or a change record (with the released lots it will suspend shown first), the appended
 * entries, the signed close, and the maximum hold of bright stock. Every state and gate is the server's.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { example } from '@ebmr/api-contract/examples';
import { apiState } from '../../src/api/client.ts';
import { renderOffice } from '../office/support.tsx';

/** The `input` of a signed action as sent (every act these screens sign carries one). */
const inputOf = (a: unknown): unknown => (a as { input?: unknown } | undefined)?.input;

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

const locks = example('records-locks');
const lock = example('records-lock');
const closed = example('records-lock-closed');
const bulk = example('records-bulk');
const B = lock.batchId;
const DEV = 'a9b8c7d6-e5f4-4a3b-8c2d-1e0f9a8b7c6d';
const CR = 'c0ffee00-1234-4abc-8def-0123456789ab';
const open = lock.amendments[0];
if (!open) throw new Error('the lock example has its open amendment');

describe('locked records', () => {
  it('[INV-21] lists each locked record with its state and why it locked, linking to the record', async () => {
    renderOffice('/records', { role: 'QA_REVIEWER' });
    const first = locks.records[0];
    if (!first) throw new Error('the example lists a record');
    const row = await screen.findByTestId(`record-lock-${first.batchNumber}`);
    expect(row.getAttribute('data-state')).toBe(first.state);
    expect(row.textContent).toContain('first disposition');
    expect(within(row).getByRole('link', { name: first.batchNumber }).getAttribute('href')).toBe(`/records/${first.batchId}`);
  });

  it('[PR-38] the maximum hold of bright stock is listed and set as a new version with a reason', async () => {
    const ui = renderOffice('/records', { role: 'MASTER_DATA_STEWARD' });
    const box = await screen.findByTestId('bright-stock-holds');
    const hold = example('records-bright-stock-holds').holds[0];
    if (!hold) throw new Error('the example lists a hold');
    expect((await within(box).findByTestId(`bright-stock-hold-${hold.productCode}`)).textContent).toContain(`at most ${hold.maxHoldHours} hours`);
    await userEvent.type(within(box).getByRole('textbox', { name: 'Product code' }), 'GBT01');
    await userEvent.type(within(box).getByRole('textbox', { name: 'Strength' }), '500 mg');
    await userEvent.type(within(box).getByRole('textbox', { name: 'Maximum hold (hours)' }), '72');
    const button = within(box).getByRole('button', { name: 'Set the maximum hold' });
    await userEvent.type(within(box).getByRole('textbox', { name: 'Reason (at least 10 characters)' }), 'short');
    expect(button.hasAttribute('disabled')).toBe(true);
    await userEvent.type(within(box).getByRole('textbox', { name: 'Reason (at least 10 characters)' }), ' stability study');
    await userEvent.click(button);
    await waitFor(() => expect(ui.posts('/api/records/bright-stock-holds')).toHaveLength(1));
    expect(ui.posts('/api/records/bright-stock-holds')[0]?.body).toEqual({ productCode: 'GBT01', strength: '500 mg', maxHoldHours: '72', reason: 'short stability study' });
  });
});

describe('one record', () => {
  it('[INV-21][R-04] a record under amendment shows the amendment, its entries, the lots it suspended and the AP market-impact tasks', async () => {
    renderOffice(`/records/${B}`, { role: 'QA_REVIEWER' });
    expect((await screen.findByTestId('record-lock-state')).getAttribute('data-state')).toBe('UNDER_AMENDMENT');
    const a = screen.getByTestId(`amendment-${open.number}`);
    expect(a.textContent).toContain(open.basis.ref);
    expect(a.textContent).toContain(open.reason);
    const e = open.entries[0];
    if (e) expect(within(a).getByTestId(`amendment-${open.number}-entry-${e.seq}`).textContent).toContain(e.text);
    const lot = open.suspendedLots[0];
    if (lot) expect(within(a).getByTestId(`amendment-${open.number}-suspended`).textContent).toContain(lot.lotCode);
    const t = open.tasks[0];
    if (t) expect(within(a).getByTestId(`amendment-task-${t.lotCode}-${t.market}`).textContent).toContain('Market-impact assessment');
    // A packaging record has no bulk reconciliation; under amendment it cannot be opened again.
    expect(screen.queryByTestId('bulk-reconciliation')).toBeNull();
    expect(screen.queryByTestId('amendment-open')).toBeNull();
  });

  it('[INV-21] production appends an entry to the open amendment (never an edit of the record); QA is offered the close, not the entry', async () => {
    renderOffice(`/records/${B}`, { role: 'QA_REVIEWER' });
    await screen.findByTestId('amendment-close');
    expect(screen.queryByTestId('amendment-append')).toBeNull();
    cleanup();
    const ui = renderOffice(`/records/${B}`, { role: 'HEAD_OF_PRODUCTION' });
    const box = await screen.findByTestId('amendment-append');
    await userEvent.type(within(box).getByRole('textbox', { name: 'What it amends (step, data point or document)' }), 'Line clearance');
    await userEvent.type(within(box).getByRole('textbox', { name: 'Entry' }), 'Check transcribed from the paper log');
    await userEvent.type(within(box).getByRole('textbox', { name: 'Reason (at least 10 characters)' }), 'Found after release');
    await userEvent.click(within(box).getByRole('button', { name: 'Append the entry' }));
    const path = `/api/records/batches/${B}/amendments/${open.number}/entries`;
    await waitFor(() => expect(ui.posts(path)).toHaveLength(1));
    expect(ui.posts(path)[0]?.body).toEqual({ kind: 'LATE_ENTRY', target: 'Line clearance', text: 'Check transcribed from the paper log', reason: 'Found after release' });
  });

  it('[INV-21] QA signs the close of the amendment with a closing statement', async () => {
    const ui = renderOffice(`/records/${B}`, { role: 'QA_REVIEWER' });
    const box = await screen.findByTestId('amendment-close');
    const button = within(box).getByRole('button', { name: `Sign the close of amendment ${open.number}` });
    expect(button.hasAttribute('disabled')).toBe(true);
    await userEvent.type(within(box).getByRole('textbox', { name: 'Closing statement (at least 10 characters)' }), 'One late entry appended; no other gap');
    await userEvent.click(button);
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    const action = { kind: 'RECORD_LOCK_ACT', act: 'AMENDMENT_CLOSE', batchId: B, input: { statement: 'One late entry appended; no other gap' } };
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual(action);
    expect(ui.posts('/api/esig/describe')[0]?.body).toEqual({ action });
  });

  it('[INV-21][R-04] on a locked record QA sees the released lots an amendment will suspend and signs its opening under a deviation or a change record', async () => {
    const ui = renderOffice(`/records/${B}`, { role: 'QA_REVIEWER', fixtures: { 'records.lock': closed } });
    const box = await screen.findByTestId('amendment-open');
    const released = closed.releasedLots[0];
    if (released) expect(within(box).getByTestId('amendment-would-suspend').textContent).toContain(released.lotCode);
    const sign = within(box).getByRole('button', { name: `Sign the opening of amendment ${closed.nextAmendmentNumber}` });
    await userEvent.type(within(box).getByRole('textbox', { name: 'Deviation (id)' }), DEV);
    await userEvent.type(within(box).getByRole('textbox', { name: 'Reason code' }), 'LATE');
    await userEvent.type(within(box).getByRole('textbox', { name: 'Reason for the amendment (at least 10 characters)' }), 'short');
    expect(sign.hasAttribute('disabled')).toBe(true);
    await userEvent.type(within(box).getByRole('textbox', { name: 'Reason for the amendment (at least 10 characters)' }), ' entry missed');
    await userEvent.click(sign);
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual({
      kind: 'RECORD_LOCK_ACT',
      act: 'AMENDMENT_OPEN',
      batchId: B,
      input: { deviationId: DEV, reason: { code: 'LATE', text: 'short entry missed' } },
    });
    await userEvent.click(within(box).getByRole('radio', { name: 'A change record' }));
    await userEvent.clear(within(box).getByRole('textbox', { name: 'Change record (id)' }));
    await userEvent.type(within(box).getByRole('textbox', { name: 'Change record (id)' }), CR);
    await userEvent.click(sign);
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(2));
    expect(inputOf(ui.ceremony.sign.mock.calls[1]?.[0].action)).toEqual({ changeRecordId: CR, reason: { code: 'LATE', text: 'short entry missed' } });
  });

  it('the amendment acts are not offered outside QA', async () => {
    renderOffice(`/records/${B}`, { role: 'OPERATOR', fixtures: { 'records.lock': closed } });
    await screen.findByTestId('record-lock-state');
    expect(screen.queryByTestId('amendment-open')).toBeNull();
    expect(screen.queryByTestId('amendment-close')).toBeNull();
    expect(screen.queryByTestId('amendment-append')).toBeNull();
  });
});

describe('bulk reconciliation', () => {
  const processing = { ...lock, recordKind: 'PROCESSING', state: 'UNLOCKED', lockedAt: null, cause: null, amendments: [], openAmendmentNumber: null };

  it('[PR-38] shows produced, issued and left bulk per order and container; the close waits for the server\'s problems', async () => {
    renderOffice(`/records/${B}`, { role: 'HEAD_OF_PRODUCTION', fixtures: { 'records.lock': processing } });
    const box = await screen.findByTestId('bulk-reconciliation');
    expect(box.textContent).toContain('left 25.000 kg');
    expect((await within(box).findByTestId('bulk-close-problems')).textContent).toContain(bulk.closeProblems[0] ?? 'x');
    expect(within(box).getByRole('button', { name: 'Close the bulk reconciliation and lock the record' }).hasAttribute('disabled')).toBe(true);
  });

  it('[INV-21] the head of production closes it, holding the bulk left over with a reason; the processing record locks', async () => {
    const ui = renderOffice(`/records/${B}`, { role: 'HEAD_OF_PRODUCTION', fixtures: { 'records.lock': processing, 'records.bulk': { ...bulk, closeProblems: [] } } });
    const box = await screen.findByTestId('bulk-reconciliation');
    const button = await within(box).findByRole('button', { name: 'Close the bulk reconciliation and lock the record' });
    expect(button.hasAttribute('disabled')).toBe(true);
    await userEvent.type(within(box).getByRole('textbox', { name: 'Why the bulk left over is held (at least 10 characters)' }), 'Held for a later packaging order');
    await userEvent.click(button);
    const path = `/api/records/batches/${B}/bulk-reconciliation`;
    await waitFor(() => expect(ui.posts(path)).toHaveLength(1));
    expect(ui.posts(path)[0]?.body).toEqual({ remainingHeldReason: 'Held for a later packaging order' });
  });
});
