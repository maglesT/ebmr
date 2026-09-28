/**
 * Test support for the devices feature (module C5): enrols the test template's TEST-GW-01 key, starts the gateway
 * listener on an ephemeral loopback port, and drives it as the site gateway would (login with the key proof,
 * sealed readings in chain order, heartbeats), using only the integration SDK.
 */
import { randomBytes, randomUUID, sign } from 'node:crypto';
import type { ActorContext } from '@ebmr/kernel';
import {
  READING_FORMAT,
  ed25519PrivateKey,
  formatWeight,
  genesisHash,
  loginProofMessage,
  sealReading,
  type LoginResponse,
  type ReadingBody,
  type ScaleReading,
  type UplinkResponse,
} from '@ebmr/integration-sdk/scale';
import { freshTap, openPersonaSession, passwordActor, terminalOf } from '@ebmr/test-kit';
import { DEMO_GATEWAY, DEMO_INSTRUMENTS, enrolGateway } from '../../src/features/devices/enrol.ts';
import { startGatewayListener, type GatewayListener } from '../../src/features/devices/listener.ts';
import type { TestServer } from '../support/harness.ts';

export const GW = DEMO_GATEWAY.gatewayCode;

export function gatewayKey(server: TestServer) {
  const key = terminalOf(server.seed, GW).key;
  if (!key || key.algorithm !== 'ED25519') throw new Error('the test template has no Ed25519 key for TEST-GW-01');
  return key;
}

export function gatewayService(server: TestServer) {
  const s = server.seed.services.find((x) => x.key === 'gateway');
  if (!s) throw new Error('no gateway service identity in the seed');
  return s;
}

export async function adminActor(server: TestServer, reason = 'C5 test configuration'): Promise<ActorContext> {
  return passwordActor(server.db, server.seed.bootstrap.admin, server.seed.bootstrap.admin.fingerprint, {
    reasonCode: 'TEST_SETUP',
    reasonText: reason,
    correlationId: randomUUID(),
  });
}

export async function enrol(server: TestServer): Promise<string> {
  return enrolGateway(server.db.app, await adminActor(server), { ...DEMO_GATEWAY, spki: gatewayKey(server).publicKeySpki, instruments: DEMO_INSTRUMENTS });
}

export interface FakeGateway {
  listener: GatewayListener;
  base: string;
  login: LoginResponse;
  token: string;
  apiToken: string;
  /** Seals the next reading of the chain (seq and prevHash follow the last one made here). */
  next(overrides?: Partial<ReadingBody>): ScaleReading;
  uplink(items: { reading: ScaleReading; delayUs?: string | null }[]): Promise<{ status: number; body: UplinkResponse & { error?: { code: string } } }>;
  heartbeat(devices: { deviceCode: string; state: string; serial: string | null }[]): Promise<{ status: number; body: unknown }>;
  post(path: string, body: unknown, bearer?: string | null): Promise<{ status: number; body: unknown }>;
  close(): Promise<void>;
}

export async function post(base: string, path: string, body: unknown, bearer?: string | null): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as unknown) : null };
}

export async function loginAt(base: string, server: TestServer, opts: { spki?: string; privateKeyPkcs8?: string; serviceKey?: string; apiToken?: string } = {}) {
  const key = gatewayKey(server);
  const service = gatewayService(server);
  const nonce = (await post(base, '/gw/v1/nonce', {})).body as { nonce: string };
  const spki = opts.spki ?? key.publicKeySpki;
  const sig = sign(null, loginProofMessage(nonce.nonce, GW, service.loginName, spki), ed25519PrivateKey(opts.privateKeyPkcs8 ?? key.privateKeyPkcs8)).toString('base64');
  const apiToken = opts.apiToken ?? randomBytes(32).toString('base64url');
  const res = await post(base, '/gw/v1/session', {
    gatewayCode: GW,
    loginName: service.loginName,
    serviceKey: opts.serviceKey ?? service.serviceKey,
    spki,
    nonce: nonce.nonce,
    sig,
    apiToken,
  });
  return { ...res, apiToken };
}

/** Starts the listener and logs in as the enrolled gateway. */
export async function fakeGateway(server: TestServer): Promise<FakeGateway> {
  const listener = await startGatewayListener(server.built.ctx, { host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${listener.port}`;
  const res = await loginAt(base, server);
  if (res.status !== 200) {
    await listener.close();
    throw new Error(`gateway login failed: ${JSON.stringify(res.body)}`);
  }
  const login = res.body as LoginResponse;
  const privateKey = ed25519PrivateKey(gatewayKey(server).privateKeyPkcs8);
  let seq = BigInt(login.head.seq);
  let prev = login.head.hash;
  return {
    listener,
    base,
    login,
    token: (login as { token: string }).token,
    apiToken: res.apiToken,
    next(overrides = {}) {
      seq += 1n;
      const value = overrides.value === undefined ? '1.250' : overrides.value;
      const body: ReadingBody = {
        format: READING_FORMAT,
        readingId: randomUUID(),
        chainId: login.chainId,
        gatewayCode: GW,
        deviceCode: 'TEST-BAL-01',
        serial: 'SIM-0001',
        seq: seq.toString(),
        value,
        unit: 'kg',
        stable: true,
        status: 'OK',
        raw: formatWeight('S', 'S', value ?? '0.000', 'kg'),
        sourceTimeUs: '1790584618000000',
        trust: 'DEVICE_UNSYNCED',
        installation: 'SANDBOX',
        purpose: 'GROSS',
        prevHash: prev,
        ...overrides,
      };
      const sealed = sealReading(body, privateKey);
      prev = sealed.hash;
      return sealed;
    },
    async uplink(items) {
      const r = await post(base, '/gw/v1/readings', { items: items.map((i) => ({ reading: i.reading, delayUs: i.delayUs === undefined ? '1000' : i.delayUs })) }, login.token);
      return r as { status: number; body: UplinkResponse & { error?: { code: string } } };
    },
    heartbeat(devices) {
      return post(base, '/gw/v1/heartbeat', { gatewayTimeUs: '1790584618000000', devices, journal: { lastSeq: seq.toString(), ackedSeq: seq.toString() } }, login.token);
    },
    post(path, body, bearer) {
      return post(base, path, body, bearer === undefined ? login.token : bearer);
    },
    close: () => listener.close(),
  };
}

/** Resets the fake chain cursor to the server's head (after a refused reading). */
export function genesisOf(chainId: string): string {
  return genesisHash(chainId);
}

/** A kiosk operator's command context with a fresh badge tap (as C3's command would run the claim). */
export async function operatorActor(server: TestServer, key = 'operator1', terminal?: string): Promise<ActorContext> {
  const a = await openPersonaSession(server.db, server.seed, key, terminal);
  return { ...a, authEventId: await freshTap(server.db, server.seed, key, terminal), correlationId: randomUUID() };
}
