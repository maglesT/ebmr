/**
 * Namespace `release` (Phase 4 slice 3, GMP): the release gate G-REL of a finished lot per market, the "since review"
 * acknowledgements and the manufacturer release (outline 5.2.6, 5.2.7, 5.7, 7.3 release cockpit; plan
 * docs/build-plan/phase-4/phase-4-plan.md, slice 3). Every rule is the database's (recipe-core 0780 to 0809; the
 * Tablets items behind the hook, tablets 1160 to 1179).
 *
 * The signed acts are the signable action RELEASE_ACT (signable.ts). Slice 3 builds:
 *   MANUFACTURER_RELEASE   manufacturer_release <lot>/RELEASE           MANUFACTURER_RELEASE (AP or named delegate)
 *   MANUFACTURER_REJECT    manufacturer_release <lot>/REJECT            MANUFACTURER_RELEASE, with the person's reason
 *   POST_CHANGE_EVALUATE   post_change_evaluation <batch>              POST_CHANGE_EVALUATED (QA; IN-03 (c))
 *   PPQ_OUTCOME            ppq_outcome <batch>/<outcome>                VALIDATION_OUTCOME_RECORDED (QA; PR-09)
 *   INVESTIGATION_JUSTIFY  investigation_justification <lot>/<deviation>/<sha256 of the text>
 *                                                                       OPEN_INVESTIGATION_JUSTIFIED (release authority;
 *                                                                       PR-53, only while its switch is on)
 * The other acts of RELEASE_ACT (US_DISPOSE, QP_INTAKE, QP_CERTIFY, MARKET_ADD, MARKET_REMOVE, RECONFIRM, RECALL,
 * REJECT_AFTER_RELEASE, DISPOSAL) arrive with slices 4 and 5. A manufacturer release signs the G-REL checklist of market
 * IN as its content (IN-05 (d)), and the act sends back the epoch the signer evaluated (INV-05: a later change refuses it).
 */
import { z } from 'zod';
import { Instant, PersonRef, Uuid } from '../common.ts';
import { defineRoute } from '../route.ts';

export const ReleaseMarket = z.enum(['IN', 'US', 'EU']);
export type ReleaseMarket = z.infer<typeof ReleaseMarket>;

/** NOT_READY -> READY (computed by G-REL, never set) -> RELEASED or REJECTED; NOT_READY -> REJECTED too. */
export const ManufacturerReleaseState = z.enum(['NOT_READY', 'READY', 'RELEASED', 'REJECTED']);
export type ManufacturerReleaseState = z.infer<typeof ManufacturerReleaseState>;

/** The evidence token of a G-REL evaluation (text); the signing act sends it back. */
export const GrelEpoch = z.string().regex(/^[0-9a-f]{64}$|^0$/);

/** `G<group>.<NAME>` for the core items (groups 1 to 11; 11 = market items, slice 4), `E.<NAME>` for the edition's. */
export const GrelItemId = z.string().regex(/^(G(?:[1-9]|1[01])|E)\.[A-Z0-9_]{1,64}$/);

export const GrelEvidence = z.strictObject({
  /** BATCH, LOT, DEVIATION, INCIDENT, LIMS_RESULT, SAMPLE, CHANGE_RECORD, SIGNATURE, CONTAINER, EXCEPTION, ... */
  kind: z.string().min(1).max(32),
  ref: z.string().min(1).max(256),
  label: z.string().max(512),
});

/** One G-REL item (recipe.grel_evaluate; item shape fixed in recipe-core 0780). */
export const GrelItemView = z.strictObject({
  /** `G<group>.<NAME>` for the core items, `E.<NAME>` for the edition's. */
  id: GrelItemId,
  /** Outline 5.2.7 group: 1 to 9 core, 10 edition, 11 market items (slice 4); an edition may answer for 4 and 9. */
  group: z.string().regex(/^([1-9]|1[01])$/),
  title: z.string().min(1),
  status: z.enum(['GREEN', 'RED', 'NA']),
  /** Why it is RED, in the database's words. */
  problem: z.string().nullable(),
  evidence: z.array(GrelEvidence),
  /** The evidence changed after the QA review of the packaging record: the signer acknowledges it item by item. */
  sinceReview: z.boolean(),
  /** This person acknowledged the item at the current epoch (only for since-review items; false otherwise). */
  acknowledged: z.boolean(),
});
export type GrelItemView = z.infer<typeof GrelItemView>;

export const GrelView = z.strictObject({
  lotId: Uuid,
  market: ReleaseMarket,
  epoch: GrelEpoch,
  /** No item RED. */
  ready: z.boolean(),
  items: z.array(GrelItemView),
});
export type GrelView = z.infer<typeof GrelView>;

export const ReleaseDecisionView = z.strictObject({
  decision: z.enum(['RELEASED', 'REJECTED']),
  by: PersonRef,
  at: Instant,
  signatureId: Uuid,
  /** The delegation the signer cited (a named delegate of the AP), or null when the AP signed. */
  delegationId: Uuid.nullable(),
  reason: z.string().nullable(),
  /** The epoch and the SHA-256 of the checklist stored with the signature (IN-05 (d)). */
  epoch: GrelEpoch,
  checklistHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** PR-53: the open investigations released under a signed justification (printed on the release record). */
  justifications: z.array(z.strictObject({ deviationId: Uuid, text: z.string(), signatureId: Uuid })),
});
export type ReleaseDecisionView = z.infer<typeof ReleaseDecisionView>;

export const LotReleaseSummaryView = z.strictObject({
  lotId: Uuid,
  lotCode: z.string(),
  /** The packaging batch the lot was posted from. */
  batchId: Uuid,
  batchNumber: z.string(),
  productCode: z.string(),
  strength: z.string(),
  markets: z.array(z.string()),
  lotStatus: z.string(),
  state: ManufacturerReleaseState,
});
export type LotReleaseSummaryView = z.infer<typeof LotReleaseSummaryView>;

/** Whether an act may be given now, and why not (the database's own reasons). */
export const ReleaseGate = z.strictObject({ ready: z.boolean(), problems: z.array(z.string()) });

export const LotReleaseView = LotReleaseSummaryView.extend({
  /** G-REL for market IN: the manufacturer release checklist. */
  grel: GrelView,
  decision: ReleaseDecisionView.nullable(),
  /** DI-12: incidents linked to the lot's batches, open or not yet assessed for them (they block the disposition). */
  incidents: z.array(z.strictObject({ incidentId: Uuid, number: z.string(), severity: z.string(), status: z.string(), assessed: z.boolean() })),
  /** PR-08: registration-relevant deviations of the lot's batches (registered or validated limit breached). */
  registrationRelevant: z.array(z.strictObject({ batchId: Uuid, exceptionId: z.string(), title: z.string(), deviationRef: z.string().nullable() })),
  /** PR-53: the open-investigation path is on (default off). */
  openInvestigationPath: z.boolean(),
  /** PR-09: batches of the evidence set made under a validation protocol, and their recorded outcome. */
  validationBatches: z.array(z.strictObject({ batchId: Uuid, batchNumber: z.string(), purpose: z.string(), outcome: z.string().nullable() })),
  /** IN-03: batches that are the first under a changed master, and whether QA signed their post-change evaluation. */
  postChange: z.array(z.strictObject({ batchId: Uuid, batchNumber: z.string(), changeRecord: z.string(), evaluated: z.boolean() })),
  gates: z.strictObject({ release: ReleaseGate, reject: ReleaseGate }),
  signable: z.strictObject({ aggregateType: z.literal('manufacturer_release'), release: z.string(), reject: z.string() }),
});
export type LotReleaseView = z.infer<typeof LotReleaseView>;

// ---------------------------------------------------------------------------------------------------------------------
// Slice 4 (4-0): market dispositions, QP certification intake, market add and removal (outline 3.3.3, 5.2.6, 5.2.7 items
// 8 and 11; INV-39, INV-43, PR-54 to PR-56, DI-39, DI-30; D-P4-5). Every rule is the database's (recipe-core 0820 to
// 0849, tablets 1180 to 1189).
// ---------------------------------------------------------------------------------------------------------------------

/** The export markets with a disposition of their own (IN is decided by the manufacturer release, slice 3). */
export const ExportMarket = z.enum(['US', 'EU']);
export type ExportMarket = z.infer<typeof ExportMarket>;

/**
 * recipe.disposition_state(lot, market). US: NOT_READY -> READY (computed: G-REL for US ready) -> RELEASED or REJECTED.
 * EU: NOT_READY -> AWAITING_QP_CERTIFICATION (computed: manufacturer release RELEASED and G-REL for EU ready) ->
 * CERTIFIED or REJECTED_BY_QP. Both: INELIGIBLE (terminal: the market-add evaluation signed with the addition had an
 * UNMET_FINAL item), RELEASE_SUSPENDED (a decided market whose manufacturer release is no longer RELEASED; INV-39
 * cascade), REMOVED (the market was removed from the lot's set, 3.3.3).
 */
export const MarketDispositionState = z.enum([
  'NOT_READY',
  'READY',
  'RELEASED',
  'REJECTED',
  'AWAITING_QP_CERTIFICATION',
  'CERTIFIED',
  'REJECTED_BY_QP',
  'INELIGIBLE',
  'RELEASE_SUSPENDED',
  'REMOVED',
]);
export type MarketDispositionState = z.infer<typeof MarketDispositionState>;

/** Outline 3.3.3: each market-add item ends MET, UNMET_RECOVERABLE (still achievable) or UNMET_FINAL (never any more). */
export const MarketAddOutcome = z.enum(['MET', 'UNMET_RECOVERABLE', 'UNMET_FINAL']);
export type MarketAddOutcome = z.infer<typeof MarketAddOutcome>;

export const MarketSubjectKind = z.enum(['BATCH', 'LOT']);

export const MarketAddItemView = z.strictObject({
  /** `MA.<NAME>`, e.g. MA.MBR_AUTHORISATION, MA.IDENTITY_ROUTE, MA.RELEASE_TESTS, MA.RESERVE_SAMPLES. */
  id: z.string().regex(/^MA\.[A-Z0-9_]{1,64}$/),
  title: z.string().min(1),
  outcome: MarketAddOutcome,
  /** Why it is not MET, in the database's words; null when MET. */
  detail: z.string().nullable(),
  evidence: z.array(GrelEvidence),
});
export type MarketAddItemView = z.infer<typeof MarketAddItemView>;

/** recipe.market_add_evaluate(kind, id, market): the worst item decides the outcome. */
export const MarketAddEvaluationView = z.strictObject({
  subjectKind: MarketSubjectKind,
  subjectId: Uuid,
  market: ReleaseMarket,
  outcome: MarketAddOutcome,
  items: z.array(MarketAddItemView),
});
export type MarketAddEvaluationView = z.infer<typeof MarketAddEvaluationView>;

/** One signed change of a market set (insert-only; the original resolution stays in the record). */
export const MarketChangeView = z.strictObject({
  changeId: Uuid,
  change: z.enum(['ADD', 'REMOVE']),
  market: ReleaseMarket,
  subjectKind: MarketSubjectKind,
  subjectId: Uuid,
  by: PersonRef,
  at: Instant,
  signatureId: Uuid,
  /** ADD: the change record the addition is made under. */
  changeRecord: z.string().nullable(),
  /** REMOVE: the linked deviation-lite record. */
  deviationRef: z.string().nullable(),
  /** REMOVE: the market had failed against its own rules before the removal (cockpit and PQR extract show it). */
  removedAfterFailure: z.boolean(),
  /** ADD: the evaluation signed with the addition (an UNMET_FINAL item makes the market INELIGIBLE). */
  evaluation: MarketAddEvaluationView.nullable(),
});
export type MarketChangeView = z.infer<typeof MarketChangeView>;

/** An EU certification outcome as recorded (the append-only register, PR-55, DI-39). */
export const QpCertificationView = z.strictObject({
  certificationId: Uuid,
  /**
   * MESSAGE: a structured message signed by the importer, verified and acknowledged; TRANSCRIBED: entered by hand and
   * verified by a second person (DI-30); IN_SYSTEM: a registered QP account signed it here (switch on, PR-55).
   */
  source: z.enum(['MESSAGE', 'TRANSCRIBED', 'IN_SYSTEM']),
  outcome: z.enum(['CERTIFIED', 'REJECTED_BY_QP']),
  certifier: z.string(),
  miaNumber: z.string(),
  certifiedAt: Instant,
  importerCode: z.string().nullable(),
  /** The importer's message id or certification reference. */
  reference: z.string(),
  /** False only for a transcription waiting for its second person; it counts only once verified. */
  verified: z.boolean(),
  recordedBy: PersonRef.nullable(),
  verifiedBy: PersonRef.nullable(),
  reason: z.string().nullable(),
});
export type QpCertificationView = z.infer<typeof QpCertificationView>;

export const MarketDecisionView = z.strictObject({
  decision: z.enum(['RELEASED', 'REJECTED']),
  by: PersonRef,
  at: Instant,
  signatureId: Uuid,
  epoch: GrelEpoch,
  checklistHash: z.string().regex(/^[0-9a-f]{64}$/),
  reason: z.string().nullable(),
  /** REJECTED: the investigation (deviation-lite record linked to the lot) every other market sees (PR-56). */
  deviationId: Uuid.nullable(),
  /** Written in the same ceremony as the manufacturer release (the AP also holds the QCU permission; D-P4-5). */
  withManufacturerRelease: z.boolean(),
});
export type MarketDecisionView = z.infer<typeof MarketDecisionView>;

export const MarketDispositionView = z.strictObject({
  market: ExportMarket,
  state: MarketDispositionState,
  /** G-REL for the market evaluated now (null when the market was removed). */
  grel: GrelView.nullable(),
  /** US: the QCU decision. */
  decision: MarketDecisionView.nullable(),
  /** EU: every certification outcome recorded for the lot, pending transcriptions included. */
  certifications: z.array(QpCertificationView),
  /** The market was added after issue: its evaluation now (G-REL item 8). */
  marketAdd: MarketAddEvaluationView.nullable(),
  /** Every signed change of the market for the lot or its batches, oldest first. */
  changes: z.array(MarketChangeView),
  /** PR-55: in-system QP certification is switched on (default off). */
  inSystemQp: z.boolean(),
  gates: z.strictObject({ release: ReleaseGate, reject: ReleaseGate, certify: ReleaseGate }),
});
export type MarketDispositionView = z.infer<typeof MarketDispositionView>;

export const LotMarketsView = z.strictObject({
  lotId: Uuid,
  manufacturerState: ManufacturerReleaseState,
  /** The lot's market set now (original, plus added, minus removed). */
  markets: z.array(ReleaseMarket),
  dispositions: z.array(MarketDispositionView),
});
export type LotMarketsView = z.infer<typeof LotMarketsView>;

/** The receipt returned to the sender of a structured certification message (DI-39). */
export const QpAcknowledgementView = z.strictObject({
  acknowledgementId: Uuid,
  messageId: z.string(),
  messageSha256: z.string().regex(/^[0-9a-f]{64}$/),
  outcome: z.enum(['ACCEPTED', 'REFUSED']),
  /** REFUSED: why, in the database's words. */
  reason: z.string().nullable(),
  receivedAt: Instant,
  lotId: Uuid.nullable(),
  certificationId: Uuid.nullable(),
});
export type QpAcknowledgementView = z.infer<typeof QpAcknowledgementView>;

/** An EU importer named in a technical agreement, with the key its certification messages are signed with. */
export const EuImporterView = z.strictObject({
  importerId: Uuid,
  code: z.string(),
  name: z.string(),
  technicalAgreementRef: z.string(),
  miaNumber: z.string(),
  /** SHA-256 of the Ed25519 public key. */
  keyFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  products: z.array(z.string()),
});
export type EuImporterView = z.infer<typeof EuImporterView>;

const lotParams = z.strictObject({ lotId: Uuid });
const batchParams = z.strictObject({ batchId: Uuid });

export const release = {
  queue: defineRoute({
    id: 'release.queue',
    method: 'GET',
    path: '/api/release/lots',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Finished lots with their manufacturer release state',
    query: z.strictObject({ state: ManufacturerReleaseState.optional() }),
    response: z.strictObject({ lots: z.array(LotReleaseSummaryView) }),
  }),
  lot: defineRoute({
    id: 'release.lot',
    method: 'GET',
    path: '/api/release/lots/:lotId',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'One finished lot: G-REL for IN (the manufacturer release checklist), the decision, incidents, flags and gates',
    params: lotParams,
    response: LotReleaseView,
  }),
  grel: defineRoute({
    id: 'release.grel',
    method: 'GET',
    path: '/api/release/lots/:lotId/grel',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'G-REL of the lot for one market, evaluated now, with this person\'s acknowledgements',
    params: lotParams,
    query: z.strictObject({ market: ReleaseMarket }),
    response: GrelView,
  }),
  acknowledge: defineRoute({
    id: 'release.acknowledge',
    method: 'POST',
    path: '/api/release/lots/:lotId/acknowledgements',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'This person acknowledges one "since review" item at the epoch shown (a later change needs a new acknowledgement)',
    params: lotParams,
    body: z.strictObject({ market: ReleaseMarket, itemId: GrelItemId, epoch: GrelEpoch }),
    response: GrelView,
  }),
  markets: defineRoute({
    id: 'release.markets',
    method: 'GET',
    path: '/api/release/lots/:lotId/markets',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The US and EU dispositions of the lot: state, G-REL for the market, decision, certifications, market changes and gates',
    params: lotParams,
    response: LotMarketsView,
  }),
  marketAdd: defineRoute({
    id: 'release.marketAdd',
    method: 'GET',
    path: '/api/release/lots/:lotId/market-add',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The market-add evaluation of the lot for a market, evaluated now against the recorded data (3.3.3)',
    params: lotParams,
    query: z.strictObject({ market: ReleaseMarket }),
    response: MarketAddEvaluationView,
  }),
  batchMarketAdd: defineRoute({
    id: 'release.batchMarketAdd',
    method: 'GET',
    path: '/api/release/batches/:batchId/market-add',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The market-add evaluation of an issued batch for a market (before a packaging order for that market)',
    params: batchParams,
    query: z.strictObject({ market: ReleaseMarket }),
    response: MarketAddEvaluationView,
  }),
  qpMessage: defineRoute({
    id: 'release.qpMessage',
    method: 'POST',
    path: '/api/release/qp-messages',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'Take in a structured certification message signed by the EU importer; the database verifies it and the acknowledgement goes back',
    body: z.strictObject({
      /** The message exactly as received (JSON text, format ebmr.qp-certification.v1); its UTF-8 bytes are what was signed. */
      message: z.string().min(2).max(16_384),
      /** The Ed25519 signature of the message bytes, base64 (64 bytes). */
      signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
    }),
    response: QpAcknowledgementView,
  }),
  importers: defineRoute({
    id: 'release.importers',
    method: 'GET',
    path: '/api/release/eu-importers',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The EU importers named in technical agreements, with their products and key fingerprints',
    response: z.strictObject({ importers: z.array(EuImporterView) }),
  }),
} as const;
