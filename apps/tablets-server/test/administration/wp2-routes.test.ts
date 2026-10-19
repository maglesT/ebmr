/**
 * The administration routes of slice 7g, work package 2 (decision 0025; contract ns/people.ts and ns/device-registry.ts)
 * over HTTP with real sessions; the database decides every act:
 *  - security alerts are acknowledged with a comment by a holder of IAM.ALERT_ACKNOWLEDGE, never by the person they are
 *    about (DI-19);
 *  - the system administrator creates a role with no permission; its permissions follow the role-permission requests
 *    a second person decides (DI-18); a person who left is rehired by the administrator;
 *  - the training coordinator keeps the qualification matrix (TRAINING.MANAGE); the administrator may not;
 *  - the administrator sets the kiosks' per-entry attribution (IAM.POLICY_MANAGE), revokes a hardening attestation,
 *    enrols and retires an OPC UA endpoint, links a process device to its plant unit and blocks an adapter
 *    (IAM.DEVICE_MANAGE); the process owner and QA may not.
 */
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type Result } from '@ebmr/api-contract';
import { asSetup } from '../blocks/compression/plant-support.ts';
import { grantedPerson, loginOf } from '../support/granted-person.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { startSigningServer } from '../esig/support.ts';
import { signAction } from '../support/signed-acts.ts';

const P = routes.people;
const D = routes.deviceRegistry;
const G = routes.accessGovernance;
let server: TestServer;
let admin: TestBrowser;
let adminPerson: string;
let owner: TestBrowser;
let qa: TestBrowser;
let trainer: TestBrowser;

const valueOf = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`expected success, got ${JSON.stringify(r.error)}`);
  return r.value;
};
const codeOf = (r: Result<unknown>): string => (r.ok ? 'OK' : r.error.kind === 'REFUSAL' ? r.error.envelope.refusal.code : JSON.stringify(r.error));
const suffix = () => randomUUID().slice(0, 6).toUpperCase();

beforeAll(async () => {
  server = await startSigningServer('GMP', { stub: false });
  admin = await loginOf(server, await grantedPerson(server, 'SYSTEM_ADMINISTRATOR', 'Ira Admin'));
  adminPerson = valueOf(await admin.call(routes.session.get)).person.personId;
  owner = await loginOf(server, await grantedPerson(server, 'PROCESS_OWNER', 'Omar Owner'));
  trainer = await loginOf(server, await grantedPerson(server, 'TRAINING_COORDINATOR', 'Tara Trainer'));
  qa = await server.asPersona('qaInvestigator');
}, 300_000);
afterAll(async () => {
  await server?.close();
});

/** A change record for roles (area ROLE), raised by the steward and approved by QA (a role is configuration, DI-09). */
async function approvedChangeRecord(): Promise<string> {
  const number = `CR-ROLE-${randomUUID().slice(0, 8).toUpperCase()}`;
  const steward = await server.asPersona('steward');
  valueOf(await steward.call(routes.config.raiseChangeRecord, { body: { number, title: 'Customer roles', description: 'New roles of the packaging hall', areas: ['ROLE'] } }));
  const qa2 = await server.asPersona('qaApprover2');
  expect((await signAction(server, qa2, 'qaApprover2', { kind: 'CONFIG_CHANGE_ACT', act: 'APPROVE', number })).ok).toBe(true);
  return number;
}

async function raiseAlert(personId: string): Promise<string> {
  const id = randomUUID();
  await server.db.admin.query("insert into iam.security_alert (id, kind, severity, person_id, details, ack_due_at) values ($1, 'AUTHENTICATION_FAILED', 'MEDIUM', $2, '{\"attempts\": 5}'::jsonb, clock_timestamp() + interval '4 hours')", [id, personId]);
  return id;
}

describe('security alerts, roles, rehiring (people)', () => {
  it('[DI-19][DI-17] a security alert is acknowledged once with a comment by a holder of IAM.ALERT_ACKNOWLEDGE, never by the person it is about; QA review may not acknowledge it', async () => {
    const aboutAdmin = await raiseAlert(adminPerson);
    const qaPerson = server.seed.personas.find((p) => p.key === 'qaInvestigator')?.personId ?? '';
    const aboutQa = await raiseAlert(qaPerson);
    const list = valueOf(await admin.call(P.alerts));
    expect(list.alerts.find((a) => a.alertId === aboutQa)).toMatchObject({ kind: 'AUTHENTICATION_FAILED', severity: 'MEDIUM', escalated: false, acknowledgement: null });
    expect(codeOf(await qa.call(P.alerts))).toBe('ROLE_NOT_ALLOWED');
    expect(codeOf(await admin.call(P.acknowledgeAlert, { params: { alertId: aboutAdmin }, body: { comment: 'it was me' } }))).toBe('EBMR-IAM-003');
    expect(codeOf(await qa.call(P.acknowledgeAlert, { params: { alertId: aboutQa }, body: { comment: 'x' } }))).toBe('EBMR-IAM-040');
    const acked = valueOf(await admin.call(P.acknowledgeAlert, { params: { alertId: aboutQa }, body: { comment: 'mistyped password after the holiday; confirmed with the person' } }));
    expect(acked.acknowledgement).toMatchObject({ by: { legalName: 'Ira Admin' }, comment: 'mistyped password after the holiday; confirmed with the person' });
    expect(codeOf(await admin.call(P.acknowledgeAlert, { params: { alertId: aboutQa }, body: { comment: 'again' } }))).toBe('EBMR-IAM-150');
  }, 120_000);

  it('[DI-18][DI-17] the administrator creates a role with no permission; a permission for it is only requested, and a second person decides it; QA may not create a role', async () => {
    const code = `LINE_LEAD_${suffix()}`;
    const changeRecord = await approvedChangeRecord();
    const body = { code, name: 'Line lead', group: 'EXECUTION' as const, description: 'Leads a packaging line', accountKinds: ['HUMAN' as const], reason: 'new organisation of the packaging hall', changeRecord };
    expect(codeOf(await qa.call(P.createRole, { body }))).toBe('EBMR-IAM-040');
    // Without an approved change record the database refuses it (DI-09).
    expect(codeOf(await admin.call(P.createRole, { body: { ...body, changeRecord: 'CR-NONE' } }))).not.toBe('OK');
    expect(valueOf(await admin.call(P.createRole, { body }))).toEqual({ code, name: 'Line lead', group: 'EXECUTION', accountKinds: ['HUMAN'] });
    const roles = valueOf(await owner.call(G.rolePermissions)).roles;
    expect(roles.find((r) => r.code === code)?.permissions).toEqual([]);
    // Its permissions go through the role-permission request of slice 7g-5: the administrator requests, a second person decides.
    const req = valueOf(await admin.call(G.requestRolePermission, { body: { roleCode: code, permissionCode: 'STEP.EXECUTE', reason: 'line leads execute steps' } }));
    expect(req).toMatchObject({ status: 'REQUESTED' });
    expect(codeOf(await admin.call(G.decideRolePermission, { params: { requestId: req.requestId }, body: { approve: true, reason: 'self' } }))).not.toBe('OK');
    expect(valueOf(await owner.call(G.rolePermissions)).roles.find((r) => r.code === code)?.permissions).toEqual([]);
  }, 120_000);

  it('[DI-14][DI-17] the administrator rehires a person who left, with the reason; a person who has not left is refused; QA may not rehire', async () => {
    const person = valueOf(await admin.call(P.createPerson, { body: { kind: 'NATURAL', legalName: 'Rhea Return' } })).personId;
    expect(codeOf(await admin.call(P.rehirePerson, { params: { personId: person }, body: { reason: 'back' } }))).toBe('EBMR-IAM-011');
    valueOf(await admin.call(P.processLeaver, { params: { personId: person }, body: { reason: 'moved to another company' } }));
    expect(codeOf(await qa.call(P.rehirePerson, { params: { personId: person }, body: { reason: 'back' } }))).toBe('EBMR-IAM-040');
    expect(valueOf(await admin.call(P.rehirePerson, { params: { personId: person }, body: { reason: 'rejoined as a line lead' } })).status).toBe('ACTIVE');
  }, 120_000);
});

describe('the qualification matrix (people)', () => {
  it('[DI-17] the training coordinator adds a qualification type and a requirement for a role with the reason, and ends it; the administrator may not change the matrix', async () => {
    const q = `WP2.QUAL-${suffix()}`;
    const role = `QUAL_ROLE_${suffix()}`;
    valueOf(await admin.call(P.createRole, { body: { code: role, name: 'Qualified role', group: 'EXECUTION', description: 'for the matrix test', accountKinds: ['HUMAN'], reason: 'test', changeRecord: await approvedChangeRecord() } }));
    expect(codeOf(await admin.call(P.createQualificationType, { body: { code: q, name: 'Matrix test', description: 'x' } }))).toBe('EBMR-IAM-040');
    expect(valueOf(await trainer.call(P.createQualificationType, { body: { code: q, name: 'Matrix test', description: 'A qualification of the matrix test' } }))).toEqual({ code: q, name: 'Matrix test', description: 'A qualification of the matrix test' });
    expect(codeOf(await admin.call(P.addQualificationRequirement, { body: { qualificationCode: q, roleCode: role, scope: {}, reason: 'x' } }))).toBe('EBMR-IAM-040');
    const req = valueOf(await trainer.call(P.addQualificationRequirement, { body: { qualificationCode: q, roleCode: role, scope: {}, reason: 'the role needs it from now on' } }));
    expect(req).toMatchObject({ qualificationCode: q, roleCode: role, permissionCode: null, effectiveTo: null, createdBy: { legalName: 'Tara Trainer' } });
    const view = valueOf(await trainer.call(P.qualifications));
    expect(view.types.some((t) => t.code === q)).toBe(true);
    expect(view.requirements.find((r) => r.requirementId === req.requirementId)).toBeTruthy();
    expect(codeOf(await qa.call(P.qualifications))).toBe('ROLE_NOT_ALLOWED');
    expect(codeOf(await admin.call(P.endQualificationRequirement, { params: { requirementId: req.requirementId }, body: { reason: 'x' } }))).toBe('EBMR-IAM-040');
    expect(valueOf(await trainer.call(P.endQualificationRequirement, { params: { requirementId: req.requirementId }, body: { reason: 'replaced by the new curriculum' } })).effectiveTo).not.toBeNull();
    expect(codeOf(await trainer.call(P.endQualificationRequirement, { params: { requirementId: req.requirementId }, body: { reason: 'again' } }))).toBe('EBMR-IAM-160');
  }, 120_000);
});

describe('the device configuration (deviceRegistry)', () => {
  it('[DI-19][DI-17] the administrator sets the per-entry attribution of a kiosk class and revokes a kiosk\'s hardening attestation with the reason; the process owner may do neither', async () => {
    expect(valueOf(await admin.call(D.configuration)).attribution).toEqual([{ deviceClass: 'SHARED', method: 'TAP' }, { deviceClass: 'GRADE_A_B', method: expect.stringMatching(/^TAP(_PIN)?$/) as string }]);
    expect(codeOf(await owner.call(D.setAttributionMethod, { body: { deviceClass: 'GRADE_A_B', method: 'TAP_PIN', reason: 'x' } }))).toBe('EBMR-IAM-040');
    const set = valueOf(await admin.call(D.setAttributionMethod, { body: { deviceClass: 'GRADE_A_B', method: 'TAP_PIN', reason: 'aseptic area: tap and PIN per entry (D8)' } }));
    expect(set.attribution.find((a) => a.deviceClass === 'GRADE_A_B')?.method).toBe('TAP_PIN');

    const s = suffix();
    const kiosk = valueOf(await admin.call(D.registerTerminal, { body: { code: `KIOSK-W-${s}`, deviceClass: 'SHARED', room: 'DISP-1', fingerprint: createHash('sha256').update(`kw${s}`).digest('hex'), description: 'WP2 kiosk' } }));
    const hardened = valueOf(await admin.call(D.attestHardening, { params: { deviceId: kiosk.deviceId }, body: { usbMassStorageBlocked: true, kioskModeEnforced: true, malwareProtectionActive: true, osPatchWithinSla: true, method: 'MANUAL_INSPECTION', evidenceRef: `INSP-${s}` } }));
    const attestationId = hardened.hardening?.attestationId ?? '';
    expect(codeOf(await owner.call(D.revokeHardening, { params: { attestationId }, body: { reason: 'x' } }))).toBe('EBMR-IAM-040');
    expect(valueOf(await admin.call(D.revokeHardening, { params: { attestationId }, body: { reason: 'USB port found open at the audit' } })).hardening).toBeNull();
    expect(codeOf(await admin.call(D.revokeHardening, { params: { attestationId }, body: { reason: 'again' } }))).toBe('EBMR-CONT-042');
  }, 120_000);

  it('[DI-20][DI-31][DI-17] the administrator enrols an OPC UA endpoint for a unit of its room and retires it, links a process device to its unit and blocks an adapter, each with the reason; QA may not', async () => {
    const s = suffix();
    const area = `RM-W-${s}`;
    const areaId = randomUUID();
    await asSetup(server, "insert into plant.area (id, code, kind, name, segregated, negative_pressure, recorded_by) values ($1, $2, 'ROOM', $2, false, false, gen_random_uuid())", [areaId, area]);
    await asSetup(server, "insert into plant.equipment_class (code, kind, description, clean_hold, dirty_hold, calibration_required, recorded_by) values ($1, 'PROCESS', 'Press (WP2 test)', interval '72 hours', interval '48 hours', false, gen_random_uuid())", [`CL-W-${s}`]);
    const press = `PRESS-W-${s}`;
    await asSetup(server, "insert into plant.equipment (id, code, name, class_code, kind, area_id, recorded_by) values (gen_random_uuid(), $1, $1, $2, 'PROCESS', $3, gen_random_uuid())", [press, `CL-W-${s}`, areaId]);
    const endpoint = `OPC-W-${s}`;
    valueOf(await admin.call(D.registerTerminal, { body: { code: endpoint, deviceClass: 'INSTRUMENT', room: area, fingerprint: createHash('sha256').update(`opc${s}`).digest('hex'), description: 'OPC UA endpoint of the press' } }));
    const enrolBody = { deviceCode: endpoint, endpointUrl: `opc.tcp://press-${s.toLowerCase()}.plant.local:4840`, securityPolicy: 'Basic256Sha256' as const, equipmentCodes: [press], reason: 'commissioned with the press' };
    expect(codeOf(await qa.call(D.enrolOpcuaEndpoint, { body: enrolBody }))).toBe('EBMR-IAM-040');
    expect(codeOf(await admin.call(D.enrolOpcuaEndpoint, { body: { ...enrolBody, deviceCode: `NONE-${s}` } }))).toBe('EBMR-EQD-031');
    expect(valueOf(await admin.call(D.enrolOpcuaEndpoint, { body: enrolBody }))).toMatchObject({ deviceCode: endpoint, version: 1, status: 'ENROLLED', equipmentCodes: [press], recordedBy: { legalName: 'Ira Admin' } });
    expect(codeOf(await qa.call(D.retireOpcuaEndpoint, { params: { deviceCode: endpoint }, body: { reason: 'x' } }))).toBe('EBMR-IAM-040');
    expect(valueOf(await admin.call(D.retireOpcuaEndpoint, { params: { deviceCode: endpoint }, body: { reason: 'press replaced' } }))).toMatchObject({ version: 2, status: 'RETIRED' });

    // A process device behind an enrolled gateway key, linked to its PROCESS unit.
    const { publicKey } = generateKeyPairSync('ed25519');
    const spki = publicKey.export({ type: 'spki', format: 'der' });
    const gwCode = `GW-W-${s}`;
    const gw = valueOf(await admin.call(D.registerTerminal, { body: { code: gwCode, deviceClass: 'SERVER', fingerprint: createHash('sha256').update(spki).digest('hex'), description: 'WP2 gateway' } }));
    const gwPerson = valueOf(await admin.call(P.createPerson, { body: { kind: 'SYSTEM', legalName: `Gateway ${gwCode}` } }));
    const gwLogin = `gw.w.${s.toLowerCase()}`;
    const gwAccount = valueOf(await admin.call(P.createAccount, { body: { personId: gwPerson.personId, loginName: gwLogin, kind: 'INTEGRATION', generic: false, breakGlass: false } })).accounts[0]!;
    const key = valueOf(await admin.call(D.enrolGatewayKey, { body: { gatewayCode: gwCode, publicKeySpki: spki.toString('base64'), loginName: gwLogin } }));
    const deviceCode = `PRS-DEV-${s}`;
    valueOf(await admin.call(D.registerTerminal, { body: { code: deviceCode, deviceClass: 'INSTRUMENT', room: area, fingerprint: createHash('sha256').update(`pd${s}`).digest('hex'), description: 'Press controller' } }));
    const bound = valueOf(await admin.call(D.bindDevice, { body: { kind: 'PROCESS', gatewayKeyId: key.keyId, deviceCode, serial: press, deviceKind: 'PRESS' } }));
    expect(codeOf(await qa.call(D.linkProcessDeviceUnit, { params: { bindingId: bound.bindingId }, body: { equipmentCode: press, reason: 'x' } }))).toBe('EBMR-IAM-040');
    const linked = valueOf(await admin.call(D.linkProcessDeviceUnit, { params: { bindingId: bound.bindingId }, body: { equipmentCode: press, reason: 'the press controller' } }));
    expect(linked.processDeviceUnits.find((u) => u.bindingId === bound.bindingId)).toEqual({ bindingId: bound.bindingId, deviceCode, equipmentCode: press });

    // The adapter's registration status.
    const adapterCode = `OPCUA-W-${s}`;
    valueOf(await admin.call(D.registerAdapter, { body: { code: adapterCode, sourceSystem: 'OPCUA', accountId: gwAccount.accountId, deviceId: gw.deviceId, description: 'WP2 OPC UA feed' } }));
    expect(codeOf(await qa.call(D.setAdapterStatus, { params: { adapterCode }, body: { status: 'BLOCKED', reason: 'x' } }))).toBe('EBMR-IAM-040');
    expect(valueOf(await admin.call(D.setAdapterStatus, { params: { adapterCode }, body: { status: 'BLOCKED', reason: 'certificate expired' } })).status).toBe('BLOCKED');
    expect(codeOf(await admin.call(D.setAdapterStatus, { params: { adapterCode: `NONE-${s}` }, body: { status: 'BLOCKED', reason: 'x' } }))).toBe('EBMR-INT-016');
  }, 180_000);
});
