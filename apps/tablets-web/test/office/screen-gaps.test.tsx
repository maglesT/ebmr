/**
 * The screens slice 7g-5 gave the person-facing routes that had none (decision 0025; the 25 routes of defect log
 * 7g1-1): shelf-life bases and hazard classes, another CAPA effectiveness check, one alarm in detail, equipment events and
 * original device records, a room's rules and room adjacency, reagent lots and their use, one label template in detail,
 * a proposed peer installation, the report views and their export, one analytics flag's dispositions, the reference
 * documents, an evidence document and a lot's shipments. Each sends what the person chose and shows the server's answer;
 * a refusal is shown in its words. Answers are the contract's examples unless a test gives its own.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { ANALYTICS_EXAMPLES, EXAMPLES } from '@ebmr/api-contract/examples';
import { apiState } from '../../src/api/client.ts';
import { refusal, renderOffice } from './support.tsx';

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

/** The first example of a route (the fixture the screen is answered with). */
function exampleOf<T = unknown>(routeId: string): T {
  const e = [...Object.values(EXAMPLES), ...Object.values(ANALYTICS_EXAMPLES)].find((x) => 'routeId' in x && x.routeId === routeId);
  if (!e) throw new Error(`no example of ${routeId}`);
  return e.data as T;
}

const at = (us: string, text: string) => ({ us, text });
const T1 = at('1767600000000000', '05 Jan 2026, 13:30 IST');
const PRODUCT_RECORD = '0b8f1c2a-1234-4c7d-8e9f-0a1b2c3d4e31';
const AREA_RECORD = '0b8f1c2a-1235-4c7d-8e9f-0a1b2c3d4e32';

describe('shelf-life bases and hazard classes (india)', () => {
  it('[IN-27][PR-43] QC records a shelf-life basis; QA approves a recorded hazard class and dedication under its own signature', async () => {
    const hazards = routes.india.hazards.response.parse({
      products: [{ recordId: PRODUCT_RECORD, productCode: 'PRD-HORM-1', hazardClass: 'SEX_HORMONE', riskAssessmentRef: 'RA-77', recordedAt: T1, state: 'RECORDED' }],
      areas: [{ recordId: AREA_RECORD, areaCode: 'COMP-2', hazardClass: 'SEX_HORMONE', dedicated: true, breathingAir: 'BACKED_UP', justification: 'hormone campaign suite', recordedAt: T1, state: 'APPROVED' }],
    });
    const india = { 'india.hazards': hazards, 'india.shelfLifeBases': exampleOf('india.shelfLifeBases') };
    const qc = renderOffice('/india/product-rules', { role: 'HEAD_OF_QC', fixtures: india });
    const bases = await screen.findByTestId('shelf-life-bases');
    await userEvent.type(await within(bases).findByRole('textbox', { name: 'Product code' }), 'PRD-001');
    await userEvent.type(within(bases).getByRole('textbox', { name: 'Strength' }), '500 mg');
    await userEvent.type(within(bases).getByRole('textbox', { name: 'Shelf life (months, 1 to 120)' }), '36');
    await userEvent.type(within(bases).getByRole('textbox', { name: 'Stability study reference' }), 'STAB-2026-04');
    await userEvent.click(within(bases).getByRole('radio', { name: 'Tentative (accelerated data)' }));
    await userEvent.click(within(bases).getByRole('button', { name: 'Record the basis' }));
    await waitFor(() => expect(qc.posts('/api/india/shelf-life-bases')).toHaveLength(1));
    expect(qc.posts('/api/india/shelf-life-bases')[0]?.body).toEqual({ productCode: 'PRD-001', strength: '500 mg', shelfLifeMonths: 36, stabilityReference: 'STAB-2026-04', tentative: true });
    // QC is not offered the hazard acts.
    expect(within(screen.getByTestId('hazards')).queryAllByRole('button')).toHaveLength(0);
    cleanup();

    const qa = renderOffice('/india/product-rules', { role: 'QA_REVIEWER', fixtures: india });
    const product = await screen.findByTestId('hazard-product-PRD-HORM-1');
    expect(product.getAttribute('data-state')).toBe('RECORDED');
    // An approved dedication offers no approval.
    expect(within(screen.getByTestId('hazard-area-COMP-2-SEX_HORMONE')).queryAllByRole('button')).toHaveLength(0);
    await userEvent.click(await within(product).findByRole('button', { name: 'Approve the hazard class of PRD-HORM-1' }));
    await waitFor(() => expect(qa.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(qa.ceremony.sign.mock.calls[0]?.[0].action).toEqual({ kind: 'INDIA_ACT', act: 'HAZARD_APPROVE', subjectId: PRODUCT_RECORD });
    const form = screen.getByTestId('hazards');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Room or line code' }), 'COMP-3');
    await userEvent.click(within(within(form).getByRole('radiogroup', { name: 'Class of the room or line' })).getByRole('radio', { name: 'Cytotoxic' }));
    await userEvent.type(within(form).getByRole('textbox', { name: 'Justification' }), 'cytotoxic line');
    await userEvent.click(within(form).getByRole('button', { name: 'Record the dedication' }));
    await waitFor(() => expect(qa.posts('/api/india/hazards')).toHaveLength(1));
    expect(qa.posts('/api/india/hazards')[0]?.body).toEqual({ area: { areaCode: 'COMP-3', hazardClass: 'CYTOTOXIC', dedicated: true, breathingAir: 'NOT_USED', justification: 'cytotoxic line' } });
  });
});

describe('CAPA', () => {
  it('[IN-01] QA schedules another effectiveness check; the due date is the database\'s', async () => {
    const detail = exampleOf<{ capaId: string; origin: string; state: string }>('capa.detail');
    const capa = { ...detail, origin: 'STAND_IN', state: 'IMPLEMENTED' };
    const ui = renderOffice(`/capa/${detail.capaId}`, { role: 'QA_REVIEWER', fixtures: { 'capa.detail': capa } });
    const box = await screen.findByTestId('capa-schedule-check');
    await userEvent.type(within(box).getByRole('textbox', { name: 'What shows the action worked (criteria)' }), 'No recurrence in 3 batches');
    await userEvent.type(within(box).getByRole('textbox', { name: 'Period (days from today, 1 to 1095)' }), '90');
    await userEvent.click(within(box).getByRole('button', { name: 'Schedule the check' }));
    await waitFor(() => expect(ui.posts(`/api/capa/${detail.capaId}/checks`)).toHaveLength(1));
    expect(ui.posts(`/api/capa/${detail.capaId}/checks`)[0]?.body).toEqual({ criteria: 'No recurrence in 3 batches', periodDays: 90 });
  });
});

describe('plant alarms, equipment data, rooms and reagents', () => {
  it('[DI-49] one alarm opens in detail with its configuration, times, batches and acknowledgment', async () => {
    const list = exampleOf<{ alarms: { alarmId: string; alarmCode: string; subject: { code: string } }[] }>('alarms.list');
    const a = list.alarms[0]!;
    const one = exampleOf<{ alarmId: string; receivedAt: { text: string } }>('alarms.alarm');
    const ui = renderOffice('/alarms', { role: 'QA_REVIEWER', fixtures: { 'alarms.alarm': { ...one, alarmId: a.alarmId } } });
    await userEvent.click(await screen.findByRole('button', { name: `Details of ${a.alarmCode} on ${a.subject.code}` }));
    const detail = await screen.findByTestId(`alarm-detail-${a.alarmId}`);
    expect(ui.requests.some((r) => r.method === 'GET' && r.path === `/api/alarms/${a.alarmId}`)).toBe(true);
    expect(detail.textContent).toContain(`received ${one.receivedAt.text}`);
  });

  it('[DI-32] equipment events of a batch and its original device records', async () => {
    const batches = exampleOf<{ batches: { runId: string; batchNumber: string; statusText: string }[] }>('batches.list');
    const b = batches.batches[0]!;
    const ui = renderOffice('/equipment-records', { role: 'QA_REVIEWER' });
    await screen.findByTestId('equipment-events');
    await userEvent.click(await screen.findByRole('radio', { name: `${b.batchNumber} (${b.statusText})` }));
    await waitFor(() => expect(ui.requests.some((r) => r.path === '/api/equipment-data/events' && r.query['batchId'] === b.runId)).toBe(true));
    await screen.findByTestId('equipment-originals');
    await waitFor(() => expect(ui.requests.some((r) => r.path === `/api/equipment-data/batches/${b.runId}/originals`)).toBe(true));
    await userEvent.type(screen.getByRole('textbox', { name: 'Unit code (optional)' }), 'press-1');
    await waitFor(() => expect(ui.requests.some((r) => r.path === '/api/equipment-data/events' && r.query['equipmentCode'] === 'PRESS-1')).toBe(true));
  });

  it('[PR-15][PR-25][PR-35] the master-data steward saves a room\'s rules and records an adjacency; a refusal is shown in the database\'s words', async () => {
    const rooms = exampleOf<{ rooms: { code: string; name: string }[] }>('plantRules.rooms');
    const r = rooms.rooms[0]!;
    const ui = renderOffice('/rooms', {
      role: 'MASTER_DATA_STEWARD',
      fixtures: { 'plantRules.defineAdjacency': () => refusal('EBMR-PLANT-951', 'A segregation needs its justification.') },
    });
    await userEvent.click(await screen.findByRole('button', { name: `${r.code} ${r.name}` }));
    const rule = await screen.findByTestId('room-rule');
    await userEvent.click(within(rule).getByRole('radio', { name: 'Controlled' }));
    const hold = within(rule).getByRole('textbox', { name: /^Clean-hold time in seconds/ });
    await userEvent.clear(hold);
    await userEvent.type(hold, '259200');
    await userEvent.type(within(rule).getByRole('textbox', { name: 'Reason for the change' }), 'validated hold study');
    await userEvent.click(within(rule).getByRole('button', { name: `Save the rules of ${r.code}` }));
    await waitFor(() => expect(ui.posts(`/api/plant-rules/rooms/${r.code}/rule`)).toHaveLength(1));
    expect(ui.posts(`/api/plant-rules/rooms/${r.code}/rule`)[0]?.body).toEqual({ authorisationRequired: true, cleanHoldSeconds: '259200', reason: 'validated hold study' });
    const adj = screen.getByTestId('adjacencies');
    await userEvent.type(within(adj).getByRole('textbox', { name: 'First room or line' }), 'pl-1');
    await userEvent.type(within(adj).getByRole('textbox', { name: 'Second room or line' }), 'pl-2');
    await userEvent.click(within(adj).getByRole('button', { name: 'Record the adjacency' }));
    await waitFor(() => expect(ui.posts('/api/plant-rules/adjacencies')).toHaveLength(1));
    expect(ui.posts('/api/plant-rules/adjacencies')[0]?.body).toEqual({ one: 'PL-1', two: 'PL-2', adjacent: true, segregated: false });
    expect(await within(adj).findByText('A segregation needs its justification.')).toBeTruthy();
  });

  it('[PR-15] a QA reviewer is offered neither a room rule nor an adjacency', async () => {
    const rooms = exampleOf<{ rooms: { code: string; name: string }[] }>('plantRules.rooms');
    const r = rooms.rooms[0]!;
    renderOffice('/rooms', { role: 'QA_REVIEWER' });
    await userEvent.click(await screen.findByRole('button', { name: `${r.code} ${r.name}` }));
    await screen.findByTestId('room-conditions');
    expect(screen.queryByTestId('room-rule')).toBeNull();
    expect(within(screen.getByTestId('adjacencies')).queryAllByRole('button')).toHaveLength(0);
  });

  it('[PR-29] QC records and withdraws a reagent lot; the floor records the lot a check used, refused by the database when expired', async () => {
    const lots = exampleOf<{ lots: { lotCode: string; state: string }[] }>('plantRules.reagentLots');
    const inDate = lots.lots.find((l) => l.state === 'IN_DATE');
    const qc = renderOffice('/reagent-lots', { role: 'QC_ANALYST' });
    const form = await screen.findByTestId('reagent-lot-record');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Lot code' }), 'BUF-7-26');
    await userEvent.click(within(form).getByRole('radio', { name: 'Buffer' }));
    await userEvent.type(within(form).getByRole('textbox', { name: 'Reagent code' }), 'PH7');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Name' }), 'pH 7 buffer');
    await userEvent.type(within(form).getByRole('textbox', { name: /^Prepared at/ }), '2026-10-18T09:00:00+05:30');
    await userEvent.type(within(form).getByRole('textbox', { name: /^Expires at/ }), '2026-11-18T09:00:00+05:30');
    await userEvent.click(within(form).getByRole('button', { name: 'Record the lot' }));
    await waitFor(() => expect(qc.posts('/api/plant-rules/reagent-lots')).toHaveLength(1));
    expect(qc.posts('/api/plant-rules/reagent-lots')[0]?.body).toEqual({ lotCode: 'BUF-7-26', kind: 'BUFFER', reagentCode: 'PH7', name: 'pH 7 buffer', preparedAt: '2026-10-18T09:00:00+05:30', expiresAt: '2026-11-18T09:00:00+05:30' });
    if (inDate) {
      const lot = screen.getByTestId(`reagent-lot-${inDate.lotCode}`);
      await userEvent.type(within(lot).getByRole('textbox', { name: `Reason to withdraw ${inDate.lotCode}` }), 'contaminated');
      await userEvent.click(within(lot).getByRole('button', { name: `Withdraw ${inDate.lotCode}` }));
      await waitFor(() => expect(qc.posts(`/api/plant-rules/reagent-lots/${encodeURIComponent(inDate.lotCode)}/withdraw`)).toHaveLength(1));
    }
    cleanup();

    const batches = exampleOf<{ batches: { runId: string; batchNumber: string; statusText: string }[] }>('batches.list');
    const b = batches.batches[0]!;
    const op = renderOffice('/reagent-lots', { role: 'OPERATOR', fixtures: { 'plantRules.recordReagentUse': () => refusal('EBMR-PLANT-962', 'The lot BUF-1 expired on 01 Oct 2026; it cannot be used.') } });
    expect(screen.queryByTestId('reagent-lot-record')).toBeNull();
    const use = await screen.findByTestId('reagent-use');
    await userEvent.click(await within(use).findByRole('radio', { name: `${b.batchNumber} (${b.statusText})` }));
    await userEvent.type(within(use).getByRole('textbox', { name: /^Step/ }), 'p-ipc-1@');
    await userEvent.type(within(use).getByRole('textbox', { name: 'Lot code' }), 'BUF-1');
    await userEvent.type(within(use).getByRole('textbox', { name: /^Purpose/ }), 'pH meter calibration');
    await userEvent.click(within(use).getByRole('button', { name: 'Record the use' }));
    await waitFor(() => expect(op.posts('/api/plant-rules/reagent-uses')).toHaveLength(1));
    expect(op.posts('/api/plant-rules/reagent-uses')[0]?.body).toEqual({ batchId: b.runId, step: 'p-ipc-1@', lotCode: 'BUF-1', purpose: 'pH meter calibration' });
    expect(await within(use).findByText('The lot BUF-1 expired on 01 Oct 2026; it cannot be used.')).toBeTruthy();
  });
});

describe('labels, transfers, dashboards and analytics', () => {
  it('[IN-31] one label template version opens with its size and the place of each record field', async () => {
    const list = exampleOf<{ templates: { templateId: string; ref: string }[] }>('labels.templates');
    const t = list.templates[0]!;
    const ui = renderOffice('/labels/templates', { role: 'QA_REVIEWER' });
    const detail = await screen.findByTestId(`label-template-detail-${t.ref}`);
    expect(ui.requests.some((r) => r.path === `/api/labels/templates/${t.templateId}`)).toBe(false);
    await userEvent.click(within(detail).getByText(`Layout of ${t.ref}`));
    await waitFor(() => expect(ui.requests.some((r) => r.path === `/api/labels/templates/${t.templateId}`)).toBe(true));
    expect(await within(detail).findByRole('columnheader', { name: 'Record field' })).toBeTruthy();
  });

  it('[DI-31] the system administrator proposes a peer installation; QA approves its key later', async () => {
    const ui = renderOffice('/transfers', { role: 'SYSTEM_ADMINISTRATOR' });
    const form = await screen.findByTestId('peer-propose');
    await userEvent.type(within(form).getByRole('textbox', { name: /^Installation code/ }), 'goa-tab-gmp');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Site code' }), 'goa');
    await userEvent.type(within(form).getByRole('textbox', { name: /^Base URL/ }), 'https://goa.example.internal');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Public key (Ed25519, base64)' }), `${'A'.repeat(43)}=`);
    await userEvent.click(within(form).getByRole('button', { name: 'Propose the installation' }));
    await waitFor(() => expect(ui.posts('/api/transfers/peers')).toHaveLength(1));
    expect(ui.posts('/api/transfers/peers')[0]?.body).toEqual({ installationCode: 'GOA-TAB-GMP', siteCode: 'GOA', edition: 'TABLETS', baseUrl: 'https://goa.example.internal', publicKey: `${'A'.repeat(43)}=` });
    cleanup();
    renderOffice('/transfers', { role: 'QA_REVIEWER' });
    await screen.findByTestId('transfer-peers');
    expect(screen.queryByTestId('peer-propose')).toBeNull();
  });

  it('[DI-08] a report view is exported with the server\'s SHA-256, and the download is the text that hash covers', async () => {
    const catalog = exampleOf<{ views: { viewName: string }[] }>('dashboards.catalog');
    const exported = exampleOf<{ viewName: string; columns: string[]; rows: (string | null)[][]; sha256: string }>('dashboards.export');
    const v = catalog.views[0]!;
    const ui = renderOffice('/dashboards', { role: 'QA_REVIEWER' });
    await userEvent.click(await screen.findByRole('button', { name: `Export ${v.viewName}` }));
    const box = await screen.findByTestId('report-export');
    await waitFor(() => expect(ui.requests.some((r) => r.path === '/api/dashboards/export' && r.query['view'] === v.viewName)).toBe(true));
    expect((await within(box).findByTestId('report-export-sha256')).textContent).toBe(exported.sha256);
    const link = within(box).getByRole('link', { name: 'Download the export' });
    expect(decodeURIComponent((link.getAttribute('href') ?? '').replace(/^data:application\/json;charset=utf-8,/, ''))).toBe(JSON.stringify({ view: exported.viewName, columns: exported.columns, rows: exported.rows }));
  });

  it('[DI-52] one analytics flag opens with every disposition it had', async () => {
    const flags = exampleOf<{ flags: { flagId: string }[] }>('analytics.flags');
    const f = flags.flags[0]!;
    const ui = renderOffice('/analytics/flags', { role: 'QA_REVIEWER' });
    const history = await screen.findByTestId(`analytics-flag-${f.flagId}-history`);
    await userEvent.click(within(history).getByText('Every disposition of this flag'));
    await waitFor(() => expect(ui.requests.some((r) => r.path === `/api/analytics/flags/${f.flagId}`)).toBe(true));
  });
});

describe('master records, quality and release', () => {
  it('[DI-07] the master records library lists the reference documents with version, status and content hash', async () => {
    const docs = { documents: [{ refId: 'r1', code: 'SOP-QA-001', kind: 'SOP', title: 'Line clearance', version: '3', hash: 'ab'.repeat(32), status: 'EFFECTIVE' }] };
    renderOffice('/mbr', { role: 'MBR_AUTHOR', fixtures: { 'designer.referenceDocuments': docs } });
    const row = await screen.findByTestId('reference-document-SOP-QA-001');
    expect(row.textContent).toContain('Line clearance');
    expect(row.textContent).toContain('ab'.repeat(32));
  });

  it('[IN-02] an evidence document is stored with its bytes; the database\'s SHA-256, size and id are shown', async () => {
    const stored = exampleOf<{ documentId: string; sha256: string }>('quality.registerEvidenceDocument');
    const ui = renderOffice('/quality/deviations', { role: 'QA_REVIEWER' });
    const box = await screen.findByTestId('evidence-document');
    await userEvent.type(within(box).getByRole('textbox', { name: 'Title' }), 'Investigation report DV-26-001');
    const file = new File(['root cause: worn punch'], 'report.txt', { type: 'text/plain' });
    await userEvent.upload(within(box).getByLabelText('Document (at most 4 MB)'), file);
    await userEvent.click(within(box).getByRole('button', { name: 'Store the document' }));
    await waitFor(() => expect(ui.posts('/api/quality/evidence-documents')).toHaveLength(1));
    expect(ui.posts('/api/quality/evidence-documents')[0]?.body).toEqual({ title: 'Investigation report DV-26-001', mediaType: 'text/plain', contentBase64: Buffer.from('root cause: worn punch').toString('base64') });
    expect((await within(box).findByTestId('evidence-document-stored')).textContent).toContain(stored.sha256);
  });

  it('[IN-02] a file of a type the database does not store is not sent', async () => {
    const ui = renderOffice('/quality/deviations', { role: 'QA_REVIEWER' });
    const box = await screen.findByTestId('evidence-document');
    await userEvent.type(within(box).getByRole('textbox', { name: 'Title' }), 'Spreadsheet');
    await userEvent.upload(within(box).getByLabelText('Document (at most 4 MB)'), new File(['x'], 'x.xlsx', { type: 'application/vnd.ms-excel' }), { applyAccept: false });
    expect(within(box).getByRole('alert').textContent).toContain('cannot be stored');
    expect(within(box).getByRole('button', { name: 'Store the document' }).hasAttribute('disabled')).toBe(true);
    expect(ui.posts('/api/quality/evidence-documents')).toHaveLength(0);
  });

  it('[INV-42] the After release tab lists the lot\'s shipments with the states the interlock saw', async () => {
    const after = exampleOf<{ lotId: string }>('release.afterRelease');
    const shipments = exampleOf<{ shipments: { shipmentNo: string; consigneeName: string }[] }>('erpShipping.lot');
    const ui = renderOffice(`/release/${after.lotId}?tab=AFTER`, { role: 'AUTHORISED_PERSON', fixtures: { 'erpShipping.lot': shipments } });
    const s = shipments.shipments[0];
    const section = await screen.findByTestId('lot-shipments');
    await waitFor(() => expect(ui.requests.some((r) => r.path === `/api/erp/lots/${after.lotId}/shipments`)).toBe(true));
    if (s) expect((await within(section).findByTestId(`shipment-${s.shipmentNo}`)).textContent).toContain(s.consigneeName);
  });
});
