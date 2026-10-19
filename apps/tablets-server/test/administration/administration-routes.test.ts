/**
 * The administration routes of slice 7g-1 (decision 0025; feature administration, contract ns/people.ts and
 * ns/device-registry.ts) over HTTP with real sessions: the database decides every act. The system administrator records
 * people, accounts, credentials and badges and requests grants; a second person (the process owner) approves; a GMP
 * role holder is refused every administration act and read; nobody approves their own request; an initial secret is
 * returned once and never again; devices, gateway keys and the gateway feed binding are registered by the
 * administrator.
 */
import { generateKeyPairSync, createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type Result } from '@ebmr/api-contract';
import { grantedPerson, loginOf } from '../support/granted-person.ts';
import { startServer, type TestBrowser, type TestServer } from '../support/harness.ts';

const P = routes.people;
const D = routes.deviceRegistry;
let server: TestServer;
let admin: TestBrowser;
let owner: TestBrowser;
let qa: TestBrowser;

const valueOf = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`expected success, got ${JSON.stringify(r.error)}`);
  return r.value;
};
const codeOf = (r: Result<unknown>): string => (r.ok ? 'OK' : r.error.kind === 'REFUSAL' ? r.error.envelope.refusal.code : JSON.stringify(r.error));
const whyOf = (r: Result<unknown>): string => (!r.ok && r.error.kind === 'REFUSAL' ? r.error.envelope.refusal.why : '');
const suffix = () => randomUUID().slice(0, 8);

beforeAll(async () => {
  server = await startServer('GMP');
  admin = await loginOf(server, await grantedPerson(server, 'SYSTEM_ADMINISTRATOR', 'Ira Admin'));
  owner = await loginOf(server, await grantedPerson(server, 'PROCESS_OWNER', 'Omar Owner'));
  qa = await server.asPersona('approver');
}, 300_000);
afterAll(async () => {
  await server?.close();
});

/** A person with a verified identity and an active HUMAN account, through the routes (the administrator's acts). */
async function newPersonWithAccount(name: string, loginName: string, breakGlassFor?: string) {
  const person = breakGlassFor ?? valueOf(await admin.call(P.createPerson, { body: { kind: 'NATURAL', legalName: name } })).personId;
  if (!breakGlassFor) {
    valueOf(await admin.call(P.verifyIdentity, { params: { personId: person }, body: { purpose: 'INITIAL', method: 'IN_PERSON_DOCUMENT', documentType: 'Employee ID card', evidenceRef: `HR-${loginName}`, occurredAt: '2026-01-05T00:00:00Z' } }));
  }
  const view = valueOf(await admin.call(P.createAccount, { body: { personId: person, loginName, kind: 'HUMAN', generic: false, breakGlass: breakGlassFor !== undefined } }));
  const account = view.accounts.find((a) => a.loginName === loginName)!;
  return { personId: person, accountId: account.accountId };
}

describe('people and access over HTTP', () => {
  it('[DI-14][DI-15][DI-16] the administrator records a person, verifies the identity, opens and activates an account and issues an initial password returned once; the person changes it at the first sign-in', async () => {
    const login = `lena.${suffix()}`;
    const { personId, accountId } = await newPersonWithAccount('Lena Fischer', login);
    // Activation before the credential is fine; the credential is shown once, and the directory shows metadata only.
    valueOf(await admin.call(P.activateAccount, { params: { accountId }, body: { reason: 'new starter' } }));
    const issued = valueOf(await admin.call(P.issueCredential, { params: { accountId }, body: { kind: 'PASSWORD', reason: 'new starter' } }));
    expect(issued).toMatchObject({ accountId, loginName: login, kind: 'PASSWORD' });
    expect(issued.secret.length).toBeGreaterThanOrEqual(16);
    const dir = valueOf(await admin.call(P.directory));
    expect(JSON.stringify(dir)).not.toContain(issued.secret);
    const me = dir.people.find((p) => p.personId === personId)!;
    // A change of legal name is recorded (the old name stays in what was signed with it).
    expect(valueOf(await admin.call(P.renamePerson, { params: { personId }, body: { legalName: 'Lena Fischer-Rao', reason: 'marriage certificate' } })).legalName).toBe('Lena Fischer-Rao');
    expect(me.accounts[0]).toMatchObject({ status: 'ACTIVE', credentials: [{ kind: 'PASSWORD', mustChange: true, origin: 'INITIAL' }] });
    // The first sign-in with it must change it (DI-15), on any registered office PC.
    const b = server.browser('PC-DESIGN-01');
    const first = { method: 'PASSWORD' as const, identifier: login, secret: issued.secret };
    const r1 = await b.call(routes.session.login, { body: { ...first, proof: await b.proof('POST', '/api/session/login', first) } });
    expect(codeOf(r1)).toBe('MUST_CHANGE_SECRET');
  }, 120_000);

  it('[DI-14] an account for a person the installation does not hold is refused as not found (404), never 500; without the right it is refused for the right', async () => {
    const body = { personId: randomUUID(), loginName: `ghost.${suffix()}`, kind: 'HUMAN' as const, generic: false, breakGlass: false };
    const r = await admin.call(P.createAccount, { body });
    expect(codeOf(r)).toBe('EBMR-API-NOT-FOUND');
    expect(r.ok ? 0 : r.error.kind === 'REFUSAL' ? r.error.status : 0).toBe(404);
    expect(codeOf(await qa.call(P.createAccount, { body }))).not.toBe('EBMR-API-NOT-FOUND');
    // A generic break-glass account breaks the account's check constraint: refused (422) with the database's words.
    const person = valueOf(await admin.call(P.createPerson, { body: { kind: 'NATURAL', legalName: 'Gita Generic' } })).personId;
    const generic = await admin.call(P.createAccount, { body: { ...body, personId: person, generic: true, breakGlass: true } });
    expect(codeOf(generic)).toBe('EBMR-API-CHECK');
    expect(generic.ok ? 0 : generic.error.kind === 'REFUSAL' ? generic.error.status : 0).toBe(422);
  }, 60_000);

  it('[DI-16][DI-18][INV-11] the administrator requests a grant and cannot approve it; a GMP role holder cannot approve or request; the process owner approves; the grant is live', async () => {
    const login = `noor.${suffix()}`;
    const { accountId } = await newPersonWithAccount('Noor Khan', login);
    valueOf(await admin.call(P.activateAccount, { params: { accountId }, body: { reason: 'new starter' } }));
    const g = valueOf(await admin.call(P.requestGrant, { body: { accountId, roleCode: 'MBR_CHECKER', scope: {}, reason: 'checks master batch records' } }));
    expect(g).toMatchObject({ status: 'REQUESTED', live: false, roleCode: 'MBR_CHECKER', loginName: login });
    // The requester never decides (DI-16); a QA person holds no grant right (IAM-040).
    const self = await admin.call(P.decideGrant, { params: { grantId: g.grantId }, body: { approve: true, reason: 'self' } });
    expect(codeOf(self)).toBe('EBMR-IAM-032');
    expect(codeOf(await qa.call(P.decideGrant, { params: { grantId: g.grantId }, body: { approve: true, reason: 'x' } }))).toBe('EBMR-IAM-040');
    expect(codeOf(await qa.call(P.requestGrant, { body: { accountId, roleCode: 'MBR_AUTHOR', scope: {}, reason: 'x' } }))).toBe('EBMR-IAM-040');
    const approved = valueOf(await owner.call(P.decideGrant, { params: { grantId: g.grantId }, body: { approve: true, reason: 'approved for MBR checks' } }));
    expect(approved).toMatchObject({ status: 'APPROVED', live: true, decidedBy: { legalName: 'Omar Owner' } });
    // INV-11: the person now holds a GMP role, so an administration role is refused at the request.
    const mixed = await admin.call(P.requestGrant, { body: { accountId, roleCode: 'SYSTEM_ADMINISTRATOR', scope: {}, reason: 'x' } });
    expect(codeOf(mixed)).toBe('EBMR-IAM-033');
    expect(whyOf(mixed)).toContain('INV-11');
    // The grant list shows both people; the owner revokes nothing of their own; the administrator revokes it.
    const list = valueOf(await owner.call(P.grants));
    expect(list.grants.find((x) => x.grantId === g.grantId)).toMatchObject({ requestedBy: { legalName: 'Ira Admin' }, decidedBy: { legalName: 'Omar Owner' } });
    expect(list.roles.some((r) => r.code === 'MBR_CHECKER')).toBe(true);
    expect(valueOf(await admin.call(P.revokeGrant, { params: { grantId: g.grantId }, body: { reason: 'moved to another site' } }))).toMatchObject({ status: 'REVOKED', live: false });
  }, 120_000);

  it('[DI-16][DI-18] P7G-1: an administrator cannot approve a grant to their own account requested by another administrator; the process owner can', async () => {
    const self = await grantedPerson(server, 'SYSTEM_ADMINISTRATOR', 'Sana Selfgrant');
    const selfAdmin = await loginOf(server, self);
    const other = await loginOf(server, await grantedPerson(server, 'SYSTEM_ADMINISTRATOR', 'Tom Otheradmin'));
    const g = valueOf(await other.call(P.requestGrant, { body: { accountId: self.accountId, roleCode: 'AUDITOR_READONLY', scope: {}, reason: 'reads the audit trail for the annual review' } }));
    expect(g.status).toBe('REQUESTED');
    // The grantee holds IAM.GRANT_APPROVE (kernel 0120) but never decides their own grant (DI-18 second person).
    expect(codeOf(await selfAdmin.call(P.decideGrant, { params: { grantId: g.grantId }, body: { approve: true, reason: 'self' } }))).toBe('EBMR-IAM-032');
    expect(codeOf(await other.call(P.decideGrant, { params: { grantId: g.grantId }, body: { approve: true, reason: 'own request' } }))).toBe('EBMR-IAM-032');
    expect(valueOf(await owner.call(P.decideGrant, { params: { grantId: g.grantId }, body: { approve: false, reason: 'not needed' } })).status).toBe('REJECTED');
  }, 120_000);

  it('[DI-14][DI-17] a GMP role holder is refused the administration reads and acts: the route names the roles, the database refuses the act', async () => {
    for (const r of [P.directory, P.grants, P.recertification, P.breakGlass, D.list] as const) {
      expect(codeOf(await qa.call(r)), r.id).toBe('ROLE_NOT_ALLOWED');
    }
    expect(codeOf(await qa.call(P.createPerson, { body: { kind: 'NATURAL', legalName: 'Not Allowed' } }))).toBe('EBMR-IAM-040');
    expect(codeOf(await qa.call(D.registerTerminal, { body: { code: `PC-X-${suffix()}`, deviceClass: 'PERSONAL', fingerprint: 'a'.repeat(64), description: 'x' } }))).toBe('EBMR-IAM-040');
  }, 120_000);

  it('[DI-19][DI-15] a badge is issued against an identity check, tested and activated; reported lost it stops; a PIN is issued once; nobody verifies their own identity', async () => {
    const login = `ravi.${suffix()}`;
    const { personId, accountId } = await newPersonWithAccount('Ravi Kumar', login);
    valueOf(await admin.call(P.activateAccount, { params: { accountId }, body: { reason: 'new starter' } }));
    const pin = valueOf(await admin.call(P.issueCredential, { params: { accountId }, body: { kind: 'PIN', reason: 'kiosk work' } }));
    expect(pin.secret).toMatch(/^\d{4,12}$/);
    const before = valueOf(await admin.call(P.directory)).people.find((p) => p.personId === personId)!;
    const uid = `04C1${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
    const issued = valueOf(await admin.call(P.issueBadge, { params: { accountId }, body: { badgeUid: uid, technology: 'ISO14443_DESFIRE_EV3', label: `B-${login}`, identityVerificationId: before.verifications[0]!.verificationId } }));
    expect(JSON.stringify(issued)).not.toContain(uid);
    const badge = issued.accounts[0]!.badges[0]!;
    expect(badge.status).toBe('ISSUED');
    valueOf(await admin.call(P.recordBadgeTest, { params: { badgeId: badge.badgeId }, body: { kind: 'AT_ISSUE', result: 'PASS' } }));
    const active = valueOf(await admin.call(P.activateBadge, { params: { badgeId: badge.badgeId }, body: { reason: 'tested at issue' } }));
    expect(active.accounts[0]!.badges[0]).toMatchObject({ status: 'ACTIVE', lastTest: { kind: 'AT_ISSUE', result: 'PASS' } });
    const lost = valueOf(await admin.call(P.withdrawBadge, { params: { badgeId: badge.badgeId }, body: { action: 'LOST', reason: 'reported lost by the holder' } }));
    expect(lost.accounts[0]!.badges[0]!.status).toBe('LOST');
    // The administrator cannot verify their own identity (the database's check, whoever asks).
    const adminSession = valueOf(await admin.call(routes.session.get));
    const own = await admin.call(P.verifyIdentity, { params: { personId: adminSession.person.personId }, body: { purpose: 'PERIODIC', method: 'IN_PERSON_DOCUMENT', documentType: 'ID', evidenceRef: 'self', occurredAt: '2026-01-05T00:00:00Z' } });
    expect(codeOf(own)).toMatch(/^EBMR-IAM-01[0-3]$/);
  }, 120_000);

  it('[DI-14] the administrator suspends and reinstates an account and processes a leaver; the process owner recertifies, the administrator cannot', async () => {
    const login = `mina.${suffix()}`;
    const { personId, accountId } = await newPersonWithAccount('Mina Das', login);
    valueOf(await admin.call(P.activateAccount, { params: { accountId }, body: { reason: 'new starter' } }));
    expect(valueOf(await admin.call(P.setAccountStatus, { params: { accountId }, body: { action: 'SUSPEND', reason: 'long leave' } })).accounts[0]!.status).toBe('SUSPENDED');
    expect(valueOf(await admin.call(P.setAccountStatus, { params: { accountId }, body: { action: 'REINSTATE', reason: 'back from leave' } })).accounts[0]!.status).toBe('ACTIVE');
    const due = valueOf(await owner.call(P.recertification)).due;
    expect(due.some((d) => d.accountId === accountId)).toBe(true);
    expect(codeOf(await admin.call(P.recertify, { params: { accountId }, body: { outcome: 'CONFIRMED', comment: 'x' } }))).toBe('EBMR-IAM-040');
    expect(valueOf(await owner.call(P.recertify, { params: { accountId }, body: { outcome: 'CONFIRMED', comment: 'still needed' } })).recertificationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(valueOf(await owner.call(P.recertification)).recent.some((r) => r.accountId === accountId && r.outcome === 'CONFIRMED')).toBe(true);
    const left = valueOf(await admin.call(P.processLeaver, { params: { personId }, body: { reason: 'resigned' } }));
    expect(left).toMatchObject({ status: 'LEFT', accounts: [{ status: 'DISABLED' }] });
  }, 120_000);

  it('[DI-18] break-glass: the holder requests a window for their own break-glass account; the requester cannot approve; the process owner approves and reviews after it ends', async () => {
    // A second administrator holds the break-glass account; the first opens it for them (nobody administers themselves).
    const backup = await grantedPerson(server, 'SYSTEM_ADMINISTRATOR', 'Bea Backup');
    const holder = await loginOf(server, backup);
    const bgLogin = `bg.${suffix()}`;
    const { accountId } = await newPersonWithAccount('', bgLogin, backup.personId);
    valueOf(await admin.call(P.activateAccount, { params: { accountId }, body: { reason: 'sealed emergency access' } }));
    // Break-glass never holds a GMP role (DI-18); its own role is requested by the administrator and approved by the owner.
    expect(codeOf(await admin.call(P.requestGrant, { body: { accountId, roleCode: 'OPERATOR', scope: {}, reason: 'x' } }))).toBe('EBMR-IAM-036');
    const g = valueOf(await admin.call(P.requestGrant, { body: { accountId, roleCode: 'BREAK_GLASS_ADMIN', scope: {}, reason: 'sealed emergency access' } }));
    valueOf(await owner.call(P.decideGrant, { params: { grantId: g.grantId }, body: { approve: true, reason: 'sealed emergency access' } }));
    // Only the holder requests a window for their break-glass account.
    expect(codeOf(await admin.call(P.requestBreakGlass, { body: { accountId, reason: 'x', minutes: 30 } }))).toBe('EBMR-IAM-130');
    const w = valueOf(await holder.call(P.requestBreakGlass, { body: { accountId, reason: 'database restore after outage', minutes: 30 } }));
    expect(w).toMatchObject({ state: 'REQUESTED', loginName: bgLogin, minutes: 30, approvedBy: null });
    expect(codeOf(await holder.call(P.approveBreakGlass, { params: { windowId: w.windowId }, body: { reason: 'x' } }))).toBe('EBMR-IAM-040');
    const open = valueOf(await owner.call(P.approveBreakGlass, { params: { windowId: w.windowId }, body: { reason: 'outage confirmed' } }));
    expect(open).toMatchObject({ state: 'OPEN', approvedBy: { legalName: 'Omar Owner' } });
    expect(codeOf(await owner.call(P.reviewBreakGlass, { params: { windowId: w.windowId }, body: { outcome: 'NO_FINDINGS', comment: 'too early' } }))).toBe('EBMR-IAM-130');
    // The window ends (moved into the past by the superuser, as the kernel's test does), then the owner reviews it.
    const c = await server.db.admin.connect();
    try {
      await c.query('begin');
      await c.query('set local session_replication_role = replica');
      await c.query("update iam.break_glass_window set valid_to = clock_timestamp() - interval '1 second' where id = $1", [w.windowId]);
      await c.query('commit');
    } finally {
      c.release();
    }
    const reviewed = valueOf(await owner.call(P.reviewBreakGlass, { params: { windowId: w.windowId }, body: { outcome: 'NO_FINDINGS', comment: 'restore only; audit trail reviewed' } }));
    expect(reviewed).toMatchObject({ state: 'REVIEWED', review: { outcome: 'NO_FINDINGS' } });
    expect(valueOf(await owner.call(P.breakGlass)).windows.some((x) => x.windowId === w.windowId)).toBe(true);
  }, 120_000);
});

describe('the device registry over HTTP', () => {
  it('[DI-19][DI-20][DI-31] the administrator registers a kiosk and attests its hardening, registers a balance and a gateway, enrols the gateway key, binds the balance behind it and binds an OPC UA adapter to its feed', async () => {
    const s = suffix().toUpperCase();
    const reg = valueOf(await admin.call(D.list));
    expect(reg.siteCode).toBe('SITE-1');
    // A shared kiosk: registered, then attested (DI-19).
    const kiosk = valueOf(await admin.call(D.registerTerminal, { body: { code: `KIOSK-T-${s}`, deviceClass: 'SHARED', room: 'DISP-1', fingerprint: createHash('sha256').update(`k${s}`).digest('hex'), description: 'Test kiosk' } }));
    expect(kiosk).toMatchObject({ deviceClass: 'SHARED', hardening: null, hardeningRequired: true, status: 'ACTIVE' });
    const hardened = valueOf(await admin.call(D.attestHardening, { params: { deviceId: kiosk.deviceId }, body: { usbMassStorageBlocked: true, kioskModeEnforced: true, malwareProtectionActive: true, osPatchWithinSla: true, method: 'MDM_COMPLIANCE_REPORT', evidenceRef: `MDM-${s}` } }));
    expect(hardened.hardening).toMatchObject({ evidenceRef: `MDM-${s}`, method: 'MDM_COMPLIANCE_REPORT' });
    // An office PC is not attested (the screen's own check, before the database).
    const pc = valueOf(await admin.call(D.registerTerminal, { body: { code: `PC-T-${s}`, deviceClass: 'PERSONAL', fingerprint: createHash('sha256').update(`p${s}`).digest('hex'), description: 'Test PC' } }));
    expect(codeOf(await admin.call(D.attestHardening, { params: { deviceId: pc.deviceId }, body: { usbMassStorageBlocked: true, kioskModeEnforced: true, malwareProtectionActive: true, osPatchWithinSla: true, method: 'MANUAL_INSPECTION', evidenceRef: 'x' } }))).toBe('EBMR-API-NOT-A-KIOSK');
    expect(valueOf(await admin.call(D.setTerminalStatus, { params: { deviceId: pc.deviceId }, body: { status: 'BLOCKED', reason: 'lost' } })).status).toBe('BLOCKED');

    // The gateway: a SERVER device whose fingerprint is the SHA-256 of its Ed25519 SPKI, and an INTEGRATION account.
    const { publicKey } = generateKeyPairSync('ed25519');
    const spki = publicKey.export({ type: 'spki', format: 'der' });
    const gwCode = `GW-T-${s}`;
    const gw = valueOf(await admin.call(D.registerTerminal, { body: { code: gwCode, deviceClass: 'SERVER', fingerprint: createHash('sha256').update(spki).digest('hex'), description: 'Test gateway' } }));
    const gwPerson = valueOf(await admin.call(P.createPerson, { body: { kind: 'SYSTEM', legalName: `Gateway ${gwCode}` } }));
    const gwLogin = `gw.${s.toLowerCase()}`;
    const gwAccount = valueOf(await admin.call(P.createAccount, { body: { personId: gwPerson.personId, loginName: gwLogin, kind: 'INTEGRATION', generic: false, breakGlass: false } })).accounts[0]!;
    // The wrong key for the registered fingerprint is refused by the database.
    const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    expect(codeOf(await admin.call(D.enrolGatewayKey, { body: { gatewayCode: gwCode, publicKeySpki: other, loginName: gwLogin } }))).toBe('EBMR-DEV-011');
    expect(codeOf(await qa.call(D.enrolGatewayKey, { body: { gatewayCode: gwCode, publicKeySpki: spki.toString('base64'), loginName: gwLogin } }))).toBe('EBMR-IAM-040');
    const key = valueOf(await admin.call(D.enrolGatewayKey, { body: { gatewayCode: gwCode, publicKeySpki: spki.toString('base64'), loginName: gwLogin } }));
    expect(key).toMatchObject({ gatewayCode: gwCode, loginName: gwLogin, status: 'ACTIVE', fingerprint: gw.fingerprint });

    // A balance: an INSTRUMENT in a room, bound behind the gateway key with its serial, unit and resolution.
    const balCode = `BAL-T-${s}`;
    valueOf(await admin.call(D.registerTerminal, { body: { code: balCode, deviceClass: 'INSTRUMENT', room: 'DISP-1', fingerprint: createHash('sha256').update(`b${s}`).digest('hex'), description: 'Test balance 60 kg' } }));
    const bound = valueOf(await admin.call(D.bindDevice, { body: { kind: 'BALANCE', gatewayKeyId: key.keyId, deviceCode: balCode, serial: `SN${s}`, unit: 'kg', resolution: '0.001' } }));
    expect(bound).toMatchObject({ kind: 'BALANCE', deviceCode: balCode, gatewayCode: gwCode, endedAt: null });
    // A device that is not a registered INSTRUMENT is refused.
    expect(codeOf(await admin.call(D.bindDevice, { body: { kind: 'BALANCE', gatewayKeyId: key.keyId, deviceCode: pc.code, serial: 'SN1', unit: 'kg', resolution: '0.001' } }))).toBe('EBMR-DEV-014');
    const ended = valueOf(await admin.call(D.endBinding, { params: { bindingId: bound.bindingId }, body: { kind: 'BALANCE', reason: 'moved to stores' } }));
    expect(ended.endedAt).not.toBeNull();

    // The OPC UA adapter on the gateway's SERVER device, then its feed bound to the gateway (slice 7a, DI-31).
    const adapterCode = `OPCUA-T-${s}`;
    const adapter = valueOf(await admin.call(D.registerAdapter, { body: { code: adapterCode, sourceSystem: 'OPCUA', accountId: gwAccount.accountId, deviceId: gw.deviceId, description: 'Test OPC UA feed' } }));
    expect(adapter).toMatchObject({ code: adapterCode, sourceSystem: 'OPCUA', feed: null });
    const fed = valueOf(await admin.call(D.bindGatewayFeed, { body: { adapterCode, gatewayCode: gwCode, reason: 'commissioning' } }));
    expect(fed.feed).toMatchObject({ gatewayCode: gwCode });
    // A gateway's feed is pulled by one adapter (EBMR-DEV-179).
    const second = `OPCUA-U-${s}`;
    // One adapter per integration account: the database's unique rule, answered as a refusal with its message.
    const dup = await admin.call(D.registerAdapter, { body: { code: second, sourceSystem: 'OPCUA', accountId: gwAccount.accountId, deviceId: gw.deviceId, description: 'A second feed' } });
    expect(codeOf(dup)).toBe('EBMR-API-DUPLICATE');
    expect(whyOf(dup)).toContain('integration_adapter_one_per_account');
    const secondPerson = valueOf(await admin.call(P.createPerson, { body: { kind: 'SYSTEM', legalName: `Second feed ${gwCode}` } }));
    const secondAccount = valueOf(await admin.call(P.createAccount, { body: { personId: secondPerson.personId, loginName: `${gwLogin}.b`, kind: 'INTEGRATION', generic: false, breakGlass: false } })).accounts.find((a) => a.loginName === `${gwLogin}.b`)!;
    valueOf(await admin.call(D.registerAdapter, { body: { code: second, sourceSystem: 'OPCUA', accountId: secondAccount.accountId, deviceId: gw.deviceId, description: 'A second feed' } }));
    expect(codeOf(await admin.call(D.bindGatewayFeed, { body: { adapterCode: second, gatewayCode: gwCode, reason: 'x' } }))).toBe('EBMR-DEV-179');
    // Revoking the key: the registry shows it, and a feed binding to a gateway without an active key is refused.
    expect(valueOf(await admin.call(D.revokeGatewayKey, { params: { keyId: key.keyId }, body: { reason: 'key rotation' } })).status).not.toBe('ACTIVE');
    expect(codeOf(await admin.call(D.bindGatewayFeed, { body: { adapterCode: second, gatewayCode: `GW-NONE-${s}`, reason: 'x' } }))).toBe('EBMR-DEV-178');
    const after = valueOf(await owner.call(D.list));
    expect(after.adapters.find((a) => a.code === adapterCode)?.feed?.gatewayCode).toBe(gwCode);
    expect(after.terminals.find((t) => t.code === `KIOSK-T-${s}`)?.hardening).not.toBeNull();
  }, 180_000);
});
