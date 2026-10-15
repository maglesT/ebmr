/**
 * Configuration screens (Phase 6 slice 6f, builder A; DI-09, DI-26) on the contract's examples: change records (raise
 * naming areas, QA approval through the ceremony CONFIG_CHANGE_ACT), the configuration as of a date and the diff with
 * the change records, a setting change and an RBE rule version each sent with its change-record number. Every gate is
 * the server's.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { example } from '@ebmr/api-contract/examples';
import { apiState } from '../../src/api/client.ts';
import { renderOffice } from '../office/support.tsx';

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

const records = example('config-change-records');
const open = records.changeRecords[0]!;

describe('configuration change control screens (DI-09, DI-26)', () => {
  it('[DI-09] a change record is raised naming its areas, and QA approves an open one through the ceremony', async () => {
    const ui = renderOffice('/config/change-records', { role: 'QA_REVIEWER' });
    const box = await screen.findByTestId('config-raise');
    await userEvent.type(within(box).getByRole('textbox', { name: 'Change-record number (e.g. CR-2026-014)' }), 'CR-2026-020');
    await userEvent.type(within(box).getByRole('textbox', { name: 'Title' }), 'LMS bound');
    await userEvent.type(within(box).getByRole('textbox', { name: 'What changes and why' }), 'Tighten the LMS bound');
    await userEvent.click(await within(box).findByRole('checkbox', { name: /Platform setting/ }));
    await userEvent.click(within(box).getByRole('button', { name: 'Raise the change record' }));
    await waitFor(() => expect(ui.posts('/api/config/change-records')).toHaveLength(1));
    expect(ui.posts('/api/config/change-records')[0]?.body).toEqual({ number: 'CR-2026-020', title: 'LMS bound', description: 'Tighten the LMS bound', areas: ['PLATFORM_SETTING'] });
    const card = await screen.findByTestId(`change-record-${open.number}`);
    expect(card.getAttribute('data-state')).toBe('OPEN');
    await userEvent.click(within(card).getByRole('button', { name: 'Approve (signature)' }));
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual({ kind: 'CONFIG_CHANGE_ACT', act: 'APPROVE', number: open.number });
  });

  it('[DI-09] the configuration diff between two dates lists each change with its change record; a setting change carries its change record', async () => {
    const ui = renderOffice('/config/history', { role: 'PROCESS_OWNER' });
    const diff = await screen.findByTestId('config-diff');
    await userEvent.type(within(diff).getByRole('textbox', { name: 'From (YYYY-MM-DDTHH:MM)' }), '2026-10-10T00:00');
    await userEvent.type(within(diff).getByRole('textbox', { name: 'To (YYYY-MM-DDTHH:MM)' }), '2026-10-13T00:00');
    expect((await within(diff).findByText('integration.mirror_max_age_s.qms_status')).closest('tr')?.textContent).toContain('CR-2026-014');
    const setting = await screen.findByTestId('setting-integration.mode.qms_status');
    await userEvent.click(within(setting).getByText(/integration.mode.qms_status =/));
    await userEvent.type(within(setting).getByRole('textbox', { name: 'New value' }), 'MIRROR');
    await userEvent.type(within(setting).getByRole('textbox', { name: 'Change-record number' }), 'CR-2026-014');
    await userEvent.type(within(setting).getByRole('textbox', { name: 'Reason' }), 'QMS adapter live');
    await userEvent.click(within(setting).getByRole('button', { name: 'Change the setting' }));
    await waitFor(() => expect(ui.posts('/api/config/settings/integration.mode.qms_status')).toHaveLength(1));
    expect(ui.posts('/api/config/settings/integration.mode.qms_status')[0]?.body).toEqual({ value: 'MIRROR', changeRecord: 'CR-2026-014', reason: 'QMS adapter live' });
  });

  it('[DI-26] an RBE rule version is saved with its change record and rationale; mandatory categories are marked', async () => {
    const ui = renderOffice('/config/rbe-rules', { role: 'QA_REVIEWER' });
    const rule = await screen.findByTestId('rbe-rule-TIME_SYNC');
    expect(rule.textContent).toContain('(mandatory)');
    await userEvent.click(await within(rule).findByRole('radio', { name: 'Critical' }));
    await userEvent.type(within(rule).getByRole('textbox', { name: 'Rationale' }), 'Clock drift is critical here');
    await userEvent.type(within(rule).getByRole('textbox', { name: 'Change-record number' }), 'CR-2026-012');
    await userEvent.click(within(rule).getByRole('button', { name: 'Save a new version' }));
    await waitFor(() => expect(ui.posts('/api/config/rbe-rules/TIME_SYNC')).toHaveLength(1));
    expect(ui.posts('/api/config/rbe-rules/TIME_SYNC')[0]?.body).toEqual({ included: true, minSeverity: 'CRITICAL', rationale: 'Clock drift is critical here', changeRecord: 'CR-2026-012' });
  });
});
