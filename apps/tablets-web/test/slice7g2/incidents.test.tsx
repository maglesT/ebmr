/**
 * The incident screens of Phase 7 slice 7g-2 (decision 0025; /incidents, /incidents/$incidentId; DI-12): the register
 * with the CERT-In reports due, the raise form as typed, and one incident's acts (impact on a linked record, the CERT-In
 * report, closure). The states, deadlines and rules are the server's.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { apiState } from '../../src/api/client.ts';
import { claimedTime } from '../../src/features/incidents/reads.ts';
import { refusal, renderOffice } from '../office/support.tsx';
import { INCIDENT } from './fixtures.ts';

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

const SUMMARY = Object.fromEntries(Object.entries(INCIDENT).filter(([k]) => !['description', 'occurredAt', 'occurredAtTrust', 'investigationStartedAt', 'closure', 'linkedRecords', 'events'].includes(k)));
const REGISTER = { incidents: [SUMMARY], certInWindowHours: '6' };

describe('the incident register', () => {
  it('[DI-12] lists the incidents with the CERT-In reports due and the window; an incident is raised as typed with its affected record', async () => {
    const ui = renderOffice('/incidents', { role: 'BATCH_ISSUER', fixtures: { 'incidents.register': REGISTER, 'incidents.raise': INCIDENT } });
    expect((await screen.findByTestId('incident-INC-000042')).getAttribute('data-status')).toBe('UNDER_INVESTIGATION');
    expect(screen.getByTestId('cert-in-due').textContent).toContain('within 6 hours');
    expect(screen.getByTestId('cert-in-due-INC-000042').getAttribute('data-overdue')).toBe('no');
    const form = screen.getByTestId('incident-raise');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Type (an upper-case code, e.g. PRINTER_JAM)' }), 'PRINTER_JAM');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Title' }), 'Label printer jammed');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Affected record: type (e.g. batch; empty when none)' }), 'batch');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Affected record: id' }), 'b-7');
    await userEvent.click(within(form).getByRole('radio', { name: 'Major' }));
    await userEvent.click(within(form).getByRole('button', { name: 'Raise the incident' }));
    await waitFor(() => expect(ui.posts('/api/incidents')).toHaveLength(1));
    expect(ui.posts('/api/incidents')[0]?.body).toEqual({ source: 'OTHER', incidentType: 'PRINTER_JAM', severity: 'MAJOR', title: 'Label printer jammed', description: '', links: [{ aggregateType: 'batch', aggregateId: 'b-7' }], certInReportable: false });
    expect(await screen.findByText('Incident INC-000042 is raised.')).toBeTruthy();
  });
});

describe('one incident', () => {
  it('[DI-12] records the impact on a linked record, the CERT-In report as typed, and shows the database\'s refusal of a closure without a root cause', async () => {
    const ui = renderOffice(`/incidents/${INCIDENT.incidentId}`, {
      role: 'QA_REVIEWER',
      fixtures: {
        'incidents.detail': INCIDENT,
        'incidents.assessImpact': INCIDENT,
        'incidents.recordCertInReport': INCIDENT,
        'incidents.close': () => refusal('EBMR-REC-053', 'This incident was major or critical at some point, so it is closed only with a root cause and a CAPA reference.'),
      },
    });
    expect((await screen.findByTestId('cert-in-status')).getAttribute('data-reported')).toBe('no');
    const link = screen.getByTestId('link-batch:b-1');
    await userEvent.type(within(link).getByRole('textbox', { name: 'Rationale for batch:b-1' }), 'No entry made');
    await userEvent.click(within(link).getByRole('button', { name: 'Record the impact on batch:b-1' }));
    await waitFor(() => expect(ui.posts(`/api/incidents/${INCIDENT.incidentId}/assessments`)).toHaveLength(1));
    expect(ui.posts(`/api/incidents/${INCIDENT.incidentId}/assessments`)[0]?.body).toEqual({ aggregateType: 'batch', aggregateId: 'b-1', outcome: 'NO_IMPACT', rationale: 'No entry made' });
    const certIn = screen.getByTestId('incident-cert-in');
    await userEvent.type(within(certIn).getByRole('textbox', { name: /^When the report was made/ }), '2026-10-18T10:15+05:30');
    await userEvent.type(within(certIn).getByRole('textbox', { name: 'CERT-In acknowledgement reference' }), 'CERTIN-ACK-9');
    await userEvent.click(within(certIn).getByRole('button', { name: 'Record the CERT-In report' }));
    await waitFor(() => expect(ui.posts(`/api/incidents/${INCIDENT.incidentId}/cert-in/report`)).toHaveLength(1));
    const sent = ui.posts(`/api/incidents/${INCIDENT.incidentId}/cert-in/report`)[0]?.body;
    expect(sent).toEqual({ reportedAt: '2026-10-18T10:15:00+05:30', reference: 'CERTIN-ACK-9' });
    // The time as typed without seconds is sent in the form the contract takes (the E2E refusal of 7g-2).
    expect(routes.incidents.recordCertInReport.body?.safeParse(sent).success).toBe(true);
    const inv = screen.getByTestId('incident-investigation');
    await userEvent.type(within(inv).getByRole('textbox', { name: 'Closure summary' }), 'Blocked');
    await userEvent.click(within(inv).getByRole('button', { name: 'Close the incident' }));
    expect(await screen.findByText(/closed only with a root cause and a CAPA reference/)).toBeTruthy();
  });
});

describe('the claimed CERT-In report time', () => {
  it('[DI-12] is sent with its offset and seconds as the contract takes it; a time without its offset is not sent', () => {
    expect(claimedTime('2026-10-18T10:15+05:30')).toBe('2026-10-18T10:15:00+05:30');
    expect(claimedTime(' 2026-10-18T10:15:42Z ')).toBe('2026-10-18T10:15:42Z');
    expect(claimedTime('2026-10-18T10:15:42.123-04:00')).toBe('2026-10-18T10:15:42.123-04:00');
    expect(claimedTime('2026-10-18T10:15')).toBeNull();
    expect(claimedTime('18-OCT-2026 10:15')).toBeNull();
    for (const t of ['2026-10-18T10:15+05:30', '2026-10-18T10:15:42Z']) {
      expect(routes.incidents.recordCertInReport.body?.safeParse({ reportedAt: claimedTime(t), reference: 'R' }).success).toBe(true);
    }
  });
});
