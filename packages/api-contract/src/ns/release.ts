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
 * The other acts of RELEASE_ACT (US_DISPOSE, QP_INTAKE, QP_CERTIFY, MARKET_ADD, MARKET_REMOVE: slice 4; RECONFIRM, RECALL,
 * REJECT_AFTER_RELEASE, DISPOSAL: slice 5a, below) arrive with slices 4 and 5. A manufacturer release signs the G-REL checklist of market
 * IN as its content (IN-05 (d)), and the act sends back the epoch the signer evaluated (INV-05: a later change refuses it).
 */
import { z } from 'zod';
import { Instant, PersonRef, Uuid } from '../common.ts';
import { defineRoute } from '../route.ts';

export const ReleaseMarket = z.enum(['IN', 'US', 'EU']);
export type ReleaseMarket = z.infer<typeof ReleaseMarket>;

/**
 * NOT_READY -> READY (computed by G-REL, never set) -> RELEASED or REJECTED; NOT_READY -> REJECTED too. After release
 * (slice 5a, L-19): RELEASED -> RELEASE_SUSPENDED (automatic) -> RELEASED (re-confirmed), RECALLED or
 * REJECTED_AFTER_RELEASE (both terminal).
 */
export const ManufacturerReleaseState = z.enum(['NOT_READY', 'READY', 'RELEASED', 'REJECTED', 'RELEASE_SUSPENDED', 'RECALLED', 'REJECTED_AFTER_RELEASE']);
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
  // Slice 5a (L-19, D-5-5): the AP's terminal after-release decisions for the market.
  'RECALLED',
  'REJECTED_AFTER_RELEASE',
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

// ---------------------------------------------------------------------------------------------------------------------
// Slice 5a: after release (L-19, IN-29, PR-46, IN-05 (e); D-5-1 to D-5-6). Every rule is the database's (recipe-core 0840
// to 0869, site services 0880 to 0884). The signed acts are RELEASE_ACT RECONFIRM, RECALL, REJECT_AFTER_RELEASE and
// DISPOSAL (signable.ts):
//   RECONFIRM, RECALL, REJECT_AFTER_RELEASE  release_suspension <lot>/<market>/<act>/<n>   RELEASE_RECONFIRMED, RECALLED,
//                                            REJECTED_AFTER_RELEASE (the AP, never an involved person; n is the
//                                            database's sequence, recipe.release_suspension_next_id)
//   DISPOSAL (record)                        disposal <lot>/<sha256 of the details>          DISPOSAL_RECORDED
//   DISPOSAL (witness: `disposalId` only)    the same record                                 DESTRUCTION_WITNESSED (another person)
// ---------------------------------------------------------------------------------------------------------------------

export const AfterReleaseAct = z.enum(['RECONFIRM', 'RECALL', 'REJECT_AFTER_RELEASE']);
export type AfterReleaseAct = z.infer<typeof AfterReleaseAct>;

/**
 * What suspended the lot (D-5-1): a deviation-lite record (any kind, investigations included), a kernel incident or DI
 * investigation linked to the lot or to a lot or batch upstream of it, a revised LIMS result, an as-found calibration
 * failure on equipment its batches used, or a record amendment (slice 5b).
 */
export const SuspensionCauseKind = z.enum(['DEVIATION', 'INCIDENT', 'DI_INVESTIGATION', 'LIMS_REVISION', 'CALIBRATION_FAILURE', 'RECORD_AMENDMENT']);
export type SuspensionCauseKind = z.infer<typeof SuspensionCauseKind>;

/** One cause suspending one decided market of the lot (insert-only; covered per market by a re-confirmation). */
export const SuspensionCauseView = z.strictObject({
  suspensionId: Uuid,
  market: ReleaseMarket,
  causeKind: SuspensionCauseKind,
  /** The cause's own id (deviation, incident, investigation, result, calibration or amendment). */
  causeRef: z.string(),
  /** In the database's words, e.g. "deviation DEV-2026-0012 linked to batch B26-0001". */
  label: z.string(),
  /** Where the cause was linked: the lot itself, or a lot, batch or equipment upstream of it (PR-57 genealogy). */
  via: z.strictObject({ kind: z.enum(['LOT', 'BATCH', 'EQUIPMENT']), id: Uuid }),
  /** The market's state when the cause suspended it (a re-confirmation restores it, D-5-4). */
  priorState: z.string(),
  suspendedAt: Instant,
  /** A re-confirmation of the market covers it. */
  covered: z.boolean(),
  /** Why the cause is not resolved yet (open deviation, CONFIRMED impact for the market, result out of limits), or null. */
  problem: z.string().nullable(),
});
export type SuspensionCauseView = z.infer<typeof SuspensionCauseView>;

/** One signed after-release decision of the AP for one market (insert-only). */
export const AfterReleaseDecisionView = z.strictObject({
  decisionId: Uuid,
  market: ReleaseMarket,
  act: AfterReleaseAct,
  /** What the market became: RELEASED or CERTIFIED (restored by a re-confirmation), RECALLED or REJECTED_AFTER_RELEASE. */
  toState: z.string(),
  by: PersonRef,
  at: Instant,
  signatureId: Uuid,
  /** RECONFIRM: the impact assessment; RECALL, REJECT_AFTER_RELEASE: the person's reason. */
  text: z.string(),
  /** RECONFIRM: the G-REL epoch evaluated under the locks (INV-05); null otherwise. */
  epoch: GrelEpoch.nullable(),
  /** The suspensions this decision covered. */
  suspensionIds: z.array(Uuid),
});
export type AfterReleaseDecisionView = z.infer<typeof AfterReleaseDecisionView>;

/** IN-29: the recall-assessment task a suspension opens (AP role); PR-46: the serial-decommissioning task of a disposal. */
export const RecallTaskView = z.strictObject({
  taskId: Uuid,
  kind: z.enum(['RECALL_ASSESSMENT', 'SERIAL_DECOMMISSIONING']),
  ownerRole: z.string(),
  status: z.enum(['OPEN', 'CLOSED']),
  openedAt: Instant,
  closedAt: Instant.nullable(),
});
export type RecallTaskView = z.infer<typeof RecallTaskView>;

/** D-5-3: an outbox message asking the ERP to block (or, once every market is decided again, to unblock) the lot's stock. */
export const StockBlockView = z.strictObject({
  requestId: Uuid,
  kind: z.enum(['BLOCK', 'UNBLOCK']),
  causeKey: z.string(),
  requestedAt: Instant,
  /** When the ERP stub applied it (at least once, idempotent by lot and cause); null while pending. */
  deliveredAt: Instant.nullable(),
});
export type StockBlockView = z.infer<typeof StockBlockView>;

export const DisposalRoute = z.enum(['WITNESSED_DESTRUCTION', 'REPROCESSING', 'RETURN']);
export type DisposalRoute = z.infer<typeof DisposalRoute>;

/** PR-46, IN-05 (e): the disposal of a rejected lot (once per lot). */
export const DisposalView = z.strictObject({
  disposalId: Uuid,
  route: DisposalRoute,
  /** WITNESSED_DESTRUCTION waits for its independent witness; the other routes are RECORDED at once. */
  state: z.enum(['AWAITING_WITNESS', 'RECORDED']),
  quantity: z.string(),
  unit: z.string(),
  /** RETURN: SUPPLIER or CUSTOMER; null otherwise. */
  returnTo: z.enum(['SUPPLIER', 'CUSTOMER']).nullable(),
  /** RETURN: the return reference; WITNESSED_DESTRUCTION: the destruction record reference (optional). */
  reference: z.string().nullable(),
  /** REPROCESSING: the Phase 3 reprocessing authorisation or request of the same product. */
  reprocessingRef: Uuid.nullable(),
  text: z.string().nullable(),
  /** The record both signatures are on: disposal <lot>/<sha256 of the details>. */
  aggregateId: z.string(),
  performedBy: PersonRef,
  performedAt: Instant,
  signatureId: Uuid,
  witnessedBy: PersonRef.nullable(),
  witnessedAt: Instant.nullable(),
  witnessSignatureId: Uuid.nullable(),
});
export type DisposalView = z.infer<typeof DisposalView>;

/** One market of the lot after release, with the gates of the AP's acts for it. */
export const AfterReleaseMarketView = z.strictObject({
  market: ReleaseMarket,
  state: z.string(),
  /** The state a re-confirmation restores (RELEASED or CERTIFIED) while the market is suspended; null otherwise. */
  priorState: z.string().nullable(),
  /** The next record each act signs (release_suspension <lot>/<market>/<act>/<n>). */
  signable: z.strictObject({ reconfirm: z.string(), recall: z.string(), rejectAfterRelease: z.string() }),
  gates: z.strictObject({ reconfirm: ReleaseGate, recall: ReleaseGate, rejectAfterRelease: ReleaseGate }),
});
export type AfterReleaseMarketView = z.infer<typeof AfterReleaseMarketView>;

export const LotAfterReleaseView = z.strictObject({
  lotId: Uuid,
  lotCode: z.string(),
  productCode: z.string(),
  batchNumber: z.string(),
  manufacturerState: ManufacturerReleaseState,
  markets: z.array(AfterReleaseMarketView),
  causes: z.array(SuspensionCauseView),
  decisions: z.array(AfterReleaseDecisionView),
  tasks: z.array(RecallTaskView),
  stockBlocks: z.array(StockBlockView),
  /** Forward trace (PR-57): the finished lots downstream of this one through the genealogy, with their manufacturer state. */
  downstream: z.array(z.strictObject({ lotId: Uuid, lotCode: z.string(), state: z.string() })),
  disposal: DisposalView.nullable(),
  /** Whether a disposal may be recorded now (the lot REJECTED or REJECTED_AFTER_RELEASE for IN, none recorded yet). */
  disposalGate: ReleaseGate,
});
export type LotAfterReleaseView = z.infer<typeof LotAfterReleaseView>;

export const SuspendedLotSummaryView = z.strictObject({
  lotId: Uuid,
  lotCode: z.string(),
  productCode: z.string(),
  batchNumber: z.string(),
  manufacturerState: ManufacturerReleaseState,
  /** The markets RELEASE_SUSPENDED now. */
  suspendedMarkets: z.array(ReleaseMarket),
  /** IN-29: an open recall-assessment task. */
  openTask: z.boolean(),
  /** When the first cause still open suspended the lot. */
  since: Instant,
});
export type SuspendedLotSummaryView = z.infer<typeof SuspendedLotSummaryView>;

/**
 * API plan A3 (C3, AS-17): the certificate of analysis of a released finished lot of the API edition (substance 5002),
 * built only from records that exist. Values are text as stored (GMP numbers never pass through a JS number).
 */
export const CoaTestView = z.strictObject({
  testCode: z.string(),
  methodReference: z.string(),
  pharmacopoeia: z.string(),
  edition: z.string(),
  unit: z.string(),
  lowerLimit: z.string().nullable(),
  upperLimit: z.string().nullable(),
  result: z.string(),
  resultId: Uuid,
});
export type CoaTestView = z.infer<typeof CoaTestView>;

export const CoaDocumentView = z.strictObject({
  kind: z.literal('CERTIFICATE_OF_ANALYSIS'),
  /** SM Part XII 11.3.4; ICH Q7 11.43. */
  manufacturer: z.strictObject({ name: z.string().nullable(), address: z.string().nullable(), telephone: z.string().nullable() }),
  /** SM Part XII 11.3.2; ICH Q7 11.41: the name with its grade. */
  product: z.strictObject({ name: z.string(), grade: z.string().nullable() }),
  /** SM Part XII 11.3.2; ICH Q7 11.41: the batch (lot) number. */
  lot: z.strictObject({ lotId: Uuid, lotCode: z.string(), batchNumber: z.string() }),
  /** UTC instants as the database writes them (recipe.utc_text). */
  releasedAt: z.string().nullable(),
  retestAt: z.string().nullable(),
  expiresAt: z.string(),
  tests: z.array(CoaTestView),
});
export type CoaDocumentView = z.infer<typeof CoaDocumentView>;

/** A prepared CoA: the stored document (the true copy), its SHA-256, whether it still hashes to it, and the QU's signature. */
export const CoaRecordView = z.strictObject({
  coaId: Uuid,
  state: z.enum(['PREPARED', 'SIGNED']),
  document: CoaDocumentView,
  documentSha256: z.string(),
  intact: z.boolean(),
  preparedBy: PersonRef,
  preparedAt: Instant,
  signedBy: PersonRef.nullable(),
  signedAt: Instant.nullable(),
  signatureId: Uuid.nullable(),
});
export type CoaRecordView = z.infer<typeof CoaRecordView>;

export const LotCoaView = z.strictObject({
  lotId: Uuid,
  /** What a CoA of the lot says now; null when the lot is no API finished lot. */
  current: CoaDocumentView.nullable(),
  /** Each refuses a CoA now. */
  problems: z.array(z.string()),
  /** Content the clause asks for that no record holds (shown, never invented). */
  gaps: z.array(z.string()),
  /** The prepared CoAs of the lot, latest first. */
  coas: z.array(CoaRecordView),
});
export type LotCoaView = z.infer<typeof LotCoaView>;

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
  // Slice 5a: after release.
  suspended: defineRoute({
    id: 'release.suspended',
    method: 'GET',
    path: '/api/release/suspended',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Finished lots with a market RELEASE_SUSPENDED or an open recall-assessment task (IN-29), oldest cause first',
    response: z.strictObject({ lots: z.array(SuspendedLotSummaryView) }),
  }),
  afterRelease: defineRoute({
    id: 'release.afterRelease',
    method: 'GET',
    path: '/api/release/lots/:lotId/after-release',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'One finished lot after release: market states, suspension causes, decisions, tasks, ERP stock blocks, forward trace and disposal',
    params: lotParams,
    response: LotAfterReleaseView,
  }),
  // API plan A3 (C3, AS-17): the CoA of a released API lot; signed with the signable action COA_ACT (COA_APPROVED).
  coa: defineRoute({
    id: 'release.coa',
    method: 'GET',
    path: '/api/release/lots/:lotId/coa',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The certificate of analysis of a released API lot: what it says now, its problems and gaps, and the prepared and signed CoAs',
    params: lotParams,
    response: LotCoaView,
  }),
  prepareCoa: defineRoute({
    id: 'release.prepareCoa',
    method: 'POST',
    path: '/api/release/lots/:lotId/coa',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'Prepare the CoA of a released API lot from its records (refused while a problem stands); the quality unit then signs it COA_APPROVED',
    params: lotParams,
    body: z.strictObject({}),
    response: LotCoaView,
  }),
} as const;
