/**
 * The inputs of the 6A-2 methods as the runner assembles them from the input views (report.cpp_value_v1 and
 * report.batch_fact_v1): per product, MBR family and critical item, the completed batches in completion order with
 * their values as decimal text, and the master's limits as decimal text (echoed unchanged in every output).
 */
import type { DecimalText } from '../../numeric/from-decimal.ts';

/** The master's specification of an item, as decimal text (null where the master states none). */
export interface Specification {
  readonly lower: DecimalText | null;
  readonly upper: DecimalText | null;
  readonly target: DecimalText | null;
  readonly unit: string | null;
}

/** One completed batch of a series. */
export interface BatchRef {
  readonly batchId: string;
  readonly batchNumber: string;
  /** The completion instant as the view gives it (the order of the series). */
  readonly completedAt: string;
}

export interface ValuePoint extends BatchRef {
  readonly value: DecimalText;
}

export interface SubgroupPoint extends BatchRef {
  readonly values: readonly DecimalText[];
}

interface SeriesKey {
  readonly product: string;
  readonly family: string;
  readonly item: string;
  /** The specification of the newest batch's master. */
  readonly specification: Specification;
}

/** One value per batch (BATCH_VALUE: I-MR, capability, drift). */
export interface ValueSeries extends SeriesKey {
  readonly points: readonly ValuePoint[];
}

/** Two or more readings per batch (SUBGROUP_VALUES: Xbar-S). */
export interface SubgroupSeries extends SeriesKey {
  readonly points: readonly SubgroupPoint[];
}

export interface BatchValueInput {
  readonly series: readonly ValueSeries[];
}

export interface SubgroupInput {
  readonly series: readonly SubgroupSeries[];
}

/** The subject of a series: product, family and item (subject kind PRODUCT_ITEM). */
export const seriesRef = (s: { product: string; family: string; item: string }): string => `${s.product}|${s.family}|${s.item}`;

/** The specification as output values: only the limits the master states, as its decimal text. */
export function specificationValues(spec: Specification): Record<string, string> {
  const out: Record<string, string> = {};
  if (spec.lower !== null) out['specLower'] = spec.lower;
  if (spec.upper !== null) out['specUpper'] = spec.upper;
  if (spec.target !== null) out['specTarget'] = spec.target;
  if (spec.unit !== null) out['unit'] = spec.unit;
  return out;
}
