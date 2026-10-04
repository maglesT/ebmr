/**
 * Scale readings from the site gateway, rule by rule (SQL mutation group "device-readings": tablets 0250, 0270, 0290,
 * 0320, 0330 and 0360). These tests close the gaps the SQL mutation run (tools/sql-mutation) found in the group's server
 * tests (test/devices/ingest, reading-proof, reading-age, reading-age-policy, claim, claim-room, gateway-role,
 * refused-weighing-readings and stale-weighing-readings), which drive the readings end to end through the honest
 * gateway and a few forgeries:
 *   - the registry of gateway keys and instrument bindings: what tab.enrol_gateway_key, tab.revoke_gateway_key,
 *     tab.bind_instrument and tab.end_instrument_binding refuse, what a revocation or an end touches (that key's or
 *     that binding's rows only), the reason both need (tab.with_reason_context), and the row guards that keep an
 *     enrolled key or a binding from ever changing but by revocation and end (tab.gateway_key_guard,
 *     tab.gateway_instrument_guard);
 *   - the gateway's sessions: what tab.bind_gateway_session refuses and answers, what tab.resolve_gateway_session
 *     reports (and, microsecond by microsecond, the roles of grants held from their valid_from up to, not at, their
 *     valid_to), which session tab.actor_gateway_key takes for a reading's command, and what
 *     tab.record_gateway_refusal records for a refused transfer;
 *   - tab.ingest_reading's own refusals (the id, the sequence and the format, a reading id already used for other
 *     content, a reading of another enrolment, an instrument no longer ACTIVE) and the proof of a stored reading
 *     (tab.device_reading_problem: a raw line naming another unit);
 *   - the proof functions on their own: tab.ed25519_decode (only the canonical encoding of a point),
 *     tab.ed25519_verify (false, never true or null, for a missing or malformed argument, S = L, and the whole of S
 *     counted), tab.reading_signature_valid and tab.upload_wait_signature_valid (a hash, a wait, an SPKI or a
 *     signature text that is not the one the format names) and tab.raw_weight_interpretation (no line over 128
 *     characters);
 *   - tab.claim_readings and tab.alert_refused_claim: who may claim or alert, the claim's own arguments, and readings
 *     that reached the table without ingestion (another installation's, one of a terminal that is no instrument);
 *     the binding a claim needs; the maximum age at its exact microsecond (a reading exactly that old is not too
 *     old); and tab.alert_claim_refusal (0250), no longer executable by the application role.
 * Everything goes through the functions the server and the listener call, with the application role and the actors
 * they build (the gateway session's actor, an operator's command with a fresh tap, the administrator's command). The
 * private helpers (the Ed25519 functions, the signature checks, the raw-line reader, tab.alert_claim_refusal) are called
 * as the superuser, as the module tests call them. Where only a state no product path produces reaches a rule (a row
 * written by owner-level code, a reading that reached the table without ingestion, a key revoked without its
 * sessions), or one no test can produce through the product in its time (thousands of copies of an approved
 * one-microsecond grant, in a transaction rolled back), the superuser writes it, and the comment says so.
 *
 * Controls: DI-14, DI-16, DI-17, DI-20, DI-22, DI-23, DI-28, DI-31, DI-32, INV-40.
 */
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { identity, type ActorContext } from '@ebmr/kernel';
import { freshTap, openPersonaSession, openServiceSession, passwordActor, terminalOf } from '@ebmr/test-kit';
import {
  READING_FORMAT,
  ed25519PrivateKey,
  formatWeight,
  genesisHash,
  interpretWeightLine,
  readingHash,
  sealReading,
  signatureMessage,
  uploadWaitMessage,
  type ReadingBody,
  type ScaleReading,
} from '@ebmr/integration-sdk/scale';
import { gatewayActor, gatewaySessionOf } from '../../src/features/devices/listener.ts';
import { withActorCommand } from '../../src/platform/db/commands.ts';
import { startServer, type TestServer } from '../support/harness.ts';
import { GW, INGEST_READING_SQL, adminActor, enrol, fakeGateway, gatewayKey, gatewayService, ingestProven, issueChallenge, operatorActor, signWait, type FakeGateway } from '../devices/support.ts';

type Json = Record<string, unknown>;

let server: TestServer;
let gw: FakeGateway;
/** The enrolment (chain id) of TEST-GW-01, the seeded gateway. */
let key1: string;
/** A second enrolment, of TEST-GW-02 (registered here) for the same gateway identity; revoked by the revocation test. */
let key2: string;
/** The key pair of TEST-GW-02 and the one TEST-GW-03 is registered with (never enrolled). */
const kp2 = generateKeyPairSync('ed25519');
const kp3 = generateKeyPairSync('ed25519');
const spkiOf = (k: KeyObject): Buffer => k.export({ type: 'spki', format: 'der' });
const spki2 = spkiOf(kp2.publicKey).toString('base64');
const spki3 = spkiOf(kp3.publicKey).toString('base64');
const sha256Hex = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const fingerprintOf = (spkiBase64: string): string => sha256Hex(Buffer.from(spkiBase64, 'base64'));
/** Device ids by code (the seeded ones and those registered here). */
const deviceIds = new Map<string, string>();
/** A gateway session opened first of all, so that it is more than 10 seconds old when the binding test reaches it. */
let oldSession: { sessionId: string; openedAt: number };

beforeAll(async () => {
  server = await startServer('SANDBOX');
  oldSession = { sessionId: (await openServiceSession(server.db, server.seed, 'gateway')).sessionId, openedAt: performance.now() };
  key1 = await enrol(server);
  gw = await fakeGateway(server);
  const admin = await adminActor(server, 'device-readings kill tests: devices, enrolments and bindings');
  const site = (await server.db.admin.query<{ site_code: string }>("select site_code from iam.device where code = 'TEST-GW-01'")).rows[0]?.site_code;
  key2 = await withActorCommand(server.db.app, admin, async (c) => {
    const register = async (code: string, cls: string, room: string | null, fingerprint: string) =>
      (await c.query<{ id: string }>('select iam.register_device($1, $2, $3, $4, null, $5, $6) as id', [code, cls, site, room, fingerprint, `${code} (device-readings kill tests)`])).rows[0]?.id ?? '';
    const block = (id: string) => c.query("select iam.set_device_status($1, 'BLOCKED', 'blocked for the device-readings kill tests')", [id]);
    await register('TEST-GW-02', 'SERVER', null, fingerprintOf(spki2));
    await register('TEST-GW-03', 'SERVER', null, fingerprintOf(spki3));
    await block(await register('TEST-GW-04', 'SERVER', null, sha256Hex(randomBytes(32))));
    await register('TEST-BAL-03', 'INSTRUMENT', 'DISP-1', sha256Hex(randomBytes(32)));
    await block(await register('TEST-BAL-04', 'INSTRUMENT', 'DISP-1', sha256Hex(randomBytes(32))));
    await register('TEST-BAL-05', 'INSTRUMENT', 'BLEND-1', sha256Hex(randomBytes(32)));
    const k2 = (await c.query<{ id: string }>("select tab.enrol_gateway_key('TEST-GW-02', $1, $2) as id", [spki2, gatewayService(server).loginName])).rows[0]?.id ?? '';
    // TEST-BAL-02 (BLEND-1) is bound to the second key; TEST-BAL-03 (DISP-1) to the first, beside TEST-BAL-01; TEST-BAL-05
    // was bound to the first key and that binding has ended.
    await c.query("select tab.bind_instrument($1, 'TEST-BAL-02', 'SIM-0002', 'kg', '0.01')", [k2]);
    await c.query("select tab.bind_instrument($1, 'TEST-BAL-03', 'SIM-0003', 'kg', '0.001')", [key1]);
    const b5 = (await c.query<{ id: string }>("select tab.bind_instrument($1, 'TEST-BAL-05', 'SIM-0005', 'kg', '0.01') as id", [key1])).rows[0]?.id;
    await c.query("select tab.end_instrument_binding($1, 'TEST_SETUP', 'ended for the device-readings kill tests')", [b5]);
    return k2;
  });
  for (const r of (await server.db.admin.query<{ code: string; id: string }>('select code, id::text as id from iam.device')).rows) deviceIds.set(r.code, r.id);
}, 300_000);

afterAll(async () => {
  await gw?.close();
  await server?.close();
});

// ---------------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------------

const deviceId = (code: string): string => {
  const id = deviceIds.get(code);
  if (!id) throw new Error(`SETUP: no device ${code}`);
  return id;
};

const key1Private = (): KeyObject => ed25519PrivateKey(gatewayKey(server).privateKeyPkcs8);
const spki1 = (): string => gatewayKey(server).publicKeySpki;
/** The 32 bytes of the enrolled TEST-GW-01 key (its SPKI without the 12-byte header). */
const rawKey1 = (): Buffer => Buffer.from(spki1(), 'base64').subarray(12);

/** The actor of the fake gateway's live session, as the listener builds it from its bearer token. */
async function gwActor(): Promise<ActorContext> {
  const hash = sha256Hex(gw.token);
  const { rows } = await server.db.app.query<{ r: Json | null }>('select tab.resolve_gateway_session($1) as r', [hash]);
  const s = rows[0]?.r;
  if (!s) throw new Error('SETUP: the fake gateway session does not resolve');
  return gatewayActor(gatewaySessionOf(hash, s), server.config.siteZone, randomUUID());
}

async function head(chain = key1): Promise<{ seq: string; hash: string }> {
  const { rows } = await server.db.app.query<{ h: { seq: string; hash: string } }>('select tab.chain_head($1) as h', [chain]);
  if (!rows[0]) throw new Error('SETUP: no chain head');
  return rows[0].h;
}

/** The next reading body of TEST-GW-01's chain (at the server's head): TEST-BAL-01, 1.250 kg stable, taken as GROSS. */
function body(h: { seq: string; hash: string }, overrides: Partial<ReadingBody> = {}): ReadingBody {
  return {
    format: READING_FORMAT,
    readingId: randomUUID(),
    chainId: key1,
    gatewayCode: GW,
    deviceCode: 'TEST-BAL-01',
    serial: 'SIM-0001',
    seq: (BigInt(h.seq) + 1n).toString(),
    value: '1.250',
    unit: 'kg',
    stable: true,
    status: 'OK',
    raw: formatWeight('S', 'S', '1.250', 'kg'),
    sourceTimeUs: '1790584618000000',
    trust: 'DEVICE_UNSYNCED',
    installation: 'SANDBOX',
    purpose: 'GROSS',
    prevHash: h.hash,
    ...overrides,
  };
}

const nextReading = async (overrides: Partial<ReadingBody> = {}): Promise<ScaleReading> => sealReading(body(await head(), overrides), key1Private());

/** tab.ingest_reading in a command of the fake gateway's session, its wait (default 0) proven as the gateway proves it. */
const ingest = async (reading: ScaleReading, delayUs = '0'): Promise<unknown> => ingestProven(server, await gwActor(), reading, delayUs);

/** A fresh reading of TEST-GW-01's chain, ingested; its id. */
async function ingested(overrides: Partial<ReadingBody> = {}): Promise<string> {
  const r = await nextReading(overrides);
  await ingest(r);
  return r.readingId;
}

/** tab.ingest_reading in a command of the fake gateway's session with an unknown wait (no proof needed), for its refusals. */
async function ingestUnproven(reading: Json): Promise<unknown> {
  return withActorCommand(server.db.app, await gwActor(), async (c) => (await c.query<{ r: unknown }>(INGEST_READING_SQL, [JSON.stringify(reading), null, null, null])).rows[0]?.r);
}

async function stored(id: string): Promise<number> {
  return (await server.db.admin.query('select 1 from tab.device_reading where id = $1', [id])).rowCount ?? 0;
}

/** The administrator's command (IAM.DEVICE_MANAGE), with the statement's result row. */
async function asAdministrator<T extends Json>(sql: string, params: unknown[]): Promise<T | undefined> {
  return withActorCommand(server.db.app, await adminActor(server, 'device-readings kill tests'), async (c) => (await c.query<T>(sql, params)).rows[0]);
}

/** A gateway identity's session on the SERVER device whose registered fingerprint is `fingerprint` (its service key login). */
async function serviceLogin(fingerprint: string): Promise<string> {
  const s = gatewayService(server);
  const ev = await identity.authenticate(server.db.authn, { method: 'SERVICE_KEY', identifier: s.loginName, secret: s.serviceKey, deviceFingerprint: fingerprint, purpose: 'LOGIN' });
  return (await identity.openSession(server.db.app, ev.authEventId, fingerprint)).sessionId;
}

const fingerprint1 = (): string => terminalOf(server.seed, GW).fingerprint;

/** tab.bind_gateway_session as the listener calls it at login, for a new bearer token; the token's hash and the answer. */
async function bindSession(sessionId: string, spki: string): Promise<{ hash: string; answer: Json }> {
  const hash = sha256Hex(randomBytes(32).toString('base64url'));
  const { rows } = await server.db.app.query<{ r: Json }>('select tab.bind_gateway_session($1, $2, $3) as r', [sessionId, hash, spki]);
  return { hash, answer: rows[0]?.r ?? {} };
}

async function gatewaySessionRows(sessionId: string): Promise<{ gateway_key_id: string; unbound: boolean }[]> {
  return (
    await server.db.admin.query<{ gateway_key_id: string; unbound: boolean }>(
      'select gateway_key_id::text as gateway_key_id, unbound_at is not null as unbound from tab.gateway_session where session_id = $1',
      [sessionId],
    )
  ).rows;
}

async function resolve(hash: string): Promise<Json | null> {
  return (await server.db.app.query<{ r: Json | null }>('select tab.resolve_gateway_session($1) as r', [hash])).rows[0]?.r ?? null;
}

async function keyRow(id: string): Promise<Json> {
  const row = (await server.db.admin.query<{ k: Json }>('select to_jsonb(k) as k from tab.gateway_key k where id = $1', [id])).rows[0]?.k;
  if (!row) throw new Error(`SETUP: no gateway key ${id}`);
  return row;
}

async function bindingOf(deviceCode: string, active = true): Promise<Json> {
  const row = (
    await server.db.admin.query<{ b: Json }>(
      `select to_jsonb(b) as b from tab.gateway_instrument b where device_code = $1 and (ended_at is null) = $2 order by bound_at desc limit 1`,
      [deviceCode, active],
    )
  ).rows[0]?.b;
  if (!row) throw new Error(`SETUP: no ${active ? 'active' : 'ended'} binding of ${deviceCode}`);
  return row;
}

/** A kiosk operator's command on the DISP-1 kiosk with a fresh tap (operatorActor); the claim's answer. */
async function claim(ids: unknown, opts: { room?: string | null; maxAgeUs?: string | null; purpose?: string | null; persona?: string } = {}): Promise<unknown> {
  const actor = await operatorActor(server, opts.persona ?? 'operator1');
  const params = [ids, 'room' in opts ? opts.room : 'DISP-1', 'maxAgeUs' in opts ? opts.maxAgeUs : '120000000', 'purpose' in opts ? opts.purpose : 'GROSS'];
  return withActorCommand(server.db.app, actor, async (c) => (await c.query<{ r: unknown }>('select tab.claim_readings($1::uuid[], $2, $3::bigint, $4) as r', params)).rows[0]?.r);
}

async function uses(id: string): Promise<number> {
  return (await server.db.admin.query('select 1 from tab.reading_use where reading_id = $1', [id])).rowCount ?? 0;
}

/** The superuser's call of a private function; the result's single column. */
async function su<T>(sql: string, params: unknown[]): Promise<T> {
  return (await server.db.admin.query<{ r: T }>(sql, params)).rows[0]?.r as T;
}

/** A pattern matching exactly `text`. */
const exactly = (text: string): RegExp => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** The same 64 bytes as a canonical base64 signature, with the unused bits of the 86th character set (not canonical). */
const nonCanonical = (sig: string): string => `${sig.slice(0, 85)}${BASE64[BASE64.indexOf(sig[85] ?? 'A') | 0x0f] ?? ''}==`;

// ---------------------------------------------------------------------------------------------------------------------
// Gateway sessions
// ---------------------------------------------------------------------------------------------------------------------

describe('gateway sessions: binding, resolution, the session of a reading command, refusals on record', () => {
  it('[DI-31][DI-20] a fresh session of the gateway identity on its SERVER device binds beside the sessions already bound, and the answer names the enrolment, its head and only its active instruments; the same session never binds twice (EBMR-DEV-022)', async () => {
    const others = await server.db.admin.query("select 1 from tab.gateway_session where unbound_at is null and gateway_key_id = $1", [key1]);
    expect(others.rowCount).toBeGreaterThan(0); // the fake gateway's own session
    const session = await serviceLogin(fingerprint1());
    const { hash, answer } = await bindSession(session, spki1());
    // TEST-BAL-05's binding to this key has ended, TEST-BAL-02 is bound to another key: neither is this enrolment's.
    expect(answer).toEqual({
      chain_id: key1,
      gateway_code: GW,
      head: await head(),
      installation: 'SANDBOX',
      server_time_us: expect.stringMatching(/^[0-9]+$/) as unknown,
      instruments: [
        { deviceCode: 'TEST-BAL-01', serial: 'SIM-0001', unit: 'kg', resolution: '0.001', roomCode: 'DISP-1' },
        { deviceCode: 'TEST-BAL-03', serial: 'SIM-0003', unit: 'kg', resolution: '0.001', roomCode: 'DISP-1' },
      ],
    });
    expect(await gatewaySessionRows(session)).toEqual([{ gateway_key_id: key1, unbound: false }]);
    expect((await resolve(hash))?.['session_id']).toBe(session);
    await expect(bindSession(session, spki1())).rejects.toThrow(/^EBMR-DEV-022 the session is already bound$/);
    expect(await gatewaySessionRows(session)).toEqual([{ gateway_key_id: key1, unbound: false }]);
  });

  it('[DI-31] a session the server bound for a browser cannot become a gateway session (EBMR-DEV-022)', async () => {
    const person = await openPersonaSession(server.db, server.seed, 'issuer');
    await server.db.app.query('select tab.bind_session($1, $2, $3)', [person.sessionId, sha256Hex(randomBytes(32)), person.roleCode]);
    await expect(bindSession(person.sessionId, spki1())).rejects.toThrow(/^EBMR-DEV-022 the session is already bound$/);
    expect(await gatewaySessionRows(person.sessionId)).toEqual([]);
  });

  it('[DI-31] an unknown session or one that has ended is never bound (EBMR-DEV-020)', async () => {
    await expect(bindSession(randomUUID(), spki1())).rejects.toThrow(/^EBMR-DEV-020 the gateway session does not exist or has ended$/);
    const ended = await serviceLogin(fingerprint1());
    await identity.endSession(server.db.app, ended);
    await expect(bindSession(ended, spki1())).rejects.toThrow(/^EBMR-DEV-020 the gateway session does not exist or has ended$/);
    expect(await gatewaySessionRows(ended)).toEqual([]);
  });

  it('[DI-31][DI-17] a SERVICE identity on its own SERVER device (the sweeper) cannot open a gateway session (EBMR-DEV-023)', async () => {
    const sweeper = await openServiceSession(server.db, server.seed, 'sweeper');
    await expect(bindSession(sweeper.sessionId, spki1())).rejects.toThrow(
      /^EBMR-DEV-023 DI-31: only an INTEGRATION account on a SERVER device can open a gateway session$/,
    );
    expect(await gatewaySessionRows(sweeper.sessionId)).toEqual([]);
  });

  it('[DI-20] a session binds only with the key enrolled for its device: another key, or a device with no active enrolment, is refused (EBMR-DEV-024)', async () => {
    const refusal = /^EBMR-DEV-024 DI-20: no active gateway key enrolled for this device, key and account$/;
    // TEST-GW-01 presenting the key enrolled for TEST-GW-02 (same account, same SERVER class).
    const wrongKey = await serviceLogin(fingerprint1());
    await expect(bindSession(wrongKey, spki2)).rejects.toThrow(refusal);
    expect(await gatewaySessionRows(wrongKey)).toEqual([]);
    // TEST-GW-03 is a registered SERVER device of the gateway identity with no enrolment at all.
    const unenrolled = await serviceLogin(fingerprintOf(spki3));
    await expect(bindSession(unenrolled, spki3)).rejects.toThrow(refusal);
    expect(await gatewaySessionRows(unenrolled)).toEqual([]);
  });

  it('[DI-31] only a session opened in the last 10 seconds is bound (EBMR-DEV-021)', async () => {
    const left = oldSession.openedAt + 11_000 - performance.now();
    if (left > 0) await new Promise<void>((r) => setTimeout(r, left));
    await expect(bindSession(oldSession.sessionId, spki1())).rejects.toThrow(/^EBMR-DEV-021 only a session opened in the last 10 seconds can be bound$/);
    expect(await gatewaySessionRows(oldSession.sessionId)).toEqual([]);
  }, 30_000);

  it('[DI-31][DI-17] a bound token resolves to its own session, account, enrolment and the roles the account holds now', async () => {
    const session = await serviceLogin(fingerprint1());
    const { hash } = await bindSession(session, spki1());
    const s = gatewayService(server);
    expect(await resolve(hash)).toEqual({
      session_id: session,
      person_id: s.personId,
      account_id: s.accountId,
      device_id: deviceId(GW),
      legal_name: s.legalName,
      login_name: s.loginName,
      state: expect.any(String) as unknown,
      chain_id: key1,
      gateway_code: GW,
      public_key_spki: spki1(),
      roles: ['SITE_GATEWAY'],
    });
    expect(await resolve(sha256Hex('no such token'))).toBeNull();
  });

  it('[DI-31][DI-20] a token whose enrolment is no longer ACTIVE resolves to nothing, whatever other key is active', async () => {
    // A bound session of TEST-GW-02's enrolment, then that key REVOKED by owner-level code without unbinding the
    // session (tab.revoke_gateway_key unbinds them; only a write past it leaves one), in a transaction rolled back.
    const session = await serviceLogin(fingerprintOf(spki2));
    const { hash, answer } = await bindSession(session, spki2);
    expect(answer['chain_id']).toBe(key2);
    expect((await resolve(hash))?.['chain_id']).toBe(key2);
    const c = await server.db.admin.connect();
    try {
      await c.query('begin');
      await c.query("set local session_replication_role = 'replica'");
      await c.query("update tab.gateway_key set status = 'REVOKED', revoked_at = clock_timestamp(), revoked_reason = 'revoked past the function (test)' where id = $1", [key2]);
      expect((await c.query<{ n: string }>("select count(*)::text as n from tab.gateway_key where status = 'ACTIVE'")).rows[0]?.n).toBe('1');
      expect((await c.query<{ r: Json | null }>('select tab.resolve_gateway_session($1) as r', [hash])).rows[0]?.r).toBeNull();
    } finally {
      await c.query('rollback');
      c.release();
    }
    expect((await resolve(hash))?.['chain_id']).toBe(key2);
    await server.db.app.query('select tab.unbind_gateway_session($1)', [hash]);
  });

  it('[DI-31] a reading command acts only from an INTEGRATION identity: the gateway session in source SYSTEM is refused (EBMR-DEV-030), nothing issued', async () => {
    const actor = { ...(await gwActor()), source: 'SYSTEM' as const };
    const before = await server.db.admin.query('select 1 from tab.ingest_challenge where session_id = $1', [actor.sessionId]);
    await expect(withActorCommand(server.db.app, actor, (c) => c.query('select tab.issue_ingest_challenge() as r'))).rejects.toThrow(
      /^EBMR-DEV-030 DI-31: readings and heartbeats come only from an INTEGRATION identity$/,
    );
    expect((await server.db.admin.query('select 1 from tab.ingest_challenge where session_id = $1', [actor.sessionId])).rowCount).toBe(before.rowCount);
  });

  it('[DI-31] a reading command needs its own session bound with an active key: a session never bound, or unbound since, is refused while other sessions are bound (EBMR-DEV-031)', async () => {
    const refusal = /^EBMR-DEV-031 the session is not a bound gateway session with an active key$/;
    const never = { ...(await openServiceSession(server.db, server.seed, 'gateway')), correlationId: randomUUID() };
    await expect(withActorCommand(server.db.app, never, (c) => c.query('select tab.issue_ingest_challenge() as r'))).rejects.toThrow(refusal);
    const loggedOut = await serviceLogin(fingerprint1());
    const { hash } = await bindSession(loggedOut, spki1());
    await server.db.app.query('select tab.unbind_gateway_session($1)', [hash]);
    const s = gatewayService(server);
    const actor: ActorContext = {
      personId: s.personId, accountId: s.accountId, roleCode: 'SITE_GATEWAY', sessionId: loggedOut, deviceId: deviceId(GW), source: 'INTEGRATION',
      siteZone: server.config.siteZone, legalName: s.legalName, correlationId: randomUUID(),
    };
    await expect(withActorCommand(server.db.app, actor, (c) => c.query('select tab.issue_ingest_challenge() as r'))).rejects.toThrow(refusal);
    expect((await server.db.admin.query('select 1 from tab.ingest_challenge where session_id = any($1::uuid[])', [[never.sessionId, loggedOut]])).rowCount).toBe(0);
    // Control: the bound session of the fake gateway is issued a challenge.
    await expect(issueChallenge(server, await gwActor())).resolves.toMatchObject({ challengeId: expect.any(String) as unknown });
  });

  it('[DI-31] a refused transfer is recorded against the gateway and session of its live token, authenticated; an unknown token records the claimed gateway, unauthenticated', async () => {
    const live = sha256Hex(gw.token);
    const session = (await resolve(live))?.['session_id'];
    const record = async (token: string, claimed: string) =>
      (
        await server.db.app.query<{ id: string }>("select tab.record_gateway_refusal($1, $2, 'GATEWAY_ALARM', 'TEST-CODE', null, 'refused in a test', $3::jsonb)::text as id", [
          token,
          claimed,
          JSON.stringify({ from: 'test' }),
        ])
      ).rows[0]?.id;
    const row = async (id: string | undefined) =>
      (
        await server.db.app.query<{ kind: string; code: string; gateway_code: string; session_id: string | null; message: string; details: Json }>(
          'select kind, code, gateway_code, session_id::text as session_id, message, details from tab.device_alarm where id = $1',
          [id],
        )
      ).rows[0];
    expect(await row(await record(live, 'TEST-GW-99'))).toEqual({
      kind: 'GATEWAY_ALARM', code: 'TEST-CODE', gateway_code: GW, session_id: session, message: 'refused in a test', details: { from: 'test', authenticated: true },
    });
    expect(await row(await record(sha256Hex('no such token'), 'TEST-GW-99'))).toEqual({
      kind: 'GATEWAY_ALARM', code: 'TEST-CODE', gateway_code: 'TEST-GW-99', session_id: null, message: 'refused in a test', details: { from: 'test', authenticated: false },
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The roles of a gateway token, microsecond by microsecond
// ---------------------------------------------------------------------------------------------------------------------

/**
 * tab.resolve_gateway_session reports the roles of grants held at the moment it reads each grant row: valid_from at or
 * before the clock, valid_to after it (kernel 0120: a grant holds on [valid_from, valid_to)). The clock is read per row,
 * so a one-microsecond grant [v, v + 1) is reported only by a resolution that reads its row in microsecond v, both
 * clock readings of that row being v.
 *
 * The grants: two customer roles any INTEGRATION account may hold (iam.create_role, IAM.ROLE_MANAGE), and one
 * one-microsecond grant of the first to the gateway's account, requested by the administrator and approved by the
 * process owner (iam.request_role_grant accepts any window with valid_to after valid_from). A sweep needs thousands of
 * such grants a few milliseconds ahead, which no test can request and approve one by one: the superuser copies the
 * approved grant (triggers off) into a transaction that is rolled back, each copy one microsecond, the latest first.
 * VACUUM FULL beforehand leaves no free space in the table, so the copies lie in the table in insertion order, latest
 * first, and are read in that order (a sequential scan, a bitmap scan, or an index scan on account_id, whose equal keys
 * are in heap order); a sweep whose copies are found out of that order is not counted. Then, as the
 * application role, in the same transaction, the sweep calls tab.resolve_gateway_session for the fake gateway's token
 * again and again until the clock has passed the copies.
 */
describe('a gateway token\'s roles at the microsecond: a grant holds from its valid_from up to, not at, its valid_to', () => {
  const MARK_A = 'TEST_GW_MARK_A';
  const MARK_B = 'TEST_GW_MARK_B';
  /** The approved one-microsecond grant of MARK_A to the gateway's account, which the sweeps copy. */
  let approved: string;

  beforeAll(async () => {
    const s = gatewayService(server);
    const admin = await adminActor(server, 'device-readings kill tests: marker roles of the gateway account');
    const requested = await withActorCommand(server.db.app, admin, async (c) => {
      for (const code of [MARK_A, MARK_B]) {
        await c.query("select iam.create_role($1, $2, 'EXECUTION', 'Marker role of the device-readings kill tests (no permission)', array['INTEGRATION'])", [code, `${code} (test)`]);
      }
      return identity.requestRoleGrant(c, {
        accountId: s.accountId, roleCode: MARK_A, validFrom: '2026-01-01T00:00:00.000000Z', validTo: '2026-01-01T00:00:00.000001Z', reason: 'one microsecond (device-readings kill tests)',
      });
    });
    const owner = await passwordActor(server.db, server.seed.bootstrap.owner, server.seed.bootstrap.owner.fingerprint, {
      reasonCode: 'TEST_SETUP', reasonText: 'device-readings kill tests: a one-microsecond grant', correlationId: randomUUID(),
    });
    await withActorCommand(server.db.app, owner, (c) => identity.decideRoleGrant(c, requested, true, 'one microsecond (device-readings kill tests)'));
    approved = requested;
  });

  interface Sweep {
    /** Whether the copies lay in the table latest first (otherwise the sweep is not counted). */
    ordered: boolean;
    calls: number;
    /** Answers naming MARK_A or MARK_B, and answers naming both. */
    marked: number;
    both: number;
  }

  /**
   * One sweep over 2000 copies of the approved grant, the first starting 50 ms after the copy statement's clock: role
   * MARK_A, or with `alternate` MARK_A for an even microsecond and MARK_B for an odd one.
   */
  async function sweep(alternate: boolean): Promise<Sweep> {
    const appRole = (await server.db.app.query<{ u: string }>('select current_user as u')).rows[0]?.u;
    const c = await server.db.admin.connect();
    try {
      await c.query('vacuum full iam.role_grant');
      await c.query('begin');
      await c.query("set local session_replication_role = 'replica'");
      const top = (
        await c.query<{ top: string }>(
          `with t as (select platform.epoch_micros(clock_timestamp()) + 50000 + 2000 as top)
           insert into iam.role_grant (account_id, person_id, role_code, valid_from, valid_to, reason, status, requested_by_person, requested_by_account,
                                       requested_at, decided_by_person, decided_by_account, decided_at, decision_reason)
           select g.account_id, g.person_id, case when $2 and (t.top - i) % 2 = 1 then $3 else g.role_code end,
                  timestamptz 'epoch' + (t.top - i) * interval '1 microsecond', timestamptz 'epoch' + (t.top - i + 1) * interval '1 microsecond',
                  g.reason, g.status, g.requested_by_person, g.requested_by_account, g.requested_at, g.decided_by_person, g.decided_by_account,
                  g.decided_at, g.decision_reason
             from iam.role_grant g, t, generate_series(0, 1999) i
            where g.id = $1
            order by i
           returning (select top from t)::text as top`,
          [approved, alternate, MARK_B],
        )
      ).rows[0]?.top;
      const ordered = (
        await c.query<{ ok: boolean }>(
          `select bool_and(prev is null or v < prev) as ok from (
             select platform.epoch_micros(valid_from) as v, lag(platform.epoch_micros(valid_from)) over (order by ctid) as prev
               from iam.role_grant where account_id = $1 and role_code in ($2, $3) and id <> $4) s`,
          [gatewayService(server).accountId, MARK_A, MARK_B, approved],
        )
      ).rows[0]?.ok;
      await c.query("select set_config('ebmr_test.token_hash', $1, true), set_config('ebmr_test.top', $2, true)", [sha256Hex(gw.token), top]);
      await c.query(`set local role "${appRole}"`);
      await c.query(`do $$
        declare
          v_top  bigint := current_setting('ebmr_test.top')::bigint;
          v_hash text := current_setting('ebmr_test.token_hash');
          v_r    jsonb;
          v_calls int := 0;
          v_marked int := 0;
          v_both int := 0;
        begin
          while platform.epoch_micros(clock_timestamp()) <= v_top + 2000 loop
            v_r := tab.resolve_gateway_session(v_hash) -> 'roles';
            v_calls := v_calls + 1;
            if v_r ? '${MARK_A}' or v_r ? '${MARK_B}' then v_marked := v_marked + 1; end if;
            if v_r ? '${MARK_A}' and v_r ? '${MARK_B}' then v_both := v_both + 1; end if;
          end loop;
          perform set_config('ebmr_test.sweep', format('%s %s %s', v_calls, v_marked, v_both), true);
        end $$`);
      const [calls = 0, marked = 0, both = 0] = ((await c.query<{ s: string }>("select current_setting('ebmr_test.sweep') as s")).rows[0]?.s ?? '').split(' ').map(Number);
      return { ordered: ordered === true, calls, marked, both };
    } finally {
      await c.query('rollback');
      c.release();
    }
  }

  /** Sweeps until `enough` answers named a marker role (ordered sweeps only), or `budgetMs` has passed. */
  async function sweepUntil(alternate: boolean, enough: number, budgetMs: number): Promise<Sweep & { sweeps: number; unordered: number }> {
    const total = { ordered: true, calls: 0, marked: 0, both: 0, sweeps: 0, unordered: 0 };
    const started = performance.now();
    while (total.marked < enough && performance.now() - started < budgetMs) {
      const s = await sweep(alternate);
      if (!s.ordered) {
        total.unordered += 1;
        continue;
      }
      total.sweeps += 1;
      total.calls += s.calls;
      total.marked += s.marked;
      total.both += s.both;
    }
    return total;
  }

  it('[DI-16][DI-31] a grant holds from its valid_from: a one-microsecond grant is reported by the resolution that reads it in that microsecond', async () => {
    // The approved grant itself (1 January 2026) is long past: the token resolves to the gateway's own role only.
    expect((await resolve(sha256Hex(gw.token)))?.['roles']).toEqual(['SITE_GATEWAY']);
    const r = await sweepUntil(false, 1, 60_000);
    expect(r.marked, JSON.stringify(r)).toBeGreaterThan(0);
    expect((await resolve(sha256Hex(gw.token)))?.['roles']).toEqual(['SITE_GATEWAY']);
    expect((await server.db.admin.query('select 1 from iam.role_grant where role_code in ($1, $2)', [MARK_A, MARK_B])).rowCount).toBe(1);
  }, 120_000);

  it('[DI-16][DI-31] a grant no longer holds at its valid_to: of adjacent one-microsecond grants, read latest first, no answer names two', async () => {
    // Along a sweep the clock never goes back while the grants go back one microsecond per row, so at most one row is
    // read in its own microsecond: at most one marker role per answer. A grant still held at its valid_to would also be
    // reported when read in the microsecond after its own, that is in the microsecond of the row before it (the other
    // marker role): both roles in one answer.
    const r = await sweepUntil(true, 60, 120_000);
    expect(r.marked, JSON.stringify(r)).toBeGreaterThanOrEqual(60);
    expect(r.both, JSON.stringify(r)).toBe(0);
    expect((await resolve(sha256Hex(gw.token)))?.['roles']).toEqual(['SITE_GATEWAY']);
  }, 180_000);
});

// ---------------------------------------------------------------------------------------------------------------------
// Enrolment, revocation, bindings
// ---------------------------------------------------------------------------------------------------------------------

describe('the registry of gateway keys and instrument bindings', () => {
  const enrolAs = (code: string, spki: string, login: string) => asAdministrator('select tab.enrol_gateway_key($1, $2, $3)::text as id', [code, spki, login]);
  const keysOf = async (code: string) => (await server.db.admin.query('select 1 from tab.gateway_key where gateway_code = $1', [code])).rowCount;

  it('[DI-20] a key is enrolled only for an ACTIVE SERVER device of the registry: an unknown code, an instrument and a blocked server are refused (EBMR-DEV-010)', async () => {
    for (const code of ['TEST-GW-404', 'TEST-BAL-02', 'TEST-GW-04']) {
      await expect(enrolAs(code, spki3, gatewayService(server).loginName)).rejects.toThrow(new RegExp(`^EBMR-DEV-010 ${code} is not an active SERVER device in the registry$`));
      expect(await keysOf(code)).toBe(0);
    }
  });

  it('[DI-20] the key is base64 DER whose SHA-256 is the fingerprint registered for the device (EBMR-DEV-011)', async () => {
    await expect(enrolAs('TEST-GW-03', '***', gatewayService(server).loginName)).rejects.toThrow(/^EBMR-DEV-011 the gateway public key is not base64 DER$/);
    await expect(enrolAs('TEST-GW-03', spki2, gatewayService(server).loginName)).rejects.toThrow(
      /^EBMR-DEV-011 DI-20: the key's fingerprint is not the one registered for TEST-GW-03$/,
    );
    expect(await keysOf('TEST-GW-03')).toBe(0);
  });

  it('[DI-20][DI-14] a key is enrolled only for an INTEGRATION account: an unknown login or a person\'s account is refused (EBMR-DEV-012)', async () => {
    await expect(enrolAs('TEST-GW-03', spki3, 'no-such-login')).rejects.toThrow(/^EBMR-DEV-012 no-such-login is not an INTEGRATION account$/);
    await expect(enrolAs('TEST-GW-03', spki3, 'test-operator-1')).rejects.toThrow(/^EBMR-DEV-012 test-operator-1 is not an INTEGRATION account$/);
    expect(await keysOf('TEST-GW-03')).toBe(0);
  });

  it('[DI-20] only an ACTIVE INSTRUMENT of the registry is bound: an unknown code, a server and a blocked balance are refused (EBMR-DEV-014)', async () => {
    for (const code of ['TEST-BAL-404', 'TEST-GW-03', 'TEST-BAL-04']) {
      await expect(asAdministrator("select tab.bind_instrument($1, $2, 'SIM-0009', 'kg', '0.01')::text as id", [key1, code])).rejects.toThrow(
        new RegExp(`^EBMR-DEV-014 ${code} is not an active INSTRUMENT in the registry$`),
      );
      expect((await server.db.admin.query('select 1 from tab.gateway_instrument where device_code = $1', [code])).rowCount).toBe(0);
    }
  });

  it('[DI-20] ending a binding ends that binding only; an ended or unknown binding cannot be ended (EBMR-DEV-015)', async () => {
    const id = (await asAdministrator<{ id: string }>("select tab.bind_instrument($1, 'TEST-BAL-05', 'SIM-0005', 'kg', '0.01')::text as id", [key1]))?.id;
    await asAdministrator("select tab.end_instrument_binding($1, 'INSTRUMENT_MOVED', 'moved to another line (test)')", [id]);
    const ended = (await server.db.admin.query<{ ended: boolean; reason: string }>('select ended_at is not null as ended, ended_reason as reason from tab.gateway_instrument where id = $1', [id])).rows[0];
    expect(ended).toEqual({ ended: true, reason: 'moved to another line (test)' });
    // The other bindings, of this key and of the other, are still active.
    const active = await server.db.admin.query<{ device_code: string }>('select device_code from tab.gateway_instrument where ended_at is null order by device_code');
    expect(active.rows.map((r) => r.device_code)).toEqual(['TEST-BAL-01', 'TEST-BAL-02', 'TEST-BAL-03']);
    const refusal = /^EBMR-DEV-015 no active instrument binding with this id$/;
    await expect(asAdministrator("select tab.end_instrument_binding($1, 'INSTRUMENT_MOVED', 'again (test)')", [id])).rejects.toThrow(refusal);
    await expect(asAdministrator("select tab.end_instrument_binding($1, 'INSTRUMENT_MOVED', 'unknown (test)')", [randomUUID()])).rejects.toThrow(refusal);
    expect((await server.db.admin.query<{ reason: string }>('select ended_reason as reason from tab.gateway_instrument where id = $1', [id])).rows[0]?.reason).toBe('moved to another line (test)');
  });

  it('[DI-22] ending a binding or revoking a key needs a reason code and a reason text, both (EBMR-DEV-009)', async () => {
    const binding = (await bindingOf('TEST-BAL-01'))['id'];
    const refusal = /^EBMR-DEV-009 a reason code and a reason text are required for this change$/;
    await expect(asAdministrator("select tab.end_instrument_binding($1, 'INSTRUMENT_MOVED', ' ')", [binding])).rejects.toThrow(refusal);
    await expect(asAdministrator("select tab.end_instrument_binding($1, '', 'moved (test)')", [binding])).rejects.toThrow(refusal);
    await expect(asAdministrator("select tab.revoke_gateway_key($1, 'KEY_RETIRED', '')", [key1])).rejects.toThrow(refusal);
    await expect(asAdministrator("select tab.revoke_gateway_key($1, null, 'retired (test)')", [key1])).rejects.toThrow(refusal);
    expect((await bindingOf('TEST-BAL-01'))['id']).toBe(binding);
    expect((await keyRow(key1))['status']).toBe('ACTIVE');
  });

  it('[DI-20][DI-31] revoking a key ends that key\'s instrument bindings and gateway sessions and nothing of any other key; a key that is not ACTIVE cannot be revoked (EBMR-DEV-013)', async () => {
    // A live session of TEST-GW-02's enrolment (TEST-BAL-02 is bound to it), beside the sessions of TEST-GW-01's.
    const session2 = await serviceLogin(fingerprintOf(spki2));
    const { hash: hash2 } = await bindSession(session2, spki2);
    const session1 = await serviceLogin(fingerprint1());
    const { hash: hash1 } = await bindSession(session1, spki1());
    const key1Sessions = (await server.db.admin.query<{ s: string }>('select session_id::text as s from tab.gateway_session where gateway_key_id = $1 and unbound_at is null order by 1', [key1])).rows;
    expect(key1Sessions.length).toBeGreaterThan(1);
    const key1Bindings = (await server.db.admin.query<{ id: string }>('select id::text as id from tab.gateway_instrument where gateway_key_id = $1 and ended_at is null order by 1', [key1])).rows;

    await asAdministrator("select tab.revoke_gateway_key($1, 'KEY_RETIRED', 'gateway TEST-GW-02 retired (test)')", [key2]);
    expect(await keyRow(key2)).toMatchObject({ status: 'REVOKED', revoked_reason: 'gateway TEST-GW-02 retired (test)' });
    expect((await keyRow(key2))['revoked_at']).not.toBeNull();
    expect(await bindingOf('TEST-BAL-02', false)).toMatchObject({ gateway_key_id: key2, ended_reason: 'gateway key revoked: gateway TEST-GW-02 retired (test)' });
    expect(await gatewaySessionRows(session2)).toEqual([{ gateway_key_id: key2, unbound: true }]);
    expect(await resolve(hash2)).toBeNull();
    // Nothing of TEST-GW-01's enrolment changed.
    expect((await keyRow(key1))['status']).toBe('ACTIVE');
    expect((await server.db.admin.query<{ s: string }>('select session_id::text as s from tab.gateway_session where gateway_key_id = $1 and unbound_at is null order by 1', [key1])).rows).toEqual(key1Sessions);
    expect((await server.db.admin.query<{ id: string }>('select id::text as id from tab.gateway_instrument where gateway_key_id = $1 and ended_at is null order by 1', [key1])).rows).toEqual(key1Bindings);
    expect((await resolve(hash1))?.['chain_id']).toBe(key1);

    const refusal = /^EBMR-DEV-013 no active gateway key with this id$/;
    const revokedAt = (await keyRow(key2))['revoked_at'];
    await expect(asAdministrator("select tab.revoke_gateway_key($1, 'KEY_RETIRED', 'again (test)')", [key2])).rejects.toThrow(refusal);
    await expect(asAdministrator("select tab.revoke_gateway_key($1, 'KEY_RETIRED', 'unknown (test)')", [randomUUID()])).rejects.toThrow(refusal);
    expect(await keyRow(key2)).toMatchObject({ status: 'REVOKED', revoked_at: revokedAt, revoked_reason: 'gateway TEST-GW-02 retired (test)' });
    expect((await keyRow(key1))['status']).toBe('ACTIVE');
  });

  it('[DI-20] an instrument is bound only to an ACTIVE key: a revoked key (while another is active) or an unknown one is refused (EBMR-DEV-013)', async () => {
    const refusal = /^EBMR-DEV-013 no active gateway key with this id$/;
    expect((await keyRow(key2))['status']).toBe('REVOKED');
    await expect(asAdministrator("select tab.bind_instrument($1, 'TEST-BAL-05', 'SIM-0005', 'kg', '0.01')", [key2])).rejects.toThrow(refusal);
    await expect(asAdministrator("select tab.bind_instrument($1, 'TEST-BAL-05', 'SIM-0005', 'kg', '0.01')", [randomUUID()])).rejects.toThrow(refusal);
    expect((await server.db.admin.query("select 1 from tab.gateway_instrument where device_code = 'TEST-BAL-05' and ended_at is null")).rowCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The row guards (owner-level code)
// ---------------------------------------------------------------------------------------------------------------------

describe('an enrolled key and a binding never change but by revocation and end, even for owner-level code', () => {
  it('[DI-20][DI-23] a key is enrolled ACTIVE: no code inserts a revoked one (EBMR-DEV-001)', async () => {
    const before = (await server.db.admin.query('select 1 from tab.gateway_key')).rowCount;
    await expect(
      server.db.admin.query(
        `insert into tab.gateway_key (gateway_device_id, gateway_code, account_id, public_key_spki, key_fingerprint, status, enrolled_by_person, revoked_at, revoked_reason)
         select gateway_device_id, gateway_code, account_id, public_key_spki, key_fingerprint, 'REVOKED', enrolled_by_person, clock_timestamp(), 'inserted revoked (test)'
           from tab.gateway_key where id = $1`,
        [key1],
      ),
    ).rejects.toThrow(/^EBMR-DEV-001 a gateway key is enrolled ACTIVE$/);
    expect((await server.db.admin.query('select 1 from tab.gateway_key')).rowCount).toBe(before);
  });

  it.each([
    ['id', 'gen_random_uuid()'],
    ['gateway_device_id', "(select id from iam.device where code = 'TEST-GW-03')"],
    ['gateway_code', "'TEST-GW-99'"],
    ['account_id', "(select id from iam.account where login_name = 'test-admin')"],
    ['public_key_spki', `'${spki2}'`],
    ['key_fingerprint', `'${'f'.repeat(64)}'`],
    ['enrolled_by_person', 'gen_random_uuid()'],
    ['enrolled_at', "enrolled_at - interval '1 second'"],
  ])('[DI-20][DI-23] the %s of an enrolled key never changes, alone (EBMR-DEV-002)', async (column, value) => {
    const before = await keyRow(key1);
    await expect(server.db.admin.query(`update tab.gateway_key set ${column} = ${value} where id = $1`, [key1])).rejects.toThrow(
      /^EBMR-DEV-002 an enrolled gateway key never changes; revoke it and enrol a new one$/,
    );
    expect(await keyRow(key1)).toEqual(before);
  });

  it('[DI-20][DI-23] a revoked key stays revoked: it is not made ACTIVE again, nor is its revocation rewritten (EBMR-DEV-003)', async () => {
    const before = await keyRow(key2);
    expect(before['status']).toBe('REVOKED');
    const refusal = /^EBMR-DEV-003 a revoked gateway key stays revoked$/;
    await expect(server.db.admin.query("update tab.gateway_key set status = 'ACTIVE', revoked_at = null, revoked_reason = null where id = $1", [key2])).rejects.toThrow(refusal);
    await expect(server.db.admin.query("update tab.gateway_key set revoked_reason = 'rewritten (test)' where id = $1", [key2])).rejects.toThrow(refusal);
    expect(await keyRow(key2)).toEqual(before);
  });

  it('[DI-20][DI-23] a binding starts active: no code inserts an ended one (EBMR-DEV-004)', async () => {
    await expect(
      server.db.admin.query(
        `insert into tab.gateway_instrument (gateway_key_id, instrument_device_id, device_code, expected_serial, unit, resolution, bound_by_person, ended_at, ended_reason)
         values ($1, $2, 'TEST-BAL-05', 'SIM-0005', 'kg', '0.01', gen_random_uuid(), clock_timestamp(), 'inserted ended (test)')`,
        [key1, deviceId('TEST-BAL-05')],
      ),
    ).rejects.toThrow(/^EBMR-DEV-004 an instrument binding starts active$/);
  });

  it.each([
    ['id', 'gen_random_uuid()'],
    ['gateway_key_id', '(select id from tab.gateway_key where gateway_code = \'TEST-GW-02\')'],
    ['instrument_device_id', "(select id from iam.device where code = 'TEST-BAL-05')"],
    ['device_code', "'TEST-BAL-99'"],
    ['expected_serial', "'SIM-9999'"],
    ['unit', "'g'"],
    ['resolution', "'0.01'"],
    ['bound_by_person', 'gen_random_uuid()'],
    ['bound_at', "bound_at - interval '1 second'"],
  ])('[DI-20][DI-23] the %s of an active binding never changes, alone (EBMR-DEV-005)', async (column, value) => {
    const before = await bindingOf('TEST-BAL-01');
    await expect(server.db.admin.query(`update tab.gateway_instrument set ${column} = ${value} where id = $1`, [before['id']])).rejects.toThrow(
      /^EBMR-DEV-005 an instrument binding never changes; end it and bind again$/,
    );
    expect(await bindingOf('TEST-BAL-01')).toEqual(before);
  });

  it('[DI-20][DI-23] an ended binding never changes: neither its end nor its reason (EBMR-DEV-005)', async () => {
    const before = await bindingOf('TEST-BAL-05', false);
    const refusal = /^EBMR-DEV-005 an instrument binding never changes; end it and bind again$/;
    await expect(server.db.admin.query("update tab.gateway_instrument set ended_reason = 'rewritten (test)' where id = $1", [before['id']])).rejects.toThrow(refusal);
    await expect(server.db.admin.query('update tab.gateway_instrument set ended_at = null, ended_reason = null where id = $1', [before['id']])).rejects.toThrow(refusal);
    expect(await server.db.admin.query<{ b: Json }>('select to_jsonb(b) as b from tab.gateway_instrument b where id = $1', [before['id']]).then((r) => r.rows[0]?.b)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------------------------------------------------

describe('ingestion: tab.ingest_reading\'s own refusals and the stored proof', () => {
  it('[DI-31] a reading id or sequence number that is not one is malformed (EBMR-DEV-040), nothing stored', async () => {
    const h = await head();
    const malformed = /^EBMR-DEV-040 DI-31: the reading id or sequence number is malformed$/;
    await expect(ingestUnproven({ ...body(h), readingId: 'not-a-uuid', hash: 'a'.repeat(64), signature: 'AAAA' })).rejects.toThrow(malformed);
    const r = body(h, { seq: 'x' });
    await expect(ingestUnproven({ ...r, hash: 'a'.repeat(64), signature: 'AAAA' })).rejects.toThrow(malformed);
    expect(await stored(r.readingId)).toBe(0);
    expect(await head()).toEqual(h);
  });

  it('[DI-31] a reading without an id or a sequence number, or with sequence 0, is refused (EBMR-DEV-040), nothing stored', async () => {
    const h = await head();
    const missing = /^EBMR-DEV-040 DI-31: the reading id or sequence number is missing$/;
    const noId = sealReading(body(h), key1Private());
    await expect(ingestUnproven({ ...noId, readingId: null })).rejects.toThrow(missing);
    const noSeq = sealReading(body(h), key1Private());
    await expect(ingestUnproven({ ...noSeq, seq: null })).rejects.toThrow(missing);
    const zero = sealReading(body(h, { seq: '0' }), key1Private());
    await expect(ingestUnproven(zero)).rejects.toThrow(missing);
    for (const r of [noId, noSeq, zero]) expect(await stored(r.readingId)).toBe(0);
    expect(await head()).toEqual(h);
  });

  it('[DI-31] a reading of another format is refused (EBMR-DEV-040), even hashed and signed as that format', async () => {
    const b = { ...body(await head()), format: 'ebmr.scale-reading.v2' } as unknown as ReadingBody;
    const hash = readingHash(b);
    const signature = sign(null, signatureMessage(hash), key1Private()).toString('base64');
    await expect(ingestUnproven({ ...b, hash, signature })).rejects.toThrow(/^EBMR-DEV-040 DI-31: unknown reading format$/);
    expect(await stored(b.readingId)).toBe(0);
  });

  it('[DI-31] a reading id already received with other content is refused (EBMR-DEV-041); the same reading again is a duplicate', async () => {
    const r = await nextReading();
    await ingest(r);
    const other = sealReading(body(await head(), { readingId: r.readingId, value: '2.000', raw: formatWeight('S', 'S', '2.000', 'kg') }), key1Private());
    await expect(ingest(other)).rejects.toThrow(new RegExp(`^EBMR-DEV-041 DI-31: reading ${r.readingId} was already received with different content$`));
    await expect(ingest(r)).resolves.toMatchObject({ outcome: 'DUPLICATE', readingId: r.readingId, seq: r.seq });
    const rows = await server.db.admin.query<{ value: string; hash: string }>('select value, hash from tab.device_reading where id = $1', [r.readingId]);
    expect(rows.rows).toEqual([{ value: '1.250', hash: r.hash }]);
    expect((await head()).seq).toBe(r.seq);
  });

  it('[DI-31] a reading of another enrolment (its chain or its gateway code) is refused (EBMR-DEV-042), nothing stored', async () => {
    const h = await head();
    const otherCode = sealReading(body(h, { gatewayCode: 'TEST-GW-02' }), key1Private());
    await expect(ingest(otherCode)).rejects.toThrow(
      new RegExp(`^EBMR-DEV-042 DI-31: the reading belongs to chain ${key1} of TEST-GW-02, not to this gateway's enrolment$`),
    );
    const otherChain = sealReading(body(h, { chainId: key2 }), key1Private());
    await expect(ingest(otherChain)).rejects.toThrow(new RegExp(`^EBMR-DEV-042 DI-31: the reading belongs to chain ${key2} of ${GW}, not to this gateway's enrolment$`));
    expect(await stored(otherCode.readingId)).toBe(0);
    expect(await stored(otherChain.readingId)).toBe(0);
  });

  it('[DI-32] a signed reading whose raw line states its value in another unit is refused (EBMR-DEV-062), nothing stored', async () => {
    const r = await nextReading({ value: '2.000', raw: formatWeight('S', 'S', '2.000', 'g') });
    await expect(ingest(r)).rejects.toThrow(exactly(`EBMR-DEV-062 DI-32: the raw line "${r.raw}" states 2.000 g (OK), not 2.000 kg (OK)`));
    expect(await stored(r.readingId)).toBe(0);
  });

  it('[DI-28][DI-31] a wait signature in non-canonical base64 (the same 64 bytes) is refused (EBMR-DEV-055); its canonical text is accepted', async () => {
    const r = await nextReading();
    const actor = await gwActor();
    const { challengeId } = await issueChallenge(server, actor);
    const sig = signWait(server, challengeId, r.readingId, '0');
    const variant = nonCanonical(sig);
    expect(Buffer.from(variant, 'base64').equals(Buffer.from(sig, 'base64'))).toBe(true);
    await expect(withActorCommand(server.db.app, actor, (c) => c.query(INGEST_READING_SQL, [JSON.stringify(r), '0', challengeId, variant]))).rejects.toThrow(/^EBMR-DEV-055 /);
    expect(await stored(r.readingId)).toBe(0);
    await withActorCommand(server.db.app, actor, (c) => c.query(INGEST_READING_SQL, [JSON.stringify(r), '0', challengeId, sig]));
    expect(await stored(r.readingId)).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The proof functions
// ---------------------------------------------------------------------------------------------------------------------

const Q = (1n << 255n) - 19n;
const L = (1n << 252n) + 27742317777372353535851937790883648493n;
/** n as `len` little-endian bytes. */
function le(n: bigint, len = 32): Buffer {
  const b = Buffer.alloc(len);
  let x = n;
  for (let i = 0; i < len; i++) {
    b[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return b;
}
const leInt = (b: Buffer): bigint => b.reduceRight((acc, byte) => (acc << 8n) | BigInt(byte), 0n);
/** The encoding of the neutral point (0, 1), and of the base point B (y = 4/5, x even). */
const NEUTRAL = le(1n);
const BASE_POINT = Buffer.from(`58${'66'.repeat(31)}`, 'hex');
const withSign = (p: Buffer): Buffer => Buffer.concat([p.subarray(0, 31), Buffer.from([(p[31] ?? 0) | 0x80])]);
/** k = SHA-512(R || A || M) mod L, as the verification derives it. */
const challengeScalar = (r: Buffer, a: Buffer, m: Buffer): bigint => leInt(createHash('sha512').update(Buffer.concat([r, a, m])).digest()) % L;
const verifySql = (key: Buffer | null, message: Buffer | null, signature: Buffer | null) => su<boolean | null>('select tab.ed25519_verify($1, $2, $3) as r', [key, message, signature]);
const ED25519_SPKI_HEADER = Buffer.from('302a300506032b6570032100', 'hex');
const X25519_SPKI_HEADER = Buffer.from('302a300506032b656e032100', 'hex');

describe('the proof functions on their own (superuser)', () => {
  it('[DI-31] tab.ed25519_decode takes only the canonical encoding of a point (RFC 8032 5.1.3): y below q, and no sign bit when x = 0', async () => {
    const decode = (p: Buffer) => su<string[] | null>('select tab.ed25519_decode($1)::text[] as r', [p]);
    expect(await decode(NEUTRAL)).toEqual(['0', '1', '1', '0']);
    expect(await decode(BASE_POINT)).not.toBeNull();
    // x = 0 with the sign bit set: the neutral point and (0, -1) written with a sign they cannot have.
    expect(await decode(withSign(NEUTRAL))).toBeNull();
    expect(await decode(le(Q - 1n))).toEqual(['0', (Q - 1n).toString(), '1', '0']);
    expect(await decode(withSign(le(Q - 1n)))).toBeNull();
    // y = q (the field's zero written unreduced) and y = q + 1, with either sign bit: no point.
    for (const y of [Q, Q + 1n]) {
      expect(await decode(le(y))).toBeNull();
      expect(await decode(withSign(le(y)))).toBeNull();
    }
  });

  it('[DI-31] tab.ed25519_verify answers false, never true or null, when an argument is missing or of the wrong length', async () => {
    // RFC 8032 section 7.1, test 1 (empty message).
    const k = Buffer.from('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'hex');
    const s = Buffer.from('e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b', 'hex');
    const m = Buffer.alloc(0);
    expect(await verifySql(k, m, s)).toBe(true);
    // R = B and S = 1 satisfy [S]B = R: with no message (so no k), a verification that skipped the message would accept it.
    const sB = Buffer.concat([BASE_POINT, le(1n)]);
    expect(await verifySql(rawKey1(), null, sB)).toBe(false);
    expect(await verifySql(null, m, s)).toBe(false);
    expect(await verifySql(k, m, null)).toBe(false);
    expect(await verifySql(k.subarray(0, 31), m, s)).toBe(false);
    expect(await verifySql(Buffer.concat([k, Buffer.from([0])]), m, s)).toBe(false);
    expect(await verifySql(k, m, Buffer.concat([s, Buffer.from([0])]))).toBe(false);
    expect(await verifySql(k, m, s.subarray(0, 63))).toBe(false);
  });

  it('[DI-31] tab.ed25519_verify refuses S = L and counts every bit of S: [S]B - [k]A must be R for S itself, not for S without its top bit', async () => {
    // Only a public key of small order lets a test choose S freely (for it [k]A does not depend on R). With A = the
    // neutral point the verification equation is [S]B = R.
    const a = NEUTRAL;
    const m = Buffer.from('ebmr.scale-reading.v1|device-readings kill test', 'utf8');
    // S = L: [L]B is the neutral point, but S must be below L (RFC 8032; OpenSSL), so this is refused.
    expect(await verifySql(a, m, Buffer.concat([NEUTRAL, le(L)]))).toBe(false);
    // S = 2^252 + 1 (below L, its bit 252 set): [S]B is not B, so R = B does not verify; dropping bit 252 would make it B.
    expect(challengeScalar(BASE_POINT, a, m) < 1n << 252n).toBe(true);
    expect(await verifySql(a, m, Buffer.concat([BASE_POINT, le((1n << 252n) + 1n)]))).toBe(false);
  });

  it('[DI-31] tab.reading_signature_valid is false for a hash that is not 64 lower-case hex digits, an SPKI that is not base64, or one that is not an Ed25519 SPKI, whatever the signature', async () => {
    const valid = (spki: string, hash: string, sig: string) => su<boolean | null>('select tab.reading_signature_valid($1, $2, $3) as r', [spki, hash, sig]);
    const hash = 'ab'.repeat(32);
    const sig = sign(null, signatureMessage(hash), key1Private()).toString('base64');
    expect(await valid(spki1(), hash, sig)).toBe(true);
    // A genuine signature over a text whose hash is upper case.
    const upper = hash.toUpperCase();
    expect(await valid(spki1(), upper, sign(null, signatureMessage(upper), key1Private()).toString('base64'))).toBe(false);
    expect(await valid('A', hash, sig)).toBe(false);
    expect(await valid(Buffer.concat([X25519_SPKI_HEADER, rawKey1()]).toString('base64'), hash, sig)).toBe(false);
    expect(await valid(Buffer.concat([ED25519_SPKI_HEADER, rawKey1(), Buffer.from([0])]).toString('base64'), hash, sig)).toBe(false);
  });

  it('[DI-28][DI-31] tab.upload_wait_signature_valid is false for a negative wait, a signature text that is not canonical, an SPKI that is not base64 or not an Ed25519 SPKI, even with a genuine signature', async () => {
    const valid = (spki: string, challenge: string, reading: string, delay: string, sig: string) =>
      su<boolean | null>('select tab.upload_wait_signature_valid($1, $2::uuid, $3::uuid, $4::bigint, $5) as r', [spki, challenge, reading, delay, sig]);
    const [challenge, reading] = [randomUUID(), randomUUID()];
    const signed = (delay: string) => sign(null, uploadWaitMessage(challenge, reading, delay), key1Private()).toString('base64');
    expect(await valid(spki1(), challenge, reading, '1000', signed('1000'))).toBe(true);
    expect(await valid(spki1(), challenge, reading, '-5', signed('-5'))).toBe(false);
    expect(await valid(spki1(), challenge, reading, '1000', nonCanonical(signed('1000')))).toBe(false);
    expect(await valid('A', challenge, reading, '1000', signed('1000'))).toBe(false);
    expect(await valid(Buffer.concat([X25519_SPKI_HEADER, rawKey1()]).toString('base64'), challenge, reading, '1000', signed('1000'))).toBe(false);
    expect(await valid(Buffer.concat([ED25519_SPKI_HEADER, rawKey1(), Buffer.from([0])]).toString('base64'), challenge, reading, '1000', signed('1000'))).toBe(false);
  });

  it('[DI-32] tab.raw_weight_interpretation reads no line longer than 128 characters, however well formed (as the SDK)', async () => {
    const interpret = (raw: string) => su<Json | null>('select tab.raw_weight_interpretation($1) as r', [raw]);
    const longest = `S S${' '.repeat(128 - 3 - 8)}1.250 kg`;
    expect(longest).toHaveLength(128);
    expect(await interpret(longest)).toEqual({ value: '1.250', unit: 'kg', stable: true, status: 'OK' });
    expect(interpretWeightLine(longest)).toEqual({ value: '1.250', unit: 'kg', stable: true, status: 'OK' });
    const tooLong = `S S${' '.repeat(130)}1.250 kg`;
    expect(tooLong.length).toBeGreaterThan(128);
    expect(await interpret(tooLong)).toBeNull();
    expect(() => interpretWeightLine(tooLong)).toThrow();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------------------------------------------------

/**
 * A reading of TEST-GW-02's chain written straight into the table by the superuser (triggers off), genuinely signed with
 * that enrolment's key: a row that reached the table without ingestion (a restore, owner-level code). Its proof holds.
 */
async function plant(overrides: Partial<ReadingBody>): Promise<ScaleReading> {
  const r = sealReading(
    {
      ...body({ seq: '0', hash: genesisHash(key2) }),
      chainId: key2,
      gatewayCode: 'TEST-GW-02',
      ...overrides,
    },
    kp2.privateKey,
  );
  const c = await server.db.admin.connect();
  try {
    await c.query('begin');
    await c.query("set local session_replication_role = 'replica'");
    await c.query(
      `insert into tab.device_reading (id, chain_id, seq, gateway_device_id, gateway_code, instrument_device_id, device_code, serial, value, unit,
                                       stable, status, raw, source_time_us, trust, installation, purpose, prev_hash, hash, signature,
                                       uplink_delay_us, recorded_at, recorded_us, ingest_session_id, correlation_id)
       select $1, $2, $3, $4, $5, d.id, d.code, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, 0, clock_timestamp(),
              platform.epoch_micros(clock_timestamp()), gen_random_uuid(), gen_random_uuid()
         from iam.device d where d.code = $19`,
      [r.readingId, r.chainId, r.seq, deviceId('TEST-GW-02'), r.gatewayCode, r.serial, r.value, r.unit, r.stable, r.status, r.raw, r.sourceTimeUs, r.trust,
       r.installation, r.purpose, r.prevHash, r.hash, r.signature, r.deviceCode],
    );
    await c.query('commit');
  } finally {
    c.release();
  }
  expect(await su<Json | null>('select tab.device_reading_problem(r) as r from tab.device_reading r where id = $1', [r.readingId])).toBeNull();
  return r;
}

describe('claims: who may claim, the claim\'s own arguments, and readings that reached the table without ingestion', () => {
  it('[DI-31] only a person\'s entry claims or alerts a reading: the gateway identity is refused as such (EBMR-DEV-100)', async () => {
    const id = await ingested();
    const gateway = await gwActor();
    await expect(
      withActorCommand(server.db.app, gateway, (c) => c.query("select tab.claim_readings(array[$1]::uuid[], 'DISP-1', 120000000, 'GROSS')", [id])),
    ).rejects.toThrow(/^EBMR-DEV-100 DI-31: only a person's entry can use a scale reading$/);
    await expect(withActorCommand(server.db.app, await gwActor(), (c) => c.query("select tab.alert_refused_claim(array[$1]::uuid[], 'BLEND-1')", [id]))).rejects.toThrow(
      /^EBMR-DEV-100 DI-31: only a person's refused use of a scale reading is alerted$/,
    );
    expect(await uses(id)).toBe(0);
    expect((await server.db.admin.query('select 1 from tab.device_alarm where reading_id = $1', [id])).rowCount).toBe(0);
  });

  it('[DI-17][INV-40] a person who can neither execute steps nor dispense (a verifier at the DISP-1 kiosk) neither claims nor alerts', async () => {
    const id = await ingested();
    await expect(claim([id], { persona: 'verifier1' })).rejects.toThrow(/^EBMR-IAM-040 .* lacks permission STEP\.EXECUTE /);
    const verifier = await operatorActor(server, 'verifier1');
    await expect(withActorCommand(server.db.app, verifier, (c) => c.query("select tab.alert_refused_claim(array[$1]::uuid[], 'BLEND-1')", [id]))).rejects.toThrow(
      /^EBMR-IAM-040 .* lacks permission STEP\.EXECUTE /,
    );
    expect(await uses(id)).toBe(0);
    expect((await server.db.admin.query('select 1 from tab.device_alarm where reading_id = $1', [id])).rowCount).toBe(0);
    // Control: the operator (STEP.EXECUTE) claims it.
    await expect(claim([id])).resolves.toMatchObject([{ readingId: id }]);
  });

  it('[DI-32] a claim names at least one reading (EBMR-DEV-101)', async () => {
    await expect(claim([])).rejects.toThrow(/^EBMR-DEV-101 no reading ids to claim$/);
    await expect(claim(null)).rejects.toThrow(/^EBMR-DEV-101 no reading ids to claim$/);
  });

  it('[DI-28] the maximum age a claim asks for is from 1 microsecond to 1 hour, never missing (EBMR-DEV-108); nothing used', async () => {
    const id = await ingested();
    for (const maxAgeUs of [null, '0', '-1', '3600000001']) {
      await expect(claim([id], { maxAgeUs })).rejects.toThrow(/^EBMR-DEV-108 the maximum reading age must be between 1 microsecond and 1 hour$/);
    }
    expect(await uses(id)).toBe(0);
    await expect(claim([id], { maxAgeUs: '3600000000' })).resolves.toMatchObject([{ readingId: id }]);
  });

  it('[DI-32] a claim names its purpose (EBMR-DEV-106); nothing used', async () => {
    const id = await ingested();
    for (const purpose of [null, '', '   ']) {
      await expect(claim([id], { purpose })).rejects.toThrow(/^EBMR-DEV-106 a claim names its purpose$/);
    }
    expect(await uses(id)).toBe(0);
  });

  it('[DI-20][DI-31] a genuinely signed reading of the other installation kind that reached the table without ingestion is never used (EBMR-DEV-043)', async () => {
    const r = await plant({ seq: '1', installation: 'GMP' });
    await expect(claim([r.readingId])).rejects.toThrow(new RegExp(`^EBMR-DEV-043 DI-20: reading ${r.readingId} is from a GMP installation$`));
    expect(await uses(r.readingId)).toBe(0);
  });

  it('[DI-20][DI-32] a genuinely signed reading of a terminal that is no instrument (the DISP-1 kiosk), which reached the table without ingestion, is never used (EBMR-DEV-103)', async () => {
    const r = await plant({ seq: '2', deviceCode: 'TEST-KIOSK-DISP-1' });
    await expect(claim([r.readingId])).rejects.toThrow(/^EBMR-DEV-103 DI-20: TEST-KIOSK-DISP-1 is not an instrument$/);
    expect(await uses(r.readingId)).toBe(0);
  });

  it('[DI-31][DI-20] a reading is used only while its instrument is still bound to its enrolment: an ended binding refuses it although the key is ACTIVE and other bindings are (EBMR-DEV-109)', async () => {
    const id = await ingested({ deviceCode: 'TEST-BAL-03', serial: 'SIM-0003' });
    const binding = (await bindingOf('TEST-BAL-03'))['id'];
    await asAdministrator("select tab.end_instrument_binding($1, 'INSTRUMENT_MOVED', 'taken out of service (test)')", [binding]);
    expect((await keyRow(key1))['status']).toBe('ACTIVE');
    expect((await server.db.admin.query('select 1 from tab.gateway_instrument where ended_at is null')).rowCount).toBeGreaterThan(0);
    await expect(claim([id])).rejects.toThrow(
      new RegExp(`^EBMR-DEV-109 DI-31: reading ${id} came through a gateway key or instrument binding that is no longer active$`),
    );
    expect(await uses(id)).toBe(0);
    await asAdministrator("select tab.bind_instrument($1, 'TEST-BAL-03', 'SIM-0003', 'kg', '0.001')", [key1]);
  });

  it('[DI-20][INV-40] a session\'s refused claims are alerted once per reading: a second reading refused in the same session is alerted too', async () => {
    const [r1, r2] = [await ingested(), await ingested()];
    const session = await openPersonaSession(server.db, server.seed, 'operator1');
    const command = async () => ({ ...session, authEventId: await freshTap(server.db, server.seed, 'operator1'), correlationId: randomUUID() });
    const alert = async (id: string) =>
      withActorCommand(server.db.app, await command(), async (c) => (await c.query<{ n: number }>("select tab.alert_refused_claim(array[$1]::uuid[], 'BLEND-1') as n", [id])).rows[0]?.n);
    expect(await alert(r1)).toBe(1);
    expect(await alert(r2)).toBe(1);
    expect(await alert(r1)).toBe(0);
    const alarms = await server.db.admin.query<{ reading_id: string }>(
      "select reading_id from tab.device_alarm where kind = 'CLAIM_REFUSED' and session_id = $1 order by id",
      [session.sessionId],
    );
    expect(alarms.rows.map((a) => a.reading_id)).toEqual([r1, r2]);
  });

  /**
   * tab.claim_readings (0360) reads the database clock once (v_now) and checks every reading of the claim against it, in
   * the order of the ids: a reading is too old when its proven age, v_now - base with base = recorded_us -
   * uplink_delay_us, is more than the maximum M; a DEVICE_SYNCED reading is also refused when its signed capture time s
   * lies more than M + T before v_now (T the clock tolerance, twice the drift alarm threshold). With a* = v_now - M, a
   * reading Y_b of base b is too old exactly when b < a*, and a DEVICE_SYNCED reading X_b captured at b - T - 1 is
   * refused by its capture time exactly when b <= a*.
   *
   * The claim lists Y_b, X_b for consecutive bases b, youngest first; bases where no Y reading landed are left out.
   * Everything above a* passes. If a* is one of the bases, Y_a* is exactly M old, so it is used, and X_a* is refused by its
   * capture time. Otherwise the first refusal is the age of Y_b for the base b just below a*, and b + 1 is then a base
   * left out. So a claim refused as too old on Y_b while Y_b+1 is in the list never happens: it would mean Y_b refused
   * at exactly M old. v_now cannot be known in advance, so M is set from the clock in the claim's own statement
   * (clock - C) and C is aimed from each refusal at the middle of the bases, each claim in a savepoint rolled back,
   * until a claim's refusal decides: X_b refused by its capture time (a* = b), or Y_b refused as too old while Y_b+1 is
   * in the list (which the rule never gives).
   */
  it('[DI-28] a reading exactly as old as the maximum age is not too old: at that microsecond only the signed capture time refuses (EBMR-DEV-104), and nothing is used', async () => {
    const tolerance = BigInt(await su<string>("select (2 * platform.setting_numeric('time.drift_alarm_threshold_s') * 1000000)::bigint::text as r", []));
    let at = await head();
    const next = (overrides: Partial<ReadingBody> = {}): ScaleReading => {
      const r = sealReading(body(at, overrides), key1Private());
      at = { seq: r.seq, hash: r.hash };
      return r;
    };
    const ingestAll = async (challengeId: string, items: { reading: ScaleReading; delayUs: bigint }[]) =>
      withActorCommand(server.db.app, await gwActor(), async (c) => {
        for (const { reading, delayUs } of items) {
          await c.query(INGEST_READING_SQL, [JSON.stringify(reading), delayUs.toString(), challengeId, signWait(server, challengeId, reading.readingId, delayUs.toString())]);
        }
      });

    // Y readings: DEVICE_UNSYNCED, one challenge, signed waits P - j. The stored wait adds the database's time from the
    // challenge to the insert and recorded_us is the insert's clock, so base = issued - (P - j) + the few microseconds
    // between those two clock readings: consecutive bases, with gaps and repeats.
    const P = 1_000_000n;
    const first = await issueChallenge(server, await gwActor());
    const ys = Array.from({ length: 140 }, (_, j) => ({ reading: next(), delayUs: P - BigInt(j) }));
    await ingestAll(first.challengeId, ys);
    const baseOf = new Map(
      (
        await server.db.admin.query<{ id: string; b: string }>('select id::text as id, (recorded_us - uplink_delay_us)::text as b from tab.device_reading where id = any($1::uuid[])', [
          ys.map((y) => y.reading.readingId),
        ])
      ).rows.map((r) => [r.id, BigInt(r.b)]),
    );
    const offsets = new Map<bigint, number>();
    for (const y of ys) {
      const o = (baseOf.get(y.reading.readingId) ?? 0n) - (first.issuedUs - y.delayUs);
      offsets.set(o, (offsets.get(o) ?? 0) + 1);
    }
    const offset = [...offsets.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? 0n;
    const lo = first.issuedUs - P + offset + 15n;
    const hi = lo + 109n;
    const yAt = new Map<bigint, string>();
    for (const y of ys) {
      const b = baseOf.get(y.reading.readingId) ?? 0n;
      if (b >= lo && b <= hi && !yAt.has(b)) yAt.set(b, y.reading.readingId);
    }
    const bases = [...yAt.keys()].sort((x, y) => (x > y ? -1 : x < y ? 1 : 0));
    expect(bases.length).toBeGreaterThan(30);
    // X readings: DEVICE_SYNCED, for each base b captured at b - T - 1, ingested now with no wait (so their own age is small).
    const second = await issueChallenge(server, await gwActor());
    const xAt = new Map(bases.map((b) => [b, next({ trust: 'DEVICE_SYNCED', sourceTimeUs: (b - tolerance - 1n).toString() })] as const));
    await ingestAll(second.challengeId, [...xAt.values()].map((reading) => ({ reading, delayUs: 0n })));
    const ids: string[] = [];
    const which = new Map<string, { kind: 'Y' | 'X'; b: bigint }>();
    for (const b of bases) {
      const y = yAt.get(b) ?? '';
      const x = xAt.get(b)?.readingId ?? '';
      ids.push(y, x);
      which.set(y, { kind: 'Y', b });
      which.set(x, { kind: 'X', b });
    }

    // d = a* - C, the clock's advance from the argument to v_now (a few hundred microseconds): estimated from each refusal.
    const estimates: bigint[] = [];
    let d = 300n;
    const aim = lo + 55n;
    const outcomes: string[] = [];
    let decided: { kind: 'Y' | 'X'; id: string; message: string } | undefined;
    for (let command = 0; command < 8 && !decided; command++) {
      await withActorCommand(server.db.app, await operatorActor(server), async (c) => {
        // A connection's first claim compiles what it calls: a refused one (no purpose) does that before the aimed ones.
        await c.query('savepoint warm');
        await c.query("select tab.claim_readings($1::uuid[], 'DISP-1', 1000000, '')", [ids]).catch(() => undefined);
        await c.query('rollback to savepoint warm');
        for (let k = 0; k < 8 && !decided; k++) {
          const C = aim - d;
          let message: string | undefined;
          await c.query('savepoint attempt');
          try {
            await c.query("select tab.claim_readings($1::uuid[], 'DISP-1', platform.epoch_micros(clock_timestamp()) - $2::bigint, 'GROSS')", [ids, C.toString()]);
          } catch (e) {
            message = e instanceof Error ? e.message : String(e);
          }
          await c.query('rollback to savepoint attempt');
          if (message === undefined) {
            outcomes.push(`C = lo - ${lo - C}: every reading used (a* below every base)`);
            estimates.push((bases[bases.length - 1] ?? lo) - C - 15n);
          } else {
            const id = /^EBMR-DEV-104 DI-28: reading ([0-9a-f-]{36}) /.exec(message)?.[1] ?? '';
            const r = which.get(id);
            if (r?.kind === 'X' && message.includes('by the gateway\'s synchronised clock')) {
              decided = { kind: 'X', id, message };
            } else if (r?.kind === 'Y' && message.includes('is too old to use')) {
              if (yAt.has(r.b + 1n)) decided = { kind: 'Y', id, message };
              else estimates.push(r.b === bases[0] ? r.b - C + 15n : r.b + 1n - C);
            } else {
              throw new Error(`unexpected refusal: ${message}`);
            }
            outcomes.push(`C = lo - ${lo - C}: ${r.kind}${r.b - lo} refused${decided ? ` (decides: ${r.kind === 'Y' ? `Y${r.b + 1n - lo} is in the list` : 'capture time'})` : ''}`);
          }
          const recent = [...estimates.slice(-5)].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
          d = recent[Math.floor(recent.length / 2)] ?? d;
        }
      });
    }
    const story = outcomes.join('\n');
    expect(decided, story).toBeDefined();
    expect(decided?.kind, `${story}\n${decided?.message ?? ''}`).toBe('X');
    const t = `${tolerance / 1000000n}.${((tolerance % 1000000n) / 1000n).toString().padStart(3, '0')}`;
    expect(decided?.message).toMatch(
      new RegExp(`^EBMR-DEV-104 DI-28: reading ${decided?.id ?? ''} was captured [0-9]+\\.[0-9] s ago by the gateway's synchronised clock, more than [0-9]+\\.[0-9] s plus a clock tolerance of ${t.replace('.', '\\.')} s; take a new reading$`),
    );
    // Every claim was rolled back: nothing used.
    expect((await server.db.admin.query('select 1 from tab.reading_use where reading_id = any($1::uuid[])', [ids])).rowCount).toBe(0);
  }, 600_000);
});

// ---------------------------------------------------------------------------------------------------------------------
// A balance taken out of service; the 0250 alert of a refused claim
// ---------------------------------------------------------------------------------------------------------------------

describe('a balance blocked in the registry, and tab.alert_claim_refusal (0250)', () => {
  /** A reading of TEST-BAL-03 ingested while it was ACTIVE, before it was blocked. */
  let beforeBlock: string;

  it('[DI-20] a reading of a bound instrument that is no longer ACTIVE is refused (EBMR-DEV-047), nothing stored', async () => {
    beforeBlock = await ingested({ deviceCode: 'TEST-BAL-03', serial: 'SIM-0003' });
    await asAdministrator("select iam.set_device_status($1, 'BLOCKED', 'calibration overdue (test)')", [deviceId('TEST-BAL-03')]);
    const r = await nextReading({ deviceCode: 'TEST-BAL-03', serial: 'SIM-0003' });
    await expect(ingest(r)).rejects.toThrow(/^EBMR-DEV-047 DI-20: instrument TEST-BAL-03 is BLOCKED$/);
    expect(await stored(r.readingId)).toBe(0);
  });

  // tab.alert_claim_refusal (0250) is no longer executable by the application role (tablets 0320) and nothing calls it;
  // it is called here as the superuser, as the module tests call the private functions, to pin what it records.
  const alertClaimRefusal = (ids: string[], room: string | null, code: string | null) =>
    su<number>('select tab.alert_claim_refusal($1::uuid[], $2, $3) as r', [ids, room, code]);
  const alertsOf = async (id: string) =>
    (
      await server.db.admin.query<{ kind: string; device_id: string; session_id: string | null; details: Json }>(
        "select kind, device_id::text as device_id, session_id::text as session_id, details from iam.security_alert where details ->> 'reading_id' = $1 order by raised_at",
        [id],
      )
    ).rows;
  const alarmsOf = async (id: string) =>
    (
      await server.db.admin.query<{ kind: string; code: string; gateway_code: string; device_code: string; session_id: string | null; message: string; details: Json }>(
        'select kind, code, gateway_code, device_code, session_id::text as session_id, message, details from tab.device_alarm where reading_id = $1 order by id',
        [id],
      )
    ).rows;

  it('[DI-20] the 0250 alert of a refused claim: a balance of another room than the one named is alerted as a location mismatch, from the registry\'s facts', async () => {
    const id = await ingested();
    expect(await alertClaimRefusal([id], 'BLEND-1', null)).toBe(1);
    expect(await alertsOf(id)).toEqual([
      { kind: 'DEVICE_LOCATION_MISMATCH', device_id: deviceId('TEST-BAL-01'), session_id: null, details: { reading_id: id, registered_room: 'DISP-1', requested_room: 'BLEND-1', status: 'ACTIVE' } },
    ]);
    expect(await alarmsOf(id)).toEqual([
      { kind: 'CLAIM_REFUSED', code: 'EBMR-DEV-103', gateway_code: GW, device_code: 'TEST-BAL-01', session_id: null, message: 'DI-20: reading of TEST-BAL-01 (room DISP-1) refused for room BLEND-1', details: { status: 'ACTIVE' } },
    ]);
  });

  it('[DI-20] the 0250 alert of a refused claim: an ACTIVE balance of the room named is not alerted', async () => {
    const id = await ingested();
    expect(await alertClaimRefusal([id], 'DISP-1', null)).toBe(0);
    expect(await alertsOf(id)).toEqual([]);
    expect(await alarmsOf(id)).toEqual([]);
  });

  it('[DI-20] the 0250 alert of a refused claim: a blocked balance is alerted as a blocked device, also for its own room', async () => {
    expect(await alertClaimRefusal([beforeBlock], 'DISP-1', 'EBMR-DEV-103')).toBe(1);
    expect(await alertsOf(beforeBlock)).toEqual([
      { kind: 'BLOCKED_DEVICE_USE', device_id: deviceId('TEST-BAL-03'), session_id: null, details: { reading_id: beforeBlock, registered_room: 'DISP-1', requested_room: 'DISP-1', status: 'BLOCKED' } },
    ]);
    expect(await alarmsOf(beforeBlock)).toEqual([
      { kind: 'CLAIM_REFUSED', code: 'EBMR-DEV-103', gateway_code: GW, device_code: 'TEST-BAL-03', session_id: null, message: 'DI-20: reading of TEST-BAL-03 (room DISP-1) refused for room DISP-1', details: { status: 'BLOCKED' } },
    ]);
  });
});
