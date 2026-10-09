/**
 * The journal on a failing disk (review finding P52; DI-28, DI-31).
 *
 * A reading is answered and uploaded only after its whole line is on disk and synced. When the file system runs out
 * of room part-way through a line, write(2) writes only part of it and Node resolves the write with the short count
 * and no error; the next write at the limit fails. The disk-full condition is produced for real with this process's
 * soft RLIMIT_FSIZE (prlimit): the kernel lets writes through up to the limit and refuses the rest, as a nearly full
 * disk does (Node ignores SIGXFSZ). The limit is lifted right after ("space was freed").
 *
 * Safe behaviour: a failed append resolves nothing, leaves no partial bytes behind (the file is cut back to its
 * last whole line), stops further appends until a restart re-verifies the file, and is alarmed; every answered
 * reading survives the restart and the journal still opens; the readings journalled before a failed append are still
 * uploaded. A failure to write the acknowledgement watermark is alarmed once and never crashes the gateway (no
 * unhandled rejection): the uplink keeps what the server acknowledged in memory, so every reading is delivered once
 * even when the watermark stays unwritable, and the watermark catches up when the disk recovers.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { READING_FORMAT, ed25519PrivateKey, ed25519PublicKey, genesisHash, sealReading, type ScaleReading } from '@ebmr/integration-sdk/scale';
import { systemClock } from '../src/clock.ts';
import { Journal, type JournalAlarm } from '../src/journal.ts';
import { Uplink, newApiToken, type UplinkAlarm } from '../src/uplink.ts';
import { FakeServer, configFor, gatewayKeys, tempDir } from './support.ts';

const keys = gatewayKeys();
const privateKey = ed25519PrivateKey(keys.privateKeyPkcs8);
const publicKey = ed25519PublicKey(keys.publicKeySpki);
const servers: FakeServer[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
});

function builder(chainId: string, value: string) {
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

async function openJournal(dir: string, alarms: JournalAlarm[] = []): Promise<Journal> {
  return Journal.open({ dir, gatewayCode: 'TEST-GW-01', publicKey, onAlarm: (a) => alarms.push(a) });
}

/** The soft file-size limit of this process (bytes or 'unlimited'). */
function softFileSizeLimit(): string {
  return execFileSync('prlimit', ['--pid', String(process.pid), '--fsize', '--raw', '--noheadings', '--output=SOFT']).toString().trim();
}

/** Runs `work` while this process may write files only up to `bytes` (a nearly full disk), then lifts the limit. */
async function withFileSizeLimit<T>(bytes: number, work: () => Promise<T>): Promise<T> {
  const original = softFileSizeLimit();
  execFileSync('prlimit', ['--pid', String(process.pid), `--fsize=${bytes}:`]);
  try {
    return await work();
  } finally {
    execFileSync('prlimit', ['--pid', String(process.pid), `--fsize=${original}:`]);
  }
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };
function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

describe('gateway journal on a failing disk (review P52)', () => {
  it('[DI-28][DI-31] a short write never resolves as journalled; every answered reading survives a restart and the journal still opens', async () => {
    const dir = tempDir();
    const chain = randomUUID();
    const j = await openJournal(dir);
    await j.adoptServerChain(chain, { seq: '0', hash: genesisHash(chain) });
    const file = join(dir, `journal-${chain}.jsonl`);

    // Readings whose appendNext resolved: the gateway answers these captures and uploads them.
    const answered: ScaleReading[] = [];
    answered.push(await j.appendNext(builder(chain, '1.250')));

    // The disk has room for only 64 more bytes of the journal while reading 2 is written.
    const second = await withFileSizeLimit(statSync(file).size + 64, () => settle(j.appendNext(builder(chain, '2.500'))));
    if (second.ok) {
      answered.push(second.value);
      expect
        .soft(readFileSync(file, 'latin1').endsWith(`${JSON.stringify(second.value)}\n`), `appendNext resolved reading ${second.value.seq} (it would be answered CAPTURED and uploaded) but its journal line on disk is truncated`)
        .toBe(true);
    }

    // Space was freed: the next capture.
    const third = await settle(j.appendNext(builder(chain, '3.750')));
    if (third.ok) answered.push(third.value);
    await j.close();

    // The gateway restarts: the journal must open, and every reading that was answered must still be in it.
    const alarms: JournalAlarm[] = [];
    const reopened = await settle(openJournal(dir, alarms));
    expect(reopened.ok ? 'journal opened' : `journal refused to open: ${String(reopened.error)}`).toBe('journal opened');
    if (!reopened.ok) return;
    const onDisk = reopened.value.all().map((r) => r.readingId);
    for (const a of answered) expect(onDisk, `answered reading ${a.seq} is missing after the restart`).toContain(a.readingId);
    expect(alarms.map((a) => a.kind), 'an answered reading was quarantined as never answered').not.toContain('PARTIAL_LINE_QUARANTINED');
    await reopened.value.close();
  });

  it('[DI-28][DI-31] a failed append leaves no partial bytes, is alarmed and stops the journal until a restart re-verifies it', async () => {
    const dir = tempDir();
    const chain = randomUUID();
    const alarms: JournalAlarm[] = [];
    const j = await openJournal(dir, alarms);
    await j.adoptServerChain(chain, { seq: '0', hash: genesisHash(chain) });
    const file = join(dir, `journal-${chain}.jsonl`);
    const first = await j.appendNext(builder(chain, '1.250'));
    const whole = readFileSync(file, 'latin1');

    // Part of the line fits, the rest does not: the append is refused and the file is cut back to its last whole line.
    const failed = await withFileSizeLimit(statSync(file).size + 64, () => settle(j.appendNext(builder(chain, '2.500'))));
    expect(failed.ok).toBe(false);
    expect(readFileSync(file, 'latin1')).toBe(whole);
    expect(j.lastSeq()).toBe(1n);
    expect(j.usable).toBe(false);
    expect(j.writeFailure).toMatch(/2/);
    expect(alarms.map((a) => a.kind)).toContain('WRITE_FAILED');

    // Space was freed, but the journal takes nothing more in this process (the file system's state is not trusted).
    const refused = await settle(j.appendNext(builder(chain, '3.750')));
    expect(refused.ok).toBe(false);
    expect(readFileSync(file, 'latin1')).toBe(whole);
    // A login that finds the server at this journal's head does not clear the failure either.
    await j.adoptServerChain(chain, { seq: '1', hash: first.hash });
    expect(j.usable).toBe(false);
    await j.close();

    // The restart verifies the file from disk and continues the chain without a gap.
    const restartAlarms: JournalAlarm[] = [];
    const reopened = await openJournal(dir, restartAlarms);
    expect(reopened.usable).toBe(true);
    expect(reopened.all().map((r) => r.readingId)).toEqual([first.readingId]);
    expect(restartAlarms).toEqual([]);
    const next = await reopened.appendNext(builder(chain, '2.500'));
    expect(next.seq).toBe('2');
    await reopened.close();
  });

  it('[DI-28][DI-31] an append refused outright (no room at all) is alarmed and changes nothing on disk', async () => {
    const dir = tempDir();
    const chain = randomUUID();
    const alarms: JournalAlarm[] = [];
    const j = await openJournal(dir, alarms);
    await j.adoptServerChain(chain, { seq: '0', hash: genesisHash(chain) });
    const file = join(dir, `journal-${chain}.jsonl`);
    await j.appendNext(builder(chain, '1.250'));
    const whole = readFileSync(file, 'latin1');
    const failed = await withFileSizeLimit(statSync(file).size, () => settle(j.appendNext(builder(chain, '2.500'))));
    expect(failed.ok).toBe(false);
    expect(readFileSync(file, 'latin1')).toBe(whole);
    expect(j.usable).toBe(false);
    expect(alarms.map((a) => a.kind)).toContain('WRITE_FAILED');
    await j.close();
  });

  it('[DI-28] a watermark that cannot be written is alarmed, never crashes the gateway; the readings stay pending and are acknowledged later', async () => {
    const dir = tempDir();
    const s = new FakeServer(keys.publicKeySpki);
    await s.start();
    servers.push(s);
    const j = await openJournal(dir);
    const alarms: UplinkAlarm[] = [];
    const up = new Uplink({
      config: configFor({ simPort: 1, uplink: s.url, journalDir: dir, keys }),
      journal: j,
      clock: systemClock,
      apiToken: newApiToken(),
      capturedAt: new Map(),
      onAlarm: (a) => alarms.push(a),
      heartbeatBody: () => ({ devices: [] }),
    });
    await up.logIn();
    await j.appendNext(builder(s.chainId, '1.250'));
    await j.appendNext(builder(s.chainId, '2.500'));

    // The disk is full while the server acknowledges: the watermark file cannot be written.
    const flushed = await withFileSizeLimit(8, () => settle(up.flush()));
    expect(flushed.ok ? 'flush settled' : `flush rejected (an unhandled rejection kills the gateway): ${String(flushed.error)}`).toBe('flush settled');
    expect(s.readings.map((r) => r.seq)).toEqual(['1', '2']);
    expect(j.ackedSeq).toBe(0n);
    expect(alarms.some((a) => a.kind === 'ACK_WRITE_FAILED')).toBe(true);

    // Space was freed: the next flush records the watermark (nothing needs sending again).
    await up.flush();
    expect(s.readings.map((r) => r.seq)).toEqual(['1', '2']);
    expect(j.ackedSeq).toBe(2n);
    await up.stop();
    await j.close();
  });

  it('[DI-28][DI-31] a watermark that cannot be written for good: more than one batch of readings is delivered, each once, and acknowledged when the disk recovers', async () => {
    const dir = tempDir();
    const s = new FakeServer(keys.publicKeySpki);
    await s.start();
    servers.push(s);
    const j = await openJournal(dir);
    const alarms: UplinkAlarm[] = [];
    const up = new Uplink({
      config: configFor({ simPort: 1, uplink: s.url, journalDir: dir, keys }),
      journal: j,
      clock: systemClock,
      apiToken: newApiToken(),
      capturedAt: new Map(),
      onAlarm: (a) => alarms.push(a),
      heartbeatBody: () => ({ devices: [] }),
    });
    await up.logIn();
    // The watermark's temporary file cannot be created (as with no free inodes); appends to the open journal work.
    const blocker = join(dir, `.ack-${s.chainId}.json.tmp`);
    mkdirSync(blocker);
    for (let i = 0; i < 51; i += 1) await j.appendNext(builder(s.chainId, '1.250'));
    const flushed = await settle(up.flush());
    expect(flushed.ok).toBe(true);
    expect(s.readings).toHaveLength(51);
    expect(s.itemsReceived).toBe(51);
    expect(j.ackedSeq).toBe(0n);
    expect(up.watermarkFailure).not.toBeNull();
    expect(alarms.filter((a) => a.kind === 'ACK_WRITE_FAILED')).toHaveLength(1);
    // Later flushes send nothing again while the watermark stays behind; a new reading is delivered at once.
    await up.flush();
    await j.appendNext(builder(s.chainId, '2.500'));
    await up.flush();
    expect(s.readings).toHaveLength(52);
    expect(s.itemsReceived).toBe(52);
    expect(await up.waitForAck(52n, 10)).toBe(true);
    // The disk recovers: the watermark follows the server without sending anything again.
    rmdirSync(blocker);
    await up.flush();
    expect(j.ackedSeq).toBe(52n);
    expect(up.watermarkFailure).toBeNull();
    expect(s.itemsReceived).toBe(52);
    await up.stop();
    await j.close();
    // After a restart, nothing is pending and nothing is sent again.
    const reopened = await openJournal(dir);
    expect(reopened.ackedSeq).toBe(52n);
    expect(reopened.pending()).toEqual([]);
    await reopened.close();
  });

  it('[DI-28][DI-31] after a failed append, the readings journalled before it are still uploaded', async () => {
    const dir = tempDir();
    const s = new FakeServer(keys.publicKeySpki);
    await s.start();
    servers.push(s);
    const j = await openJournal(dir);
    const up = new Uplink({
      config: configFor({ simPort: 1, uplink: s.url, journalDir: dir, keys }),
      journal: j,
      clock: systemClock,
      apiToken: newApiToken(),
      capturedAt: new Map(),
      heartbeatBody: () => ({ devices: [] }),
    });
    await up.logIn();
    // The listener is away while two readings are journalled (answered CAPTURED, not yet uploaded).
    s.down = true;
    await j.appendNext(builder(s.chainId, '1.250'));
    await j.appendNext(builder(s.chainId, '2.500'));
    await up.flush();
    expect(s.readings).toEqual([]);
    // The disk fills up during the next append: the journal stops taking readings.
    const file = join(dir, `journal-${s.chainId}.jsonl`);
    const failed = await withFileSizeLimit(statSync(file).size + 64, () => settle(j.appendNext(builder(s.chainId, '3.750'))));
    expect(failed.ok).toBe(false);
    expect(j.writeFailure).not.toBeNull();
    // The listener is back: the two whole, synced readings still reach the server; the failed one never existed.
    s.down = false;
    await up.flush();
    expect(s.readings.map((r) => r.seq)).toEqual(['1', '2']);
    expect(j.ackedSeq).toBe(2n);
    await up.stop();
    await j.close();
  });
});
