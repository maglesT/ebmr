/**
 * The release cockpit's market tabs and the market changes (Phase 4 slice 4c) on the contract's examples: the US tab
 * (state, G-REL for US, the QCU's release or rejection naming its investigation, the recorded decision, and the two-row
 * release offered to the authorised person who also holds the QCU role, with the server's companion passed to the
 * ceremony), the EU tab (importer, certification register, the structured message with its acknowledgement, the
 * transcription and the second person's verification, the in-system QP behind its switch), the India tab, the market-add
 * evaluation and the signed addition and removal of a lot's or a batch's market. Every signed act goes through
 * esig.describe and the ceremony with the action as sent; the browser computes no state, gate or outcome.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionView } from '@ebmr/api-contract';
import { EXAMPLES, example } from '@ebmr/api-contract/examples';
import { apiState } from '../../src/api/client.ts';
import { refusal, renderOffice } from '../office/support.tsx';

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

const lot = example('release-lot');
const markets = example('release-markets');
const marketAdd = example('release-market-add');
const L = lot.lotId;
const ready = { ready: true, problems: [] };
const US = markets.dispositions.find((d) => d.market === 'US');
const EU = markets.dispositions.find((d) => d.market === 'EU');
if (!US || !EU) throw new Error('the markets example names US and EU');
const usGrel = US.grel;
if (!usGrel) throw new Error('the US example has its G-REL');
const DEV = 'a9b8c7d6-e5f4-4a3b-8c2d-1e0f9a8b7c6d';
const CR = 'c0ffee00-1234-4abc-8def-0123456789ab';

/** A US disposition not decided yet, ready to release. */
const usReady = { ...US, state: 'READY' as const, decision: null, gates: { ...US.gates, release: ready, reject: ready } };
/** An EU disposition waiting for the QP. */
const euAwaiting = { ...EU, state: 'AWAITING_QP_CERTIFICATION' as const, certifications: [], gates: { ...EU.gates, certify: ready } };
const withMarkets = (dispositions: unknown[], set: string[] = markets.markets) => ({ ...markets, manufacturerState: 'READY', markets: set, dispositions });

async function openTab(name: RegExp) {
  await userEvent.click(await screen.findByRole('tab', { name }));
}

const session = (role: string, roles: string[]) => ({ ...(EXAMPLES['session-office'].data as SessionView), role, roles });

describe('US tab', () => {
  it('shows the US state, G-REL for US with its items and the recorded decision signed with the manufacturer release', async () => {
    renderOffice(`/release/${L}`, { role: 'US_QCU_SIGNER' });
    await openTab(/^US$/);
    expect((await screen.findByTestId('market-state-US')).textContent).toContain('Released');
    expect(screen.getByTestId('grel-US-item-G11.REGISTRATION').getAttribute('data-status')).toBe('GREEN');
    const decision = screen.getByTestId('us-decision');
    expect(decision.textContent).toContain('in the same ceremony as the manufacturer release');
    expect(decision.textContent).toContain(US.decision?.checklistHash ?? 'x');
    // Decided: nothing more to sign.
    expect(screen.queryByTestId('us-release')).toBeNull();
    expect(screen.getByRole('tab', { name: /^US$/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('[INV-39] the QCU signs the US release with the epoch of G-REL for US shown, through esig.describe and the ceremony', async () => {
    const ui = renderOffice(`/release/${L}`, { role: 'US_QCU_SIGNER', fixtures: { 'release.markets': withMarkets([usReady, EU]) } });
    await openTab(/^US$/);
    const box = await screen.findByTestId('us-release');
    await userEvent.click(within(box).getByRole('button', { name: 'Sign the US release' }));
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    const action = { kind: 'RELEASE_ACT', act: 'US_DISPOSE', lotId: L, input: { usDecision: 'RELEASE', expectedEpoch: usGrel.epoch } };
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual(action);
    expect(ui.posts('/api/esig/describe')[0]?.body).toEqual({ action });
    expect(ui.ceremony.sign.mock.calls[0]?.[0].companion).toBeUndefined();
  });

  it('the US release cannot be pressed while its gate stands; the reasons are the server\'s', async () => {
    const blocked = { ...usReady, gates: { ...usReady.gates, release: { ready: false, problems: ['the manufacturer release of the lot is not RELEASED'] } } };
    renderOffice(`/release/${L}`, { role: 'US_QCU_SIGNER', fixtures: { 'release.markets': withMarkets([blocked, EU]) } });
    await openTab(/^US$/);
    const box = await screen.findByTestId('us-release');
    expect(within(box).getByTestId('us-release-problems').textContent).toContain('the manufacturer release of the lot is not RELEASED');
    expect(within(box).getByRole('button', { name: 'Sign the US release' }).hasAttribute('disabled')).toBe(true);
  });

  it('[PR-56] a US rejection needs the person\'s reason, both halves, and the investigation every other market sees', async () => {
    const ui = renderOffice(`/release/${L}`, { role: 'US_QCU_SIGNER', fixtures: { 'release.markets': withMarkets([usReady, EU]) } });
    await openTab(/^US$/);
    const box = await screen.findByTestId('us-reject');
    const button = within(box).getByRole('button', { name: 'Sign the US rejection' });
    await userEvent.type(within(box).getByRole('textbox', { name: 'Reason code' }), 'OOS');
    await userEvent.type(within(box).getByRole('textbox', { name: 'Reason for the US rejection' }), 'Dissolution fails the USP limit');
    expect(button.hasAttribute('disabled')).toBe(true);
    await userEvent.type(within(box).getByRole('textbox', { name: 'Investigation (deviation id)' }), DEV);
    await userEvent.click(button);
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual({
      kind: 'RELEASE_ACT',
      act: 'US_DISPOSE',
      lotId: L,
      input: { usDecision: 'REJECT', expectedEpoch: usGrel.epoch, reason: { code: 'OOS', text: 'Dissolution fails the USP limit' }, deviationId: DEV },
    });
  });

  it('[D-P4-5] the AP who also holds the QCU role signs the manufacturer and US release once: both epochs sent, the server\'s companion passed to the ceremony', async () => {
    const companion = { aggregateType: 'us_disposition', aggregateId: `${L}/RELEASE`, meaning: 'US_DISPOSITION', expectedState: null };
    const ui = renderOffice(`/release/${L}`, {
      fixtures: {
        'session.get': session('AUTHORISED_PERSON', ['AUTHORISED_PERSON', 'US_QCU_SIGNER']),
        'release.lot': { ...lot, state: 'READY', gates: { ...lot.gates, release: ready } },
        'release.markets': withMarkets([{ ...usReady, gates: { ...usReady.gates, release: { ready: false, problems: ['the manufacturer release is not RELEASED'] } } }, EU]),
        'esig.describe': { kind: 'RELEASE_ACT', aggregateType: 'manufacturer_release', aggregateId: `${L}/RELEASE`, meaning: 'MANUFACTURER_RELEASE', expectedState: null, companion },
      },
    });
    await openTab(/^US$/);
    const box = await screen.findByTestId('two-row-release');
    await userEvent.click(within(box).getByRole('button', { name: 'Sign the manufacturer and US release' }));
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    const req = ui.ceremony.sign.mock.calls[0]?.[0];
    expect(req?.action).toEqual({ kind: 'RELEASE_ACT', act: 'MANUFACTURER_RELEASE', lotId: L, input: { expectedEpoch: lot.grel.epoch, usExpectedEpoch: usGrel.epoch } });
    expect(req).toMatchObject({ aggregateType: 'manufacturer_release', meaning: 'MANUFACTURER_RELEASE', companion: { aggregateType: 'us_disposition', aggregateId: `${L}/RELEASE`, meaning: 'US_DISPOSITION' } });
    // Not the QCU's own act: the AP is not offered the one-row US disposition.
    expect(screen.queryByTestId('us-release')).toBeNull();
  });

  it('[D-P4-5] the two-row release is not offered to an AP without the QCU role, nor while the manufacturer gate stands', async () => {
    renderOffice(`/release/${L}`, { role: 'AUTHORISED_PERSON', fixtures: { 'release.markets': withMarkets([usReady, EU]) } });
    await openTab(/^US$/);
    await screen.findByTestId('grel-US');
    expect(screen.queryByTestId('two-row-release')).toBeNull();
    cleanup();
    renderOffice(`/release/${L}`, { fixtures: { 'session.get': session('AUTHORISED_PERSON', ['AUTHORISED_PERSON', 'US_QCU_SIGNER']), 'release.markets': withMarkets([usReady, EU]) } });
    await openTab(/^US$/);
    const box = await screen.findByTestId('two-row-release');
    expect(within(box).getByTestId('two-row-problems').textContent).toContain('G-REL item G4.RECONCILIATION is RED');
    expect(within(box).getByRole('button', { name: 'Sign the manufacturer and US release' }).hasAttribute('disabled')).toBe(true);
  });
});

describe('EU tab', () => {
  const pending = {
    ...EU.certifications[0],
    certificationId: 'b1b2b3b4-c5c6-4d7d-8e9e-0f1f2f3f4f5f',
    reference: 'QP-CERT-2026-0413',
    verified: false,
    verifiedBy: null,
  };

  it('shows the importer of the product, the register of certifications and a transcription waiting for its second person', async () => {
    const importers = { importers: [{ ...example('release-importers').importers[0], products: [lot.productCode] }] };
    const ui = renderOffice(`/release/${L}`, { role: 'QA_REVIEWER', fixtures: { 'release.importers': importers, 'release.markets': withMarkets([US, { ...EU, certifications: [...EU.certifications, pending] }]) } });
    await openTab(/^EU$/);
    expect((await screen.findByTestId('eu-importer')).textContent).toContain('EUIMP-DE-01');
    expect(screen.getByTestId('market-state-EU').textContent).toContain('Certified');
    expect(screen.getByTestId('certification-QP-CERT-2026-0412').getAttribute('data-verified')).toBe('true');
    const row = screen.getByTestId('certification-QP-CERT-2026-0413');
    expect(row.textContent).toContain("Waiting for a second person's verification");
    await userEvent.click(within(row).getByRole('button', { name: 'Verify transcription QP-CERT-2026-0413' }));
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual({ kind: 'RELEASE_ACT', act: 'QP_INTAKE_VERIFY', lotId: L, input: { intakeId: pending.certificationId } });
  });

  it('[DI-39] a structured message is taken in as received with the importer\'s signature; the acknowledgement sent back is shown', async () => {
    const ui = renderOffice(`/release/${L}`, { role: 'QA_REVIEWER', fixtures: { 'release.markets': withMarkets([US, euAwaiting]) } });
    await openTab(/^EU$/);
    const box = await screen.findByTestId('qp-message');
    const message = '{"format":"ebmr.qp-certification.v1","messageId":"EUIMP-DE-01-2026-0412"}';
    const signature = `${'A'.repeat(86)}==`;
    const take = within(box).getByRole('button', { name: 'Take in the message' });
    await userEvent.click(within(box).getByLabelText('Message as received'));
    await userEvent.paste(message);
    expect(take.hasAttribute('disabled')).toBe(true);
    await userEvent.type(within(box).getByRole('textbox', { name: "Importer's signature (base64)" }), signature);
    await userEvent.click(take);
    await waitFor(() => expect(ui.posts('/api/release/qp-messages')).toHaveLength(1));
    expect(ui.posts('/api/release/qp-messages')[0]?.body).toEqual({ message, signature });
    expect((await within(box).findByTestId('qp-ack')).textContent).toContain('EUIMP-DE-01-2026-0412');
    expect(within(box).getByText('Message accepted; acknowledgement sent')).toBeTruthy();
  });

  it('[DI-39] a refused message shows the database\'s reason in the acknowledgement', async () => {
    const refused = { ...example('release-qp-message'), outcome: 'REFUSED', reason: 'the signature does not verify with the key of importer EUIMP-DE-01', certificationId: null };
    renderOffice(`/release/${L}`, { role: 'QA_REVIEWER', fixtures: { 'release.markets': withMarkets([US, euAwaiting]), 'release.qpMessage': refused } });
    await openTab(/^EU$/);
    const box = await screen.findByTestId('qp-message');
    await userEvent.click(within(box).getByLabelText('Message as received'));
    await userEvent.paste('{"x":1}');
    await userEvent.type(within(box).getByRole('textbox', { name: "Importer's signature (base64)" }), `${'B'.repeat(86)}==`);
    await userEvent.click(within(box).getByRole('button', { name: 'Take in the message' }));
    expect((await within(box).findByTestId('qp-ack')).textContent).toContain('the signature does not verify');
    expect(within(box).getByText('Message refused; acknowledgement sent')).toBeTruthy();
  });

  it('[DI-30] a transcribed certification is signed with every detail as entered; a QP rejection needs its reason', async () => {
    const ui = renderOffice(`/release/${L}`, { role: 'QA_REVIEWER', fixtures: { 'release.markets': withMarkets([US, euAwaiting]) } });
    await openTab(/^EU$/);
    const box = await screen.findByTestId('qp-transcribe');
    const sign = within(box).getByRole('button', { name: 'Sign the transcription' });
    await userEvent.click(within(box).getByRole('radio', { name: 'Rejected by QP' }));
    await userEvent.type(within(box).getByRole('textbox', { name: 'Qualified person' }), 'Dr. Lena Vogel');
    await userEvent.type(within(box).getByRole('textbox', { name: 'MIA number' }), 'DE-MIA-2024-118');
    await userEvent.type(within(box).getByRole('textbox', { name: /^Certified at/ }), '2026-10-03T09:20:00+02:00');
    await userEvent.type(within(box).getByRole('textbox', { name: 'Certification reference' }), 'QP-CERT-2026-0414');
    expect(sign.hasAttribute('disabled')).toBe(true);
    await userEvent.type(within(box).getByRole('textbox', { name: 'Reason code' }), 'QP');
    await userEvent.type(within(box).getByRole('textbox', { name: "The QP's reason, as written" }), 'Shipping temperature excursion');
    await userEvent.click(sign);
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual({
      kind: 'RELEASE_ACT',
      act: 'QP_INTAKE',
      lotId: L,
      input: {
        qpOutcome: 'REJECTED_BY_QP',
        certification: { certifier: 'Dr. Lena Vogel', miaNumber: 'DE-MIA-2024-118', certifiedAt: '2026-10-03T09:20:00+02:00', reference: 'QP-CERT-2026-0414' },
        reason: { code: 'QP', text: 'Shipping temperature excursion' },
      },
    });
  });

  it('[PR-55] the in-system certification is offered to the registered QP only while its switch is on', async () => {
    renderOffice(`/release/${L}`, { role: 'EU_QP', fixtures: { 'release.markets': withMarkets([US, euAwaiting]) } });
    await openTab(/^EU$/);
    await screen.findByTestId('eu-certifications');
    expect(screen.queryByTestId('qp-certify')).toBeNull();
    cleanup();
    const ui = renderOffice(`/release/${L}`, { role: 'EU_QP', fixtures: { 'release.markets': withMarkets([US, { ...euAwaiting, inSystemQp: true }]) } });
    await openTab(/^EU$/);
    const box = await screen.findByTestId('qp-certify');
    // The QP takes in no transcription (QA's act).
    expect(screen.queryByTestId('qp-transcribe')).toBeNull();
    await userEvent.click(within(box).getByRole('radio', { name: 'Certified' }));
    await userEvent.click(within(box).getByRole('button', { name: 'Sign the certification' }));
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    const euGrel = euAwaiting.grel;
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual({ kind: 'RELEASE_ACT', act: 'QP_CERTIFY', lotId: L, input: { qpOutcome: 'CERTIFIED', expectedEpoch: euGrel?.epoch } });
  });
});

describe('India tab', () => {
  it('shows the manufacturer state: market IN is decided by the manufacturer release', async () => {
    renderOffice(`/release/${L}`, { role: 'QA_REVIEWER', fixtures: { 'release.lot': example('release-lot-released') } });
    await openTab(/^India$/);
    const box = await screen.findByTestId('market-in');
    expect(within(box).getByTestId('market-state-IN').textContent).toContain('Released');
    expect(box.textContent).toContain('Anita Rao');
  });
});

describe('market add and removal (3.3.3)', () => {
  it('[INV-43] a market not in the set shows the evaluation with each item\'s outcome and reason; QA signs the addition under a change record', async () => {
    const ui = renderOffice(`/release/${L}`, { role: 'QA_REVIEWER', fixtures: { 'release.markets': withMarkets([EU], ['EU', 'IN']) } });
    await openTab(/^US$/);
    expect((await screen.findByTestId('market-state-US')).textContent).toContain('not in the lot\'s market set');
    const box = await screen.findByTestId('market-add-US');
    const evaluation = await within(box).findByTestId('market-add-eval-US');
    expect(evaluation.getAttribute('data-outcome')).toBe('UNMET_FINAL');
    expect(within(evaluation).getByTestId('market-add-eval-US-MA.IDENTITY_ROUTE').textContent).toContain('vendor-history route');
    expect(within(evaluation).getByTestId('market-add-eval-US-MA.MBR_AUTHORISATION').getAttribute('data-outcome')).toBe('MET');
    await waitFor(() => expect(ui.requests.some((r) => r.path === `/api/release/lots/${L}/market-add` && r.query['market'] === 'US')).toBe(true));
    const sign = within(box).getByRole('button', { name: 'Sign the addition of US' });
    expect(sign.hasAttribute('disabled')).toBe(true);
    await userEvent.type(within(box).getByRole('textbox', { name: 'Change record (id)' }), CR);
    await userEvent.click(sign);
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual({ kind: 'RELEASE_ACT', act: 'MARKET_ADD', lotId: L, input: { market: 'US', changeRecordId: CR } });
  });

  it('[INV-43] QA removes a market with a linked deviation chosen from the batch\'s records', async () => {
    const devs = example('quality-deviations');
    const first = devs.deviations[0];
    if (!first) throw new Error('the deviations example lists one');
    const ui = renderOffice(`/release/${L}`, { role: 'QA_REVIEWER', fixtures: { 'release.markets': withMarkets([US, euAwaiting]) } });
    await openTab(/^EU$/);
    const box = await screen.findByTestId('market-remove-EU');
    await userEvent.click(await within(box).findByRole('radio', { name: new RegExp(first.ref) }));
    await userEvent.click(within(box).getByRole('button', { name: 'Sign the removal of EU' }));
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual({ kind: 'RELEASE_ACT', act: 'MARKET_REMOVE', lotId: L, input: { market: 'EU', deviationId: first.deviationId } });
    expect(ui.requests.some((r) => r.path === '/api/quality/deviations' && r.query['batchId'] === lot.batchId)).toBe(true);
  });

  it('[INV-43] the signed changes show the change record, the deviation, the evaluation signed with an addition and the "removed after failure" flag', async () => {
    const by = example('release-lot-released').decision?.by;
    const at = example('release-lot-released').decision?.at;
    const base = { market: 'US', subjectKind: 'LOT', subjectId: L, by, at, signatureId: 'd1d2d3d4-e5e6-4f7f-8a8a-9b9b9b9b9b9b' };
    const changes = [
      { ...base, changeId: '11111111-2222-4333-8444-555555555555', change: 'ADD', changeRecord: 'CC-2026-021', deviationRef: null, removedAfterFailure: false, evaluation: marketAdd },
      { ...base, changeId: '66666666-7777-4888-8999-aaaaaaaaaaaa', change: 'REMOVE', changeRecord: null, deviationRef: 'DEV-2026-0031', removedAfterFailure: true, evaluation: null },
    ];
    renderOffice(`/release/${L}`, { role: 'QA_REVIEWER', fixtures: { 'release.markets': withMarkets([{ ...US, state: 'REMOVED', decision: null, grel: null, changes }, EU], ['EU', 'IN']) } });
    await openTab(/^US$/);
    const list = await screen.findByTestId('market-changes-US');
    const add = within(list).getByTestId('market-change-11111111-2222-4333-8444-555555555555');
    expect(add.textContent).toContain('CC-2026-021');
    expect(within(add).getByTestId('market-change-eval-11111111-2222-4333-8444-555555555555').getAttribute('data-outcome')).toBe('UNMET_FINAL');
    const removed = within(list).getByTestId('market-change-66666666-7777-4888-8999-aaaaaaaaaaaa');
    expect(removed.textContent).toContain('DEV-2026-0031');
    expect(removed.textContent).toContain('Removed after failure');
    expect(screen.getByTestId('market-state-US').textContent).toContain('Removed');
  });

  it('[INV-43] an INELIGIBLE market says so; the refusal of a signed act is the server\'s', async () => {
    const ui = renderOffice(`/release/${L}`, {
      role: 'QA_REVIEWER',
      fixtures: {
        'release.markets': withMarkets([{ ...US, state: 'INELIGIBLE', decision: null }, euAwaiting]),
        'esig.describe': refusal('EBMR-REL-071', 'The market cannot be removed.', 'No deviation record is linked to the lot.'),
      },
    });
    await openTab(/^US$/);
    expect((await screen.findByTestId('market-state-US')).textContent).toContain('Ineligible');
    expect(screen.getByText('The lot can never be released for US')).toBeTruthy();
    const box = screen.getByTestId('market-remove-US');
    await userEvent.type(within(box).getByRole('textbox', { name: 'Deviation (id)' }), DEV);
    await userEvent.click(within(box).getByRole('button', { name: 'Sign the removal of US' }));
    expect(await within(box).findByText(/The market cannot be removed/)).toBeTruthy();
    expect(ui.ceremony.sign).not.toHaveBeenCalled();
  });
});

describe('markets of a batch', () => {
  const B = example('review-batch').batchId;

  it('[INV-43] shows the batch\'s set and the evaluation for a market; QA signs the removal of a market in the set (BATCH_MARKET_ACT)', async () => {
    const ui = renderOffice(`/release/batches/${B}`, { role: 'QA_REVIEWER' });
    expect((await screen.findByTestId('batch-markets')).textContent).toContain('EU, IN, US');
    await userEvent.click(screen.getByRole('radio', { name: 'US' }));
    expect((await screen.findByTestId('batch-market-add-eval-US')).getAttribute('data-outcome')).toBe('UNMET_FINAL');
    expect(ui.requests.some((r) => r.path === `/api/release/batches/${B}/market-add` && r.query['market'] === 'US')).toBe(true);
    const box = screen.getByTestId('batch-market-remove-act');
    expect(screen.queryByTestId('batch-market-add-act')).toBeNull();
    await userEvent.type(within(box).getByRole('textbox', { name: 'Deviation (id)' }), DEV);
    await userEvent.click(within(box).getByRole('button', { name: 'Sign the removal of US' }));
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual({ kind: 'BATCH_MARKET_ACT', act: 'MARKET_REMOVE', batchId: B, input: { market: 'US', deviationId: DEV } });
  });

  it('[INV-43] a market outside the batch\'s set is added under a change record', async () => {
    const ui = renderOffice(`/release/batches/${B}`, { role: 'QA_REVIEWER', fixtures: { 'review.batch': { ...example('review-batch'), markets: ['IN'] } } });
    await screen.findByTestId('batch-markets');
    await userEvent.click(screen.getByRole('radio', { name: 'EU' }));
    const box = await screen.findByTestId('batch-market-add-act');
    await screen.findByTestId('batch-market-add-eval-EU');
    await userEvent.type(within(box).getByRole('textbox', { name: 'Change record (id)' }), CR);
    await userEvent.click(within(box).getByRole('button', { name: 'Sign the addition of EU' }));
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual({ kind: 'BATCH_MARKET_ACT', act: 'MARKET_ADD', batchId: B, input: { market: 'EU', changeRecordId: CR } });
  });
});
