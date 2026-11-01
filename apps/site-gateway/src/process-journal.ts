/**
 * The gateway's process reading journal (Phase 3 slice 3a, G-06; DI-28 buffering, DI-31 acknowledgement and retry):
 * store and forward for the press and coater readings, beside the scale journal in the same directory.
 *
 *   <dir>/process-journal.jsonl            one line per reading: {"sessionId":..., "reading": ProcessReading}
 *   <dir>/process-ack.json                 {"delivered": "<n>"}: the first n lines are held by the server
 *   <dir>/process-journal.partial-<n>      a trailing partial line found at start (a crash mid-write), kept as evidence
 *   <dir>/process-journal.sealed-<a>-<b>.jsonl  lines a to b, sealed once all were delivered (never rewritten or deleted)
 *   <dir>/process-checkpoint.json          {lines, lastSeq}: the lines in sealed segments and each device's last
 *                                          sequence in them, written atomically after each seal
 *
 * The active file holds the lines after the sealed ones; line numbers (and the delivered mark) count from the first
 * line ever written. Start reads the checkpoint and the active file only, streamed line by line (the hosted demo's
 * journal passed 2 GiB, the most one read can return; 1 November 2026). Once every line is delivered and the active
 * file is past `sealBytes`, it is renamed to its sealed segment, the checkpoint follows, and a new active file
 * starts; a crash between the rename and the checkpoint is repaired at the next start by checking the segment's
 * lines. A journal of one large file from before is sealed on its first start once delivered.
 *
 * A poll's readings are written in one append and synced before they exist for anyone (the uplink sends only what is
 * on disk). Each reading takes the next number of its device's sequence under the journal lock, so the sequence has
 * no gap and never repeats, across restarts too (the counters are rebuilt from the file at start). At start every line
 * is checked against the wire schema; a broken whole line refuses the start (fail closed); only an unterminated last
 * line is set aside, because it was never synced or sent. Nothing is ever rewritten or deleted.
 *
 * When an append's write or sync fails, its bytes are cut off again, the failure is alarmed, and the journal takes
 * nothing more until the gateway restarts (as the scale journal, review finding P52); what is on disk is still
 * delivered. When the delivered mark cannot be written, the mark is kept in memory (nothing is sent twice in this
 * process) and written with the next acknowledgement; after a restart the server sees the repeated readings as
 * duplicates by device and sequence.
 */
import { existsSync } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ProcessReading } from '@ebmr/integration-sdk/process';
import { forEachLine, READ_CHUNK_BYTES, setAsideTail } from './journal-file.ts';

export class ProcessJournalIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProcessJournalIntegrityError';
  }
}

export interface ProcessJournalAlarm {
  kind: 'PARTIAL_LINE_QUARANTINED' | 'WRITE_FAILED' | 'ACK_WRITE_FAILED';
  message: string;
  details: Record<string, string>;
}

export const JournalEntry = z.strictObject({ sessionId: z.uuid(), reading: ProcessReading });
export type JournalEntry = z.infer<typeof JournalEntry>;

const AckFile = z.strictObject({ delivered: z.string().regex(/^(0|[1-9][0-9]*)$/) });

const Checkpoint = z.strictObject({
  lines: z.string().regex(/^(0|[1-9][0-9]*)$/),
  lastSeq: z.record(z.string(), z.string().regex(/^(0|[1-9][0-9]*)$/)),
});

const JOURNAL = 'process-journal.jsonl';
const ACK = 'process-ack.json';
const CHECKPOINT = 'process-checkpoint.json';
const SEALED = /^process-journal\.sealed-([1-9][0-9]*)-([1-9][0-9]*)\.jsonl$/;
/** The active file is sealed past this size once all of it is delivered (about four hours of the demo's readings). */
const SEAL_BYTES = 64 * 1024 * 1024;

async function fsyncDir(dir: string): Promise<void> {
  const fh = await open(dir, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** Writes a small file atomically: temp file, fsync, rename, fsync of the directory. */
async function writeAtomic(dir: string, name: string, text: string): Promise<void> {
  const tmp = join(dir, `.${name}.tmp`);
  const fh = await open(tmp, 'w', 0o600);
  try {
    await fh.writeFile(text, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, join(dir, name));
  await fsyncDir(dir);
}

export interface ProcessJournalOptions {
  dir: string;
  onAlarm?: (alarm: ProcessJournalAlarm) => void;
  /** The active file's size from which it is sealed once delivered (tests set it low). */
  sealBytes?: number;
  /** Bytes read per step at start (a test seam). */
  chunkBytes?: number;
}

export class ProcessJournal {
  /** Lines the server holds (the delivered mark), as written on disk. */
  deliveredOnDisk = 0n;
  /** Lines the server holds, as this process knows it (ahead of the disk while the mark cannot be written). */
  delivered = 0n;
  /** Why the journal takes no more readings in this process (null while none failed); cleared only by a restart. */
  writeFailure: string | null = null;
  private total = 0n;
  /** Lines in sealed segments (the active file starts after them). */
  private sealed = 0n;
  /** The lines from `delivered` on, in order (what remains to send). */
  private pendingEntries: JournalEntry[] = [];
  private readonly lastSeq = new Map<string, bigint>();
  private fh: FileHandle | null = null;
  private size = 0;
  private lock: Promise<unknown> = Promise.resolve();

  private constructor(private readonly options: ProcessJournalOptions) {}

  static async open(options: ProcessJournalOptions): Promise<ProcessJournal> {
    await mkdir(options.dir, { recursive: true, mode: 0o700 });
    const j = new ProcessJournal(options);
    await j.load();
    return j;
  }

  private alarm(a: ProcessJournalAlarm): void {
    this.options.onAlarm?.(a);
  }

  private async load(): Promise<void> {
    const dir = this.options.dir;
    const file = join(dir, JOURNAL);
    const chunk = this.options.chunkBytes ?? READ_CHUNK_BYTES;
    const ackFile = join(dir, ACK);
    const delivered = existsSync(ackFile) ? BigInt(AckFile.parse(JSON.parse(await readFile(ackFile, 'utf8'))).delivered) : 0n;
    // The sealed lines and each device's last sequence in them.
    const cpFile = join(dir, CHECKPOINT);
    if (existsSync(cpFile)) {
      let cp: z.infer<typeof Checkpoint>;
      try {
        cp = Checkpoint.parse(JSON.parse(await readFile(cpFile, 'utf8')));
      } catch {
        throw new ProcessJournalIntegrityError(`${cpFile} is not a process journal checkpoint; the gateway refuses to start`);
      }
      this.sealed = BigInt(cp.lines);
      for (const [serial, seq] of Object.entries(cp.lastSeq)) this.lastSeq.set(serial, BigInt(seq));
    }
    const segments = (await readdir(dir))
      .map((name) => ({ name, m: SEALED.exec(name) }))
      .filter((x): x is { name: string; m: RegExpExecArray } => x.m !== null)
      .map((x) => ({ name: x.name, from: BigInt(x.m[1] ?? '0'), to: BigInt(x.m[2] ?? '0') }))
      .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
    let expected = 1n;
    for (const seg of segments) {
      if (seg.from !== expected || seg.to < seg.from) throw new ProcessJournalIntegrityError(`${seg.name} does not continue the sealed segments at line ${expected.toString()}`);
      expected = seg.to + 1n;
    }
    // A segment sealed after the checkpoint was written (a crash between the rename and the checkpoint): its lines are
    // checked as the active file's are, and the checkpoint is brought up to date.
    this.total = this.sealed;
    for (const seg of segments.filter((x) => x.from > this.sealed)) {
      if (seg.from !== this.sealed + 1n) throw new ProcessJournalIntegrityError(`${cpFile} ends inside ${seg.name}; the gateway refuses to start`);
      const n = await this.readLines(join(dir, seg.name), delivered, chunk);
      if (BigInt(n) !== seg.to - seg.from + 1n) throw new ProcessJournalIntegrityError(`${seg.name} holds ${n} lines, its name says ${(seg.to - seg.from + 1n).toString()}`);
      this.sealed = this.total;
      await this.writeCheckpoint();
    }
    if (this.sealed !== expected - 1n) throw new ProcessJournalIntegrityError(`${cpFile} counts ${this.sealed.toString()} sealed lines, the sealed segments hold ${(expected - 1n).toString()}`);
    const tail = await setAsideTail(file, join(dir, 'process-journal.partial'), chunk);
    if (tail.quarantined) {
      // An unterminated last line was never synced, answered or sent: set aside as evidence, then cut off.
      const name = tail.quarantined.file.slice(dir.length + 1);
      this.alarm({ kind: 'PARTIAL_LINE_QUARANTINED', message: `an unfinished process journal line was set aside as ${name}`, details: { bytes: String(tail.quarantined.bytes) } });
    }
    await this.readLines(file, delivered, chunk);
    if (delivered > this.total) throw new ProcessJournalIntegrityError(`${ackFile} marks ${delivered.toString()} lines delivered, the journal holds ${this.total.toString()}`);
    this.delivered = delivered;
    this.deliveredOnDisk = delivered;
    this.fh = await open(file, 'a', 0o600);
    this.size = (await this.fh.stat()).size;
    await this.sealIfDue();
  }

  /** Checks each line of `file` (schema, each device's sequence), counting on from `total`; returns its line count. */
  private async readLines(file: string, delivered: bigint, chunk: number): Promise<number> {
    const first = this.total;
    const n = await forEachLine(
      file,
      (line, i) => {
        const at = first + BigInt(i) + 1n;
        let entry: JournalEntry;
        try {
          entry = JournalEntry.parse(JSON.parse(line));
        } catch {
          throw new ProcessJournalIntegrityError(`line ${at.toString()} of the process journal (${file}) is not a process reading; the gateway refuses to start`);
        }
        const prev = this.lastSeq.get(entry.reading.deviceSerial) ?? 0n;
        const seq = BigInt(entry.reading.sequence);
        if (seq !== prev + 1n) {
          throw new ProcessJournalIntegrityError(`line ${at.toString()} of the process journal (${file}): sequence ${entry.reading.sequence} of ${entry.reading.deviceSerial} does not follow ${prev.toString()}`);
        }
        this.lastSeq.set(entry.reading.deviceSerial, seq);
        if (at > delivered) this.pendingEntries.push(entry);
      },
      chunk,
    );
    this.total += BigInt(n);
    return n;
  }

  private async writeCheckpoint(): Promise<void> {
    const lastSeq = Object.fromEntries([...this.lastSeq].map(([serial, seq]) => [serial, seq.toString()]));
    await writeAtomic(this.options.dir, CHECKPOINT, `${JSON.stringify({ lines: this.sealed.toString(), lastSeq })}\n`);
  }

  /**
   * Seals the active file when every line is delivered and it is past `sealBytes`: renamed to its segment (never
   * changed again), the checkpoint written, a new active file opened. A failure leaves the journal as it was (the
   * active file still open) and is tried again after the next acknowledgement.
   */
  private async sealIfDue(): Promise<void> {
    if (this.writeFailure !== null || this.delivered !== this.total || this.total === this.sealed || this.size < (this.options.sealBytes ?? SEAL_BYTES)) return;
    const dir = this.options.dir;
    const name = `process-journal.sealed-${(this.sealed + 1n).toString()}-${this.total.toString()}.jsonl`;
    await this.fh?.close();
    this.fh = null;
    try {
      await rename(join(dir, JOURNAL), join(dir, name));
      await fsyncDir(dir);
      this.sealed = this.total;
      await this.writeCheckpoint();
    } finally {
      this.fh = await open(join(dir, JOURNAL), 'a', 0o600);
      this.size = (await this.fh.stat()).size;
    }
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  /** The last sequence number journalled for a device (0 when none). */
  lastSequence(deviceSerial: string): bigint {
    return this.lastSeq.get(deviceSerial) ?? 0n;
  }

  /** Lines journalled in all. */
  count(): bigint {
    return this.total;
  }

  /** Readings not yet held by the server, oldest first, at most `max`. */
  undelivered(max = Number.MAX_SAFE_INTEGER): JournalEntry[] {
    return this.pendingEntries.slice(0, max);
  }

  /**
   * Appends readings (each numbered with the next sequence of its device, under the lock) in one write and syncs it.
   * Resolves with the readings as journalled; rejects when nothing was journalled (and the journal then stops).
   */
  append(sessionId: string, readings: Omit<ProcessReading, 'sequence'>[]): Promise<ProcessReading[]> {
    return this.exclusive(async () => {
      const fh = this.fh;
      if (!fh) throw new Error('the process journal is closed');
      if (this.writeFailure !== null) throw new Error(`the process journal stopped after a failed write (${this.writeFailure}); the gateway must restart`);
      if (readings.length === 0) return [];
      const next = new Map<string, bigint>();
      const entries: JournalEntry[] = readings.map((r) => {
        const seq = (next.get(r.deviceSerial) ?? this.lastSequence(r.deviceSerial)) + 1n;
        next.set(r.deviceSerial, seq);
        return JournalEntry.parse({ sessionId, reading: { ...r, sequence: seq.toString() } });
      });
      const line = Buffer.from(entries.map((e) => `${JSON.stringify(e)}\n`).join(''), 'latin1');
      try {
        for (let done = 0; done < line.length; ) {
          const { bytesWritten } = await fh.write(line, done, line.length - done, null);
          if (bytesWritten <= 0) throw new Error(`the file system took no bytes after ${done} of ${line.length}`);
          done += bytesWritten;
        }
        await fh.datasync();
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error);
        this.writeFailure = cause;
        let cutBack = 'cut back to its last whole line';
        try {
          await fh.truncate(this.size);
          await fh.sync();
        } catch (cut) {
          cutBack = `not cut back (${cut instanceof Error ? cut.message : String(cut)}); the partial line is set aside at the next start`;
        }
        this.alarm({
          kind: 'WRITE_FAILED',
          message: `${entries.length} process readings could not be journalled (${cause}); none was sent; the file was ${cutBack}; process readings stop until the gateway restarts`,
          details: { error: cause, keptBytes: String(this.size) },
        });
        throw new Error(`process readings were not journalled: ${cause}`, { cause: error });
      }
      this.size += line.length;
      this.total += BigInt(entries.length);
      for (const [serial, seq] of next) this.lastSeq.set(serial, seq);
      this.pendingEntries.push(...entries);
      return entries.map((e) => e.reading);
    });
  }

  /** The server holds the next `n` undelivered readings: the mark moves on (in memory at once, on disk when it can). */
  acknowledge(n: number): Promise<void> {
    return this.exclusive(async () => {
      const take = Math.min(n, this.pendingEntries.length);
      this.pendingEntries.splice(0, take);
      this.delivered += BigInt(take);
      try {
        await writeAtomic(this.options.dir, ACK, `${JSON.stringify({ delivered: this.delivered.toString() })}\n`);
        this.deliveredOnDisk = this.delivered;
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error);
        this.alarm({ kind: 'ACK_WRITE_FAILED', message: `the delivered mark of the process journal could not be written (${cause}); it is kept in memory`, details: { delivered: this.delivered.toString(), onDisk: this.deliveredOnDisk.toString() } });
      }
      // Sealing needs the mark on disk: a restart must never count sealed lines as undelivered.
      if (this.deliveredOnDisk === this.delivered) {
        try {
          await this.sealIfDue();
        } catch {
          // Tried again after the next acknowledgement; the journal goes on in its active file.
        }
      }
    });
  }

  async close(): Promise<void> {
    await this.lock.catch(() => undefined);
    await this.fh?.close();
    this.fh = null;
  }
}
