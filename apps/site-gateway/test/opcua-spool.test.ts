/**
 * Phase 7 slice 7b-1 (DI-32, DI-31): what the gateway keeps of a series across a crash, and the dating of samples.
 *  - the spool (the T12 observation, decision 0022): each sample of an open chunk is spooled on receipt and fsynced in
 *    batches at most 1 s apart; at restart the open chunk is completed from the spool, signed like any chunk, and what
 *    cannot be filled is an opcua.series_gap naming unit, tag and interval (the database raises SERIES_GAP);
 *  - 6jc-R13: a value without any OPC UA timestamp is marked BAD with a reason and dated when it was received, never
 *    epoch 0; a sample dated more than the allowed skew before its session is kept out of the series with an alarm.
 * A fake transport plays the endpoint (opcua-driver.test.ts), and a "crash" cuts the sink before the driver stops, so
 * nothing more reaches the files, as when the process dies.
 */
import { verify } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DataValue } from 'node-opcua';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalDecimal,
  feedSignatureMessage,
  InboundEnvelope,
  MISSING_TIMESTAMP_STATUS,
  opcuaNodeId,
  SeriesChunkV1,
  SeriesGapV1,
  type NativeSample,
  type OpcuaEndpoint,
} from '@ebmr/integration-sdk/adapter';
import type { GatewayClock } from '../src/clock.ts';
import { OpcuaDriver, type OpcuaDataChange, type OpcuaDriverAlarm, type OpcuaSink, type OpcuaTransport } from '../src/drivers/opcua.ts';
import { sampleOf } from '../src/drivers/opcua-node.ts';
import { OpcuaFeed, type OpcuaFeedAlarm } from '../src/opcua-feed.ts';
import { TEST_FEED_KEY, until } from './support.ts';

const THUMB = 'a'.repeat(64);
const endpoint: OpcuaEndpoint = { endpointUrl: 'opc.tcp://press-01:4840/ebmr', securityMode: 'SignAndEncrypt', securityPolicy: 'Basic256Sha256', certificateThumbprint: THUMB, equipmentCodes: ['PRESS-01'], areaCode: 'RM-COMP-1' };

class TestClock implements GatewayClock {
  constructor(public wall = 1_000n, public mono = 1_000_000n) {}
  wallUs(): bigint {
    return this.wall;
  }
  monoUs(): bigint {
    return this.mono;
  }
}

class FakeTransport implements OpcuaTransport {
  onChange: ((c: OpcuaDataChange) => void) | null = null;
  connect(): Promise<{ serverCertificateThumbprint: string }> {
    return Promise.resolve({ serverCertificateThumbprint: THUMB });
  }
  subscribe(_n: readonly string[], _ms: number, onChange: (c: OpcuaDataChange) => void): Promise<void> {
    this.onChange = onChange;
    return Promise.resolve();
  }
  subscribeEvents(): Promise<void> {
    return Promise.resolve();
  }
  read(): Promise<NativeSample> {
    return Promise.resolve({ sourceTime: '1', serverTime: null, raw: '0', value: '0', status: '0x80000000' });
  }
  readText(): Promise<string | null> {
    return Promise.resolve(null);
  }
  write(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
  push(tag: string, sourceTime: bigint, raw: string, extra: Partial<OpcuaDataChange> = {}): void {
    this.onChange?.({ nodeId: opcuaNodeId('PRESS-01', tag), sample: { sourceTime: sourceTime.toString(), serverTime: null, raw, value: canonicalDecimal(raw), status: '0x00000000' }, ...extra });
  }
}

/** A sink that a crash cuts: after `cut()`, nothing the driver hands over reaches the feed's files. */
function cuttable(sink: OpcuaSink): { sink: OpcuaSink; cut(): void } {
  let alive = true;
  return {
    sink: {
      session: (x) => alive && sink.session(x),
      chunk: (x) => alive && sink.chunk(x),
      alarm: (x) => alive && sink.alarm(x),
      event: (x) => alive && sink.event(x),
      sample: (x) => alive && sink.sample?.(x),
    },
    cut: () => {
      alive = false;
    },
  };
}

const drivers: OpcuaDriver[] = [];
const feeds: OpcuaFeed[] = [];
afterEach(async () => {
  for (const d of drivers.splice(0)) await d.stop();
  for (const f of feeds.splice(0)) await f.close();
});

function openFeed(dir: string, clock: GatewayClock, alarms: OpcuaFeedAlarm[] = [], opts: { spoolSyncMs?: number } = {}): OpcuaFeed {
  return OpcuaFeed.open({ dir, gatewayCode: 'GW-TEST', signingKey: TEST_FEED_KEY, clock, onAlarm: (a) => alarms.push(a), ...opts });
}

function driverOn(sink: OpcuaSink, feed: OpcuaFeed, clock: GatewayClock, t: FakeTransport, alarms: OpcuaDriverAlarm[] = []): OpcuaDriver {
  const d = new OpcuaDriver({
    code: 'OPC-PRESS-01', endpoint, equipment: { 'PRESS-01': 'PRESS' }, transport: t, clock, sink, nextChunkNo: (u, tag) => feed.nextChunkNo(u, tag),
    backoffInitialMs: 20, backoffMaxMs: 40, chunkMaxSamples: 3, gapAfterMs: 600_000,
  });
  d.on('alarm', (a: OpcuaDriverAlarm) => alarms.push(a));
  d.start();
  return d;
}

const chunkNos = (f: OpcuaFeed) => f.published().filter((m) => m.messageType === 'opcua.series_chunk').map((m) => (m.payload as { chunkNo: string }).chunkNo);

describe('the gateway spool of open chunks (slice 7b-1)', () => {
  it('[DI-32][DI-31] a gateway crash: the open chunk is completed from the spool at restart, signed like every chunk and numbered on; what it cannot fill is a series gap naming unit, tag and interval', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opcua-spool-'));
    const clock = new TestClock();
    const f1 = openFeed(dir, clock, [], { spoolSyncMs: 1000 });
    const crash = cuttable(f1.sink());
    const t = new FakeTransport();
    const d1 = driverOn(crash.sink, f1, clock, t);
    await until(() => d1.state === 'ONLINE', 2000, 'online');
    for (const [i, raw] of ['12.5', '12.43', '12.6', '12.7', '12.8'].entries()) t.push('force.main_kN', BigInt((i + 1) * 1000), raw);
    // Chunk 1 (three samples) closed and was journalled; chunk 2 (4000, 5000) is open, its samples spooled.
    expect(chunkNos(f1)).toEqual(['1']);
    f1.syncSpool();
    const spooled = readFileSync(join(dir, 'opcua-spool.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { chunkNo: string; sample: NativeSample });
    expect(spooled.map((l) => [l.chunkNo, l.sample.sourceTime])).toEqual([['1', '1000'], ['1', '2000'], ['1', '3000'], ['2', '4000'], ['2', '5000']]);
    // The crash: the process dies; a sample after the last batch never reaches the disk, chunk 2 is never closed.
    crash.cut();
    t.push('force.main_kN', 6000n, '12.9');
    await d1.stop();
    const headBefore = f1.head();

    clock.wall = 9_000_000n;
    const alarms: OpcuaFeedAlarm[] = [];
    const f2 = openFeed(dir, clock, alarms);
    feeds.push(f2);
    const added = f2.published().slice(Number(headBefore));
    expect(added.map((m) => m.messageType)).toEqual(['opcua.series_chunk', 'opcua.series_gap']);
    for (const m of added) {
      expect(InboundEnvelope.safeParse(m).success).toBe(true);
      const sig = m.gatewaySignature;
      if (!sig) throw new Error('unsigned');
      expect(verify(null, feedSignatureMessage(m as unknown as InboundEnvelope, 'GW-TEST', TEST_FEED_KEY.keyId), TEST_FEED_KEY.publicKey, Buffer.from(sig.sig, 'base64'))).toBe(true);
    }
    const completed = SeriesChunkV1.parse(added[0]?.payload);
    expect(completed).toMatchObject({ subjectCode: 'PRESS-01', tag: 'force.main_kN', unit: 'kN', chunkNo: '2' });
    expect(completed.samples.map((s) => [s.sourceTime, s.raw])).toEqual([['4000', '12.7'], ['5000', '12.8']]);
    const gap = SeriesGapV1.parse(added[1]?.payload);
    expect(gap).toMatchObject({ subjectKind: 'EQUIPMENT', subjectCode: 'PRESS-01', tag: 'force.main_kN', unit: 'kN', fromUs: '5000', toUs: '9000000', reason: 'GATEWAY_RESTART' });
    expect(alarms).toEqual([expect.objectContaining({ kind: 'SERIES_GAP', details: { unit: 'PRESS-01', tag: 'force.main_kN', fromUs: '5000', toUs: '9000000' } })]);
    // The chunk numbers continue after the completed chunk, and the spool starts afresh.
    expect(f2.nextChunkNo('PRESS-01', 'force.main_kN')).toBe(3n);
    expect(readFileSync(join(dir, 'opcua-spool.jsonl'), 'utf8')).toBe('');
    // A clean stop after it: nothing is completed or reported again.
    feeds.splice(0);
    await f2.close();
    const f3 = openFeed(dir, clock, alarms);
    feeds.push(f3);
    expect(f3.head()).toBe(f2.head());
    expect(alarms).toHaveLength(1);
  });

  it('[DI-32][DI-31] a clean stop closes every open chunk and ends the spool, so a restart reports no gap; a torn last spool line is a sample never written; batches are fsynced within 1 s', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opcua-spool-'));
    const clock = new TestClock();
    const f1 = openFeed(dir, clock, [], { spoolSyncMs: 60_000 });
    const t = new FakeTransport();
    const d1 = driverOn(f1.sink(), f1, clock, t);
    await until(() => d1.state === 'ONLINE', 2000, 'online');
    t.push('force.main_kN', 1000n, '12.5');
    // The batch is written within a second even when asked for longer (at most 1 s, the plan's bound).
    await until(() => readFileSync(join(dir, 'opcua-spool.jsonl'), 'utf8').includes('"sourceTime":"1000"'), 1500, 'the spool batch');
    await d1.stop();
    await f1.close();
    expect(chunkNos(f1)).toEqual(['1']);
    expect(readFileSync(join(dir, 'opcua-spool.jsonl'), 'utf8').trim().split('\n').at(-1)).toBe('{"k":"closed"}');
    const alarms: OpcuaFeedAlarm[] = [];
    const f2 = openFeed(dir, clock, alarms);
    expect(f2.head()).toBe(f1.head());
    expect(alarms).toEqual([]);
    // A crash in the middle of a spool write: the torn line is dropped; the samples before it complete the chunk.
    const crash = cuttable(f2.sink());
    const d2 = driverOn(crash.sink, f2, clock, t);
    await until(() => d2.state === 'ONLINE', 2000, 'online');
    t.push('force.main_kN', 2000n, '12.6');
    f2.syncSpool();
    crash.cut();
    await d2.stop();
    appendFileSync(join(dir, 'opcua-spool.jsonl'), '{"k":"s","subjectKind":"EQUIPMENT","subj');
    clock.wall = 5_000_000n;
    const f3 = openFeed(dir, clock, alarms);
    feeds.push(f3);
    expect(chunkNos(f3)).toEqual(['1', '2']);
    expect(f3.published().at(-1)).toMatchObject({ messageType: 'opcua.series_gap', payload: { fromUs: '2000', toUs: '5000000' } });
  });
});

// Review round 1 of 7b-1b, finding 2: nothing the spool knew of is lost without a gap.
describe('the gateway spool: what a crash leaves (review round 1)', () => {
  const sampleLine = (chunkNo: string, sourceTime: string, raw: string, value: string | null = raw) =>
    `${JSON.stringify({ k: 's', subjectKind: 'EQUIPMENT', subjectCode: 'PRESS-01', tag: 'force.main_kN', unit: 'kN', chunkNo, sample: { sourceTime, serverTime: null, raw, value, status: '0x00000000' } })}\n`;

  it('[DI-32][DI-31] a crash just after a chunk closed (nothing open, the next sample never written) is a series gap from the end of the last journalled chunk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opcua-spool-'));
    const clock = new TestClock();
    const f1 = openFeed(dir, clock, [], { spoolSyncMs: 1000 });
    const crash = cuttable(f1.sink());
    const t = new FakeTransport();
    const d1 = driverOn(crash.sink, f1, clock, t);
    await until(() => d1.state === 'ONLINE', 2000, 'online');
    for (const [i, raw] of ['12.5', '12.43', '12.6'].entries()) t.push('force.main_kN', BigInt((i + 1) * 1000), raw);
    f1.syncSpool();
    // The fourth sample closes chunk 1 (journalled); the process dies before the sample itself is spooled.
    t.push('force.main_kN', 4000n, '12.7');
    expect(chunkNos(f1)).toEqual(['1']);
    crash.cut();
    await d1.stop();
    const head = f1.head();
    clock.wall = 8_000_000n;
    const alarms: OpcuaFeedAlarm[] = [];
    const f2 = openFeed(dir, clock, alarms);
    feeds.push(f2);
    const added = f2.published().slice(Number(head));
    expect(added.map((m) => m.messageType)).toEqual(['opcua.series_gap']);
    expect(SeriesGapV1.parse(added[0]?.payload)).toMatchObject({ subjectCode: 'PRESS-01', tag: 'force.main_kN', fromUs: '3000', toUs: '8000000' });
    expect(alarms.map((a) => a.kind)).toEqual(['SERIES_GAP']);
  });

  it('[DI-32][DI-31] a spooled chunk that is not a valid chunk is reported as a gap up to the next completed chunk, never dropped silently', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opcua-spool-'));
    // Chunk 1: a shown value that is not the raw value (no valid chunk); chunk 2: valid.
    writeFileSync(join(dir, 'opcua-spool.jsonl'), sampleLine('1', '1000', '12.5', '99') + sampleLine('2', '2000', '12.6') + sampleLine('2', '3000', '12.7'));
    const clock = new TestClock(9_000_000n);
    const f = openFeed(dir, clock);
    feeds.push(f);
    expect(f.published().map((m) => m.messageType)).toEqual(['opcua.series_gap', 'opcua.series_chunk', 'opcua.series_gap']);
    const [dropped, chunk, tail] = f.published();
    expect(SeriesGapV1.parse(dropped?.payload)).toMatchObject({ fromUs: '999', toUs: '2000', detail: expect.stringContaining('chunk(s) 1 could not be completed') as unknown });
    expect(SeriesChunkV1.parse(chunk?.payload)).toMatchObject({ chunkNo: '2' });
    expect(SeriesGapV1.parse(tail?.payload)).toMatchObject({ fromUs: '3000', toUs: '9000000' });
  });

  it('[DI-32][DI-31] a recovery message that cannot be signed keeps the spool: it is never truncated or marked closed, and the next start completes the chunk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opcua-spool-'));
    const spool = sampleLine('1', '1000', '12.5') + sampleLine('1', '2000', '12.6');
    writeFileSync(join(dir, 'opcua-spool.jsonl'), spool);
    const clock = new TestClock(9_000_000n);
    const alarms: OpcuaFeedAlarm[] = [];
    const broken = OpcuaFeed.open({ dir, gatewayCode: 'GW-TEST', signingKey: { privateKey: {} as typeof TEST_FEED_KEY.privateKey, keyId: TEST_FEED_KEY.keyId }, clock, onAlarm: (a) => alarms.push(a) });
    expect(broken.head()).toBe(0n);
    expect(alarms.map((a) => a.kind)).toContain('FEED_JOURNAL_FAILED');
    await broken.close();
    expect(readFileSync(join(dir, 'opcua-spool.jsonl'), 'utf8')).toBe(spool);
    const f = openFeed(dir, clock);
    feeds.push(f);
    expect(f.published().map((m) => m.messageType)).toEqual(['opcua.series_chunk', 'opcua.series_gap']);
    expect(SeriesChunkV1.parse(f.published()[0]?.payload).samples.map((x) => x.sourceTime)).toEqual(['1000', '2000']);
  });
});

describe('the dating of OPC UA samples (6jc-R13)', () => {
  const dv = (over: Record<string, unknown>): DataValue =>
    ({ statusCode: { value: 0 }, value: { value: 12.5 }, sourceTimestamp: null, sourcePicoseconds: 0, serverTimestamp: null, serverPicoseconds: 0, ...over }) as unknown as DataValue;

  it('[DI-32] 6jc-R13: a value without any OPC UA timestamp is marked BAD with a reason and dated when the gateway received it, never epoch 0', () => {
    const none = sampleOf(dv({}), 7_000_000n);
    expect(none.sample).toEqual({ sourceTime: '7000000', serverTime: null, raw: '12.5', value: null, status: MISSING_TIMESTAMP_STATUS });
    expect(none.problem).toMatch(/no source or server timestamp \(status 0x00000000\)/);
    // A timestamp at the epoch (or before it) is no timestamp either.
    expect(sampleOf(dv({ sourceTimestamp: new Date(0) }), 7_000_000n).sample).toMatchObject({ sourceTime: '7000000', status: MISSING_TIMESTAMP_STATUS, value: null });
    // The source server's timestamp stands in for a missing source timestamp (OPC UA allows it); both present: the source's.
    expect(sampleOf(dv({ serverTimestamp: new Date(1_790_000_000_000) }), 7_000_000n)).toEqual({
      sample: { sourceTime: '1790000000000000', serverTime: '1790000000000000', raw: '12.5', value: '12.5', status: '0x00000000' }, problem: null,
    });
    expect(sampleOf(dv({ sourceTimestamp: new Date(1_790_000_000_001), serverTimestamp: new Date(1_790_000_000_002) }), 7_000_000n).sample.sourceTime).toBe('1790000000001000');
  });

  it('[DI-32] 6jc-R13: the driver alarms a sample without a timestamp and keeps it BAD; a sample dated more than the offline buffer before its session stays out of the series with an alarm; a value unchanged for hours before it is taken', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opcua-spool-'));
    const clock = new TestClock(1_790_000_000_000_000n);
    const feed = openFeed(dir, clock);
    feeds.push(feed);
    const t = new FakeTransport();
    const alarms: OpcuaDriverAlarm[] = [];
    const d = driverOn(feed.sink(), feed, clock, t, alarms);
    drivers.push(d);
    await until(() => d.state === 'ONLINE', 2000, 'online');
    // Eight days before the session opened: more than the offline buffer (7 days).
    t.push('force.main_kN', clock.wall - 8n * 86_400_000_000n, '12.3');
    expect(alarms.map((a) => a.kind)).toEqual(['BEFORE_SESSION']);
    // A day before it: the current value of a tag unchanged since then (genuine; golden regression of round 2).
    t.push('force.main_kN', clock.wall - 86_400_000_000n, '12.4');
    // A minute before it, and a value without a timestamp (dated at receipt by the transport, BAD).
    t.push('force.main_kN', clock.wall - 60_000_000n, '12.5');
    t.onChange?.({
      nodeId: opcuaNodeId('PRESS-01', 'force.main_kN'), sample: { sourceTime: clock.wall.toString(), serverTime: null, raw: '12.6', value: null, status: MISSING_TIMESTAMP_STATUS },
      problem: 'the value came with no source or server timestamp (status 0x00000000)',
    });
    expect(alarms.map((a) => a.kind)).toEqual(['BEFORE_SESSION', 'MISSING_TIMESTAMP', 'STALE_VALUE']);
    expect(alarms[1]?.message).toMatch(/no source or server timestamp/);
    drivers.splice(0);
    await d.stop();
    const samples = feed.published().filter((m) => m.messageType === 'opcua.series_chunk').flatMap((m) => SeriesChunkV1.parse(m.payload).samples);
    expect(samples.map((s) => [s.sourceTime, s.status])).toEqual([
      [(clock.wall - 86_400_000_000n).toString(), '0x00000000'], [(clock.wall - 60_000_000n).toString(), '0x00000000'], [clock.wall.toString(), MISSING_TIMESTAMP_STATUS],
    ]);
  });
});
