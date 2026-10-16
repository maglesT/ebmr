/**
 * Namespaces `dashboards`, `changeImpact` (GMP) and `training` (SANDBOX) (Phase 6 slice 6g-0; kernel 1210, 1211;
 * recipe-core 1070, 1071; D-P6g-0-1 to 9).
 *
 *  - dashboards: read-only views over the report views (outline 7.3: never used for GMP decisions). Each response states
 *    when its data was current (`dataAsOf`), when it was read (`readAt`) and the age in whole seconds, and each row a
 *    `drill` path to the record screen. Ratios, hours and quantities are decimal text; counts are whole numbers.
 *  - changeImpact: what a proposed change reaches, from the database's recipe.change_impact, with the SHA-256 of the
 *    canonical rows for the change record. Read-only.
 *  - training: training mode is the sandbox installation (DI-05): the TEST, NOT GMP watermark, the sandbox personas, the
 *    scripted exercises and the person's own attempts, kept in the sandbox only.
 */
import { z } from 'zod';
import { DecimalString, Instant, Uuid, Watermark } from '../common.ts';
import { defineRoute } from '../route.ts';

/** A site-zone calendar date. */
export const SiteDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date as YYYY-MM-DD');
const Count = z.number().int().nonnegative();
/** A screen path of the web application (the record a dashboard row drills to). */
const Drill = z.string().regex(/^\/[A-Za-z0-9/_?=&.-]*$/).nullable();

const periodQuery = { from: SiteDate.optional(), to: SiteDate.optional() };

export const DataAge = {
  dataAsOf: Instant,
  readAt: Instant,
  dataAgeSeconds: Count,
  /** Always true: the dashboards inform; GMP decisions are taken on the records (outline 7.3). */
  notForGmpDecisions: z.literal(true),
};
export const Period = z.strictObject({ from: SiteDate, to: SiteDate });

export const RightFirstTimeView = z.strictObject({
  ...DataAge,
  period: Period,
  summary: z.strictObject({ batches: Count, rightFirstTime: Count, rate: DecimalString.nullable() }),
  /** Per site-zone day of the QA review: batches reviewed and how many right first time (a plain run chart). */
  runChart: z.array(z.strictObject({ day: SiteDate, batches: Count, rightFirstTime: Count })),
  batches: z.array(z.strictObject({
    batchId: Uuid, batchNumber: z.string().min(1), productCode: z.string().nullable(), qaReviewedAt: Instant, rightFirstTime: z.boolean(),
    exceptionCount: Count, deviationCount: Count, reviewCycles: Count, drill: Drill,
  })),
});
export type RightFirstTimeView = z.infer<typeof RightFirstTimeView>;

export const ExceptionParetoView = z.strictObject({
  ...DataAge,
  period: Period,
  total: Count,
  categories: z.array(z.strictObject({
    category: z.string().min(1), count: Count, cumulativePercent: DecimalString,
    batches: z.array(z.strictObject({ batchId: Uuid, batchNumber: z.string().min(1), drill: Drill })),
  })),
});
export type ExceptionParetoView = z.infer<typeof ExceptionParetoView>;

export const ReviewCycleTimeView = z.strictObject({
  ...DataAge,
  period: Period,
  summary: z.strictObject({ batches: Count, medianDays: DecimalString.nullable(), maxDays: DecimalString.nullable() }),
  batches: z.array(z.strictObject({
    batchId: Uuid, batchNumber: z.string().min(1), completedAt: Instant, qaReviewedAt: Instant, cycleDays: DecimalString, reviewCycles: Count, drill: Drill,
  })),
});
export type ReviewCycleTimeView = z.infer<typeof ReviewCycleTimeView>;

export const AgeingBucket = z.enum(['0-30', '31-60', '61-90', '>90']);
export const DeviationAgeingView = z.strictObject({
  ...DataAge,
  buckets: z.array(z.strictObject({ bucket: AgeingBucket, count: Count })),
  open: z.array(z.strictObject({
    deviationId: Uuid, ref: z.string().min(1), kind: z.string().min(1), classification: z.string().min(1), state: z.string().min(1),
    raisedAt: Instant, ageDays: Count, bucket: AgeingBucket, drill: Drill,
  })),
});
export type DeviationAgeingView = z.infer<typeof DeviationAgeingView>;

export const HoldRisk = z.enum(['OK', 'AT_RISK', 'OVER']);
export const HoldTimeRiskView = z.strictObject({
  ...DataAge,
  summary: z.strictObject({ held: Count, atRisk: Count, over: Count }),
  containers: z.array(z.strictObject({
    containerId: Uuid, labelCode: z.string().min(1), batchId: Uuid, batchNumber: z.string().min(1), productCode: z.string().min(1), strength: z.string().min(1),
    closedAt: Instant, maxHoldHours: Count, heldHours: DecimalString, usedPercent: DecimalString, risk: HoldRisk, drill: Drill,
  })),
});
export type HoldTimeRiskView = z.infer<typeof HoldTimeRiskView>;

export const OverdueReviewsView = z.strictObject({
  ...DataAge,
  versions: z.array(z.strictObject({
    versionId: Uuid, documentId: z.string().min(1), familyCode: z.string().min(1), versionNumber: z.number().int().positive(),
    reviewDue: SiteDate, daysOverdue: Count, lastReviewAt: Instant.nullable(), inUse: z.boolean(), drill: Drill,
  })),
});
export type OverdueReviewsView = z.infer<typeof OverdueReviewsView>;

export const PressOeeView = z.strictObject({
  ...DataAge,
  period: Period,
  presses: z.array(z.strictObject({
    equipmentId: Uuid, equipmentCode: z.string().min(1), batchId: Uuid, batchNumber: z.string().min(1), from: Instant, to: Instant,
    runningSeconds: DecimalString, observedSeconds: DecimalString, tablets: DecimalString.nullable(), rejects: DecimalString.nullable(),
    /** RUNNING time over observed time (D-P6g-0-6). */
    availability: DecimalString.nullable(),
    /** Good over counted. */
    quality: DecimalString.nullable(),
    /** Availability times quality; performance needs a rated speed master data does not hold (D-P6g-0-6). */
    oee: DecimalString.nullable(),
    drill: Drill,
  })),
});
export type PressOeeView = z.infer<typeof PressOeeView>;

export const AlarmTrendView = z.strictObject({
  ...DataAge,
  period: Period,
  /** Every alarm raised (source time) in the period, counted once (D-P6g-0-7). */
  total: Count,
  gmpCritical: Count,
  byDay: z.array(z.strictObject({ day: SiteDate, count: Count })),
  byCode: z.array(z.strictObject({ alarmCode: z.string().min(1), count: Count, gmpCritical: Count, batches: Count })),
  /** The alarms themselves, newest first; at most 500 (`listTruncated`); the counts above are never cut. */
  alarms: z.array(z.strictObject({
    alarmId: Uuid, alarmCode: z.string().min(1), source: z.string().min(1), subjectCode: z.string().nullable(), raisedAt: Instant, gmpCritical: z.boolean(),
    acknowledged: z.boolean(), batchNumbers: z.array(z.string()), drill: Drill,
  })),
  listTruncated: z.boolean(),
});
export type AlarmTrendView = z.infer<typeof AlarmTrendView>;

export const ReportCatalogView = z.strictObject({
  ...DataAge,
  views: z.array(z.strictObject({
    viewName: z.string().regex(/^[a-z][a-z0-9_]*_v[1-9][0-9]*$/), version: z.number().int().positive(), grain: z.string().min(1), description: z.string().min(1),
    columns: z.array(z.strictObject({ name: z.string().min(1), type: z.string().min(1) })),
  })),
});
export type ReportCatalogView = z.infer<typeof ReportCatalogView>;

/** The documented export of one report view: its columns and rows as text (values exactly as the database writes them). */
export const ReportExportView = z.strictObject({
  ...DataAge,
  viewName: z.string().min(1),
  columns: z.array(z.string().min(1)),
  rows: z.array(z.array(z.string().nullable())),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ReportExportView = z.infer<typeof ReportExportView>;

const dashboard = <S extends z.ZodType>(name: string, path: string, summary: string, response: S, withPeriod = true) =>
  defineRoute({
    id: `dashboards.${name}`,
    method: 'GET',
    path: `/api/dashboards/${path}`,
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary,
    query: withPeriod ? z.strictObject(periodQuery) : z.strictObject({}),
    response,
  });

export const dashboards = {
  rightFirstTime: dashboard('rightFirstTime', 'right-first-time', 'Right-first-time batches by QA review day, with each batch (never used for GMP decisions)', RightFirstTimeView),
  exceptionPareto: dashboard('exceptionPareto', 'exception-pareto', 'Register exceptions by category, largest first, with the cumulative share', ExceptionParetoView),
  reviewCycleTime: dashboard('reviewCycleTime', 'review-cycle-time', 'Days from execution complete to QA review per batch', ReviewCycleTimeView),
  deviationAgeing: dashboard('deviationAgeing', 'deviation-ageing', 'Open deviations by age bucket', DeviationAgeingView, false),
  holdTimeRisk: dashboard('holdTimeRisk', 'hold-time-risk', 'Closed bulk containers against their bright-stock maximum hold', HoldTimeRiskView, false),
  overdueReviews: dashboard('overdueReviews', 'overdue-reviews', 'Approved MBR versions past their periodic review (PR-05)', OverdueReviewsView, false),
  pressOee: dashboard('pressOee', 'press-oee', 'Press availability and quality per batch from the state events and counters (D-P6g-0-6)', PressOeeView),
  alarmTrend: dashboard('alarmTrend', 'alarm-trend', 'Plant alarms across batches by day and code (DI-49)', AlarmTrendView),
  catalog: dashboard('catalog', 'catalog', 'The report views, their versions, grains and columns (the analytics path)', ReportCatalogView, false),
  export: defineRoute({
    id: 'dashboards.export',
    method: 'GET',
    path: '/api/dashboards/export',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The rows of one report view as text, with their SHA-256 (the documented export)',
    query: z.strictObject({ view: z.string().regex(/^[a-z][a-z0-9_]*_v[1-9][0-9]*$/) }),
    response: ReportExportView,
  }),
} as const;

// ---------------------------------------------------------------------------------------------
// Change impact
// ---------------------------------------------------------------------------------------------

export const ChangeImpactKind = z.enum(['MATERIAL', 'SPECIFICATION', 'EQUIPMENT', 'MBR_VERSION', 'SITE_VALUE', 'SUPPLIER']);
export type ChangeImpactKind = z.infer<typeof ChangeImpactKind>;

export const ChangeImpactItem = z.strictObject({
  id: Uuid.nullable(),
  label: z.string().min(1),
  detail: z.string().nullable(),
  via: z.string().nullable(),
  drill: Drill,
});
export type ChangeImpactItem = z.infer<typeof ChangeImpactItem>;

export const ChangeImpactView = z.strictObject({
  kind: ChangeImpactKind,
  ref: z.string().min(1),
  generatedAt: Instant,
  /** SHA-256 of the canonical JSON of kind, ref and the five lists (not of the time): the same answer gives the same hash. */
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  counts: z.strictObject({ versions: Count, openBatches: Count, releasedLots: Count, markets: Count, configHistory: Count }),
  versions: z.array(ChangeImpactItem),
  openBatches: z.array(ChangeImpactItem),
  releasedLots: z.array(ChangeImpactItem),
  markets: z.array(ChangeImpactItem),
  configHistory: z.array(ChangeImpactItem),
});
export type ChangeImpactView = z.infer<typeof ChangeImpactView>;

export const changeImpact = {
  query: defineRoute({
    id: 'changeImpact.query',
    method: 'GET',
    path: '/api/change-impact',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'What a proposed change reaches: MBR versions, open batches, released lots, markets and configuration history (read-only)',
    query: z.strictObject({ kind: ChangeImpactKind, ref: z.string().trim().min(1).max(128) }),
    response: ChangeImpactView,
  }),
} as const;

// ---------------------------------------------------------------------------------------------
// Training mode (sandbox)
// ---------------------------------------------------------------------------------------------

export const TrainingPersonaView = z.strictObject({
  personId: Uuid,
  legalName: z.string().min(1),
  loginName: z.string().min(1),
  roles: z.array(z.string().min(1)),
});
export type TrainingPersonaView = z.infer<typeof TrainingPersonaView>;

export const TrainingAttemptView = z.strictObject({
  attemptId: Uuid,
  exerciseCode: z.string().min(1),
  exerciseVersion: z.number().int().positive(),
  startedAt: Instant,
  done: z.array(z.number().int().positive()),
  complete: z.boolean(),
});
export type TrainingAttemptView = z.infer<typeof TrainingAttemptView>;

export const TrainingExerciseView = z.strictObject({
  code: z.string().regex(/^[A-Z][A-Z0-9_-]{1,39}$/),
  version: z.number().int().positive(),
  title: z.string().min(1),
  summary: z.string().min(1),
  /** The roles the exercise is done in (sign in as a training persona holding it). */
  roles: z.array(z.string().min(1)),
  steps: z.array(z.strictObject({ no: z.number().int().positive(), instruction: z.string().min(1), screen: z.string().regex(/^\/[A-Za-z0-9/_-]*$/) })),
  attempts: z.array(TrainingAttemptView),
});
export type TrainingExerciseView = z.infer<typeof TrainingExerciseView>;

export const TrainingOverviewView = z.strictObject({
  watermark: Watermark,
  personas: z.array(TrainingPersonaView),
  exercises: z.array(TrainingExerciseView),
});
export type TrainingOverviewView = z.infer<typeof TrainingOverviewView>;

export const training = {
  overview: defineRoute({
    id: 'training.overview',
    method: 'GET',
    path: '/api/training',
    installation: 'SANDBOX',
    auth: 'SESSION',
    mutating: false,
    summary: 'Training mode (sandbox only, TEST, NOT GMP): personas, exercises and the person\'s attempts (DI-05)',
    response: TrainingOverviewView,
  }),
  start: defineRoute({
    id: 'training.start',
    method: 'POST',
    path: '/api/training/attempts',
    installation: 'SANDBOX',
    auth: 'SESSION',
    mutating: true,
    summary: 'Start an attempt of a training exercise (kept in the sandbox only; DI-05)',
    body: z.strictObject({ exerciseCode: z.string().regex(/^[A-Z][A-Z0-9_-]{1,39}$/) }),
    response: TrainingAttemptView,
  }),
  completeStep: defineRoute({
    id: 'training.completeStep',
    method: 'POST',
    path: '/api/training/attempts/:attemptId/steps',
    installation: 'SANDBOX',
    auth: 'SESSION',
    mutating: true,
    summary: 'Mark a step of one\'s own training attempt done (DI-05)',
    params: z.strictObject({ attemptId: Uuid }),
    body: z.strictObject({ step: z.number().int().positive().max(50) }),
    response: TrainingAttemptView,
  }),
} as const;
