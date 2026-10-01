/**
 * The gateway's reading journal (DI-28 buffering, DI-31): an append-only JSONL file per chain, each line a sealed
 * reading linked to the previous one by hash, written and fsync'd before the capture is answered or the reading is
 * uploaded; an acknowledgement watermark (the last reading the server confirmed) written atomically.
 *
 *   <dir>/chain.json               the current chain (the gateway's enrolment on its server)
 *   <dir>/journal-<chain>.jsonl    the readings of that chain, in sequence
 *   <dir>/ack-<chain>.json         {seq, hash} of the last reading the server acknowledged
 *   <dir>/journal-<chain>.partial-<n>  a trailing partial line found at start (a crash mid-write), kept as evidence
 *
 * At start the whole chain is verified: schema, sequence, hash links from the genesis link, the hash of each
 * reading and its Ed25519 signature with the gateway's own key. Any break refuses the start (fail closed); only an
 * unterminated last line is set aside, because it was never fsync'd, answered or uploaded.
 * Nothing is ever deleted or rewritten; a new chain (a new enrolment on the server) starts a new file.
 *
 * An append writes the whole line (a short write, as on a nearly full disk, is continued) and syncs it before the
 * reading exists for anyone. When a write or the sync fails, the bytes of that line are cut off again (the file
 * ends at its last whole line), the failure is alarmed, and the journal takes nothing more until the gateway
 * restarts and verifies the file from disk: the file system's state after a failed write or sync is not trusted
 * (review finding P52).
 *
 * Appends and watermark changes take one lock, in the order asked for. A login's adoption of the server's chain and
 * head is the only change that may switch the chain. Every other watermark change (an acknowledgement, a
 * reconciliation) names the basis it was asked on and is dropped as STALE, under the lock, when the chain is another
 * one or a login's adoption was asked for since: what the server said before a login never overtakes the login's
 * head, even when it waited behind a hung write (decision X33).
 */
import type { KeyObject } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rename, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ScaleReading, genesisHash, readingProblem } from '@ebmr/integration-sdk/scale';

export class JournalIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JournalIntegrityError';
  }
}

export interface JournalAlarm {
  kind: 'PARTIAL_LINE_QUARANTINED' | 'CHAIN_SWITCHED' | 'DIVERGED' | 'WRITE_FAILED';
  message: string;
  details: Record<string, string>;
}

export interface JournalOptions {
  dir: string;
  gatewayCode: string;
  publicKey: KeyObject;
  onAlarm?: (alarm: JournalAlarm) => void;
}

const ChainFile = z.object({ chainId: z.uuid(), gatewayCode: z.string() });
const AckFile = z.object({ seq: z.string().regex(/^(0|[1-9][0-9]*)$/), hash: z.string().regex(/^[0-9a-f]{64}$/) });

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

export type AdoptOutcome = 'CONTINUE' | 'NEW_CHAIN' | 'DIVERGED';

/**
 * What a watermark change the uplink asks for rests on (Journal.basis, taken when the server was asked): the chain,
 * and how many adoptions of the server's head a login had asked for by then. The change is stale, and nothing is
 * done, when the journal's basis has moved on when the change's turn comes under the journal lock: a login's adoption
 * was asked for since (its head is newer than what the change records) or the chain is another one.
 */
export interface WatermarkBasis {
  readonly chainId: string;
  readonly adoptions: number;
}

export class Journal {
  chainId: string | null = null;
  ackedSeq = 0n;
  /** Adoptions of the server's chain and head asked for (adoptServerChain), counted when asked for (WatermarkBasis). */
  private adoptions = 0;
  /**
   * Why the journal takes no more readings in this process: an append whose write or sync failed (null while
   * none did). It is cleared only by a restart, which verifies the file from disk.
   */
  writeFailure: string | null = null;
  /** True after the server's head was found outside this journal (re-enrolment needed). */
  private diverged = false;
  private readings: ScaleReading[] = [];
  private fh: FileHandle | null = null;
  /** Bytes of the current file that hold whole, synced lines (where a failed append is cut back to). */
  private size = 0;
  private lock: Promise<unknown> = Promise.resolve();

  /** False when nothing may be captured: the journal diverged from the server, or a write failed. */
  get usable(): boolean {
    return !this.diverged && this.writeFailure === null;
  }

  /**
   * True when the readings already journalled may be uploaded: there is a chain and it has not diverged from the
   * server. A failed append does not stop this: every reading in memory was written whole and synced before it,
   * and the failed one never became a reading (review finding P52).
   */
  get uploadable(): boolean {
    return this.chainId !== null && !this.diverged;
  }

  private constructor(private readonly options: JournalOptions) {}

  static async open(options: JournalOptions): Promise<Journal> {
    await mkdir(options.dir, { recursive: true, mode: 0o700 });
    const j = new Journal(options);
    const chainFile = join(options.dir, 'chain.json');
    if (existsSync(chainFile)) {
      const chain = ChainFile.parse(JSON.parse(await readFile(chainFile, 'utf8')));
      if (chain.gatewayCode !== options.gatewayCode) {
        throw new JournalIntegrityError(`the journal in ${options.dir} belongs to gateway ${chain.gatewayCode}, not ${options.gatewayCode}`);
      }
      await j.load(chain.chainId);
    }
    return j;
  }

  private file(chainId: string): string {
    return join(this.options.dir, `journal-${chainId}.jsonl`);
  }

  private alarm(a: JournalAlarm): void {
    this.options.onAlarm?.(a);
  }

  /** Loads and verifies one chain's journal and watermark; sets it current. */
  private async load(chainId: string): Promise<void> {
    await this.fh?.close();
    this.fh = null;
    const path = this.file(chainId);
    let text = existsSync(path) ? await readFile(path, 'latin1') : '';
    if (text.length > 0 && !text.endsWith('\n')) {
      const cut = text.lastIndexOf('\n') + 1;
      const partial = text.slice(cut);
      let n = 1;
      while (existsSync(`${path}.partial-${n}`)) n += 1;
      await writeFile(`${path}.partial-${n}`, partial, { encoding: 'latin1', mode: 0o600 });
      const fh = await open(path, 'r+');
      try {
        await fh.truncate(cut);
        await fh.sync();
      } finally {
        await fh.close();
      }
      await fsyncDir(this.options.dir);
      text = text.slice(0, cut);
      this.alarm({
        kind: 'PARTIAL_LINE_QUARANTINED',
        message: 'an unterminated last journal line (a crash while writing, never answered or uploaded) was set aside',
        details: { file: `${path}.partial-${n}`, bytes: String(partial.length) },
      });
    }
    const readings: ScaleReading[] = [];
    let prev = genesisHash(chainId);
    const lines = text === '' ? [] : text.slice(0, -1).split('\n');
    for (const [i, line] of lines.entries()) {
      let candidate: unknown;
      try {
        candidate = JSON.parse(line);
      } catch {
        throw new JournalIntegrityError(`journal line ${i + 1} is not JSON`);
      }
      const problem = readingProblem(candidate, this.options.publicKey);
      if (problem) throw new JournalIntegrityError(`journal line ${i + 1}: ${problem.problem} (${problem.detail})`);
      const r = ScaleReading.parse(candidate);
      if (r.chainId !== chainId || r.gatewayCode !== this.options.gatewayCode) throw new JournalIntegrityError(`journal line ${i + 1} belongs to another chain or gateway`);
      if (r.seq !== String(i + 1)) throw new JournalIntegrityError(`journal line ${i + 1} carries sequence ${r.seq}`);
      if (r.prevHash !== prev) throw new JournalIntegrityError(`journal line ${i + 1} does not link to the reading before it`);
      prev = r.hash;
      readings.push(r);
    }
    let acked = 0n;
    const ackPath = join(this.options.dir, `ack-${chainId}.json`);
    if (existsSync(ackPath)) {
      const ack = AckFile.parse(JSON.parse(await readFile(ackPath, 'utf8')));
      acked = BigInt(ack.seq);
      const expected = acked === 0n ? genesisHash(chainId) : readings[Number(acked) - 1]?.hash;
      if (acked > BigInt(readings.length) || expected !== ack.hash) throw new JournalIntegrityError(`the acknowledgement watermark ${ack.seq} does not match the journal`);
    }
    this.chainId = chainId;
    this.readings = readings;
    this.ackedSeq = acked;
    this.fh = await open(path, 'a', 0o600);
    this.size = (await this.fh.stat()).size;
    await fsyncDir(this.options.dir);
  }

  /** The chain's head: the last reading, or the genesis link. */
  head(): { seq: bigint; hash: string } {
    if (!this.chainId) throw new Error('the journal has no chain yet');
    const last = this.readings.at(-1);
    return last ? { seq: BigInt(last.seq), hash: last.hash } : { seq: 0n, hash: genesisHash(this.chainId) };
  }

  lastSeq(): bigint {
    return BigInt(this.readings.length);
  }

  /** Readings the server has not acknowledged, in order. */
  pending(): ScaleReading[] {
    return this.readings.slice(Number(this.ackedSeq));
  }

  all(): readonly ScaleReading[] {
    return this.readings;
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.lock.then(work, work);
    this.lock = run.catch(() => undefined);
    return run;
  }

  /** The basis of a watermark change asked for on what the server says from now on (null while there is no chain). */
  basis(): WatermarkBasis | null {
    return this.chainId === null ? null : { chainId: this.chainId, adoptions: this.adoptions };
  }

  /**
   * Whether `basis` is still the journal's: the same chain, and no login's adoption asked for since. Once false it stays
   * false (the count only grows, and only an adoption switches the chain). The uplink uses it to drop an answer that
   * arrives after a login's adoption was asked for; acknowledge and reconcile check it again under the journal lock.
   */
  isCurrent(basis: WatermarkBasis): boolean {
    return basis.chainId === this.chainId && basis.adoptions === this.adoptions;
  }

  /**
   * At login: the server names the chain (its enrolment) and its head. The same chain continues when the server's
   * head is a reading of this journal (the watermark moves to it; later readings are re-sent). A new chain id starts
   * a new journal file (the old one stays on disk). A server head that is not in this journal means the two
   * diverged: nothing is captured or uploaded until the gateway is re-enrolled. Counted when asked for: a watermark
   * change asked for on what the server said before this is stale from now on (WatermarkBasis), also when it waits
   * behind this adoption for the journal lock.
   */
  adoptServerChain(chainId: string, serverHead: { seq: string; hash: string }): Promise<AdoptOutcome> {
    this.adoptions += 1;
    return this.exclusive(async () => {
      let outcome: AdoptOutcome = 'CONTINUE';
      if (this.chainId !== chainId) {
        if (this.chainId !== null && this.pending().length > 0) {
          this.alarm({
            kind: 'CHAIN_SWITCHED',
            message: `the server enrolled this gateway anew (chain ${chainId}); ${this.pending().length} unacknowledged readings of chain ${this.chainId} stay in its journal file and are not uploaded`,
            details: { oldChain: this.chainId, newChain: chainId, pending: String(this.pending().length) },
          });
        }
        await writeAtomic(this.options.dir, 'chain.json', `${JSON.stringify({ chainId, gatewayCode: this.options.gatewayCode })}\n`);
        await this.load(chainId);
        outcome = 'NEW_CHAIN';
      }
      return (await this.moveToServerHead(serverHead)) ?? outcome;
    });
  }

  /**
   * The server holds fewer readings of the chain than it acknowledged (the uplink's reconciliation by counts, DI-31):
   * the watermark moves back to the server's head when that is a reading of this journal; otherwise the two diverged,
   * as at adoptServerChain. Never changes the chain. 'STALE', with nothing done, when `basis` is no longer the
   * journal's by the time the journal lock is taken (a login adopted the server's head since, or another chain).
   */
  reconcile(basis: WatermarkBasis, serverHead: { seq: string; hash: string }): Promise<'CONTINUE' | 'DIVERGED' | 'STALE'> {
    return this.exclusive(async () => {
      if (!this.isCurrent(basis)) return 'STALE';
      return (await this.moveToServerHead(serverHead)) ?? 'CONTINUE';
    });
  }

  /** Under the lock: the watermark moves to the server's head of the current chain; 'DIVERGED' when it is not ours. */
  private async moveToServerHead(serverHead: { seq: string; hash: string }): Promise<'DIVERGED' | null> {
    const chainId = this.chainId;
    if (chainId === null) throw new Error('the journal has no chain yet');
    const s = BigInt(serverHead.seq);
    const ours = s === 0n ? genesisHash(chainId) : this.readings[Number(s) - 1]?.hash;
    if (s > this.lastSeq() || ours !== serverHead.hash) {
      this.diverged = true;
      this.alarm({
        kind: 'DIVERGED',
        message: `the server holds reading ${serverHead.seq} of chain ${chainId}, which this journal does not have; captures and uploads stop until the gateway is re-enrolled`,
        details: { serverSeq: serverHead.seq, journalSeq: this.lastSeq().toString() },
      });
      return 'DIVERGED';
    }
    this.diverged = false;
    await this.writeAck(s, serverHead.hash);
    return null;
  }

  /**
   * Seals and appends the next reading of the chain under the journal lock: `build` gets the sequence number and
   * the link, and returns the sealed reading. Resolves once the whole line is written and fsync'd; rejects, with
   * nothing of the line left in the file, when a write or the sync fails (the journal then stops, see above).
   */
  appendNext(build: (seq: bigint, prevHash: string) => ScaleReading): Promise<ScaleReading> {
    return this.exclusive(async () => {
      const fh = this.fh;
      if (!this.chainId || !fh) throw new Error('the journal has no chain yet');
      if (this.writeFailure !== null) throw new Error(`the journal stopped after a failed write (${this.writeFailure}); the gateway must restart`);
      if (this.diverged) throw new Error('the journal diverged from the server; re-enrolment is needed');
      const head = this.head();
      const reading = build(head.seq + 1n, head.hash);
      if (reading.seq !== (head.seq + 1n).toString() || reading.prevHash !== head.hash || reading.chainId !== this.chainId) {
        throw new Error('the reading does not continue the chain');
      }
      const line = Buffer.from(`${JSON.stringify(reading)}\n`, 'latin1');
      try {
        // One write call may write only part of the line (a nearly full disk): continue until all of it is written.
        for (let done = 0; done < line.length; ) {
          const { bytesWritten } = await fh.write(line, done, line.length - done, null);
          if (bytesWritten <= 0) throw new Error(`the file system took no bytes after ${done} of ${line.length}`);
          done += bytesWritten;
        }
        await fh.datasync();
      } catch (error) {
        await this.stopAfterFailedWrite(fh, reading.seq, error);
        throw new Error(`reading ${reading.seq} was not journalled: ${this.writeFailure ?? 'write failed'}`, { cause: error });
      }
      this.size += line.length;
      this.readings.push(reading);
      return reading;
    });
  }

  /** A failed append: cut the file back to its last whole line, stop the journal and alarm (review finding P52). */
  private async stopAfterFailedWrite(fh: FileHandle, seq: string, error: unknown): Promise<void> {
    const cause = error instanceof Error ? error.message : String(error);
    this.writeFailure = `reading ${seq}: ${cause}`;
    let cutBack = 'the file was cut back to its last whole line';
    try {
      await fh.truncate(this.size);
      await fh.sync();
    } catch (cut) {
      cutBack = `the file could not be cut back to its last whole line (${cut instanceof Error ? cut.message : String(cut)}); the partial line is set aside at the next start`;
    }
    this.alarm({
      kind: 'WRITE_FAILED',
      message: `reading ${seq} could not be written to the journal (${cause}); nothing was answered or uploaded for it; ${cutBack}; captures stop until the gateway restarts`,
      details: { seq, error: cause, keptBytes: String(this.size) },
    });
  }

  /**
   * The server acknowledged every reading up to `seq` (its hash must be ours). 'STALE', with nothing written, when
   * `basis` is no longer the journal's by the time the journal lock is taken (a login adopted the server's head since,
   * or another chain): the adoption's head stands.
   */
  acknowledge(basis: WatermarkBasis, seq: bigint, hash: string): Promise<'ACKNOWLEDGED' | 'STALE'> {
    return this.exclusive(async () => {
      if (!this.isCurrent(basis)) return 'STALE';
      if (seq <= this.ackedSeq) return 'ACKNOWLEDGED';
      const ours = this.readings[Number(seq) - 1]?.hash;
      if (ours !== hash) throw new JournalIntegrityError(`the server acknowledged reading ${seq} with a hash this journal does not hold`);
      await this.writeAck(seq, hash);
      return 'ACKNOWLEDGED';
    });
  }

  private async writeAck(seq: bigint, hash: string): Promise<void> {
    if (!this.chainId) return;
    await writeAtomic(this.options.dir, `ack-${this.chainId}.json`, `${JSON.stringify({ seq: seq.toString(), hash })}\n`);
    this.ackedSeq = seq;
  }

  async close(): Promise<void> {
    await this.lock.catch(() => undefined);
    await this.fh?.close();
    this.fh = null;
  }
}
