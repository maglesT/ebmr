/**
 * Serialisation L3/L4 contract (Phase 6 slice 6c; PR-42; outline 4.6, L-53; default D-P6c-1). The device-side pool
 * contract (pool requests, serial state events, the hashed pool report) stays in ../../serialisation; this module is
 * what the L3 system sends the eBMR through the adapter framework, a documented JSON shape modelled on the OPEN-SCS
 * event names and the EPCIS aggregation event (a vendor's exact profile is mapped at deployment, D-P6c-1):
 *
 *   l3.aggregation        an EPCIS-style AggregationEvent: a parent (the shipper's SSCC) with the count of serialised
 *                         packs aggregated into it (ADD) or taken out (DELETE), for one pool. The record holds each
 *                         shipper's SSCC and packs (TB-24 SHIPPER entries); a parent that is no shipper of the pool's
 *                         packaging order is refused WRONG_IDENTITY, a count that differs from the shipper's packs is
 *                         refused OUT_OF_RANGE (the aggregation mismatch).
 *   l3.decommission_task  a decommissioning task the L3 system opened when a pool's lot or packs were rejected (OPEN), or
 *                         closed when its serials were decommissioned (DONE). An OPEN task keeps release blocked (PR-42).
 *
 * Unit serials never enter the record (L-53): both messages carry counts. The L3 mirror data class L3_SERIAL_STATUS
 * (blocking) is kept fresh by the adapter's heartbeat; in MIRROR mode release fails closed when it is stale.
 * Receiving command (tablets 1231): tab.receive_l3_message.
 */
import { z } from 'zod';
import { SourceCode, SourceText, type SystemContract } from '../contract.ts';
import { EpochMicrosText } from '../envelope.ts';

/** A count as decimal text (no leading zeros). */
const CountText = z.string().regex(/^(0|[1-9][0-9]{0,17})$/, 'a whole count as text');
/** An SSCC (GS1 AI 00): 18 digits. */
export const Sscc = z.string().regex(/^[0-9]{18}$/, 'an SSCC of 18 digits');

export const L3AggregationV1 = z.strictObject({
  eventId: SourceCode,
  action: z.enum(['ADD', 'DELETE']),
  poolId: SourceCode,
  parentId: Sscc,
  childCount: CountText,
  eventTime: EpochMicrosText,
});
export type L3AggregationV1 = z.infer<typeof L3AggregationV1>;

export const L3DecommissionTaskV1 = z.strictObject({
  taskId: SourceCode,
  poolId: SourceCode,
  packagingOrder: SourceCode,
  serialCount: CountText,
  reason: SourceText,
  state: z.enum(['OPEN', 'DONE']),
  changedAt: EpochMicrosText,
});
export type L3DecommissionTaskV1 = z.infer<typeof L3DecommissionTaskV1>;

/** The data class the L3 adapter keeps fresh (kernel 1180 platform.mirror_data_class row added by tablets 1231). */
export const L3_MIRROR_CLASS = 'L3_SERIAL_STATUS';

export const L3: SystemContract = {
  system: 'L3',
  inbound: {
    'l3.aggregation': { summary: 'An EPCIS-style aggregation of serialised packs into a shipper (SSCC)', versions: { '1': L3AggregationV1 } },
    'l3.decommission_task': { summary: 'A decommissioning task opened on a rejection, or closed', versions: { '1': L3DecommissionTaskV1 } },
  },
  outbound: ['l3.pool_request', 'l3.serial_events', 'l3.pool_rejected'],
  refusalCodes: {
    'EBMR-L3-101': 'MALFORMED',
    'EBMR-L3-103': 'WRONG_IDENTITY',
    'EBMR-L3-105': 'OUT_OF_RANGE',
    'EBMR-L3-104': 'STALE',
  },
};
