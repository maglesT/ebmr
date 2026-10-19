/**
 * The plant-rule screen of Phase 7 slice 7g-2 (decision 0025; /plant-rules; recipe-core 1210, PR-27): what is in force,
 * what waits for QA, each version's effect (a tightening in force at once, a loosening once approved), the steward's
 * proposals as typed, and QA's approval through the ceremony. Who may propose or approve is the database's; every act
 * is offered and a refusal is shown in its words.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { apiState } from '../../src/api/client.ts';
import { renderOffice, signedCeremony } from '../office/support.tsx';
import { at, proposal, QA } from './fixtures.ts';

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

const PROPOSALS = {
  facilityRules: [{ site: 'SITE-PEN', inForce: false, approvedVersion: null, pending: true, versions: [proposal({})] }],
  betaLactam: [
    {
      kind: 'MATERIAL' as const, code: 'AMOX-3H', inForce: true, approvedVersion: '1', pending: true,
      versions: [proposal({ proposalId: '6b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e', version: '2', effect: 'LOOSENS', value: false }), { ...proposal({ proposalId: '7b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e', state: 'APPROVED', effect: 'TIGHTENS' }), approvedBy: QA, approvedAt: at('17-OCT-2026') }],
    },
  ],
  readAt: at('18-OCT-2026 10:00'),
};

describe('penicillin facility rules and beta-lactam classifications', () => {
  it('[PR-27] shows the value in force and the pending proposal with its effect; QA approves the proposal through the ceremony', async () => {
    const ceremony = signedCeremony();
    renderOffice('/plant-rules', { role: 'QA_MBR_APPROVER', ceremony, fixtures: { 'plantRules.proposals': PROPOSALS } });
    const site = await screen.findByTestId('facility-SITE-PEN');
    expect(site.getAttribute('data-in-force')).toBe('no');
    expect(site.getAttribute('data-pending')).toBe('yes');
    expect(site.textContent).toContain('In force: not a penicillin facility');
    expect(site.textContent).toContain('loosens: in force only once QA approves it');
    const amox = screen.getByTestId('beta-MATERIAL-AMOX-3H');
    expect(amox.textContent).toContain('In force: beta-lactam');
    expect(amox.textContent).toContain('approved by Meera Iyer');
    // Only the latest proposal is offered for approval; an approved version is not.
    expect(within(amox).getAllByRole('button')).toHaveLength(1);
    await userEvent.click(within(site).getByRole('button', { name: 'Approve version 1 of SITE-PEN' }));
    await waitFor(() => expect(ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ceremony.sign.mock.calls[0]?.[0].action).toEqual({ kind: 'INDIA_ACT', act: 'FACILITY_RULE_APPROVE', subjectId: '3b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e' });
  });

  it('[PR-27] the steward proposes a facility rule and a classification as typed', async () => {
    const ui = renderOffice('/plant-rules', { role: 'MASTER_DATA_STEWARD', fixtures: { 'plantRules.proposals': PROPOSALS, 'plantRules.setFacilityRule': { version: '1', proposalId: '3b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e', state: 'PROPOSED' }, 'plantRules.classifyBetaLactam': { version: '3', proposalId: '3b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e', state: 'PROPOSED' } } });
    const f = await screen.findByTestId('propose-facility');
    await userEvent.type(within(f).getByRole('textbox', { name: 'Site code' }), 'SITE-2');
    await userEvent.click(within(f).getByRole('radio', { name: 'is not a penicillin facility' }));
    await userEvent.type(within(f).getByRole('textbox', { name: 'Justification' }), 'No penicillin block');
    await userEvent.click(within(f).getByRole('button', { name: 'Propose the facility rule' }));
    await waitFor(() => expect(ui.posts('/api/plant-rules/facilities/SITE-2')).toHaveLength(1));
    expect(ui.posts('/api/plant-rules/facilities/SITE-2')[0]?.body).toEqual({ penicillinFacility: false, justification: 'No penicillin block' });
    const b = screen.getByTestId('propose-beta-lactam');
    await userEvent.type(within(b).getByRole('textbox', { name: 'Material or product code' }), 'CEPH-1');
    await userEvent.type(within(b).getByRole('textbox', { name: 'Reason' }), 'A cephalosporin');
    await userEvent.click(within(b).getByRole('button', { name: 'Propose the classification' }));
    await waitFor(() => expect(ui.posts('/api/plant-rules/beta-lactam')).toHaveLength(1));
    expect(ui.posts('/api/plant-rules/beta-lactam')[0]?.body).toEqual({ kind: 'MATERIAL', code: 'CEPH-1', betaLactam: true, reason: 'A cephalosporin' });
    expect(await screen.findByText('The classification is proposed: a tightening is in force now, a loosening once QA approves it.')).toBeTruthy();
  });
});
