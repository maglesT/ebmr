/**
 * The serialisation L3 contract (Phase 3 slice 4a, K-21, PR-42; the 4a interface of slice-4-plan.md). The tablets
 * server is the client of the site's L3 system (a stub in apps/simulators until the Phase 6 adapter); unit serials and
 * aggregation stay in the L3/L4 system, the record keeps the pool id, the counts, the reconciliation and the report
 * hash.
 *
 *   POST /l3/v1/pools                    PoolRequest -> PoolResponse: a pool of serials for one packaging order
 *   POST /l3/v1/pools/:poolId/events     SerialEventsRequest: serial state events (a batch is taken whole or refused whole)
 *   GET  /l3/v1/pools/:poolId/report     PoolReport: counts per state, unexplained serials and the report hash
 *
 * Quantities and counts are whole decimal text; times are UTC epoch microseconds as text. Every serial must end in a
 * state: COMMISSIONED (on a saleable pack), DECOMMISSIONED, DESTROYED, SAMPLE or UNUSED_RETURNED; a serial issued
 * with no state is unexplained. The report hash is the SHA-256 (lower-case hex) of the canonical report text
 * (canonicalReportText): the same pool in the same states always gives the same hash.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Gtin } from '../printer/wire.ts';
import { ProcessEpochMicros } from '../process/wire.ts';
import { MARKETS } from './market.ts';

export const L3_POOLS_PATH = '/l3/v1/pools';
export const l3PoolEventsPath = (poolId: string): string => `${L3_POOLS_PATH}/${encodeURIComponent(poolId)}/events`;
export const l3PoolReportPath = (poolId: string): string => `${L3_POOLS_PATH}/${encodeURIComponent(poolId)}/report`;

/** The most serials one pool holds, and the most events one request carries. */
export const POOL_MAX = 100_000n;
export const SERIAL_EVENTS_MAX = 1000;

const WholeText = z.string().regex(/^(0|[1-9][0-9]{0,17})$/, 'a whole number as decimal text');
export const PoolId = z.string().regex(/^[\x21-\x7E]{1,64}$/);
export const Serial = z.string().regex(/^[A-Za-z0-9/.-]{1,20}$/, 'a serial (GS1 AI 21 subset, at most 20)');

export const PoolRequest = z.strictObject({
  packagingOrder: z.string().regex(/^[\x20-\x7E]{1,64}$/),
  market: z.enum(MARKETS),
  gtin: Gtin,
  quantity: WholeText.refine((q) => q !== '0' && BigInt(q) <= POOL_MAX, `1 to ${POOL_MAX.toString()} serials`),
});
export type PoolRequest = z.infer<typeof PoolRequest>;

export const PoolResponse = z.strictObject({ poolId: PoolId, serials: z.array(Serial).min(1), issuedAt: ProcessEpochMicros });
export type PoolResponse = z.infer<typeof PoolResponse>;

export const SERIAL_STATES = ['COMMISSIONED', 'DECOMMISSIONED', 'DESTROYED', 'SAMPLE', 'UNUSED_RETURNED'] as const;
export const SerialState = z.enum(SERIAL_STATES);
export type SerialState = z.infer<typeof SerialState>;

export const SerialEvent = z.strictObject({ serial: Serial, state: SerialState, at: ProcessEpochMicros });
export type SerialEvent = z.infer<typeof SerialEvent>;
export const SerialEventsRequest = z.strictObject({ events: z.array(SerialEvent).min(1).max(SERIAL_EVENTS_MAX) });
export type SerialEventsRequest = z.infer<typeof SerialEventsRequest>;
/** The stub answers {accepted: "<n>"}; a client reads nothing else from a 2xx. */
export const SerialEventsResponse = z.looseObject({ accepted: WholeText });

/**
 * The state changes a serial may take (from no state = issued): issued -> COMMISSIONED, UNUSED_RETURNED or DESTROYED
 * (a coded set-up unit destroyed before commissioning); COMMISSIONED -> DECOMMISSIONED, DESTROYED or SAMPLE;
 * DECOMMISSIONED -> DESTROYED. DESTROYED, SAMPLE and UNUSED_RETURNED end it. An event repeating the state the serial
 * holds is a repeat, taken as a no-op (a client may resend a batch).
 */
export const SERIAL_TRANSITIONS: Record<SerialState | 'ISSUED', readonly SerialState[]> = {
  ISSUED: ['COMMISSIONED', 'UNUSED_RETURNED', 'DESTROYED'],
  COMMISSIONED: ['DECOMMISSIONED', 'DESTROYED', 'SAMPLE'],
  DECOMMISSIONED: ['DESTROYED'],
  DESTROYED: [],
  SAMPLE: [],
  UNUSED_RETURNED: [],
};

export function serialTransitionAllowed(from: SerialState | null, to: SerialState): boolean {
  return SERIAL_TRANSITIONS[from ?? 'ISSUED'].includes(to);
}

export const PoolCounts = z.strictObject({
  issued: WholeText,
  COMMISSIONED: WholeText,
  DECOMMISSIONED: WholeText,
  DESTROYED: WholeText,
  SAMPLE: WholeText,
  UNUSED_RETURNED: WholeText,
});
export type PoolCounts = z.infer<typeof PoolCounts>;

export const PoolReport = z.strictObject({
  poolId: PoolId,
  counts: PoolCounts,
  /** Serials issued with no state, as whole decimal text. */
  unexplained: WholeText,
  reportHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type PoolReport = z.infer<typeof PoolReport>;

/** The L3 error body (4xx/5xx). */
export const L3Error = z.strictObject({ error: z.strictObject({ code: z.string().regex(/^[A-Z_]{2,40}$/), message: z.string().max(500) }) });

export interface PoolSnapshot {
  poolId: string;
  packagingOrder: string;
  market: string;
  gtin: string;
  /** Every serial issued with its state now (null: no state). */
  serials: readonly { serial: string; state: SerialState | null }[];
}

export const L3_REPORT_FORMAT = 'ebmr.l3-report.v1';

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The canonical text of a pool report: LF-ended lines, the format name, the pool's identity, the counts in the order
 * of PoolCounts, the unexplained count, then one line per serial in code-unit order of the serial ("<serial> <state>",
 * NONE for no state). Event times are not part of it: the hash names the outcome, not the history.
 */
export function canonicalReportText(pool: PoolSnapshot): string {
  const counts = poolCounts(pool);
  const lines = [
    L3_REPORT_FORMAT,
    `poolId=${pool.poolId}`,
    `packagingOrder=${pool.packagingOrder}`,
    `market=${pool.market}`,
    `gtin=${pool.gtin}`,
    `issued=${counts.issued}`,
    ...SERIAL_STATES.map((s) => `${s}=${counts[s]}`),
    `unexplained=${unexplainedOf(pool).toString()}`,
    ...[...pool.serials].sort((a, b) => compare(a.serial, b.serial)).map((s) => `${s.serial} ${s.state ?? 'NONE'}`),
  ];
  return `${lines.join('\n')}\n`;
}

export function reportHashOf(canonicalText: string): string {
  return createHash('sha256').update(canonicalText, 'utf8').digest('hex');
}

export function poolCounts(pool: PoolSnapshot): PoolCounts {
  const n = (s: SerialState) => BigInt(pool.serials.filter((x) => x.state === s).length).toString();
  return { issued: BigInt(pool.serials.length).toString(), COMMISSIONED: n('COMMISSIONED'), DECOMMISSIONED: n('DECOMMISSIONED'), DESTROYED: n('DESTROYED'), SAMPLE: n('SAMPLE'), UNUSED_RETURNED: n('UNUSED_RETURNED') };
}

function unexplainedOf(pool: PoolSnapshot): bigint {
  return BigInt(pool.serials.filter((s) => s.state === null).length);
}

/** The report of a pool now: counts, unexplained and the hash of its canonical text. Pure. */
export function poolReport(pool: PoolSnapshot): PoolReport {
  return { poolId: pool.poolId, counts: poolCounts(pool), unexplained: unexplainedOf(pool).toString(), reportHash: reportHashOf(canonicalReportText(pool)) };
}

/** Whether a report shows every serial in a state (zero unexplained) and its counts add up to the serials issued. */
export function reportReconciles(report: PoolReport): boolean {
  const sum = SERIAL_STATES.reduce((acc, s) => acc + BigInt(report.counts[s]), 0n);
  return report.unexplained === '0' && sum === BigInt(report.counts.issued);
}

// ---------------------------------------------------------------------------------------------------------------
// Phase 6 slice 6c (PR-42, D-P6c-1): the serial query and the rejection of a pool, additive.
//
//   GET  /l3/v1/serials/:serial          SerialQueryAnswer: the pool, GTIN, packaging order and state the L3 system holds
//                                        for one serial (lot and expiry when the L3 profile carries them)
//   POST /l3/v1/pools/:poolId/reject     PoolRejection -> DecommissionTask: the L3 system opens a decommissioning task
//                                        for the serials commissioned in the pool (the same task again for a repeat)
// The eBMR answers a serial query with the lot and expiry of its own record (the pool's packaging order), never the
// L3's: an L3 lot or expiry that differs from the record is shown as a problem.
// ---------------------------------------------------------------------------------------------------------------

export const l3SerialPath = (serial: string): string => `/l3/v1/serials/${encodeURIComponent(serial)}`;
export const l3PoolRejectPath = (poolId: string): string => `${L3_POOLS_PATH}/${encodeURIComponent(poolId)}/reject`;

export const SerialQueryAnswer = z.strictObject({
  serial: Serial,
  poolId: PoolId,
  gtin: Gtin,
  packagingOrder: z.string().regex(/^[\x20-\x7E]{1,64}$/),
  /** null: issued, no state yet. */
  state: SerialState.nullable(),
  /** The lot (batch number) and expiry (YYYY-MM) the L3 profile carries, when it does. */
  lot: z.string().regex(/^[\x20-\x7E]{1,64}$/).optional(),
  expiry: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
});
export type SerialQueryAnswer = z.infer<typeof SerialQueryAnswer>;

export const PoolRejection = z.strictObject({ reason: z.string().regex(/^[\x20-\x7E]{1,500}$/) });
export type PoolRejection = z.infer<typeof PoolRejection>;

export const DecommissionTask = z.strictObject({
  taskId: z.string().regex(/^[\x21-\x7E]{1,64}$/),
  poolId: PoolId,
  packagingOrder: z.string().regex(/^[\x20-\x7E]{1,64}$/),
  reason: z.string().max(500),
  createdAt: ProcessEpochMicros,
  state: z.enum(['OPEN', 'DONE']),
  serials: z.array(Serial),
});
export type DecommissionTask = z.infer<typeof DecommissionTask>;
