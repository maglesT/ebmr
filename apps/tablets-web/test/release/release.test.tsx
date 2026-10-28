/**
 * The release cockpit, manufacturer tab, and the notification centre (Phase 4 slice 3c) on the contract's examples: the
 * queue, G-REL items red or green with the database's reasons and links to their evidence, the "since review" items
 * acknowledged one by one at the epoch shown, the manufacturer release with the checklist shown and the epoch sent back,
 * the rejection with the person's own reason, the post-change evaluation and the PPQ outcome, the recorded decision, and
 * the notifications of both departments with the acknowledgement (a fresh badge tap on a shared terminal). Every signed
 * act goes through esig.describe and the ceremony with the action as sent; the browser computes no gate or status.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { example } from '@ebmr/api-contract/examples';
import { apiState } from '../../src/api/client.ts';
import { renderOffice, TAPPED } from '../office/support.tsx';

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

const lot = example('release-lot');
const released = example('release-lot-released');
const notices = example('notifications-list');
const L = lot.lotId;
const ready = { ready: true, problems: [] };
const AP = { role: 'AUTHORISED_PERSON' };

describe('release queue', () => {
  it('lists finished lots with the server\'s state; a filter asks the server for one state', async () => {
    const ui = renderOffice('/release', AP);
    const row = await screen.findByTestId('release-lot-P26-0001');
    expect(row.textContent).toContain('Not ready');
    expect(within(row).getByRole('link', { name: 'P26-0001' }).getAttribute('href')).toBe(`/release/${L}`);
    await userEvent.click(screen.getByRole('radio', { name: 'Ready' }));
    await waitFor(() => expect(ui.requests.some((r) => r.path === '/api/release/lots' && r.query['state'] === 'READY')).toBe(true));
  });
});

describe('release cockpit, manufacturer tab', () => {
  it('shows each G-REL item red, green or not applicable as the server answers, the reason of a red item and links to the evidence', async () => {
    renderOffice(`/release/${L}`, AP);
    const list = await screen.findByTestId('grel-checklist');
    expect(within(list).getByTestId('grel-item-G1.REVIEW').getAttribute('data-status')).toBe('GREEN');
    const red = within(list).getByTestId('grel-item-G4.RECONCILIATION');
    expect(red.getAttribute('data-status')).toBe('RED');
    expect(red.textContent).toContain('the Tablets edition reports no reconciliation item yet');
    expect(within(list).getByTestId('grel-item-G8.MARKET_ADD').textContent).toContain('Not applicable');
    const g1 = within(list).getByTestId('grel-item-G1.REVIEW');
    expect(within(g1).getByRole('link', { name: 'P26-0001 packaging record' }).getAttribute('href')).toBe(`/review/${lot.batchId}`);
    // Evidence no screen shows yet is named, not linked.
    expect(within(within(list).getByTestId('grel-item-G3.LIMS')).queryByRole('link')).toBeNull();
    expect(screen.getByRole('tab', { name: /Manufacturer/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('a "since review" item is acknowledged on its own with the market and the epoch shown; an acknowledged one offers nothing', async () => {
    const changed = { ...lot, grel: { ...lot.grel, items: lot.grel.items.map((i) => (i.id === 'G3.LIMS' ? { ...i, acknowledged: false } : i.id === 'G1.REVIEW' ? { ...i, sinceReview: true, acknowledged: true } : i)) } };
    const ui = renderOffice(`/release/${L}`, { ...AP, fixtures: { 'release.lot': changed } });
    const box = await screen.findByTestId('since-review');
    expect(within(within(box).getByTestId('since-review-G1.REVIEW')).queryByRole('button')).toBeNull();
    expect(within(box).getByTestId('since-review-G1.REVIEW').textContent).toContain('Acknowledged by you');
    await userEvent.click(within(box).getByRole('button', { name: 'Acknowledge G3.LIMS' }));
    await waitFor(() => expect(ui.posts(`/api/release/lots/${L}/acknowledgements`)).toHaveLength(1));
    expect(ui.posts(`/api/release/lots/${L}/acknowledgements`)[0]?.body).toEqual({ market: 'IN', itemId: 'G3.LIMS', epoch: lot.grel.epoch });
  });

  it('[PR-08] the release screen shows each registration-relevant deviation of the lot\'s records with its flag and deviation, and offers nothing that clears the flag', async () => {
    const flagged = {
      ...lot,
      registrationRelevant: [
        { batchId: lot.batchId, exceptionId: 'EX-4', title: 'Assay of the blend outside its registered limit', deviationRef: 'DEV-2026-0042' },
        { batchId: lot.batchId, exceptionId: 'EX-7', title: 'Tablet hardness outside its registered limit', deviationRef: null },
      ],
    };
    renderOffice(`/release/${L}`, { ...AP, fixtures: { 'release.lot': flagged } });
    const list = await screen.findByTestId('release-registration-relevant');
    const banner = list.closest('[role="alert"], [role="status"], section, div') ?? list;
    expect(banner.textContent).toContain('Registration-relevant deviations (PR-08)');
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Assay of the blend outside its registered limit (EX-4), deviation DEV-2026-0042',
      'Tablet hardness outside its registered limit (EX-7), no deviation linked',
    ]);
    // The flag is the record's: the screen offers no button, link or field on it.
    expect(within(banner as HTMLElement).queryAllByRole('button')).toEqual([]);
    expect(within(list).queryAllByRole('textbox')).toEqual([]);
    expect(within(list).queryAllByRole('checkbox')).toEqual([]);
    cleanup();
    // A lot without such a deviation shows no flag.
    renderOffice(`/release/${L}`, { ...AP, fixtures: { 'release.lot': { ...lot, registrationRelevant: [], incidents: [] } } });
    await screen.findByTestId('grel-checklist');
    expect(screen.queryByTestId('release-registration-relevant')).toBeNull();
  });

  it('the release cannot be pressed while its gate stands; the reasons are the server\'s', async () => {
    renderOffice(`/release/${L}`, AP);
    const box = await screen.findByTestId('manufacturer-release');
    expect(within(box).getByTestId('release-problems').textContent).toContain('G-REL item G4.RECONCILIATION is RED');
    expect(within(box).getByRole('button', { name: 'Sign the manufacturer release' }).hasAttribute('disabled')).toBe(true);
  });

  it('[IN-05] the manufacturer release shows the checklist and signs it through the ceremony with the epoch the signer saw', async () => {
    const ui = renderOffice(`/release/${L}`, { ...AP, fixtures: { 'release.lot': { ...lot, state: 'READY', gates: { ...lot.gates, release: ready } } } });
    const box = await screen.findByTestId('manufacturer-release');
    const checklist = within(box).getByTestId('release-checklist');
    expect(within(checklist).getAllByRole('listitem')).toHaveLength(lot.grel.items.length);
    await userEvent.click(within(box).getByRole('button', { name: 'Sign the manufacturer release' }));
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    const action = { kind: 'RELEASE_ACT', act: 'MANUFACTURER_RELEASE', lotId: L, input: { expectedEpoch: lot.grel.epoch } };
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual(action);
    expect(ui.posts('/api/esig/describe')[0]?.body).toEqual({ action });
    expect(ui.ceremony.sign.mock.calls[0]?.[0]).toMatchObject({ aggregateType: 'test_aggregate', aggregateId: 'test-id', meaning: 'TEST_MEANING' });
  });

  it('a named delegate cites the delegation; a rejection needs the person\'s reason, both halves', async () => {
    const ui = renderOffice(`/release/${L}`, AP);
    await userEvent.type(await screen.findByRole('textbox', { name: /^Delegation/ }), 'f0e1d2c3-b4a5-4968-8776-655443322110');
    const box = screen.getByTestId('manufacturer-reject');
    const button = within(box).getByRole('button', { name: 'Sign the rejection' });
    await userEvent.type(within(box).getByRole('textbox', { name: 'Reason code' }), 'OOS');
    expect(button.hasAttribute('disabled')).toBe(true);
    await userEvent.type(within(box).getByRole('textbox', { name: 'Reason for the rejection' }), 'Assay out of specification, confirmed');
    await userEvent.click(button);
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual({
      kind: 'RELEASE_ACT',
      act: 'MANUFACTURER_REJECT',
      lotId: L,
      input: { expectedEpoch: lot.grel.epoch, reason: { code: 'OOS', text: 'Assay out of specification, confirmed' }, delegationId: 'f0e1d2c3-b4a5-4968-8776-655443322110' },
    });
  });

  it('[IN-03][PR-09] QA signs a post-change evaluation and a PPQ outcome for the batch named, each with its own text', async () => {
    const view = {
      ...lot,
      postChange: [{ batchId: lot.batchId, batchNumber: 'P26-0001', changeRecord: 'CC-2026-015', evaluated: false }],
      validationBatches: [{ batchId: lot.batchId, batchNumber: 'P26-0001', purpose: 'PPQ', outcome: null }],
    };
    const ui = renderOffice(`/release/${L}`, { ...AP, fixtures: { 'release.lot': view } });
    const pc = await screen.findByTestId('post-change');
    const sign = await within(pc).findByRole('button', { name: 'Sign the post-change evaluation of P26-0001' });
    expect(sign.hasAttribute('disabled')).toBe(true);
    await userEvent.type(within(pc).getByRole('textbox'), 'First batch after CC-2026-015: results within the validated range');
    await userEvent.click(sign);
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual({ kind: 'RELEASE_ACT', act: 'POST_CHANGE_EVALUATE', lotId: L, input: { batchId: lot.batchId, text: 'First batch after CC-2026-015: results within the validated range' } });
    const ppq = screen.getByTestId('ppq');
    await userEvent.click(within(ppq).getByRole('radio', { name: 'Passed' }));
    await userEvent.type(within(ppq).getByRole('textbox', { name: 'Protocol (and report)' }), 'PV-GBT01-01');
    await userEvent.type(within(ppq).getByRole('textbox', { name: 'Outcome statement' }), 'All three PPQ batches met the protocol');
    await userEvent.click(within(ppq).getByRole('button', { name: 'Sign the PPQ outcome of P26-0001' }));
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(2));
    expect(ui.ceremony.sign.mock.calls[1]?.[0].action).toEqual({ kind: 'RELEASE_ACT', act: 'PPQ_OUTCOME', lotId: L, input: { batchId: lot.batchId, outcome: 'PASSED', protocolRef: 'PV-GBT01-01', text: 'All three PPQ batches met the protocol' } });
  });

  it('the recorded decision is shown with its epoch and checklist hash and no act is offered again; the lot\'s notifications are listed', async () => {
    renderOffice(`/release/${L}`, { ...AP, fixtures: { 'release.lot': released } });
    const d = await screen.findByTestId('release-decision');
    expect(d.textContent).toContain('Released');
    expect(d.textContent).toContain(released.decision?.checklistHash ?? 'x');
    expect(screen.queryByTestId('manufacturer-release')).toBeNull();
    const n = await screen.findByTestId('lot-notifications');
    expect((await within(n).findByTestId('notification-QA')).textContent).toContain('was released by the manufacturer');
  });

  it('R10 #6: a released lot says who released it and when, and offers no form of the decision (acknowledgements, evaluations, justifications)', async () => {
    const d = released.decision;
    const view = {
      ...released,
      // Evidence that changed after the release (e.g. the record locked at release) and acts not yet done: the decision stands.
      grel: { ...released.grel, items: released.grel.items.map((i, n) => (n === 0 ? { ...i, sinceReview: true, acknowledged: false } : i)) },
      postChange: [{ batchId: released.batchId, batchNumber: 'P26-0001', changeRecord: 'CC-2026-015', evaluated: false }],
      validationBatches: [{ batchId: released.batchId, batchNumber: 'P26-0001', purpose: 'PPQ', outcome: null }],
      openInvestigationPath: true,
    };
    renderOffice(`/release/${L}`, { ...AP, fixtures: { 'release.lot': view } });
    const box = await screen.findByTestId('release-decision');
    expect(box.textContent).toContain(`Released by ${d?.by.legalName ?? 'x'}`);
    expect(box.textContent).toContain(`on ${d?.at.text ?? 'x'}`);
    expect(screen.queryByTestId('manufacturer-release')).toBeNull();
    expect(screen.queryByTestId('manufacturer-reject')).toBeNull();
    expect(screen.queryByTestId('since-review')).toBeNull();
    expect(screen.queryByTestId('post-change')).toBeNull();
    expect(screen.queryByTestId('ppq')).toBeNull();
    expect(screen.queryByTestId('investigation-justify')).toBeNull();
  });
});

describe('notification centre', () => {
  it('[IN-39] lists the department\'s notifications; the acknowledgement is the person\'s own, with a fresh badge tap on a shared terminal', async () => {
    const ui = renderOffice('/notifications', { role: 'QA_SHOP_FLOOR', attribution: 'TAP' });
    expect(await screen.findByText(/Your departments: Quality assurance/)).toBeTruthy();
    const item = await screen.findByTestId('notification-QA');
    expect(item.textContent).toContain('Not acknowledged yet.');
    await userEvent.click(within(item).getByRole('button', { name: 'Acknowledge (Quality assurance)' }));
    const id = notices.notifications[0]?.notificationId ?? '';
    await waitFor(() => expect(ui.posts(`/api/notifications/${id}/acknowledgements`)).toHaveLength(1));
    expect(ui.tap.requestTap).toHaveBeenCalledWith(expect.any(String), { method: 'POST', path: `/api/notifications/${id}/acknowledgements`, body: {} });
    expect(ui.posts(`/api/notifications/${id}/acknowledgements`)[0]?.body).toEqual({ attribution: TAPPED });
    // The list asks for the notifications waiting for this person by default.
    expect(ui.requests.some((r) => r.path === '/api/notifications' && r.query['open'] === 'true')).toBe(true);
  });

  it('a notification this person may not acknowledge offers no button', async () => {
    renderOffice('/notifications', { role: 'HEAD_OF_PRODUCTION', fixtures: { 'notifications.list': { departments: ['PRODUCTION'], notifications: notices.notifications.map((n) => ({ ...n, mayAcknowledge: false })) } } });
    const item = await screen.findByTestId('notification-QA');
    expect(within(item).queryByRole('button')).toBeNull();
  });
});
