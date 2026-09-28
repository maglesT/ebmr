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
  kind: 'PARTIAL_LINE_QUARANTINED' | 'CHAIN_SWITCHED' | 'DIVERGED';
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

export class Journal {
  chainId: string | null = null;
  ackedSeq = 0n;
  /** False after the server's head was found outside this journal: no capture, no upload (re-enrolment needed). */
  usable = true;
  private readings: ScaleReading[] = [];
  private fh: FileHandle | null = null;
  private lock: Promise<unknown> = Promise.resolve();

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

  /**
   * At login: the server names the chain (its enrolment) and its head. The same chain continues when the server's
   * head is a reading of this journal (the watermark moves to it; later readings are re-sent). A new chain id starts
   * a new journal file (the old one stays on disk). A server head that is not in this journal means the two
   * diverged: nothing is captured or uploaded until the gateway is re-enrolled.
   */
  adoptServerChain(chainId: string, serverHead: { seq: string; hash: string }): Promise<AdoptOutcome> {
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
      const s = BigInt(serverHead.seq);
      const ours = s === 0n ? genesisHash(chainId) : this.readings[Number(s) - 1]?.hash;
      if (s > this.lastSeq() || ours !== serverHead.hash) {
        this.usable = false;
        this.alarm({
          kind: 'DIVERGED',
          message: `the server holds reading ${serverHead.seq} of chain ${chainId}, which this journal does not have; captures and uploads stop until the gateway is re-enrolled`,
          details: { serverSeq: serverHead.seq, journalSeq: this.lastSeq().toString() },
        });
        return 'DIVERGED';
      }
      this.usable = true;
      await this.writeAck(s, serverHead.hash);
      return outcome;
    });
  }

  /**
   * Seals and appends the next reading of the chain under the journal lock: `build` gets the sequence number and
   * the link, and returns the sealed reading. Resolves once the line is fsync'd.
   */
  appendNext(build: (seq: bigint, prevHash: string) => ScaleReading): Promise<ScaleReading> {
    return this.exclusive(async () => {
      if (!this.chainId || !this.fh) throw new Error('the journal has no chain yet');
      if (!this.usable) throw new Error('the journal diverged from the server; re-enrolment is needed');
      const head = this.head();
      const reading = build(head.seq + 1n, head.hash);
      if (reading.seq !== (head.seq + 1n).toString() || reading.prevHash !== head.hash || reading.chainId !== this.chainId) {
        throw new Error('the reading does not continue the chain');
      }
      await this.fh.write(`${JSON.stringify(reading)}\n`, null, 'latin1');
      await this.fh.datasync();
      this.readings.push(reading);
      return reading;
    });
  }

  /** The server acknowledged every reading up to `seq` (its hash must be ours). */
  acknowledge(seq: bigint, hash: string): Promise<void> {
    return this.exclusive(async () => {
      if (seq <= this.ackedSeq) return;
      const ours = this.readings[Number(seq) - 1]?.hash;
      if (ours !== hash) throw new JournalIntegrityError(`the server acknowledged reading ${seq} with a hash this journal does not hold`);
      await this.writeAck(seq, hash);
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
