/**
 * The integration health page and one adapter (Phase 6 slice 6a, builder A; DI-31) on the contract's examples: the
 * adapters with their last message, data age, open alarms and reconciliation; the mirrors with their freshness (a stale
 * blocking mirror named with its age and bound); the open alarms, acknowledged by a person with a note.
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

const alarm = example('integrations-alarms').alarms[0]!;

describe('integration health (DI-31)', () => {
  it('[DI-31] the health page shows each adapter\'s last message, data age, open alarms and reconciliation, and every mirror\'s freshness', async () => {
    renderOffice('/integrations', { role: 'SHIFT_SUPERVISOR' });
    const erp = await screen.findByTestId('adapter-ERP-MAIN');
    expect(erp.textContent).toContain('erp.production_order PO-4714 (sequence 131, Gap)');
    expect(erp.textContent).toContain('1 open');
    expect(erp.textContent).toContain('Matched');
    expect(screen.getByTestId('adapter-LMS-MAIN')).toBeTruthy();
    const mirrors = screen.getByTestId('integration-mirrors');
    expect(within(mirrors).getAllByRole('row').length).toBeGreaterThan(1);
  });

  it('[DI-31] a stale blocking mirror is named with its age and bound and says who to call', async () => {
    renderOffice('/integrations', { role: 'SHIFT_SUPERVISOR', fixtures: { 'integrations.mirrors': example('integrations-mirrors-stale') } });
    const row = await screen.findByTestId('mirror-LMS_QUALIFICATION');
    expect(row.getAttribute('data-stale')).toBe('true');
    expect(row.textContent).toMatch(/Stale, blocking: (synchronised .* ago|never synchronised), more than its bound of/);
    expect(row.textContent).toContain('call the Lms system owner');
  });

  it('[DI-31] a person acknowledges an open alarm with a note; the note is required', async () => {
    const ui = renderOffice('/integrations', { role: 'SHIFT_SUPERVISOR' });
    const item = await screen.findByTestId(`alarm-${alarm.alarmId}`);
    expect(item.textContent).toContain(alarm.summary);
    const button = within(item).getByRole('button', { name: 'Acknowledge the alarm' });
    expect(button.hasAttribute('disabled')).toBe(true);
    await userEvent.type(within(item).getByRole('textbox', { name: 'What was done about it' }), 'ERP team resent 129 and 130');
    await userEvent.click(button);
    await waitFor(() => expect(ui.posts(`/api/integrations/alarms/${alarm.alarmId}/acknowledge`)).toHaveLength(1));
    expect(ui.posts(`/api/integrations/alarms/${alarm.alarmId}/acknowledge`)[0]?.body).toEqual({ note: 'ERP team resent 129 and 130' });
  });

  it('[DI-31] one adapter shows its accepted messages with the gap, its refusals with their class, and its reconciliation', async () => {
    renderOffice('/integrations/ERP-MAIN', { role: 'QA_REVIEWER' });
    const messages = await screen.findByTestId('adapter-messages');
    expect(messages.textContent).toContain('131');
    expect(messages.textContent).toContain('Gap');
    expect(screen.getByTestId('adapter-refusals').textContent).toContain('Wrong identity');
    expect((await screen.findByTestId('adapter-reconciliations')).textContent).toMatch(/Matched|Mismatch/);
  });
});
