/**
 * A scale is ONLINE only while a capture on it would be journalled AND delivered (review finding P51, second pass;
 * DI-30, PR-20, DI-28, DI-31).
 *
 * The server shows a scale ONLINE from the gateway heartbeat alone, and C3 then refuses hand-keyed weights
 * (EBMR-EXE-074). A capture the gateway journals but cannot deliver is answered READING_NOT_RECEIVED by the server,
 * so a gateway that keeps saying ONLINE while nothing reaches the server blocks both paths. The first pass covered
 * a diverged journal, an enrolment mismatch, a refused chain head and a failed append. These are the cases a skeptic
 * still reproduced, and the states around them:
 *  - the acknowledgement watermark cannot be written for good (no free inodes; appends to the open journal still
 *    work): only the first 50 readings were ever sent again, later ones never, and the scale stayed ONLINE;
 *  - one answer that accepts a reading and refuses the next while the watermark cannot be written: the refusal was
 *    dropped, so the blocked chain was not reported;
 *  - after a restart the refusal was known only in memory: the scale was ONLINE and a capture was journalled behind
 *    the still-refused head before the first upload learned of it;
 *  - uploads fail while heartbeats still arrive (the listener's ingest is broken);
 *  - GET /v1/health said ONLINE while the heartbeat said OFFLINE, with no reason;
 *  - the heartbeat period could be longer than the server's 10 s freshness window, and readiness changes waited for
 *    the next period.
 * Round-1 verification: the heartbeat said OFFLINE but not why, so the server held no record of the reason; it counted
 * only the written watermark (ackedSeq), which stays behind while it cannot be written, so the server's reconciliation
 * by counts (DI-31) was blind then; and readiness heartbeats were not rate-limited (a flapping state sent one per
 * round trip).
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { READING_FORMAT, ed25519PrivateKey, sealReading, type ScaleReading } from '@ebmr/integration-sdk/scale';
import { systemClock, type GatewayClock } from '../src/clock.ts';
import { GatewayConfigFile } from '../src/config.ts';
import { SiteGateway } from '../src/gateway.ts';
import { READINESS_HEARTBEAT_GAP_MS } from '../src/uplink.ts';
import { FakeServer, configFor, gatewayKeys, startSimulator, tempDir, until, type SimProcess } from './support.ts';

let sim: SimProcess;
const keys = gatewayKeys();
const privateKey = ed25519PrivateKey(keys.privateKeyPkcs8);
const driverTiming = { commandTimeoutMs: 1000, backoffInitialMs: 100, backoffMaxMs: 400 };
const servers: FakeServer[] = [];
const gateways: SiteGateway[] = [];

beforeAll(async () => {
  sim = await startSimulator();
}, 60_000);

afterAll(async () => {
  for (const g of gateways.splice(0)) await g.stop().catch(() => undefined);
  for (const s of servers.splice(0)) await s.stop();
  await sim?.stop();
});

beforeEach(async () => {
  for (const g of gateways.splice(0)) await g.stop().catch(() => undefined);
  for (const s of servers.splice(0)) await s.stop();
  await sim.control('reset');
  await sim.control('place', { mass: '1.250' });
});

/** What tab.scale_status would show for this heartbeat entry (0250 scale_status; freshness is given here). */
function serverStatus(entry: { state: string; serial: string | null } | undefined): 'ONLINE' | 'OFFLINE' {
  return entry && entry.state === 'ONLINE' && entry.serial === 'SIM-0001' ? 'ONLINE' : 'OFFLINE';
}

/** The TEST-BAL-01 entry of a heartbeat the gateway sends now. */
async function heartbeatEntry(gateway: SiteGateway, server: FakeServer) {
  const before = server.heartbeats.length;
  await gateway.uplink.heartbeat();
  expect(server.heartbeats.length, 'a heartbeat reached the server').toBe(before + 1);
  return server.heartbeats.at(-1)?.devices.find((d) => d.deviceCode === 'TEST-BAL-01');
}

async function fakeServer(): Promise<FakeServer> {
  const s = new FakeServer(keys.publicKeySpki);
  await s.start();
  servers.push(s);
  return s;
}

/** A gateway with manual uplink (the test logs in, flushes and sends heartbeats), connected to the simulator. */
async function startGateway(server: FakeServer, opts: { journalDir?: string; clock?: GatewayClock; manualUplink?: boolean; heartbeatMs?: number } = {}): Promise<SiteGateway> {
  const config = { ...configFor({ simPort: sim.tcpPort, uplink: server.url, journalDir: opts.journalDir ?? tempDir(), keys, captureTimeoutMs: 2000 }), ...(opts.heartbeatMs ? { heartbeatMs: opts.heartbeatMs } : {}) };
  const gateway = await SiteGateway.start(config, { driver: driverTiming, manualUplink: opts.manualUplink ?? true, ...(opts.clock ? { clock: opts.clock } : {}) });
  gateways.push(gateway);
  await until(() => gateway.instruments.get('TEST-BAL-01')?.driver.state === 'ONLINE', 15_000, 'the balance connected');
  return gateway;
}

/** A sealed reading of TEST-BAL-01 that continues the chain (as a capture journals it). */
function builder(chainId: string, value = '1.250') {
  return (seq: bigint, prevHash: string): ScaleReading =>
    sealReading(
      {
        format: READING_FORMAT,
        readingId: randomUUID(),
        chainId,
        gatewayCode: 'TEST-GW-01',
        deviceCode: 'TEST-BAL-01',
        serial: 'SIM-0001',
        seq: seq.toString(),
        value,
        unit: 'kg',
        stable: true,
        status: 'OK',
        raw: `S S ${value.padStart(10, ' ')} kg`,
        sourceTimeUs: '1790584618000000',
        trust: 'DEVICE_UNSYNCED',
        installation: 'SANDBOX',
        purpose: 'GROSS',
        prevHash,
      },
      privateKey,
    );
}

/** Makes the watermark file unwritable: its temporary file cannot be created (as with no free inodes). */
function blockWatermark(gateway: SiteGateway): () => void {
  const path = join(gateway.config.journalDir, `.ack-${gateway.journal.chainId ?? ''}.json.tmp`);
  mkdirSync(path);
  return () => rmdirSync(path);
}

describe('review P51 (second pass): ONLINE only while a capture would be journalled and delivered', () => {
  it('[DI-28][DI-30][PR-20] a watermark that cannot be written for good: every journalled reading is still delivered, once; the scale is OFFLINE and captures answer NOT_READY until the watermark is written', async () => {
    const server = await fakeServer();
    const gateway = await startGateway(server);
    await gateway.uplink.logIn();
    expect(serverStatus(await heartbeatEntry(gateway, server))).toBe('ONLINE');
    const chain = gateway.journal.chainId ?? '';

    const unblock = blockWatermark(gateway);
    for (let i = 0; i < 51; i += 1) await gateway.journal.appendNext(builder(chain));
    await gateway.uplink.flush();
    // All 51 reached the server (not only the first batch of 50); the watermark on disk is still behind.
    expect(server.readings.map((r) => r.seq)).toEqual(Array.from({ length: 51 }, (_, i) => String(i + 1)));
    expect(gateway.journal.ackedSeq).toBe(0n);
    expect(gateway.alarms.filter((a) => a.kind === 'ACK_WRITE_FAILED')).toHaveLength(1);
    // Nothing is sent again while the watermark stays behind (no endless resend of the same batch).
    const sent = server.itemsReceived;
    await gateway.uplink.flush();
    expect(server.itemsReceived).toBe(sent);

    // The gateway cannot record what the server holds: nothing more is captured, the server sees the scale OFFLINE,
    // and GET /v1/health says the same, with the reason.
    const lastSeq = gateway.journal.lastSeq();
    const refused = await gateway.capture('TEST-BAL-01', 'GROSS');
    expect(refused).toMatchObject({ outcome: 'FAILED', error: 'NOT_READY', reading: null });
    expect(gateway.journal.lastSeq()).toBe(lastSeq);
    expect(serverStatus(await heartbeatEntry(gateway, server))).toBe('OFFLINE');
    const health = gateway.health().devices.find((d) => d.deviceCode === 'TEST-BAL-01');
    expect(health?.state).toBe('OFFLINE');
    expect(health?.notReady).toMatch(/acknowledg/);

    // The disk recovers: the watermark is written without sending anything again; the scale is ONLINE again.
    unblock();
    await gateway.uplink.flush();
    expect(gateway.journal.ackedSeq).toBe(51n);
    expect(server.itemsReceived).toBe(sent);
    expect(serverStatus(await heartbeatEntry(gateway, server))).toBe('ONLINE');
    expect(gateway.health().devices.find((d) => d.deviceCode === 'TEST-BAL-01')).toMatchObject({ state: 'ONLINE', notReady: null });
    expect(await gateway.capture('TEST-BAL-01', 'GROSS')).toMatchObject({ outcome: 'CAPTURED', uplinked: true });
  });

  it('[DI-30][PR-20][DI-31] an answer that accepts a reading and refuses the next is recorded as a refusal even while the watermark cannot be written', async () => {
    const server = await fakeServer();
    const gateway = await startGateway(server);
    await gateway.uplink.logIn();
    const chain = gateway.journal.chainId ?? '';
    blockWatermark(gateway);
    await gateway.journal.appendNext(builder(chain));
    await gateway.journal.appendNext(builder(chain, '2.500'));
    server.refuse = (reading) => (reading.seq === '2' ? 'EBMR-DEV-048' : null);
    await gateway.uplink.flush();
    expect(server.readings.map((r) => r.seq)).toEqual(['1']);
    expect(gateway.alarms.some((a) => a.kind === 'READING_REFUSED')).toBe(true);
    expect(gateway.uplink.refusedHead()).toMatchObject({ code: 'EBMR-DEV-048' });
    const r = await gateway.capture('TEST-BAL-01', 'GROSS');
    expect(r).toMatchObject({ outcome: 'FAILED', error: 'NOT_READY' });
    if (r.outcome === 'FAILED') expect(r.message).toContain('EBMR-DEV-048');
    expect(serverStatus(await heartbeatEntry(gateway, server))).toBe('OFFLINE');
  });

  it('[DI-30][PR-20][DI-28] after a restart, readings the server has not accepted keep the scale OFFLINE and captures NOT_READY until they are delivered: nothing is journalled behind a refused head', async () => {
    const server = await fakeServer();
    const dir = tempDir();
    let skewUs = 0n;
    const clock: GatewayClock = { wallUs: () => systemClock.wallUs(), monoUs: () => systemClock.monoUs() + skewUs };
    const first = await startGateway(server, { journalDir: dir });
    await first.uplink.logIn();
    server.refuse = () => 'EBMR-DEV-048';
    const captured = await first.capture('TEST-BAL-01', 'GROSS');
    expect(captured).toMatchObject({ outcome: 'CAPTURED', uplinked: false });
    await first.stop();
    gateways.splice(gateways.indexOf(first), 1);

    // The gateway restarts (nothing in memory survives) and logs in; no upload has run yet.
    const second = await startGateway(server, { journalDir: dir, clock });
    await second.uplink.logIn();
    const lastSeq = second.journal.lastSeq();
    expect(lastSeq).toBe(1n);
    expect(await second.capture('TEST-BAL-01', 'GROSS')).toMatchObject({ outcome: 'FAILED', error: 'NOT_READY', reading: null });
    expect(second.journal.lastSeq()).toBe(lastSeq);
    expect(serverStatus(await heartbeatEntry(second, server))).toBe('OFFLINE');

    // The first upload learns that the server still refuses it: still OFFLINE, and the answer names the refusal.
    await second.uplink.flush();
    const blocked = await second.capture('TEST-BAL-01', 'GROSS');
    expect(blocked).toMatchObject({ outcome: 'FAILED', error: 'NOT_READY' });
    if (blocked.outcome === 'FAILED') expect(blocked.message).toContain('EBMR-DEV-048');
    expect(serverStatus(await heartbeatEntry(second, server))).toBe('OFFLINE');

    // The server accepts it (the binding was corrected; offered again after 30 s): ONLINE, captures delivered.
    server.refuse = null;
    skewUs += 31_000_000n;
    await second.uplink.flush();
    expect(server.readings.map((r) => r.readingId)).toEqual([captured.reading?.readingId]);
    expect(serverStatus(await heartbeatEntry(second, server))).toBe('ONLINE');
    expect(await second.capture('TEST-BAL-01', 'GROSS')).toMatchObject({ outcome: 'CAPTURED', uplinked: true });
  });

  it('[DI-30][PR-20][DI-28] while uploads fail and heartbeats still arrive, the scale is OFFLINE and captures answer NOT_READY; ONLINE again after an upload succeeds', async () => {
    const server = await fakeServer();
    const gateway = await startGateway(server);
    await gateway.uplink.logIn();
    expect(serverStatus(await heartbeatEntry(gateway, server))).toBe('ONLINE');
    server.uploadsDown = true;
    await gateway.journal.appendNext(builder(gateway.journal.chainId ?? ''));
    await gateway.uplink.flush();
    expect(server.readings).toEqual([]);
    expect(serverStatus(await heartbeatEntry(gateway, server))).toBe('OFFLINE');
    const lastSeq = gateway.journal.lastSeq();
    expect(await gateway.capture('TEST-BAL-01', 'GROSS')).toMatchObject({ outcome: 'FAILED', error: 'NOT_READY' });
    expect(gateway.journal.lastSeq()).toBe(lastSeq);

    server.uploadsDown = false;
    await gateway.uplink.flush();
    expect(server.readings.map((r) => r.seq)).toEqual(['1']);
    expect(serverStatus(await heartbeatEntry(gateway, server))).toBe('ONLINE');
    expect(await gateway.capture('TEST-BAL-01', 'GROSS')).toMatchObject({ outcome: 'CAPTURED', uplinked: true });
  });

  it('[DI-30][PR-20] GET /v1/health reports the state the heartbeat reports, with the reason a connected scale is not ready', async () => {
    const server = await fakeServer();
    server.instruments = [{ deviceCode: 'TEST-BAL-01', serial: 'SIM-0001', unit: 'kg', resolution: '0.01', roomCode: 'DISP-1' }];
    const gateway = await startGateway(server);
    await gateway.uplink.logIn();
    const entry = await heartbeatEntry(gateway, server);
    const health = gateway.health().devices.find((d) => d.deviceCode === 'TEST-BAL-01');
    expect(serverStatus(entry)).toBe('OFFLINE');
    expect(health?.state).toBe(entry?.state);
    expect(health?.notReady).toMatch(/binding differs/);
  });

  it('[DI-30][PR-20] the heartbeat period is at most half of the server\'s 10 s freshness window, and a change of readiness is reported at once', async () => {
    const file = { gatewayCode: 'TEST-GW-01', installation: 'SANDBOX', listen: '127.0.0.1:0', uplink: 'http://127.0.0.1:1', keyFile: 'k', serviceKeysFile: 's', journalDir: 'j', devices: [{ code: 'TEST-BAL-01', driver: 'mt-sics', host: '127.0.0.1', port: 1, expectedSerial: 'SIM-0001', resolution: '0.001', unit: 'kg' }] };
    expect(GatewayConfigFile.safeParse({ ...file, heartbeatMs: 5000 }).success).toBe(true);
    expect(GatewayConfigFile.safeParse({ ...file, heartbeatMs: 5001 }).success).toBe(false);
    expect(GatewayConfigFile.safeParse({ ...file, heartbeatMs: 60_000 }).success).toBe(false);

    // Production loops with the longest period: the server learns of a refused chain head without waiting for it.
    const server = await fakeServer();
    const gateway = await startGateway(server, { manualUplink: false, heartbeatMs: 5000 });
    await until(() => gateway.uplink.login !== null && server.heartbeats.some((h) => serverStatus(h.devices[0]) === 'ONLINE'), 15_000, 'an ONLINE heartbeat');
    const before = server.heartbeats.length;
    server.refuse = () => 'EBMR-DEV-048';
    await gateway.journal.appendNext(builder(gateway.journal.chainId ?? ''));
    void gateway.uplink.flush();
    await until(() => server.heartbeats.slice(before).some((h) => serverStatus(h.devices[0]) === 'OFFLINE'), 1500, 'an OFFLINE heartbeat within 1.5 s of the refusal');
  }, 30_000);

  it('[DI-30][DI-31][PR-20] the heartbeat says why a connected scale is not ready, and what the server acknowledged beside the written watermark (deliveredSeq)', async () => {
    const server = await fakeServer();
    const gateway = await startGateway(server);
    await gateway.uplink.logIn();
    const ready = await heartbeatEntry(gateway, server);
    expect(ready).toMatchObject({ state: 'ONLINE', notReady: null });
    const chain = gateway.journal.chainId ?? '';
    const unblock = blockWatermark(gateway);
    for (let i = 0; i < 3; i += 1) await gateway.journal.appendNext(builder(chain));
    await gateway.uplink.flush();
    expect(server.readings).toHaveLength(3);
    expect(gateway.journal.ackedSeq).toBe(0n);
    const entry = await heartbeatEntry(gateway, server);
    expect(entry?.state).toBe('OFFLINE');
    expect(entry?.notReady).toMatch(/acknowledgement cannot be recorded/);
    // The written watermark is 0, but the server acknowledged 3: the server's reconciliation by counts sees both.
    expect(server.heartbeats.at(-1)?.journal).toEqual({ lastSeq: '3', ackedSeq: '0', deliveredSeq: '3' });
    unblock();
    await gateway.uplink.flush();
    expect(await heartbeatEntry(gateway, server)).toMatchObject({ state: 'ONLINE', notReady: null });
    expect(server.heartbeats.at(-1)?.journal).toEqual({ lastSeq: '3', ackedSeq: '3', deliveredSeq: '3' });
  });

  it('[DI-30][PR-20] readiness heartbeats are coalesced: a state that flaps every 20 ms sends at most one heartbeat per 500 ms, the last reporting the state as it is then', async () => {
    const server = await fakeServer();
    const gateway = await startGateway(server, { manualUplink: false, heartbeatMs: 5000 });
    await until(() => gateway.uplink.login !== null && server.heartbeats.length > 0, 15_000, 'the first heartbeat');
    await new Promise((r) => setTimeout(r, READINESS_HEARTBEAT_GAP_MS));
    const before = server.heartbeats.length;
    const started = performance.now();
    // One second of a flapping readiness (the last upload failed / succeeded), each change reported to the uplink.
    for (let i = 0; performance.now() - started < 1000; i += 1) {
      gateway.uplink.uploadFailure = i % 2 === 0 ? 'the listener answered 500' : null;
      gateway.uplink.readinessChanged();
      await new Promise((r) => setTimeout(r, 20));
    }
    gateway.uplink.uploadFailure = 'the listener answered 500';
    gateway.uplink.readinessChanged();
    await new Promise((r) => setTimeout(r, READINESS_HEARTBEAT_GAP_MS + 300));
    const sent = server.heartbeats.length - before;
    // At most one per 500 ms over about 1.5 s, plus at most one periodic heartbeat (every 5 s); without coalescing
    // every change sent one (about 50).
    expect(sent, `${sent} heartbeats`).toBeGreaterThanOrEqual(2);
    expect(sent, `${sent} heartbeats`).toBeLessThanOrEqual(5);
    expect(server.heartbeats.at(-1)?.devices[0]).toMatchObject({ state: 'OFFLINE', notReady: expect.stringMatching(/last upload to the server failed/) as unknown });
  }, 30_000);
});
