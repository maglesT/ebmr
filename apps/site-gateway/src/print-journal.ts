/**
 * The gateway's print event journal (Phase 3 slice 4a, G-21; DI-28 buffering, DI-31 acknowledgement and retry): store
 * and forward for the printers' events, beside the scale and process journals in the same directory.
 *
 *   <dir>/print-journal.jsonl            one line per event: {"sessionId":..., "origin":..., "event": PrintEvent}
 *   <dir>/print-ack.json                 {"delivered": "<n>"}: the first n lines are held by the server
 *   <dir>/print-journal.partial-<n>      a trailing partial line found at start (a crash mid-write), kept as evidence
 *
 * The same rules as the print journal: a poll's events are written in one append and synced before they exist for
 * anyone; each event takes the next number of its printer's sequence under the journal lock (no gap, never repeated,
 * across restarts too); a broken whole line refuses the start; only an unterminated last line is set aside; nothing
 * is rewritten or deleted; a failed append stops the journal until a restart.
 *
 * `origin` is where the event came from on the printer: its boot and event number (null for an event the gateway
 * made itself: a printed count, or a fault it saw). At start the last origin of each printer is rebuilt from the
 * file, so after a restart the gateway asks the printer only for the events after it: none is taken twice.
 */
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rename, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { PrintEvent } from '@ebmr/integration-sdk/printer';
import { forEachLine, setAsideTail } from './journal-file.ts';

export class PrintJournalIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrintJournalIntegrityError';
  }
}

export interface PrintJournalAlarm {
  kind: 'PARTIAL_LINE_QUARANTINED' | 'WRITE_FAILED' | 'ACK_WRITE_FAILED';
  message: string;
  details: Record<string, string>;
}

export const PrintOrigin = z.strictObject({ boot: z.string().regex(/^(0|[1-9][0-9]{0,17})$/), no: z.string().regex(/^[1-9][0-9]{0,17}$/) });
export type PrintOrigin = z.infer<typeof PrintOrigin>;
export const PrintJournalEntry = z.strictObject({ sessionId: z.uuid(), origin: PrintOrigin.nullable(), event: PrintEvent });
export type PrintJournalEntry = z.infer<typeof PrintJournalEntry>;
/** An event to journal: its sequence is given by the journal. */
export interface PrintJournalInput {
  origin: PrintOrigin | null;
  event: Omit<PrintEvent, 'sequence'>;
}

const AckFile = z.strictObject({ delivered: z.string().regex(/^(0|[1-9][0-9]*)$/) });

const JOURNAL = 'print-journal.jsonl';
const ACK = 'print-ack.json';

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

export interface PrintJournalOptions {
  dir: string;
  onAlarm?: (alarm: PrintJournalAlarm) => void;
}

export class PrintJournal {
  /** Lines the server holds (the delivered mark), as written on disk. */
  deliveredOnDisk = 0n;
  /** Lines the server holds, as this process knows it (ahead of the disk while the mark cannot be written). */
  delivered = 0n;
  /** Why the journal takes no more events in this process (null while none failed); cleared only by a restart. */
  writeFailure: string | null = null;
  private total = 0n;
  /** The lines from `delivered` on, in order (what remains to send). */
  private pendingEntries: PrintJournalEntry[] = [];
  private readonly lastSeq = new Map<string, bigint>();
  private readonly lastOrigins = new Map<string, PrintOrigin>();
  private readonly lastPrinted = new Map<string, { jobId: string | null; value: string }>();
  private fh: FileHandle | null = null;
  private size = 0;
  private lock: Promise<unknown> = Promise.resolve();

  private constructor(private readonly options: PrintJournalOptions) {}

  static async open(options: PrintJournalOptions): Promise<PrintJournal> {
    await mkdir(options.dir, { recursive: true, mode: 0o700 });
    const j = new PrintJournal(options);
    await j.load();
    return j;
  }

  private alarm(a: PrintJournalAlarm): void {
    this.options.onAlarm?.(a);
  }

  private async load(): Promise<void> {
    const file = join(this.options.dir, JOURNAL);
    // Streamed, never read whole: a journal can pass the 2 GiB one read returns (the hosted demo, 1 November 2026).
    const tail = await setAsideTail(file, join(this.options.dir, 'print-journal.partial'));
    if (tail.quarantined) {
      // An unterminated last line was never synced, answered or sent: set aside as evidence, then cut off.
      const name = tail.quarantined.file.slice(this.options.dir.length + 1);
      this.alarm({ kind: 'PARTIAL_LINE_QUARANTINED', message: `an unfinished print journal line was set aside as ${name}`, details: { bytes: String(tail.quarantined.bytes) } });
    }
    const ackFile = join(this.options.dir, ACK);
    const delivered = existsSync(ackFile) ? BigInt(AckFile.parse(JSON.parse(await readFile(ackFile, 'utf8'))).delivered) : 0n;
    const lines = await forEachLine(file, (line, i) => {
      let entry: PrintJournalEntry;
      try {
        entry = PrintJournalEntry.parse(JSON.parse(line));
      } catch {
        throw new PrintJournalIntegrityError(`line ${i + 1} of ${file} is not a print event; the gateway refuses to start`);
      }
      const prev = this.lastSeq.get(entry.event.deviceSerial) ?? 0n;
      const seq = BigInt(entry.event.sequence);
      if (seq !== prev + 1n) {
        throw new PrintJournalIntegrityError(`line ${i + 1} of ${file}: sequence ${entry.event.sequence} of ${entry.event.deviceSerial} does not follow ${prev.toString()}`);
      }
      this.lastSeq.set(entry.event.deviceSerial, seq);
      this.noteEntry(entry);
      if (BigInt(i) >= delivered) this.pendingEntries.push(entry);
    });
    this.total = BigInt(lines);
    if (delivered > this.total) throw new PrintJournalIntegrityError(`${ackFile} marks ${delivered.toString()} lines delivered, the journal holds ${lines}`);
    this.delivered = delivered;
    this.deliveredOnDisk = delivered;
    this.fh = await open(file, 'a', 0o600);
    this.size = (await this.fh.stat()).size;
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

  private noteEntry(e: PrintJournalEntry): void {
    if (e.origin) this.lastOrigins.set(e.event.deviceSerial, e.origin);
    if (e.event.kind === 'PRINTED_COUNT') this.lastPrinted.set(e.event.deviceSerial, { jobId: e.event.jobId, value: e.event.value });
  }

  /** The printer's last event journalled (boot and number), or null when none. */
  lastOrigin(deviceSerial: string): PrintOrigin | null {
    return this.lastOrigins.get(deviceSerial) ?? null;
  }

  /** The last printed count journalled for a printer (its job and value), or null when none. */
  lastPrintedCount(deviceSerial: string): { jobId: string | null; value: string } | null {
    return this.lastPrinted.get(deviceSerial) ?? null;
  }

  /** Lines journalled in all. */
  count(): bigint {
    return this.total;
  }

  /** Events not yet held by the server, oldest first, at most `max`. */
  undelivered(max = Number.MAX_SAFE_INTEGER): PrintJournalEntry[] {
    return this.pendingEntries.slice(0, max);
  }

  /**
   * Appends events (each numbered with the next sequence of its device, under the lock) in one write and syncs it.
   * Resolves with the events as journalled; rejects when nothing was journalled (and the journal then stops).
   */
  append(sessionId: string, inputs: PrintJournalInput[]): Promise<PrintEvent[]> {
    return this.exclusive(async () => {
      const fh = this.fh;
      if (!fh) throw new Error('the print journal is closed');
      if (this.writeFailure !== null) throw new Error(`the print journal stopped after a failed write (${this.writeFailure}); the gateway must restart`);
      if (inputs.length === 0) return [];
      const next = new Map<string, bigint>();
      const entries: PrintJournalEntry[] = inputs.map((r) => {
        const seq = (next.get(r.event.deviceSerial) ?? this.lastSequence(r.event.deviceSerial)) + 1n;
        next.set(r.event.deviceSerial, seq);
        return PrintJournalEntry.parse({ sessionId, origin: r.origin, event: { ...r.event, sequence: seq.toString() } });
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
          message: `${entries.length} print events could not be journalled (${cause}); none was sent; the file was ${cutBack}; print events stop until the gateway restarts`,
          details: { error: cause, keptBytes: String(this.size) },
        });
        throw new Error(`print events were not journalled: ${cause}`, { cause: error });
      }
      this.size += line.length;
      this.total += BigInt(entries.length);
      for (const [serial, seq] of next) this.lastSeq.set(serial, seq);
      this.pendingEntries.push(...entries);
      for (const e of entries) this.noteEntry(e);
      return entries.map((e) => e.event);
    });
  }

  /** The server holds the next `n` undelivered events: the mark moves on (in memory at once, on disk when it can). */
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
        this.alarm({ kind: 'ACK_WRITE_FAILED', message: `the delivered mark of the print journal could not be written (${cause}); it is kept in memory`, details: { delivered: this.delivered.toString(), onDisk: this.deliveredOnDisk.toString() } });
      }
    });
  }

  async close(): Promise<void> {
    await this.lock.catch(() => undefined);
    await this.fh?.close();
    this.fh = null;
  }
}
