/**
 * The gateway journal (DI-28 buffering, DI-31): fsync'd, hash-chained, verified at start, uploaded exactly once
 * in order across restarts and crashes.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { READING_FORMAT, ed25519PrivateKey, ed25519PublicKey, genesisHash, sealReading, type ScaleReading } from '@ebmr/integration-sdk/scale';
import { systemClock } from '../src/clock.ts';
import { Journal, JournalIntegrityError } from '../src/journal.ts';
import { Uplink, newApiToken } from '../src/uplink.ts';
import { FakeServer, configFor, gatewayKeys, tempDir } from './support.ts';

const keys = gatewayKeys();
const privateKey = ed25519PrivateKey(keys.privateKeyPkcs8);
const publicKey = ed25519PublicKey(keys.publicKeySpki);
const servers: FakeServer[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
});

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

async function openJournal(dir: string, alarms: string[] = []): Promise<Journal> {
  return Journal.open({ dir, gatewayCode: 'TEST-GW-01', publicKey, onAlarm: (a) => alarms.push(a.kind) });
}

async function server(): Promise<FakeServer> {
  const s = new FakeServer(keys.publicKeySpki);
  await s.start();
  servers.push(s);
  return s;
}

function uplinkFor(s: FakeServer, journal: Journal, dir: string): Uplink {
  return new Uplink({
    config: configFor({ simPort: 1, uplink: s.url, journalDir: dir, keys }),
    journal,
    clock: systemClock,
    apiToken: newApiToken(),
    capturedAt: new Map(),
    heartbeatBody: () => ({ devices: [] }),
  });
}

describe('gateway journal', () => {
  it('[DI-28] survives a restart with no gap or duplicate: unacknowledged readings are uploaded once, in order', async () => {
    const dir = tempDir();
    const s = await server();
    let j = await openJournal(dir);
    let up = uplinkFor(s, j, dir);
    await up.logIn();
    for (let i = 0; i < 3; i += 1) await j.appendNext(builder(s.chainId));
    await up.flush();
    expect(s.readings.map((r) => r.seq)).toEqual(['1', '2', '3']);
    // The listener goes away; captures continue into the journal (buffered).
    s.down = true;
    for (let i = 0; i < 4; i += 1) await j.appendNext(builder(s.chainId));
    await up.flush();
    expect(j.pending()).toHaveLength(4);
    // The gateway restarts (process gone: no in-memory state survives).
    await up.stop();
    await j.close();
    j = await openJournal(dir);
    expect(j.lastSeq()).toBe(7n);
    expect(j.ackedSeq).toBe(3n);
    s.down = false;
    up = uplinkFor(s, j, dir);
    await up.logIn();
    await up.flush();
    expect(s.readings.map((r) => r.seq)).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    expect(new Set(s.readings.map((r) => r.readingId)).size).toBe(7);
    expect(j.ackedSeq).toBe(7n);
    await up.stop();
    await j.close();
  });

  it('[DI-28] a crash between upload and acknowledgement: at login the server head moves the watermark; nothing is ingested twice', async () => {
    const dir = tempDir();
    const s = await server();
    let j = await openJournal(dir);
    let up = uplinkFor(s, j, dir);
    await up.logIn();
    for (let i = 0; i < 3; i += 1) await j.appendNext(builder(s.chainId));
    await up.flush();
    // Simulate the lost acknowledgement: the watermark file says 1 although the server holds 3.
    const ackFile = join(dir, `ack-${s.chainId}.json`);
    writeFileSync(ackFile, `${JSON.stringify({ seq: '1', hash: j.all()[0]!.hash })}\n`);
    await up.stop();
    await j.close();
    j = await openJournal(dir);
    expect(j.ackedSeq).toBe(1n);
    up = uplinkFor(s, j, dir);
    await up.logIn();
    expect(j.ackedSeq).toBe(3n);
    await up.flush();
    expect(s.readings.map((r) => r.seq)).toEqual(['1', '2', '3']);
    await up.stop();
    await j.close();
  });

  it('[DI-31][DI-28] reconciliation by counts: when the server holds fewer readings than acknowledged, the journal sends them again', async () => {
    const dir = tempDir();
    const s = await server();
    const j = await openJournal(dir);
    const up = uplinkFor(s, j, dir);
    await up.logIn();
    for (let i = 0; i < 4; i += 1) await j.appendNext(builder(s.chainId));
    await up.flush();
    expect(j.ackedSeq).toBe(4n);
    // The server was restored from a backup taken after reading 2.
    s.readings.length = 2;
    await up.heartbeat();
    await up.flush();
    expect(s.readings.map((r) => r.seq)).toEqual(['1', '2', '3', '4']);
    expect(j.ackedSeq).toBe(4n);
    await up.stop();
    await j.close();
  });

  it('[DI-28] a resend of readings the server already holds is idempotent (duplicates, never second copies)', async () => {
    const dir = tempDir();
    const s = await server();
    const j = await openJournal(dir);
    const up = uplinkFor(s, j, dir);
    await up.logIn();
    const a = await j.appendNext(builder(s.chainId));
    await up.flush();
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${up.token ?? ''}` };
    const { challengeId } = (await (await fetch(`${s.url}/gw/v1/challenge`, { method: 'POST', headers, body: '{}' })).json()) as { challengeId: string };
    const res = await fetch(`${s.url}/gw/v1/readings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ challengeId, items: [{ reading: a, delayUs: null, waitSig: null }] }),
    });
    expect(((await res.json()) as { results: { outcome: string }[] }).results[0]?.outcome).toBe('DUPLICATE');
    expect(s.readings).toHaveLength(1);
    await up.stop();
    await j.close();
  });

  it('[DI-28] an unterminated last line (crash mid-write) is set aside as evidence; the chain continues without a gap', async () => {
    const dir = tempDir();
    const chain = randomUUID();
    const alarms: string[] = [];
    let j = await openJournal(dir);
    await j.adoptServerChain(chain, { seq: '0', hash: genesisHash(chain) });
    await j.appendNext(builder(chain));
    await j.appendNext(builder(chain));
    await j.close();
    appendFileSync(join(dir, `journal-${chain}.jsonl`), '{"format":"ebmr.scale-reading.v1","readingId":"trunc');
    j = await openJournal(dir, alarms);
    expect(alarms).toContain('PARTIAL_LINE_QUARANTINED');
    expect(j.lastSeq()).toBe(2n);
    expect(readdirSync(dir).some((f) => f.includes('.partial-1'))).toBe(true);
    const next = await j.appendNext(builder(chain));
    expect(next.seq).toBe('3');
    await j.close();
    const reopened = await openJournal(dir);
    expect(reopened.all().map((r) => r.seq)).toEqual(['1', '2', '3']);
    await reopened.close();
  });

  it('[DI-31] a journal that was altered refuses the start (fail closed)', async () => {
    const dir = tempDir();
    const chain = randomUUID();
    const j = await openJournal(dir);
    await j.adoptServerChain(chain, { seq: '0', hash: genesisHash(chain) });
    await j.appendNext(builder(chain, '1.250'));
    await j.appendNext(builder(chain, '2.500'));
    await j.close();
    const file = join(dir, `journal-${chain}.jsonl`);
    writeFileSync(file, readFileSync(file, 'latin1').replace('"2.500"', '"2.600"'), 'latin1');
    await expect(openJournal(dir)).rejects.toThrow(JournalIntegrityError);
    // A removed line breaks the sequence as well.
    const lines = readFileSync(file, 'latin1').split('\n');
    writeFileSync(file, `${lines[1]}\n`, 'latin1');
    await expect(openJournal(dir)).rejects.toThrow(JournalIntegrityError);
  });

  it('[DI-31] a server head that this journal does not hold stops captures and uploads (re-enrolment needed)', async () => {
    const dir = tempDir();
    const s = await server();
    const alarms: string[] = [];
    const j = await openJournal(dir, alarms);
    const up = uplinkFor(s, j, dir);
    await up.logIn();
    await j.appendNext(builder(s.chainId));
    await up.flush();
    // The server holds a reading this journal never wrote (e.g. the journal disk was replaced).
    s.readings.push({ ...s.readings[0]!, readingId: randomUUID(), seq: '2', hash: 'f'.repeat(64) });
    await up.stop();
    const up2 = uplinkFor(s, j, dir);
    await up2.logIn();
    expect(j.usable).toBe(false);
    expect(alarms).toContain('DIVERGED');
    await expect(j.appendNext(builder(s.chainId))).rejects.toThrow(/re-enrolment/);
    // A new enrolment starts a new chain; the old journal file is kept.
    s.reenrol();
    const up3 = uplinkFor(s, j, dir);
    await up3.logIn();
    expect(j.usable).toBe(true);
    expect(j.chainId).toBe(s.chainId);
    expect(existsSync(join(dir, `journal-${s.chainId}.jsonl`))).toBe(true);
    expect(readdirSync(dir).filter((f) => f.startsWith('journal-') && f.endsWith('.jsonl'))).toHaveLength(2);
    await up2.stop();
    await up3.stop();
    await j.close();
  });
});
