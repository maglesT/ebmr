/**
 * Inter-site transfer and federated genealogy screens (Phase 6 slice 6i; L-41, DI-31, DI-39, PR-57, IN-29) on the
 * contract's examples: the stores build and seal a package and take one in (a refusal shows its reason and that nothing
 * was taken in), QA approves a peer's key and decides a received lot through the ceremony, the receipt shows the hold
 * time, the CoA and the rule resolutions, the explorer asks the other sites and says when the result is incomplete, and
 * the mock recall shows each destination's part and asks again. Every value and gate is the server's.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { example } from '@ebmr/api-contract/examples';
import { apiState } from '../../src/api/client.ts';
import { holdLeft, packageFileHref, parsePackageFile } from '../../src/features/transfers/TransfersPages.tsx';
import { renderOffice } from '../office/support.tsx';

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

const peers = example('transfers-peers');
const file = example('transfers-package-file');
const receipt = example('transfers-receipt');
const refused = example('transfers-import-refused');
const federated = example('genealogy-federated-trace');
const incomplete = example('genealogy-federated-trace-incomplete');
const recall = example('recall-mock-recall-federated');

describe('transfer packages (L-41)', () => {
  it('[DI-31] the stores build and seal a package for a trusted installation only; the file is the payload and seal as exchanged', async () => {
    const ui = renderOffice('/transfers', { role: 'WAREHOUSE_LABELLING' });
    const form = await screen.findByTestId('transfer-prepare');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Lot (id)' }), receipt.lotId);
    // Only APPROVED peers are offered as destinations.
    const select = within(form).getByRole('combobox', { name: 'Destination installation' });
    await waitFor(() => expect([...select.querySelectorAll('option')].map((o) => o.getAttribute('value'))).toEqual(['', 'GOA-TAB-GMP']));
    await userEvent.selectOptions(select, 'GOA-TAB-GMP');
    await userEvent.type(within(form).getByRole('textbox', { name: "Quantity (in the lot's unit)" }), '100.5');
    await userEvent.click(within(form).getByRole('button', { name: 'Build and seal the package' }));
    await waitFor(() => expect(ui.posts('/api/transfers/packages')).toHaveLength(1));
    expect(ui.posts('/api/transfers/packages')[0]?.body).toEqual({ lotId: receipt.lotId, destination: 'GOA-TAB-GMP', quantity: '100.5' });
    const link = await screen.findByTestId('transfer-file-new');
    expect(link.getAttribute('download')).toBe(file.fileName);
    expect(parsePackageFile(decodeURIComponent(link.getAttribute('href')!.replace(/^data:application\/json;charset=utf-8,/, '')))).toEqual({ payload: file.payload, seal: file.seal });
    expect(packageFileHref(file)).toContain('application/json');
  });

  it('[DI-31] a package the database refuses is shown with its reason; nothing was taken in', async () => {
    const ui = renderOffice('/transfers', { role: 'WAREHOUSE_LABELLING', fixtures: { 'transfers.import': refused } });
    const form = await screen.findByTestId('transfer-import');
    const take = within(form).getByRole('button', { name: 'Take in the package' });
    expect(take.hasAttribute('disabled')).toBe(true);
    await userEvent.click(within(form).getByRole('textbox', { name: 'Package file as received' }));
    await userEvent.paste(JSON.stringify({ payload: file.payload, seal: file.seal }));
    await userEvent.click(take);
    expect((await screen.findByTestId('transfer-refused')).textContent).toBe(refused.reason);
    expect(ui.posts('/api/transfers/receipts')[0]?.body).toEqual({ payload: file.payload, seal: file.seal });
    expect(parsePackageFile('not json')).toBeNull();
  });

  it('[DI-31] QA approves a proposed installation key through the ceremony; the stores are not offered it', async () => {
    const ui = renderOffice('/transfers', { role: 'QA_REVIEWER' });
    const proposed = peers.peers.find((p) => p.state === 'PROPOSED')!;
    await userEvent.click(await within(await screen.findByTestId(`peer-${proposed.installationCode}`)).findByRole('button', { name: `Approve the key of ${proposed.installationCode}` }));
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual({ kind: 'PEER_INSTALLATION_APPROVE', peerId: proposed.peerId });
    cleanup();
    renderOffice('/transfers', { role: 'WAREHOUSE_LABELLING' });
    expect(within(await screen.findByTestId(`peer-${proposed.installationCode}`)).queryByRole('button')).toBeNull();
  });

  it('[DI-39] the receipt shows the origin\'s status, CoA, rule resolutions and hold time; local QA accepts, or refuses with a reason, through the ceremony', async () => {
    const ui = renderOffice(`/transfers/receipts/${receipt.receiptId}`, { role: 'QA_REVIEWER' });
    expect((await screen.findByTestId('receipt-summary')).textContent).toContain(`lot ${receipt.originLotCode}`);
    expect(screen.getByTestId('receipt-hold').textContent).toContain(`${holdLeft(receipt.holdRemainingSeconds)} left`);
    expect(screen.getByTestId('receipt-coa').textContent).toContain('ASSAY');
    expect(screen.getByTestId('rule-kernel.selfInspection.maxIntervalMonths').getAttribute('data-winner')).toBe('CARRIED');
    const decision = screen.getByTestId('receipt-decision');
    const refuse = await within(decision).findByRole('button', { name: 'Refuse the received lot' });
    expect(refuse.hasAttribute('disabled')).toBe(true);
    await userEvent.click(within(decision).getByRole('button', { name: 'Accept the received lot' }));
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual({ kind: 'TRANSFER_RECEIPT_DECIDE', receiptId: receipt.receiptId, decision: 'ACCEPTED' });
    await userEvent.type(within(decision).getByRole('textbox', { name: /^Reason for a refusal/ }), 'container seals broken');
    await userEvent.click(refuse);
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(2));
    expect(ui.ceremony.sign.mock.calls[1]?.[0].action).toEqual({ kind: 'TRANSFER_RECEIPT_DECIDE', receiptId: receipt.receiptId, decision: 'REFUSED', reason: 'container seals broken' });
    expect(holdLeft('0')).toBe('passed');
    expect(holdLeft('90061')).toBe('1 d 1 h 1 min');
  });

  it('[DI-39] the stores are not offered the decision on a received lot', async () => {
    renderOffice(`/transfers/receipts/${receipt.receiptId}`, { role: 'WAREHOUSE_LABELLING' });
    expect(within(await screen.findByTestId('receipt-decision')).queryByRole('button')).toBeNull();
  });
});

describe('federated genealogy (PR-57, IN-29)', () => {
  it('[PR-57] the explorer asks across sites and shows each site\'s part with its as-of; an unanswered site makes the result incomplete', async () => {
    const ui = renderOffice('/genealogy', { role: 'QA_REVIEWER' });
    const ask = await screen.findByTestId('genealogy-ask');
    await userEvent.type(within(ask).getByRole('textbox', { name: 'Record id' }), federated.local.start.id);
    await userEvent.click(within(ask).getByRole('checkbox'));
    await userEvent.click(within(ask).getByRole('button', { name: 'Trace' }));
    const part = await screen.findByTestId(`federated-part-${federated.remote[0]!.packageNo}`);
    expect(ui.requests.find((r) => r.path === '/api/genealogy/federated-trace')?.query).toEqual({ kind: 'LOT', id: federated.local.start.id, direction: 'FORWARD' });
    expect(part.getAttribute('data-status')).toBe('ANSWERED');
    expect(part.querySelectorAll('li[data-kind]')).toHaveLength(federated.remote[0]!.edges.length);
    expect(screen.getByText('Complete across sites')).toBeTruthy();
    expect(screen.getByTestId('genealogy-summary').textContent).toContain('1 transfer(s) to or from other sites');
    cleanup();
    renderOffice('/genealogy', { role: 'QA_REVIEWER', fixtures: { 'genealogy.federatedTrace': incomplete } });
    const ask2 = await screen.findByTestId('genealogy-ask');
    await userEvent.type(within(ask2).getByRole('textbox', { name: 'Record id' }), federated.local.start.id);
    await userEvent.click(within(ask2).getByRole('checkbox'));
    await userEvent.click(within(ask2).getByRole('button', { name: 'Trace' }));
    expect((await screen.findByTestId('federated-incomplete')).textContent).toContain('GOA-TAB-GMP (Unreachable)');
    expect(screen.getByTestId(`federated-part-${incomplete.remote[0]!.packageNo}`).textContent).toContain(`Last excerpt received, as of ${incomplete.remote[0]!.excerptAsOf!.text}`);
  });

  it('[IN-29] a mock recall with one site down is shown incomplete with the last excerpt; QA asks the sites again', async () => {
    const ui = renderOffice(`/recall/${recall.mockRecallId}`, { role: 'QA_REVIEWER', fixtures: { 'recall.mockRecall': recall } });
    expect((await screen.findByTestId('mock-recall-federation-incomplete')).textContent).toBe('GOA-TAB-GMP (Unreachable)');
    const t = recall.federation!.transfers[0]!;
    const line = screen.getByTestId(`mock-recall-remote-${t.packageNo}`);
    expect(line.getAttribute('data-status')).toBe('UNREACHABLE');
    expect(line.textContent).toContain(`last excerpt as of ${t.excerptAsOf!.text}`);
    expect(line.textContent).toContain('Shipment SH-GOA-77 to CUST-GOA-1');
    await userEvent.click(await within(screen.getByTestId('mock-recall-federation')).findByRole('button', { name: 'Ask the other sites again' }));
    await waitFor(() => expect(ui.posts(`/api/recall/mock-recalls/${recall.mockRecallId}/federation`)).toHaveLength(1));
  });
});
