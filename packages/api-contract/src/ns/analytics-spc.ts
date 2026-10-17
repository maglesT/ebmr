/**
 * Namespace `analyticsSpc` (Phase 6A slice 6A-2; interfaces slice-6A-0-interfaces.md section 5): control charts,
 * capability and deviation-rate comparisons. GMP only, SESSION, advisory (ns/analytics.ts). The master's limits and
 * every recorded value are echoed as the source's decimal text; statistics are StatNumber (DI-51).
 */
import { z } from 'zod';
import { DecimalString, Instant, Uuid } from '../common.ts';
import { defineRoute } from '../route.ts';
import { AdvisoryEnvelope, AnalyticsDrill, FlagView, SkippedSubject, StatNumber } from './analytics.ts';

const Count = z.number().int().nonnegative();
const SiteDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date as YYYY-MM-DD');
const Code = z.string().trim().min(1).max(64);

/** The master's specification limits of the item, as its decimal text (null where it has none). */
export const SpecificationEcho = z.strictObject({ lower: DecimalString.nullable(), upper: DecimalString.nullable(), target: DecimalString.nullable(), unit: z.string().min(1) });
/** A statistic with its two-sided interval. */
export const StatInterval = z.strictObject({ value: StatNumber, lower: StatNumber, upper: StatNumber, confidence: StatNumber });

export const SpcChartView = z.strictObject({
  ...AdvisoryEnvelope,
  product: Code,
  family: Code,
  item: z.string().min(1),
  chart: z.enum(['IMR', 'XBAR_S']),
  /** REFERENCE_SET: from the approved reference set; PHASE_I: from the first batches, labelled as such (D-6A-7). */
  limitsSource: z.enum(['REFERENCE_SET', 'PHASE_I']),
  specification: SpecificationEcho,
  centre: StatNumber,
  upperControl: StatNumber,
  lowerControl: StatNumber,
  /** Slice 6A-2 (optional, additive): the spread chart's centre and limits (moving range for I-MR, S for Xbar-S). */
  spreadChart: z.strictObject({ kind: z.enum(['MR', 'S']), centre: StatNumber, upper: StatNumber, lower: StatNumber }).optional(),
  points: z.array(z.strictObject({
    batchId: Uuid,
    batchNumber: z.string().min(1),
    completedAt: Instant,
    /** The recorded value (I-MR) or null for a subgroup chart; decimal text as recorded. */
    value: DecimalString.nullable(),
    /** The plotted statistic: the value itself (I-MR) or the subgroup mean (Xbar-S). */
    plotted: StatNumber,
    spread: StatNumber.nullable(),
    rules: z.array(z.string().regex(/^NELSON_[1235]$/)),
    drill: AnalyticsDrill,
  })),
  flags: z.array(FlagView),
  skipped: z.array(SkippedSubject),
});
export type SpcChartView = z.infer<typeof SpcChartView>;

export const CapabilityView = z.strictObject({
  ...AdvisoryEnvelope,
  product: Code,
  family: Code,
  item: z.string().min(1),
  specification: SpecificationEcho,
  batches: Count,
  /** False below the minimum batches (25, D-6A-8); the indices are then null and the reason is given. */
  shown: z.boolean(),
  notShownReason: z.string().min(1).nullable(),
  cpk: StatInterval.nullable(),
  ppk: StatInterval.nullable(),
  normality: z.strictObject({ andersonDarling: StatNumber, pValue: StatNumber.nullable(), note: z.string().min(1) }).nullable(),
});
export type CapabilityView = z.infer<typeof CapabilityView>;

export const RateGrouping = z.enum(['STEP', 'EQUIPMENT', 'ROOM', 'MATERIAL_LOT', 'SUPPLIER', 'SHIFT']);
export const RatesView = z.strictObject({
  ...AdvisoryEnvelope,
  product: Code,
  by: RateGrouping,
  period: z.strictObject({ from: SiteDate, to: SiteDate }),
  /** The overall rate the groups are compared with (the funnel's centre line). */
  overall: z.strictObject({
    batches: Count,
    withDeviation: Count,
    share: StatNumber,
    /** Slice 6A-2 (optional, additive): deviations linked to a batch only, not attributed within the grouping (D-6A-10). */
    unattributedDeviations: Count.optional(),
  }),
  groups: z.array(z.strictObject({
    group: z.string().min(1),
    batches: Count,
    withDeviation: Count,
    deviations: Count,
    /** Share of batches with a deviation, with its Wilson interval. */
    share: StatInterval,
    /** Deviations per 100 batches, with its exact Poisson (Garwood) interval. */
    per100: StatInterval,
    pValue: StatNumber,
    /** Benjamini-Hochberg adjusted (D-6A-10). */
    qValue: StatNumber,
    above: z.boolean(),
    /** Slice 6A-2 (optional, additive): the funnel's comparison limits at the group's size. */
    funnel: z.strictObject({ lower: StatNumber, upper: StatNumber }).optional(),
  })),
  flags: z.array(FlagView),
  skipped: z.array(SkippedSubject),
});
export type RatesView = z.infer<typeof RatesView>;

const chartQuery = z.strictObject({ product: Code, family: Code, item: z.string().trim().min(1).max(200) });

export const analyticsSpc = {
  chart: defineRoute({
    id: 'analyticsSpc.chart',
    method: 'GET',
    path: '/api/analytics/spc',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The control chart of a critical item of a product and MBR family, with its run-rule flags (advisory; CPV support)',
    query: chartQuery,
    response: SpcChartView,
  }),
  capability: defineRoute({
    id: 'analyticsSpc.capability',
    method: 'GET',
    path: '/api/analytics/spc/capability',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Cpk and Ppk with intervals for a critical item, from 25 batches (advisory)',
    query: chartQuery,
    response: CapabilityView,
  }),
  rates: defineRoute({
    id: 'analyticsSpc.rates',
    method: 'GET',
    path: '/api/analytics/rates',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Deviation rates of a product by step, equipment, room, supplier lot or shift, each compared with the rest (advisory)',
    query: z.strictObject({ product: Code, by: RateGrouping, from: SiteDate.optional(), to: SiteDate.optional() }),
    response: RatesView,
  }),
} as const;
