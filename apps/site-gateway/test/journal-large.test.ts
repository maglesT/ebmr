/**
 * Large journals at start (hosted demo, 1 November 2026): the process journal passed 2 GiB, the most one readFile can
 * return (ERR_FS_FILE_TOO_LARGE), and the gateway no longer started. Here readFile refuses every journal file as it
 * would past the cap, so a start passes only if it streams; the process journal's sealed segments, its checkpoint
 * and the first start of a journal of one large file are proved too, with every start-up check kept.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { READING_FORMAT, ed25519PrivateKey, ed25519PublicKey, genesisHash, sealReading, type ScaleReading } from '@ebmr/integration-sdk/scale';
import type { ProcessReading } from '@ebmr/integration-sdk/process';
import { Journal } from '../src/journal.ts';
import { PrintJournal } from '../src/print-journal.ts';
import { ProcessJournal, ProcessJournalIntegrityError } from '../src/process-journal.ts';
import { gatewayKeys, tempDir } from './support.ts';

// What a single read of a journal past 2 GiB does: refused. Small files (marks, checkpoint, chain) read as usual.
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof FsPromises>();
  return {
    ...real,
    readFile: (path: unknown, ...rest: unknown[]) => {
      if (String(path).endsWith('.jsonl')) {
        const e = new RangeError('File size is greater than 2 GiB') as RangeError & { code: string };
        e.code = 'ERR_FS_FILE_TOO_LARGE';
        return Promise.reject(e);
      }
      return (real.readFile as (...a: unknown[]) => Promise<unknown>)(path, ...rest);
    },
  };
});

const SESSION = '7a1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e11';
const reading = (deviceSerial: string, n: number): Omit<ProcessReading, 'sequence'> => ({
  deviceSerial,
  tag: 'press.main_force_kN',
  value: `${String(10 + (n % 7))}.25`,
  unit: 'kN',
  quality: 'GOOD',
  sourceTime: String(1790584618000000 + n),
  kind: 'ACTUAL',
});
const CHUNK = 512;

async function fill(j: ProcessJournal, n: number): Promise<void> {
  for (let i = 0; i < n; i += 50) {
    const batch = Array.from({ length: Math.min(50, n - i) }, (_, k) => reading(k % 2 === 0 ? 'PRESS-01' : 'PRESS-02', i + k));
    await j.append(SESSION, batch);
  }
}

describe('a large process journal at start', () => {
  it('[DI-28][DI-31] starts without reading the journal whole: every line is checked from a stream (lines across read boundaries), sequences go on, the undelivered ones are kept', async () => {
    const dir = tempDir();
    let j = await ProcessJournal.open({ dir, chunkBytes: CHUNK });
    await fill(j, 2000);
    await j.acknowledge(1500);
    await j.close();
    j = await ProcessJournal.open({ dir, chunkBytes: CHUNK });
    expect(j.count()).toBe(2000n);
    expect(j.delivered).toBe(1500n);
    expect(j.undelivered().length).toBe(500);
    expect(j.lastSequence('PRESS-01')).toBe(1000n);
    const [next] = await j.append(SESSION, [reading('PRESS-02', 1)]);
    expect(next?.sequence).toBe('1001');
    await j.close();
  });

  it('[DI-28][DI-31] a broken line or a gap in a device\'s sequence still refuses the start (fail closed)', async () => {
    const dir = tempDir();
    const j = await ProcessJournal.open({ dir, chunkBytes: CHUNK });
    await fill(j, 120);
    await j.close();
    const file = join(dir, 'process-journal.jsonl');
    const lines = readFileSyncLatin1(file).split('\n');
    writeFileSync(file, [...lines.slice(0, 60), ...lines.slice(62)].join('\n'), 'latin1');
    await expect(ProcessJournal.open({ dir, chunkBytes: CHUNK })).rejects.toThrow(/does not follow/);
    writeFileSync(file, `${lines.slice(0, 60).join('\n')}\n{"not":"a reading"}\n`, 'latin1');
    await expect(ProcessJournal.open({ dir, chunkBytes: CHUNK })).rejects.toThrow(/line 61 .* is not a process reading/);
  });

  it('[DI-28] an unterminated last line is set aside as evidence and cut off, found from the file\'s end only', async () => {
    const dir = tempDir();
    const alarms: string[] = [];
    let j = await ProcessJournal.open({ dir, chunkBytes: CHUNK });
    await fill(j, 200);
    await j.close();
    const partial = `{"sessionId":"${SESSION}","reading":{"deviceSerial":"PRESS-01","tag":"press.main_for`;
    appendFileSync(join(dir, 'process-journal.jsonl'), partial, 'latin1');
    j = await ProcessJournal.open({ dir, chunkBytes: CHUNK, onAlarm: (a) => alarms.push(a.kind) });
    expect(alarms).toEqual(['PARTIAL_LINE_QUARANTINED']);
    expect(readFileSyncLatin1(join(dir, 'process-journal.partial-1'))).toBe(partial);
    expect(j.count()).toBe(200n);
    expect(readFileSyncLatin1(join(dir, 'process-journal.jsonl')).endsWith('\n')).toBe(true);
    await j.close();
  });

  it('[DI-31] a delivered mark past the journal\'s end refuses the start', async () => {
    const dir = tempDir();
    const j = await ProcessJournal.open({ dir, chunkBytes: CHUNK });
    await fill(j, 10);
    await j.close();
    writeFileSync(join(dir, 'process-ack.json'), '{"delivered":"11"}\n');
    await expect(ProcessJournal.open({ dir, chunkBytes: CHUNK })).rejects.toThrow(ProcessJournalIntegrityError);
  });
});

describe('sealed segments of the process journal', () => {
  it('[DI-28][DI-31] once all is delivered the active file is sealed (never rewritten); a restart reads the checkpoint and the new active file, and each device\'s sequence goes on across the boundary', async () => {
    const dir = tempDir();
    let j = await ProcessJournal.open({ dir, chunkBytes: CHUNK, sealBytes: 1 });
    await fill(j, 300);
    await j.acknowledge(300);
    expect(existsSync(join(dir, 'process-journal.sealed-1-300.jsonl'))).toBe(true);
    const sealed = readFileSyncLatin1(join(dir, 'process-journal.sealed-1-300.jsonl'));
    await fill(j, 40);
    await j.close();
    expect(JSON.parse(readFileSync(join(dir, 'process-checkpoint.json'), 'utf8'))).toEqual({ lines: '300', lastSeq: { 'PRESS-01': '150', 'PRESS-02': '150' } });
    j = await ProcessJournal.open({ dir, chunkBytes: CHUNK, sealBytes: 1 });
    expect(j.count()).toBe(340n);
    expect(j.delivered).toBe(300n);
    expect(j.undelivered().map((e) => e.reading.sequence).slice(0, 2)).toEqual(['151', '151']);
    expect(j.lastSequence('PRESS-01')).toBe(170n);
    await j.acknowledge(40);
    expect(existsSync(join(dir, 'process-journal.sealed-301-340.jsonl'))).toBe(true);
    expect(readFileSyncLatin1(join(dir, 'process-journal.sealed-1-300.jsonl'))).toBe(sealed);
    await j.close();
    // A gap at the boundary (the active file not following the checkpoint) refuses the start.
    j = await ProcessJournal.open({ dir, chunkBytes: CHUNK });
    await fill(j, 4);
    await j.close();
    const file = join(dir, 'process-journal.jsonl');
    writeFileSync(file, readFileSyncLatin1(file).split('\n').slice(2).join('\n'), 'latin1');
    await expect(ProcessJournal.open({ dir, chunkBytes: CHUNK })).rejects.toThrow(/does not follow/);
  });

  it('[DI-28] a crash between sealing and the checkpoint is repaired at the next start by checking the segment; a checkpoint that does not match the segments refuses the start', async () => {
    const dir = tempDir();
    let j = await ProcessJournal.open({ dir, chunkBytes: CHUNK, sealBytes: 1 });
    await fill(j, 100);
    await j.acknowledge(100);
    await j.close();
    unlinkSync(join(dir, 'process-checkpoint.json'));
    j = await ProcessJournal.open({ dir, chunkBytes: CHUNK });
    expect(j.count()).toBe(100n);
    expect(j.lastSequence('PRESS-02')).toBe(50n);
    await j.close();
    expect(JSON.parse(readFileSync(join(dir, 'process-checkpoint.json'), 'utf8'))).toMatchObject({ lines: '100' });
    writeFileSync(join(dir, 'process-checkpoint.json'), '{"lines":"60","lastSeq":{}}\n');
    await expect(ProcessJournal.open({ dir, chunkBytes: CHUNK })).rejects.toThrow(ProcessJournalIntegrityError);
  });

  it('[DI-28][DI-31] a journal of one large file from before is sealed on its first start once delivered; nothing is lost and its lines are unchanged', async () => {
    const dir = tempDir();
    let j = await ProcessJournal.open({ dir, chunkBytes: CHUNK });
    await fill(j, 500);
    await j.acknowledge(500);
    await j.close();
    const before = readFileSyncLatin1(join(dir, 'process-journal.jsonl'));
    j = await ProcessJournal.open({ dir, chunkBytes: CHUNK, sealBytes: 1024 });
    expect(readdirSync(dir).filter((f) => f.includes('.sealed-'))).toEqual(['process-journal.sealed-1-500.jsonl']);
    expect(readFileSyncLatin1(join(dir, 'process-journal.sealed-1-500.jsonl'))).toBe(before);
    expect(readFileSyncLatin1(join(dir, 'process-journal.jsonl'))).toBe('');
    const [next] = await j.append(SESSION, [reading('PRESS-01', 1)]);
    expect(next?.sequence).toBe('251');
    expect(j.count()).toBe(501n);
    await j.close();
  });

  it('[DI-31] lines not yet delivered are never sealed', async () => {
    const dir = tempDir();
    const j = await ProcessJournal.open({ dir, chunkBytes: CHUNK, sealBytes: 1 });
    await fill(j, 50);
    await j.acknowledge(49);
    expect(readdirSync(dir).some((f) => f.includes('.sealed-'))).toBe(false);
    await j.close();
  });
});

describe('the scale and print journals stream too', () => {
  it('[DI-28] a print journal starts from a stream (each line checked, sequences go on)', async () => {
    const dir = tempDir();
    let j = await PrintJournal.open({ dir });
    for (let i = 0; i < 30; i += 1) await j.append(SESSION, [{ origin: null, event: { deviceSerial: 'PRN-0001', jobId: `J-${String(i)}`, kind: 'FAULT', value: 'JOB_VOIDED', sourceTime: '1790584618000000' } }]);
    await j.close();
    j = await PrintJournal.open({ dir });
    expect(j.count()).toBe(30n);
    await j.close();
  });

  it('[DI-28] a scale journal starts from a stream and verifies its chain as before', async () => {
    const keys = gatewayKeys();
    const privateKey = ed25519PrivateKey(keys.privateKeyPkcs8);
    const publicKey = ed25519PublicKey(keys.publicKeySpki);
    const chain = randomUUID();
    const build = (seq: bigint, prevHash: string): ScaleReading =>
      sealReading(
        { format: READING_FORMAT, readingId: randomUUID(), chainId: chain, gatewayCode: 'TEST-GW-01', deviceCode: 'TEST-BAL-01', serial: 'SIM-0001', seq: seq.toString(), value: '1.250', unit: 'kg', stable: true, status: 'OK', raw: 'S S      1.250 kg', sourceTimeUs: '1790584618000000', trust: 'DEVICE_UNSYNCED', installation: 'SANDBOX', purpose: 'GROSS', prevHash },
        privateKey,
      );
    const dir = tempDir();
    let j = await Journal.open({ dir, gatewayCode: 'TEST-GW-01', publicKey });
    await j.adoptServerChain(chain, { seq: '0', hash: genesisHash(chain) });
    for (let i = 0; i < 5; i += 1) await j.appendNext(build);
    await j.close();
    j = await Journal.open({ dir, gatewayCode: 'TEST-GW-01', publicKey });
    expect(j.lastSeq()).toBe(5n);
    await j.close();
  });
});

function readFileSyncLatin1(path: string): string {
  return readFileSync(path, 'latin1');
}
