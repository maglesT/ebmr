/**
 * The records register screens (Phase 7 slice 7g-3, WP1) on test answers: record types defined and approved with a
 * signature; a record's retention, a legal hold placed and released with the reason, and the signed approval of its
 * disposal; data-integrity investigations opened, linked, read again and closed with a signature.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { apiState } from '../../src/api/client.ts';
import { at, renderValidation } from './support.tsx';

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

const ID = '6b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e';
const HOLD = 'c0ffee00-1234-4abc-8def-0123456789ab';
const PERSON = 'a9b8c7d6-e5f4-4a3b-8c2d-1e0f9a8b7c6d';

const type = (state: 'DEFINED' | 'APPROVED') => ({
  code: 'CLEANING_LOG', version: '2', title: 'Cleaning log', description: 'Cleaning between batches', dataClass: 'RAW', gmpCriticality: 'HIGH', officialMedium: 'ELECTRONIC',
  retentionKey: 'SUPPORTING_RECORD', feedsAcceptanceLimit: false, state, definedBy: 'Kavya Iyer', definedAt: at('1760000000000001'), approvedBy: state === 'APPROVED' ? 'Ravi Kumar' : null,
});

describe('record types', () => {
  it('[DI-37] a defined version is approved with a signature of exactly that version', async () => {
    const ui = renderValidation('/validation/record-types', { fixtures: { 'validation.recordTypes': { recordTypes: [type('DEFINED')] } } });
    const row = await screen.findByTestId('record-type-CLEANING_LOG-2');
    expect(row.getAttribute('data-state')).toBe('DEFINED');
    await userEvent.click(within(row).getByRole('button', { name: 'Approve CLEANING_LOG v2 (signature)' }));
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual({ kind: 'RECORDS_ACT', act: 'RECORD_TYPE_APPROVE', input: { code: 'CLEANING_LOG', version: '2' } });
  });

  it('a record type is defined with every field the register needs and the reason', async () => {
    const ui = renderValidation('/validation/record-types', { fixtures: { 'validation.recordTypes': { recordTypes: [type('APPROVED')] }, 'validation.defineRecordType': type('DEFINED') } });
    const box = await screen.findByTestId('define-record-type');
    const fill = async (label: string, text: string) => userEvent.type(within(box).getByRole('textbox', { name: label }), text);
    await fill('Code (e.g. CLEANING_LOG)', 'CLEANING_LOG');
    await fill('Title', 'Cleaning log');
    await fill('Description', 'Cleaning between batches');
    await fill('Original and copies', 'Electronic original');
    await fill('Storage location', 'eBMR database');
    await fill('Owning module', 'plant');
    await fill('Owner role', 'HEAD_OF_PRODUCTION');
    await fill('Review rule', 'With the batch record');
    const button = within(box).getByRole('button', { name: 'Define the record type' });
    expect(button.hasAttribute('disabled')).toBe(true);
    await fill('Reason', 'second version');
    await userEvent.click(button);
    await waitFor(() => expect(ui.posts('/api/validation/record-types')).toHaveLength(1));
    expect(ui.posts('/api/validation/record-types')[0]?.body).toEqual({
      definition: {
        code: 'CLEANING_LOG', title: 'Cleaning log', description: 'Cleaning between batches', officialRecord: true, dataClass: 'RAW', gmpCriticality: 'HIGH', officialMedium: 'ELECTRONIC',
        originalAndCopies: 'Electronic original', storageLocation: 'eBMR database', owningModule: 'plant', ownerRole: 'HEAD_OF_PRODUCTION', retentionKey: 'SUPPORTING_RECORD',
        reviewRule: 'With the batch record', feedsAcceptanceLimit: false,
      },
      reason: 'second version',
    });
  });
});

describe('retention, holds and disposal', () => {
  const retention = { recordKey: `batch:${ID}`, aggregateType: 'batch', aggregateId: ID, scheduled: true, retainUntil: '2015-01-31', status: 'DATED', onHold: false, purged: false, refusals: [], blockers: [] };
  const hold = { holdId: HOLD, recordKey: `batch:${ID}`, kind: 'LEGAL', reason: 'litigation hold', reference: 'CASE-7', placedBy: 'Divya Menon', at: at('1760000000000002') };

  it('[DI-47] a record\'s retention is shown; a legal hold is placed with the reason and a hold in force is released with one', async () => {
    const ui = renderValidation('/validation/retention', { fixtures: { 'validation.retention': retention, 'validation.legalHolds': { holds: [hold] }, 'validation.placeLegalHold': hold, 'validation.releaseLegalHold': { holds: [] } } });
    await userEvent.type(await screen.findByRole('textbox', { name: 'Record type (e.g. batch)' }), 'batch');
    await userEvent.type(screen.getByRole('textbox', { name: 'Record id' }), ID);
    await userEvent.click(screen.getByRole('button', { name: 'Show its retention' }));
    expect((await screen.findByTestId('retention-status')).textContent).toBe('Kept until 2015-01-31.');
    expect(ui.gets('/api/validation/retention')[0]?.query).toEqual({ aggregateType: 'batch', aggregateId: ID });
    await userEvent.type(screen.getByRole('textbox', { name: 'Reason for the hold' }), 'litigation hold');
    await userEvent.type(screen.getByRole('textbox', { name: 'Reference (optional, e.g. the legal case)' }), 'CASE-7');
    await userEvent.click(screen.getByRole('button', { name: 'Place the legal hold' }));
    await waitFor(() => expect(ui.posts('/api/validation/legal-holds')).toHaveLength(1));
    expect(ui.posts('/api/validation/legal-holds')[0]?.body).toEqual({ aggregateType: 'batch', aggregateId: ID, reason: 'litigation hold', reference: 'CASE-7' });
    const row = screen.getByTestId(`hold-${HOLD}`);
    await userEvent.type(within(row).getByRole('textbox', { name: 'Reason for the release' }), 'case closed');
    await userEvent.click(within(row).getByRole('button', { name: 'Release the hold' }));
    await waitFor(() => expect(ui.posts(`/api/validation/legal-holds/${HOLD}/release`)).toHaveLength(1));
    expect(ui.posts(`/api/validation/legal-holds/${HOLD}/release`)[0]?.body).toEqual({ reason: 'case closed' });
  });

  it('[DI-47][DI-37] the disposal is approved with a signature naming the record and the reason', async () => {
    const ui = renderValidation('/validation/retention', { fixtures: { 'validation.retention': retention, 'validation.legalHolds': { holds: [] } } });
    await userEvent.type(await screen.findByRole('textbox', { name: 'Record type (e.g. batch)' }), 'batch');
    await userEvent.type(screen.getByRole('textbox', { name: 'Record id' }), ID);
    await userEvent.click(screen.getByRole('button', { name: 'Show its retention' }));
    const button = await screen.findByRole('button', { name: 'Approve the disposal (signature)' });
    await userEvent.type(screen.getByRole('textbox', { name: 'Reason for the disposal (at least 10 characters)' }), 'short');
    expect(button.hasAttribute('disabled')).toBe(true);
    await userEvent.type(screen.getByRole('textbox', { name: 'Reason for the disposal (at least 10 characters)' }), ' and ended');
    await userEvent.click(button);
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual({ kind: 'RECORDS_ACT', act: 'DISPOSAL_APPROVE', input: { recordKey: `batch:${ID}`, reason: 'short and ended' } });
  });
});

describe('data-integrity investigations', () => {
  const investigation = (status: 'OPEN' | 'CLOSED') => ({
    investigationId: ID, reference: 'DII-000001', status, subject: 'Anil Rao', investigator: 'Kavya Iyer', openedBy: 'Kavya Iyer', windowFrom: at('1760000000000003'), windowTo: at('1760000000000004'),
    concern: 'Entries outside the shift pattern', qmsReference: null, conclusion: status === 'CLOSED' ? 'No falsification found' : null, remediation: status === 'CLOSED' ? 'Retrained' : null,
    approvedBy: status === 'CLOSED' ? 'Divya Menon' : null, links: [{ recordKey: `batch:${ID}`, source: 'SCOPE' as const, note: null }],
  });

  it('[DI-37] an investigation is opened, a record linked with a note, the scope read again, and the closure signed with the conclusion and remediation', async () => {
    const ui = renderValidation('/validation/di-investigations', {
      fixtures: {
        'validation.diInvestigations': { investigations: [investigation('OPEN')] },
        'validation.openDiInvestigation': investigation('OPEN'),
        'validation.linkDiInvestigation': investigation('OPEN'),
        'validation.refreshDiInvestigationScope': { linked: '2', investigation: investigation('OPEN') },
      },
    });
    const open = await screen.findByTestId('di-open');
    await userEvent.type(within(open).getByRole('textbox', { name: 'Person investigated (person id)' }), PERSON);
    await userEvent.type(within(open).getByRole('textbox', { name: 'Window from (e.g. 2026-09-01T00:00+05:30)' }), '2026-09-01T00:00+05:30');
    await userEvent.type(within(open).getByRole('textbox', { name: 'Window to (e.g. 2026-09-30T00:00+05:30)' }), '2026-09-30T00:00+05:30');
    await userEvent.type(within(open).getByRole('textbox', { name: 'Concern (at least 10 characters)' }), 'Entries outside the shift pattern');
    await userEvent.click(within(open).getByRole('button', { name: 'Open the investigation' }));
    await waitFor(() => expect(ui.posts('/api/validation/di-investigations')).toHaveLength(1));
    expect(ui.posts('/api/validation/di-investigations')[0]?.body).toEqual({ subjectPersonId: PERSON, windowFrom: '2026-09-01T00:00+05:30', windowTo: '2026-09-30T00:00+05:30', concern: 'Entries outside the shift pattern' });

    const row = screen.getByTestId('di-DII-000001');
    expect(within(row).getByTestId('di-DII-000001-links').textContent).toContain(`batch:${ID} (in scope)`);
    await userEvent.type(within(row).getByRole('textbox', { name: 'Record type to link' }), 'batch');
    await userEvent.type(within(row).getByRole('textbox', { name: 'Record id to link' }), PERSON);
    await userEvent.type(within(row).getByRole('textbox', { name: 'Why it is linked' }), 'same shift');
    await userEvent.click(within(row).getByRole('button', { name: 'Link the record' }));
    await waitFor(() => expect(ui.posts(`/api/validation/di-investigations/${ID}/links`)).toHaveLength(1));
    await userEvent.click(within(row).getByRole('button', { name: 'Read the scope again' }));
    await waitFor(() => expect(ui.posts(`/api/validation/di-investigations/${ID}/refresh`)).toHaveLength(1));
    expect(await within(row).findByText('2 records newly linked.')).toBeTruthy();

    await userEvent.type(within(row).getByRole('textbox', { name: 'Conclusion (at least 10 characters)' }), 'No falsification found');
    await userEvent.type(within(row).getByRole('textbox', { name: 'Remediation (at least 10 characters)' }), 'Shift pattern retrained');
    await userEvent.click(within(row).getByRole('button', { name: 'Close DII-000001 (signature)' }));
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual({ kind: 'RECORDS_ACT', act: 'DI_INVESTIGATION_CLOSE', input: { investigationId: ID, conclusion: 'No falsification found', remediation: 'Shift pattern retrained' } });
  });

  it('a closed investigation shows its closure and offers no act', async () => {
    renderValidation('/validation/di-investigations', { fixtures: { 'validation.diInvestigations': { investigations: [investigation('CLOSED')] } } });
    const row = await screen.findByTestId('di-DII-000001');
    expect(row.textContent).toContain('Closed by Divya Menon: No falsification found');
    expect(within(row).queryByRole('button')).toBeNull();
  });
});
