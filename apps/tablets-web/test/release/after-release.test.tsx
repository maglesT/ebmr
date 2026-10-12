/**
 * The suspension and recall cockpit (Phase 4 slice 5c) on the contract's examples: the list of suspended lots, a lot's
 * "After release" tab (the causes with where each was linked, the forward trace through the genealogy, the recall
 * assessment and the ERP stock block), the authorised person's RECONFIRM, RECALL and REJECT_AFTER_RELEASE per market,
 * and the disposal (witnessed destruction by a performer and an independent witness, reprocessing, return). Every
 * signed act goes through esig.describe and the ceremony with the action as sent; the browser computes no state or gate.
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

const after = example('release-after-release');
const disposed = example('release-after-release-disposed');
const grel = example('release-grel');
const suspended = example('release-suspended');
const L = after.lotId;
const ready = { ready: true, problems: [] };
const IN = after.markets.find((m) => m.market === 'IN');
const US = after.markets.find((m) => m.market === 'US');
if (!IN || !US) throw new Error('the after-release example names IN and US');
const DOWN = { lotId: 'aa11bb22-cc33-4d44-8e55-ff6677889900', lotCode: 'P26-0002', state: 'RELEASE_SUSPENDED' };
const REPRO = 'c0ffee00-1234-4abc-8def-0123456789ab';

/** The example with the IN market's gates replaced. */
const withIn = (gates: Partial<typeof IN.gates>, extra: Record<string, unknown> = {}) => ({ ...after, markets: [{ ...IN, gates: { ...IN.gates, ...gates } }, US], ...extra });
/** A lot rejected after release for IN, no disposal yet, the disposal gate open. */
const rejected = { ...after, manufacturerState: 'REJECTED_AFTER_RELEASE', markets: disposed.markets, disposal: null, disposalGate: ready };

async function openAfter(lotId = L, opts: Parameters<typeof renderOffice>[1] = {}) {
  const ui = renderOffice(`/release/${lotId}?tab=AFTER`, { role: 'AUTHORISED_PERSON', ...opts });
  await screen.findByTestId('after-release-state');
  return ui;
}

describe('suspended lots', () => {
  it('[L-19][IN-29] lists each suspended lot with its suspended markets and the open recall assessment, linking to its After release tab', async () => {
    renderOffice('/release/suspended', { role: 'AUTHORISED_PERSON' });
    const s = suspended.lots[0];
    if (!s) throw new Error('the example lists a lot');
    const row = await screen.findByTestId(`suspended-lot-${s.lotCode}`);
    expect(row.textContent).toContain('suspended for IN, US');
    expect(row.textContent).toContain('Recall assessment open');
    expect(within(row).getByRole('link', { name: s.lotCode }).getAttribute('href')).toBe(`/release/${s.lotId}?tab=AFTER`);
  });
});

describe('After release tab', () => {
  it('[L-19][IN-29] shows the suspension per market, its causes with the database\'s reason, the recall assessment and the ERP stock block', async () => {
    await openAfter();
    expect(screen.getByRole('tab', { name: 'After release' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('The release is suspended for IN, US')).toBeTruthy();
    expect(screen.getByTestId('after-release-market-IN').getAttribute('data-state')).toBe('RELEASE_SUSPENDED');
    expect(screen.getByTestId('after-release-market-IN').textContent).toContain('a re-confirmation restores Released');
    const cause = after.causes[0];
    if (!cause) throw new Error('the example has a cause');
    const row = screen.getByTestId(`suspension-cause-${cause.suspensionId}`);
    expect(row.textContent).toContain(cause.label);
    expect(row.textContent).toContain('Not resolved');
    expect(row.textContent).toContain(cause.problem ?? 'x');
    expect(screen.getByTestId('task-RECALL_ASSESSMENT').textContent).toContain('Open');
    expect(screen.getByTestId('stock-BLOCK').textContent).toContain('ERP stock block');
  });

  it('[L-19] the forward trace lists the lots made downstream of this one (PR-57 genealogy), each opening on its own After release tab', async () => {
    await openAfter(L, { fixtures: { 'release.afterRelease': { ...after, downstream: [DOWN] } } });
    const trace = screen.getByTestId('forward-trace');
    const row = within(trace).getByTestId(`downstream-${DOWN.lotCode}`);
    expect(row.textContent).toContain('Release suspended');
    expect(within(row).getByRole('link', { name: DOWN.lotCode }).getAttribute('href')).toBe(`/release/${DOWN.lotId}?tab=AFTER`);
    cleanup();
    await openAfter();
    expect(screen.getByTestId('forward-trace').textContent).toContain('No finished lot was made from this lot.');
  });

  it('[L-19] re-confirmation cannot be pressed while a cause is unresolved; the reasons are the server\'s', async () => {
    await openAfter();
    const box = await screen.findByTestId('reconfirm-IN');
    expect(within(box).getByTestId('reconfirm-IN-problems').textContent).toContain('UNDER_INVESTIGATION');
    expect(within(box).getByRole('button', { name: 'Sign the re-confirmation of IN' }).hasAttribute('disabled')).toBe(true);
  });

  it('[L-19] the AP re-confirms a market with an impact assessment on G-REL for the market at the epoch shown', async () => {
    const ui = await openAfter(L, { fixtures: { 'release.afterRelease': withIn({ reconfirm: ready }) } });
    const box = await screen.findByTestId('reconfirm-IN');
    await within(box).findByText(new RegExp(`evidence epoch ${grel.epoch}`));
    const button = within(box).getByRole('button', { name: 'Sign the re-confirmation of IN' });
    expect(button.hasAttribute('disabled')).toBe(true);
    await userEvent.type(within(box).getByRole('textbox', { name: 'Impact assessment' }), 'Deviation closed: no impact on the lot');
    await userEvent.click(button);
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    const action = { kind: 'RELEASE_ACT', act: 'RECONFIRM', lotId: L, input: { market: 'IN', expectedEpoch: grel.epoch, text: 'Deviation closed: no impact on the lot' } };
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual(action);
    expect(ui.posts('/api/esig/describe')[0]?.body).toEqual({ action });
    expect(ui.requests.some((r) => r.path === `/api/release/lots/${L}/grel` && r.query['market'] === 'IN')).toBe(true);
  });

  it('[L-19] a recall needs both halves of the person\'s reason and is signed per market', async () => {
    const ui = await openAfter();
    const box = await screen.findByTestId('recall-US');
    const button = within(box).getByRole('button', { name: 'Sign the recall from US' });
    await userEvent.type(within(box).getByRole('textbox', { name: 'Reason code' }), 'RECALL-1');
    expect(button.hasAttribute('disabled')).toBe(true);
    await userEvent.type(within(box).getByRole('textbox', { name: 'Reason for the recall' }), 'Contamination confirmed');
    await userEvent.click(button);
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual({ kind: 'RELEASE_ACT', act: 'RECALL', lotId: L, input: { market: 'US', reason: { code: 'RECALL-1', text: 'Contamination confirmed' } } });
  });

  it('[L-19] a rejection after release is signed per market with the reason; its gate is the server\'s', async () => {
    const ui = await openAfter(L, { fixtures: { 'release.afterRelease': withIn({ rejectAfterRelease: { ready: false, problems: ['the market is RECALLED'] } }) } });
    const blocked = await screen.findByTestId('reject-after-release-IN');
    expect(within(blocked).getByTestId('reject-after-release-IN-problems').textContent).toContain('the market is RECALLED');
    expect(within(blocked).getByRole('button', { name: 'Sign the rejection for IN' }).hasAttribute('disabled')).toBe(true);
    const box = screen.getByTestId('reject-after-release-US');
    await userEvent.type(within(box).getByRole('textbox', { name: 'Reason code' }), 'OOS');
    await userEvent.type(within(box).getByRole('textbox', { name: 'Reason for the rejection after release' }), 'Stability failure');
    await userEvent.click(within(box).getByRole('button', { name: 'Sign the rejection for US' }));
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual({ kind: 'RELEASE_ACT', act: 'REJECT_AFTER_RELEASE', lotId: L, input: { market: 'US', reason: { code: 'OOS', text: 'Stability failure' } } });
  });

  it('the after-release acts are not offered to a role outside QA', async () => {
    await openAfter(L, { role: 'OPERATOR' });
    expect(screen.queryByTestId('after-release-acts-IN')).toBeNull();
    expect(screen.getByTestId('suspension-causes')).toBeTruthy();
  });
});

describe('disposal', () => {
  it('[PR-46] a disposal cannot be recorded while the lot is not rejected; the reason is the server\'s', async () => {
    await openAfter();
    const box = screen.getByTestId('disposal');
    expect(within(box).getByTestId('disposal-problems').textContent).toContain('a disposal follows a rejection');
    expect(within(box).getByRole('button', { name: 'Sign the destruction as performer' }).hasAttribute('disabled')).toBe(true);
  });

  it('[PR-46] the performer signs a witnessed destruction with its quantity and reference', async () => {
    const ui = await openAfter(L, { fixtures: { 'release.afterRelease': rejected } });
    const box = screen.getByTestId('disposal');
    const button = within(box).getByRole('button', { name: 'Sign the destruction as performer' });
    await userEvent.type(within(box).getByRole('textbox', { name: 'Quantity disposed of (in the lot\'s unit)' }), '10.5x');
    await userEvent.type(within(box).getByRole('textbox', { name: 'Destruction record reference (optional)' }), 'DR-1');
    expect(button.hasAttribute('disabled')).toBe(true);
    await userEvent.clear(within(box).getByRole('textbox', { name: 'Quantity disposed of (in the lot\'s unit)' }));
    await userEvent.type(within(box).getByRole('textbox', { name: 'Quantity disposed of (in the lot\'s unit)' }), '1000');
    await userEvent.click(button);
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual({
      kind: 'RELEASE_ACT',
      act: 'DISPOSAL',
      lotId: L,
      input: { disposalRoute: 'WITNESSED_DESTRUCTION', disposalQuantity: '1000', disposalReference: 'DR-1' },
    });
  });

  it('[PR-46] a return names to whom and its reference; a reprocessing names its authorisation', async () => {
    const ui = await openAfter(L, { fixtures: { 'release.afterRelease': rejected } });
    const box = screen.getByTestId('disposal');
    await userEvent.click(within(box).getByRole('radio', { name: 'Return' }));
    await userEvent.click(within(box).getByRole('radio', { name: 'Customer' }));
    await userEvent.type(within(box).getByRole('textbox', { name: 'Quantity disposed of (in the lot\'s unit)' }), '200');
    const sign = within(box).getByRole('button', { name: 'Sign the return' });
    expect(sign.hasAttribute('disabled')).toBe(true);
    await userEvent.type(within(box).getByRole('textbox', { name: 'Return reference' }), 'RMA-77');
    await userEvent.click(sign);
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(inputOf(ui.ceremony.sign.mock.calls[0]?.[0].action)).toEqual({ disposalRoute: 'RETURN', disposalQuantity: '200', returnTo: 'CUSTOMER', disposalReference: 'RMA-77' });

    await userEvent.click(within(box).getByRole('radio', { name: 'Reprocessing' }));
    const repro = within(box).getByRole('button', { name: 'Sign the reprocessing' });
    await userEvent.type(within(box).getByRole('textbox', { name: 'Reprocessing authorisation (id)' }), 'not-an-id');
    expect(repro.hasAttribute('disabled')).toBe(true);
    await userEvent.clear(within(box).getByRole('textbox', { name: 'Reprocessing authorisation (id)' }));
    await userEvent.type(within(box).getByRole('textbox', { name: 'Reprocessing authorisation (id)' }), REPRO);
    await userEvent.click(repro);
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(2));
    expect(inputOf(ui.ceremony.sign.mock.calls[1]?.[0].action)).toEqual({ disposalRoute: 'REPROCESSING', disposalQuantity: '200', reprocessingRef: REPRO });
  });

  it('[PR-46] a destruction waiting for its witness is signed by the witness on the same record (the disposal id only)', async () => {
    const d = disposed.disposal;
    if (!d) throw new Error('the disposed example has its disposal');
    const awaiting = { ...disposed, disposal: { ...d, state: 'AWAITING_WITNESS', witnessedBy: null, witnessedAt: null, witnessSignatureId: null } };
    const ui = await openAfter(L, { role: 'QA_REVIEWER', fixtures: { 'release.afterRelease': awaiting } });
    expect(screen.getByTestId('disposal-state').getAttribute('data-state')).toBe('AWAITING_WITNESS');
    await userEvent.click(within(screen.getByTestId('disposal-witness')).getByRole('button', { name: 'Sign as the witness of the destruction' }));
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual({ kind: 'RELEASE_ACT', act: 'DISPOSAL', lotId: L, input: { disposalId: d.disposalId } });
  });

  it('[PR-46] a recorded disposal shows the route, quantity and both signatures, and nothing more to sign', async () => {
    const d = disposed.disposal;
    if (!d) throw new Error('the disposed example has its disposal');
    await openAfter(L, { fixtures: { 'release.afterRelease': disposed } });
    const box = screen.getByTestId('disposal-recorded');
    expect(box.textContent).toContain('Witnessed destruction');
    expect(box.textContent).toContain(`${d.quantity} ${d.unit}`);
    expect(box.textContent).toContain(d.performedBy.legalName);
    expect(box.textContent).toContain(d.witnessedBy?.legalName ?? 'x');
    expect(screen.queryByTestId('disposal-witness')).toBeNull();
    expect(screen.queryByTestId('disposal')).toBeNull();
  });
});
