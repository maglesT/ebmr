/**
 * The signature catalogue and the record-seal keys (Phase 7 slice 7g-3, WP1) on test answers: a customer signature point
 * added and a meaning type versioned, each under a change record with the reason; a seal key retired with the reason
 * and its change record. The database decides; the screens send what the person typed.
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

const meaning = (code: string, origin: 'VENDOR' | 'CUSTOMER') => ({
  code, version: '1', origin, status: 'ACTIVE' as const, category: 'RECORDS', roleClass: 'APPROVER', title: `${code} title`, meaningText: 'Approved by', permissions: ['RECORD.DISPOSAL_APPROVE'],
  independentOf: [], excludesPerformers: true, excludesInvolved: false, witness: false, reauth: 'ALL_COMPONENTS' as const, delegable: false, definedAt: at('1760000000000001'),
});

describe('the signature catalogue', () => {
  it('[DI-09] a customer signature point is added under a change record with the reason', async () => {
    const ui = renderValidation('/validation/meaning-types', { fixtures: { 'esig.meaningTypes': { meaningTypes: [meaning('RECORD_DISPOSAL_APPROVED', 'VENDOR')] }, 'esig.addMeaningType': meaning('ARCHIVE_TRANSFER_APPROVED', 'CUSTOMER') } });
    const box = await screen.findByTestId('add-meaning-type');
    await userEvent.type(within(box).getByRole('textbox', { name: 'Code' }), 'ARCHIVE_TRANSFER_APPROVED');
    await userEvent.type(within(box).getByRole('textbox', { name: 'Title' }), 'Archive transfer approved');
    await userEvent.type(within(box).getByRole('textbox', { name: 'Meaning as the manifestation shows it' }), 'Archive transfer approved by');
    await userEvent.type(within(box).getByRole('textbox', { name: 'Permissions that may sign it (comma-separated)' }), 'RECORD.DISPOSAL_APPROVE, RECORD.LEGAL_HOLD');
    await userEvent.type(within(box).getByRole('textbox', { name: 'Reason' }), 'its own signature point');
    const button = within(box).getByRole('button', { name: 'Add the signature point' });
    expect(button.hasAttribute('disabled')).toBe(true);
    await userEvent.type(within(box).getByRole('textbox', { name: 'Approved change record (number)' }), 'CR-2026-040');
    await userEvent.click(button);
    await waitFor(() => expect(ui.posts('/api/esig/meaning-types')).toHaveLength(1));
    expect(ui.posts('/api/esig/meaning-types')[0]?.body).toEqual({
      code: 'ARCHIVE_TRANSFER_APPROVED',
      definition: { category: 'RECORDS', roleClass: 'APPROVER', title: 'Archive transfer approved', meaningText: 'Archive transfer approved by', permissions: ['RECORD.DISPOSAL_APPROVE', 'RECORD.LEGAL_HOLD'] },
      changeRecord: 'CR-2026-040',
      reason: 'its own signature point',
    });
  });

  it('[DI-09] a meaning type gets a new version under a change record; only a customer type can be retired', async () => {
    const ui = renderValidation('/validation/meaning-types', {
      fixtures: { 'esig.meaningTypes': { meaningTypes: [meaning('RECORD_DISPOSAL_APPROVED', 'VENDOR'), meaning('ARCHIVE_TRANSFER_APPROVED', 'CUSTOMER')] }, 'esig.configureMeaningType': meaning('ARCHIVE_TRANSFER_APPROVED', 'CUSTOMER') },
    });
    const vendor = await screen.findByTestId('meaning-RECORD_DISPOSAL_APPROVED');
    expect(within(vendor).queryByRole('checkbox', { name: 'Retire it' })).toBeNull();
    const custom = screen.getByTestId('meaning-ARCHIVE_TRANSFER_APPROVED');
    await userEvent.click(within(custom).getByRole('checkbox', { name: 'Retire it' }));
    await userEvent.type(within(custom).getByRole('textbox', { name: 'Approved change record (number)' }), 'CR-2026-041');
    await userEvent.type(within(custom).getByRole('textbox', { name: 'Reason' }), 'no longer used');
    await userEvent.click(within(custom).getByRole('button', { name: 'Save a new version of ARCHIVE_TRANSFER_APPROVED' }));
    await waitFor(() => expect(ui.posts('/api/esig/meaning-types/ARCHIVE_TRANSFER_APPROVED')).toHaveLength(1));
    expect(ui.posts('/api/esig/meaning-types/ARCHIVE_TRANSFER_APPROVED')[0]?.body).toEqual({ changes: { status: 'RETIRED' }, changeRecord: 'CR-2026-041', reason: 'no longer used' });
  });
});

describe('the record-seal keys', () => {
  it('a seal key is retired with the reason and its change record; a retired key offers nothing', async () => {
    const keys = [
      { keyId: 'site-hmac-1', algorithm: 'HMAC-SHA256' as const, description: 'Site seal key', registeredAt: at('1760000000000002'), retired: null },
      { keyId: 'site-hmac-0', algorithm: 'HMAC-SHA256' as const, description: 'Old key', registeredAt: at('1760000000000003'), retired: { reason: 'rotated', at: at('1760000000000004') } },
    ];
    const ui = renderValidation('/validation/seal-keys', { role: 'SYSTEM_ADMINISTRATOR', fixtures: { 'esig.sealKeys': { sealKeys: keys }, 'esig.retireSealKey': { sealKeys: keys } } });
    const old = await screen.findByTestId('seal-key-site-hmac-0');
    expect(old.getAttribute('data-retired')).toBe('true');
    expect(within(old).queryByRole('button')).toBeNull();
    const row = screen.getByTestId('seal-key-site-hmac-1');
    await userEvent.type(within(row).getByRole('textbox', { name: 'Change record (number)' }), 'CR-KEYS-1');
    await userEvent.type(within(row).getByRole('textbox', { name: 'Reason' }), 'key rotated');
    await userEvent.click(within(row).getByRole('button', { name: 'Retire site-hmac-1' }));
    await waitFor(() => expect(ui.posts('/api/esig/seal-keys/site-hmac-1/retire')).toHaveLength(1));
    expect(ui.posts('/api/esig/seal-keys/site-hmac-1/retire')[0]?.body).toEqual({ changeRecord: 'CR-KEYS-1', reason: 'key rotated' });
  });
});
