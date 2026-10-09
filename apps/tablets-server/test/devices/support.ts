/**
 * Test support for the devices feature (module C5): enrols the test template's TEST-GW-01 key, starts the gateway
 * listener on an ephemeral loopback port, and drives it as the site gateway would (login with the key proof,
 * sealed readings in chain order with their waits signed against a challenge from the database, heartbeats), using
 * only the integration SDK.
 */
import { randomBytes, randomUUID, sign } from 'node:crypto';
import type pg from 'pg';
import type { ActorContext } from '@ebmr/kernel';
import {
  READING_FORMAT,
  ed25519PrivateKey,
  formatWeight,
  genesisHash,
  loginProofMessage,
  sealReading,
  uploadWaitMessage,
  type LoginResponse,
  type ReadingBody,
  type ScaleReading,
  type UplinkResponse,
} from '@ebmr/integration-sdk/scale';
import { freshTap, openPersonaSession, passwordActor, terminalOf } from '@ebmr/test-kit';
import { DEMO_GATEWAY, DEMO_INSTRUMENTS, enrolGateway } from '../../src/features/devices/enrol.ts';
import { startGatewayListener, type GatewayListener } from '../../src/features/devices/listener.ts';
import { withActorCommand } from '../../src/platform/db/commands.ts';
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

/** DI-28: the enrolled gateway key's signature over a reading's wait for an upload's challenge (SDK uploadWaitMessage). */
export function signWait(server: TestServer, challengeId: string, readingId: string, delayUs: string): string {
  return sign(null, uploadWaitMessage(challengeId, readingId, delayUs), ed25519PrivateKey(gatewayKey(server).privateKeyPkcs8)).toString('base64');
}

/** A challenge the database issues to the gateway session `actor` (as the listener's POST /gw/v1/challenge does). */
export async function issueChallenge(server: TestServer, actor: ActorContext): Promise<{ challengeId: string; issuedUs: bigint }> {
  const r = await withActorCommand(server.db.app, actor, async (c) => (await c.query<{ r: { challengeId: string; issuedUs: string } }>('select tab.issue_ingest_challenge() as r')).rows[0]?.r);
  if (!r) throw new Error('tab.issue_ingest_challenge returned nothing');
  return { challengeId: r.challengeId, issuedUs: BigInt(r.issuedUs) };
}

/** The statement the listener sends for one reading: tab.ingest_reading(reading, wait, challenge, wait signature). */
export const INGEST_READING_SQL = 'select tab.ingest_reading($1::jsonb, $2::bigint, $3::uuid, $4) as r';

/**
 * The parameters of INGEST_READING_SQL for `reading` with the wait `delayUs` as the gateway proves it: signed with the
 * enrolled key over a challenge the database has just issued to `actor` (the gateway session).
 */
export async function provenIngestParams(server: TestServer, actor: ActorContext, reading: ScaleReading, delayUs = '0'): Promise<[string, string, string, string]> {
  const { challengeId } = await issueChallenge(server, actor);
  return [JSON.stringify(reading), delayUs, challengeId, signWait(server, challengeId, reading.readingId, delayUs)];
}

/** tab.ingest_reading called directly in a command of the gateway session `actor`, with a proven wait (default 0). */
export async function ingestProven(server: TestServer, actor: ActorContext, reading: ScaleReading, delayUs = '0', client?: pg.PoolClient): Promise<unknown> {
  const params = await provenIngestParams(server, actor, reading, delayUs);
  if (client) return (await client.query<{ r: unknown }>(INGEST_READING_SQL, params)).rows[0]?.r;
  return withActorCommand(server.db.app, actor, async (c) => (await c.query<{ r: unknown }>(INGEST_READING_SQL, params)).rows[0]?.r);
}

export interface FakeGateway {
  listener: GatewayListener;
  base: string;
  login: LoginResponse;
  token: string;
  apiToken: string;
  /** Seals the next reading of the chain (seq and prevHash follow the last one made here). */
  next(overrides?: Partial<ReadingBody>): ScaleReading;
  /** A challenge from the listener (POST /gw/v1/challenge); throws unless it answers 200. */
  challenge(): Promise<string>;
  /**
   * One upload as the gateway sends it: a fresh challenge (or `opts.challengeId`), then each item's wait (default
   * '1000') signed with the gateway key over the challenge and the reading id (`waitSig` given: sent as it is). When the
   * challenge is refused, that answer is returned.
   */
  uplink(
    items: { reading: ScaleReading; delayUs?: string | null; waitSig?: string | null }[],
    opts?: { challengeId?: string },
  ): Promise<{ status: number; body: UplinkResponse & { error?: { code: string } } }>;
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
    async challenge() {
      const r = await post(base, '/gw/v1/challenge', {}, login.token);
      if (r.status !== 200) throw new Error(`the challenge was refused: ${JSON.stringify(r.body)}`);
      return (r.body as { challengeId: string }).challengeId;
    },
    async uplink(items, opts = {}) {
      type Answer = { status: number; body: UplinkResponse & { error?: { code: string } } };
      let challengeId = opts.challengeId;
      if (challengeId === undefined) {
        const c = await post(base, '/gw/v1/challenge', {}, login.token);
        if (c.status !== 200) return c as Answer;
        challengeId = (c.body as { challengeId: string }).challengeId;
      }
      const cid = challengeId;
      const body = {
        challengeId: cid,
        items: items.map((i) => {
          const delayUs = i.delayUs === undefined ? '1000' : i.delayUs;
          const waitSig = i.waitSig !== undefined ? i.waitSig : delayUs === null ? null : sign(null, uploadWaitMessage(cid, i.reading.readingId, delayUs), privateKey).toString('base64');
          return { reading: i.reading, delayUs, waitSig };
        }),
      };
      return (await post(base, '/gw/v1/readings', body, login.token)) as Answer;
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
