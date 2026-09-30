/**
 * Scale status versus capture readiness (review finding P51; DI-30, PR-20, DI-31, DI-28).
 *
 * The server shows a scale ONLINE only from the heartbeat: tab.scale_status says ONLINE when the last heartbeat (at
 * most 10 s old) reported the instrument ONLINE with its registered serial. C3 then refuses hand-keyed weights
 * (EBMR-EXE-074, "the scale is online"), while the capture route maps the gateway's NOT_READY answer to
 * SCALE_OFFLINE ("manual entry needs a second person"). So whenever the gateway cannot journal and deliver a
 * capture, its heartbeat must not report the instrument ONLINE, or neither path can record the weighing (PR-20: the
 * step falls back to the two-person mode when the device is offline; DI-30: a value keyed while the interface is
 * down is flagged manual and verified).
 *
 * Cases: the server's binding differs from the gateway configuration; the journal diverged from the server; the
 * server refuses the oldest unacknowledged reading (every later reading queues behind it); the journal could not
 * be written (a full disk, review finding P52). A healthy gateway reports ONLINE, and does again once the refused
 * reading is accepted.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { systemClock, type GatewayClock } from '../src/clock.ts';
import { SiteGateway } from '../src/gateway.ts';
import { FakeServer, configFor, gatewayKeys, startSimulator, tempDir, until, type SimProcess } from './support.ts';

let sim: SimProcess;
const keys = gatewayKeys();
const driverTiming = { commandTimeoutMs: 1000, backoffInitialMs: 100, backoffMaxMs: 400 };

beforeAll(async () => {
  sim = await startSimulator();
}, 60_000);

afterAll(async () => {
  await sim?.stop();
});

beforeEach(async () => {
  await sim.control('reset');
  await sim.control('place', { mass: '1.250' });
});

/** What tab.scale_status would show for this heartbeat entry (0250 scale_status; freshness is given here). */
function serverStatus(entry: { state: string; serial: string | null } | undefined, registeredSerial: string): 'ONLINE' | 'OFFLINE' {
  return entry && entry.state === 'ONLINE' && entry.serial === registeredSerial ? 'ONLINE' : 'OFFLINE';
}

/** The entry for TEST-BAL-01 in a heartbeat the gateway sends now. */
async function heartbeatEntry(gateway: SiteGateway, server: FakeServer) {
  const before = server.heartbeats.length;
  await gateway.uplink.heartbeat();
  expect(server.heartbeats.length, 'a heartbeat reached the server').toBe(before + 1);
  return server.heartbeats.at(-1)?.devices.find((d) => d.deviceCode === 'TEST-BAL-01');
}

/** A gateway with manual uplink (the test logs in and sends heartbeats itself), connected to the simulator. */
async function startGateway(server: FakeServer, clock?: GatewayClock): Promise<SiteGateway> {
  const config = configFor({ simPort: sim.tcpPort, uplink: server.url, journalDir: tempDir(), keys, captureTimeoutMs: 2000 });
  const gateway = await SiteGateway.start(config, { driver: driverTiming, manualUplink: true, ...(clock ? { clock } : {}) });
  await until(() => gateway.instruments.get('TEST-BAL-01')?.driver.state === 'ONLINE', 15_000, 'the balance connected');
  return gateway;
}

describe('review P51: a scale is reported ONLINE only while the gateway can capture and deliver', () => {
  it('[DI-30][PR-20][DI-31] while the gateway answers NOT_READY for a scale, its heartbeat does not report that scale ONLINE', async () => {
    const server = new FakeServer(keys.publicKeySpki);
    // The administrator's binding differs from the gateway configuration (resolution 0.01 instead of 0.001).
    server.instruments = [{ deviceCode: 'TEST-BAL-01', serial: 'SIM-0001', unit: 'kg', resolution: '0.01', roomCode: 'DISP-1' }];
    await server.start();
    const config = configFor({ simPort: sim.tcpPort, uplink: server.url, journalDir: tempDir(), keys, captureTimeoutMs: 2000 });
    // Normal uplink loops (login and heartbeat every 500 ms), as in production.
    const gateway = await SiteGateway.start(config, { driver: driverTiming });
    try {
      await until(() => gateway.uplink.login !== null && gateway.instruments.get('TEST-BAL-01')?.driver.state === 'ONLINE', 15_000, 'login and connection');
      await new Promise((r) => setTimeout(r, 400));

      // The gateway refuses every capture of this scale (the server would answer SCALE_OFFLINE: "manual entry needs a second person").
      const r = await gateway.capture('TEST-BAL-01', 'GROSS');
      expect(r).toMatchObject({ outcome: 'FAILED', error: 'NOT_READY' });
      expect(gateway.alarms.some((a) => a.kind === 'ENROLMENT_MISMATCH' && a.deviceCode === 'TEST-BAL-01')).toBe(true);

      // A heartbeat sent after that refusal.
      const before = server.heartbeats.length;
      await until(() => server.heartbeats.length >= before + 2, 5000, 'a heartbeat after the refused capture');
      const entry = server.heartbeats.at(-1)?.devices.find((d) => d.deviceCode === 'TEST-BAL-01');

      // The gateway still refuses captures at this point.
      expect(await gateway.capture('TEST-BAL-01', 'GROSS')).toMatchObject({ outcome: 'FAILED', error: 'NOT_READY' });

      // Safe behaviour: the server must not be told the scale is ONLINE (which makes C3 refuse the manual two-person
      // path with EBMR-EXE-074) while every capture is refused.
      expect(serverStatus(entry, 'SIM-0001'), `heartbeat entry ${JSON.stringify(entry)} makes tab.scale_status report ONLINE while capture answers NOT_READY`).not.toBe('ONLINE');
    } finally {
      await gateway.stop();
      await server.stop();
    }
  });

  it('[DI-30][PR-20][DI-31] a journal that diverged from the server reports its scale OFFLINE, not ONLINE', async () => {
    const server = new FakeServer(keys.publicKeySpki);
    await server.start();
    const gateway = await startGateway(server);
    try {
      // A healthy gateway reports its connected scale ONLINE (the check below is not vacuous).
      await gateway.uplink.logIn();
      expect(serverStatus(await heartbeatEntry(gateway, server), 'SIM-0001')).toBe('ONLINE');
      // The server holds a reading this journal never wrote (e.g. the journal disk was replaced): the next login diverges.
      const r = await gateway.capture('TEST-BAL-01', 'GROSS');
      expect(r.outcome).toBe('CAPTURED');
      server.readings.push({ ...server.readings[0]!, readingId: randomUUID(), seq: '2', hash: 'f'.repeat(64) });
      await gateway.uplink.logIn();
      expect(gateway.journal.usable).toBe(false);
      expect(await gateway.capture('TEST-BAL-01', 'GROSS')).toMatchObject({ outcome: 'FAILED', error: 'NOT_READY' });
      expect(serverStatus(await heartbeatEntry(gateway, server), 'SIM-0001')).toBe('OFFLINE');
    } finally {
      await gateway.stop();
      await server.stop();
    }
  });

  it('[DI-30][PR-20][DI-28] while the server refuses the oldest unacknowledged reading, captures answer NOT_READY and the scale is OFFLINE; it is ONLINE again once the reading is accepted', async () => {
    const server = new FakeServer(keys.publicKeySpki);
    await server.start();
    let skewUs = 0n;
    const clock: GatewayClock = { wallUs: () => systemClock.wallUs(), monoUs: () => systemClock.monoUs() + skewUs };
    const gateway = await startGateway(server, clock);
    try {
      await gateway.uplink.logIn();
      expect(serverStatus(await heartbeatEntry(gateway, server), 'SIM-0001')).toBe('ONLINE');

      // The server refuses the next reading (its binding changed while it waited, EBMR-DEV-048).
      server.refuse = () => 'EBMR-DEV-048';
      const first = await gateway.capture('TEST-BAL-01', 'GROSS');
      expect(first).toMatchObject({ outcome: 'CAPTURED', uplinked: false });
      expect(gateway.alarms.some((a) => a.kind === 'READING_REFUSED')).toBe(true);

      // Every later reading of every instrument would queue behind it: nothing more is captured, the scale is OFFLINE.
      const lastSeq = gateway.journal.lastSeq();
      const blocked = await gateway.capture('TEST-BAL-01', 'GROSS');
      expect(blocked).toMatchObject({ outcome: 'FAILED', error: 'NOT_READY' });
      if (blocked.outcome === 'FAILED') expect(blocked.message).toContain('EBMR-DEV-048');
      expect(gateway.journal.lastSeq()).toBe(lastSeq);
      expect(serverStatus(await heartbeatEntry(gateway, server), 'SIM-0001')).toBe('OFFLINE');

      // The server accepts it again (the binding was corrected); the refused reading is offered again after 30 s.
      server.refuse = null;
      skewUs += 31_000_000n;
      await gateway.uplink.flush();
      expect(server.readings.map((x) => x.readingId)).toContain(first.reading?.readingId);
      expect(serverStatus(await heartbeatEntry(gateway, server), 'SIM-0001')).toBe('ONLINE');
      expect(await gateway.capture('TEST-BAL-01', 'GROSS')).toMatchObject({ outcome: 'CAPTURED', uplinked: true });
    } finally {
      await gateway.stop();
      await server.stop();
    }
  });

  it('[DI-30][PR-20][DI-28] a journal that could not be written (full disk) answers NOT_READY, keeps no partial line and reports the scale OFFLINE', async () => {
    const server = new FakeServer(keys.publicKeySpki);
    await server.start();
    const gateway = await startGateway(server);
    try {
      await gateway.uplink.logIn();
      expect((await gateway.capture('TEST-BAL-01', 'TARE')).outcome).toBe('CAPTURED');
      const file = join(gateway.config.journalDir, `journal-${gateway.journal.chainId ?? ''}.jsonl`);
      const whole = readFileSync(file, 'latin1');

      // The disk has room for only 64 more bytes of the journal during the next capture.
      const original = execFileSync('prlimit', ['--pid', String(process.pid), '--fsize', '--raw', '--noheadings', '--output=SOFT']).toString().trim();
      execFileSync('prlimit', ['--pid', String(process.pid), `--fsize=${statSync(file).size + 64}:`]);
      let r: Awaited<ReturnType<SiteGateway['capture']>>;
      try {
        r = await gateway.capture('TEST-BAL-01', 'GROSS');
      } finally {
        execFileSync('prlimit', ['--pid', String(process.pid), `--fsize=${original}:`]);
      }
      expect(r).toMatchObject({ outcome: 'FAILED', error: 'NOT_READY', reading: null });
      expect(readFileSync(file, 'latin1')).toBe(whole);
      expect(gateway.alarms.some((a) => a.kind === 'WRITE_FAILED')).toBe(true);

      // Space was freed, but nothing more is recorded until the gateway restarts; the server sees the scale OFFLINE.
      expect(await gateway.capture('TEST-BAL-01', 'GROSS')).toMatchObject({ outcome: 'FAILED', error: 'NOT_READY' });
      expect(serverStatus(await heartbeatEntry(gateway, server), 'SIM-0001')).toBe('OFFLINE');
    } finally {
      await gateway.stop();
      await server.stop();
    }
  });
});
