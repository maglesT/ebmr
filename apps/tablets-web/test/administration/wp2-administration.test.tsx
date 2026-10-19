/**
 * The administration, integrations and transfers screens of slice 7g, work package 2 on test answers: security alerts
 * (never offered to the person an alert is about), a role created with no permission, a rehire, the qualification matrix
 * (the training coordinator's), the device configuration (attribution, hardening revocation, OPC UA endpoints, a process
 * device's unit), an adapter's status and QA's revocation of a peer. The server tests prove the refusals.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { type DeviceConfigurationView, type Instant, type QualificationsView, type SecurityAlertView } from '@ebmr/api-contract';
import { apiState } from '../../src/api/client.ts';
import { ME, render7g } from '../operations/wp2-support.tsx';
import { directory, registry } from './fixtures.ts';

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

const at = (us: string): Instant => ({ us, text: `18-OCT-2026 10:${us.slice(-2)}:00 +05:30 (Asia/Kolkata)` });
const ref = (personId: string, legalName: string) => ({ personId, legalName, loginName: legalName.toLowerCase().replace(' ', '.'), role: '' });
const OTHER = '0b8f1c2a-7777-4c7d-8e9f-0a1b2c3d4e77';

describe('security alerts (DI-19)', () => {
  it('[DI-19] an alert about another person is acknowledged with a comment; an alert about the person signed in is not offered to them', async () => {
    const alert = (id: string, personId: string, legalName: string): SecurityAlertView => ({
      alertId: id, kind: 'AUTHENTICATION_FAILED', severity: 'MEDIUM', loginName: 'x', person: ref(personId, legalName), deviceCode: 'PC-QA-03', details: '{}', raisedAt: at('1000000000000001'), escalated: id.endsWith('2'), acknowledgement: null,
    });
    const ABOUT_ME = '0b8f1c2a-0001-4c7d-8e9f-0a1b2c3d4e01';
    const ABOUT_OTHER = '0b8f1c2a-0002-4c7d-8e9f-0a1b2c3d4e02';
    const ui = render7g('/admin/security-alerts', {
      role: 'SYSTEM_ADMINISTRATOR',
      fixtures: { 'people.alerts': { alerts: [alert(ABOUT_ME, ME, 'Ira Admin'), alert(ABOUT_OTHER, OTHER, 'Lena Fischer')] }, 'people.acknowledgeAlert': alert(ABOUT_OTHER, OTHER, 'Lena Fischer') },
    });
    const mine = await screen.findByTestId(`alert-${ABOUT_ME}`);
    expect(mine.textContent).toContain('This alert is about you');
    expect(within(mine).queryByRole('button', { name: 'Acknowledge' })).toBeNull();
    const other = screen.getByTestId(`alert-${ABOUT_OTHER}`);
    expect(other.textContent).toContain('Escalated');
    await userEvent.type(within(other).getByRole('textbox', { name: /What was found/ }), 'mistyped password');
    await userEvent.click(within(other).getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(ui.posts(`/api/admin/security-alerts/${ABOUT_OTHER}/acknowledgement`)).toHaveLength(1));
    expect(ui.posts(`/api/admin/security-alerts/${ABOUT_OTHER}/acknowledgement`)[0]?.body).toEqual({ comment: 'mistyped password' });
  });
});

describe('roles and people', () => {
  it('[DI-18][DI-17] the administrator creates a role with no permission (its permissions are requested afterwards); a person who left is rehired with the reason', async () => {
    const ui = render7g('/admin/role-permissions', {
      role: 'SYSTEM_ADMINISTRATOR',
      fixtures: { 'accessGovernance.rolePermissions': { roles: [], permissions: [], requests: [] }, 'people.createRole': { code: 'LINE_LEAD', name: 'Line lead', group: 'EXECUTION', accountKinds: ['HUMAN'] } },
    });
    const form = await screen.findByTestId('role-create');
    await userEvent.click(within(form).getByText('Create a role'));
    await userEvent.type(within(form).getByRole('textbox', { name: /Code/ }), 'line_lead');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Name' }), 'Line lead');
    await userEvent.selectOptions(within(form).getByLabelText('Group'), 'EXECUTION');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Description' }), 'Leads a line');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Reason' }), 'new hall');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Change record approved for roles' }), 'CR-7');
    await userEvent.click(within(form).getByRole('button', { name: 'Create the role' }));
    await waitFor(() => expect(ui.posts('/api/admin/roles')).toHaveLength(1));
    expect(ui.posts('/api/admin/roles')[0]?.body).toEqual({ code: 'LINE_LEAD', name: 'Line lead', group: 'EXECUTION', description: 'Leads a line', accountKinds: ['HUMAN'], reason: 'new hall', changeRecord: 'CR-7' });
    cleanup();

    const left = { ...directory.people[0]!, status: 'LEFT' as const };
    const people = render7g('/admin/people', { role: 'SYSTEM_ADMINISTRATOR', fixtures: { 'people.directory': { ...directory, people: [left] }, 'people.rehirePerson': { ...left, status: 'ACTIVE' } } });
    const card = await screen.findByTestId(`person-${left.legalName}`);
    await userEvent.click(within(card).getByText(`Rehire ${left.legalName}`, { selector: 'summary' }));
    await userEvent.type(within(card).getByRole('textbox', { name: 'Reason' }), 'rejoined');
    await userEvent.click(within(card).getByRole('button', { name: `Rehire ${left.legalName}` }));
    await waitFor(() => expect(people.posts(`/api/admin/people/${left.personId}/rehire`)).toHaveLength(1));
    expect(people.posts(`/api/admin/people/${left.personId}/rehire`)[0]?.body).toEqual({ reason: 'rejoined' });
  });
});

const quals = (): QualificationsView => ({
  types: [{ code: 'GMP.BASIC', name: 'GMP basics', description: 'Basic GMP training' }],
  requirements: [{ requirementId: '0b8f1c2a-0003-4c7d-8e9f-0a1b2c3d4e03', qualificationCode: 'GMP.BASIC', roleCode: 'OPERATOR', permissionCode: null, scope: { site: null, area: null, product: null }, reason: 'all operators', effectiveFrom: at('1000000000000002'), effectiveTo: null, createdBy: ref(OTHER, 'Tara Trainer') }],
  roles: [{ code: 'OPERATOR', name: 'Operator', group: 'EXECUTION', accountKinds: ['HUMAN'] }],
  permissions: ['STEP.EXECUTE'],
});

describe('the qualification matrix', () => {
  it('[DI-17] the training coordinator adds a type and a requirement for a role, and ends a requirement with the reason; the administrator is offered none of these', async () => {
    const ui = render7g('/admin/qualifications', {
      role: 'TRAINING_COORDINATOR',
      fixtures: { 'people.qualifications': quals(), 'people.createQualificationType': quals().types[0], 'people.addQualificationRequirement': quals().requirements[0], 'people.endQualificationRequirement': quals().requirements[0] },
    });
    const add = await screen.findByTestId('qualification-type-add');
    await userEvent.type(within(add).getByRole('textbox', { name: /Code/ }), 'gmp.adv');
    await userEvent.type(within(add).getByRole('textbox', { name: 'Name' }), 'Advanced GMP');
    await userEvent.type(within(add).getByRole('textbox', { name: 'Description' }), 'For QA');
    await userEvent.click(within(add).getByRole('button', { name: 'Add the qualification type' }));
    await waitFor(() => expect(ui.posts('/api/admin/qualification-types')).toHaveLength(1));
    expect(ui.posts('/api/admin/qualification-types')[0]?.body).toEqual({ code: 'GMP.ADV', name: 'Advanced GMP', description: 'For QA' });

    const req = screen.getByTestId('qualification-requirement-add');
    await userEvent.selectOptions(within(req).getByLabelText('Qualification'), 'GMP.BASIC');
    await userEvent.selectOptions(within(req).getByLabelText('Role'), 'OPERATOR');
    await userEvent.type(within(req).getByRole('textbox', { name: 'Area (optional)' }), 'GRAN-1');
    await userEvent.type(within(req).getByRole('textbox', { name: 'Reason' }), 'granulation operators');
    await userEvent.click(within(req).getByRole('button', { name: 'Add the requirement' }));
    await waitFor(() => expect(ui.posts('/api/admin/qualification-requirements')).toHaveLength(1));
    expect(ui.posts('/api/admin/qualification-requirements')[0]?.body).toEqual({ qualificationCode: 'GMP.BASIC', roleCode: 'OPERATOR', scope: { area: 'GRAN-1' }, reason: 'granulation operators' });

    const row = screen.getByTestId('requirement-0b8f1c2a-0003-4c7d-8e9f-0a1b2c3d4e03');
    await userEvent.type(within(row).getByRole('textbox', { name: /Reason to end/ }), 'new curriculum');
    await userEvent.click(within(row).getByRole('button', { name: 'End the requirement' }));
    await waitFor(() => expect(ui.posts('/api/admin/qualification-requirements/0b8f1c2a-0003-4c7d-8e9f-0a1b2c3d4e03/end')).toHaveLength(1));
    cleanup();
    render7g('/admin/qualifications', { role: 'SYSTEM_ADMINISTRATOR', fixtures: { 'people.qualifications': quals() } });
    await screen.findByTestId('qualification-requirements');
    expect(screen.queryByTestId('qualification-type-add')).toBeNull();
    expect(screen.queryByRole('button', { name: 'End the requirement' })).toBeNull();
  });
});

const config = (): DeviceConfigurationView => ({
  attribution: [{ deviceClass: 'SHARED', method: 'TAP' }, { deviceClass: 'GRADE_A_B', method: 'TAP_PIN' }],
  opcuaEndpoints: [{ deviceCode: 'OPC-1', version: 1, status: 'ENROLLED', endpointUrl: 'opc.tcp://press.plant.local:4840', securityPolicy: 'Basic256Sha256', certificateThumbprint: 'ab'.repeat(32), equipmentCodes: ['PRESS-01'], reason: 'commissioned', recordedBy: ref(ME, 'Ira Admin'), recordedAt: at('1000000000000005') }],
  processDeviceUnits: [{ bindingId: '0b8f1c2a-0004-4c7d-8e9f-0a1b2c3d4e04', deviceCode: 'PRS-DEV-1', equipmentCode: null }],
});

describe('the device configuration', () => {
  it('[DI-19][DI-20][DI-31] the administrator sets a kiosk class\'s attribution, revokes a hardening attestation, retires an OPC UA endpoint and links a process device to its unit, each with the reason', async () => {
    const attested = { ...registry.terminals[0]!, hardening: { attestationId: '0b8f1c2a-0005-4c7d-8e9f-0a1b2c3d4e05', result: 'PASS', method: 'MANUAL_INSPECTION', evidenceRef: 'INSP-1', validUntil: null, attestedBy: ref(ME, 'Ira Admin') } };
    const ui = render7g('/admin/device-configuration', {
      role: 'SYSTEM_ADMINISTRATOR',
      fixtures: {
        'deviceRegistry.configuration': config(),
        'deviceRegistry.list': { ...registry, terminals: [attested, ...registry.terminals.slice(1)] },
        'deviceRegistry.setAttributionMethod': config(),
        'deviceRegistry.revokeHardening': registry.terminals[0],
        'deviceRegistry.retireOpcuaEndpoint': { ...config().opcuaEndpoints[0]!, version: 2, status: 'RETIRED' },
        'deviceRegistry.linkProcessDeviceUnit': config(),
      },
    });
    expect((await screen.findByTestId('attribution-GRADE_A_B')).textContent).toContain('a badge tap and a PIN');
    const attr = screen.getByTestId('attribution');
    await userEvent.selectOptions(within(attr).getByLabelText('Kiosk class'), 'SHARED');
    await userEvent.selectOptions(within(attr).getByLabelText('Attribution'), 'TAP_PIN');
    await userEvent.type(within(attr).getByRole('textbox', { name: 'Reason' }), 'D8 review');
    await userEvent.click(within(attr).getByRole('button', { name: 'Set the attribution' }));
    await waitFor(() => expect(ui.posts('/api/admin/attribution-methods')).toHaveLength(1));
    expect(ui.posts('/api/admin/attribution-methods')[0]?.body).toEqual({ deviceClass: 'SHARED', method: 'TAP_PIN', reason: 'D8 review' });

    const kiosk = await screen.findByTestId(`attested-${attested.code}`);
    await userEvent.type(within(kiosk).getByRole('textbox', { name: /Reason to revoke/ }), 'USB open');
    await userEvent.click(within(kiosk).getByRole('button', { name: `Revoke the attestation of ${attested.code}` }));
    await waitFor(() => expect(ui.posts('/api/admin/hardening-attestations/0b8f1c2a-0005-4c7d-8e9f-0a1b2c3d4e05/revocation')).toHaveLength(1));

    const endpoint = screen.getByTestId('opcua-OPC-1');
    await userEvent.type(within(endpoint).getByRole('textbox', { name: /Reason to retire/ }), 'press replaced');
    await userEvent.click(within(endpoint).getByRole('button', { name: 'Retire OPC-1' }));
    await waitFor(() => expect(ui.posts('/api/admin/opcua-endpoints/OPC-1/retirement')).toHaveLength(1));

    const unit = screen.getByTestId('process-unit-PRS-DEV-1');
    await userEvent.type(within(unit).getByRole('textbox', { name: 'Plant unit of PRS-DEV-1' }), 'PRESS-01');
    await userEvent.type(within(unit).getByRole('textbox', { name: 'Reason' }), 'press controller');
    await userEvent.click(within(unit).getByRole('button', { name: 'Link PRS-DEV-1' }));
    await waitFor(() => expect(ui.posts('/api/admin/device-bindings/0b8f1c2a-0004-4c7d-8e9f-0a1b2c3d4e04/unit')).toHaveLength(1));
    expect(ui.posts('/api/admin/device-bindings/0b8f1c2a-0004-4c7d-8e9f-0a1b2c3d4e04/unit')[0]?.body).toEqual({ equipmentCode: 'PRESS-01', reason: 'press controller' });
  });

  it('[DI-20] an OPC UA endpoint is enrolled with its URL, security policy and units; the process owner is offered no device act', async () => {
    const ui = render7g('/admin/device-configuration', { role: 'SYSTEM_ADMINISTRATOR', fixtures: { 'deviceRegistry.configuration': config(), 'deviceRegistry.list': registry, 'deviceRegistry.enrolOpcuaEndpoint': config().opcuaEndpoints[0] } });
    const section = await screen.findByTestId('opcua-endpoints');
    await userEvent.type(within(section).getByRole('textbox', { name: 'Instrument code' }), 'OPC-2');
    await userEvent.type(within(section).getByRole('textbox', { name: /Endpoint URL/ }), 'opc.tcp://coater.plant.local:4840');
    await userEvent.selectOptions(within(section).getByLabelText(/Security policy/), 'Aes256_Sha256_RsaPss');
    await userEvent.type(within(section).getByRole('textbox', { name: /Units it serves/ }), 'COATER-01, COATER-02');
    await userEvent.type(within(section).getAllByRole('textbox', { name: 'Reason' }).at(-1)!, 'commissioning');
    await userEvent.click(within(section).getByRole('button', { name: 'Enrol the endpoint' }));
    await waitFor(() => expect(ui.posts('/api/admin/opcua-endpoints')).toHaveLength(1));
    expect(ui.posts('/api/admin/opcua-endpoints')[0]?.body).toEqual({ deviceCode: 'OPC-2', endpointUrl: 'opc.tcp://coater.plant.local:4840', securityPolicy: 'Aes256_Sha256_RsaPss', equipmentCodes: ['COATER-01', 'COATER-02'], reason: 'commissioning' });
    cleanup();
    render7g('/admin/device-configuration', { role: 'PROCESS_OWNER', fixtures: { 'deviceRegistry.configuration': config(), 'deviceRegistry.list': registry } });
    await screen.findByTestId('opcua-endpoints');
    expect(screen.queryByRole('button', { name: 'Enrol the endpoint' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Set the attribution' })).toBeNull();
  });
});

describe('an adapter\'s status and a peer\'s revocation', () => {
  it('[DI-31] the administrator blocks an adapter with the reason on its page', async () => {
    const ui = render7g('/integrations/OPCUA-T-1', { role: 'SYSTEM_ADMINISTRATOR', fixtures: { 'deviceRegistry.setAdapterStatus': registry.adapters[0] } });
    const panel = await screen.findByTestId('adapter-status');
    await userEvent.selectOptions(within(panel).getByLabelText('New status'), 'BLOCKED');
    await userEvent.type(within(panel).getByRole('textbox', { name: 'Reason' }), 'certificate expired');
    await userEvent.click(within(panel).getByRole('button', { name: 'Change the status' }));
    await waitFor(() => expect(ui.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/status'))).toHaveLength(1));
    expect(ui.requests.find((r) => r.method === 'POST' && r.path.endsWith('/status'))?.body).toEqual({ status: 'BLOCKED', reason: 'certificate expired' });
  });

  it('[DI-31] QA revokes an approved peer with a reason of at least 10 characters', async () => {
    const PEER = '0b8f1c2a-0006-4c7d-8e9f-0a1b2c3d4e06';
    const peer = { peerId: PEER, installationCode: 'GOA-TAB-GMP', siteCode: 'GOA-1', edition: 'TABLETS' as const, baseUrl: 'https://goa.example.internal', keyFingerprint: 'ab'.repeat(32), state: 'APPROVED' as const, proposedBy: ref(ME, 'Ira Admin'), proposedAt: at('1000000000000007'), approvedBy: ref(OTHER, 'Divya Menon'), approvedAt: at('1000000000000008') };
    const ui = render7g('/transfers', { role: 'QA_REVIEWER', fixtures: { 'transfers.peers': { installation: null, peers: [peer] }, 'transfers.revokePeer': { ...peer, state: 'REVOKED' } } });
    const box = await screen.findByTestId('peer-revoke-GOA-TAB-GMP');
    const button = within(box).getByRole('button', { name: 'Revoke GOA-TAB-GMP' });
    await userEvent.type(within(box).getByRole('textbox', { name: /Reason to revoke/ }), 'sold');
    expect(button.hasAttribute('disabled')).toBe(true);
    await userEvent.type(within(box).getByRole('textbox', { name: /Reason to revoke/ }), ' to another company');
    await userEvent.click(button);
    await waitFor(() => expect(ui.posts(`/api/transfers/peers/${PEER}/revocation`)).toHaveLength(1));
    expect(ui.posts(`/api/transfers/peers/${PEER}/revocation`)[0]?.body).toEqual({ reason: 'sold to another company' });
  });
});
