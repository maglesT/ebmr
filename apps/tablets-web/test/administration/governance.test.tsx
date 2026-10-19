/**
 * The access-governance screens of slice 7g-5 (decision 0025; contract ns/access-governance.ts): role-permission
 * requests and their decision, delegations of signing authority, and the US e-signature certification letter. Display
 * only decides what is offered (never a decision to the requester, the delegator or the delegate); the server and the
 * database decide every act (apps/tablets-server/test/administration/access-governance-routes.test.ts), and a refusal
 * is shown in the database's words.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { apiState } from '../../src/api/client.ts';
import { refusal, renderOffice } from '../office/support.tsx';
import { IRA, OMAR, sessionAs } from './fixtures.ts';

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

const at = (us: string, text: string) => ({ us, text });
const T1 = at('1767600000000000', '05 Jan 2026, 13:30 IST');
const T2 = at('1768204800000000', '12 Jan 2026, 13:30 IST');
const SHALINI = { personId: '0b8f1c2a-aaaa-4c7d-8e9f-0a1b2c3d4e21', legalName: 'Shalini Kapoor', loginName: 'shalini.kapoor', role: 'DELEGATOR' };
const ARVIND = { personId: '0b8f1c2a-bbbb-4c7d-8e9f-0a1b2c3d4e22', legalName: 'Arvind Rao', loginName: 'arvind.rao', role: 'DELEGATE' };
const REQ_OPEN = '0b8f1c2a-cccc-4c7d-8e9f-0a1b2c3d4e23';
const REQ_DONE = '0b8f1c2a-dddd-4c7d-8e9f-0a1b2c3d4e24';
const DELEGATION = '0b8f1c2a-eeee-4c7d-8e9f-0a1b2c3d4e25';

const request = (requestId: string, permissionCode: string, status: 'REQUESTED' | 'APPROVED') => ({
  requestId,
  roleCode: 'QA_REVIEWER',
  permissionCode,
  reason: 'reviewers read the new register',
  status,
  requestedBy: { ...IRA },
  requestedAt: T1,
  decidedBy: status === 'APPROVED' ? { ...OMAR } : null,
  decidedAt: status === 'APPROVED' ? T2 : null,
  decisionReason: status === 'APPROVED' ? 'agreed with QA' : null,
});
const rolePermissions = routes.accessGovernance.rolePermissions.response.parse({
  roles: [
    { code: 'QA_REVIEWER', name: 'QA reviewer', group: 'QA', accountKinds: ['HUMAN'], permissions: ['RECORD.QA_REVIEW', 'RECORD.READ'] },
    { code: 'SYSTEM_ADMINISTRATOR', name: 'System administrator', group: 'IT', accountKinds: ['HUMAN'], permissions: ['IAM.ROLE_MANAGE'] },
  ],
  permissions: [
    { code: 'RECORD.QA_REVIEW', domain: 'GMP', effect: 'SIGN', description: 'QA review' },
    { code: 'RECORD.READ', domain: 'GMP', effect: 'READ', description: 'Read records' },
    { code: 'LOGBOOK.READ', domain: 'GMP', effect: 'READ', description: 'Read logbooks' },
  ],
  requests: [request(REQ_OPEN, 'LOGBOOK.READ', 'REQUESTED'), request(REQ_DONE, 'RECORD.READ', 'APPROVED')],
});

const delegation = (status: 'REQUESTED' | 'APPROVED') => ({
  delegationId: DELEGATION,
  delegator: SHALINI,
  delegate: ARVIND,
  scope: { site: null, area: null, product: null },
  markets: ['IN'],
  meanings: ['MANUFACTURER_RELEASE'],
  validFrom: T1,
  validTo: T2,
  sopRef: 'SOP-QA-017',
  reason: 'annual leave',
  status,
  live: status === 'APPROVED',
  requestedBy: SHALINI,
  requestedAt: T1,
  decidedBy: status === 'APPROVED' ? OMAR : null,
  decidedAt: status === 'APPROVED' ? T1 : null,
  decisionReason: status === 'APPROVED' ? 'SOP followed' : null,
  revokedBy: null,
  revokedAt: null,
  revocationReason: null,
});
const delegations = (status: 'REQUESTED' | 'APPROVED', mayApprove: boolean) =>
  routes.accessGovernance.delegations.response.parse({ delegations: [delegation(status)], meanings: [{ code: 'MANUFACTURER_RELEASE', title: 'Manufacturer release' }], mayApprove });

const certifications = (legalEntity?: string) =>
  routes.accessGovernance.usEsigCertifications.response.parse({
    mode: 'BLOCK',
    certifications: [{ certificationId: '0b8f1c2a-ffff-4c7d-8e9f-0a1b2c3d4e26', legalEntity: 'Batchwright Pharma Pvt Ltd', letterRef: 'CERT-2026-001', submittedOn: '2026-03-02', agencyAcknowledgementRef: null, recordedBy: OMAR, recordedAt: T1 }],
    status: legalEntity ? { legalEntity, onFile: false, blocking: true } : null,
  });

describe('role permissions', () => {
  it('[DI-16][DI-18] the administrator requests a permission the role does not hold and is never offered the decision on their own request', async () => {
    const ui = renderOffice('/admin/role-permissions', {
      role: 'SYSTEM_ADMINISTRATOR',
      fixtures: { 'session.get': sessionAs(IRA, 'SYSTEM_ADMINISTRATOR'), 'accessGovernance.rolePermissions': rolePermissions, 'accessGovernance.requestRolePermission': rolePermissions.requests[0] },
    });
    const open = await screen.findByTestId('role-permission-QA_REVIEWER-LOGBOOK.READ');
    expect(open.textContent).toContain('You requested this, so a second person decides it.');
    expect(within(open).queryAllByRole('button')).toHaveLength(0);
    const form = screen.getByTestId('role-permission-request');
    await userEvent.selectOptions(within(form).getByLabelText('Role'), 'QA_REVIEWER');
    // A permission the role holds is not offered.
    const perms = within(form).getByLabelText('Permission');
    expect(within(perms).queryByRole('option', { name: /^RECORD\.READ/ })).toBeNull();
    await userEvent.selectOptions(perms, 'LOGBOOK.READ');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Reason' }), 'reviewers read the new register');
    await userEvent.click(within(form).getByRole('button', { name: 'Request the permission' }));
    await waitFor(() => expect(ui.posts('/api/admin/role-permissions/requests')).toHaveLength(1));
    expect(ui.posts('/api/admin/role-permissions/requests')[0]?.body).toEqual({ roleCode: 'QA_REVIEWER', permissionCode: 'LOGBOOK.READ', reason: 'reviewers read the new register' });
  });

  it('[DI-16][DI-09] the process owner approves under the change record; the database\'s refusal without one is shown in its words', async () => {
    const ui = renderOffice('/admin/role-permissions', {
      role: 'PROCESS_OWNER',
      fixtures: {
        'session.get': sessionAs(OMAR, 'PROCESS_OWNER'),
        'accessGovernance.rolePermissions': rolePermissions,
        'accessGovernance.decideRolePermission': ({ body }: { body: unknown }) =>
          (body as { changeRecord?: string }).changeRecord ? request(REQ_OPEN, 'LOGBOOK.READ', 'APPROVED') : refusal('EBMR-CFG-001', 'A configuration change needs a change-record id; this one named none.'),
      },
    });
    const open = await screen.findByTestId('role-permission-QA_REVIEWER-LOGBOOK.READ');
    expect(screen.queryByTestId('role-permission-request')).toBeNull();
    await userEvent.type(within(open).getByRole('textbox', { name: 'Reason (LOGBOOK.READ for QA_REVIEWER)' }), 'agreed with QA');
    await userEvent.click(within(open).getByRole('button', { name: 'Approve LOGBOOK.READ for QA_REVIEWER' }));
    expect(await within(open).findByText('A configuration change needs a change-record id; this one named none.')).toBeTruthy();
    await userEvent.type(within(open).getByRole('textbox', { name: /^Change record approved for role permissions/ }), 'CR-ROLE-7');
    await userEvent.click(within(open).getByRole('button', { name: 'Approve LOGBOOK.READ for QA_REVIEWER' }));
    await waitFor(() => expect(ui.posts(`/api/admin/role-permissions/requests/${REQ_OPEN}/decision`)).toHaveLength(2));
    expect(ui.posts(`/api/admin/role-permissions/requests/${REQ_OPEN}/decision`)[1]?.body).toEqual({ approve: true, reason: 'agreed with QA', changeRecord: 'CR-ROLE-7' });
    expect(screen.getByTestId('role-permission-QA_REVIEWER-RECORD.READ').textContent).toContain('Approved by Omar Owner');
  });

  it('[DI-16] the administrator removes a permission a role holds, under a change record', async () => {
    const ui = renderOffice('/admin/role-permissions', {
      role: 'SYSTEM_ADMINISTRATOR',
      fixtures: { 'session.get': sessionAs(IRA, 'SYSTEM_ADMINISTRATOR'), 'accessGovernance.rolePermissions': rolePermissions, 'accessGovernance.removeRolePermission': rolePermissions },
    });
    const form = await screen.findByTestId('role-permission-remove');
    await userEvent.selectOptions(within(form).getByLabelText('Role'), 'QA_REVIEWER');
    await userEvent.selectOptions(within(form).getByLabelText('Permission it holds'), 'RECORD.READ');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Change record approved for role permissions' }), 'CR-ROLE-7');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Reason for the removal' }), 'register retired');
    await userEvent.click(within(form).getByRole('button', { name: 'Remove the permission' }));
    await waitFor(() => expect(ui.posts('/api/admin/role-permissions/removal')).toHaveLength(1));
    expect(ui.posts('/api/admin/role-permissions/removal')[0]?.body).toEqual({ roleCode: 'QA_REVIEWER', permissionCode: 'RECORD.READ', reason: 'register retired', changeRecord: 'CR-ROLE-7' });
  });
});

describe('delegations of signing authority', () => {
  it('[IN-05][DI-35] the delegator requests a delegation and is not offered its decision', async () => {
    const ui = renderOffice('/admin/delegations', {
      role: 'AUTHORISED_PERSON',
      fixtures: { 'session.get': sessionAs(SHALINI, 'AUTHORISED_PERSON'), 'accessGovernance.delegations': delegations('REQUESTED', false), 'accessGovernance.requestDelegation': delegation('REQUESTED') },
    });
    const item = await screen.findByTestId('delegation-arvind.rao-SOP-QA-017');
    expect(item.textContent).toContain('a third person decides it');
    expect(within(item).queryAllByRole('button')).toHaveLength(0);
    const form = screen.getByTestId('delegation-request');
    await userEvent.type(within(form).getByRole('textbox', { name: "Delegate's user ID" }), 'arvind.rao');
    await userEvent.click(within(form).getByRole('checkbox', { name: 'Manufacturer release (MANUFACTURER_RELEASE)' }));
    await userEvent.click(within(form).getByRole('checkbox', { name: 'IN' }));
    await userEvent.type(within(form).getByRole('textbox', { name: /^Valid from/ }), '2026-11-01T00:00:00+05:30');
    await userEvent.type(within(form).getByRole('textbox', { name: /^Valid to/ }), '2026-11-15T23:59:00+05:30');
    await userEvent.type(within(form).getByRole('textbox', { name: /SOP reference/ }), 'SOP-QA-017');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Reason' }), 'annual leave');
    await userEvent.click(within(form).getByRole('button', { name: 'Request the delegation' }));
    await waitFor(() => expect(ui.posts('/api/admin/delegations')).toHaveLength(1));
    expect(ui.posts('/api/admin/delegations')[0]?.body).toEqual({
      delegateLoginName: 'arvind.rao', scope: {}, markets: ['IN'], meanings: ['MANUFACTURER_RELEASE'], validFrom: '2026-11-01T00:00:00+05:30', validTo: '2026-11-15T23:59:00+05:30', sopRef: 'SOP-QA-017', reason: 'annual leave',
    });
  });

  it('[DI-35][DI-18] an approver who is not involved approves; the database\'s refusal is shown in its words', async () => {
    const ui = renderOffice('/admin/delegations', {
      role: 'PROCESS_OWNER',
      fixtures: {
        'session.get': sessionAs(OMAR, 'PROCESS_OWNER'),
        'accessGovernance.delegations': delegations('REQUESTED', true),
        'accessGovernance.decideDelegation': () => refusal('EBMR-IAM-181', 'no re-delegation: the delegator holds these meanings only by delegation'),
      },
    });
    const item = await screen.findByTestId('delegation-arvind.rao-SOP-QA-017');
    await userEvent.type(within(item).getByRole('textbox', { name: 'Reason (delegation Shalini Kapoor to Arvind Rao)' }), 'SOP followed');
    await userEvent.click(within(item).getByRole('button', { name: 'Approve the delegation Shalini Kapoor to Arvind Rao' }));
    await waitFor(() => expect(ui.posts(`/api/admin/delegations/${DELEGATION}/decision`)).toHaveLength(1));
    expect(ui.posts(`/api/admin/delegations/${DELEGATION}/decision`)[0]?.body).toEqual({ approve: true, reason: 'SOP followed' });
    expect(await within(item).findByText('no re-delegation: the delegator holds these meanings only by delegation')).toBeTruthy();
  });

  it('[DI-35] the delegate is offered neither the decision nor the revocation; the delegator revokes an approved one', async () => {
    renderOffice('/admin/delegations', { role: 'QA_REVIEWER', fixtures: { 'session.get': sessionAs(ARVIND, 'QA_REVIEWER'), 'accessGovernance.delegations': delegations('APPROVED', true) } });
    const item = await screen.findByTestId('delegation-arvind.rao-SOP-QA-017');
    expect(item.getAttribute('data-status')).toBe('APPROVED');
    expect(item.textContent).toContain('In force');
    // The delegate holds the approval permission here, yet only an approver or the delegator revokes; nothing to decide.
    expect(within(item).queryByRole('button', { name: /^Approve/ })).toBeNull();
    cleanup();
    const ui = renderOffice('/admin/delegations', {
      role: 'AUTHORISED_PERSON',
      fixtures: { 'session.get': sessionAs(SHALINI, 'AUTHORISED_PERSON'), 'accessGovernance.delegations': delegations('APPROVED', false), 'accessGovernance.revokeDelegation': delegation('APPROVED') },
    });
    const mine = await screen.findByTestId('delegation-arvind.rao-SOP-QA-017');
    await userEvent.type(within(mine).getByRole('textbox', { name: 'Reason (delegation Shalini Kapoor to Arvind Rao)' }), 'back from leave');
    await userEvent.click(within(mine).getByRole('button', { name: 'Revoke the delegation Shalini Kapoor to Arvind Rao' }));
    await waitFor(() => expect(ui.posts(`/api/admin/delegations/${DELEGATION}/revocation`)).toHaveLength(1));
    expect(ui.posts(`/api/admin/delegations/${DELEGATION}/revocation`)[0]?.body).toEqual({ reason: 'back from leave' });
  });
});

describe('the US e-signature certification', () => {
  it('[DI-15] the process owner records the letter; the page says whether a legal entity without one is blocked', async () => {
    const ui = renderOffice('/admin/us-esig-certification', {
      role: 'PROCESS_OWNER',
      fixtures: {
        'session.get': sessionAs(OMAR, 'PROCESS_OWNER'),
        'accessGovernance.usEsigCertifications': ({ query }: { query: Record<string, string> }) => certifications(query['legalEntity']),
        'accessGovernance.recordUsEsigCertification': certifications().certifications[0],
      },
    });
    expect(await screen.findByText('Policy: a US-market batch is not issued without a letter on file.')).toBeTruthy();
    expect((await screen.findByTestId('us-esig-CERT-2026-001')).textContent).toContain('Batchwright Pharma Pvt Ltd: letter CERT-2026-001, submitted on 2026-03-02');
    await userEvent.type(within(screen.getByTestId('us-esig-status')).getByRole('textbox', { name: 'Legal entity' }), 'Other Entity Ltd');
    const result = await screen.findByTestId('us-esig-status-result');
    expect(result.getAttribute('data-on-file')).toBe('false');
    expect(result.textContent).toContain('US-market work blocked');
    const form = screen.getByTestId('us-esig-record');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Legal entity (as named in the letter)' }), 'Batchwright Pharma Pvt Ltd');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Letter reference' }), 'CERT-2026-001');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Submitted on (YYYY-MM-DD)' }), '2026-03-02');
    await userEvent.click(within(form).getByRole('button', { name: 'Record the letter' }));
    await waitFor(() => expect(ui.posts('/api/admin/us-esig-certifications')).toHaveLength(1));
    expect(ui.posts('/api/admin/us-esig-certifications')[0]?.body).toEqual({ legalEntity: 'Batchwright Pharma Pvt Ltd', letterRef: 'CERT-2026-001', submittedOn: '2026-03-02' });
  });

  it('[DI-15] the system administrator is not offered the record', async () => {
    renderOffice('/admin/us-esig-certification', { role: 'SYSTEM_ADMINISTRATOR', fixtures: { 'session.get': sessionAs(IRA, 'SYSTEM_ADMINISTRATOR'), 'accessGovernance.usEsigCertifications': certifications() } });
    await screen.findByTestId('us-esig-CERT-2026-001');
    expect(screen.queryByTestId('us-esig-record')).toBeNull();
  });
});
