/**
 * Answers of the administration routes for the screen tests (slice 7g-1), each parsed with its route's response schema
 * so a fixture the server could not give fails here.
 */
import { routes, type SessionView } from '@ebmr/api-contract';
import { EXAMPLES } from '@ebmr/api-contract/examples';

const at = (us: string, text: string) => ({ us, text });
const T1 = at('1767600000000000', '05 Jan 2026, 13:30 IST');
const T2 = at('1767686400000000', '06 Jan 2026, 13:30 IST');

export const ME = '0b8f1c2a-1111-4c7d-8e9f-0a1b2c3d4e01';
export const OWNER = '0b8f1c2a-2222-4c7d-8e9f-0a1b2c3d4e02';
const LENA = '0b8f1c2a-3333-4c7d-8e9f-0a1b2c3d4e03';
const LENA_ACCOUNT = '0b8f1c2a-4444-4c7d-8e9f-0a1b2c3d4e04';
const BG_ACCOUNT = '0b8f1c2a-5555-4c7d-8e9f-0a1b2c3d4e05';
const VERIFICATION = '0b8f1c2a-6666-4c7d-8e9f-0a1b2c3d4e06';
const BADGE = '0b8f1c2a-7777-4c7d-8e9f-0a1b2c3d4e07';

const ref = (personId: string, legalName: string, loginName: string, role = '') => ({ personId, legalName, loginName, role });
export const IRA = ref(ME, 'Ira Admin', 'ira.admin', 'SYSTEM_ADMINISTRATOR');
export const OMAR = ref(OWNER, 'Omar Owner', 'omar.owner', 'PROCESS_OWNER');

/** The session of `person` in `role` (the office example otherwise). */
export function sessionAs(person: { personId: string; legalName: string; loginName: string }, role: string): SessionView {
  const base = EXAMPLES['session-office'].data as SessionView;
  return { ...base, person: { ...person, role }, role, roles: [role] };
}

export const directory = routes.people.directory.response.parse({
  siteCode: 'SITE-1',
  badgeTechnologies: ['ISO14443_DESFIRE_EV3', 'LF_125KHZ_PROX'],
  people: [
    {
      personId: LENA,
      kind: 'NATURAL',
      legalName: 'Lena Fischer',
      employeeRef: 'E-1001',
      status: 'ACTIVE',
      createdAt: T1,
      verifications: [{ verificationId: VERIFICATION, purpose: 'INITIAL', method: 'IN_PERSON_DOCUMENT', documentType: 'Employee ID card', verifiedBy: IRA, occurredAt: T1 }],
      accounts: [
        {
          accountId: LENA_ACCOUNT,
          loginName: 'lena.fischer',
          kind: 'HUMAN',
          generic: false,
          breakGlass: false,
          status: 'PENDING_ACTIVATION',
          statusReason: null,
          locked: true,
          credentials: [{ credentialId: '0b8f1c2a-8888-4c7d-8e9f-0a1b2c3d4e08', kind: 'PASSWORD', origin: 'INITIAL', mustChange: true, status: 'ACTIVE', issuedAt: T1, expiresAt: T2 }],
          badges: [{ badgeId: BADGE, label: 'B-lena', technology: 'ISO14443_DESFIRE_EV3', status: 'ISSUED', issuedAt: T1, lastTest: null }],
          roles: [],
        },
      ],
    },
    {
      personId: ME,
      kind: 'NATURAL',
      legalName: 'Ira Admin',
      employeeRef: null,
      status: 'ACTIVE',
      createdAt: T1,
      verifications: [],
      accounts: [
        { accountId: '0b8f1c2a-9999-4c7d-8e9f-0a1b2c3d4e09', loginName: 'ira.admin', kind: 'HUMAN', generic: false, breakGlass: false, status: 'ACTIVE', statusReason: null, locked: false, credentials: [], badges: [], roles: ['SYSTEM_ADMINISTRATOR'] },
        { accountId: BG_ACCOUNT, loginName: 'bg.ira', kind: 'HUMAN', generic: false, breakGlass: true, status: 'ACTIVE', statusReason: null, locked: false, credentials: [], badges: [], roles: ['BREAK_GLASS_ADMIN'] },
      ],
    },
  ],
});

const grant = (id: string, roleCode: string, requestedBy: typeof IRA, status: 'REQUESTED' | 'APPROVED') => ({
  grantId: id,
  accountId: LENA_ACCOUNT,
  loginName: 'lena.fischer',
  grantee: ref(LENA, 'Lena Fischer', 'lena.fischer', roleCode),
  roleCode,
  roleName: roleCode === 'MBR_CHECKER' ? 'MBR checker' : 'MBR author',
  scope: { site: null, area: null, product: null },
  validFrom: null,
  validTo: null,
  reason: 'new starter',
  status,
  live: status === 'APPROVED',
  requestedBy,
  requestedAt: T1,
  decidedBy: status === 'APPROVED' ? OMAR : null,
  decidedAt: status === 'APPROVED' ? T2 : null,
  decisionReason: status === 'APPROVED' ? 'approved' : null,
  revokedBy: null,
  revokedAt: null,
  revocationReason: null,
});
export const GRANT_BY_IRA = '0b8f1c2a-aaaa-4c7d-8e9f-0a1b2c3d4e0a';
export const GRANT_BY_OMAR = '0b8f1c2a-bbbb-4c7d-8e9f-0a1b2c3d4e0b';

export const grants = routes.people.grants.response.parse({
  grants: [grant(GRANT_BY_IRA, 'MBR_CHECKER', IRA, 'REQUESTED'), grant(GRANT_BY_OMAR, 'MBR_AUTHOR', OMAR, 'REQUESTED')],
  roles: [
    { code: 'MBR_CHECKER', name: 'MBR checker', group: 'GMP', accountKinds: ['HUMAN'] },
    { code: 'SYSTEM_ADMINISTRATOR', name: 'System administrator', group: 'ADMIN', accountKinds: ['HUMAN'] },
  ],
});

export const recertification = routes.people.recertification.response.parse({
  due: [{ accountId: LENA_ACCOUNT, loginName: 'lena.fischer', person: ref(LENA, 'Lena Fischer', 'lena.fischer'), lastRecertifiedAt: null, dueAt: T1, overdue: true, roles: ['MBR_CHECKER'] }],
  recent: [],
});

const window = (id: string, requestedBy: typeof IRA, state: 'REQUESTED' | 'ENDED') => ({
  windowId: id,
  accountId: BG_ACCOUNT,
  loginName: 'bg.ira',
  holder: ref(ME, 'Ira Admin', 'bg.ira', 'BREAK_GLASS_ADMIN'),
  reason: 'database restore after outage',
  minutes: 30,
  requestedBy,
  requestedAt: T1,
  approvedBy: state === 'ENDED' ? OMAR : null,
  approvedAt: state === 'ENDED' ? T1 : null,
  validTo: state === 'ENDED' ? T2 : null,
  state,
  review: null,
});
export const WINDOW_REQUESTED = '0b8f1c2a-cccc-4c7d-8e9f-0a1b2c3d4e0c';
export const WINDOW_ENDED = '0b8f1c2a-dddd-4c7d-8e9f-0a1b2c3d4e0d';
export const breakGlass = routes.people.breakGlass.response.parse({ windows: [window(WINDOW_REQUESTED, IRA, 'REQUESTED'), window(WINDOW_ENDED, IRA, 'ENDED')] });

export const ISSUED = routes.people.issueCredential.response.parse({ credentialId: '0b8f1c2a-eeee-4c7d-8e9f-0a1b2c3d4e0e', accountId: LENA_ACCOUNT, loginName: 'lena.fischer', kind: 'PASSWORD', secret: 'Kq7mPz2xWv9rTs4n', expiresAt: T2 });

const KIOSK = '0b8f1c2a-0001-4c7d-8e9f-0a1b2c3d4e10';
const PC = '0b8f1c2a-0002-4c7d-8e9f-0a1b2c3d4e11';
const GW = '0b8f1c2a-0003-4c7d-8e9f-0a1b2c3d4e12';
const BAL = '0b8f1c2a-0004-4c7d-8e9f-0a1b2c3d4e13';
export const KEY = '0b8f1c2a-0005-4c7d-8e9f-0a1b2c3d4e14';
const terminal = (deviceId: string, code: string, deviceClass: 'PERSONAL' | 'SHARED' | 'SERVER' | 'INSTRUMENT', roomCode: string | null) => ({
  deviceId,
  code,
  deviceClass,
  siteCode: 'SITE-1',
  roomCode,
  lineCode: null,
  status: 'ACTIVE',
  statusReason: null,
  fingerprint: 'ab'.repeat(32),
  description: `${code} description`,
  registeredBy: IRA,
  registeredAt: T1,
  hardening: null,
  hardeningRequired: deviceClass === 'SHARED',
});
export const registry = routes.deviceRegistry.list.response.parse({
  siteCode: 'SITE-1',
  terminals: [terminal(KIOSK, 'KIOSK-T-1', 'SHARED', 'DISP-1'), terminal(PC, 'PC-T-1', 'PERSONAL', null), terminal(GW, 'GW-T-1', 'SERVER', null), terminal(BAL, 'BAL-T-1', 'INSTRUMENT', 'DISP-1')],
  gatewayKeys: [{ keyId: KEY, gatewayCode: 'GW-T-1', loginName: 'gw.t1', fingerprint: 'ab'.repeat(32), status: 'ACTIVE', enrolledBy: IRA, enrolledAt: T1, revokedAt: null, revokedReason: null }],
  bindings: [],
  adapters: [{ adapterId: '0b8f1c2a-0006-4c7d-8e9f-0a1b2c3d4e15', code: 'OPCUA-T-1', sourceSystem: 'OPCUA', loginName: 'gw.t1', deviceCode: 'GW-T-1', status: 'ACTIVE', description: 'OPC UA feed', registeredBy: IRA, registeredAt: T1, feed: null }],
  integrationAccounts: [{ accountId: '0b8f1c2a-0007-4c7d-8e9f-0a1b2c3d4e16', loginName: 'gw.t1', status: 'ACTIVE' }],
  sourceSystems: ['ERP_WMS', 'OPCUA'],
});

export const ADMIN_FIXTURES = {
  'people.directory': directory,
  'people.grants': grants,
  'people.recertification': recertification,
  'people.breakGlass': breakGlass,
  'deviceRegistry.list': registry,
  'people.issueCredential': ISSUED,
  'people.createPerson': directory.people[0],
  'people.issueBadge': directory.people[0],
  'people.recordBadgeTest': directory.people[0],
  'people.decideGrant': grants.grants[1],
  'people.requestGrant': grants.grants[0],
  'people.recertify': { recertificationId: '0b8f1c2a-0008-4c7d-8e9f-0a1b2c3d4e17' },
  'people.requestBreakGlass': breakGlass.windows[0],
  'people.approveBreakGlass': breakGlass.windows[0],
  'deviceRegistry.registerTerminal': registry.terminals[1],
  'deviceRegistry.attestHardening': registry.terminals[0],
  'deviceRegistry.enrolGatewayKey': registry.gatewayKeys[0],
  'deviceRegistry.bindGatewayFeed': registry.adapters[0],
  'deviceRegistry.bindDevice': { bindingId: '0b8f1c2a-0009-4c7d-8e9f-0a1b2c3d4e18', kind: 'BALANCE', deviceCode: 'BAL-T-1', gatewayCode: 'GW-T-1', gatewayKeyId: KEY, serial: 'SN1', detail: 'kg, resolution 0.001', boundBy: IRA, boundAt: T1, endedAt: null, endedReason: null },
};
