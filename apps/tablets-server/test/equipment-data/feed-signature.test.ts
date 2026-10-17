/**
 * The gateway's signed OPC UA feed and the adapters' mutual TLS (Phase 7 slice 7a, 6jc-R9; DI-31, DI-20; tablets 1405,
 * kernel 1305; interfaces slice-7-0-interfaces.md sections 2 and 3).
 *
 * The OPCUA adapter worker pulls a gateway-like feed (a small HTTP and HTTPS server in the test serving envelopes the
 * test signs with the SDK, as the gateway does) and hands each envelope to tab.accept_gateway_envelope. The adapter is
 * bound to the seeded gateway TEST-GW-01, whose enrolled key signs the good envelopes; a second gateway with its own
 * enrolled key is made at run time. Refusals are proven through the worker (the alarm it records, nothing else
 * written) and against the database directly as the adapter's identity (the bypass a holder of its credentials has).
 * Certificates are made at run time by a test CA (support/test-pki.ts).
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adapterTransportProblem, feedSignatureMessage, isLoopbackHost, seriesChunkHash, type AdapterTls } from '@ebmr/integration-sdk/adapter';
import { identity, withCommand } from '@ebmr/kernel';
import { count, ctxOf, nowUs } from '../../../../packages/kernel/test/integrations/support.ts';
import type { TestDatabase } from '../../../../packages/kernel/test/support/db.ts';
import { OPCUA_ADAPTER } from '../../src/features/integrations/adapters/opcua/index.ts';
import { feedWorker, type AdapterWorker, type CycleReport } from '../../src/features/integrations/adapters/framework.ts';
import { adapterTlsOf, certificateFingerprint } from '../../src/features/integrations/adapters/transport.ts';
import { adminActor, enrol, GW } from '../devices/support.ts';
import { startServer, type TestServer } from '../support/harness.ts';
import { testCa, testCertificate, type TestCa, type TestCertificate } from '../support/test-pki.ts';
import { bindFeed, opcuaWorld, otherGateway, sandboxOpcuaAdapter, seededGatewaySigner, signed, type FeedSigner, type OpcuaWorld } from './opcua-support.ts';

type Json = Record<string, unknown>;

/**
 * A gateway-like OPC UA feed over HTTP and HTTPS (mutual TLS); push() appends an envelope as given. Its head is the
 * highest sequence number the test has given out (nextSeq), so the envelopes a test hands to the database directly
 * take their numbers from the same series.
 */
interface Feed {
  base: string;
  secureBase: string;
  push(env: Json): void;
  close(): Promise<void>;
}

async function startFeed(tls: { server: TestCertificate; clientCa: TestCa }): Promise<Feed> {
  const messages: Json[] = [];
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (body: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/opcua/v1/feed') {
      const after = BigInt(url.searchParams.get('after') ?? '0');
      const limit = Number(url.searchParams.get('limit') ?? '500');
      send({ messages: messages.filter((m) => BigInt(String(m['sequenceNo'])) > after).slice(0, limit), head: lastSeq.toString() });
    } else if (url.pathname === '/opcua/v1/heartbeat') {
      send({ head: lastSeq.toString(), atUs: nowUs() });
    } else {
      res.writeHead(404).end();
    }
  };
  const plain: Server = createServer(handler);
  // The system's side of mutual TLS: its certificate from its CA, and only clients with a certificate of the client CA.
  const secure = createHttpsServer({ cert: readFileSync(tls.server.cert), key: readFileSync(tls.server.key), ca: readFileSync(tls.clientCa.cert), requestCert: true, rejectUnauthorized: true }, handler);
  await new Promise<void>((resolve) => plain.listen(0, '127.0.0.1', resolve));
  await new Promise<void>((resolve) => secure.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${(plain.address() as AddressInfo).port.toString()}/opcua/v1`,
    secureBase: `https://localhost:${(secure.address() as AddressInfo).port.toString()}/opcua/v1`,
    push: (env) => void messages.push(env),
    close: async () => {
      await new Promise<void>((resolve) => plain.close(() => resolve()));
      await new Promise<void>((resolve) => secure.close(() => resolve()));
    },
  };
}

let lastSeq = 0n;
/** The next sequence number of the adapter's feed. */
const nextSeq = (): string => (++lastSeq).toString();

let server: TestServer;
let db: TestDatabase;
let w: OpcuaWorld;
let gw: FeedSigner;
let other: FeedSigner;
let feed: Feed;
let worker: AdapterWorker;
let systemCa: TestCa;
let serverCa: TestCa;
let feedServerCert: TestCertificate;
let clientCert: TestCertificate;

beforeAll(async () => {
  server = await startServer('SANDBOX');
  db = server.db as unknown as TestDatabase;
  const chainId = await enrol(server);
  w = await opcuaWorld(server, chainId);
  gw = seededGatewaySigner(server);
  await bindFeed(server, w.adapter.code, GW);
  other = await otherGateway(server);
  // The system's CA signs its server certificate; the eBMR server's CA signs the adapter's client certificate.
  systemCa = testCa('OPCUA-SYSTEM');
  serverCa = testCa('EBMR-SERVER');
  feedServerCert = testCertificate(systemCa, 'localhost', 'serverAuth', { dns: ['localhost'], ip: ['127.0.0.1'] });
  clientCert = testCertificate(serverCa, w.adapter.code, 'clientAuth');
  feed = await startFeed({ server: feedServerCert, clientCa: serverCa });
  worker = feedWorker(db.app, w.adapter.code, OPCUA_ADAPTER, () => Promise.resolve(ctxOf(w.adapter.actor)), { endpoint: feed.base, timeoutMs: 2000 });
}, 300_000);
afterAll(async () => {
  await worker?.stop();
  await feed?.close();
  await server?.close();
});

const hash = (p: Json) => createHash('sha256').update(JSON.stringify(p), 'utf8').digest('hex');
/** An unsigned envelope of the feed with the next sequence number. */
function envelope(messageType: string, payload: Json, over: Json = {}): Json {
  const seq = nextSeq();
  return {
    sourceSystem: 'OPCUA', messageType, sourceRecordId: `GW-${seq}`, sourceTimestamp: nowUs(), sequenceNo: seq,
    idempotencyKey: `${messageType}:${randomBytes(6).toString('hex')}`, schemaVersion: '1', payloadHash: hash(payload), payload, ...over,
  };
}
const session = (): Json => ({
  endpointCode: w.endpoint.code, endpointUrl: w.endpoint.url, securityMode: 'SignAndEncrypt', securityPolicy: 'Basic256Sha256',
  certificateThumbprint: w.endpoint.thumbprint, reportedLocation: w.areaCode, equipmentCodes: [w.unit.code], openedAt: nowUs(),
});
const event = (): Json => ({ equipmentCode: w.unit.code, eventId: `EV-${randomBytes(4).toString('hex')}`, kind: 'STATE_CHANGED', state: 'RUNNING', recipeVersion: null, message: 'press running', occurredAt: nowUs() });

async function settle(wk: AdapterWorker = worker, n = 4): Promise<CycleReport[]> {
  const out: CycleReport[] = [];
  for (let i = 0; i < n; i++) {
    const r = await wk.cycle();
    out.push(r);
    if (r.caughtUp && r.stopped === null) break;
  }
  return out;
}
const outcomes = (rs: CycleReport[]) => rs.flatMap((r) => r.outcomes);
const events = (id: unknown) => count(db, 'select count(*) as n from plant.equipment_state_event where event_id = $1', [id]);
const messages = () => count(db, 'select count(*) as n from platform.inbound_message where adapter_code = $1', [w.adapter.code]);
const alarmsOf = (key: unknown) => count(db, "select count(*) as n from platform.integration_alarm where adapter_code = $1 and kind = 'WRONG_IDENTITY' and details ->> 'idempotencyKey' = $2", [w.adapter.code, key]);
/** The adapter's identity calls `sql` with the envelope as $1, as a holder of its credentials could (the bypass). */
const direct = (sql: string, env: Json) => withCommand(db.app, ctxOf(w.adapter.actor), async (c) => (await c.query<{ r: Json }>(sql, [JSON.stringify(env)])).rows[0]?.r);

/** Pushes `env`, runs the worker, and expects it refused with `code`, alarmed, and nothing of it written. */
async function expectRefusedWithAlarm(env: Json, code: string, eventId?: unknown): Promise<void> {
  const before = await messages();
  feed.push(env);
  const out = outcomes(await settle());
  expect(out.filter((o) => o.idempotencyKey === env['idempotencyKey']).map((o) => [o.result, o.errorClass, o.code])).toEqual([['REFUSED', 'WRONG_IDENTITY', code]]);
  expect(await alarmsOf(env['idempotencyKey'])).toBe(1);
  expect(await messages()).toBe(before);
  if (eventId !== undefined) expect(await events(eventId)).toBe(0);
}

describe('the gateway signs its OPC UA feed and the database verifies it (6jc-R9)', () => {
  it('[DI-31][DI-20] a good envelope signed by the bound gateway\'s key is accepted with its verification; an exact resend is de-duplicated', async () => {
    feed.push(signed(envelope('opcua.endpoint_session', session()), gw));
    const e = event();
    const env = signed(envelope('opcua.equipment_event', e), gw);
    feed.push(env);
    const rs = await settle();
    expect(outcomes(rs).map((o) => o.result)).toEqual(['ACCEPTED', 'ACCEPTED']);
    expect(await events(e['eventId'])).toBe(1);
    const { rows } = await db.admin.query<{ v: string; p: string | null }>('select source_verification as v, transport_peer as p from platform.inbound_message where adapter_code = $1 and idempotency_key = $2', [w.adapter.code, env['idempotencyKey']]);
    expect(rows).toEqual([{ v: `tab.accept_gateway_envelope: gateway ${GW} key ${gw.keyId}`, p: null }]);
    expect(await direct('select tab.accept_gateway_envelope($1::json) as r', env)).toMatchObject({ outcome: 'DUPLICATE' });
    expect(await events(e['eventId'])).toBe(1);
  });

  it('[DI-31] an OPC UA feed envelope without a gateway signature is refused with an alarm and leaves nothing', async () => {
    const e = event();
    await expectRefusedWithAlarm(envelope('opcua.equipment_event', e), 'EBMR-INT-030', e['eventId']);
  });

  it('[DI-31] an envelope signed by another gateway\'s key, or replayed with a new sequence, is refused', async () => {
    // Re-signed by another enrolled gateway, in its own name: not the gateway the adapter is bound to.
    let e = event();
    await expectRefusedWithAlarm(signed(envelope('opcua.equipment_event', e), other), 'EBMR-INT-033', e['eventId']);
    // In the bound gateway's name, naming the other gateway's active key.
    e = event();
    await expectRefusedWithAlarm(signed(envelope('opcua.equipment_event', e), other, { gatewayCode: GW }), 'EBMR-INT-033', e['eventId']);
    // In the bound gateway's name and key id, signed with another key (a forgery).
    e = event();
    await expectRefusedWithAlarm(signed(envelope('opcua.equipment_event', e), other, { gatewayCode: GW, keyId: gw.keyId }), 'EBMR-INT-032', e['eventId']);
    // A key id no gateway has enrolled.
    e = event();
    await expectRefusedWithAlarm(signed(envelope('opcua.equipment_event', e), gw, { keyId: 'e'.repeat(64) }), 'EBMR-INT-031', e['eventId']);
    // A good envelope replayed under a new sequence number (and a new idempotency key): the signature covers both.
    e = event();
    const good = signed(envelope('opcua.equipment_event', e), gw);
    feed.push(good);
    expect(outcomes(await settle()).map((o) => o.result)).toEqual(['ACCEPTED']);
    await expectRefusedWithAlarm({ ...good, sequenceNo: nextSeq() }, 'EBMR-INT-032');
    await expectRefusedWithAlarm({ ...good, sequenceNo: nextSeq(), idempotencyKey: `${String(good['idempotencyKey'])}-again` }, 'EBMR-INT-032');
    expect(await events(e['eventId'])).toBe(1);
  });

  it('[DI-31] the database checks what the worker cannot be trusted with: a payload swapped under a valid signature is refused', async () => {
    const e = event();
    const env = signed(envelope('opcua.equipment_event', e), gw);
    // The adapter's identity sends the signed envelope with another payload (its hash and signature kept).
    await expect(direct('select tab.accept_gateway_envelope($1::json) as r', { ...env, payload: { ...e, state: 'STOPPED' } })).rejects.toThrow(/EBMR-INT-032/);
    // The same payload with its keys in another order is not the text whose hash was signed either.
    const reordered = Object.fromEntries(Object.entries(e).reverse());
    await expect(direct('select tab.accept_gateway_envelope($1::json) as r', { ...env, payload: reordered })).rejects.toThrow(/EBMR-INT-032/);
    // Through the jsonb door the payload's text is not checked: that door is closed to an OPCUA envelope (EBMR-INT-030).
    await expect(direct('select plant.receive_equipment_event($1::jsonb) as r', { ...env, payload: { ...e, state: 'STOPPED' } })).rejects.toThrow(/EBMR-INT-030/);
    expect(await events(e['eventId'])).toBe(0);
    expect(await direct('select tab.accept_gateway_envelope($1::json) as r', env)).toMatchObject({ outcome: 'ACCEPTED' });
    expect(await events(e['eventId'])).toBe(1);
  });

  it('[DI-31] a direct call of plant.receive_series_chunk for the OPCUA source is refused without the gateway\'s verification', async () => {
    const before = await messages();
    const chunkRows = () => count(db, 'select count(*) as n from plant.series s join plant.equipment e on e.id = s.equipment_id where e.code = $1', [w.unit.code]);
    const seriesBefore = await chunkRows();
    const c = { subjectKind: 'EQUIPMENT', subjectCode: w.unit.code, tag: 'force.main_kN', unit: 'kN', chunkNo: '900001', samples: [{ sourceTime: nowUs(), serverTime: null, raw: '12.5', value: '12.5', status: '0x00000000' }] };
    const chunk = { ...c, chunkHash: seriesChunkHash(c as Parameters<typeof seriesChunkHash>[0]) };
    // Even signed correctly: the receiving commands take an OPCUA envelope only after tab.accept_gateway_envelope's check.
    const env = signed(envelope('opcua.series_chunk', chunk), gw);
    await expect(direct('select plant.receive_series_chunk($1::jsonb) as r', env)).rejects.toThrow(/EBMR-INT-030/);
    const e = event();
    await expect(direct('select plant.receive_equipment_event($1::jsonb) as r', signed(envelope('opcua.equipment_event', e), gw))).rejects.toThrow(/EBMR-INT-030/);
    await expect(direct('select plant.receive_equipment_alarm($1::jsonb) as r', signed(envelope('opcua.alarm', {
      subjectKind: 'EQUIPMENT', subjectCode: w.unit.code, occurrenceId: `occ-${randomBytes(3).toString('hex')}`, transition: 'RAISED', alarmCode: 'REJECT_BURST', severity: '700',
      tag: null, value: null, limit: null, limitKind: null, message: 'reject burst', occurredAt: nowUs(),
    }), gw))).rejects.toThrow(/EBMR-INT-030/);
    await expect(direct('select plant.receive_opcua_endpoint_session($1::jsonb) as r', signed(envelope('opcua.endpoint_session', session()), gw))).rejects.toThrow(/EBMR-INT-030/);
    await expect(direct('select platform.accept_inbound_detail($1::jsonb) as r', env)).rejects.toThrow(/EBMR-INT-030/);
    // Nor can the identity mark an envelope verified itself.
    await expect(direct("select platform.record_source_verification(platform.inbound_envelope_key($1::jsonb), 'forged') as r", env)).rejects.toThrow(/permission denied/);
    expect(await messages()).toBe(before);
    expect(await chunkRows()).toBe(seriesBefore);
    expect(await events(e['eventId'])).toBe(0);
    // The same chunk through the verifier lands.
    expect(await direct('select tab.accept_gateway_envelope($1::json) as r', env)).toMatchObject({ outcome: 'ACCEPTED' });
    expect(await chunkRows()).toBe(seriesBefore + 1);
  });

  it('[DI-31] a gateway\'s feed is bound to one adapter, so a signed envelope cannot be replayed through another', async () => {
    const e = event();
    const env = signed(envelope('opcua.equipment_event', e), gw);
    expect(await direct('select tab.accept_gateway_envelope($1::json) as r', env)).toMatchObject({ outcome: 'ACCEPTED' });
    // A second OPCUA adapter (its own sequence space) cannot be bound to the gateway already bound to the first.
    const second = await sandboxOpcuaAdapter(server, w.adm, 'SITE-1');
    await expect(bindFeed(server, second.code, GW)).rejects.toThrow(/EBMR-DEV-179/);
    await expect(db.admin.query(
      "insert into tab.gateway_feed_binding (adapter_id, adapter_code, gateway_code, bound_by_person) select id, code, $2, gen_random_uuid() from iam.integration_adapter where code = $1",
      [second.code, GW])).rejects.toThrow(/gateway_feed_binding_one_adapter/);
    // The envelope accepted through the first adapter, replayed through the second: refused, nothing lands twice.
    await expect(withCommand(db.app, ctxOf(second.actor), (c) => c.query('select tab.accept_gateway_envelope($1::json)', [JSON.stringify(env)]))).rejects.toThrow(/EBMR-INT-031/);
    expect(await count(db, 'select count(*) as n from platform.inbound_message where adapter_code = $1', [second.code])).toBe(0);
    expect(await events(e['eventId'])).toBe(1);
  });

  it('[DI-31][DI-20] the SQL twin of the feed signature gives the SDK\'s bytes for every committed vector, and the database verifies the vectors\' signatures', async () => {
    const fixture = JSON.parse(readFileSync(join(import.meta.dirname, '../../../../packages/integration-sdk/fixtures/feed-signature-v1.json'), 'utf8')) as {
      key: { publicKeySpkiDerHex: string; keyId: string };
      vectors: { name: string; gatewayCode: string; keyId: string; envelope: Json; messageHex: string; signature: string }[];
    };
    expect(fixture.vectors.length).toBe(4);
    const spki = Buffer.from(fixture.key.publicKeySpkiDerHex, 'hex');
    const q = (sql: string, p: unknown[]) => db.admin.query<{ r: unknown }>(sql, p).then((r) => r.rows[0]?.r);
    for (const v of fixture.vectors) {
      const msg = (await q('select encode(tab.feed_signature_message($1::jsonb, $2, $3), \'hex\') as r', [JSON.stringify(v.envelope), v.gatewayCode, v.keyId])) as string;
      expect(msg, v.name).toBe(v.messageHex);
      expect(Buffer.from(feedSignatureMessage(v.envelope as never, v.gatewayCode, v.keyId)).toString('hex'), v.name).toBe(v.messageHex);
      const ok = (await q("select tab.ed25519_verify(substring($1::bytea from 13 for 32), decode($2, 'hex'), decode($3, 'base64')) as r", [spki, v.messageHex, v.signature])) as boolean;
      expect(ok, v.name).toBe(true);
      // Another sequence number is another message: the vector's signature does not verify it.
      const replay = (await q("select tab.ed25519_verify(substring($1::bytea from 13 for 32), tab.feed_signature_message($2::jsonb, $3, $4), decode($5, 'base64')) as r",
        [spki, JSON.stringify({ ...v.envelope, sequenceNo: '7' }), v.gatewayCode, v.keyId, v.signature])) as boolean;
      expect(replay, v.name).toBe(false);
    }
    // A field outside its rule (a line feed would forge a line) gives no message at all.
    const v0 = fixture.vectors[0]!;
    expect(await q('select tab.feed_signature_message($1::jsonb, $2, $3) as r', [JSON.stringify({ ...v0.envelope, idempotencyKey: 'a\nb' }), v0.gatewayCode, v0.keyId])).toBeNull();
    expect(await q('select tab.feed_signature_message($1::jsonb, $2, $3) as r', [JSON.stringify(v0.envelope), 'GW\nX', v0.keyId])).toBeNull();
    expect(await q('select tab.feed_signature_message($1::jsonb, $2, $3) as r', [JSON.stringify({ ...v0.envelope, sequenceNo: '01' }), v0.gatewayCode, v0.keyId])).toBeNull();
  });
});

describe('the adapters use mutual TLS (6jc-R9)', () => {
  const tlsOf = (ca: TestCa, over: Partial<AdapterTls> = {}): AdapterTls => ({ ca: ca.cert, cert: clientCert.cert, key: clientCert.key, ...over });

  it('[DI-31] a GMP installation refuses an adapter base URL off loopback without mutual TLS', () => {
    const tls = tlsOf(systemCa);
    expect(adapterTransportProblem('http://opcua-gw.plant.example:4850/opcua/v1', undefined, 'GMP')).toMatch(/^EBMR-INT-034 /);
    expect(adapterTransportProblem('https://opcua-gw.plant.example:4850/opcua/v1', undefined, 'GMP')).toMatch(/^EBMR-INT-034 /);
    expect(adapterTransportProblem('http://10.1.2.3:4850/opcua/v1', undefined, 'GMP')).toMatch(/^EBMR-INT-034 /);
    expect(adapterTransportProblem('http://opcua-gw.plant.example:4850/opcua/v1', tls, 'GMP')).toMatch(/^EBMR-INT-034 .*not https/);
    expect(adapterTransportProblem('https://opcua-gw.plant.example:4850/opcua/v1', tls, 'GMP')).toBeNull();
    // Loopback without TLS stays allowed (D-P7-10), and a sandbox is not a GMP installation.
    for (const u of ['http://127.0.0.1:4850/opcua/v1', 'http://localhost:4850/opcua/v1', 'http://[::1]:4850/opcua/v1', 'http://127.8.9.10:1/x']) expect(adapterTransportProblem(u, undefined, 'GMP'), u).toBeNull();
    expect(adapterTransportProblem('http://opcua-gw.plant.example:4850/opcua/v1', undefined, 'SANDBOX')).toBeNull();
    expect(isLoopbackHost('127.0.0.1.example')).toBe(false);
    expect(isLoopbackHost('localhost.example')).toBe(false);
    // EBMR_ADAPTER_TLS_DIR holds all three files of an adapter or none.
    expect(adapterTlsOf(null, 'X')).toBeUndefined();
    expect(adapterTlsOf(systemCa.dir, 'NO-SUCH-ADAPTER')).toBeUndefined();
  });

  it('[DI-31] mutual TLS: a peer from another CA or under another name is refused; the pinned CA\'s peer is accepted and its certificate fingerprint is kept with each message of the page', async () => {
    const e = event();
    const env = signed(envelope('opcua.equipment_event', e), gw);
    feed.push(env);
    // (The extra workers share the adapter's session, so none is stopped here: stop() would end that session.)
    // Pinned to the eBMR server's own CA, not the system's: the handshake fails, nothing is taken, the cursor stays.
    const wrongCa = feedWorker(db.app, w.adapter.code, OPCUA_ADAPTER, () => Promise.resolve(ctxOf(w.adapter.actor)), { endpoint: feed.secureBase, timeoutMs: 2000, tls: tlsOf(serverCa) });
    const r1 = await wrongCa.cycle();
    expect(r1).toMatchObject({ received: 0, stoppedBy: { kind: 'TRANSPORT' } });
    // The right CA under another pinned server name.
    const wrongName = feedWorker(db.app, w.adapter.code, OPCUA_ADAPTER, () => Promise.resolve(ctxOf(w.adapter.actor)), { endpoint: feed.secureBase, timeoutMs: 2000, tls: tlsOf(systemCa, { serverName: 'opcua-gw.plant.example' }) });
    expect(await wrongName.cycle()).toMatchObject({ received: 0, stoppedBy: { kind: 'TRANSPORT' } });
    expect(await events(e['eventId'])).toBe(0);
    // The pinned CA and name: received, with the peer certificate's SHA-256.
    const right = feedWorker(db.app, w.adapter.code, OPCUA_ADAPTER, () => Promise.resolve(ctxOf(w.adapter.actor)), { endpoint: feed.secureBase, timeoutMs: 2000, tls: tlsOf(systemCa) });
    const rs = await settle(right);
    expect(outcomes(rs).map((o) => o.result)).toEqual(['ACCEPTED']);
    const pem = readFileSync(feedServerCert.cert, 'utf8');
    const der = Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
    const { rows } = await db.admin.query<{ p: string }>('select transport_peer as p from platform.inbound_message where adapter_code = $1 and idempotency_key = $2', [w.adapter.code, env['idempotencyKey']]);
    expect(rows).toEqual([{ p: certificateFingerprint({ raw: der }) }]);
    expect(await events(e['eventId'])).toBe(1);
  });
});

describe('a revoked gateway key and an unbound adapter (6jc-R9)', () => {
  it('[DI-31][DI-20] after the bound gateway\'s key is revoked its signature no longer counts, and an adapter bound to no gateway takes nothing', async () => {
    const e = event();
    const env = signed(envelope('opcua.equipment_event', e), gw);
    const id = (await db.admin.query<{ id: string }>("select id from tab.gateway_key where gateway_code = $1 and status = 'ACTIVE'", [GW])).rows[0]!.id;
    await identity.withGuardedCommand(db.app, await adminActor(server), (c) => c.query("select tab.revoke_gateway_key($1, 'TEST_SETUP', 'retired at the end of the test')", [id]));
    await expectRefusedWithAlarm(env, 'EBMR-INT-031', e['eventId']);
    // The binding needs an active key, and an adapter with no binding refuses every envelope.
    await expect(bindFeed(server, w.adapter.code, 'NO-SUCH-GATEWAY')).rejects.toThrow(/EBMR-DEV-178/);
    const unbound = await sandboxOpcuaAdapter(server, w.adm, 'SITE-1');
    await expect(bindFeed(server, unbound.code, GW)).rejects.toThrow(/EBMR-DEV-178 .*no active enrolled key/);
    const env2 = signed({ ...envelope('opcua.equipment_event', event()), sequenceNo: '1' }, other);
    await expect(withCommand(db.app, ctxOf(unbound.actor), (c) => c.query('select tab.accept_gateway_envelope($1::json)', [JSON.stringify(env2)]))).rejects.toThrow(/EBMR-INT-031 .* bound to no gateway feed/);
  });
});
