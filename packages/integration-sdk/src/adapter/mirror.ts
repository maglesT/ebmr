/**
 * Mirror data classes, modes and freshness (Phase 6 slice 6a-0; DI-31, INV-26, INV-38; D-P6a-3, D-P6a-5).
 *
 * Each data class that a GMP guard reads from another system runs in one mode per site (the platform setting
 * `integration.mode.<data class in lower case>`):
 *  - STAND_IN: the eBMR's built-in register is authoritative (decision 0001 item 11); there is no freshness bound.
 *  - MIRROR: an adapter keeps the eBMR copy in step; the copy is stale when its last successful synchronisation is
 *    older than `integration.mirror_max_age_s.<data class>` seconds, and a blocking class then fails closed.
 *
 * `platform.mirror_freshness(dataClass)` returns MirrorFreshness; `platform.mirror_fresh_or_raise(dataClass)` returns
 * the same when the class may be used and raises EBMR-INT-010 (naming the mirror, its age and its bound) when a
 * blocking class is stale. Non-blocking classes (item master, quantity on hand) are flagged, never refused.
 */
import { z } from 'zod';
import { EpochMicrosText, SourceSystem } from './envelope.ts';

export const MIRROR_DATA_CLASSES = [
  'LMS_QUALIFICATION',
  'CMMS_CALIBRATION',
  'CMMS_MAINTENANCE',
  'QMS_STATUS',
  'ERP_LOT_STATUS',
  'ERP_ITEM_MASTER',
  'WMS_STOCK',
] as const;
export const MirrorDataClass = z.enum(MIRROR_DATA_CLASSES);
export type MirrorDataClass = z.infer<typeof MirrorDataClass>;

export const MirrorMode = z.enum(['STAND_IN', 'MIRROR']);
export type MirrorMode = z.infer<typeof MirrorMode>;

const WholeText = z.string().regex(/^(0|[1-9][0-9]{0,17})$/);

export const MirrorFreshness = z.strictObject({
  dataClass: MirrorDataClass,
  sourceSystem: SourceSystem,
  mode: MirrorMode,
  /** A stale blocking class refuses; a stale non-blocking class is flagged. */
  blocking: z.boolean(),
  /** Last successful synchronisation (UTC epoch microseconds); null in STAND_IN or before the first one. */
  asOfUs: EpochMicrosText.nullable(),
  /** Whole seconds since asOfUs; null when asOfUs is null. */
  ageSeconds: WholeText.nullable(),
  /** The bound in whole seconds; null in STAND_IN. */
  boundSeconds: WholeText.nullable(),
  stale: z.boolean(),
});
export type MirrorFreshness = z.infer<typeof MirrorFreshness>;
