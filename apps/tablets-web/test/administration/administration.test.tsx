/**
 * The administration screens of slice 7g-1 (decision 0025): people and accounts, role grants, recertification,
 * break-glass and the device registry. Display only decides what is offered; the server and the database decide every act
 * (the server tests in apps/tablets-server/test/administration prove the refusals), and a refusal is shown in the
 * database's words.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { apiState } from '../../src/api/client.ts';
import { refusal, renderOffice } from '../office/support.tsx';
import { ADMIN_FIXTURES, GRANT_BY_IRA, GRANT_BY_OMAR, IRA, ISSUED, KEY, OMAR, sessionAs, WINDOW_ENDED, WINDOW_REQUESTED } from './fixtures.ts';

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

const asAdmin = { ...ADMIN_FIXTURES, 'session.get': sessionAs(IRA, 'SYSTEM_ADMINISTRATOR') };
const asOwner = { ...ADMIN_FIXTURES, 'session.get': sessionAs(OMAR, 'PROCESS_OWNER') };

describe('people and accounts', () => {
  it('[DI-14][DI-15] the administrator records a person; an issued password is hidden until shown to its owner, then removed; the directory shows credentials as metadata only', async () => {
    const ui = renderOffice('/admin/people', { role: 'SYSTEM_ADMINISTRATOR', fixtures: asAdmin });
    const form = await screen.findByTestId('person-create');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Legal name' }), 'Noor Khan');
    await userEvent.click(within(form).getByRole('button', { name: 'Record the person' }));
    await waitFor(() => expect(ui.posts('/api/admin/people')).toHaveLength(1));
    expect(ui.posts('/api/admin/people')[0]?.body).toEqual({ kind: 'NATURAL', legalName: 'Noor Khan' });

    const account = await screen.findByTestId('account-lena.fischer');
    expect(account.textContent).toContain('Password (must be changed at first use, expires 06 Jan 2026, 13:30 IST)');
    expect(account.textContent).toContain('Locked after failed sign-ins');
    expect(document.body.textContent).not.toContain(ISSUED.secret);
    await userEvent.type(within(account).getByRole('textbox', { name: 'Reason (for the record of acts on lena.fischer)' }), 'new starter');
    await userEvent.click(within(account).getByRole('button', { name: 'Issue a password for lena.fischer' }));
    await waitFor(() => expect(ui.posts(`/api/admin/accounts/${ISSUED.accountId}/credentials`)).toHaveLength(1));
    expect(ui.posts(`/api/admin/accounts/${ISSUED.accountId}/credentials`)[0]?.body).toEqual({ kind: 'PASSWORD', reason: 'new starter' });
    const handover = await within(account).findByTestId('secret-handover');
    expect(handover.textContent).not.toContain(ISSUED.secret);
    await userEvent.click(within(handover).getByRole('button', { name: 'Show it to the person' }));
    expect(within(handover).getByTestId('issued-secret').textContent).toBe(ISSUED.secret);
    await userEvent.click(within(handover).getByRole('button', { name: 'Handed over: remove it from the screen' }));
    await waitFor(() => expect(within(account).queryByTestId('secret-handover')).toBeNull());
    expect(document.body.textContent).not.toContain(ISSUED.secret);
  });

  it('[DI-19][DI-38] a badge UID is typed into a secret field, sent once and cleared; badges are tested and activated from the account', async () => {
    const ui = renderOffice('/admin/people', { role: 'SYSTEM_ADMINISTRATOR', fixtures: asAdmin });
    const account = await screen.findByTestId('account-lena.fischer');
    await userEvent.click(within(account).getByText('Issue a badge for lena.fischer'));
    const uid = within(account).getByLabelText('Badge UID (tap the badge on the reader)');
    expect(uid.getAttribute('type')).toBe('password');
    await userEvent.type(uid, '04B1000000ABCD');
    await userEvent.type(within(account).getByRole('textbox', { name: 'Printed label' }), 'B-lena-2');
    await userEvent.click(within(account).getByRole('button', { name: 'Issue the badge for lena.fischer' }));
    await waitFor(() => expect(ui.posts(`/api/admin/accounts/${ISSUED.accountId}/badges`)).toHaveLength(1));
    expect(ui.posts(`/api/admin/accounts/${ISSUED.accountId}/badges`)[0]?.body).toMatchObject({ badgeUid: '04B1000000ABCD', technology: 'ISO14443_DESFIRE_EV3', label: 'B-lena-2' });
    expect((uid as HTMLInputElement).value).toBe('');
    const badge = within(account).getByTestId('badge-B-lena');
    await userEvent.click(within(badge).getByRole('button', { name: 'Badge B-lena passed its test' }));
    await waitFor(() => expect(ui.requests.some((r) => r.method === 'POST' && r.path.endsWith('/tests'))).toBe(true));
    expect(ui.requests.find((r) => r.method === 'POST' && r.path.endsWith('/tests'))?.body).toEqual({ kind: 'AT_ISSUE', result: 'PASS' });
  });

  it('[DI-14] a person in a GMP role is offered no administration act', async () => {
    renderOffice('/admin/people', { role: 'QA_MBR_APPROVER', fixtures: { ...ADMIN_FIXTURES, 'session.get': sessionAs(OMAR, 'QA_MBR_APPROVER') } });
    await screen.findByTestId('account-lena.fischer');
    expect(screen.queryByTestId('person-create')).toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});

describe('role grants', () => {
  it('[DI-16][DI-18] the process owner is offered the decision on a grant another person requested, never on their own request; the database\'s refusal is shown in its words', async () => {
    const ui = renderOffice('/admin/grants', {
      role: 'PROCESS_OWNER',
      fixtures: { ...asOwner, 'people.decideGrant': () => refusal('EBMR-IAM-033', 'The identity rules do not allow this.', 'INV-11/DI-18: the person already holds a GMP role and cannot also hold administrator role SYSTEM_ADMINISTRATOR') },
    });
    const byIra = await screen.findByTestId('grant-lena.fischer-MBR_CHECKER');
    const byOmar = screen.getByTestId('grant-lena.fischer-MBR_AUTHOR');
    expect(within(byOmar).queryByRole('button')).toBeNull();
    expect(byOmar.textContent).toContain('a second person decides it');
    await userEvent.type(within(byIra).getByRole('textbox', { name: 'Reason (MBR_CHECKER for lena.fischer)' }), 'approved for MBR checks');
    await userEvent.click(within(byIra).getByRole('button', { name: 'Approve MBR_CHECKER for lena.fischer' }));
    await waitFor(() => expect(ui.posts(`/api/admin/grants/${GRANT_BY_IRA}/decision`)).toHaveLength(1));
    expect(ui.posts(`/api/admin/grants/${GRANT_BY_IRA}/decision`)[0]?.body).toEqual({ approve: true, reason: 'approved for MBR checks' });
    expect(await within(byIra).findByText(/INV-11\/DI-18: the person already holds a GMP role/)).toBeTruthy();
    void GRANT_BY_OMAR;
  });

  it('[DI-16] the administrator requests a grant for an account and scope; the decision on their own request is not offered', async () => {
    const ui = renderOffice('/admin/grants', { role: 'SYSTEM_ADMINISTRATOR', fixtures: asAdmin });
    const form = await screen.findByTestId('grant-request');
    await waitFor(() => expect(within(form).getAllByRole('option').length).toBeGreaterThan(2));
    await userEvent.selectOptions(within(form).getByLabelText('Account'), within(form).getByRole('option', { name: /Lena Fischer \(lena\.fischer/ }));
    await userEvent.selectOptions(within(form).getByLabelText('Role'), 'MBR_CHECKER');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Site (optional; blank for every site)' }), 'SITE-1');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Reason' }), 'checks master batch records');
    await userEvent.click(within(form).getByRole('button', { name: 'Request the grant' }));
    await waitFor(() => expect(ui.posts('/api/admin/grants')).toHaveLength(1));
    expect(ui.posts('/api/admin/grants')[0]?.body).toEqual({ accountId: '0b8f1c2a-4444-4c7d-8e9f-0a1b2c3d4e04', roleCode: 'MBR_CHECKER', scope: { site: 'SITE-1' }, reason: 'checks master batch records' });
    const own = screen.getByTestId('grant-lena.fischer-MBR_CHECKER');
    expect(within(own).queryByRole('button', { name: /Approve/ })).toBeNull();
    expect(within(screen.getByTestId('grant-lena.fischer-MBR_AUTHOR')).getByRole('button', { name: 'Approve MBR_AUTHOR for lena.fischer' })).toBeTruthy();
  });
});

describe('recertification and break-glass', () => {
  it('[DI-16] the process owner confirms an account\'s access; the administrator is not offered it', async () => {
    const ui = renderOffice('/admin/recertification', { role: 'PROCESS_OWNER', fixtures: asOwner });
    const due = await screen.findByTestId('recert-lena.fischer');
    expect(due.textContent).toContain('MBR_CHECKER');
    await userEvent.type(within(due).getByRole('textbox', { name: 'Comment (lena.fischer)' }), 'still needed');
    await userEvent.click(within(due).getByRole('button', { name: 'Confirm the access of lena.fischer' }));
    await waitFor(() => expect(ui.posts('/api/admin/accounts/0b8f1c2a-4444-4c7d-8e9f-0a1b2c3d4e04/recertification')).toHaveLength(1));
    expect(ui.posts('/api/admin/accounts/0b8f1c2a-4444-4c7d-8e9f-0a1b2c3d4e04/recertification')[0]?.body).toEqual({ outcome: 'CONFIRMED', comment: 'still needed' });
    cleanup();
    renderOffice('/admin/recertification', { role: 'SYSTEM_ADMINISTRATOR', fixtures: asAdmin });
    expect(within(await screen.findByTestId('recert-lena.fischer')).queryByRole('button')).toBeNull();
  });

  it('[DI-18] the holder requests a window for their own break-glass account; the process owner approves a request of another person and reviews an ended window', async () => {
    const ui = renderOffice('/admin/break-glass', { role: 'SYSTEM_ADMINISTRATOR', fixtures: asAdmin });
    const form = await screen.findByTestId('break-glass-request');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Why the window is needed' }), 'database restore after outage');
    await userEvent.click(within(form).getByRole('button', { name: 'Request the window' }));
    await waitFor(() => expect(ui.posts('/api/admin/break-glass')).toHaveLength(1));
    expect(ui.posts('/api/admin/break-glass')[0]?.body).toEqual({ accountId: '0b8f1c2a-5555-4c7d-8e9f-0a1b2c3d4e05', reason: 'database restore after outage', minutes: 30 });
    // The requester is never offered the approval.
    expect(screen.queryByRole('button', { name: /Approve the window/ })).toBeNull();
    cleanup();
    const ui2 = renderOffice('/admin/break-glass', { role: 'PROCESS_OWNER', fixtures: asOwner });
    expect(screen.queryByTestId('break-glass-request')).toBeNull();
    const rows = await screen.findAllByTestId('break-glass-bg.ira');
    const requested = rows.find((r) => r.getAttribute('data-state') === 'REQUESTED')!;
    await userEvent.type(within(requested).getByRole('textbox'), 'outage confirmed');
    await userEvent.click(within(requested).getByRole('button', { name: 'Approve the window for bg.ira' }));
    await waitFor(() => expect(ui2.posts(`/api/admin/break-glass/${WINDOW_REQUESTED}/approval`)).toHaveLength(1));
    const ended = rows.find((r) => r.getAttribute('data-state') === 'ENDED')!;
    expect(within(ended).getByRole('button', { name: 'Reviewed: no findings' })).toBeTruthy();
    void WINDOW_ENDED;
  });
});

describe('the device registry', () => {
  it('[DI-19][DI-20] the administrator registers a terminal with its key fingerprint and attests the hardening of a kiosk only', async () => {
    const ui = renderOffice('/admin/devices', { role: 'SYSTEM_ADMINISTRATOR', fixtures: asAdmin });
    const form = await screen.findByTestId('terminal-register');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Code' }), 'PC-NEW-1');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Key fingerprint (SHA-256 of the public key, 64 hexadecimal digits)' }), 'c'.repeat(64));
    await userEvent.type(within(form).getByRole('textbox', { name: 'Description' }), 'QA office PC');
    await userEvent.click(within(form).getByRole('button', { name: 'Register the device' }));
    await waitFor(() => expect(ui.posts('/api/admin/devices')).toHaveLength(1));
    expect(ui.posts('/api/admin/devices')[0]?.body).toEqual({ code: 'PC-NEW-1', deviceClass: 'PERSONAL', fingerprint: 'c'.repeat(64), description: 'QA office PC' });
    const kiosk = screen.getByTestId('terminal-KIOSK-T-1');
    expect(kiosk.textContent).toContain('No hardening attestation');
    expect(within(screen.getByTestId('terminal-PC-T-1')).queryByText(/Attest the hardening/)).toBeNull();
    await userEvent.click(within(kiosk).getByText('Attest the hardening of KIOSK-T-1'));
    for (const label of ['USB mass storage is blocked', 'Kiosk mode is enforced', 'Malware protection is active', 'Operating-system patches are within the agreed time']) {
      await userEvent.click(within(kiosk).getByRole('checkbox', { name: label }));
    }
    await userEvent.type(within(kiosk).getByRole('textbox', { name: 'Evidence reference' }), 'MDM-2026-01');
    await userEvent.click(within(kiosk).getByRole('button', { name: 'Record the attestation of KIOSK-T-1' }));
    await waitFor(() => expect(ui.requests.some((r) => r.method === 'POST' && r.path.endsWith('/hardening'))).toBe(true));
    expect(ui.requests.find((r) => r.path.endsWith('/hardening'))?.body).toEqual({ usbMassStorageBlocked: true, kioskModeEnforced: true, malwareProtectionActive: true, osPatchWithinSla: true, method: 'MDM_COMPLIANCE_REPORT', evidenceRef: 'MDM-2026-01' });
  });

  it('[DI-31][DI-20] the administrator enrols a gateway key, binds a balance behind it and binds an OPC UA adapter to the gateway\'s feed', async () => {
    const ui = renderOffice('/admin/devices', { role: 'SYSTEM_ADMINISTRATOR', fixtures: asAdmin });
    const enrol = await screen.findByTestId('gateway-key-enrol');
    await userEvent.selectOptions(within(enrol).getByLabelText('Gateway (SERVER device)'), 'GW-T-1');
    await userEvent.selectOptions(within(enrol).getByLabelText('Its INTEGRATION login'), 'gw.t1');
    await userEvent.type(within(enrol).getByRole('textbox', { name: 'Public key (SPKI DER, base64)' }), 'MCowBQYDK2VwAyEAAAAA');
    await userEvent.click(within(enrol).getByRole('button', { name: 'Enrol the key' }));
    await waitFor(() => expect(ui.posts('/api/admin/gateway-keys')).toHaveLength(1));
    expect(ui.posts('/api/admin/gateway-keys')[0]?.body).toEqual({ gatewayCode: 'GW-T-1', publicKeySpki: 'MCowBQYDK2VwAyEAAAAA', loginName: 'gw.t1' });

    const bind = screen.getByTestId('device-bind');
    await userEvent.selectOptions(within(bind).getByLabelText('Gateway key'), KEY);
    await userEvent.selectOptions(within(bind).getByLabelText('Instrument (registered INSTRUMENT)'), 'BAL-T-1');
    await userEvent.type(within(bind).getByRole('textbox', { name: 'Serial' }), 'SN1');
    await userEvent.type(within(bind).getByRole('textbox', { name: 'Resolution (e.g. 0.001)' }), '0.001');
    await userEvent.click(within(bind).getByRole('button', { name: 'Bind the device' }));
    await waitFor(() => expect(ui.posts('/api/admin/device-bindings')).toHaveLength(1));
    expect(ui.posts('/api/admin/device-bindings')[0]?.body).toEqual({ kind: 'BALANCE', gatewayKeyId: KEY, deviceCode: 'BAL-T-1', serial: 'SN1', unit: 'kg', resolution: '0.001' });

    const adapter = screen.getByTestId('adapter-OPCUA-T-1');
    expect(adapter.textContent).toContain('No gateway feed bound.');
    await userEvent.selectOptions(within(adapter).getByLabelText('Gateway whose feed OPCUA-T-1 pulls'), 'GW-T-1');
    await userEvent.type(within(adapter).getByRole('textbox', { name: 'Reason (OPCUA-T-1)' }), 'commissioning');
    await userEvent.click(within(adapter).getByRole('button', { name: 'Bind the feed of OPCUA-T-1' }));
    await waitFor(() => expect(ui.posts('/api/admin/gateway-feeds')).toHaveLength(1));
    expect(ui.posts('/api/admin/gateway-feeds')[0]?.body).toEqual({ adapterCode: 'OPCUA-T-1', gatewayCode: 'GW-T-1', reason: 'commissioning' });
  });

  it('[DI-19] a person in a GMP role sees the registry with no act offered', async () => {
    renderOffice('/admin/devices', { role: 'QA_MBR_APPROVER', fixtures: { ...ADMIN_FIXTURES, 'session.get': sessionAs(OMAR, 'QA_MBR_APPROVER') } });
    await screen.findByTestId('terminal-KIOSK-T-1');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
