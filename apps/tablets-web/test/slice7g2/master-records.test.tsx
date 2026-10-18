/**
 * The master-record screens of Phase 7 slice 7g-2 (decision 0025): the life-cycle signatures and market authorisations
 * of a version (/mbr/versions/$versionId/signing) and the labelling specimens (/mbr/specimens). Every act goes through
 * the ceremony with the action the server describes; who may sign what is the server's, so every act is offered and a
 * refusal is shown in the server's words.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { apiState } from '../../src/api/client.ts';
import { refusal, renderOffice, signedCeremony } from '../office/support.tsx';
import { AUTHORISATION, prepared, REG, SPECIMEN, VERSION, at } from './fixtures.ts';

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

const signingFixtures = (over: Record<string, unknown> = {}) => ({
  'designer.version': VERSION,
  'esig.signatures': { signatures: [prepared()] },
  'designer.marketAuthorisations': { authorisations: [AUTHORISATION] },
  ...over,
});

describe('the life-cycle signatures of a version', () => {
  it('[INV-04][DI-35] shows the signatures and offers all four acts with their meaning; Prepared is signed on the revision shown through the ceremony', async () => {
    const ceremony = signedCeremony();
    renderOffice(`/mbr/versions/${VERSION.versionId}/signing`, { role: 'MBR_CHECKER', fixtures: signingFixtures(), ceremony });
    expect((await screen.findByTestId('mbr-signing-state')).textContent).toContain('In verification');
    const lifecycle = screen.getByTestId('mbr-lifecycle');
    expect(lifecycle.textContent).toContain('The checker is never the author, and the approver is neither');
    await waitFor(() => expect(screen.getByTestId('mbr-sign-SUBMIT').getAttribute('data-signed')).toBe('yes'));
    expect(screen.getByTestId('mbr-sign-CHECK').getAttribute('data-signed')).toBe('no');
    for (const name of ['Sign as prepared', 'Sign as independently checked', 'Confirm the registration references', 'Approve for the quality unit']) {
      expect(within(lifecycle).getByRole('button', { name })).toBeTruthy();
    }
    await userEvent.click(within(lifecycle).getByRole('button', { name: 'Sign as independently checked' }));
    await waitFor(() => expect(ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ceremony.sign.mock.calls[0]?.[0].action).toEqual({ kind: 'MBR_TRANSITION', versionId: VERSION.versionId, transition: 'CHECK', baseRevision: VERSION.revision });
  });

  it('[INV-04] a refused signature is shown in the server\'s words', async () => {
    const ceremony = { sign: () => Promise.resolve({ status: 'REFUSED' as const, refusal: refusal('EBMR-ESIG-030', 'The checker may not be the author.', 'mbr_version: the role MBR_AUTHOR may not sign CHECKED').body }) };
    renderOffice(`/mbr/versions/${VERSION.versionId}/signing`, { role: 'MBR_AUTHOR', fixtures: signingFixtures(), ceremony: ceremony as unknown as ReturnType<typeof signedCeremony> });
    await userEvent.click(await screen.findByRole('button', { name: 'Sign as independently checked' }));
    expect(await screen.findByText('The checker may not be the author.')).toBeTruthy();
  });
});

describe('market authorisations', () => {
  it('[PR-04] a proposed authorisation offers the regulatory confirmation and QA\'s authorisation, which carries QA\'s own reason', async () => {
    const ceremony = signedCeremony();
    renderOffice(`/mbr/versions/${VERSION.versionId}/signing`, { role: 'QA_MBR_APPROVER', fixtures: signingFixtures(), ceremony });
    const item = await screen.findByTestId('market-IN');
    expect(item.getAttribute('data-state')).toBe('PROPOSED');
    expect(item.textContent).toContain('Registration not confirmed yet.');
    await userEvent.click(within(item).getByRole('button', { name: 'Confirm the registration for IN' }));
    await waitFor(() => expect(ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ceremony.sign.mock.calls[0]?.[0].action).toEqual({ kind: 'MBR_MARKET_ACT', act: 'REGULATORY_CONFIRM', authorisationId: AUTHORISATION.authorisationId });
    const authorise = within(item).getByRole('button', { name: 'Authorise for IN' });
    expect(authorise.hasAttribute('disabled')).toBe(true);
    await userEvent.type(within(item).getByRole('textbox', { name: 'Reason (authorisation)' }), 'IN registration confirmed');
    await userEvent.click(authorise);
    await waitFor(() => expect(ceremony.sign).toHaveBeenCalledTimes(2));
    expect(ceremony.sign.mock.calls[1]?.[0].action).toEqual({ kind: 'MBR_MARKET_ACT', act: 'AUTHORISE', authorisationId: AUTHORISATION.authorisationId, reason: { code: 'MARKET_AUTHORISED', text: 'IN registration confirmed' } });
  });

  it('[PR-04][PR-05] QA proposes an authorisation for a market of the master and scope; an active one shows who confirmed and authorised it and can be withdrawn with a reason', async () => {
    const active = { ...AUTHORISATION, state: 'ACTIVE' as const, regulatoryConfirmedBy: { by: REG, at: at('18-OCT-2026 11:00') }, activatedAt: at('18-OCT-2026 12:00') };
    const ui = renderOffice(`/mbr/versions/${VERSION.versionId}/signing`, { role: 'QA_MBR_APPROVER', fixtures: signingFixtures({ 'designer.marketAuthorisations': { authorisations: [active] }, 'designer.proposeMarketAuthorisation': AUTHORISATION, 'designer.withdrawMarketAuthorisation': { ...active, state: 'WITHDRAWN' } }) });
    const item = await screen.findByTestId('market-IN');
    expect(item.textContent).toContain('Registration confirmed by Rahul Menon');
    expect(within(item).queryByRole('button', { name: 'Authorise for IN' })).toBeNull();
    const form = screen.getByTestId('mbr-propose-market');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Site' }), 'SITE-1');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Line' }), 'L2');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Batch size (its id in the master)' }), 'BS-100K');
    await userEvent.type(within(form).getByRole('textbox', { name: /^Regulatory basis/ }), 'IN: variation approved');
    await userEvent.click(within(form).getByRole('button', { name: 'Propose the authorisation' }));
    await waitFor(() => expect(ui.posts(`/api/mbr/versions/${VERSION.versionId}/market-authorisations`)).toHaveLength(1));
    expect(ui.posts(`/api/mbr/versions/${VERSION.versionId}/market-authorisations`)[0]?.body).toEqual({ market: 'IN', kind: 'CURRENT', cells: [{ site: 'SITE-1', line: 'L2', batchSize: 'BS-100K' }], regulatoryBasis: 'IN: variation approved' });
    await userEvent.type(within(item).getByRole('textbox', { name: 'Reason code (withdrawal)' }), 'MARKET_EXIT');
    await userEvent.type(within(item).getByRole('textbox', { name: 'Reason (withdrawal)' }), 'Withdrawn from the market');
    await userEvent.click(within(item).getByRole('button', { name: 'Withdraw the authorisation for IN' }));
    await waitFor(() => expect(ui.posts(`/api/mbr/market-authorisations/${AUTHORISATION.authorisationId}/withdraw`)).toHaveLength(1));
    expect(ui.posts(`/api/mbr/market-authorisations/${AUTHORISATION.authorisationId}/withdraw`)[0]?.body).toEqual({ reason: { code: 'MARKET_EXIT', text: 'Withdrawn from the market' } });
  });
});

describe('labelling specimens', () => {
  it('[DI-35] lists the specimens with their state; a recorded one is approved through the ceremony, an approved one is not offered again', async () => {
    const ceremony = signedCeremony();
    renderOffice('/mbr/specimens', { role: 'QA_MBR_APPROVER', ceremony, fixtures: { 'designer.specimens': { specimens: [SPECIMEN, { ...SPECIMEN, documentId: '1b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e', version: '2', state: 'APPROVED', approvedBy: REG, approvedAt: at('x') }] } } });
    const recorded = await screen.findByTestId('specimen-SPC-CARTON-1');
    expect(recorded.textContent).toContain('recorded by Neha Joshi');
    expect(within(screen.getByTestId('specimen-SPC-CARTON-2')).queryByRole('button')).toBeNull();
    await userEvent.click(within(recorded).getByRole('button', { name: 'Approve specimen SPC-CARTON version 1' }));
    await waitFor(() => expect(ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ceremony.sign.mock.calls[0]?.[0].action).toEqual({ kind: 'SPECIMEN_ACT', act: 'APPROVE', documentId: SPECIMEN.documentId });
  });
});
