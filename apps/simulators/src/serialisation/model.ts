/**
 * The serialisation L3 stub (Phase 3 slice 4a, K-21, PR-42; D-S4-1, D-S4-3): one site L3 system that issues serial
 * pools to packaging orders, takes serial state events and reports each pool with its counts, unexplained serials and
 * the hash of the canonical report text (@ebmr/integration-sdk/serialisation). Its state lasts for the run of the
 * process (in memory). Serials come from a seeded generator, time from an injectable clock, so the same seed, clock
 * and requests give the same pools, serials and reports.
 *
 * Pool rules are the market profiles' (India Schedule H2 is batch-level: no pool; US GTINs carry the NDC). The same
 * pool request again (same packaging order, market, GTIN and quantity) answers the pool already issued, so a client
 * that lost an answer never orphans a pool. An events request is taken whole or refused whole. Rejecting a lot
 * (POST .../reject) opens a decommissioning task for its commissioned serials (D-S4-3; the flow is Phase 4).
 */
import {
  MARKET_PROFILES,
  POOL_MAX,
  gtinCarriesNdc,
  poolReport,
  serialTransitionAllowed,
  type PoolReport,
  type PoolRequest,
  type PoolResponse,
  type PoolSnapshot,
  type SerialEvent,
  type SerialState,
} from '@ebmr/integration-sdk/serialisation';
import { seededRandom } from '../scale/model.ts';

export interface L3Clock {
  /** UTC epoch microseconds. */
  nowUs(): bigint;
}

export const realL3Clock: L3Clock = { nowUs: () => BigInt(Date.now()) * 1000n };

/** Serial characters (digits and upper-case letters without I and O) and length. */
export const SERIAL_ALPHABET = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const SERIAL_LENGTH = 12;

export type L3ErrorCode = 'NOT_SERIALISED' | 'GTIN_NOT_NDC' | 'POOL_TOO_LARGE' | 'UNKNOWN_POOL' | 'UNKNOWN_SERIAL' | 'BAD_TRANSITION';
export class L3Refusal extends Error {
  constructor(
    readonly code: L3ErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'L3Refusal';
  }
}

interface Pool {
  poolId: string;
  packagingOrder: string;
  market: PoolRequest['market'];
  gtin: string;
  quantity: string;
  issuedAt: string;
  serials: string[];
  states: Map<string, { state: SerialState; at: string } | null>;
  rejected: boolean;
}

export interface DecommissionTask {
  taskId: string;
  poolId: string;
  packagingOrder: string;
  reason: string;
  createdAt: string;
  state: 'OPEN';
  /** The serials to decommission: those commissioned when the lot was rejected. */
  serials: string[];
}

export interface L3StubOptions {
  seed: number;
  clock?: L3Clock;
}

export class L3Stub {
  private readonly clock: L3Clock;
  private readonly random: () => number;
  private readonly pools = new Map<string, Pool>();
  private readonly issuedSerials = new Set<string>();
  private readonly tasks = new Map<string, DecommissionTask>();
  private nextPool = 1n;
  private nextTask = 1n;

  constructor(options: L3StubOptions) {
    this.clock = options.clock ?? realL3Clock;
    this.random = seededRandom(options.seed);
  }

  private newSerial(): string {
    for (;;) {
      let s = '';
      for (let i = 0; i < SERIAL_LENGTH; i += 1) s += SERIAL_ALPHABET[Math.floor(this.random() * SERIAL_ALPHABET.length)] ?? '0';
      if (!this.issuedSerials.has(s)) {
        this.issuedSerials.add(s);
        return s;
      }
    }
  }

  private pool(poolId: string): Pool {
    const p = this.pools.get(poolId);
    if (!p) throw new L3Refusal('UNKNOWN_POOL', `no pool ${poolId}`, 404);
    return p;
  }

  /** Issues a pool of serials for a packaging order (or answers the same pool for the same request). */
  issue(req: PoolRequest): PoolResponse {
    const profile = MARKET_PROFILES[req.market];
    if (!profile.serialised) throw new L3Refusal('NOT_SERIALISED', `${req.market} codes are batch-level: no serial pool`, 422);
    if (profile.gtinMustCarryNdc && !gtinCarriesNdc(req.gtin)) throw new L3Refusal('GTIN_NOT_NDC', `a ${req.market} GTIN carries the NDC (indicator digit, then 03)`, 422);
    if (BigInt(req.quantity) > POOL_MAX) throw new L3Refusal('POOL_TOO_LARGE', `at most ${POOL_MAX.toString()} serials`, 422);
    const same = [...this.pools.values()].find((p) => p.packagingOrder === req.packagingOrder && p.market === req.market && p.gtin === req.gtin && p.quantity === req.quantity);
    if (same) return { poolId: same.poolId, serials: [...same.serials], issuedAt: same.issuedAt };
    const poolId = `POOL-${this.nextPool.toString().padStart(6, '0')}`;
    this.nextPool += 1n;
    const serials: string[] = [];
    for (let i = 0n; i < BigInt(req.quantity); i += 1n) serials.push(this.newSerial());
    const pool: Pool = { poolId, packagingOrder: req.packagingOrder, market: req.market, gtin: req.gtin, quantity: req.quantity, issuedAt: this.clock.nowUs().toString(), serials, states: new Map(serials.map((s) => [s, null])), rejected: false };
    this.pools.set(poolId, pool);
    return { poolId, serials: [...serials], issuedAt: pool.issuedAt };
  }

  /** Applies serial events in order, all or none. Repeating the state a serial holds is a no-op. Answers how many were taken. */
  applyEvents(poolId: string, events: readonly SerialEvent[]): bigint {
    const pool = this.pool(poolId);
    const next = new Map(pool.states);
    for (const [i, e] of events.entries()) {
      if (!next.has(e.serial)) throw new L3Refusal('UNKNOWN_SERIAL', `events.${i}: ${e.serial} is not a serial of ${poolId}`, 422);
      const current = next.get(e.serial) ?? null;
      if (current?.state === e.state) continue;
      if (!serialTransitionAllowed(current?.state ?? null, e.state)) {
        throw new L3Refusal('BAD_TRANSITION', `events.${i}: ${e.serial} cannot go from ${current?.state ?? 'ISSUED'} to ${e.state}`, 409);
      }
      next.set(e.serial, { state: e.state, at: e.at });
    }
    pool.states = next;
    return BigInt(events.length);
  }

  snapshot(poolId: string): PoolSnapshot {
    const pool = this.pool(poolId);
    return { poolId, packagingOrder: pool.packagingOrder, market: pool.market, gtin: pool.gtin, serials: pool.serials.map((s) => ({ serial: s, state: pool.states.get(s)?.state ?? null })) };
  }

  report(poolId: string): PoolReport {
    return poolReport(this.snapshot(poolId));
  }

  /** A rejected lot: a decommissioning task for the serials commissioned now (the same task again for a repeat). */
  reject(poolId: string, reason: string): DecommissionTask {
    const pool = this.pool(poolId);
    const existing = [...this.tasks.values()].find((t) => t.poolId === poolId);
    if (existing) return structuredClone(existing);
    pool.rejected = true;
    const taskId = `DT-${this.nextTask.toString().padStart(6, '0')}`;
    this.nextTask += 1n;
    const task: DecommissionTask = {
      taskId,
      poolId,
      packagingOrder: pool.packagingOrder,
      reason,
      createdAt: this.clock.nowUs().toString(),
      state: 'OPEN',
      serials: pool.serials.filter((s) => pool.states.get(s)?.state === 'COMMISSIONED'),
    };
    this.tasks.set(taskId, task);
    return structuredClone(task);
  }

  decommissionTasks(): DecommissionTask[] {
    return [...this.tasks.values()].map((t) => structuredClone(t));
  }

  /** A summary of every pool (the console and the tests). */
  summaries(): { poolId: string; packagingOrder: string; market: string; gtin: string; issuedAt: string; rejected: boolean; report: PoolReport }[] {
    return [...this.pools.values()].map((p) => ({ poolId: p.poolId, packagingOrder: p.packagingOrder, market: p.market, gtin: p.gtin, issuedAt: p.issuedAt, rejected: p.rejected, report: this.report(p.poolId) }));
  }
}
