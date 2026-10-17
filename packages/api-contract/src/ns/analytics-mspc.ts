/**
 * Namespace `analyticsMspc` (Phase 6A slice 6A-3; interfaces slice-6A-0-interfaces.md section 5): multivariate
 * monitoring by PCA with Hotelling's T-squared, Q residuals and contributions. GMP only, SESSION, advisory.
 */
import { z } from 'zod';
import { DecimalString, Instant, Uuid } from '../common.ts';
import { defineRoute } from '../route.ts';
import { AdvisoryEnvelope, AnalyticsDrill, FlagView, RunRef, SkippedSubject, StatNumber } from './analytics.ts';

const Count = z.number().int().nonnegative();
const Code = z.string().trim().min(1).max(64);

/**
 * The limits of a scope's model. `t2` is the limit of a new batch (F); `t2Reference` that of a reference batch (beta) and
 * `qMethod` how the Q limit was found (slice 6A-3 additions, D-6A-3-10).
 */
export const MspcLimits = z.strictObject({
  t2: StatNumber, q: StatNumber, confidence: StatNumber, t2Reference: StatNumber.optional(), qMethod: z.enum(['JACKSON_MUDHOLKAR', 'BOX']).optional(),
});

export const MspcChartView = z.strictObject({
  ...AdvisoryEnvelope,
  product: Code,
  family: Code,
  referenceSet: Uuid,
  components: z.number().int().positive(),
  explainedVariance: z.array(StatNumber),
  variables: z.array(z.string().min(1)),
  limits: MspcLimits,
  batches: z.array(z.strictObject({
    batchId: Uuid, batchNumber: z.string().min(1), reference: z.boolean(), t2: StatNumber, q: StatNumber, scores: z.array(StatNumber), flagged: z.boolean(), drill: AnalyticsDrill,
    /** Slice 6A-3 additions: when it completed, and its own T-squared limit (beta for a reference batch, F otherwise). */
    completedAt: Instant.optional(), t2Limit: StatNumber.optional(),
  })),
  flags: z.array(FlagView),
  skipped: z.array(SkippedSubject),
});
export type MspcChartView = z.infer<typeof MspcChartView>;

export const MspcBatchView = z.strictObject({
  ...AdvisoryEnvelope,
  batchId: Uuid,
  batchNumber: z.string().min(1),
  t2: StatNumber,
  q: StatNumber,
  limits: MspcLimits,
  /**
   * Each variable's recorded value (decimal text) and its contributions, largest Q contribution first. A subgroup item
   * is charted as the mean of its readings: its value is null and its readings are given (D-6A-3-10, before any consumer).
   */
  contributions: z.array(z.strictObject({
    variable: z.string().min(1), value: DecimalString.nullable(), readings: z.array(DecimalString).optional(), t2: StatNumber, q: StatNumber,
  })),
  flags: z.array(FlagView),
  drill: AnalyticsDrill,
  /** Slice 6A-3 additions: the scope, the reference set scored against and whether the batch is one of its batches. */
  product: Code.optional(),
  family: Code.optional(),
  referenceSet: Uuid.optional(),
  reference: z.boolean().optional(),
});
export type MspcBatchView = z.infer<typeof MspcBatchView>;

export const ModelCandidateView = z.strictObject({
  outputId: Uuid,
  run: RunRef,
  product: Code,
  family: Code,
  batches: Count,
  components: z.number().int().positive(),
  modelSha256: z.string().regex(/^[0-9a-f]{64}$/),
  fittedAt: Instant,
  /** The reference set made effective from it, if any. */
  referenceSet: Uuid.nullable(),
  skipped: z.array(SkippedSubject),
  /**
   * Slice 6A-3 additions: the reference batches (ids and numbers), the variables, each kept component's share of the
   * variance, the limits, and the reference batches' own T-squared and Q, for QA to review before approving it.
   */
  batchIds: z.array(Uuid).optional(),
  batchNumbers: z.array(z.string().min(1)).optional(),
  variables: z.array(z.string().min(1)).optional(),
  explainedVariance: z.array(StatNumber).optional(),
  limits: MspcLimits.optional(),
  referenceT2: z.array(StatNumber).optional(),
  referenceQ: z.array(StatNumber).optional(),
});
export type ModelCandidateView = z.infer<typeof ModelCandidateView>;

export const MspcCandidatesView = z.strictObject({ ...AdvisoryEnvelope, candidates: z.array(ModelCandidateView) });
export type MspcCandidatesView = z.infer<typeof MspcCandidatesView>;

export const analyticsMspc = {
  chart: defineRoute({
    id: 'analyticsMspc.chart',
    method: 'GET',
    path: '/api/analytics/mspc',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'T-squared and Q of the batches of a product and MBR family against the effective reference set (advisory)',
    query: z.strictObject({ product: Code, family: Code }),
    response: MspcChartView,
  }),
  batch: defineRoute({
    id: 'analyticsMspc.batch',
    method: 'GET',
    path: '/api/analytics/mspc/batches/:batchId',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'One batch\'s T-squared, Q and the contribution of each variable (advisory)',
    params: z.strictObject({ batchId: Uuid }),
    response: MspcBatchView,
  }),
  candidates: defineRoute({
    id: 'analyticsMspc.candidates',
    method: 'GET',
    path: '/api/analytics/mspc/candidates',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The model candidates QA can make effective as a reference set under a change record (advisory; DI-52)',
    response: MspcCandidatesView,
  }),
} as const;
