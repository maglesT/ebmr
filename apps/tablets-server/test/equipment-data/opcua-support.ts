/**
 * Server-side world of the slice 6b builder-A tests (tablets 1210, recipe-core 0961; DI-32, DI-20): a press unit in a
 * plant room, the process device behind the site gateway linked to it, the OPC UA endpoint serving it (an INSTRUMENT
 * with its certificate thumbprint, enrolled), and the OPCUA adapter that reports the endpoint's sessions. Set-up rows the
 * application cannot write (a plant room, a press with its qualification and cleaning) are written as the superuser with
 * triggers off for that transaction only; every control is proven as the application role.
 */
import { createHash, generateKeyPairSync, randomBytes, randomUUID, type KeyObject } from 'node:crypto';
import { feedKeyId, signFeedEnvelope, type FeedSignedFields, type GatewaySignature } from '@ebmr/integration-sdk/adapter';
import { ed25519PrivateKey } from '@ebmr/integration-sdk/scale';
import { identity, withCommand } from '@ebmr/kernel';
import { passwordActor } from '@ebmr/test-kit';
import { activateAccount, createAccount, createPerson, decideRoleGrant, issueInitialSecret, registerDevice, requestRoleGrant } from '../../../../packages/kernel/src/identity/admin.ts';
import { authenticate } from '../../../../packages/kernel/src/identity/authentication.ts';
import { openSession } from '../../../../packages/kernel/src/identity/sessions.ts';
import { withReason } from '../../../../packages/kernel/test/identity/seed.ts';
import { envelopeFor, nowUs, receive, type Administration, type TestAdapter } from '../../../../packages/kernel/test/integrations/support.ts';
import type { TestDatabase } from '../../../../packages/kernel/test/support/db.ts';
import { asSetup } from '../blocks/compression/plant-support.ts';
import { DEMO_GATEWAY } from '../../src/features/devices/enrol.ts';
import { adminActor, gatewayKey, GW } from '../devices/support.ts';
import type { TestServer } from '../support/harness.ts';

export interface OpcuaWorld {
  adm: Administration;
  adapter: TestAdapter;
  areaCode: string;
  unit: { id: string; code: string };
  /** The process device bound to the gateway enrolment, linked to the unit; its serial is the unit's code. */
  device: { code: string; serial: string };
  endpoint: { code: string; deviceId: string; thumbprint: string; url: string };
}

export async function administration(server: TestServer): Promise<Administration> {
  const b = server.seed.bootstrap;
  return { admin: await passwordActor(server.db, b.admin, b.admin.fingerprint), owner: await passwordActor(server.db, b.owner, b.owner.fingerprint), authn: server.db.authn };
}

/** A room, a PROCESS unit in it, its process device on gateway enrolment `chainId`, and an enrolled endpoint serving it. */
export async function opcuaWorld(server: TestServer, chainId: string, adm?: Administration): Promise<OpcuaWorld> {
  const t = randomBytes(3).toString('hex').toUpperCase();
  const a = adm ?? (await administration(server));
  const areaCode = `TEST-RM-OPC-${t}`;
  const areaId = randomUUID();
  await asSetup(server, `insert into plant.area (id, code, kind, name, segregated, negative_pressure, recorded_by) values ($1, $2, 'ROOM', $2, false, false, gen_random_uuid())`, [areaId, areaCode]);
  const classCode = `TEST-CL-OPC-${t}`;
  await asSetup(
    server,
    `insert into plant.equipment_class (code, kind, description, clean_hold, dirty_hold, calibration_required, recorded_by)
     values ($1, 'PROCESS', 'Rotary tablet press (OPC UA test)', interval '72 hours', interval '48 hours', false, gen_random_uuid())`,
    [classCode],
  );
  const unit = { id: randomUUID(), code: `TEST-PRESS-${t}` };
  await asSetup(server, `insert into plant.equipment (id, code, name, class_code, kind, area_id, recorded_by) values ($1, $2, $2, $3, 'PROCESS', $4, gen_random_uuid())`, [unit.id, unit.code, classCode, areaId]);
  const site = (await server.db.admin.query<{ s: string }>("select site_code as s from iam.device where device_class = 'INSTRUMENT' limit 1")).rows[0]?.s ?? 'SITE-1';
  const device = { code: `TEST-DEV-OPC-${t}`, serial: unit.code };
  const endpoint = { code: `TEST-OPC-${t}`, deviceId: '', thumbprint: randomBytes(32).toString('hex'), url: `opc.tcp://opc-${t.toLowerCase()}.plant.local:4840/ebmr` };
  await identity.withGuardedCommand(server.db.app, await adminActor(server), async (c) => {
    await c.query('select iam.register_device($1, $2, $3, $4, $5, $6, $7)', [device.code, 'INSTRUMENT', site, areaCode, null, createHash('sha256').update(`${device.code}:${randomUUID()}`).digest('hex'), 'Press unit behind the OPC UA endpoint']);
    const b = (await c.query<{ id: string }>('select tab.bind_process_device($1, $2, $3, $4) as id', [chainId, device.code, device.serial, 'PRESS'])).rows[0]!.id;
    await c.query('select tab.link_process_device_unit($1, $2)', [b, unit.code]);
    endpoint.deviceId = (await c.query<{ id: string }>('select iam.register_device($1, $2, $3, $4, $5, $6, $7) as id', [endpoint.code, 'INSTRUMENT', site, areaCode, null, endpoint.thumbprint, 'OPC UA endpoint of the press'])).rows[0]!.id;
    await c.query("select plant.enrol_opcua_endpoint($1, $2, 'Basic256Sha256', $3, 'commissioned (test)')", [endpoint.code, endpoint.url, [unit.code]]);
  });
  const adapter = await sandboxOpcuaAdapter(server, a, site);
  return { adm: a, adapter, areaCode, unit, device, endpoint };
}

/**
 * The OPCUA adapter's INTEGRATION identity on its own SERVER device, registered for OPCUA (the kernel helper's, with the
 * sandbox's TEST- labels, EBMR-SBX-022).
 */
export async function sandboxOpcuaAdapter(server: TestServer, adm: Administration, site: string): Promise<TestAdapter> {
  const db = server.db as unknown as TestDatabase;
  const t = randomBytes(3).toString('hex').toUpperCase();
  const login = `test-svc-opcua-${t.toLowerCase()}`;
  const fp = randomBytes(32).toString('hex');
  const created = await withCommand(db.app, withReason(adm.admin), async (c) => {
    const personId = await createPerson(c, 'SYSTEM', `TEST-OPCUA-ADAPTER-${t}`);
    const accountId = await createAccount(c, { personId, loginName: login, kind: 'INTEGRATION' });
    const { secret } = await issueInitialSecret(c, accountId, 'SERVICE_KEY');
    await activateAccount(c, accountId);
    const grantId = await requestRoleGrant(c, { accountId, roleCode: 'SERVICE_ACCOUNT', reason: 'test OPC UA adapter' });
    const deviceId = await registerDevice(c, { code: `TEST-SRV-OPCUA-${t}`, deviceClass: 'SERVER', site, fingerprint: fp, description: 'TEST OPC UA adapter host' });
    return { personId, accountId, secret, grantId, deviceId };
  });
  await withCommand(db.app, withReason(adm.owner), (c) => decideRoleGrant(c, created.grantId, true, 'approved for test'));
  const ev = await authenticate(adm.authn ?? { pool: db.admin, setRole: 'ebmr_authn' }, { method: 'SERVICE_KEY', identifier: login, secret: created.secret, deviceFingerprint: fp, purpose: 'LOGIN' });
  const s = await openSession(db.app, ev.authEventId, fp);
  const code = `TEST-OPCUA-${t}`;
  const id = await withCommand(db.app, withReason(adm.admin), async (c) =>
    (await c.query<{ id: string }>("select iam.register_integration_adapter($1, 'OPCUA', $2, $3, 'TEST OPC UA adapter') as id", [code, created.accountId, s.deviceId])).rows[0]!.id,
  );
  const actor = {
    personId: created.personId, accountId: created.accountId, roleCode: 'SERVICE_ACCOUNT', sessionId: s.sessionId, deviceId: s.deviceId, source: 'INTEGRATION' as const,
    siteZone: adm.admin.siteZone, legalName: `TEST-OPCUA-ADAPTER-${t}`,
    seed: { loginName: login, password: created.secret, deviceFingerprint: fp, deviceClass: 'SERVER' as const, grantId: created.grantId },
  };
  return { system: 'OPCUA', code, id, actor, seq: 0 };
}

/** The gateway reports a session of the world's endpoint (over: fields changed, e.g. another certificate). */
export function reportSession(server: TestServer, w: OpcuaWorld, over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const payload = {
    endpointCode: w.endpoint.code, endpointUrl: w.endpoint.url, securityMode: 'SignAndEncrypt', securityPolicy: 'Basic256Sha256',
    certificateThumbprint: w.endpoint.thumbprint, reportedLocation: w.areaCode, equipmentCodes: [w.unit.code], openedAt: nowUs(), ...over,
  };
  return receive(server.db as unknown as TestDatabase, w.adapter, 'plant.receive_opcua_endpoint_session', envelopeFor(w.adapter, 'opcua.endpoint_session', payload));
}


/** A gateway that signs its OPC UA feed (slice 7a): its code, key id (SHA-256 of its SPKI DER) and private key. */
export interface FeedSigner {
  gatewayCode: string;
  keyId: string;
  privateKey: KeyObject;
  /** Base64 SPKI DER of the public key, as tab.gateway_key holds it. */
  spki: string;
}

/** The seeded gateway's signer (TEST-GW-01, the key `enrol` enrols). */
export function seededGatewaySigner(server: TestServer): FeedSigner {
  const k = gatewayKey(server);
  return { gatewayCode: GW, keyId: feedKeyId(Buffer.from(k.publicKeySpki, 'base64')), privateKey: ed25519PrivateKey(k.privateKeyPkcs8), spki: k.publicKeySpki };
}

/**
 * Another gateway with its own key, made at run time: a SERVER device in the registry whose fingerprint is the key's
 * SHA-256, and the key enrolled for the seeded gateway's service account (tab.enrol_gateway_key).
 */
export async function otherGateway(server: TestServer): Promise<FeedSigner> {
  const pair = generateKeyPairSync('ed25519');
  const der = pair.publicKey.export({ type: 'spki', format: 'der' });
  const signer: FeedSigner = { gatewayCode: `TEST-GW-${randomBytes(3).toString('hex').toUpperCase()}`, keyId: feedKeyId(der), privateKey: pair.privateKey, spki: der.toString('base64') };
  const site = (await server.db.admin.query<{ s: string }>("select site_code as s from iam.device where code = $1", [GW])).rows[0]?.s ?? 'SITE-1';
  await identity.withGuardedCommand(server.db.app, await adminActor(server), async (c) => {
    await c.query("select iam.register_device($1, 'SERVER', $2, null, null, $3, 'TEST second site gateway')", [signer.gatewayCode, site, signer.keyId]);
    await c.query('select tab.enrol_gateway_key($1, $2, $3)', [signer.gatewayCode, signer.spki, DEMO_GATEWAY.loginName]);
  });
  return signer;
}

/** The device administrator binds the OPCUA adapter `adapterCode` to the feed of gateway `gatewayCode` (tablets 1405). */
export async function bindFeed(server: TestServer, adapterCode: string, gatewayCode: string): Promise<string> {
  return identity.withGuardedCommand(server.db.app, await adminActor(server), async (c) =>
    (await c.query<{ id: string }>("select tab.bind_gateway_feed($1, $2, 'TEST_SETUP', 'the OPC UA adapter pulls this gateway''s feed (test)') as id", [adapterCode, gatewayCode])).rows[0]!.id);
}

/** The envelope signed as gateway `s` (SDK signFeedEnvelope); `as` overrides the code and key id it names. */
export function signed<T extends Record<string, unknown>>(env: T, s: FeedSigner, as: { gatewayCode?: string; keyId?: string } = {}): T & { gatewaySignature: GatewaySignature } {
  const sig = signFeedEnvelope(env as unknown as FeedSignedFields, as.gatewayCode ?? s.gatewayCode, as.keyId ?? s.keyId, s.privateKey);
  return { ...env, gatewaySignature: sig };
}
