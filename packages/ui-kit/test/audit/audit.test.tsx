/**
 * Audit trail components (module C1; DI-22, DI-23): each entry shows who, what, when (site time with offset and
 * zone, plus UTC to the microsecond), why and how; a command's business entry leads its field changes; the chain
 * verification result is shown as colour, icon and word.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AuditEventView } from '@ebmr/api-contract';
import { AuditEventList, ChainVerifyBadge, groupByCommand, utcText } from '../../src/audit/index.ts';

const WHO = { personId: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e51', legalName: 'Asha Rao', loginName: 'asha.rao', role: 'MBR_AUTHOR' };
const ev = (over: Partial<AuditEventView>): AuditEventView => ({
  eventId: '1',
  chainKey: 'esig_stub:s-1',
  seq: '1',
  at: { us: '1790586663123456', text: '28-SEP-2026 14:41:03 +05:30 (Asia/Kolkata)' },
  kind: 'ROW',
  action: 'UPDATE',
  summary: 'Changed value in esig.stub_signable s-1',
  table: 'esig.stub_signable',
  recordId: 's-1',
  who: WHO,
  device: 'PC-DESIGN-01',
  why: 'ENTRY_ERROR: transcription error corrected',
  correlationId: 'c-1',
  changes: [{ field: 'value', old: '12.503', new: '12.530' }],
  ...over,
});

describe('audit entries', () => {
  it('[DI-22] UTC is rendered exactly, to the microsecond, without the browser\'s zone or locale', () => {
    expect(utcText('0')).toBe('1970-01-01 00:00:00.000000 UTC');
    expect(utcText('1790586663000000')).toBe('2026-09-28 09:11:03.000000 UTC');
    expect(utcText('1790586663123456')).toBe('2026-09-28 09:11:03.123456 UTC');
    expect(utcText('-1')).toBe('1969-12-31 23:59:59.999999 UTC');
    expect(utcText('951782400000000')).toBe('2000-02-29 00:00:00.000000 UTC');
  });

  it('[DI-22][DI-23] an entry shows who, what (old and new), when (site time and UTC), why and the terminal', async () => {
    render(<AuditEventList events={[ev({})]} />);
    expect(screen.getByText('Changed value in esig.stub_signable s-1')).toBeTruthy();
    expect(screen.getByText('Who: Asha Rao (asha.rao), MBR_AUTHOR · Terminal: PC-DESIGN-01')).toBeTruthy();
    expect(screen.getByText('When: 28-SEP-2026 14:41:03 +05:30 (Asia/Kolkata) · 2026-09-28 09:11:03.123456 UTC')).toBeTruthy();
    expect(screen.getByText('Why: ENTRY_ERROR: transcription error corrected')).toBeTruthy();
    await userEvent.click(screen.getByText('Field changes (1)'));
    const row = screen.getByRole('row', { name: /^value/ });
    expect(within(row).getByText('12.503')).toBeTruthy();
    expect(within(row).getByText('12.530')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /edit|delete|remove|disable/i })).toBeNull();
  });

  it('[DI-22] a command\'s business entry comes first; its row changes are grouped under it', () => {
    const events = [
      ev({ eventId: '10', seq: '1', correlationId: 'c-2', summary: 'Created esig.stub_signable s-2', action: 'INSERT' }),
      ev({ eventId: '11', seq: '2', correlationId: 'c-2', kind: 'BUSINESS', action: 'BUSINESS', summary: 'signed PERFORMED by Asha Rao', changes: [] }),
      ev({ eventId: '12', seq: '3', correlationId: 'c-3', summary: 'Changed value' }),
    ];
    const groups = groupByCommand(events);
    expect(groups.map((g) => [g.correlationId, g.business.map((e) => e.eventId), g.rows.map((e) => e.eventId)])).toEqual([
      ['c-2', ['11'], ['10']],
      ['c-3', [], ['12']],
    ]);
    render(<AuditEventList events={events} />);
    const articles = screen.getAllByRole('article');
    expect(articles[0]?.textContent).toContain('signed PERFORMED by Asha Rao');
    expect(screen.getByText('Records changed by this action (1)')).toBeTruthy();
  });

  it('[DI-23] chain verification shows intact or broken with the problems named', async () => {
    const onVerify = vi.fn();
    const { rerender } = render(<ChainVerifyBadge result={null} busy={false} onVerify={onVerify} />);
    await userEvent.click(screen.getByRole('button', { name: 'Verify chain' }));
    expect(onVerify).toHaveBeenCalled();
    const verifiedAt = { us: '1790586663000000', text: '28-SEP-2026 14:41:03 +05:30 (Asia/Kolkata)' };
    rerender(<ChainVerifyBadge result={{ chainKey: 'x', ok: true, events: 3, problems: [], verifiedAt }} busy={false} onVerify={onVerify} />);
    expect(screen.getByText('Chain intact: 3 entries verified')).toBeTruthy();
    rerender(<ChainVerifyBadge result={{ chainKey: 'x', ok: false, events: 3, problems: ['entry 1: hash does not match the payload (event altered)'], verifiedAt }} busy={false} onVerify={onVerify} />);
    expect(screen.getByText('Chain broken: 1 problem(s)')).toBeTruthy();
    expect(screen.getByText('entry 1: hash does not match the payload (event altered)')).toBeTruthy();
  });
});
