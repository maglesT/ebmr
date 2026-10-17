/**
 * The OPC UA client driver's rules behind its transport port (slice 6b, builder A; DI-20, DI-31, DI-32): a fake
 * transport plays the endpoint, so each rule is exercised exactly (the real node-opcua transport against the simulator
 * is opcua-simulator.test.ts).
 */
import { appendFileSync, closeSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalDecimal,
  ENDPOINT_LOCATION_NODE,
  OpcuaEndpointSessionV1,
  opcuaActiveAlarmsNodeId,
  opcuaNodeId,
  opcuaSetpointNodeId,
  RECIPE_VERSION_TAG,
  SeriesChunkV1,
  type EquipmentAlarmV1,
  type EquipmentEventV1,
  type NativeSample,
  type OpcuaEndpoint,
} from '@ebmr/integration-sdk/adapter';
import type { GatewayClock } from '../src/clock.ts';
import { OpcuaDriver, type OpcuaDataChange, type OpcuaDriverAlarm, type OpcuaTransport } from '../src/drivers/opcua.ts';
import { OpcuaFeed } from '../src/opcua-feed.ts';
import { until } from './support.ts';

const THUMB = 'a'.repeat(64);
const endpoint: OpcuaEndpoint = { endpointUrl: 'opc.tcp://press-01:4840/ebmr', securityMode: 'SignAndEncrypt', securityPolicy: 'Basic256Sha256', certificateThumbprint: THUMB, equipmentCodes: ['PRESS-01'], areaCode: 'RM-COMP-1' };

class TestClock implements GatewayClock {
  wall = 1_790_000_000_000_000n;
  mono = 1_000_000n;
  wallUs(): bigint {
    return this.wall;
  }
  monoUs(): bigint {
    return this.mono;
  }
  advance(ms: number): void {
    this.wall += BigInt(ms) * 1000n;
    this.mono += BigInt(ms) * 1000n;
  }
}

class FakeTransport implements OpcuaTransport {
  thumbprint = THUMB;
  location: string | null = 'RM-COMP-1';
  recipe = 'RCP-1';
  connects = 0;
  closes = 0;
  writes: [string, string][] = [];
  failConnect = false;
  onChange: ((c: OpcuaDataChange) => void) | null = null;
  onAlarm: ((a: EquipmentAlarmV1) => void) | null = null;
  onEvent: ((e: EquipmentEventV1) => void) | null = null;
  lost: ((reason: string) => void) | null = null;
  subscribed: string[] = [];
  readBack = new Map<string, NativeSample>();
  connect(): Promise<{ serverCertificateThumbprint: string }> {
    this.connects += 1;
    if (this.failConnect) return Promise.reject(new Error('connection refused'));
    return Promise.resolve({ serverCertificateThumbprint: this.thumbprint });
  }
  subscribe(nodeIds: readonly string[], _ms: number, onChange: (c: OpcuaDataChange) => void): Promise<void> {
    this.subscribed = [...nodeIds];
    this.onChange = onChange;
    return Promise.resolve();
  }
  subscribeEvents(onAlarm: (a: EquipmentAlarmV1) => void, onEvent: (e: EquipmentEventV1) => void): Promise<void> {
    this.onAlarm = onAlarm;
    this.onEvent = onEvent;
    return Promise.resolve();
  }
  read(nodeId: string): Promise<NativeSample> {
    return Promise.resolve(this.readBack.get(nodeId) ?? { sourceTime: '1', serverTime: null, raw: '0', value: '0', status: '0x80000000' });
  }
  readText(nodeId: string): Promise<string | null> {
    return Promise.resolve(nodeId === ENDPOINT_LOCATION_NODE ? this.location : nodeId.endsWith(RECIPE_VERSION_TAG) ? this.recipe : null);
  }
  write(nodeId: string, raw: string): Promise<void> {
    this.writes.push([nodeId, raw]);
    this.readBack.set(nodeId, { sourceTime: '5', serverTime: null, raw, value: raw, status: '0x00000000' });
    return Promise.resolve();
  }
  onConnectionLost(cb: (reason: string) => void): void {
    this.lost = cb;
  }
  close(): Promise<void> {
    this.closes += 1;
    return Promise.resolve();
  }
  push(tag: string, sourceTime: bigint, raw: string, status = '0x00000000', unit = 'PRESS-01'): void {
    const value = status.charAt(2) >= '8' ? null : canonicalDecimal(raw);
    this.onChange?.({ nodeId: opcuaNodeId(unit, tag), sample: { sourceTime: sourceTime.toString(), serverTime: null, raw, value, status } });
  }
}

interface Rig {
  t: FakeTransport;
  d: OpcuaDriver;
  feed: OpcuaFeed;
  clock: TestClock;
  alarms: OpcuaDriverAlarm[];
}

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.d.stop();
    await r.feed.close();
  }
});

function rig(over: Partial<FakeTransport> = {}, opts: { chunkMaxSamples?: number; gapAfterMs?: number } = {}): Promise<Rig> {
  const t = Object.assign(new FakeTransport(), over);
  const clock = new TestClock();
  const feed = OpcuaFeed.open({ dir: mkdtempSync(join(tmpdir(), 'opcua-feed-')), gatewayCode: 'GW-TEST', clock });
  const d = new OpcuaDriver({
    code: 'OPC-PRESS-01', endpoint, equipment: { 'PRESS-01': 'PRESS' }, transport: t, clock, sink: feed.sink(), nextChunkNo: (u, tag) => feed.nextChunkNo(u, tag),
    backoffInitialMs: 20, backoffMaxMs: 40, chunkMaxSamples: opts.chunkMaxSamples ?? 3, gapAfterMs: opts.gapAfterMs ?? 600_000,
  });
  const alarms: OpcuaDriverAlarm[] = [];
  d.on('alarm', (a: OpcuaDriverAlarm) => alarms.push(a));
  const r = { t, d, feed, clock, alarms };
  rigs.push(r);
  d.start();
  return Promise.resolve(r);
}

const types = (f: OpcuaFeed) => f.published().map((m) => m.messageType);

describe('the OPC UA client driver', () => {
  it('[DI-20] reports each session first, with the certificate presented, the location the server states and the units; then subscribes the released tags', async () => {
    const { t, d, feed } = await rig();
    await until(() => d.state === 'ONLINE', 2000, 'online');
    const [session] = feed.published();
    expect(session?.messageType).toBe('opcua.endpoint_session');
    const s = OpcuaEndpointSessionV1.parse(session?.payload);
    expect(s).toMatchObject({ endpointCode: 'OPC-PRESS-01', securityMode: 'SignAndEncrypt', securityPolicy: 'Basic256Sha256', certificateThumbprint: THUMB, reportedLocation: 'RM-COMP-1', equipmentCodes: ['PRESS-01'] });
    expect(t.subscribed).toContain(opcuaNodeId('PRESS-01', 'force.main_kN'));
    expect(t.subscribed).toContain(opcuaSetpointNodeId('PRESS-01', 'force.main_kN'));
    expect(t.subscribed).toContain(opcuaActiveAlarmsNodeId('PRESS-01'));
    expect(t.subscribed.every((n) => n.startsWith('nsu=urn:ebmr:process:tags:v1;s=PRESS-01/'))).toBe(true);
  });

  it('[DI-20] a changed certificate: nothing is read, the session is reported once with the certificate presented, the state and an alarm say why; retried', async () => {
    const { t, d, feed, alarms } = await rig({ thumbprint: 'b'.repeat(64) });
    await until(() => t.connects >= 3, 2000, 'retries');
    expect(d.state).toBe('CERTIFICATE_MISMATCH');
    expect(alarms.filter((a) => a.kind === 'CERTIFICATE_MISMATCH').length).toBeGreaterThanOrEqual(1);
    expect(t.subscribed).toEqual([]);
    const sessions = feed.published().filter((m) => m.messageType === 'opcua.endpoint_session');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.payload).toMatchObject({ certificateThumbprint: 'b'.repeat(64), reportedLocation: null });
    expect(await d.unit('PRESS-01').read()).toMatchObject({ ok: false, error: 'CERTIFICATE_MISMATCH' });
    // The enrolled certificate again: a new session, online.
    t.thumbprint = THUMB;
    await until(() => d.state === 'ONLINE', 2000, 'online again');
  });

  it('[DI-32] samples become numbered, hashed chunks with source times, raw text and status as received; the process view shows the raw value exactly', async () => {
    const { t, d, feed } = await rig();
    await until(() => d.state === 'ONLINE', 2000, 'online');
    t.push('force.main_kN', 1000n, '12.5');
    t.push('force.main_kN', 2000n, '12.43');
    t.push('force.main_kN', 3000n, '1.25E1');
    t.push('force.main_kN', 4000n, '12.6');
    const chunks = feed.published().filter((m) => m.messageType === 'opcua.series_chunk');
    expect(chunks).toHaveLength(1);
    const c = SeriesChunkV1.parse(chunks[0]?.payload);
    expect(c).toMatchObject({ subjectKind: 'EQUIPMENT', subjectCode: 'PRESS-01', tag: 'force.main_kN', unit: 'kN', chunkNo: '1' });
    expect(c.samples.map((s) => [s.sourceTime, s.raw, s.status])).toEqual([['1000', '12.5', '0x00000000'], ['2000', '12.43', '0x00000000'], ['3000', '1.25E1', '0x00000000']]);
    const r = await d.unit('PRESS-01').read();
    if (!r.ok) throw new Error('not ok');
    expect(r.sample.values.find((v) => v.tag === 'force.main_kN')).toMatchObject({ value: '12.6', quality: 'GOOD' });
    expect(r.native.values['force.main_kN']).toEqual({ raw: '12.6', status: '0x00000000', deviceTime: '4000', endpointCode: 'OPC-PRESS-01' });
    // Stopping closes the open chunk: no sample is held back.
    await d.stop();
    const after = feed.published().filter((m) => m.messageType === 'opcua.series_chunk');
    expect(after.map((m) => (m.payload as { chunkNo: string }).chunkNo)).toEqual(['1', '2']);
  });

  it('[DI-31] a repeated source time (stale), an older one (out of order), a doubtful status and a node not subscribed each alarm; none is taken as a good value', async () => {
    const { t, d, feed, alarms } = await rig();
    await until(() => d.state === 'ONLINE', 2000, 'online');
    t.push('force.main_kN', 1000n, '12.5');
    t.push('force.main_kN', 1000n, '12.5');
    t.push('force.main_kN', 900n, '12.4');
    t.push('turret.speed_rpm', 1100n, '40.0', '0x40900000');
    t.onChange?.({ nodeId: opcuaNodeId('PRESS-99', 'force.main_kN'), sample: { sourceTime: '1200', serverTime: null, raw: '1', value: '1', status: '0x00000000' } });
    expect(alarms.map((a) => a.kind)).toEqual(['STALE_VALUE', 'OUT_OF_ORDER', 'STALE_VALUE', 'WRONG_UNIT']);
    const r = await d.unit('PRESS-01').read();
    if (!r.ok) throw new Error('not ok');
    expect(r.sample.values.find((v) => v.tag === 'turret.speed_rpm')?.quality).toBe('UNCERTAIN');
    await d.stop();
    const samples = feed.published().filter((m) => m.messageType === 'opcua.series_chunk').flatMap((m) => SeriesChunkV1.parse(m.payload).samples);
    // The doubtful sample is kept as received (its status says so); the repeated and the older one are not chunked.
    expect(samples.map((s) => [s.sourceTime, s.status])).toEqual(expect.arrayContaining([['1000', '0x00000000'], ['1100', '0x40900000']]));
    expect(samples).toHaveLength(2);
  });

  it('[DI-31] a feed gap alarms once; a lost session closes the open chunks, alarms and reconnects with a new session; a recipe mismatch is an event and an alarm', async () => {
    const { t, d, feed, alarms, clock } = await rig({}, { gapAfterMs: 1000 });
    await until(() => d.state === 'ONLINE', 2000, 'online');
    t.push('force.main_kN', 1000n, '12.5');
    clock.advance(1500);
    await until(() => alarms.some((a) => a.kind === 'FEED_GAP'), 3000, 'gap alarm');
    clock.advance(1500);
    await new Promise((r) => setTimeout(r, 1200));
    expect(alarms.filter((a) => a.kind === 'FEED_GAP')).toHaveLength(1);
    t.lost?.('socket reset');
    expect(feed.published().filter((m) => m.messageType === 'opcua.series_chunk')).toHaveLength(1);
    expect(alarms.some((a) => a.kind === 'DISCONNECTED')).toBe(true);
    await until(() => d.state === 'ONLINE' && t.connects === 2, 2000, 'reconnected');
    expect(types(feed).filter((x) => x === 'opcua.endpoint_session')).toHaveLength(2);
    d.expectRecipe('PRESS-01', 'RCP-2');
    expect(alarms.some((a) => a.kind === 'RECIPE_MISMATCH')).toBe(true);
    const ev = feed.published().find((m) => m.messageType === 'opcua.equipment_event');
    expect(ev?.payload).toMatchObject({ equipmentCode: 'PRESS-01', kind: 'RECIPE_MISMATCH', recipeVersion: 'RCP-1' });
  });

  it('[DI-31] alarms and events of the units served go to the feed; one naming another unit is refused with an alarm; an exact re-delivery is not published twice', async () => {
    const { t, d, feed, alarms } = await rig();
    await until(() => d.state === 'ONLINE', 2000, 'online');
    const alarm: EquipmentAlarmV1 = {
      subjectKind: 'EQUIPMENT', subjectCode: 'PRESS-01', occurrenceId: 'burst-1', transition: 'RAISED', alarmCode: 'REJECT_BURST', severity: '700', tag: null, value: null, limit: null, limitKind: null,
      message: 'Reject burst', occurredAt: '1790000000000000',
    };
    t.onAlarm?.(alarm);
    t.onAlarm?.(alarm);
    t.onEvent?.({ equipmentCode: 'PRESS-99', eventId: 'e-1', kind: 'STATE_CHANGED', state: 'RUNNING', recipeVersion: null, message: 'x', occurredAt: '1790000000000000' });
    expect(feed.published().filter((m) => m.messageType === 'opcua.alarm')).toHaveLength(1);
    expect(alarms.map((a) => a.kind)).toEqual(['WRONG_UNIT']);
  });

  it('a setpoint is written to its setpoint node and read back from the device, not from the subscription', async () => {
    const { t, d } = await rig();
    await until(() => d.state === 'ONLINE', 2000, 'online');
    expect(await d.unit('PRESS-01').write('force.main_kN', '12.50')).toEqual({ ok: true });
    expect(t.writes).toEqual([[opcuaSetpointNodeId('PRESS-01', 'force.main_kN'), '12.50']]);
    t.push('force.main_kN', 1000n, '12.4');
    const r = await d.unit('PRESS-01').read();
    if (!r.ok) throw new Error('not ok');
    expect(r.sample.setpoints).toEqual([{ tag: 'force.main_kN', value: '12.50', unit: 'kN' }]);
    expect(await d.unit('PRESS-01').write('tablet.count', '1')).toMatchObject({ ok: false, error: 'REFUSED' });
  });

  it('the feed journal survives a restart: same sequence numbers, chunk numbers continue', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opcua-feed-'));
    const clock = new TestClock();
    const f1 = OpcuaFeed.open({ dir, gatewayCode: 'GW-TEST', clock });
    const sink = f1.sink();
    sink.chunk({ subjectKind: 'EQUIPMENT', subjectCode: 'PRESS-01', tag: 'force.main_kN', unit: 'kN', chunkNo: '7', samples: [{ sourceTime: '1', serverTime: null, raw: '1', value: '1', status: '0x00000000' }], chunkHash: 'c'.repeat(64) });
    await f1.close();
    const f2 = OpcuaFeed.open({ dir, gatewayCode: 'GW-TEST', clock });
    expect(f2.head()).toBe(1n);
    expect(f2.nextChunkNo('PRESS-01', 'force.main_kN')).toBe(8n);
    expect(f2.reconciliation(0n, 10n)).toMatchObject({ sourceCount: '1' });
    await f2.close();
  });
});

// Mutation triage T12 (Phase 6 slice 6j; decision 0019): rules of the gateway that only this TypeScript enforces (the
// database never sees what the gateway drops, and cannot tell which endpoint of the gateway sent an alarm).
describe('the OPC UA driver and feed: what only the gateway can check (T12)', () => {
  it('[DI-31] a malformed data change, a setpoint value of a tag without a setpoint and a tag of another kind of unit each alarm MALFORMED and are never chunked', async () => {
    const { t, d, feed, alarms } = await rig();
    await until(() => d.state === 'ONLINE', 2000, 'online');
    t.onChange?.({ nodeId: opcuaNodeId('PRESS-01', 'force.main_kN'), sample: { sourceTime: '1000', serverTime: null, raw: '12.5', value: '12.5', status: 'GOOD' } });
    t.onChange?.({ nodeId: `${opcuaNodeId('PRESS-01', 'tablet.count')}/setpoint`, sample: { sourceTime: '1000', serverTime: null, raw: '5', value: '5', status: '0x00000000' } });
    t.push('pan.speed_rpm', 1000n, '1.0'); // a coater's tag: the press has none
    expect(alarms.map((a) => a.kind)).toEqual(['MALFORMED', 'MALFORMED', 'MALFORMED']);
    await d.stop();
    expect(feed.published().filter((m) => m.messageType === 'opcua.series_chunk')).toHaveLength(0);
  });

  it('[DI-31][DI-20] a malformed alarm or event alarms MALFORMED; an alarm naming a unit this endpoint does not serve, or a room, is refused (WRONG_UNIT) and never published', async () => {
    const { t, d, feed, alarms } = await rig();
    await until(() => d.state === 'ONLINE', 2000, 'online');
    const alarm: EquipmentAlarmV1 = {
      subjectKind: 'EQUIPMENT', subjectCode: 'PRESS-01', occurrenceId: 'occ-1', transition: 'RAISED', alarmCode: 'REJECT_BURST', severity: '700', tag: null, value: null, limit: null, limitKind: null,
      message: 'Reject burst', occurredAt: '1790000000000000',
    };
    // PRESS-02 may be served by another endpoint of the same gateway: the feed is the gateway's, so only the driver can
    // bind an alarm to the endpoint that raised it.
    t.onAlarm?.({ ...alarm, subjectCode: 'PRESS-02', occurrenceId: 'occ-2' });
    t.onAlarm?.({ ...alarm, subjectKind: 'AREA', subjectCode: 'PRESS-01', occurrenceId: 'occ-3' }); // a room, whatever its code
    t.onAlarm?.({ ...alarm, severity: 'high' });
    t.onEvent?.({ equipmentCode: 'PRESS-01', eventId: 'e-1', kind: 'NO_SUCH_KIND', state: null, recipeVersion: null, message: 'x', occurredAt: '1790000000000000' } as unknown as EquipmentEventV1);
    expect(alarms.map((a) => a.kind)).toEqual(['WRONG_UNIT', 'WRONG_UNIT', 'MALFORMED', 'MALFORMED']);
    expect(types(feed).filter((x) => x === 'opcua.alarm' || x === 'opcua.equipment_event')).toEqual([]);
  });

  it('[DI-31][DI-32] the process view: refused while the session is lost (never the last values); a BAD sample shows no value; a doubtful setpoint is not shown; the active alarms of the unit\'s tags are passed on', async () => {
    const { t, d } = await rig();
    await until(() => d.state === 'ONLINE', 2000, 'online');
    t.push('force.main_kN', 1000n, '12.5');
    t.push('turret.speed_rpm', 1000n, '40.0', '0x80000000');
    t.onChange?.({ nodeId: opcuaSetpointNodeId('PRESS-01', 'force.main_kN'), sample: { sourceTime: '1000', serverTime: null, raw: '12.50', value: '12.50', status: '0x40000000' } });
    t.onChange?.({ nodeId: opcuaActiveAlarmsNodeId('PRESS-01'), sample: { sourceTime: '1000', serverTime: null, raw: 'FORCE_MAIN_HIGH|force.main_kN;SPEED_LOW|turret.speed_rpm;bad code|force.main_kN', value: null, status: '0x00000000' } });
    const r = await d.unit('PRESS-01').read();
    if (!r.ok) throw new Error('not ok');
    expect(r.sample.values.map((v) => v.tag)).toEqual(['force.main_kN']);
    expect(r.sample.setpoints).toEqual([]);
    expect(r.sample.alarms).toEqual([{ code: 'FORCE_MAIN_HIGH', tag: 'force.main_kN' }]);
    t.lost?.('socket reset');
    expect(await d.unit('PRESS-01').read()).toMatchObject({ ok: false, error: 'OFFLINE' });
  });

  it('[DI-31] the feed journal at restart: a torn last line (never acknowledged) is dropped; a damaged line before the end refuses to open, never truncating the feed', async () => {
    const clock = new TestClock();
    const make = async (): Promise<string> => {
      const dir = mkdtempSync(join(tmpdir(), 'opcua-feed-'));
      const f = OpcuaFeed.open({ dir, gatewayCode: 'GW-TEST', clock });
      for (const id of ['e-1', 'e-2', 'e-3']) f.sink().event({ equipmentCode: 'PRESS-01', eventId: id, kind: 'FAULT', state: null, recipeVersion: null, message: 'x', occurredAt: '1' });
      await f.close();
      return dir;
    };
    const torn = await make();
    appendFileSync(join(torn, 'opcua-feed.jsonl'), '{"sourceSystem":"OPCUA","messageTy');
    const f1 = OpcuaFeed.open({ dir: torn, gatewayCode: 'GW-TEST', clock });
    expect(f1.head()).toBe(3n);
    await f1.close();
    const damaged = await make();
    const path = join(damaged, 'opcua-feed.jsonl');
    const lines = readFileSync(path, 'utf8').split('\n');
    lines[1] = '{"damaged';
    writeFileSync(path, lines.join('\n'));
    expect(() => OpcuaFeed.open({ dir: damaged, gatewayCode: 'GW-TEST', clock })).toThrow(/damaged at line 2/);
  });

  it('[DI-31] a journal that cannot be written alarms once and stops the feed: nothing more is published, the head stays, the heartbeat answers 503', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opcua-feed-'));
    const alarms: string[] = [];
    const feed = OpcuaFeed.open({ dir, gatewayCode: 'GW-TEST', clock: new TestClock(), onAlarm: (a) => alarms.push(a.kind) });
    const ev = (id: string): EquipmentEventV1 => ({ equipmentCode: 'PRESS-01', eventId: id, kind: 'FAULT', state: null, recipeVersion: null, message: 'x', occurredAt: '1' });
    feed.sink().event(ev('e-1'));
    const port = await feed.serve('127.0.0.1', 0);
    expect((await fetch(`http://127.0.0.1:${port.toString()}/opcua/v1/heartbeat`)).status).toBe(200);
    // The journal's descriptor becomes read-only: the next write fails as a full or failed disk would.
    const priv = feed as unknown as { fd: number };
    closeSync(priv.fd);
    priv.fd = openSync(join(dir, 'opcua-feed.jsonl'), 'r');
    feed.sink().event(ev('e-2'));
    feed.sink().event(ev('e-3'));
    expect(alarms).toEqual(['FEED_JOURNAL_FAILED']);
    expect(feed.head()).toBe(1n);
    expect(feed.healthy).toBe(false);
    expect((await fetch(`http://127.0.0.1:${port.toString()}/opcua/v1/heartbeat`)).status).toBe(503);
    await feed.close();
  });

  it('[DI-31] the feed protocol pages the journal in order, without a gap or a repeat, and refuses malformed requests', async () => {
    const feed = OpcuaFeed.open({ dir: mkdtempSync(join(tmpdir(), 'opcua-feed-')), gatewayCode: 'GW-TEST', clock: new TestClock() });
    for (let i = 1; i <= 5; i++) feed.sink().event({ equipmentCode: 'PRESS-01', eventId: `e-${i.toString()}`, kind: 'FAULT', state: null, recipeVersion: null, message: 'x', occurredAt: i.toString() });
    const port = await feed.serve('127.0.0.1', 0);
    const get = async (q: string): Promise<{ status: number; body: { messages?: { sequenceNo: string }[]; head?: string } }> => {
      const r = await fetch(`http://127.0.0.1:${port.toString()}/opcua/v1/${q}`);
      return { status: r.status, body: (await r.json()) as { messages?: { sequenceNo: string }[]; head?: string } };
    };
    const seqs = async (q: string) => (await get(q)).body.messages?.map((m) => m.sequenceNo);
    expect(await seqs('feed?after=0&limit=2')).toEqual(['1', '2']);
    expect(await seqs('feed?after=2&limit=2')).toEqual(['3', '4']);
    expect(await seqs('feed?after=4&limit=100')).toEqual(['5']);
    expect(await get('feed?after=9&limit=2')).toEqual({ status: 200, body: { messages: [], head: '5' } });
    expect(await seqs('feed')).toEqual(['1', '2', '3', '4', '5']);
    expect((await get('feed?after=-1&limit=2')).status).toBe(400);
    expect((await get('feed?after=0&limit=0')).status).toBe(400);
    expect((await get('reconciliation?from=5&to=5')).status).toBe(400);
    expect((await get('reconciliation?from=1&to=6')).body).toMatchObject({ sourceCount: '5' });
    expect((await fetch(`http://127.0.0.1:${port.toString()}/opcua/v1/feed`, { method: 'POST' })).status).toBe(405);
    await feed.close();
  });

  it('[DI-31] the transitions of an alarm and distinct events with the longest ids the contract allows are each published, never taken for one another', async () => {
    const { t, d, feed } = await rig();
    await until(() => d.state === 'ONLINE', 2000, 'online');
    const occ = 'C'.repeat(128);
    const alarm: EquipmentAlarmV1 = {
      subjectKind: 'EQUIPMENT', subjectCode: 'PRESS-01', occurrenceId: occ, transition: 'RAISED', alarmCode: 'REJECT_BURST', severity: '700', tag: null, value: null, limit: null, limitKind: null,
      message: 'Reject burst', occurredAt: '1790000000000000',
    };
    t.onAlarm?.(alarm);
    t.onAlarm?.({ ...alarm, transition: 'CLEARED', occurredAt: '1790000000000001' });
    const event = (last: string): EquipmentEventV1 => ({ equipmentCode: 'PRESS-01', eventId: `${'E'.repeat(127)}${last}`, kind: 'FAULT', state: null, recipeVersion: null, message: 'x', occurredAt: '1790000000000000' });
    t.onEvent?.(event('1'));
    t.onEvent?.(event('2'));
    const of = (type: string) => feed.published().filter((m) => m.messageType === type);
    expect(of('opcua.alarm').map((m) => (m.payload as { transition: string }).transition)).toEqual(['RAISED', 'CLEARED']);
    expect(of('opcua.equipment_event')).toHaveLength(2);
    expect(new Set([...of('opcua.alarm'), ...of('opcua.equipment_event')].map((m) => m.idempotencyKey)).size).toBe(4);
    expect(of('opcua.alarm').every((m) => m.sourceRecordId.length <= 128)).toBe(true);
  });
});
