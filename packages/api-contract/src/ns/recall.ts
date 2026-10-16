/**
 * Namespace `recall` (Phase 6 slice 6d-0, GMP; IN-29, PR-57; recipe-core 1012): the mock recall, a stored exercise the
 * authorised person owns and signs off (D-P6d-2). It never changes a lot: a real recall stays the RECALL act of the
 * after-release model (release.afterRelease, Phase 4 slice 5).
 *
 *  - A run starts from a lot or a deviation and is computed by the database as of an instant (the run's own time by
 *    default): the affected batches and lots (the forward genealogy), the consignees with what each was delivered, and
 *    a reconciliation sheet per lot of delivered against returned (recovered) quantities; distribution records without
 *    the consignee's address are listed as incomplete. The run, its as-of point, the query version, the result and its
 *    SHA-256 are stored; `reproduces` says whether a re-run as of the same instant still gives that hash.
 *  - The run records whether the licensing authority was informed of the (intended) recall, with its reference.
 *
 * Signed act (signable action MOCK_RECALL_SIGN_OFF, signable.ts), aggregate `mock_recall`:
 *    mock_recall <mock recall id>   MOCK_RECALL_SIGNED_OFF (the authorised person), state RUN
 */
import { z } from 'zod';
import { DecimalString, EpochMicros, Instant, PersonRef, Uuid, withAttribution } from '../common.ts';
import { defineRoute } from '../route.ts';

export const MockRecallSubjectKind = z.enum(['LOT', 'DEVIATION']);
export type MockRecallSubjectKind = z.infer<typeof MockRecallSubjectKind>;

export const MockRecallCounts = z.strictObject({
  batches: z.number().int().nonnegative(),
  lots: z.number().int().nonnegative(),
  consignees: z.number().int().nonnegative(),
  shipments: z.number().int().nonnegative(),
  incompleteRecords: z.number().int().nonnegative(),
});

export const MockRecallSignOffView = z.strictObject({ signedBy: PersonRef, signedAt: Instant, signatureId: Uuid });

export const MockRecallSummaryView = z.strictObject({
  mockRecallId: Uuid,
  subjectKind: MockRecallSubjectKind,
  subjectId: Uuid,
  /** The lot number or the deviation reference. */
  subjectRef: z.string().min(1),
  asOf: Instant,
  queryVersion: z.number().int().positive(),
  resultSha256: z.string().regex(/^[0-9a-f]{64}$/),
  authorityInformed: z.boolean(),
  authorityReference: z.string().nullable(),
  counts: MockRecallCounts,
  ranBy: PersonRef,
  ranAt: Instant,
  signOff: MockRecallSignOffView.nullable(),
});
export type MockRecallSummaryView = z.infer<typeof MockRecallSummaryView>;

export const MockRecallBatchView = z.strictObject({ batchId: Uuid, batchNumber: z.string().min(1), productCode: z.string().nullable(), depth: z.number().int().nonnegative() });
/** One affected lot's line of the reconciliation sheet: delivered (shipped) against returned, in the lot's unit. */
export const MockRecallLotView = z.strictObject({
  lotId: Uuid,
  lotCode: z.string().min(1),
  materialCode: z.string().min(1),
  materialKind: z.string().min(1),
  depth: z.number().int().nonnegative(),
  unit: z.string().min(1),
  delivered: DecimalString,
  returned: DecimalString,
  outstanding: DecimalString,
});
export const MockRecallShipmentView = z.strictObject({
  shipmentNo: z.string().min(1),
  lotCode: z.string().min(1),
  quantity: DecimalString,
  unit: z.string().min(1),
  shippedAt: Instant,
});
export const MockRecallConsigneeView = z.strictObject({
  consigneeCode: z.string().min(1),
  consigneeName: z.string().min(1),
  consigneeAddress: z.string().nullable(),
  markets: z.array(z.string()),
  shipments: z.array(MockRecallShipmentView),
});

export const MockRecallView = MockRecallSummaryView.extend({
  /** Whether a re-run of the same query version as of the same instant gives the stored hash now. */
  reproduces: z.boolean(),
  batches: z.array(MockRecallBatchView),
  lots: z.array(MockRecallLotView),
  consignees: z.array(MockRecallConsigneeView),
  /** Shipment numbers whose distribution record lacks the consignee's address (D-P6d-0-7). */
  incomplete: z.array(z.string()),
});
export type MockRecallView = z.infer<typeof MockRecallView>;

export const recall = {
  mockRecalls: defineRoute({
    id: 'recall.mockRecalls',
    method: 'GET',
    path: '/api/recall/mock-recalls',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The mock recalls run, newest first',
    response: z.strictObject({ mockRecalls: z.array(MockRecallSummaryView) }),
  }),
  mockRecall: defineRoute({
    id: 'recall.mockRecall',
    method: 'GET',
    path: '/api/recall/mock-recalls/:mockRecallId',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'One mock recall: affected batches and lots, consignees, the reconciliation sheet, whether it reproduces, and the AP sign-off',
    params: z.strictObject({ mockRecallId: Uuid }),
    response: MockRecallView,
  }),
  run: defineRoute({
    id: 'recall.run',
    method: 'POST',
    path: '/api/recall/mock-recalls',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Run a mock recall from a lot or a deviation as of an instant (QA, AP); stored with its result hash (IN-29, PR-57)',
    body: withAttribution({
      subjectKind: MockRecallSubjectKind,
      subjectId: Uuid,
      asOfUs: EpochMicros.optional(),
      authorityInformed: z.boolean(),
      authorityReference: z.string().trim().min(1).max(200).optional(),
    }),
    response: MockRecallView,
  }),
} as const;
