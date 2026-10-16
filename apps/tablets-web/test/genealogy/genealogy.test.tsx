/**
 * Genealogy and recall screens (Phase 6 slice 6d; PR-57, IN-07, IN-29, PR-50, PR-49) on the contract's examples: the
 * explorer (tree and table both ways, the node-kind filter, the as-of instant sent as microseconds, the CSV export), the
 * complaint lookup, the API supply-chain report, the deviation impact list, the mock-recall cockpit (QA's run, the AP's
 * sign-off through the ceremony) and the recurrence warning on the certification (release) screen. Every value and
 * gate is the server's; these tests check that the screens show what the server says and send what the person chose.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { example } from '@ebmr/api-contract/examples';
import { apiState } from '../../src/api/client.ts';
import { exportRows } from '../../src/features/genealogy/GenealogyExplorerPage.tsx';
import { reconciliationRows } from '../../src/features/genealogy/MockRecallPages.tsx';
import { csvField } from '../../src/features/genealogy/reads.ts';
import { renderOffice } from '../office/support.tsx';

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

const trace = example('genealogy-trace');
const lookup = example('genealogy-lookup');
const supply = example('genealogy-supply-chain');
const impact = example('genealogy-deviation-impact');
const recurrence = example('genealogy-recurrence');
const mock = example('recall-mock-recall');
const signed = example('recall-mock-recall-signed-off');
const lot = example('release-lot');

describe('genealogy explorer (PR-57, IN-07)', () => {
  it('[PR-57][IN-07] a trace asked with an as-of instant is sent as microseconds; the tree expands each node once and names a node reached again; the table and the kind filter show the server rows', async () => {
    const ui = renderOffice('/genealogy', { role: 'QA_REVIEWER' });
    const ask = await screen.findByTestId('genealogy-ask');
    await userEvent.type(within(ask).getByRole('textbox', { name: 'Record id' }), trace.start.id);
    await userEvent.click(within(ask).getByRole('radio', { name: 'Backward (where it came from)' }));
    await userEvent.type(within(ask).getByRole('textbox', { name: /^As of/ }), '2026-10-12T10:10:00+05:30');
    await userEvent.click(within(ask).getByRole('button', { name: 'Trace' }));
    await screen.findByTestId('genealogy-result');
    const asked = ui.requests.find((r) => r.path === '/api/genealogy/trace');
    expect(asked?.query).toEqual({ kind: 'LOT', id: trace.start.id, direction: 'BACKWARD', asOfUs: '1791780000000000' });
    expect(screen.getByTestId('genealogy-summary').textContent).toContain(`As of ${trace.asOf.text}: 3 lot(s), 3 batch(es), 2 container(s), 1 shipment(s).`);
    // Tree: every edge row is a list item; the packaging batch reached by its packaging order and by its bulk issue is
    // expanded once and named again once.
    const tree = screen.getByTestId('genealogy-tree');
    expect(tree.querySelectorAll('li')).toHaveLength(trace.edges.length);
    const p1 = [...tree.querySelectorAll('li[data-kind="BATCH"]')].filter((li) => li.getAttribute('data-testid') === 'genealogy-node-GBT01-2601-P1');
    expect(p1.map((li) => li.getAttribute('data-repeat')).sort()).toEqual(['false', 'true']);
    expect(within(tree).getAllByText(/reached again/)).toHaveLength(2);
    // Table with the kind filter.
    await userEvent.click(screen.getByRole('radio', { name: 'Table' }));
    const table = screen.getByTestId('genealogy-table');
    expect(table.querySelectorAll('tbody tr')).toHaveLength(trace.edges.length);
    await userEvent.click(within(screen.getByRole('radiogroup', { name: 'Node kind' })).getByRole('radio', { name: 'Shipment' }));
    const rows = [...screen.getByTestId('genealogy-table').querySelectorAll('tbody tr')];
    expect(rows.map((r) => r.getAttribute('data-kind'))).toEqual(['SHIPMENT']);
    expect(rows[0]?.textContent).toContain('Shipped');
    expect(rows[0]?.getAttribute('data-depth')).toBe('4');
  });

  it('[PR-57] an as-of instant without its offset is not sent; an empty one means now', async () => {
    const ui = renderOffice(`/genealogy?kind=BATCH&id=${trace.start.id}&direction=FORWARD`, { role: 'QA_REVIEWER' });
    await screen.findByTestId('genealogy-result');
    expect(ui.requests.find((r) => r.path === '/api/genealogy/trace')?.query).toEqual({ kind: 'BATCH', id: trace.start.id, direction: 'FORWARD' });
    const ask = screen.getByTestId('genealogy-ask');
    await userEvent.type(within(ask).getByRole('textbox', { name: /^As of/ }), '2026-10-12T10:10');
    expect(within(ask).getByRole('button', { name: 'Trace' }).hasAttribute('disabled')).toBe(true);
  });

  it('[PR-57] the export holds every edge row with the direction and the as-of point, quoted where needed', () => {
    const rows = exportRows(trace);
    expect(rows).toHaveLength(trace.edges.length + 1);
    expect(rows[0]).toEqual(['depth', 'kind', 'label', 'id', 'code', 'name', 'sub_kind', 'state', 'edge_kind', 'from_kind', 'from_label', 'direction', 'as_of_us']);
    expect(rows.at(-1)?.slice(0, 3)).toEqual(['4', 'SHIPMENT', 'SH-26001']);
    expect(rows.every((r, i) => i === 0 || (r[11] === 'FORWARD' && r[12] === trace.asOf.us))).toBe(true);
    expect(csvField('a,"b"')).toBe('"a,""b"""');
    expect(csvField('plain')).toBe('plain');
  });
});

describe('complaint lookup, supply chain and impact (PR-57, PR-50)', () => {
  it('[PR-57] the complaint lookup by number opens the lot, its records, deviations and shipments with the distribution fields', async () => {
    const ui = renderOffice('/genealogy/lookup', { role: 'QA_REVIEWER' });
    await userEvent.type(await screen.findByRole('textbox', { name: 'Lot, batch or shipment number' }), ' GBT01-2601-P1 ');
    await userEvent.click(screen.getByRole('button', { name: 'Look up' }));
    await screen.findByTestId('lookup-result');
    expect(ui.requests.find((r) => r.path === '/api/genealogy/lookup')?.query).toEqual({ code: 'GBT01-2601-P1' });
    expect(screen.getByTestId('lookup-batches').querySelectorAll('li')).toHaveLength(lookup.batches.length);
    const s = lookup.shipments[0]!;
    const row = screen.getByTestId(`shipment-${s.shipmentNo}`);
    expect(row.getAttribute('data-complete')).toBe('true');
    for (const part of [s.productName, s.lotCode, s.consigneeName, s.quantity, s.shippedAt.text]) expect(row.textContent).toContain(part);
    expect(screen.getByTestId('lookup-deviations').querySelectorAll('li')).toHaveLength(lookup.deviations.length);
  });

  it('[PR-57] a distribution record without the consignee address is flagged incomplete, never filled in', async () => {
    const s = { ...lookup.shipments[0]!, consigneeAddress: null, complete: false };
    renderOffice('/genealogy/lookup', { role: 'QA_REVIEWER', fixtures: { 'genealogy.lookup': { ...lookup, shipments: [s] } } });
    await userEvent.type(await screen.findByRole('textbox', { name: 'Lot, batch or shipment number' }), 'SH-26001');
    await userEvent.click(screen.getByRole('button', { name: 'Look up' }));
    const row = await screen.findByTestId(`shipment-${s.shipmentNo}`);
    expect(row.getAttribute('data-complete')).toBe('false');
    expect(row.textContent).toContain('Incomplete record: no consignee address');
  });

  it('[PR-57] the API supply-chain report names each upstream lot with its supplier, supplier lot and manufacturer', async () => {
    renderOffice(`/genealogy/lots/${supply.lot.id}/supply-chain`, { role: 'QA_REVIEWER' });
    const line = supply.lines[0]!;
    const row = await screen.findByTestId(`supply-${line.lot.label}`);
    for (const part of [line.supplier!, line.supplierLot!, line.manufacturerCode!, ...line.consumedBy]) expect(row.textContent).toContain(part);
    expect(decodeURIComponent(screen.getByTestId('supply-chain-export').getAttribute('href') ?? '')).toContain(`${line.lot.label},${line.lot.code ?? ''},API,3,`);
  });

  it('[PR-50] the impact page lists the server batch set with each relation', async () => {
    renderOffice(`/genealogy/deviations/${impact.deviationId}/impact`, { role: 'QA_REVIEWER' });
    await screen.findByTestId('deviation-impact');
    for (const b of impact.batches) expect(screen.getByTestId(`impact-${b.batchNumber}`).getAttribute('data-relation')).toBe(b.relation);
  });
});

describe('mock-recall cockpit (IN-29)', () => {
  it('[IN-29] QA runs a mock recall from a lot with the authority flag and its reference; the run is sent as chosen', async () => {
    const ui = renderOffice('/recall', { role: 'QA_REVIEWER' });
    const box = await screen.findByTestId('mock-recall-run');
    await userEvent.type(within(box).getByRole('textbox', { name: 'Lot (id)' }), mock.subjectId);
    const button = within(box).getByRole('button', { name: 'Run the mock recall' });
    expect(button.hasAttribute('disabled')).toBe(true);
    await userEvent.click(within(box).getByRole('radio', { name: 'Informed' }));
    expect(within(box).getByRole('button', { name: 'Run the mock recall' }).hasAttribute('disabled')).toBe(true);
    await userEvent.type(within(box).getByRole('textbox', { name: 'Authority reference' }), 'CDSCO/MR/2026/04');
    await userEvent.click(within(box).getByRole('button', { name: 'Run the mock recall' }));
    await waitFor(() => expect(ui.posts('/api/recall/mock-recalls')).toHaveLength(1));
    expect(ui.posts('/api/recall/mock-recalls')[0]?.body).toEqual({ subjectKind: 'LOT', subjectId: mock.subjectId, authorityInformed: true, authorityReference: 'CDSCO/MR/2026/04' });
  });

  it('[IN-29] a production person is not offered the run', async () => {
    renderOffice('/recall', { role: 'OPERATOR' });
    await screen.findByTestId('mock-recalls');
    expect(screen.queryByTestId('mock-recall-run')).toBeNull();
  });

  it('[IN-29][PR-57] a mock recall shows the reconciliation sheet, the consignees and its hash; the AP signs it off through the ceremony (MOCK_RECALL_SIGN_OFF names the run only)', async () => {
    const ui = renderOffice(`/recall/${mock.mockRecallId}`, { role: 'AUTHORISED_PERSON' });
    expect((await screen.findByTestId('mock-recall-state')).getAttribute('data-reproduces')).toBe('true');
    expect(screen.getByTestId('mock-recall-state').textContent).toContain(mock.resultSha256);
    for (const l of mock.lots) expect(screen.getByTestId(`reconcile-${l.lotCode}`).textContent).toContain(`${l.delivered} ${l.unit}`);
    const c = mock.consignees[0]!;
    expect(screen.getByTestId(`consignee-${c.consigneeCode}`).textContent).toContain(c.shipments[0]!.shipmentNo);
    expect(reconciliationRows(mock)).toHaveLength(mock.lots.length + 1);
    await userEvent.click(await within(screen.getByTestId('mock-recall-sign-off')).findByRole('button', { name: 'Sign off the mock recall' }));
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual({ kind: 'MOCK_RECALL_SIGN_OFF', mockRecallId: mock.mockRecallId });
  });

  it('[IN-29] QA is not offered the sign-off; a run that no longer reproduces cannot be signed off; a signed-off run shows its signer', async () => {
    renderOffice(`/recall/${mock.mockRecallId}`, { role: 'QA_REVIEWER' });
    await screen.findByTestId('mock-recall-sign-off');
    expect(within(screen.getByTestId('mock-recall-sign-off')).queryByRole('button')).toBeNull();
    cleanup();
    renderOffice(`/recall/${mock.mockRecallId}`, { role: 'AUTHORISED_PERSON', fixtures: { 'recall.mockRecall': { ...mock, reproduces: false } } });
    expect((await screen.findByTestId('mock-recall-state')).getAttribute('data-reproduces')).toBe('false');
    expect((await within(screen.getByTestId('mock-recall-sign-off')).findByRole('button', { name: 'Sign off the mock recall' })).hasAttribute('disabled')).toBe(true);
    cleanup();
    renderOffice(`/recall/${signed.mockRecallId}`, { role: 'AUTHORISED_PERSON', fixtures: { 'recall.mockRecall': signed } });
    expect((await screen.findByTestId('mock-recall-signed')).textContent).toContain(signed.signOff!.signedBy.legalName);
  });
});

describe('chemical recovery of returned goods (IN-29, PR-48)', () => {
  const r = example('samples-returns').returns[0]!;
  const recoverable = { ...r, assessment: { ...r.assessment!, disposition: 'CHEMICAL_RECOVERY' as const, signed: true } };

  it('[IN-29][PR-48] the stores record the chemical recovery of returns whose signed assessment chose it; the body is what they typed', async () => {
    const ui = renderOffice('/quality/returns', { role: 'STORES_OFFICER', fixtures: { 'samples.returns': { returns: [recoverable] } } });
    const form = await screen.findByTestId(`form-Chemical recovery of ${r.lotCode}`);
    for (const [name, value] of [
      ['Recovered material code', 'API-REC'], ['Recovered material name', 'Recovered paracetamol'], ['Quantity recovered', '40.5'], ['Unit', 'kg'],
      ['Recovery procedure and run', 'SOP-REC-01 run 3'], ['Expiry (UTC, e.g. 2029-01-01T00:00:00Z)', '2029-01-01T00:00:00Z'],
    ] as const) await userEvent.type(within(form).getByRole('textbox', { name: new RegExp(`^${name.replace(/[()]/g, '\\$&')}`) }), value);
    await userEvent.click(within(form).getByRole('button', { name: 'Record the chemical recovery' }));
    await waitFor(() => expect(ui.posts(`/api/quality/returns/${r.lotId}/chemical-recovery`)).toHaveLength(1));
    expect(ui.posts(`/api/quality/returns/${r.lotId}/chemical-recovery`)[0]?.body).toEqual({
      materialCode: 'API-REC', materialName: 'Recovered paracetamol', quantity: '40.5', unit: 'kg', processReference: 'SOP-REC-01 run 3', expiresAt: '2029-01-01T00:00:00Z',
    });
  });

  it('[IN-29] a return assessed for destruction, or not yet signed, offers no recovery', async () => {
    renderOffice('/quality/returns', { role: 'STORES_OFFICER', fixtures: { 'samples.returns': { returns: [r, { ...recoverable, lotId: 'a3000000-0000-4000-8000-0000000000aa', lotCode: 'G-UNSIGNED', assessment: { ...recoverable.assessment, signed: false } }] } } });
    await screen.findByTestId(`return-${r.lotCode}`);
    expect(screen.queryByTestId(`form-Chemical recovery of ${r.lotCode}`)).toBeNull();
    expect(screen.queryByTestId('form-Chemical recovery of G-UNSIGNED')).toBeNull();
  });
});

describe('the recurrence warning on the certification screen (PR-49)', () => {
  it('[PR-49] the third recurrence shows a warning on the certification screen', async () => {
    const ui = renderOffice(`/release/${lot.lotId}`, { role: 'AUTHORISED_PERSON' });
    const warning = await screen.findByTestId('recurrence-warning');
    const item = recurrence.items[0]!;
    const li = within(warning).getByTestId(`recurrence-${item.ref}`);
    expect(li.getAttribute('data-occurrences')).toBe('3');
    expect(li.textContent).toContain('occurrence 3');
    for (const o of item.others) expect(li.textContent).toContain(o.ref);
    expect(ui.requests.some((r) => r.path === `/api/genealogy/lots/${lot.lotId}/recurrence`)).toBe(true);
  });

  it('[PR-49] below the third occurrence no warning is shown', async () => {
    renderOffice(`/release/${lot.lotId}`, { role: 'AUTHORISED_PERSON', fixtures: { 'genealogy.recurrence': example('genealogy-recurrence-quiet') } });
    await screen.findByTestId('release-state');
    await waitFor(() => expect(screen.queryByTestId('recurrence-warning')).toBeNull());
  });
});
