/**
 * The server's OPC UA adapter worker over a gateway feed (Phase 6 slice 6b; DI-20, DI-31, DI-32, DI-49; D-P6b-0-1):
 * the worker pulls the 6a feed protocol under <root>/opcua/v1 and hands each envelope to its receiving command. The feed
 * here is a small HTTP server in the test serving envelopes built with the SDK (the server tests never import the
 * gateway's code, .dependency-cruiser.cjs no-app-to-app; the gateway's own feed has its tests in apps/site-gateway).
 * The worker runs as the registered OPCUA INTEGRATION identity of the sandbox world (opcua-support.ts).
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seriesChunkHash, type SeriesChunkV1 } from '@ebmr/integration-sdk/adapter';
import { count, ctxOf, nowUs } from '../../../../packages/kernel/test/integrations/support.ts';
import type { TestDatabase } from '../../../../packages/kernel/test/support/db.ts';
import { OPCUA_ADAPTER } from '../../src/features/integrations/adapters/opcua/index.ts';
import { ADAPTER_SLOTS } from '../../src/features/integrations/adapters/start.ts';
import { AdapterWorker, feedAdapterDefinition, feedWorker, type CycleReport } from '../../src/features/integrations/adapters/framework.ts';
import { enrol, GW } from '../devices/support.ts';
import { startServer, type TestServer } from '../support/harness.ts';
import { bindFeed, opcuaWorld, seededGatewaySigner, signed, type FeedSigner, type OpcuaWorld } from './opcua-support.ts';

type Json = Record<string, unknown>;

/** A gateway-like OPC UA feed: publish() appends an envelope with the next sequence number. */
interface Feed {
  base: string;
  /** `opts.key`: the idempotency key (default a new one); `opts.sent`: the payload actually sent, when it is not the hashed one. */
  publish(messageType: string, payload: Json, opts?: { key?: string; sent?: Json }): void;
  close(): Promise<void>;
}

/** Slice 7a: every envelope is signed as the gateway does (the seeded gateway's key; the adapter is bound to its feed). */
async function startFeed(signer: FeedSigner): Promise<Feed> {
  const messages: Json[] = [];
  const srv: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (body: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/opcua/v1/feed') {
      const after = BigInt(url.searchParams.get('after') ?? '0');
      const limit = Number(url.searchParams.get('limit') ?? '500');
      send({ messages: messages.filter((m) => BigInt(String(m['sequenceNo'])) > after).slice(0, limit), head: messages.length.toString() });
    } else if (url.pathname === '/opcua/v1/heartbeat') {
      send({ head: messages.length.toString(), atUs: nowUs() });
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = (srv.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port.toString()}`,
    publish(messageType, payload, opts = {}) {
      const seq = (messages.length + 1).toString();
      messages.push(signed({
        sourceSystem: 'OPCUA', messageType, sourceRecordId: `GW-${seq}`, sourceTimestamp: nowUs(), sequenceNo: seq,
        idempotencyKey: opts.key ?? `${messageType}:${randomBytes(6).toString('hex')}`, schemaVersion: '1',
        payloadHash: createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex'), payload: opts.sent ?? payload,
      }, signer));
    },
    close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
  };
}

let server: TestServer;
let db: TestDatabase;
let w: OpcuaWorld;
let feed: Feed;
let worker: AdapterWorker;
let clock = BigInt(Date.now()) * 1000n - 1_800_000_000n;

beforeAll(async () => {
  server = await startServer('SANDBOX');
  db = server.db as unknown as TestDatabase;
  const chainId = await enrol(server);
  w = await opcuaWorld(server, chainId);
  await bindFeed(server, w.adapter.code, GW);
  feed = await startFeed(seededGatewaySigner(server));
  worker = feedWorker(db.app, w.adapter.code, OPCUA_ADAPTER, () => Promise.resolve(ctxOf(w.adapter.actor)), { endpoint: `${feed.base}/opcua/v1`, timeoutMs: 1000 });
}, 300_000);
afterAll(async () => {
  await feed?.close();
  await server?.close();
});

const session = (over: Json = {}): Json => ({
  endpointCode: w.endpoint.code, endpointUrl: w.endpoint.url, securityMode: 'SignAndEncrypt', securityPolicy: 'Basic256Sha256',
  certificateThumbprint: w.endpoint.thumbprint, reportedLocation: w.areaCode, equipmentCodes: [w.unit.code], openedAt: nowUs(), ...over,
});

let chunkNo = 0;
/** Samples as [raw, shown] pairs (a plain raw is shown as itself). */
function chunk(raws: (string | [string, string])[]): SeriesChunkV1 {
  chunkNo += 1;
  clock += 10_000_000n;
  const samples = raws.map((r, i) => {
    const [raw, value] = typeof r === 'string' ? [r, r] : r;
    return { sourceTime: (clock + BigInt(i) * 100_000n).toString(), serverTime: null, raw, value, status: '0x00000000' };
  });
  const c = { subjectKind: 'EQUIPMENT' as const, subjectCode: w.unit.code, tag: 'force.main_kN', unit: 'kN', chunkNo: chunkNo.toString(), samples };
  return { ...c, chunkHash: seriesChunkHash(c) };
}

async function settle(n = 4): Promise<CycleReport[]> {
  const out: CycleReport[] = [];
  for (let i = 0; i < n; i++) {
    const r = await worker.cycle();
    out.push(r);
    if (r.caughtUp && r.stopped === null) break;
  }
  return out;
}
const total = (rs: CycleReport[], k: 'accepted' | 'fetched') => rs.reduce((a, r) => a + r[k], 0);
const refusedOf = (rs: CycleReport[], cls: string) => rs.reduce((a, r) => a + ((r.refused as Record<string, number>)[cls] ?? 0), 0);
const seriesRows = () => count(db, 'select count(*) as n from plant.series s join plant.equipment e on e.id = s.equipment_id where e.code = $1', [w.unit.code]);

describe('the OPC UA adapter worker (D-P6b-0-1)', () => {
  it('[DI-31] the OPC UA adapter is a slot of the server, started by the rule of the EMS', () => {
    expect(ADAPTER_SLOTS.find((s) => s.system === 'OPCUA')).toMatchObject({ terminal: 'SRV-OPCUA-ADAPTER-01', roleCode: 'SERVICE_ACCOUNT' });
    expect(Object.keys(OPCUA_ADAPTER.receive).sort()).toEqual(['opcua.alarm', 'opcua.endpoint_session', 'opcua.equipment_event', 'opcua.series_chunk']);
  });

  it('[DI-32][DI-49] a session, native chunks, a reject-burst alarm and an equipment event from the feed land as sent', async () => {
    feed.publish('opcua.endpoint_session', session());
    const c = chunk(['12.5', ['1.251E1', '12.51'], '12.49']);
    feed.publish('opcua.series_chunk', c);
    const occ = `REJ-${randomBytes(3).toString('hex')}`;
    feed.publish('opcua.alarm', {
      subjectKind: 'EQUIPMENT', subjectCode: w.unit.code, occurrenceId: occ, transition: 'RAISED', alarmCode: 'REJECT_BURST', severity: '700',
      tag: null, value: null, limit: null, limitKind: null, message: 'reject burst at the press discharge', occurredAt: nowUs(),
    });
    const ev = `EV-${randomBytes(3).toString('hex')}`;
    feed.publish('opcua.equipment_event', { equipmentCode: w.unit.code, eventId: ev, kind: 'STATE_CHANGED', state: 'RUNNING', recipeVersion: null, message: 'press running', occurredAt: nowUs() });
    const rs = await settle();
    expect(total(rs, 'accepted')).toBe(4);
    expect(rs.at(-1)).toMatchObject({ caughtUp: true, stopped: null });
    const { rows } = await db.app.query<{ raws: string[]; values: (string | null)[] }>(
      `select array(select x ->> 'raw' from jsonb_array_elements(s.samples) x) as raws, array(select x ->> 'value' from jsonb_array_elements(s.samples) x) as values
         from plant.series s join plant.equipment e on e.id = s.equipment_id where e.code = $1 and s.chunk_no = $2`,
      [w.unit.code, c.chunkNo],
    );
    expect(rows).toEqual([{ raws: ['12.5', '1.251E1', '12.49'], values: ['12.5', '12.51', '12.49'] }]);
    expect(await count(db, "select count(*) as n from plant.alarm where source = 'OPCUA' and occurrence_id = $1 and alarm_code = 'REJECT_BURST'", [occ])).toBe(1);
    expect(await count(db, 'select count(*) as n from plant.equipment_state_event where event_id = $1', [ev])).toBe(1);
  });

  it('[DI-20][DI-31] after a relocated endpoint session the data are refused with an alarm and none lands; a valid session restores the feed', async () => {
    const before = await seriesRows();
    feed.publish('opcua.endpoint_session', session({ reportedLocation: 'SOME-OTHER-ROOM' }));
    feed.publish('opcua.series_chunk', chunk(['12.5']));
    const rs = await settle();
    expect(refusedOf(rs, 'WRONG_IDENTITY')).toBe(1);
    expect(await seriesRows()).toBe(before);
    expect(await count(db, "select count(*) as n from platform.integration_alarm where adapter_code = $1 and kind = 'WRONG_IDENTITY'", [w.adapter.code])).toBeGreaterThanOrEqual(2);
    // A chunk whose hash does not state its samples is refused too (the database recomputes it).
    const bad = { ...chunk(['12.6']), chunkHash: 'f'.repeat(64) };
    feed.publish('opcua.endpoint_session', session());
    feed.publish('opcua.series_chunk', bad);
    const good = chunk(['12.7']);
    feed.publish('opcua.series_chunk', good);
    const rs2 = await settle();
    expect(refusedOf(rs2, 'MALFORMED')).toBe(1);
    expect(total(rs2, 'accepted')).toBe(2);
    expect(await seriesRows()).toBe(before + 1);
  });

  // Mutation triage T12 (Phase 6 slice 6j): the payload hash is checked only by the worker (the database stores the
  // payload and its stated hash as given), so this is the one place an altered value is caught.
  it('[DI-31] a message whose payload is not the one its hash states is refused as malformed with an alarm and lands nowhere; a changed message the source then sends under the same key is not taken for the refused one', async () => {
    feed.publish('opcua.endpoint_session', session());
    const ev = `EV-${randomBytes(3).toString('hex')}`;
    const event: Json = { equipmentCode: w.unit.code, eventId: ev, kind: 'STATE_CHANGED', state: 'RUNNING', recipeVersion: null, message: 'press running', occurredAt: nowUs() };
    const key = `opcua.equipment_event:${randomBytes(6).toString('hex')}`;
    const malformed = () => count(db, "select count(*) as n from platform.integration_alarm where adapter_code = $1 and kind = 'MALFORMED'", [w.adapter.code]);
    const events = () => count(db, 'select count(*) as n from plant.equipment_state_event where event_id = $1', [ev]);
    const before = await malformed();
    feed.publish('opcua.equipment_event', event, { key, sent: { ...event, state: 'STOPPED' } });
    const rs = await settle();
    expect(refusedOf(rs, 'MALFORMED')).toBe(1);
    expect(await malformed()).toBe(before + 1);
    expect(await events()).toBe(0);
    // The source sends that record again, changed (its hash states it): it is received, not taken for the refused message.
    feed.publish('opcua.equipment_event', { ...event, state: 'HELD' }, { key });
    const rs2 = await settle();
    expect(total(rs2, 'accepted')).toBe(1);
    expect(await events()).toBe(1);
  });

  // Defect M6-D2 (Phase 6 slice 6j, triage T12; D-P6j-T12-3): the worker remembered a refused message by the hash it
  // stated, so after a refusal for a payload that did not match its hash, the intact message under the same key and
  // hash was taken for the refused one and never reached the database (alarmed only at the first refusal).
  it('[DI-31] M6-D2: after a message refused because its payload is not the one its hash states, the intact message under the same key lands, exactly once; the tampered payload sent again is refused again', async () => {
    feed.publish('opcua.endpoint_session', session());
    const ev = `EV-${randomBytes(3).toString('hex')}`;
    const event: Json = { equipmentCode: w.unit.code, eventId: ev, kind: 'STATE_CHANGED', state: 'RUNNING', recipeVersion: null, message: 'press running', occurredAt: nowUs() };
    const tampered: Json = { ...event, state: 'STOPPED' };
    const key = `opcua.equipment_event:${randomBytes(6).toString('hex')}`;
    const refusals = () => count(db, "select count(*) as n from platform.inbound_exception where adapter_code = $1 and kind = 'REFUSED' and idempotency_key = $2", [w.adapter.code, key]);
    const events = () => count(db, 'select count(*) as n from plant.equipment_state_event where event_id = $1', [ev]);
    feed.publish('opcua.equipment_event', event, { key, sent: tampered });
    expect(refusedOf(await settle(), 'MALFORMED')).toBe(1);
    // The same tampered payload again, under the same key and stated hash: refused again, never landed.
    feed.publish('opcua.equipment_event', event, { key, sent: tampered });
    expect(refusedOf(await settle(), 'MALFORMED')).toBe(1);
    expect(await refusals()).toBe(2);
    expect(await events()).toBe(0);
    // The intact message, same key, the hash it states: it lands.
    feed.publish('opcua.equipment_event', event, { key });
    const rs = await settle();
    expect(total(rs, 'accepted')).toBe(1);
    expect(await events()).toBe(1);
    // Sent again unchanged: de-duplicated by the database, still exactly once.
    feed.publish('opcua.equipment_event', event, { key });
    expect(total(await settle(), 'accepted')).toBe(0);
    expect(await events()).toBe(1);
  });

  it('[DI-31] M6-D2: a page that repeats a refused item unchanged is handled once; the refusal is not recorded twice', async () => {
    const key = `opcua.equipment_event:${randomBytes(6).toString('hex')}`;
    const event: Json = { equipmentCode: w.unit.code, eventId: `EV-${randomBytes(3).toString('hex')}`, kind: 'STATE_CHANGED', state: 'RUNNING', recipeVersion: null, message: 'press running', occurredAt: nowUs() };
    const seq = ((await worker.databaseCursor()) + 1n).toString();
    const item = {
      sourceSystem: 'OPCUA', messageType: 'opcua.equipment_event', sourceRecordId: `GW-${seq}`, sourceTimestamp: nowUs(), sequenceNo: seq, idempotencyKey: key, schemaVersion: '1',
      payloadHash: createHash('sha256').update(JSON.stringify(event), 'utf8').digest('hex'), payload: { ...event, state: 'STOPPED' },
    };
    // A source that never saw the cursor move: every page repeats the same item.
    const repeating = new AdapterWorker(db.app, feedAdapterDefinition(w.adapter.code, OPCUA_ADAPTER), {
      page: () => Promise.resolve({ messages: [item], head: seq }),
      heartbeat: () => Promise.resolve(true),
      reconciliation: () => Promise.reject(new Error('not used')),
    }, () => Promise.resolve(ctxOf(w.adapter.actor)));
    expect((await repeating.cycle()).outcomes.map((o) => o.result)).toEqual(['REFUSED']);
    expect((await repeating.cycle()).outcomes.map((o) => o.result)).toEqual(['DUPLICATE']);
    expect(await count(db, "select count(*) as n from platform.inbound_exception where adapter_code = $1 and kind = 'REFUSED' and idempotency_key = $2", [w.adapter.code, key])).toBe(1);
    await repeating.stop();
  });
});
