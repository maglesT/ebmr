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

/**
 * Phase 6 slice 6i (recipe-core 1091; additive): per outbound transfer the run reached, what its destination installation
 * answered as of the run's own instant (ANSWERED), or why not, with the last excerpt received and its older as-of. The run
 * is complete only when every transfer ANSWERED (computed by the database; part of what the AP signs off).
 */
export const MockRecallRemoteView = z.strictObject({
  transferId: Uuid,
  packageNo: z.string().min(1),
  destination: z.string().min(1),
  depth: z.number().int().nonnegative(),
  status: z.enum(['NOT_ASKED', 'ANSWERED', 'UNREACHABLE', 'REFUSED', 'NOT_REGISTERED']),
  excerptAsOf: Instant.nullable(),
  detail: z.string().nullable(),
  /** The destination's lots, batches and shipments (consignee codes) from the excerpt shown. */
  lots: z.array(z.strictObject({ lotId: Uuid, lotCode: z.string().min(1), materialCode: z.string().nullable(), state: z.string().nullable() })),
  batches: z.array(z.strictObject({ batchId: Uuid, batchNumber: z.string().min(1) })),
  shipments: z.array(z.strictObject({ shipmentId: Uuid, shipmentNo: z.string().min(1), consigneeCode: z.string().nullable(), market: z.string().nullable() })),
});
export type MockRecallRemoteView = z.infer<typeof MockRecallRemoteView>;
export const MockRecallFederationView = z.strictObject({ complete: z.boolean(), transfers: z.array(MockRecallRemoteView) });
export type MockRecallFederationView = z.infer<typeof MockRecallFederationView>;

export const MockRecallView = MockRecallSummaryView.extend({
  /** Whether a re-run of the same query version as of the same instant gives the stored hash now. */
  reproduces: z.boolean(),
  batches: z.array(MockRecallBatchView),
  lots: z.array(MockRecallLotView),
  consignees: z.array(MockRecallConsigneeView),
  /** Shipment numbers whose distribution record lacks the consignee's address (D-P6d-0-7). */
  incomplete: z.array(z.string()),
  /** Phase 6 slice 6i (query version 2 and later): the other sites' parts and whether the run is complete. */
  federation: MockRecallFederationView.optional(),
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
    summary: 'Run a mock recall from a lot or a deviation as of an instant (QA, AP); stored with its result hash; each destination of an outbound transfer is asked for its part (IN-29, PR-57, L-41)',
    body: withAttribution({
      subjectKind: MockRecallSubjectKind,
      subjectId: Uuid,
      asOfUs: EpochMicros.optional(),
      authorityInformed: z.boolean(),
      authorityReference: z.string().trim().min(1).max(200).optional(),
    }),
    response: MockRecallView,
  }),
  /** Phase 6 slice 6i (additive): ask the destinations that did not answer again, as of the run's own instant. */
  refreshFederation: defineRoute({
    id: 'recall.refreshFederation',
    method: 'POST',
    path: '/api/recall/mock-recalls/:mockRecallId/federation',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Ask again every destination site that has not answered, as of the mock recall\'s own instant, before the sign-off (L-41, IN-29)',
    params: z.strictObject({ mockRecallId: Uuid }),
    body: withAttribution({}),
    response: MockRecallView,
  }),
} as const;
