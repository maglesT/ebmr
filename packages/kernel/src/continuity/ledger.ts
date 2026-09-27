/**
 * External continuity ledger: the record kept OUTSIDE the database (build outline 4.2, 5.4; ADR 0007).
 *
 * It holds what a restore must not be able to take back: external copies of audit anchors, the
 * high-water marks of every protected identifier source, write-ahead ceilings of protected counters,
 * and restore events. In production it lives on write-once storage (object lock in compliance mode or
 * a WORM appliance) under credentials the database administrators do not hold. `FileLedger` is the
 * demo and test stand-in: an append-only JSON-lines file in which every line carries the hash of the
 * previous one, so an edited, removed or reordered line is detected on read. It is labelled demo-only.
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** One audit anchor as copied outside the database (field names match kernel.audit_anchor). */
export interface ExternalAnchor {
  anchor_id: string;
  created_at: string;
  merkle_root_hex: string;
  head_count: number;
  heads: { chain_key: string; seq: number; hash_hex: string }[];
}

/** High-water mark of one protected identifier source (continuity.sequence_high_water). */
export interface HighWaterMark {
  sequenceKey: string;
  sourceKind: 'PG_SEQUENCE' | 'COUNTER';
  lastValue: string;
  reservedCeiling: string | null;
}

export interface SequenceBump {
  sequenceKey: string;
  sourceKind: 'PG_SEQUENCE' | 'COUNTER';
  valueBefore: string;
  externalValue: string | null;
  valueAfter: string;
}

export type LedgerEntry =
  | { type: 'ANCHOR'; database: string; anchor: ExternalAnchor; highWater: HighWaterMark[] }
  | { type: 'CEILING'; database: string; sequenceKey: string; ceiling: string; floor: string }
  | { type: 'RESTORE_EVENT'; database: string; restoreEventId: string; eventKind: string; contentHashHex: string; discardedAnchorIds: string[] }
  | { type: 'RESTORE_COMPLETED'; database: string; restoreEventId: string; bumps: SequenceBump[] };

export interface LedgerRecord {
  seq: number;
  prev: string;
  hash: string;
  entry: LedgerEntry;
}

/** Proof that an entry reached external storage; stored with the database record it protects. */
export interface LedgerReceipt {
  seq: number;
  hash: string;
  /** Compact form stored in the database (continuity.ceiling_reservation.ledger_receipt). */
  id: string;
}

export class LedgerIntegrityError extends Error {
  override readonly name = 'LedgerIntegrityError';
}

/** Storage-independent contract; a write-once object-store implementation replaces FileLedger in production. */
export interface ExternalLedger {
  /** Label of the database this ledger protects; entries of other databases are ignored. */
  readonly database: string;
  /** Durably appends one entry and returns its receipt. Resolves only after the entry is on stable storage. */
  append(entry: LedgerEntry): Promise<LedgerReceipt>;
  /** Every entry of this database, after verifying the whole hash chain (throws LedgerIntegrityError). */
  entries(): Promise<LedgerEntry[]>;
}

const GENESIS = createHash('sha256').update('genesis:ebmr-continuity-ledger').digest('hex');

/** JSON with object keys sorted at every level, so the same entry always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'bigint') throw new TypeError('canonicalJson: bigint values must be written as strings');
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

function lineHash(prev: string, entry: LedgerEntry): string {
  return createHash('sha256').update(`${prev}\n${canonicalJson(entry)}`).digest('hex');
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface FileLedgerOptions {
  database: string;
  /** How long to wait for another writer's lock before failing (default 10 s). */
  lockTimeoutMs?: number;
}

/** Demo-only stand-in for write-once storage: append-only, hash-chained, fsync'd JSON lines. */
export class FileLedger implements ExternalLedger {
  readonly database: string;
  readonly path: string;
  private readonly lockTimeoutMs: number;

  constructor(path: string, options: FileLedgerOptions) {
    this.path = path;
    this.database = options.database;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 10_000;
    mkdirSync(dirname(path), { recursive: true });
  }

  append(entry: LedgerEntry): Promise<LedgerReceipt> {
    if (entry.database !== this.database) {
      return Promise.reject(new Error(`ledger for ${this.database} cannot store an entry for ${entry.database}`));
    }
    return Promise.resolve(
      this.withLock(() => {
        const records = this.readAll();
        const last = records[records.length - 1];
        const prev = last ? last.hash : GENESIS;
        const seq = last ? last.seq + 1 : 1;
        const hash = lineHash(prev, entry);
        const record: LedgerRecord = { seq, prev, hash, entry };
        const fd = openSync(this.path, 'a', 0o600);
        try {
          writeSync(fd, `${canonicalJson(record)}\n`);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        return { seq, hash, id: `ledger:${seq}:${hash.slice(0, 16)}` };
      }),
    );
  }

  entries(): Promise<LedgerEntry[]> {
    try {
      return Promise.resolve(this.readAll().map((r) => r.entry).filter((e) => e.database === this.database));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** Reads and verifies every line; throws LedgerIntegrityError on any break in the chain. */
  readAll(): LedgerRecord[] {
    if (!existsSync(this.path)) return [];
    const text = readFileSync(this.path, 'utf8');
    const lines = text.split('\n');
    if (lines[lines.length - 1] !== '') throw new LedgerIntegrityError(`${this.path}: the last line is incomplete`);
    const records: LedgerRecord[] = [];
    let prev = GENESIS;
    for (const [i, line] of lines.slice(0, -1).entries()) {
      let record: LedgerRecord;
      try {
        record = JSON.parse(line) as LedgerRecord;
      } catch {
        throw new LedgerIntegrityError(`${this.path}: line ${i + 1} is not valid JSON`);
      }
      if (record.seq !== i + 1) throw new LedgerIntegrityError(`${this.path}: line ${i + 1} has sequence ${record.seq}`);
      if (record.prev !== prev) throw new LedgerIntegrityError(`${this.path}: line ${i + 1} does not follow the previous line`);
      if (record.hash !== lineHash(prev, record.entry)) throw new LedgerIntegrityError(`${this.path}: line ${i + 1} was altered`);
      records.push(record);
      prev = record.hash;
    }
    return records;
  }

  private withLock<T>(work: () => T): T {
    const lock = `${this.path}.lock`;
    let waited = 0;
    for (;;) {
      try {
        closeSync(openSync(lock, 'wx', 0o600));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (waited >= this.lockTimeoutMs) {
          throw new Error(`ledger ${this.path} is locked by another writer (remove ${lock} only after confirming no writer is running)`);
        }
        sleepSync(20);
        waited += 20;
      }
    }
    try {
      return work();
    } finally {
      rmSync(lock, { force: true });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Queries over the entries of one database
// ---------------------------------------------------------------------------------------------

/** Every external anchor, in ledger order. */
export async function ledgerAnchors(ledger: ExternalLedger): Promise<ExternalAnchor[]> {
  return (await ledger.entries()).flatMap((e) => (e.type === 'ANCHOR' ? [e.anchor] : []));
}

/** Highest write-ahead ceiling the ledger holds for a counter, or null if it holds none. */
export async function ledgerMaxCeiling(ledger: ExternalLedger, sequenceKey: string): Promise<bigint | null> {
  let max: bigint | null = null;
  for (const e of await ledger.entries()) {
    if (e.type === 'CEILING' && e.sequenceKey === sequenceKey) {
      const v = BigInt(e.ceiling);
      if (max === null || v > max) max = v;
    }
  }
  return max;
}

/**
 * Highest value the ledger knows for every protected source: the maximum over counter ceilings and
 * over the high-water marks exported with anchors (last value and reserved ceiling).
 */
export async function ledgerHighWater(ledger: ExternalLedger): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  const raise = (key: string, value: string | null): void => {
    if (value === null) return;
    const v = BigInt(value);
    const current = out.get(key);
    if (current === undefined || v > current) out.set(key, v);
  };
  for (const e of await ledger.entries()) {
    if (e.type === 'CEILING') raise(e.sequenceKey, e.ceiling);
    if (e.type === 'ANCHOR') {
      for (const h of e.highWater) {
        raise(h.sequenceKey, h.lastValue);
        raise(h.sequenceKey, h.reservedCeiling);
      }
    }
  }
  return out;
}
