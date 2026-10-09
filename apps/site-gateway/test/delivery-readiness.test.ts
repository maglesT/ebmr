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
 * Follow-up (gateway-delivery-readiness-timing): the capture's 5 s wait for the server's acknowledgement also covered
 * writing the watermark after it (two fsyncs), so on a busy disk it could run out and a reading the server had
 * acknowledged within milliseconds could be answered as not uplinked; the restart case below got that answer once in a
 * full parallel run (writing the watermark took up to 3.7 s of the wait under a disk-heavy load, the uploads a few ms). A
 * first fix timed only the server's answer but then waited for the write without a bound, and a reading queued behind
 * another one's upload still waited for that one's watermark write before it was even sent. Now no upload waits for a
 * watermark write, a capture is told as soon as the server's answer (or a login's head) covers its reading, and it
 * answers once the write has settled but never later than its 5 s (decision X28).
 * Round 2 (its verifier): with the writes one at a time beside the uploads, a write that waited behind a hung one was
 * made after a login that came meanwhile, on what the server had said before it: after a re-enrolment the old chain's
 * acknowledgement failed on the new chain (a false ACK_WRITE_FAILED, captures NOT_READY until the next login), a
 * reconciliation switched the journal back to the old chain, and on the same chain the watermark moved past the login's
 * head. Now an answer that arrives once a login has asked for its adoption is dropped on arrival, and a write already
 * waiting is dropped by the journal under its lock; a dropped write is not a failure and does not clear one (decision
 * X33). Test support: FakeServer.uploadTakes, uploadAnswerGate, heartbeatGate and restoreTo; stallWatermark's
 * thenBlocked.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, mkdirSync, openSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { READING_FORMAT, ed25519PrivateKey, genesisHash, sealReading, type ScaleReading } from '@ebmr/integration-sdk/scale';
import { systemClock, type GatewayClock } from '../src/clock.ts';
import { GatewayConfigFile } from '../src/config.ts';
import { CAPTURE_ACK_WAIT_MS, SiteGateway } from '../src/gateway.ts';
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

/**
 * Makes the watermark write hang, as on a disk whose fsync does not return: its temporary file is a named pipe, and
 * opening a pipe for writing waits until a reader opens it. The returned function (it may be called more than once)
 * removes the pipe and lets a write waiting on it go on; that write then fails (a pipe cannot be synced) and the next
 * one succeeds. A write that has not reached the pipe yet (its open still queued for a file-system thread) creates its
 * file as usual. With `thenBlocked`, the pipe is replaced by a directory before the waiting write goes on, so every
 * later write fails too (as blockWatermark; the test removes the directory).
 */
function stallWatermark(gateway: SiteGateway, { thenBlocked = false } = {}): () => void {
  const path = join(gateway.config.journalDir, `.ack-${gateway.journal.chainId ?? ''}.json.tmp`);
  execFileSync('mkfifo', ['-m', '600', path]);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // A reader that does not wait for a writer (the write may not have reached the pipe yet); a waiting write goes on.
    const reader = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    unlinkSync(path);
    if (thenBlocked) mkdirSync(path);
    closeSync(reader);
  };
}

/**
 * The answer of `pending`, a capture whose reading is journalled (its wait has begun), while the watermark write hangs.
 * Only so that an answer that waits for the disk fails the test instead of hanging it, the write is let go after four
 * times the capture's own wait; `waitedForDisk` then says so.
 */
async function answerWhileStalled<T>(pending: Promise<T>, release: () => void): Promise<{ answer: T; waitedForDisk: boolean }> {
  let waitedForDisk = false;
  const failsafe = setTimeout(() => {
    waitedForDisk = true;
    release();
  }, 4 * CAPTURE_ACK_WAIT_MS);
  try {
    return { answer: await pending, waitedForDisk };
  } finally {
    clearTimeout(failsafe);
  }
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

  it('[DI-28][DI-30] a reading the server acknowledged is answered uplinked when the capture\'s wait ends although the watermark write after it hangs: the answer waits for the gateway\'s disk only that long, never longer and never as not uplinked', async () => {
    const server = await fakeServer();
    const gateway = await startGateway(server);
    await gateway.uplink.logIn();
    const acked = gateway.journal.ackedSeq;
    // The disk stalls: the watermark write after the server's acknowledgement does not finish until it is let go.
    const release = stallWatermark(gateway);
    try {
      const capture = gateway.capture('TEST-BAL-01', 'GROSS');
      await until(() => gateway.journal.lastSeq() === 1n, 20_000, 'the capture journalled its reading');
      const { answer, waitedForDisk } = await answerWhileStalled(capture, release);
      expect(waitedForDisk, 'the capture waited for the stalled watermark write').toBe(false);
      expect(answer).toMatchObject({ outcome: 'CAPTURED', uplinked: true });
      // Answered while the watermark is not on disk; the gateway keeps what the server holds in memory.
      expect(gateway.journal.ackedSeq).toBe(acked);
      expect(gateway.uplink.deliveredSeq()).toBe(gateway.journal.lastSeq());
      expect(server.readings.map((r) => r.readingId)).toEqual([answer.reading?.readingId]);
    } finally {
      release();
    }
    // The write that was waiting on the pipe fails and is tried again: the watermark is written without sending
    // anything again, and the scale is ONLINE.
    await gateway.uplink.flush();
    expect(gateway.journal.ackedSeq).toBe(gateway.journal.lastSeq());
    expect(gateway.uplink.watermarkFailure).toBeNull();
    expect(server.itemsReceived).toBe(1);
    expect(serverStatus(await heartbeatEntry(gateway, server))).toBe('ONLINE');
  });

  it('[DI-28][DI-30] a capture whose watermark write settles within its 5 s is answered only after that write, not at the server\'s acknowledgement', async () => {
    const server = await fakeServer();
    const gateway = await startGateway(server);
    await gateway.uplink.logIn();
    const release = stallWatermark(gateway);
    const started = performance.now();
    let answeredAt: number | null = null;
    let failureAtAnswer: string | null = null;
    const capture = gateway.capture('TEST-BAL-01', 'GROSS').then((answer) => {
      answeredAt = performance.now();
      failureAtAnswer = gateway.uplink.watermarkFailure;
      return answer;
    });
    let releasedAt: number;
    try {
      await until(() => gateway.uplink.deliveredSeq() === 1n, 10_000, 'the server acknowledged the reading');
      // The write hangs for about a second after the acknowledgement, and is let go well within the capture's 5 s
      // (counted here from before the capture began, which is earlier than its journalling).
      const hold = Math.min(1000, started + CAPTURE_ACK_WAIT_MS - 1500 - performance.now());
      if (hold > 0) await new Promise((r) => setTimeout(r, hold));
      expect(answeredAt, 'answered while the watermark write still hangs').toBeNull();
    } finally {
      releasedAt = performance.now();
      release();
    }
    const answer = await capture;
    expect(answer).toMatchObject({ outcome: 'CAPTURED', uplinked: true });
    expect(answeredAt).toBeGreaterThanOrEqual(releasedAt);
    // Answered once the write had settled: this one failed on the pipe, which was recorded (and alarmed) before it.
    expect(failureAtAnswer).not.toBeNull();
    expect(gateway.alarms.filter((a) => a.kind === 'ACK_WRITE_FAILED').map((a) => a.details['seq'])).toEqual(['1']);
    // The next pass writes the watermark without sending anything again.
    await gateway.uplink.flush();
    expect(gateway.journal.ackedSeq).toBe(1n);
    expect(gateway.uplink.watermarkFailure).toBeNull();
    expect(server.itemsReceived).toBe(1);
  });

  it('[DI-28][DI-30] a capture whose upload queues behind another reading\'s in the same upload pass is sent and acknowledged while that reading\'s watermark write hangs, and answered uplinked', async () => {
    const server = await fakeServer();
    const gateway = await startGateway(server);
    await gateway.uplink.logIn();
    const release = stallWatermark(gateway);
    // Reading 1 (another balance's capture, say) is being uploaded; the server holds back its challenge until the
    // capture below has journalled reading 2, so reading 2 queues behind reading 1 in the same pass.
    let letChallengeGo = (): void => undefined;
    server.challengeGate = new Promise<void>((r) => (letChallengeGo = r));
    await gateway.journal.appendNext(builder(gateway.journal.chainId ?? ''));
    const pass = gateway.uplink.flush();
    const capture = gateway.capture('TEST-BAL-01', 'GROSS');
    try {
      await until(() => gateway.journal.lastSeq() === 2n, 10_000, 'the capture journalled reading 2');
      server.challengeGate = null;
      letChallengeGo();
      await until(() => gateway.uplink.deliveredSeq() === 2n, 10_000, 'the server acknowledged reading 2 while the watermark write for reading 1 hangs');
      expect(server.readings.map((r) => r.seq)).toEqual(['1', '2']);
      expect(gateway.journal.ackedSeq).toBe(0n);
    } finally {
      letChallengeGo();
      release();
    }
    expect(await capture).toMatchObject({ outcome: 'CAPTURED', uplinked: true });
    await pass;
    await gateway.uplink.flush();
    expect(gateway.journal.ackedSeq).toBe(2n);
    expect(gateway.uplink.watermarkFailure).toBeNull();
    expect(server.itemsReceived).toBe(2);
  });

  it('[DI-28][DI-30] an upload pass started while an earlier pass\'s watermark write hangs sends at once: a reading offered again then is acknowledged without waiting for the disk', async () => {
    const server = await fakeServer();
    let skewUs = 0n;
    const clock: GatewayClock = { wallUs: () => systemClock.wallUs(), monoUs: () => systemClock.monoUs() + skewUs };
    const gateway = await startGateway(server, { clock });
    await gateway.uplink.logIn();
    const chain = gateway.journal.chainId ?? '';
    await gateway.journal.appendNext(builder(chain));
    await gateway.journal.appendNext(builder(chain, '2.500'));
    // The server takes reading 1 and refuses reading 2 for now; the watermark write for reading 1 hangs.
    server.refuse = (reading) => (reading.seq === '2' ? 'EBMR-DEV-048' : null);
    const release = stallWatermark(gateway);
    const first = gateway.uplink.flush();
    let second: Promise<void> | undefined;
    try {
      await until(() => gateway.uplink.refusedHead() !== null, 10_000, 'the server refused reading 2');
      // Reading 2 is accepted now and offered again (after 30 s): the next pass sends it while the write still hangs.
      server.refuse = null;
      skewUs += 31_000_000n;
      second = gateway.uplink.flush();
      await until(() => gateway.uplink.deliveredSeq() === 2n, 10_000, 'the server acknowledged reading 2 while the watermark write for reading 1 hangs');
      expect(await gateway.uplink.waitForAck(2n, CAPTURE_ACK_WAIT_MS)).toBe(true);
      expect(server.readings.map((r) => r.seq)).toEqual(['1', '2']);
      expect(gateway.journal.ackedSeq).toBe(0n);
    } finally {
      release();
    }
    await first;
    await second;
    await gateway.uplink.flush();
    expect(gateway.journal.ackedSeq).toBe(2n);
    expect(gateway.uplink.watermarkFailure).toBeNull();
  });

  it('[DI-28][DI-31] a capture whose upload answer was lost is answered uplinked as soon as a new login\'s server head shows the server holds its reading; nothing is sent again', async () => {
    const server = await fakeServer();
    const gateway = await startGateway(server);
    await gateway.uplink.logIn();
    // The server stores the reading, but its answer never arrives (the connection is cut).
    server.loseUploadAnswers = true;
    const capture = gateway.capture('TEST-BAL-01', 'GROSS');
    await until(() => server.readings.length === 1 && gateway.uplink.uploadFailure !== null, 10_000, 'the upload failed after the server stored the reading');
    server.loseUploadAnswers = false;
    // A new session (the server may have ended the old one): its head covers the reading the capture waits for.
    await gateway.uplink.logIn();
    const captured = await capture;
    expect(captured).toMatchObject({ outcome: 'CAPTURED', uplinked: true });
    expect(server.readings.map((r) => r.readingId)).toEqual([captured.reading?.readingId]);
    expect(gateway.journal.ackedSeq).toBe(1n);
    expect(server.itemsReceived).toBe(1);
  });

  it('[DI-28][DI-31] a capture waiting for a reading of a chain the server has since replaced (re-enrolment) is never answered uplinked by readings of the new chain', async () => {
    const server = await fakeServer();
    const gateway = await startGateway(server);
    await gateway.uplink.logIn();
    const oldChain = gateway.journal.chainId;
    server.uploadsDown = true;
    const capture = gateway.capture('TEST-BAL-01', 'GROSS');
    await until(() => gateway.journal.lastSeq() === 1n && gateway.uplink.uploadFailure !== null, 10_000, 'the capture journalled reading 1 and its upload failed');
    // The gateway is enrolled anew: a new chain whose reading 1 the server acknowledges while the capture still waits.
    server.reenrol();
    server.uploadsDown = false;
    await gateway.uplink.logIn();
    expect(gateway.journal.chainId).not.toBe(oldChain);
    await gateway.journal.appendNext(builder(server.chainId));
    await gateway.uplink.flush();
    expect(server.readings.map((r) => r.seq)).toEqual(['1']);
    // Asked about reading 1 of the old chain now, the answer is no as well.
    expect(await gateway.uplink.waitForAck(1n, 50, oldChain)).toBe(false);
    const captured = await capture;
    expect(captured).toMatchObject({ outcome: 'CAPTURED', uplinked: false });
    expect(captured.reading?.chainId).toBe(oldChain);
  });

  it('[DI-28][DI-30] when the uplink stops while the watermark write after an acknowledgement hangs, the waiting capture is answered uplinked at once', async () => {
    const server = await fakeServer();
    const gateway = await startGateway(server);
    await gateway.uplink.logIn();
    const release = stallWatermark(gateway);
    let answered: unknown = null;
    void gateway.capture('TEST-BAL-01', 'GROSS').then(
      (answer) => (answered = answer),
      (error: unknown) => (answered = error),
    );
    let stopping: Promise<void> | undefined;
    try {
      await until(() => gateway.uplink.deliveredSeq() === 1n, 10_000, 'the server acknowledged the reading');
      stopping = gateway.uplink.stop();
      // Answered before anything else runs (no timer, no disk).
      await new Promise((r) => setImmediate(r));
      expect(answered).toMatchObject({ outcome: 'CAPTURED', uplinked: true });
    } finally {
      release();
    }
    await stopping;
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

/**
 * Records the chains a login has asked the gateway's journal to adopt (Journal.adoptServerChain calls, before the
 * adoption runs); the adoption itself runs unchanged.
 */
function watchAdoptions(gateway: SiteGateway): (chainId: string) => boolean {
  const adopt = vi.spyOn(gateway.journal, 'adoptServerChain');
  return (chainId) => adopt.mock.calls.some(([asked]) => asked === chainId);
}

/** The chain named in the journal's chain.json (what a restart would continue). */
function chainOnDisk(gateway: SiteGateway): string {
  return (JSON.parse(readFileSync(join(gateway.config.journalDir, 'chain.json'), 'utf8')) as { chainId: string }).chainId;
}

describe('gateway-delivery-readiness-timing, round 2: a watermark change based on what the server said before a login never lands after the login\'s adoption (decision X33)', () => {
  it('[DI-31][DI-30] a re-enrolment login while one watermark write hangs and another waits behind it: the waiting write of the replaced chain is dropped, not failed, and the scale is ONLINE on the new chain', async () => {
    const server = await fakeServer();
    const gateway = await startGateway(server);
    await gateway.uplink.logIn();
    const oldChain = gateway.journal.chainId ?? '';
    // Journalled first: an append waits behind a hung watermark write (one journal lock).
    await gateway.journal.appendNext(builder(oldChain));
    await gateway.journal.appendNext(builder(oldChain, '2.500'));
    const adoptionAsked = watchAdoptions(gateway);
    const release = stallWatermark(gateway);
    let login: Promise<unknown> | undefined;
    try {
      // Two acknowledgements, one reading per upload: the watermark write for reading 1 hangs, the one for reading 2
      // waits behind it.
      server.uploadTakes = 1;
      void gateway.uplink.flush();
      await until(() => gateway.uplink.deliveredSeq() === 1n, 10_000, 'the server acknowledged reading 1');
      void gateway.uplink.flush();
      await until(() => gateway.uplink.deliveredSeq() === 2n, 10_000, 'the server acknowledged reading 2');
      server.uploadTakes = null;
      // The gateway is enrolled anew; the login's adoption of the new chain waits behind the hung write.
      server.reenrol();
      login = gateway.uplink.logIn();
      await until(() => adoptionAsked(server.chainId), 10_000, 'the login asked the journal to adopt the new chain');
    } finally {
      release();
    }
    await login;
    for (let i = 0; i < 3; i += 1) await gateway.uplink.flush();
    expect(gateway.journal.chainId).toBe(server.chainId);
    expect(chainOnDisk(gateway)).toBe(server.chainId);
    expect(gateway.uplink.watermarkFailure).toBeNull();
    // The hung write's own failure is the only one alarmed (the waiting write of the old chain is not a failure).
    expect(gateway.alarms.filter((a) => a.kind === 'ACK_WRITE_FAILED').map((a) => a.details['seq'])).toEqual(['1']);
    expect(serverStatus(await heartbeatEntry(gateway, server))).toBe('ONLINE');
    const captured = await gateway.capture('TEST-BAL-01', 'GROSS');
    expect(captured).toMatchObject({ outcome: 'CAPTURED', uplinked: true });
    expect(server.readings.map((r) => r.readingId)).toEqual([captured.reading?.readingId]);
  });

  it('[DI-31][DI-30] a login whose own adoption of the server\'s head cannot be written (no free inodes), with a write waiting behind a hung one: the waiting write, now stale, is dropped, but the watermark failure stands and captures answer NOT_READY until the watermark is written', async () => {
    const server = await fakeServer();
    const gateway = await startGateway(server);
    await gateway.uplink.logIn();
    const chain = gateway.journal.chainId ?? '';
    await gateway.journal.appendNext(builder(chain));
    await gateway.journal.appendNext(builder(chain, '2.500'));
    const adoptionAsked = watchAdoptions(gateway);
    const acknowledge = vi.spyOn(gateway.journal, 'acknowledge');
    const tmp = join(gateway.config.journalDir, `.ack-${chain}.json.tmp`);
    const release = stallWatermark(gateway, { thenBlocked: true });
    let login: Promise<unknown> | undefined;
    try {
      // Two acknowledgements, one reading per upload: the write for reading 1 hangs, the one for reading 2 waits.
      server.uploadTakes = 1;
      void gateway.uplink.flush();
      await until(() => gateway.uplink.deliveredSeq() === 1n, 10_000, 'the server acknowledged reading 1');
      void gateway.uplink.flush();
      await until(() => gateway.uplink.deliveredSeq() === 2n, 10_000, 'the server acknowledged reading 2');
      server.uploadTakes = null;
      // The server ends the session; the new login's adoption of its head (reading 2) waits behind the hung write.
      server.endSessions();
      login = gateway.uplink.logIn().then(
        () => null,
        (error: unknown) => error,
      );
      await until(() => adoptionAsked(chain), 10_000, 'the login asked the journal to adopt the server\'s head');
    } finally {
      // The hung write fails, and from now on no watermark file can be created.
      release();
    }
    expect(await login, 'the login fails: its adoption could not be written').toBeInstanceOf(Error);
    await until(() => acknowledge.mock.calls.some(([, seq]) => seq === 2n), 10_000, 'the waiting write reached the journal');
    const waiting = acknowledge.mock.results[acknowledge.mock.calls.findIndex(([, seq]) => seq === 2n)];
    expect(await waiting?.value, 'the waiting write, asked for before the login').toBe('STALE');
    await new Promise((r) => setImmediate(r));
    // Nothing reset the failure the hung write recorded: the watermark is not on disk, so nothing is captured.
    expect(gateway.uplink.watermarkFailure).not.toBeNull();
    expect(gateway.alarms.filter((a) => a.kind === 'ACK_WRITE_FAILED').map((a) => a.details['seq'])).toEqual(['1']);
    const lastSeq = gateway.journal.lastSeq();
    expect(await gateway.capture('TEST-BAL-01', 'GROSS')).toMatchObject({ outcome: 'FAILED', error: 'NOT_READY', reading: null });
    expect(gateway.journal.lastSeq()).toBe(lastSeq);
    // The disk recovers: the next login writes the server's head, and the scale is ready again.
    rmdirSync(tmp);
    await gateway.uplink.logIn();
    expect(gateway.journal.ackedSeq).toBe(2n);
    expect(gateway.uplink.watermarkFailure).toBeNull();
    expect(await gateway.capture('TEST-BAL-01', 'GROSS')).toMatchObject({ outcome: 'CAPTURED', uplinked: true });
  });

  it('[DI-31][DI-30] a reconciliation that moves the watermark back, waiting behind a hung watermark write, then a re-enrolment login: the journal and chain.json stay on the new chain', async () => {
    const server = await fakeServer();
    const gateway = await startGateway(server);
    await gateway.uplink.logIn();
    const oldChain = gateway.journal.chainId ?? '';
    for (let i = 0; i < 3; i += 1) await gateway.journal.appendNext(builder(oldChain));
    await gateway.uplink.flush();
    expect(gateway.journal.ackedSeq).toBe(3n);
    await gateway.journal.appendNext(builder(oldChain));
    const adoptionAsked = watchAdoptions(gateway);
    const release = stallWatermark(gateway);
    let heartbeat: Promise<void> | undefined;
    let login: Promise<unknown> | undefined;
    try {
      void gateway.uplink.flush();
      await until(() => gateway.uplink.deliveredSeq() === 4n, 10_000, 'the server acknowledged reading 4 (its watermark write hangs)');
      // The server is restored from a backup holding readings up to 1: the heartbeat's reconciliation moves the
      // watermark back to 1, a write that waits behind the hung one.
      server.restoreTo(1);
      heartbeat = gateway.uplink.heartbeat();
      await until(() => gateway.uplink.deliveredSeq() === 1n, 10_000, 'the reconciliation to the server\'s head');
      server.reenrol();
      login = gateway.uplink.logIn();
      await until(() => adoptionAsked(server.chainId), 10_000, 'the login asked the journal to adopt the new chain');
    } finally {
      release();
    }
    await login;
    await heartbeat;
    for (let i = 0; i < 3; i += 1) await gateway.uplink.flush();
    expect(gateway.journal.chainId).toBe(server.chainId);
    expect(chainOnDisk(gateway)).toBe(server.chainId);
    expect(gateway.journal.usable).toBe(true);
    expect(gateway.uplink.watermarkFailure).toBeNull();
    expect(gateway.alarms.filter((a) => a.kind === 'READING_REFUSED')).toEqual([]);
    expect(serverStatus(await heartbeatEntry(gateway, server))).toBe('ONLINE');
    expect(await gateway.capture('TEST-BAL-01', 'GROSS')).toMatchObject({ outcome: 'CAPTURED', uplinked: true });
  });

  it('[DI-31][DI-30] a heartbeat answer showing that the server\'s history diverged, arriving while a re-enrolment login waits behind a hung watermark write: the journal is not switched back to the replaced chain', async () => {
    const server = await fakeServer();
    const gateway = await startGateway(server);
    await gateway.uplink.logIn();
    const oldChain = gateway.journal.chainId ?? '';
    for (let i = 0; i < 2; i += 1) await gateway.journal.appendNext(builder(oldChain));
    await gateway.uplink.flush();
    await gateway.journal.appendNext(builder(oldChain));
    const adoptionAsked = watchAdoptions(gateway);
    const release = stallWatermark(gateway);
    let letHeartbeatGo = (): void => undefined;
    let heartbeat: Promise<void> | undefined;
    let login: Promise<unknown> | undefined;
    try {
      void gateway.uplink.flush();
      await until(() => gateway.uplink.deliveredSeq() === 3n, 10_000, 'the server acknowledged reading 3 (its watermark write hangs)');
      // The server now holds a reading 1 this journal does not have, and answers the next heartbeat with it late.
      server.restoreTo(0);
      server.readings.push(builder(oldChain, '9.999')(1n, genesisHash(oldChain)));
      server.heartbeatGate = new Promise<void>((r) => (letHeartbeatGo = r));
      const accepted = server.heartbeats.length;
      heartbeat = gateway.uplink.heartbeat();
      await until(() => server.heartbeats.length > accepted, 10_000, 'the server took the heartbeat');
      server.reenrol();
      login = gateway.uplink.logIn();
      await until(() => adoptionAsked(server.chainId), 10_000, 'the login asked the journal to adopt the new chain');
      server.heartbeatGate = null;
      letHeartbeatGo();
      await until(() => gateway.alarms.some((a) => a.kind === 'UPLINK_FAILED' && /fewer than/.test(a.message)), 10_000, 'the heartbeat answer handled');
    } finally {
      letHeartbeatGo();
      release();
    }
    await login;
    await heartbeat;
    await gateway.uplink.flush();
    expect(gateway.journal.chainId).toBe(server.chainId);
    expect(chainOnDisk(gateway)).toBe(server.chainId);
    expect(gateway.journal.usable).toBe(true);
    expect(gateway.alarms.filter((a) => a.kind === 'DIVERGED')).toEqual([]);
    expect(serverStatus(await heartbeatEntry(gateway, server))).toBe('ONLINE');
    expect(await gateway.capture('TEST-BAL-01', 'GROSS')).toMatchObject({ outcome: 'CAPTURED', uplinked: true });
  });

  it('[DI-31][DI-28] a login that continues the same chain from a lower head (the server was restored from a backup) while one watermark write hangs and another waits behind it: the waiting write does not move the watermark past the login\'s head, and the readings after it are sent again', async () => {
    const server = await fakeServer();
    const gateway = await startGateway(server);
    await gateway.uplink.logIn();
    const chain = gateway.journal.chainId ?? '';
    for (let i = 0; i < 3; i += 1) await gateway.journal.appendNext(builder(chain));
    await gateway.uplink.flush();
    expect(gateway.journal.ackedSeq).toBe(3n);
    // Journalled first: an append waits behind a hung watermark write (one journal lock).
    await gateway.journal.appendNext(builder(chain));
    await gateway.journal.appendNext(builder(chain));
    const adoptionAsked = watchAdoptions(gateway);
    const release = stallWatermark(gateway);
    let login: Promise<unknown> | undefined;
    try {
      // One reading per upload: the watermark write for reading 4 hangs, the one for reading 5 waits behind it.
      server.uploadTakes = 1;
      void gateway.uplink.flush();
      await until(() => gateway.uplink.deliveredSeq() === 4n, 10_000, 'the server acknowledged reading 4 (its watermark write hangs)');
      void gateway.uplink.flush();
      await until(() => gateway.uplink.deliveredSeq() === 5n, 10_000, 'the server acknowledged reading 5 (its write waits)');
      server.uploadTakes = null;
      // The server restarts from a backup holding readings up to 1: the new login's head is reading 1.
      server.restoreTo(1);
      server.endSessions();
      login = gateway.uplink.logIn();
      await until(() => adoptionAsked(chain), 10_000, 'the login asked the journal to adopt the server\'s head');
    } finally {
      release();
    }
    await login;
    // The waiting write has settled before anything is offered again (a pass whose uploads fail waits for it): the
    // watermark is the login's head.
    server.uploadsDown = true;
    await gateway.uplink.flush();
    expect(gateway.journal.ackedSeq, 'the watermark once the waiting write has settled').toBe(1n);
    server.uploadsDown = false;
    for (let i = 0; i < 3; i += 1) await gateway.uplink.flush();
    // Readings 2 to 5 were offered again and the server holds them all; nothing was refused.
    expect(server.readings.map((r) => r.seq)).toEqual(['1', '2', '3', '4', '5']);
    expect(gateway.journal.ackedSeq).toBe(5n);
    expect(gateway.uplink.watermarkFailure).toBeNull();
    expect(gateway.alarms.filter((a) => a.kind === 'READING_REFUSED')).toEqual([]);
    expect(await gateway.capture('TEST-BAL-01', 'GROSS')).toMatchObject({ outcome: 'CAPTURED', uplinked: true });
    expect(server.readings.map((r) => r.seq)).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  it('[DI-31][DI-28] an upload\'s answer that arrives after a login continuing the chain from a lower head (the server was restored from a backup): it is dropped, so the same pass goes on from the login\'s head and nothing is refused', async () => {
    const server = await fakeServer();
    const gateway = await startGateway(server);
    await gateway.uplink.logIn();
    const chain = gateway.journal.chainId ?? '';
    for (let i = 0; i < 3; i += 1) await gateway.journal.appendNext(builder(chain));
    await gateway.uplink.flush();
    expect(gateway.journal.ackedSeq).toBe(3n);
    for (let i = 0; i < 2; i += 1) await gateway.journal.appendNext(builder(chain));
    let letAnswerGo = (): void => undefined;
    server.uploadAnswerGate = new Promise<void>((r) => (letAnswerGo = r));
    let pass: Promise<void> | undefined;
    try {
      // Readings 4 and 5 reach the server; its answer (the server holds up to 5) is held up.
      pass = gateway.uplink.flush();
      await until(() => server.readings.length === 5, 10_000, 'the server stored readings 4 and 5');
      // Meanwhile the server restarts from a backup holding reading 1: the new login's head is reading 1.
      server.restoreTo(1);
      server.endSessions();
      await gateway.uplink.logIn();
      expect(gateway.journal.ackedSeq).toBe(1n);
      await gateway.journal.appendNext(builder(chain));
    } finally {
      server.uploadAnswerGate = null;
      letAnswerGo();
    }
    // The held answer arrives after the login: the pass sends readings 2 to 6, not reading 6 alone (after the 5 the
    // answer names), which the restored server would refuse as out of sequence.
    await pass;
    expect(gateway.alarms.filter((a) => a.kind === 'READING_REFUSED')).toEqual([]);
    expect(server.readings.map((r) => r.seq)).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(gateway.journal.ackedSeq).toBe(6n);
    expect(gateway.uplink.watermarkFailure).toBeNull();
  });

  it('[DI-31] a heartbeat answered before a login but handled after it: the older server head it names moves no watermark, and nothing is sent again', async () => {
    const server = await fakeServer();
    const gateway = await startGateway(server);
    await gateway.uplink.logIn();
    const chain = gateway.journal.chainId ?? '';
    for (let i = 0; i < 3; i += 1) await gateway.journal.appendNext(builder(chain));
    await gateway.uplink.flush();
    // The server is restored from a backup holding reading 1, and its answer to a heartbeat (that head) comes late.
    server.restoreTo(1);
    let letHeartbeatGo = (): void => undefined;
    server.heartbeatGate = new Promise<void>((r) => (letHeartbeatGo = r));
    const accepted = server.heartbeats.length;
    let heartbeat: Promise<void> | undefined;
    try {
      heartbeat = gateway.uplink.heartbeat();
      await until(() => server.heartbeats.length > accepted, 10_000, 'the server took the heartbeat');
      server.heartbeatGate = null;
      // Meanwhile the server restarts: the new login's head is reading 1, and readings 2 and 3 are sent again.
      server.endSessions();
      await gateway.uplink.logIn();
      await gateway.uplink.flush();
      expect(server.readings.map((r) => r.seq)).toEqual(['1', '2', '3']);
      expect(gateway.journal.ackedSeq).toBe(3n);
    } finally {
      letHeartbeatGo();
    }
    const sent = server.itemsReceived;
    await heartbeat;
    await gateway.uplink.flush();
    expect(gateway.journal.ackedSeq).toBe(3n);
    expect(server.itemsReceived, 'readings sent again after the late answer').toBe(sent);
  });

  it('[DI-31][DI-28] the answer to an upload of the replaced chain, arriving after a re-enrolment login: it is not taken for the new chain\'s reading of the same number, which is delivered before its capture is answered uplinked', async () => {
    const server = await fakeServer();
    const gateway = await startGateway(server);
    await gateway.uplink.logIn();
    const oldChain = gateway.journal.chainId ?? '';
    let letAnswerGo = (): void => undefined;
    server.uploadAnswerGate = new Promise<void>((r) => (letAnswerGo = r));
    let capture: ReturnType<SiteGateway['capture']> | undefined;
    let pass: Promise<void> | undefined;
    try {
      // Reading 1 of the old chain reaches the server; the answer is held up.
      await gateway.journal.appendNext(builder(oldChain));
      pass = gateway.uplink.flush();
      await until(() => server.readings.length === 1, 10_000, 'the server stored reading 1 of the old chain');
      // The gateway is enrolled anew and logs in; a capture journals reading 1 of the new chain.
      server.reenrol();
      await gateway.uplink.logIn();
      expect(gateway.journal.chainId).toBe(server.chainId);
      capture = gateway.capture('TEST-BAL-01', 'GROSS');
      await until(() => gateway.journal.lastSeq() === 1n, 10_000, 'the capture journalled reading 1 of the new chain');
    } finally {
      server.uploadAnswerGate = null;
      letAnswerGo();
    }
    await pass;
    const captured = await capture;
    expect(captured).toMatchObject({ outcome: 'CAPTURED', uplinked: true });
    expect(captured?.reading?.chainId).toBe(server.chainId);
    expect(server.readings.map((r) => r.readingId)).toEqual([captured?.reading?.readingId]);
    expect(gateway.journal.ackedSeq).toBe(1n);
  });
});

describe('review P50, follow-up round 2: the gateway does not fall silent while a new login is held up (decision X31)', () => {
  it('[DI-30][PR-20] while a new login gets no answer (held up in the server, or its connection cut) the heartbeats go on with the last login\'s token and reach the server without a pause; once a login succeeds they carry its token; a refused login stops them', async () => {
    const server = await fakeServer();
    const gateway = await startGateway(server, { manualUplink: false, heartbeatMs: 500 });
    await until(() => gateway.uplink.login !== null && server.heartbeats.length > 0, 15_000, 'the first heartbeat');
    const firstToken = server.heartbeatsReceived.at(-1)?.tokenHash;
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    /** The longest time (ms) without a heartbeat reaching the server, from the one at index `from` until now. */
    const longestGap = (from: number): number => {
      const at = [...server.heartbeatsReceived.slice(from).map((h) => h.at), performance.now()];
      return Math.max(...at.slice(1).map((t, i) => t - (at[i] ?? t)));
    };

    // 1. The server ends the session (as after its restart) and holds the new login up for 3 s (as its database can).
    let release = (): void => undefined;
    server.loginGate = new Promise<void>((r) => (release = r));
    const accepted = server.heartbeats.length;
    const heldFrom = server.heartbeatsReceived.length;
    server.endSessions();
    await pause(3000);
    const held = server.heartbeatsReceived.slice(heldFrom);
    expect(held.length).toBeGreaterThanOrEqual(4);
    expect([...new Set(held.map((h) => h.tokenHash))]).toEqual([firstToken]);
    expect(server.heartbeats.length).toBe(accepted);
    expect(longestGap(heldFrom)).toBeLessThan(1500);
    // Let go, the login succeeds and the heartbeats carry its token: accepted again.
    server.loginGate = null;
    release();
    await until(() => server.heartbeats.length > accepted, 5000, 'a heartbeat accepted after the login');
    expect(server.heartbeatsReceived.at(-1)?.tokenHash).not.toBe(firstToken);

    // 2. The session ends again and every login's connection is cut (no answer): the logins are retried and the
    // heartbeats go on meanwhile.
    server.cutLogins = true;
    const cutFrom = server.heartbeatsReceived.length;
    server.endSessions();
    await pause(3000);
    expect(server.heartbeatsReceived.length - cutFrom).toBeGreaterThanOrEqual(4);
    expect(longestGap(cutFrom)).toBeLessThan(1500);
    server.cutLogins = false;
    const accepted2 = server.heartbeats.length;
    await until(() => server.heartbeats.length > accepted2, 15_000, 'a heartbeat accepted after the next login');

    // 3. The session ends and the login is refused: the gateway sends no more heartbeats (it cannot deliver; P51).
    server.refuseLogins = true;
    server.endSessions();
    await pause(1000);
    const refusedFrom = server.heartbeatsReceived.length;
    await pause(2000);
    expect(server.heartbeatsReceived.length).toBe(refusedFrom);
    expect(gateway.uplink.token).toBeNull();
  }, 60_000);
});
