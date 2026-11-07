/**
 * Namespace `specifications` (Phase 4 slice 2b, GMP): approved specifications per material with the pharmacopoeia and
 * edition of every limit (IN-33), editions marked effective and the review list of specifications citing an older one,
 * the QA proposal of a lot status decision (HOLD, UNHOLD, RETURN, RECALL; D-P4-3) and the finished lot of a packaging
 * order posted in quarantine (IN-05 (a), PR-45). Every rule is the database's (site services 0840 to 0842, tablets 1150).
 *
 * Signed acts are the signable action LIMS_ACT (SPECIFICATION_APPROVE: SPECIFICATION_APPROVED by another person than
 * the drafter) and LOT_DECISION (its HOLD, UNHOLD, RETURN and RECALL sign MATERIAL_LOT_STATUS_DECIDED over the lot's
 * content, which names the decision QA proposed here first).
 */
import { z } from 'zod';
import { DecimalString, Instant, PersonRef, Uuid, withAttribution } from '../common.ts';
import { defineRoute } from '../route.ts';

const Code = z.string().regex(/^[A-Z0-9][A-Z0-9/._-]{0,39}$/);
const TestCode = z.string().regex(/^[A-Z0-9][A-Z0-9_.-]{0,39}$/);
const Unit = z.string().regex(/^[!-~]{1,32}$/);
export const Pharmacopoeia = z.enum(['IP', 'BP', 'PH_EUR', 'USP', 'IN_HOUSE']);
const Edition = z.string().trim().min(1).max(32);

const PointLabel = z.string().regex(/^[!-~]( ?[!-~]){0,31}$/, 'a short label such as 1 h or 60 min');
const StageLabel = z.string().regex(/^[!-~]( ?[!-~]){0,47}$/, 'a short label of the stage and its medium, e.g. Acid 0.1 M HCl');

/**
 * One time point of a profile test (slice 7p, site services 1720): its label, time with unit and its own limits; a
 * two-stage test names the stage (and medium) of each point, and the time starts again in each stage (R8 C4).
 */
export const ProfilePointInput = z.strictObject({
  label: PointLabel,
  stage: StageLabel.optional(),
  timeValue: z.string().regex(/^(0|[1-9][0-9]{0,5})(\.[0-9]{1,3})?$/, 'the time as decimal text, e.g. 60 or 1.5'),
  timeUnit: z.enum(['min', 'h']),
  lowerLimit: DecimalString.optional(),
  upperLimit: DecimalString.optional(),
});
export type ProfilePointInput = z.infer<typeof ProfilePointInput>;

export const ProfilePointView = z.strictObject({
  pointNo: z.number().int().positive(),
  label: z.string(),
  stage: z.string().nullable(),
  timeValue: DecimalString,
  timeUnit: z.enum(['min', 'h']),
  lowerLimit: DecimalString.nullable(),
  upperLimit: DecimalString.nullable(),
});
export type ProfilePointView = z.infer<typeof ProfilePointView>;

export const SpecificationTestInput = z.strictObject({
  testCode: TestCode,
  methodReference: z.string().trim().min(1).max(128),
  unit: Unit,
  lowerLimit: DecimalString.optional(),
  upperLimit: DecimalString.optional(),
  /** Required for release (a lot without a current result of it is not released). */
  required: z.boolean(),
  /** The source of the limit and its edition (IN-33); IN_HOUSE cites its document version. */
  pharmacopoeia: Pharmacopoeia,
  edition: Edition,
  /** What one run of the test takes; the reserve sample is twice the sum (PR-44, IN-32). */
  sampleQuantity: DecimalString,
  sampleUnit: Unit,
  /** A profile (e.g. a dissolution profile): its ordered time points carry the limits; the test then has none (slice 7p). */
  points: z.array(ProfilePointInput).min(2).max(24).optional(),
});
export type SpecificationTestInput = z.infer<typeof SpecificationTestInput>;

export const SpecificationView = z.strictObject({
  specificationId: Uuid,
  siteCode: z.string(),
  materialCode: z.string(),
  version: z.number().int().positive(),
  title: z.string(),
  monographReference: z.string(),
  /** DRAFT, APPROVED (in effect) or SUPERSEDED. */
  state: z.enum(['DRAFT', 'APPROVED', 'SUPERSEDED']),
  tests: z.array(
    z.strictObject({
      testCode: z.string(),
      methodReference: z.string(),
      unit: z.string(),
      lowerLimit: DecimalString.nullable(),
      upperLimit: DecimalString.nullable(),
      required: z.boolean(),
      pharmacopoeia: Pharmacopoeia,
      edition: z.string(),
      sampleQuantity: DecimalString,
      sampleUnit: z.string(),
      /** The time points of a profile test (slice 7p); absent for a single test. */
      points: z.array(ProfilePointView).optional(),
    }),
  ),
  draftedBy: PersonRef,
  draftedAt: Instant,
  approvedBy: PersonRef.nullable(),
  approvedAt: Instant.nullable(),
});
export type SpecificationView = z.infer<typeof SpecificationView>;

export const EditionReviewItem = z.strictObject({
  specificationId: Uuid,
  siteCode: z.string(),
  materialCode: z.string(),
  version: z.number().int().positive(),
  testCode: z.string(),
  pharmacopoeia: Pharmacopoeia,
  cited: z.string(),
  effective: z.string(),
});
export type EditionReviewItem = z.infer<typeof EditionReviewItem>;

/** A master-record version whose limits cite an edition older than the one effective now (IN-33; recipe-core 1061). */
export const MbrEditionReviewItem = z.strictObject({
  familyId: Uuid,
  familyCode: z.string(),
  productCode: z.string(),
  versionId: Uuid,
  versionNumber: z.number().int().positive(),
  state: z.string().nullable(),
  /** The id (or title) of the limit, calculation or acceptance criterion that cites the edition. */
  citedIn: z.string(),
  pharmacopoeia: z.string(),
  cited: z.string(),
  effective: z.string(),
});
export type MbrEditionReviewItem = z.infer<typeof MbrEditionReviewItem>;

/** Why a lot is not released yet on its results and samples, in the database's words (null when nothing stands). */
export const LotReleaseCheckView = z.strictObject({
  lotId: Uuid,
  specificationId: Uuid.nullable(),
  limsProblem: z.string().nullable(),
  sampleProblem: z.string().nullable(),
});
export type LotReleaseCheckView = z.infer<typeof LotReleaseCheckView>;

export const LotDecisionProposalView = z.strictObject({
  proposalId: Uuid,
  lotId: Uuid,
  event: z.enum(['HOLD', 'UNHOLD', 'RETURN', 'RECALL', 'RELEASE_FOR_FURTHER_PROCESSING']),
  fromState: z.string(),
  /** The lot's state version the proposal was made at (a later change voids it). */
  version: z.string(),
});
export type LotDecisionProposalView = z.infer<typeof LotDecisionProposalView>;

export const FinishedLotView = z.strictObject({
  lotId: Uuid,
  lotCode: z.string(),
  batchId: Uuid,
  productCode: z.string(),
  status: z.string(),
  quantity: DecimalString,
  unit: z.string(),
  markets: z.array(z.string()),
  expiry: Instant,
});
export type FinishedLotView = z.infer<typeof FinishedLotView>;

/** API plan A2 (C1): the intermediate lot of a processing batch of the API edition (site-services 1732, substance 5004). */
export const IntermediateLotView = z.strictObject({
  lotId: Uuid,
  lotCode: z.string(),
  batchId: Uuid,
  materialCode: z.string(),
  status: z.string(),
  quantity: DecimalString,
  unit: z.string(),
  expiry: Instant,
});
export type IntermediateLotView = z.infer<typeof IntermediateLotView>;

export const specifications = {
  list: defineRoute({
    id: 'specifications.list',
    method: 'GET',
    path: '/api/quality/specifications',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Specification versions of the site, newest first, filtered by material',
    query: z.strictObject({ materialCode: Code.optional() }),
    response: z.strictObject({ specifications: z.array(SpecificationView) }),
  }),
  draft: defineRoute({
    id: 'specifications.draft',
    method: 'POST',
    path: '/api/quality/specifications',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Draft a new version of a material\'s specification (QC); it takes effect once approved by another person (LIMS_ACT)',
    body: withAttribution({
      materialCode: Code,
      title: z.string().trim().min(1).max(200),
      monographReference: z.string().trim().min(1).max(200),
      tests: z.array(SpecificationTestInput).min(1).max(100),
    }),
    response: SpecificationView,
  }),
  markEdition: defineRoute({
    id: 'specifications.markEdition',
    method: 'POST',
    path: '/api/quality/editions',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Mark a pharmacopoeia edition effective from an instant (QA; IN-33)',
    body: withAttribution({
      pharmacopoeia: z.enum(['IP', 'BP', 'PH_EUR', 'USP']),
      edition: Edition,
      effectiveFrom: z.iso.datetime({ offset: true }),
    }),
    response: z.strictObject({ editionId: Uuid }),
  }),
  editionReview: defineRoute({
    id: 'specifications.editionReview',
    method: 'GET',
    path: '/api/quality/editions/review',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Specifications in effect and master records whose limits cite an edition older than the one effective now (IN-33 review list)',
    response: z.strictObject({ items: z.array(EditionReviewItem), mbrs: z.array(MbrEditionReviewItem) }),
  }),
  lotReleaseCheck: defineRoute({
    id: 'specifications.lotReleaseCheck',
    method: 'GET',
    path: '/api/lots/:lotId/release-check',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Why a lot is not released yet on its specification\'s required results and its reserve samples',
    params: z.strictObject({ lotId: Uuid }),
    response: LotReleaseCheckView,
  }),
  proposeLotDecision: defineRoute({
    id: 'specifications.proposeLotDecision',
    method: 'POST',
    path: '/api/lots/:lotId/decisions',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'QA proposes a status decision on a lot (HOLD, UNHOLD, RETURN, RECALL, or the release of an intermediate for further processing); it is then signed and applied as LOT_DECISION (D-P4-3; API plan A2)',
    params: z.strictObject({ lotId: Uuid }),
    body: withAttribution({ event: z.enum(['HOLD', 'UNHOLD', 'RETURN', 'RECALL', 'RELEASE_FOR_FURTHER_PROCESSING']) }),
    response: LotDecisionProposalView,
  }),
  postFinishedLot: defineRoute({
    id: 'specifications.postFinishedLot',
    method: 'POST',
    path: '/api/quality/finished-lots',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Post the finished lot of a completed packaging order, in quarantine (IN-05 (a), PR-45)',
    body: withAttribution({ batchId: Uuid, quantity: DecimalString, unit: Unit }),
    response: FinishedLotView,
  }),
  postIntermediateLot: defineRoute({
    id: 'specifications.postIntermediateLot',
    method: 'POST',
    path: '/api/quality/intermediate-lots',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Post the intermediate lot of a completed processing batch of the API edition, in quarantine (API plan A2, C1; AS-03, AS-09)',
    body: withAttribution({ batchId: Uuid, quantity: DecimalString, unit: Unit }),
    response: IntermediateLotView,
  }),
} as const;
