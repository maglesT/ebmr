/**
 * Namespace `serialisation` (Phase 6 slice 6c, GMP): serialisation L3/L4 (PR-42; tablets 0952, 1231; integration-sdk
 * serialisation and adapter/systems/l3.ts; interfaces docs/build-plan/phase-6/slice-6c-0-interfaces.md).
 *
 *  - A serial query: the server asks the L3 system for the serial's pool and state and answers with the lot (batch
 *    number) and expiry of its own record for that pool; an L3 lot or expiry that differs is a problem (D-P6c-1).
 *  - The pools of a packaging order with their latest report, the aggregations and decommissioning tasks the L3
 *    adapter received, the L3 mirror's freshness and the release problem (zero unexplained serials, no open
 *    decommissioning task and, in MIRROR mode, a fresh L3 mirror; fails closed).
 *  - QA rejects a pool: the L3 system opens a decommissioning task for its commissioned serials.
 */
import { z } from 'zod';
import { Uuid, withAttribution } from '../common.ts';
import { defineRoute } from '../route.ts';

export const SerialStatus = z.enum(['ISSUED', 'COMMISSIONED', 'DECOMMISSIONED', 'DESTROYED', 'SAMPLE', 'UNUSED_RETURNED']);

export const L3MirrorView = z.strictObject({
  mode: z.enum(['STAND_IN', 'MIRROR']),
  stale: z.boolean(),
  ageSeconds: z.number().int().nonnegative().nullable(),
  boundSeconds: z.number().int().positive(),
});

export const SerialLookupView = z.strictObject({
  serial: z.string(),
  poolId: z.string(),
  gtin: z.string(),
  market: z.string(),
  batchId: Uuid,
  /** The lot is the packaging order's batch number (the record's). */
  lot: z.string(),
  /** The record's expiry month (recipe.batch_expiry). */
  expiry: z.string().nullable(),
  status: SerialStatus,
  /** What the L3 system itself said of lot and expiry, when its profile carries them. */
  l3: z.strictObject({ lot: z.string().nullable(), expiry: z.string().nullable(), packagingOrder: z.string() }),
  /** Disagreements between the L3 answer and the record (empty when consistent). */
  problems: z.array(z.string()),
  mirror: L3MirrorView,
});
export type SerialLookupView = z.infer<typeof SerialLookupView>;

export const BatchPoolsView = z.strictObject({
  batchId: Uuid,
  batchNumber: z.string(),
  mirror: L3MirrorView,
  pools: z.array(z.strictObject({
    poolId: z.string(),
    stepKey: z.string(),
    market: z.string(),
    gtin: z.string(),
    quantity: z.string(),
    latestReport: z.strictObject({ unexplained: z.string(), reportHash: z.string(), fetchedAt: z.string() }).nullable(),
    aggregations: z.array(z.strictObject({ parentId: z.string(), action: z.enum(['ADD', 'DELETE']), childCount: z.string() })),
    decommissionTasks: z.array(z.strictObject({ taskId: z.string(), state: z.enum(['OPEN', 'DONE']), serialCount: z.string(), reason: z.string() })),
  })),
  /** Why release waits on serialisation (the database's words), null when nothing blocks it. */
  releaseProblem: z.string().nullable(),
});
export type BatchPoolsView = z.infer<typeof BatchPoolsView>;

export const serialisation = {
  serial: defineRoute({
    id: 'serialisation.serial', method: 'GET', path: '/api/serialisation/serials/:serial', installation: 'GMP', auth: 'SESSION', mutating: false,
    summary: 'A serial query: its lot, expiry and status (PR-42)',
    params: z.strictObject({ serial: z.string().regex(/^[A-Za-z0-9/.-]{1,20}$/) }),
    response: SerialLookupView,
  }),
  batchPools: defineRoute({
    id: 'serialisation.batchPools', method: 'GET', path: '/api/serialisation/batches/:batchId/pools', installation: 'GMP', auth: 'SESSION', mutating: false,
    summary: 'The serial pools of a packaging order with reports, aggregations, decommissioning tasks and the release problem',
    params: z.strictObject({ batchId: Uuid }),
    response: BatchPoolsView,
  }),
  rejectPool: defineRoute({
    id: 'serialisation.rejectPool', method: 'POST', path: '/api/serialisation/pools/:poolId/rejection', installation: 'GMP', auth: 'SESSION', mutating: true, attribution: 'FRESH_ON_SHARED',
    summary: 'QA rejects a pool: the L3 system opens a decommissioning task for its commissioned serials',
    params: z.strictObject({ poolId: z.string().regex(/^[\x21-\x7E]{1,64}$/) }),
    body: withAttribution({ reason: z.string().trim().min(1).max(500).regex(/^[\x20-\x7E]+$/) }),
    response: BatchPoolsView,
  }),
} as const;
