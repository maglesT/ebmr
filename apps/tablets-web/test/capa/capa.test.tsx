/**
 * CAPA screens (Phase 6 slice 6a, builder B; IN-01 (d), PR-51) on the contract's examples, and the stale-mirror part of
 * a refusal on the release and signing screens (DI-31; D-P6a-3): which mirror, how old, whom to call. Every value and
 * gate is the server's.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { example } from '@ebmr/api-contract/examples';
import { floor } from '@ebmr/ui-kit';
import { apiState } from '../../src/api/client.ts';
import { RefusalMessage } from '../../src/app/refusal.tsx';
import { renderOffice } from '../office/support.tsx';

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

const reg = example('capa-register');
const detail = example('capa-detail');
const closable = example('capa-detail-closable');

describe('CAPA screens (IN-01 (d), PR-51)', () => {
  it('[IN-01] the register flags an overdue CAPA and an overdue effectiveness check; QA raises a CAPA with its check', async () => {
    const ui = renderOffice('/capa', { role: 'QA_REVIEWER' });
    const overdue = await screen.findByTestId(`capa-${reg.capas[1]!.ref}`);
    expect(overdue.getAttribute('data-overdue')).toBe('true');
    expect(overdue.textContent).toContain('Overdue');
    expect(screen.getByTestId(`capa-${reg.capas[0]!.ref}`).textContent).toContain('1 effectiveness check(s) overdue');
    const box = screen.getByTestId('capa-raise');
    await userEvent.type(within(box).getByRole('textbox', { name: 'Title' }), 'Bin added to the clearance checklist');
    await userEvent.click(within(box).getByRole('radio', { name: 'Complaint' }));
    await userEvent.type(within(box).getByRole('textbox', { name: 'Source reference' }), 'CMP-2026-014');
    await userEvent.type(within(box).getByRole('textbox', { name: 'Owner (person id)' }), detail.ownerPersonId!);
    await userEvent.type(within(box).getByRole('textbox', { name: 'Due date (YYYY-MM-DD)' }), '2026-12-31');
    await userEvent.type(within(box).getByRole('textbox', { name: 'Effectiveness check: what is measured' }), 'No missed bin in ten clearances');
    await userEvent.click(within(box).getByRole('button', { name: 'Raise the CAPA' }));
    await waitFor(() => expect(ui.posts('/api/capa')).toHaveLength(1));
    expect(ui.posts('/api/capa')[0]?.body).toEqual({
      title: 'Bin added to the clearance checklist', sourceKind: 'COMPLAINT', sourceRef: 'CMP-2026-014', ownerPersonId: detail.ownerPersonId, dueOn: '2026-12-31',
      needsMasterChange: false, effectivenessCheck: { criteria: 'No missed bin in ten clearances', periodDays: 90 },
    });
  });

  it('[PR-51][IN-01] a CAPA shows its overdue check, the master version not yet effective and why it cannot close; the close button waits for the server', async () => {
    renderOffice(`/capa/${detail.capaId}`, { role: 'QA_REVIEWER' });
    expect((await screen.findByTestId(`capa-check-${detail.checks[0]!.checkId}`)).getAttribute('data-status')).toBe('OVERDUE');
    expect(screen.getByTestId('capa-master').textContent).toContain('Not effective yet');
    expect(screen.getByTestId('capa-close-problem').textContent).toContain(detail.closeProblem!);
    expect((await within(screen.getByTestId('capa-close')).findByRole('button', { name: 'Close the CAPA' })).hasAttribute('disabled')).toBe(true);
  });

  it('[PR-51] a closable CAPA is closed through the ceremony (CAPA_ACT names the CAPA only)', async () => {
    const ui = renderOffice(`/capa/${closable.capaId}`, { role: 'QA_REVIEWER', fixtures: { 'capa.detail': closable } });
    await userEvent.click(await within(await screen.findByTestId('capa-close')).findByRole('button', { name: 'Close the CAPA' }));
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual({ kind: 'CAPA_ACT', act: 'CLOSE', capaId: closable.capaId });
  });

  it('[PR-51] a QMS mirror row shows its version token and history and offers no act', async () => {
    const mirror = example('capa-detail-mirror');
    renderOffice(`/capa/${mirror.capaId}`, { role: 'QA_REVIEWER', fixtures: { 'capa.detail': mirror } });
    expect((await screen.findByTestId('capa-version-token')).textContent).toBe('v7');
    expect(screen.queryByTestId('capa-close')).toBeNull();
    expect(screen.queryByTestId('capa-cancel')).toBeNull();
  });
});

describe('stale-mirror refusals on the release and signing screens (DI-31)', () => {
  const refusalOf = (code: string, why: string) => ({
    kind: 'REFUSAL' as const, status: 409,
    envelope: { refusal: { code, kind: 'STALE' as const, whatHappened: 'Data from another system is too old to be used.', why, controls: ['DI-31'], whatYouCanDo: [], whoCanHelp: ['The owner of the named system'] }, correlationId: 'c', retryable: true },
  });

  it('[DI-31] stale LMS mirror: a step signature is refused and the screen names the mirror, its age and whom to call', () => {
    const why = 'EBMR-INT-010 the LMS mirror LMS_QUALIFICATION is stale: last synchronised 7230 s ago, more than its bound of 3600 s; data from it cannot be used until the LMS adapter synchronises again (call the LMS system owner)';
    render(<floor.RefusalPanel refusal={refusalOf('EBMR-INT-010', why).envelope.refusal} />);
    const notice = screen.getByTestId('stale-mirror');
    expect(notice.getAttribute('data-mirror')).toBe('LMS_QUALIFICATION');
    expect(notice.textContent).toContain('qualifications and training from the LMS');
    expect(notice.textContent).toContain('Last synchronised 2 h 0 min ago (allowed 1 h 0 min)');
    expect(notice.textContent).toContain('Call the LMS system owner');
  });

  it('[DI-31] stale CMMS mirror: an equipment use is refused and the screen names the calibration mirror', () => {
    const why = 'EBMR-INT-010 the CMMS mirror CMMS_CALIBRATION is stale: it has never synchronised, more than its bound of 3600 s; data from it cannot be used until the CMMS adapter synchronises again (call the CMMS system owner)';
    render(<RefusalMessage error={refusalOf('EBMR-INT-010', why)} />);
    expect(screen.getByTestId('stale-mirror').textContent).toContain('calibration due dates and results from the CMMS (CMMS_CALIBRATION). It has never synchronised');
  });

  it('[DI-31] QMS unreachable at release: the release screen names the QMS and whom to call', () => {
    render(<RefusalMessage error={refusalOf('EBMR-QMS-020', 'The release fetches the lot\'s QMS status live inside the signing (D-P6a-3): the QMS did not answer in 2000 ms.')} />);
    const notice = screen.getByTestId('stale-mirror');
    expect(notice.getAttribute('data-mirror')).toBe('QMS_STATUS');
    expect(notice.textContent).toContain('Call the QMS system owner');
  });
});
