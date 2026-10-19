/**
 * The material, reprocessing and batch-number screens of Phase 7 slice 7g, WP4 (decision 0025: every act has a screen):
 * a lot's witnessed destruction (record, the witness's LOT_DESTRUCTION_WITNESS signature, the performer's destroy), its
 * reservations and stock-location exceptions, the OOS record of an approved failing result, the vendor-history routes,
 * the reprocessing proposals, the plan of a reprocessing batch with its authorised request, and the batch-number
 * register. What is sent is the person's input; what is signed is the server's; the screens show the server's answers.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { BatchNumberView, LotHandlingView, LotResultView, ReprocessingRequestView, VendorRouteView } from '@ebmr/api-contract';
import { example } from '@ebmr/api-contract/examples';
import { apiState } from '../../src/api/client.ts';
import { renderOffice } from '../office/support.tsx';

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

const at = (text: string) => ({ us: '1792300000000000', text });
const person = (legalName: string, loginName: string, role: string) => ({ personId: '7a1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e11', legalName, loginName, role });
const STORES = person('Manoj Pillai', 'manoj.pillai', 'WAREHOUSE');
const WITNESS = person('Kavya Reddy', 'kavya.reddy', 'WITNESS');
const base = example('quality-lots').lots[0];
if (!base) throw new Error('no lot example');
const rejected = { ...base, status: 'REJECTED' };
const lots = { lots: [rejected] };
const lotPath = `/quality/lots/${rejected.lotId}`;
const empty: LotHandlingView = { lotId: rejected.lotId, destruction: null, witness: null, reservations: [], locationExceptions: [] };
const recorded: LotHandlingView = {
  ...empty,
  destruction: { destructionId: '1d1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e', method: 'Incineration', reason: 'Rejected lot', quantity: rejected.quantity, unit: rejected.unit, performedBy: STORES, recordedAt: at('18-OCT-2026 10:00') },
};
const witnessed: LotHandlingView = { ...recorded, witness: { signatureId: '2d1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e', signedBy: WITNESS } };

describe('the witnessed destruction of a lot', () => {
  it('[IN-24] stores record the destruction with its method and reason; the witness signs LOT_DESTRUCTION_WITNESS; the performer destroys the lot with the witness\'s signature', async () => {
    let handling = empty;
    const ui = renderOffice(lotPath, {
      role: 'WAREHOUSE_LABELLING',
      fixtures: { 'quality.lots': lots, 'quality.lotResults': { results: [] }, 'quality.lotHandling': () => handling, 'quality.recordLotDestruction': () => (handling = recorded), 'quality.destroyLot': () => handling },
    });
    const section = await screen.findByTestId('lot-destruction');
    await userEvent.type(within(section).getByRole('textbox', { name: 'Method of destruction' }), 'Incineration');
    await userEvent.type(within(section).getByRole('textbox', { name: 'Reason' }), 'Rejected lot');
    await userEvent.click(within(section).getByRole('button', { name: 'Record the destruction (you perform it)' }));
    await waitFor(() => expect(ui.posts(`/api/lots/${rejected.lotId}/destruction`)).toHaveLength(1));
    expect(ui.posts(`/api/lots/${rejected.lotId}/destruction`)[0]?.body).toEqual({ method: 'Incineration', reason: 'Rejected lot' });
    expect((await screen.findByTestId('destruction-record')).textContent).toContain('recorded by Manoj Pillai');
    await userEvent.click(within(screen.getByTestId('lot-destruction')).getByRole('button', { name: 'Sign as the witness of the destruction' }));
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual({ kind: 'LOT_DESTRUCTION_WITNESS', lotId: rejected.lotId });
    handling = witnessed;
    cleanup();
    const ui2 = renderOffice(lotPath, { role: 'WAREHOUSE_LABELLING', fixtures: { 'quality.lots': lots, 'quality.lotResults': { results: [] }, 'quality.lotHandling': () => handling, 'quality.destroyLot': () => handling } });
    expect((await screen.findByTestId('destruction-witness')).textContent).toContain('Kavya Reddy');
    await userEvent.click(within(screen.getByTestId('lot-destruction')).getByRole('button', { name: 'Destroy the lot (the performer, with the witness\'s signature)' }));
    await waitFor(() => expect(ui2.posts(`/api/lots/${rejected.lotId}/destroy`)).toHaveLength(1));
    expect(ui2.posts(`/api/lots/${rejected.lotId}/destroy`)[0]?.body).toEqual({ expectedVersion: rejected.version, witnessSignatureId: '2d1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e' });
  });
});

describe('a lot\'s reservations and stock-location exceptions', () => {
  const reservation = { reservationId: '3d1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e', batchNumber: 'B26-0007', quantity: '5', unit: 'kg', expiresAt: at('17-NOV-2026'), reservedBy: STORES, reservedAt: at('18-OCT-2026 09:00'), revoked: null };
  const exception = { exceptionId: '4d1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e', problem: 'Moved to released stock while in quarantine', raisedAt: at('18-OCT-2026 08:00'), resolved: null };
  const handling: LotHandlingView = { ...empty, reservations: [reservation], locationExceptions: [exception] };

  it('[DI-22] stores cancel an open reservation with their own reason', async () => {
    const ui = renderOffice(lotPath, { role: 'WAREHOUSE_LABELLING', fixtures: { 'quality.lots': { lots: [base] }, 'quality.lotResults': { results: [] }, 'quality.lotHandling': handling, 'quality.cancelReservation': handling } });
    const section = await screen.findByTestId('lot-reservations');
    await userEvent.click(within(section).getByRole('radio', { name: 'B26-0007: 5 kg' }));
    const cancel = within(section).getByRole('button', { name: 'Cancel the reservation' });
    expect(cancel.hasAttribute('disabled')).toBe(true);
    await userEvent.type(within(section).getByRole('textbox', { name: 'Your reason' }), 'Batch cancelled by planning');
    await userEvent.click(cancel);
    await waitFor(() => expect(ui.posts(`/api/quality/reservations/${reservation.reservationId}/cancel`)).toHaveLength(1));
    expect(ui.posts(`/api/quality/reservations/${reservation.reservationId}/cancel`)[0]?.body).toEqual({ reason: 'Batch cancelled by planning' });
  });

  it('[PR-46] QA closes a stock-location exception with the deviation linked to the lot and what was done', async () => {
    const ui = renderOffice(lotPath, { role: 'QA_REVIEWER', fixtures: { 'quality.lots': { lots: [base] }, 'quality.lotResults': { results: [] }, 'quality.lotHandling': handling, 'quality.resolveLotLocationException': handling } });
    const row = await screen.findByTestId(`location-exception-${exception.exceptionId}`);
    expect(row.textContent).toContain('open: the lot is blocked');
    await userEvent.type(within(row).getByRole('textbox', { name: 'Deviation linked to the lot (id)' }), '5d1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e');
    await userEvent.type(within(row).getByRole('textbox', { name: 'What was done' }), 'Pallet returned to quarantine');
    await userEvent.click(within(row).getByRole('button', { name: 'Close the exception' }));
    await waitFor(() => expect(ui.posts(`/api/quality/location-exceptions/${exception.exceptionId}/resolve`)).toHaveLength(1));
    expect(ui.posts(`/api/quality/location-exceptions/${exception.exceptionId}/resolve`)[0]?.body).toEqual({ deviationId: '5d1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e', note: 'Pallet returned to quarantine' });
  });
});

describe('the OOS record of an approved failing result', () => {
  it('[IN-20] raising the OOS record of an approved failing result links it to the lot and names it on the result', async () => {
    const result: LotResultView = { resultId: '6d1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e', testCode: 'ASSAY', purpose: 'RELEASE', value: '91.0', unit: '%', lowerLimit: '98.0', upperLimit: '102.0', verdict: 'FAIL', state: 'APPROVED' };
    const dev = example('quality-deviations').deviations[0];
    const ui = renderOffice(lotPath, {
      role: 'QC_ANALYST',
      fixtures: { 'quality.lots': { lots: [base] }, 'quality.lotResults': { results: [result] }, 'quality.lotHandling': empty, 'quality.raiseDeviation': dev, 'quality.linkDeviation': dev, 'quality.linkLotTestOos': { resultId: result.resultId, deviationId: dev?.deviationId } },
    });
    const row = await screen.findByTestId('result-ASSAY-RELEASE');
    await userEvent.click(within(row).getByRole('button', { name: 'Raise an OOS record for ASSAY' }));
    await waitFor(() => expect(ui.posts(`/api/quality/lot-results/${result.resultId}/oos`)).toHaveLength(1));
    expect(ui.posts(`/api/quality/lot-results/${result.resultId}/oos`)[0]?.body).toEqual({ deviationId: dev?.deviationId });
    expect(await within(row).findByText(/raised and linked to the lot/)).toBeTruthy();
  });
});

describe('the vendor-history routes', () => {
  it('[IN-24] lists the routes with their state and QA disables an enabled one with the reason', async () => {
    const route: VendorRouteView = {
      routeId: '7d1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e', siteCode: 'SITE-1', materialCode: 'MAT-MCC', justification: 'Twenty consecutive lots passed full testing', statisticalReference: 'STAT-2026-07',
      proposedBy: person('Divya Menon', 'divya.menon', 'QA'), proposedAt: at('01-OCT-2026'), enabled: { by: person('Divya Menon', 'divya.menon', 'QA'), at: at('02-OCT-2026') }, disabled: null,
    };
    const ui = renderOffice('/quality/vendor-routes', { role: 'QA_REVIEWER', fixtures: { 'quality.vendorRoutes': { routes: [route] }, 'quality.disableVendorRoute': route } });
    const row = await screen.findByTestId('vendor-route-MAT-MCC');
    expect(row.textContent).toContain('enabled by Divya Menon');
    await userEvent.type(within(row).getByRole('textbox', { name: 'Reason to disable the route of MAT-MCC' }), 'A lot failed its full test');
    await userEvent.click(within(row).getByRole('button', { name: 'Disable the route of MAT-MCC' }));
    await waitFor(() => expect(ui.posts(`/api/quality/vendor-routes/${route.routeId}/disable`)).toHaveLength(1));
    expect(ui.posts(`/api/quality/vendor-routes/${route.routeId}/disable`)[0]?.body).toEqual({ reason: 'A lot failed its full test' });
  });
});

describe('the reprocessing proposals and the plan of a reprocessing batch', () => {
  it('[IN-19] QA asks for the authorisation of a reprocessing step with the investigation and the risk evaluation', async () => {
    const ui = renderOffice('/quality/reprocessing', { role: 'QA_SHOP_FLOOR', fixtures: { 'quality.proposeReprocessingAuthorisation': { authorisationId: '8d1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e' } } });
    const form = await screen.findByTestId('form-Ask for the authorisation of a reprocessing or recovery step');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Batch (id)' }), '9d1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Step of the MBR (a G-24 or TB-08 step that declares its case)' }), 'p-tb08');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Investigation' }), 'DEV-2026-0007');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Risk evaluation' }), 'RA-2026-031');
    await userEvent.click(within(form).getByRole('button', { name: 'Ask for the authorisation' }));
    await waitFor(() => expect(ui.posts('/api/quality/reprocessing/authorisations')).toHaveLength(1));
    expect(ui.posts('/api/quality/reprocessing/authorisations')[0]?.body).toEqual({ batchId: '9d1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e', step: 'p-tb08', investigationRef: 'DEV-2026-0007', riskEvaluationRef: 'RA-2026-031' });
  });

  it('[PR-47] the planner asks for a whole-batch reprocessing naming its parents, the investigation and the risk evaluation', async () => {
    const ui = renderOffice('/quality/reprocessing', { role: 'BATCH_ISSUER', fixtures: { 'quality.proposeReprocessingRequest': { requestId: 'ad1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e' } } });
    const form = await screen.findByTestId('propose-reprocessing-request');
    await userEvent.type(within(form).getByRole('textbox', { name: 'REPROCESSING master (family id)' }), 'bd1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Site' }), 'SITE-1');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Parent batches (ids, separated by commas)' }), 'cd1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e, dd1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Concluded investigation' }), 'DEV-2026-0007');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Stored risk evaluation (document id)' }), 'ed1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e');
    await userEvent.click(within(form).getByRole('button', { name: 'Ask for the reprocessing' }));
    await waitFor(() => expect(ui.posts('/api/quality/reprocessing/requests')).toHaveLength(1));
    expect(ui.posts('/api/quality/reprocessing/requests')[0]?.body).toEqual({
      familyId: 'bd1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e', site: 'SITE-1', parentBatchIds: ['cd1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e', 'dd1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e'],
      investigationRef: 'DEV-2026-0007', riskEvaluationId: 'ed1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e',
    });
  });

  it('[PR-47] a REPROCESSING master is planned only with an authorised request of its master, which the plan names', async () => {
    const orders = structuredClone(example('planning-orders'));
    const order = orders.orders[0];
    if (!order?.match) throw new Error('no matched order example');
    order.match.recordKind = 'REPROCESSING';
    const requests = structuredClone(example('quality-reprocessing-requests'));
    const authorised: ReprocessingRequestView = { ...(requests.requests[0] as ReprocessingRequestView), familyId: order.match.familyId, authorisedBy: person('Shalini Kapoor', 'shalini.kapoor', 'AUTHORISED_PERSON'), authorisedAt: at('18-OCT-2026') };
    const ui = renderOffice('/planning', { role: 'BATCH_ISSUER', fixtures: { 'planning.orders': orders, 'quality.reprocessingRequests': { requests: [authorised] }, 'plant.areas': { areas: [] } } });
    const form = await screen.findByTestId('plan-form');
    const plan = within(form).getByRole('button', { name: `Plan a batch for ${order.orderNo}` });
    await userEvent.type(within(form).getByRole('textbox', { name: 'Line' }), 'L1');
    expect(plan.hasAttribute('disabled')).toBe(true);
    await userEvent.click(await within(form).findByRole('radio', { name: new RegExp(authorised.investigationRef) }));
    await userEvent.click(plan);
    await waitFor(() => expect(ui.posts('/api/batches')).toHaveLength(1));
    expect(ui.posts('/api/batches')[0]?.body).toMatchObject({ familyId: order.match.familyId, reprocessingRequest: authorised.requestId });
  });
});

describe('the batch-number register', () => {
  const allocated: BatchNumberView = example('planning-batch-numbers').numbers[0] as BatchNumberView;

  it('[IN-18] lists the numbers with their status, registers an external number as typed and voids a number with a reason code and text', async () => {
    const ui = renderOffice('/planning/batch-numbers', { role: 'BATCH_ISSUER' });
    expect((await screen.findByTestId('number-B26-0002')).getAttribute('data-status')).toBe('VOIDED');
    const row = screen.getByTestId(`number-${allocated.batchNumber}`);
    await userEvent.click(within(row).getByRole('button', { name: `Void ${allocated.batchNumber}` }));
    await userEvent.type(within(row).getByRole('textbox', { name: 'Reason code (e.g. ORDER_CANCELLED)' }), 'ORDER_CANCELLED');
    await userEvent.type(within(row).getByRole('textbox', { name: 'Reason' }), 'The ERP order was cancelled');
    await userEvent.click(within(row).getByRole('button', { name: `Void ${allocated.batchNumber} for good` }));
    await waitFor(() => expect(ui.posts(`/api/planning/batch-numbers/${allocated.allocationId}/void`)).toHaveLength(1));
    expect(ui.posts(`/api/planning/batch-numbers/${allocated.allocationId}/void`)[0]?.body).toEqual({ reasonCode: 'ORDER_CANCELLED', reasonText: 'The ERP order was cancelled' });
    const form = screen.getByTestId('form-External batch number');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Batch number' }), 'EXT-0042');
    await userEvent.click(within(form).getByRole('radio', { name: 'PROCESSING' }));
    await userEvent.type(within(form).getByRole('textbox', { name: 'External reference (e.g. the ERP order)' }), 'SAP-PO-4711');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Product code' }), 'PCM-500');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Product name' }), 'Paracetamol tablets 500 mg');
    await userEvent.click(within(form).getByRole('radio', { name: 'TABLETS' }));
    await userEvent.type(within(form).getByRole('textbox', { name: 'Batch size' }), '100000');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Batch size unit (e.g. {tbl}, kg)' }), 'kg');
    await userEvent.click(within(form).getByRole('button', { name: 'Register the number' }));
    await waitFor(() => expect(ui.posts('/api/planning/batch-numbers/external')).toHaveLength(1));
    expect(ui.posts('/api/planning/batch-numbers/external')[0]?.body).toEqual({
      batchNumber: 'EXT-0042', batchKind: 'PROCESSING', externalReference: 'SAP-PO-4711', productCode: 'PCM-500', productName: 'Paracetamol tablets 500 mg', edition: 'TABLETS', batchSize: '100000', batchSizeUnit: 'kg',
    });
  });
});
