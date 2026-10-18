/**
 * Namespace `analytics` (Phase 6A slice 6A-0, then the lead; ADR 0020; interfaces slice-6A-0-interfaces.md section 5):
 * the catalogue, the method versions, the monitor and the flags with QA's dispositions. GMP installation only, SESSION;
 * the sandbox runs no analytics (D-6A-6).
 *
 * Every analytics response carries the advisory envelope: `advisory` and `notForGmpDecisions` (always true), the
 * method and the run it shows (null when it spans several, each item then naming its own: D-6A-0-6) and the data age.
 * Statistics are `StatNumber`, a finite JSON number; it exists only in the analytics* namespace files. A GMP value a
 * response repeats (a recorded value, a limit) is the source's decimal text, unchanged (DI-51).
 *
 * The shared shapes of the slice namespaces (analytics-spc, -mspc, -audit, -review, -profile) are defined here.
 * The namespaces join the route table (routes.ts) when the slice that serves them binds them on the server
 * (D-6A-0-4); until then each is exported with its examples (examples.ts, ANALYTICS_EXAMPLES).
 */
import { z } from 'zod';
import { Instant, PersonRef, Uuid, withAttribution } from '../common.ts';
import { defineRoute } from '../route.ts';

/** A statistic: a finite JSON number. Never a GMP value (ADR 0020 point 5). */
export const StatNumber = z.number().refine(Number.isFinite, 'a statistic is a finite number');
export type StatNumber = z.infer<typeof StatNumber>;

const Count = z.number().int().nonnegative();
/** A site-zone calendar date. */
const SiteDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date as YYYY-MM-DD');
/** A screen path of the web application (the record an item drills to). */
export const AnalyticsDrill = z.string().regex(/^\/[A-Za-z0-9/_?=&.%-]*$/).nullable();

export const AnalyticsMethodId = z.enum([
  'SPC.IMR', 'SPC.XBAR_S', 'CAP.INDEX', 'DRIFT.TREND', 'RATE.DEVIATION', 'MSPC.PCA', 'ATA.RULES', 'ATA.BASELINE', 'REVIEW.PRIORITY', 'GBP.DTW_BAND',
]);
export type AnalyticsMethodId = z.infer<typeof AnalyticsMethodId>;
export const AnalyticsSubjectKind = z.enum(['BATCH', 'PRODUCT_ITEM', 'GROUP', 'EQUIPMENT_STEP_TAG', 'PERSON', 'ACCOUNT', 'METHOD']);
export const AnalyticsOutputKind = z.enum([
  'CONTROL_CHART', 'CAPABILITY', 'DRIFT', 'RATE_COMPARISON', 'MODEL_CANDIDATE', 'MSPC_SCORE', 'AUDIT_RULE_HIT', 'AUDIT_BASELINE', 'REVIEW_PRIORITY',
  'PROFILE_DISTANCE',
]);
export const FlagSeverity = z.enum(['INFO', 'ATTENTION', 'HIGH']);
export const FlagVerdict = z.enum(['TRUE_SIGNAL', 'FALSE_ALARM', 'NOT_ASSESSABLE']);

export const MethodRef = z.strictObject({ id: AnalyticsMethodId, version: z.number().int().positive() });
export type MethodRef = z.infer<typeof MethodRef>;
/** A completed run: when its data was current and when it finished. */
export const RunRef = z.strictObject({ id: Uuid, dataAsOf: Instant, finishedAt: Instant });
export type RunRef = z.infer<typeof RunRef>;

/** The advisory envelope of every analytics response. */
export const AdvisoryEnvelope = {
  advisory: z.literal(true),
  notForGmpDecisions: z.literal(true),
  method: MethodRef.nullable(),
  run: RunRef.nullable(),
  /** Seconds between the data's currency (the run's dataAsOf, or the oldest shown) and the read. */
  dataAgeSeconds: Count,
};

export const AnalyticsReason = z.strictObject({
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  text: z.string().min(1),
  weight: StatNumber.optional(),
  evidence: z.array(z.strictObject({ kind: z.string().min(1), ref: z.string().min(1), drill: AnalyticsDrill.optional() })).optional(),
});
export type AnalyticsReason = z.infer<typeof AnalyticsReason>;

/** A subject a method could not assess, with why. */
export const SkippedSubject = z.strictObject({ subject: z.string().min(1), reason: z.string().min(1) });

export const DispositionView = z.strictObject({
  dispositionId: Uuid,
  flagId: Uuid,
  verdict: FlagVerdict,
  cause: z.string().min(10),
  deviationRef: z.string().min(1).nullable(),
  supersedes: Uuid.nullable(),
  reason: z.string().min(1).nullable(),
  person: PersonRef,
  recordedAt: Instant,
  /** True for the disposition nothing supersedes. */
  current: z.boolean(),
});
export type DispositionView = z.infer<typeof DispositionView>;

export const FlagView = z.strictObject({
  flagId: Uuid,
  method: MethodRef,
  run: RunRef,
  subjectKind: AnalyticsSubjectKind,
  subjectRef: z.string().min(1),
  /** What the subject is called on screen (a batch number, a product and item, a person's name). */
  subjectLabel: z.string().min(1),
  rule: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  severity: FlagSeverity,
  reasons: z.array(AnalyticsReason).min(1),
  raisedAt: Instant,
  /** About a PERSON or an ACCOUNT: shown only with ANALYTICS.DI_REVIEW (DI-53). */
  restricted: z.boolean(),
  disposition: DispositionView.nullable(),
  drill: AnalyticsDrill,
  /**
   * Slice 6A-3 (D-6A-3-9), in the open-flags list: how often later runs raised the same hit (same method version,
   * subject, rule, severity and reasons) and when it was first raised; the flag shown is the latest raise.
   */
  raisedCount: z.number().int().positive().optional(),
  firstRaisedAt: Instant.optional(),
});
export type FlagView = z.infer<typeof FlagView>;

export const AnalyticsCatalogView = z.strictObject({
  ...AdvisoryEnvelope,
  methods: z.array(z.strictObject({
    id: AnalyticsMethodId,
    title: z.string().min(1),
    intendedUse: z.string().min(1),
    slice: z.string().regex(/^6A-[0-9]$/),
    outputKinds: z.array(AnalyticsOutputKind),
    flagRules: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)),
    inputs: z.array(z.string().min(1)),
    /** Always false: no analytics output changes GMP data (PR-60). */
    changesGmpData: z.literal(false),
    /** The versions EFFECTIVE now (none until QA makes one effective under a change record). */
    effectiveVersions: z.array(z.number().int().positive()),
  })),
  inputs: z.array(z.strictObject({
    name: z.string().min(1), kind: z.enum(['VIEW', 'FUNCTION']), version: z.number().int().positive(), ownerSlice: z.string().min(1), grain: z.string().min(1),
  })),
});
export type AnalyticsCatalogView = z.infer<typeof AnalyticsCatalogView>;

export const MethodVersionView = z.strictObject({
  method: AnalyticsMethodId,
  version: z.number().int().positive(),
  status: z.enum(['EFFECTIVE', 'RETIRED']),
  title: z.string().min(1),
  intendedUse: z.string().min(1),
  acceptance: z.record(z.string(), z.unknown()),
  parametersSha256: z.string().regex(/^[0-9a-f]{64}$/),
  codeIdentity: z.string().min(1),
  validationRef: z.string().min(1),
  validFrom: Instant,
  /** When the next row of the same version took effect (null: still the latest). */
  validTo: Instant.nullable(),
  changeRecord: z.string().min(1).nullable(),
});
export type MethodVersionView = z.infer<typeof MethodVersionView>;

export const AnalyticsMethodsView = z.strictObject({ ...AdvisoryEnvelope, versions: z.array(MethodVersionView) });
export type AnalyticsMethodsView = z.infer<typeof AnalyticsMethodsView>;

export const AnalyticsMonitorView = z.strictObject({
  ...AdvisoryEnvelope,
  rows: z.array(z.strictObject({
    method: AnalyticsMethodId,
    version: z.number().int().positive(),
    month: z.string().regex(/^\d{4}-\d{2}$/),
    runs: Count,
    /** FAILED runs and runs unended an hour after they started (D-6A-0-3). */
    failures: Count,
    /** Null for an audit-trail method (ATA.*) read without ANALYTICS.DI_REVIEW: restricted, with its shares (DI-53, kernel 1322). */
    flags: Count.nullable(),
    dispositionedShare: StatNumber.nullable(),
    falseAlarmRate: StatNumber.nullable(),
  })),
});
export type AnalyticsMonitorView = z.infer<typeof AnalyticsMonitorView>;

export const AnalyticsFlagsView = z.strictObject({ ...AdvisoryEnvelope, flags: z.array(FlagView) });
export type AnalyticsFlagsView = z.infer<typeof AnalyticsFlagsView>;

export const AnalyticsFlagView = z.strictObject({ ...AdvisoryEnvelope, flag: FlagView, dispositions: z.array(DispositionView) });
export type AnalyticsFlagView = z.infer<typeof AnalyticsFlagView>;

export const AnalyticsDispositionResult = z.strictObject({ ...AdvisoryEnvelope, disposition: DispositionView });
export type AnalyticsDispositionResult = z.infer<typeof AnalyticsDispositionResult>;

export const analytics = {
  catalog: defineRoute({
    id: 'analytics.catalog',
    method: 'GET',
    path: '/api/analytics/catalog',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The analytics catalogue: every method with its intended use, inputs and "changes GMP data: no", and the inputs the analytics role reads (PR-60; advisory)',
    response: AnalyticsCatalogView,
  }),
  methods: defineRoute({
    id: 'analytics.methods',
    method: 'GET',
    path: '/api/analytics/methods',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Every method version with its intended use, parameters hash, validation reference, validity and change record (DI-52; advisory)',
    response: AnalyticsMethodsView,
  }),
  monitor: defineRoute({
    id: 'analytics.monitor',
    method: 'GET',
    path: '/api/analytics/monitor',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Per method version and month: runs, failures, flags, the dispositioned share and the false-alarm rate (DI-52; advisory)',
    response: AnalyticsMonitorView,
  }),
  flags: defineRoute({
    id: 'analytics.flags',
    method: 'GET',
    path: '/api/analytics/flags',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The flags the person may see in a period (open by default; flags about a person only with ANALYTICS.DI_REVIEW; advisory)',
    query: z.strictObject({ from: SiteDate.optional(), to: SiteDate.optional(), kind: AnalyticsSubjectKind.optional() }),
    response: AnalyticsFlagsView,
  }),
  flag: defineRoute({
    id: 'analytics.flag',
    method: 'GET',
    path: '/api/analytics/flags/:flagId',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'One flag with its reasons and its dispositions (advisory)',
    params: z.strictObject({ flagId: Uuid }),
    response: AnalyticsFlagView,
  }),
  dispose: defineRoute({
    id: 'analytics.dispose',
    method: 'POST',
    path: '/api/analytics/flags/:flagId/dispositions',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Record QA\'s verdict on a flag (true signal, false alarm, not assessable) with its cause; a later one supersedes the current one with a reason (DI-52)',
    params: z.strictObject({ flagId: Uuid }),
    body: withAttribution({
      verdict: FlagVerdict,
      cause: z.string().trim().min(10).max(2000),
      deviationRef: z.string().trim().min(1).max(64).nullable().optional(),
      supersedes: Uuid.nullable().optional(),
      reason: z.string().trim().min(1).max(2000).nullable().optional(),
    }),
    response: AnalyticsDispositionResult,
  }),
} as const;
