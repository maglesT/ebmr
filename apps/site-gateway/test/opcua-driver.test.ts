/**
 * The OPC UA client driver's rules behind its transport port (slice 6b, builder A; DI-20, DI-31, DI-32): a fake
 * transport plays the endpoint, so each rule is exercised exactly (the real node-opcua transport against the simulator
 * is opcua-simulator.test.ts).
 */
import { mkdtempSync } from 'node:fs';
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
