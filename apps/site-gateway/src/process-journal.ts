/**
 * The gateway's process reading journal (Phase 3 slice 3a, G-06; DI-28 buffering, DI-31 acknowledgement and retry):
 * store and forward for the press and coater readings, beside the scale journal in the same directory.
 *
 *   <dir>/process-journal.jsonl            one line per reading: {"sessionId":..., "reading": ProcessReading}
 *   <dir>/process-ack.json                 {"delivered": "<n>"}: the first n lines are held by the server
 *   <dir>/process-journal.partial-<n>      a trailing partial line found at start (a crash mid-write), kept as evidence
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
import { mkdir, open, readFile, rename, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ProcessReading } from '@ebmr/integration-sdk/process';

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

const JOURNAL = 'process-journal.jsonl';
const ACK = 'process-ack.json';

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
}

export class ProcessJournal {
  /** Lines the server holds (the delivered mark), as written on disk. */
  deliveredOnDisk = 0n;
  /** Lines the server holds, as this process knows it (ahead of the disk while the mark cannot be written). */
  delivered = 0n;
  /** Why the journal takes no more readings in this process (null while none failed); cleared only by a restart. */
  writeFailure: string | null = null;
  private total = 0n;
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
    const file = join(this.options.dir, JOURNAL);
    let text = existsSync(file) ? await readFile(file, 'latin1') : '';
    const end = text.lastIndexOf('\n') + 1;
    if (end < text.length) {
      // An unterminated last line was never synced, answered or sent: set it aside as evidence, then cut it off.
      let n = 1;
      while (existsSync(join(this.options.dir, `process-journal.partial-${n}`))) n += 1;
      await writeFile(join(this.options.dir, `process-journal.partial-${n}`), text.slice(end), { encoding: 'latin1', mode: 0o600 });
      const fh = await open(file, 'r+');
      try {
        await fh.truncate(end);
        await fh.sync();
      } finally {
        await fh.close();
      }
      this.alarm({ kind: 'PARTIAL_LINE_QUARANTINED', message: `an unfinished process journal line was set aside as process-journal.partial-${n}`, details: { bytes: String(text.length - end) } });
      text = text.slice(0, end);
    }
    const ackFile = join(this.options.dir, ACK);
    const delivered = existsSync(ackFile) ? BigInt(AckFile.parse(JSON.parse(await readFile(ackFile, 'utf8'))).delivered) : 0n;
    const lines = text === '' ? [] : text.slice(0, -1).split('\n');
    lines.forEach((line, i) => {
      let entry: JournalEntry;
      try {
        entry = JournalEntry.parse(JSON.parse(line));
      } catch {
        throw new ProcessJournalIntegrityError(`line ${i + 1} of ${file} is not a process reading; the gateway refuses to start`);
      }
      const prev = this.lastSeq.get(entry.reading.deviceSerial) ?? 0n;
      const seq = BigInt(entry.reading.sequence);
      if (seq !== prev + 1n) {
        throw new ProcessJournalIntegrityError(`line ${i + 1} of ${file}: sequence ${entry.reading.sequence} of ${entry.reading.deviceSerial} does not follow ${prev.toString()}`);
      }
      this.lastSeq.set(entry.reading.deviceSerial, seq);
      if (BigInt(i) >= delivered) this.pendingEntries.push(entry);
    });
    this.total = BigInt(lines.length);
    if (delivered > this.total) throw new ProcessJournalIntegrityError(`${ackFile} marks ${delivered.toString()} lines delivered, the journal holds ${lines.length}`);
    this.delivered = delivered;
    this.deliveredOnDisk = delivered;
    this.fh = await open(file, 'a', 0o600);
    this.size = Buffer.byteLength(text, 'latin1');
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
    });
  }

  async close(): Promise<void> {
    await this.lock.catch(() => undefined);
    await this.fh?.close();
    this.fh = null;
  }
}
