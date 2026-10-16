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
 *
 * Phase 6 slice 6c (PR-42, D-P6c-1, D-P6c-14, D-P6c-15): the stub becomes a stateful L3/L4 simulator. It publishes what
 * the eBMR's L3 adapter receives on its own feed (system-feed/feed.ts, source system L3): an EPCIS-style aggregation of
 * packs into a shipper (l3.aggregation) and each state of a decommissioning task (l3.decommission_task, OPEN on a
 * rejection, DONE when its serials are decommissioned). It answers a serial query (SerialQueryAnswer) with the pool,
 * GTIN, packaging order and state it holds, and the lot and expiry of the pool's profile when one is set. Faults
 * (L3_FAULTS), on and off by the console or POST /api/fault:
 *   MISSING_EVENTS        the feed delivers nothing while messages are published (a gap; delivered when off)
 *   DUPLICATE_SERIAL      a new pool carries one serial twice (the eBMR refuses a pool of fewer distinct serials)
 *   STALE_REPORT          the heartbeat stops and reports are frozen as they were when the fault came on
 *   AGGREGATION_MISMATCH  an aggregation is published with one pack more than the shipper holds
 * The feed's own faults (FEED_FAULTS) are switched the same way.
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
import { SerialQueryAnswer } from '@ebmr/integration-sdk/serialisation';
import { seededRandom } from '../scale/model.ts';
import { SystemFeed } from '../system-feed/feed.ts';

export const L3_FAULTS = ['MISSING_EVENTS', 'DUPLICATE_SERIAL', 'STALE_REPORT', 'AGGREGATION_MISMATCH'] as const;
export type L3Fault = (typeof L3_FAULTS)[number];

export interface L3Clock {
  /** UTC epoch microseconds. */
  nowUs(): bigint;
}

export const realL3Clock: L3Clock = { nowUs: () => BigInt(Date.now()) * 1000n };

/** Serial characters (digits and upper-case letters without I and O) and length. */
export const SERIAL_ALPHABET = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const SERIAL_LENGTH = 12;

export type L3ErrorCode = 'NOT_SERIALISED' | 'GTIN_NOT_NDC' | 'POOL_TOO_LARGE' | 'UNKNOWN_POOL' | 'UNKNOWN_SERIAL' | 'BAD_TRANSITION' | 'UNKNOWN_TASK' | 'SCHEMA';
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
  /** The lot and expiry the L3 profile carries for the pool, when set. */
  profile: { lot?: string; expiry?: string };
}

export interface DecommissionTask {
  taskId: string;
  poolId: string;
  packagingOrder: string;
  reason: string;
  createdAt: string;
  state: 'OPEN' | 'DONE';
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
  private nextEvent = 1n;
  /** The L3 feed the eBMR's adapter pulls (source system L3). */
  readonly feed: SystemFeed;
  readonly faults = new Set<L3Fault>();
  private frozenReports: Map<string, PoolReport> | null = null;

  constructor(options: L3StubOptions) {
    this.clock = options.clock ?? realL3Clock;
    this.random = seededRandom(options.seed);
    const clock = this.clock;
    let last = 0n;
    let wrong = 0;
    this.feed = new SystemFeed({
      system: 'L3',
      clock: { nowUs: () => (last = clock.nowUs() > last ? clock.nowUs() : last + 1n) },
      wrongIdentity: (_t, p) => ({ ...p, poolId: `NO-SUCH-POOL-${(++wrong).toString()}` }),
    });
  }

  /** Switches an L3 fault (header). */
  setFault(fault: L3Fault, on: boolean): void {
    if (on) this.faults.add(fault);
    else this.faults.delete(fault);
    if (fault === 'MISSING_EVENTS') {
      if (on) this.feed.faults.add('FEED_GAP');
      else this.feed.faults.delete('FEED_GAP');
    }
    if (fault === 'STALE_REPORT') {
      if (on) this.feed.faults.add('STALE_MIRROR');
      else this.feed.faults.delete('STALE_MIRROR');
      this.frozenReports = on ? new Map([...this.pools.keys()].map((id) => [id, poolReport(this.snapshot(id))])) : null;
    }
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
    // DUPLICATE_SERIAL: the last serial repeats the first (a pool of fewer distinct serials than asked).
    if (this.faults.has('DUPLICATE_SERIAL') && serials.length > 1) serials[serials.length - 1] = serials[0] ?? '';
    const pool: Pool = { poolId, packagingOrder: req.packagingOrder, market: req.market, gtin: req.gtin, quantity: req.quantity, issuedAt: this.clock.nowUs().toString(), serials, states: new Map(serials.map((s) => [s, null])), rejected: false, profile: {} };
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
    const frozen = this.frozenReports?.get(poolId);
    return frozen ? structuredClone(frozen) : poolReport(this.snapshot(poolId));
  }

  /** A rejected lot: a decommissioning task for the serials commissioned now (the same task again for a repeat). */
  reject(poolId: string, reason: string): DecommissionTask {
    const pool = this.pool(poolId);
    // The same task again while it is open; a rejection after a task is done opens a new one.
    const existing = [...this.tasks.values()].find((t) => t.poolId === poolId && t.state === 'OPEN');
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
    this.publishTask(task, task.createdAt);
    return structuredClone(task);
  }

  private publishTask(t: DecommissionTask, changedAt: string): void {
    this.feed.publish('l3.decommission_task', t.taskId, {
      taskId: t.taskId, poolId: t.poolId, packagingOrder: t.packagingOrder, serialCount: t.serials.length.toString(), reason: t.reason, state: t.state, changedAt,
    });
  }

  /** The task's serials are decommissioned: each serial DECOMMISSIONED, the task DONE and published. */
  completeTask(taskId: string): DecommissionTask {
    const t = this.tasks.get(taskId);
    if (!t) throw new L3Refusal('UNKNOWN_TASK', `no decommissioning task ${taskId}`, 404);
    if (t.state === 'DONE') return structuredClone(t);
    const at = this.clock.nowUs().toString();
    const pool = this.pool(t.poolId);
    for (const s of t.serials) if (pool.states.get(s)?.state === 'COMMISSIONED') pool.states.set(s, { state: 'DECOMMISSIONED', at });
    t.state = 'DONE';
    this.publishTask(t, at);
    return structuredClone(t);
  }

  /** An aggregation of `childCount` packs of pool `poolId` into shipper `parentId` (EPCIS AggregationEvent), published. */
  aggregate(a: { poolId: string; parentId: string; childCount: string; action?: 'ADD' | 'DELETE' }): Record<string, unknown> {
    this.pool(a.poolId);
    if (!/^[0-9]{18}$/.test(a.parentId) || !/^(0|[1-9][0-9]{0,17})$/.test(a.childCount)) throw new L3Refusal('SCHEMA', 'parentId is an SSCC of 18 digits, childCount a whole count', 400);
    const count = this.faults.has('AGGREGATION_MISMATCH') ? (BigInt(a.childCount) + 1n).toString() : a.childCount;
    const eventId = `AGG-${(this.nextEvent++).toString().padStart(6, '0')}`;
    const payload = { eventId, action: a.action ?? 'ADD', poolId: a.poolId, parentId: a.parentId, childCount: count, eventTime: this.clock.nowUs().toString() };
    this.feed.publish('l3.aggregation', `${a.poolId}/${a.parentId}`, payload);
    return payload;
  }

  /** Sets the lot and expiry the L3 profile carries for a pool (the serial query answers them). */
  setProfile(poolId: string, profile: { lot?: string; expiry?: string }): void {
    this.pool(poolId).profile = { ...profile };
  }

  /** A serial query: what the L3 holds for one serial. */
  query(serial: string): SerialQueryAnswer {
    for (const p of this.pools.values()) {
      if (!p.states.has(serial)) continue;
      return SerialQueryAnswer.parse({ serial, poolId: p.poolId, gtin: p.gtin, packagingOrder: p.packagingOrder, state: p.states.get(serial)?.state ?? null, ...p.profile });
    }
    throw new L3Refusal('UNKNOWN_SERIAL', `no pool holds serial ${serial}`, 404);
  }

  decommissionTasks(): DecommissionTask[] {
    return [...this.tasks.values()].map((t) => structuredClone(t));
  }

  /** A summary of every pool (the console and the tests). */
  summaries(): { poolId: string; packagingOrder: string; market: string; gtin: string; issuedAt: string; rejected: boolean; report: PoolReport }[] {
    return [...this.pools.values()].map((p) => ({ poolId: p.poolId, packagingOrder: p.packagingOrder, market: p.market, gtin: p.gtin, issuedAt: p.issuedAt, rejected: p.rejected, report: this.report(p.poolId) }));
  }
}
