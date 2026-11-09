/**
 * The full deviation stand-in over HTTP (Phase 4 slice 2a; outline 5.2.5; plan D-P4-2; site services 0820 to 0823). These
 * routes join the `quality` namespace (spread into it by ns/quality.ts): QA's classification when the investigation starts
 * (IN-02) and later, the impact on each linked subject per market, the closure basis (root-cause method, system factors,
 * CAPA references, regulatory-notification assessment, other batches assessed), the detail of a record and the release
 * checklist of a subject (INV-46, L-21). Every rule is the database's.
 *
 * Signed acts are QUALITY_ACT: DEVIATION_IMPACT_ASSESS (DEVIATION_IMPACT_ASSESSED, QA neither the initiator nor the
 * owner), DEVIATION_CONCLUDE (IMPACT_ASSESSED -> PENDING_CLOSURE) and DEVIATION_CLOSE (PENDING_CLOSURE -> CLOSED).
 */
import { z } from 'zod';
import { Uuid } from '../common.ts';
import { defineRoute } from '../route.ts';

/** The states of a record (site.deviation_state, 0820): deviation-lite's CONCLUDED reads as PENDING_CLOSURE (D-P4-2). */
export const DeviationState = z.enum(['OPEN', 'UNDER_INVESTIGATION', 'IMPACT_ASSESSED', 'PENDING_CLOSURE', 'CLOSED', 'CANCELLED']);
export type DeviationState = z.infer<typeof DeviationState>;

const Classification = z.enum(['MINOR', 'MAJOR', 'CRITICAL']);
const Market = z.enum(['IN', 'US', 'EU']);
const Impact = z.enum(['NONE', 'POTENTIAL', 'CONFIRMED']);
const SubjectKind = z.enum(['BATCH', 'LOT', 'CONTAINER']);
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const deviationParams = z.strictObject({ deviationId: Uuid });

/** QA's classification (IN-02): the risk rationale is always written; the owner investigates; the due date is a date. */
export const DeviationClassificationInput = z.strictObject({
  classification: Classification,
  riskRationale: z.string().trim().min(10).max(4000),
  ownerPersonId: Uuid,
  dueDate: IsoDate,
  riskDocumentId: Uuid.optional(),
});
export type DeviationClassificationInput = z.infer<typeof DeviationClassificationInput>;

export const DeviationClosureBasisInput = z.strictObject({
  rootCauseMethod: z.string().trim().min(3).max(400).optional(),
  systemFactors: z
    .strictObject({ process: z.string().trim().min(10).max(4000), procedure: z.string().trim().min(10).max(4000), system: z.string().trim().min(10).max(4000) })
    .optional(),
  capaRefs: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9/._-]{1,39}$/)).max(50),
  noCapaReason: z.string().trim().min(10).max(4000).optional(),
  notificationRequired: z.boolean(),
  notificationRationale: z.string().trim().min(10).max(4000),
  authorityReference: z.string().trim().min(1).max(200).optional(),
  otherBatches: z
    .array(z.strictObject({ subjectKind: z.enum(['BATCH', 'PRODUCT', 'LOT']), ref: z.string().trim().min(1).max(200), included: z.boolean(), reason: z.string().trim().min(5).max(2000) }))
    .min(1)
    .max(500),
});
export type DeviationClosureBasisInput = z.infer<typeof DeviationClosureBasisInput>;

export const DeviationDetailView = z.strictObject({
  deviationId: Uuid,
  ref: z.string(),
  kind: z.enum(['DEVIATION', 'OOS', 'INVESTIGATION']),
  title: z.string(),
  state: DeviationState,
  /** The initiator's classification when raised. */
  raisedClassification: Classification,
  raisedBy: Uuid,
  /** QA's latest classification (null while OPEN). */
  qaClassification: z
    .strictObject({ classification: Classification, riskRationale: z.string(), ownerPersonId: Uuid, dueDate: IsoDate, riskDocumentId: Uuid.nullable(), classifiedBy: Uuid })
    .nullable(),
  links: z.array(
    z.strictObject({
      linkId: Uuid,
      subjectKind: SubjectKind,
      subjectId: Uuid,
      subjectRef: z.string(),
      batchNumber: z.string().nullable(),
      /** The latest impact per market; signed is whether QA's latest sign-off covers it. */
      impacts: z.array(z.strictObject({ market: Market, impact: Impact, rationale: z.string(), signed: z.boolean() })),
    }),
  ),
  impactCurrent: z.boolean(),
  finding: z
    .strictObject({ assignableCause: z.boolean(), cause: z.string(), rootCauseCategory: z.string(), recordedBy: Uuid })
    .nullable(),
  closureBasis: DeviationClosureBasisInput.extend({ recordedBy: Uuid }).nullable(),
  cancelReason: z.string().nullable(),
});
export type DeviationDetailView = z.infer<typeof DeviationDetailView>;

export const DeviationReleaseItem = z.strictObject({
  deviationId: Uuid,
  ref: z.string(),
  kind: z.enum(['DEVIATION', 'OOS', 'INVESTIGATION']),
  state: DeviationState,
  classification: Classification,
  cancelled: z.boolean(),
  blocking: z.boolean(),
  reason: z.string().nullable(),
  cancelledBy: Uuid.nullable(),
});
export type DeviationReleaseItem = z.infer<typeof DeviationReleaseItem>;

/**
 * Platform slice 2 (owner ruling, 9 November 2026): where the server has a Deviations link, a batch's deviation is its
 * Deviations number, and its status is read from the view Deviations publishes (report.deviation_v1). Closed and
 * rejected are resolved; anything else, and a number Deviations does not have (status null), blocks release.
 */
export const LinkedDeviation = z.strictObject({
  number: z.string(),
  batchId: Uuid,
  batchNumber: z.string(),
  status: z.enum(['classification', 'approval', 'investigation', 'closure', 'closed', 'rejected']).nullable(),
  classification: z.string().nullable(),
  blocking: z.boolean(),
  linkedAt: z.string(),
  /** When Deviations last had the record as read (the view's data_as_of); null when the view has no row. */
  dataAsOf: z.string().nullable(),
});
export type LinkedDeviation = z.infer<typeof LinkedDeviation>;
const batchParams = z.strictObject({ batchId: Uuid });

export const deviationRoutes = {
  deviationDetail: defineRoute({
    id: 'quality.deviationDetail',
    method: 'GET',
    path: '/api/quality/deviations/:deviationId/detail',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'A deviation record in full: QA classification, links with their impact per market, finding, closure basis',
    params: deviationParams,
    response: DeviationDetailView,
  }),
  reclassifyDeviation: defineRoute({
    id: 'quality.reclassifyDeviation',
    method: 'POST',
    path: '/api/quality/deviations/:deviationId/classification',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'QA reclassifies a record under investigation (IN-02: with the risk rationale; never the initiator)',
    params: deviationParams,
    body: DeviationClassificationInput,
    response: DeviationDetailView,
  }),
  recordDeviationImpact: defineRoute({
    id: 'quality.recordDeviationImpact',
    method: 'POST',
    path: '/api/quality/deviations/:deviationId/impacts',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'Record the impact on one linked subject for one market (QA signs the assessment as DEVIATION_IMPACT_ASSESS)',
    params: deviationParams,
    body: z.strictObject({ linkId: Uuid, market: Market, impact: Impact, rationale: z.string().trim().min(10).max(4000) }),
    response: DeviationDetailView,
  }),
  recordDeviationClosureBasis: defineRoute({
    id: 'quality.recordDeviationClosureBasis',
    method: 'POST',
    path: '/api/quality/deviations/:deviationId/closure-basis',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'Record what PENDING_CLOSURE needs: root-cause method, system factors, CAPA, regulatory notification, other batches',
    params: deviationParams,
    body: DeviationClosureBasisInput,
    response: DeviationDetailView,
  }),
  deviationRelease: defineRoute({
    id: 'quality.deviationRelease',
    method: 'GET',
    path: '/api/quality/deviation-release',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The deviations linked to a batch, lot or container as the release checklist lists them, and why release is blocked',
    query: z.strictObject({ subjectKind: SubjectKind, subjectId: Uuid, market: Market.optional() }),
    /** `linked`: the Deviations numbers of the subject's batches, where the server has a Deviations link (slice 2). */
    response: z.strictObject({ items: z.array(DeviationReleaseItem), problem: z.string().nullable(), linked: z.array(LinkedDeviation).optional() }),
  }),
  deviationNumbers: defineRoute({
    id: 'quality.deviationNumbers',
    method: 'GET',
    path: '/api/quality/batches/:batchId/deviation-numbers',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The Deviations numbers linked to a batch, with each status as the Deviations product publishes it (Deviations link only)',
    params: batchParams,
    response: z.strictObject({ deviations: z.array(LinkedDeviation) }),
  }),
  linkDeviationNumber: defineRoute({
    id: 'quality.linkDeviationNumber',
    method: 'POST',
    path: '/api/quality/batches/:batchId/deviation-numbers',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'Link a deviation raised in the Deviations product to a batch by its number (Deviations link only)',
    params: batchParams,
    body: z.strictObject({ number: z.string().trim().min(1).max(64) }),
    response: z.strictObject({ deviations: z.array(LinkedDeviation) }),
  }),
} as const;
