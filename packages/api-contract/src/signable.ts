/**
 * Signable actions (Phase 2 apps plan section 6). The e-signature endpoints (C1) look up a handler in the
 * server's SignableActionRegistry by `kind`; the handler supplies aggregate, meaning, expected state,
 * previewContent, prepareForChallenge, dryRun and apply.
 *  - ENGINE_COMMAND (C3): a signature-bearing engine intent on a sandbox test run.
 *  - MBR_TRANSITION (C2, A2): prepared, checked, approved and regulatory signatures on an MBR version.
 *  - GMP_BATCH_ISSUE (C3, GMP; Phase 3 slice 2b): the issuer's ISSUED signature on a planned GMP batch's issue content,
 *    and the issue in the same command, with the issuer's own reason (EBMR-AUDIT-002).
 *  - ESIG_STUB: test-only, over the kernel's esig_stub aggregate, so the ceremony is tested before C3 lands.
 * Phase 3 slice 6 (GMP): the signed acts of quality, lots, reprocessing, master data and plant over HTTP. Each handler
 * calls the existing database command, which stays the decider; the meanings are the existing ones:
 *  - QUALITY_ACT: DEVIATION_IMPACT_ASSESS (DEVIATION_IMPACT_ASSESSED, Phase 4 slice 2a), DEVIATION_CONCLUDE
 *    (DEVIATION_CONCLUDED), DEVIATION_CLOSE (DEVIATION_CLOSED), LOT_RESULT_APPROVE
 *    (QC_RESULT_APPROVED), QC_EXTRA_TESTING_DECISION (QC_EXTRA_TESTING_DECIDED), LOT_RETEST (QC_RESULT_APPROVED on the
 *    retest's results' lot: the retest itself is recorded by QC from approved RETEST results);
 *  - LOT_DECISION: RELEASE (MATERIAL_LOT_RELEASED) or REJECT (MATERIAL_LOT_REJECTED from quarantine, otherwise
 *    MATERIAL_LOT_STATUS_DECIDED) of a material lot, as the lot's state machine names them;
 *    Phase 4 slice 2b: also HOLD, UNHOLD, RETURN and RECALL (MATERIAL_LOT_STATUS_DECIDED over the proposed decision);
 *  - LIMS_ACT (Phase 4 slice 2b): SPECIFICATION_APPROVE (SPECIFICATION_APPROVED, never by the drafter) and
 *    RETURN_ASSESSMENT_SIGN (RETURNED_GOODS_ASSESSED, by the QC person who recorded the assessment);
 *  - REPROCESSING_ACT: RESERVE_RESIDUE (RESIDUE_RESERVED), AUTHORISE_ADDITION and AUTHORISE_REQUEST
 *    (REPROCESSING_AUTHORISED);
 *  - MASTER_DATA_APPROVE: a formula version (FORMULA_APPROVED, by a person other than its author); a received ERP
 *    product or material master version that changes a controlled value, or names a new code (ERP_MASTER_CONFIRMED by
 *    QA, never the ERP interface's own person; site-services 0802);
 *  - ACT_APPROVAL: the approval of an act proposed on a GMP batch (recipe.propose_act), with the act's own meaning
 *    (VOID_AUTHORISED for a void), by another person than the requester;
 *  - PLANT_VERIFY: CLEANING and REPAIR (LOGBOOK_DOUBLE_CHECKED), CLEARANCE (the clearance verification meaning of
 *    recipe-core 0404).
 * Phase 4 slice 1 (review; recipe-core 0710 to 0739; aggregates and meanings in ns/review.ts):
 *  - REVIEW_ACT: PRODUCTION_APPROVE, QA_REVIEW, AUDIT_TRAIL_REVIEW, DELTA_REVIEW, REOPEN and DISPOSE_ITEM of a GMP batch
 *    record; the input members an act does not use are refused by the handler (422).
 *  - CORRECTION_APPROVAL: the approval of an entry correction (CORRECTION_APPROVED on the data point, batch_point
 *    `<batch>:<point>`), given before the corrector's signed CORRECT_ENTRY names it (S25; QA when a failing value, or a
 *    loop reading that missed its endpoint, would change: plan open question 1, default taken).
 * Phase 4 slice 1b (containers; recipe-core 0740, 0741; ns/containers.ts):
 *  - CONTAINER_ACT: VERIFY_CLOSE (VERIFIED on the output container, by a second person, never its closer or opener) and
 *    RELEASE (OUTPUT_CONTAINER_RELEASED, by QA, once the hold's exceptions are dispositioned and deviations concluded).
 * Phase 4 slice 3 (release; recipe-core 0780 to 0809; aggregates and meanings in ns/release.ts):
 *  - RELEASE_ACT: MANUFACTURER_RELEASE and MANUFACTURER_REJECT of a finished lot (MANUFACTURER_RELEASE, AP or named
 *    delegate), POST_CHANGE_EVALUATE (IN-03), PPQ_OUTCOME (PR-09) and INVESTIGATION_JUSTIFY (PR-53); the market, recall
 *    and disposal acts are reserved for slices 4 and 5 (the handler refuses them until then, 501).
 * Phase 4 slice 4 (4-0; recipe-core 0820 to 0849, tablets 1180 to 1189):
 *  - RELEASE_ACT US_DISPOSE        us_disposition <lot>/<RELEASE|REJECT>                    US_DISPOSITION (QCU role)
 *                MANUFACTURER_RELEASE with usExpectedEpoch: two rows in one ceremony (D-P4-5), the companion challenge
 *                                signs us_disposition <lot>/RELEASE
 *                QP_INTAKE         qp_transcription <lot>/<sha256 of the canonical details>  QP_CERTIFICATION_RECORDED (QA)
 *                QP_INTAKE_VERIFY  qp_transcription_check <intake>                         QP_CERTIFICATION_VERIFIED (another QA person, DI-30)
 *                QP_CERTIFY        qp_certification <lot>/<CERTIFIED|REJECTED_BY_QP>        QP_CERTIFIED (registered QP, switch on, PR-55)
 *                MARKET_ADD        market_change LOT/<lot>/ADD/<market>                    MARKET_ADDED (QA, with a change record)
 *                MARKET_REMOVE     market_change LOT/<lot>/REMOVE/<market>                 MARKET_REMOVED (QA, with a linked deviation)
 *  - BATCH_MARKET_ACT MARKET_ADD, MARKET_REMOVE  market_change BATCH/<batch>/<ADD|REMOVE>/<market>  as above.
 * Phase 4 slice 4b (kernel 1160):
 *  - QP_PACKAGE_ACT ISSUE  qp_package <package id>  TRUE_COPY_VERIFIED (QA): issues the assembled EU QP batch package.
 * Phase 4 slice 5a (recipe-core 0840 to 0869; L-19, PR-46, IN-05 (e)):
 *  - RELEASE_ACT RECONFIRM             release_suspension <lot>/<market>/RECONFIRM/<n>             RELEASE_RECONFIRMED (AP)
 *                RECALL                release_suspension <lot>/<market>/RECALL/<n>                RECALLED (AP)
 *                REJECT_AFTER_RELEASE  release_suspension <lot>/<market>/REJECT_AFTER_RELEASE/<n>  REJECTED_AFTER_RELEASE (AP)
 *                DISPOSAL              disposal <lot>/<sha256 of the details>  DISPOSAL_RECORDED; with `disposalId` only,
 *                                      DESTRUCTION_WITNESSED on the same record by an independent witness
 * Phase 4 slice 5b (recipe-core 0870 to 0889; ns/records-lock.ts):
 *  - RECORD_LOCK_ACT AMENDMENT_OPEN   record_lock <batch>/<n>/OPEN/<DEVIATION|CHANGE_RECORD>/<id>  AMENDMENT_OPENED (QA)
 *                    AMENDMENT_CLOSE  record_lock <batch>/<n>/CLOSE                                 AMENDMENT_CLOSED (QA)
 * Phase 4 slice 6c (recipe-core 0910; ns/pqr.ts):
 *  - PQR_SIGN_OFF  pqr_extract <extract id>  PQR_SIGNED_OFF (AP, outside the reviewed batches' records), state EXTRACTED
 * Phase 4 slice 6b (kernel 1170, 1171; ns/archive.ts):
 *  - ARCHIVE_ACT CERTIFY_EXPORT  evidence_export <export id>     EVIDENCE_EXPORT_CERTIFIED (QA), state ASSEMBLED
 *                SIGN_FORMS      form_reconciliation <batch id>  FORMS_RECONCILED (QA), state RECONCILED
 * Phase 4 slice 6a (site services 0885; ns/india.ts):
 *  - INDIA_ACT LICENCE_APPROVE            manufacturing_licence <licence id>     LICENCE_APPROVED (QA, never the recorder)
 *              EXPORT_PERMISSION_APPROVE  export_permission <permission id>      EXPORT_PERMISSION_APPROVED (QA, never the recorder)
 *              HAZARD_APPROVE             hazard_classification <record id>      HAZARD_CLASSIFICATION_APPROVED (QA, never the recorder)
 *              DEDICATION_APPROVE         area_dedication <record id>            AREA_DEDICATION_APPROVED (QA, never the recorder)
 */
import { z } from 'zod';
import { DataValueWire, RunVersion, Uuid } from './common.ts';
import { ActId, SignedIntent } from './intents.ts';

/**
 * What a quality act carries besides its subject: the extra-testing decision and its tests; the retest's new date and
 * its approved RETEST results. Members another act does not use are refused by the handler (422).
 */
export const QualityActInput = z.strictObject({
  decision: z.enum(['NONE_REQUIRED', 'EXTRA_TESTS']).optional(),
  tests: z.array(z.string().regex(/^[A-Z0-9][A-Z0-9/._-]{0,39}$/)).max(50).optional(),
  /** LOT_RETEST: the new retest date as an ISO-8601 instant with offset; the database checks it against the master's limit. */
  retestAt: z.iso.datetime({ offset: true }).optional(),
  results: z.array(Uuid).max(50).optional(),
});
export type QualityActInput = z.infer<typeof QualityActInput>;

/** What a review act carries besides its batch; members another act does not use are refused by the handler (422). */
export const ReviewActInput = z.strictObject({
  /** QA_REVIEW: the batch's evidence epoch the reviewer evaluated (a later bump refuses the act: write after evaluation). */
  expectedEpoch: z.string().regex(/^(0|[1-9][0-9]*)$/).optional(),
  /** REOPEN: the person's own reason, both halves (L-09, DI-22). */
  reason: z.strictObject({ code: z.string().trim().min(1).max(64), text: z.string().trim().min(1).max(2000) }).optional(),
  /** DISPOSE_ITEM: the exception ids (one for a critical item; several only for grouped acceptance, PR-52). */
  items: z.array(z.string().min(1).max(128)).min(1).max(500).optional(),
  disposition: z.enum(['ACCEPT', 'QUERY', 'ESCALATE']).optional(),
  /** DISPOSE_ITEM: the justification (ACCEPT of a critical item or a group), the query text (QUERY) or the reason (ESCALATE). */
  justification: z.string().trim().min(1).max(4000).optional(),
  /** DISPOSE_ITEM ESCALATE: the deviation-lite record linked to the batch the item is escalated to. */
  deviationRef: z.string().trim().min(1).max(128).optional(),
  /** AUDIT_TRAIL_REVIEW, DELTA_REVIEW: the review the report names (`reviewId` of review.auditTrail, `<batch>/<n>`). */
  reviewId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[1-9][0-9]{0,6}$/).optional(),
  /** REOPEN: the review cycle being reopened (`cycle` of review.batch). */
  cycle: z.number().int().min(1).max(1_000_000).optional(),
});
export type ReviewActInput = z.infer<typeof ReviewActInput>;

/** What a release act carries besides its lot; members an act does not use are refused by the handler (422). */
export const ReleaseActInput = z.strictObject({
  /** MANUFACTURER_RELEASE, MANUFACTURER_REJECT (and the market acts): the G-REL epoch the signer evaluated (INV-05: a later change refuses it). */
  expectedEpoch: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /** MANUFACTURER_RELEASE, MANUFACTURER_REJECT: the delegation a named delegate of the AP cites (checked at signing). */
  delegationId: Uuid.optional(),
  /** MANUFACTURER_REJECT: the person's own reason, both halves (DI-22). */
  reason: z.strictObject({ code: z.string().trim().min(1).max(64), text: z.string().trim().min(1).max(2000) }).optional(),
  /** POST_CHANGE_EVALUATE, PPQ_OUTCOME: the batch of the lot's evidence set the act is about. */
  batchId: Uuid.optional(),
  /** PPQ_OUTCOME: the validation outcome, or CONCURRENT_RELEASE under a protocol that permits it (US only, D-P4-6). */
  outcome: z.enum(['PASSED', 'FAILED', 'CONCURRENT_RELEASE']).optional(),
  /** PPQ_OUTCOME: the protocol (and report, when known) the outcome is recorded under. */
  protocolRef: z.string().trim().min(1).max(128).optional(),
  /** INVESTIGATION_JUSTIFY: the open deviation-lite record; POST_CHANGE_EVALUATE, PPQ_OUTCOME, INVESTIGATION_JUSTIFY: the text. */
  deviationId: Uuid.optional(),
  text: z.string().trim().min(1).max(4000).optional(),
  // Slice 4 (4-0): market dispositions, certification intake, market add and removal.
  /**
   * MANUFACTURER_RELEASE only, D-P4-5: the AP also holds the QCU permission and releases the lot for the US in the same
   * ceremony: the G-REL epoch for US the signer evaluated. Two signature rows are written (MANUFACTURER_RELEASE and
   * US_DISPOSITION), each on its own record; the companion challenge is the US_DISPOSITION one (esig sign).
   */
  usExpectedEpoch: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /** US_DISPOSE: RELEASE or REJECT (a rejection carries `reason` and the investigation `deviationId`, PR-56). */
  usDecision: z.enum(['RELEASE', 'REJECT']).optional(),
  /** MARKET_ADD, MARKET_REMOVE: the market. */
  market: z.enum(['IN', 'US', 'EU']).optional(),
  /** MARKET_ADD: the change record the addition is made under (3.3.3). MARKET_REMOVE names `deviationId` instead. */
  changeRecordId: Uuid.optional(),
  /** QP_INTAKE (transcribed), QP_CERTIFY (in-system): the outcome. */
  qpOutcome: z.enum(['CERTIFIED', 'REJECTED_BY_QP']).optional(),
  /** QP_INTAKE: the certification as received outside a structured message, transcribed (DI-30: a second person verifies it). */
  certification: z
    .strictObject({
      certifier: z.string().trim().min(1).max(200),
      miaNumber: z.string().trim().min(1).max(64),
      certifiedAt: z.iso.datetime({ offset: true }),
      reference: z.string().trim().min(1).max(128),
    })
    .optional(),
  /** QP_INTAKE_VERIFY: the transcription the second person verifies. */
  intakeId: Uuid.optional(),
  // Slice 5a: after release. RECONFIRM carries `market`, `expectedEpoch` (G-REL of the market) and `text` (the impact
  // assessment); RECALL and REJECT_AFTER_RELEASE carry `market` and `reason`.
  /** DISPOSAL (record): the route (D-5-6). */
  disposalRoute: z.enum(['WITNESSED_DESTRUCTION', 'REPROCESSING', 'RETURN']).optional(),
  /** DISPOSAL (record): the quantity disposed of, as a decimal in the lot's unit. */
  disposalQuantity: z.string().regex(/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/).optional(),
  /** DISPOSAL RETURN: to the SUPPLIER or the CUSTOMER. */
  returnTo: z.enum(['SUPPLIER', 'CUSTOMER']).optional(),
  /** DISPOSAL: the return reference (RETURN, required) or the destruction record reference. */
  disposalReference: z.string().trim().min(1).max(128).optional(),
  /** DISPOSAL REPROCESSING: the Phase 3 reprocessing authorisation or request of the same product. */
  reprocessingRef: Uuid.optional(),
  /** DISPOSAL (witness): the recorded destruction the independent witness signs. */
  disposalId: Uuid.optional(),
});
export type ReleaseActInput = z.infer<typeof ReleaseActInput>;

/** What a batch market act carries besides its batch (3.3.3; members an act does not use are refused, 422). */
export const BatchMarketActInput = z.strictObject({
  market: z.enum(['IN', 'US', 'EU']),
  /** MARKET_ADD: the change record. */
  changeRecordId: Uuid.optional(),
  /** MARKET_REMOVE: the linked deviation-lite record. */
  deviationId: Uuid.optional(),
});
export type BatchMarketActInput = z.infer<typeof BatchMarketActInput>;

/** What a record-lock act carries besides its batch (members an act does not use are refused, 422). */
export const RecordLockActInput = z.strictObject({
  /** AMENDMENT_OPEN: the open deviation linked to the record, or the change record, the amendment is made under (one of them). */
  deviationId: Uuid.optional(),
  changeRecordId: Uuid.optional(),
  /** AMENDMENT_OPEN: the person's own reason, both halves (DI-22). */
  reason: z.strictObject({ code: z.string().trim().min(1).max(64), text: z.string().trim().min(10).max(2000) }).optional(),
  /** AMENDMENT_CLOSE: the closing statement (what the amendment found and appended). */
  statement: z.string().trim().min(10).max(4000).optional(),
});
export type RecordLockActInput = z.infer<typeof RecordLockActInput>;

export const RELEASE_ACTS = [
  'MANUFACTURER_RELEASE',
  'MANUFACTURER_REJECT',
  'POST_CHANGE_EVALUATE',
  'PPQ_OUTCOME',
  'INVESTIGATION_JUSTIFY',
  'US_DISPOSE',
  'QP_INTAKE',
  'QP_CERTIFY',
  'QP_INTAKE_VERIFY',
  'MARKET_ADD',
  'MARKET_REMOVE',
  'RECONFIRM',
  'RECALL',
  'REJECT_AFTER_RELEASE',
  'DISPOSAL',
] as const;

export const SignableAction = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('ENGINE_COMMAND'),
    runId: Uuid,
    /** Run version the person reviewed (optimistic locking; stale gives 409). */
    expectedVersion: RunVersion,
    intent: SignedIntent,
  }),
  z.strictObject({
    kind: z.literal('MBR_TRANSITION'),
    versionId: Uuid,
    transition: z.enum(['SUBMIT', 'CHECK', 'APPROVE', 'REGULATORY_CONFIRM']),
    baseRevision: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal('GMP_BATCH_ISSUE'),
    batchId: Uuid,
    /** The issuer's own reason for the issue, both halves (DI-22, DI-24). */
    reason: z.strictObject({ code: z.string().trim().min(1).max(64), text: z.string().trim().min(1).max(2000) }),
    variants: z.record(z.string(), z.string()),
    inputs: z.record(z.string(), DataValueWire),
  }),
  z.strictObject({
    kind: z.literal('ESIG_STUB'),
    stubId: Uuid,
  }),
  z.strictObject({
    kind: z.literal('QUALITY_ACT'),
    act: z.enum(['DEVIATION_IMPACT_ASSESS', 'DEVIATION_CONCLUDE', 'DEVIATION_CLOSE', 'LOT_RESULT_APPROVE', 'QC_EXTRA_TESTING_DECISION', 'LOT_RETEST']),
    /** The deviation (conclude, close), the lot test result (approve), the GMP batch (extra testing) or the lot (retest). */
    subjectId: Uuid,
    input: QualityActInput,
  }),
  z.strictObject({
    kind: z.literal('LOT_DECISION'),
    lotId: Uuid,
    /** Phase 4 slice 2b: HOLD, UNHOLD, RETURN and RECALL sign MATERIAL_LOT_STATUS_DECIDED over the decision QA proposed (D-P4-3). */
    decision: z.enum(['RELEASE', 'REJECT', 'HOLD', 'UNHOLD', 'RETURN', 'RECALL']),
    /** A RELEASE names its route, and only a RELEASE does (IN-24 (c)). */
    route: z.enum(['IDENTITY_TESTED', 'VENDOR_HISTORY']).optional(),
    /** The person's own reason, both halves (a status decision such as a rejection carries one: DI-22, EBMR-AUDIT-002). */
    reason: z.strictObject({ code: z.string().trim().min(1).max(64), text: z.string().trim().min(1).max(2000) }).optional(),
  }),
  z.strictObject({
    /** Phase 4 slice 2b (ns/specifications.ts, ns/samples.ts): a specification's approval, QC's signature of a returned-goods assessment. */
    kind: z.literal('LIMS_ACT'),
    act: z.enum(['SPECIFICATION_APPROVE', 'RETURN_ASSESSMENT_SIGN']),
    /** The specification version (approve) or the returned lot (assessment). */
    subjectId: Uuid,
  }),
  z.strictObject({
    kind: z.literal('REPROCESSING_ACT'),
    act: z.enum(['RESERVE_RESIDUE', 'AUTHORISE_ADDITION', 'AUTHORISE_REQUEST']),
    /** The residue container (reserve), the reprocessing authorisation (addition) or the reprocessing request (request). */
    subjectId: Uuid,
    input: z.strictObject({}),
  }),
  z.strictObject({
    kind: z.literal('MASTER_DATA_APPROVE'),
    /** A formula version (FORMULA_APPROVED), or a received ERP product or material master version (ERP_MASTER_CONFIRMED). */
    masterKind: z.enum(['FORMULA', 'ERP_PRODUCT', 'ERP_MATERIAL']),
    versionId: Uuid,
  }),
  z.strictObject({
    kind: z.literal('ACT_APPROVAL'),
    /** The GMP batch and the act proposed on it (aggregate batch_act): QA's VOID_AUTHORISED approval of a void (S28). */
    batchId: Uuid,
    actId: ActId,
  }),
  z.strictObject({
    kind: z.literal('PLANT_VERIFY'),
    act: z.enum(['CLEANING', 'CLEARANCE', 'REPAIR']),
    /** The cleaning, clearance or repair record. */
    id: Uuid,
  }),
  z.strictObject({
    kind: z.literal('REVIEW_ACT'),
    act: z.enum(['PRODUCTION_APPROVE', 'QA_REVIEW', 'AUDIT_TRAIL_REVIEW', 'DELTA_REVIEW', 'REOPEN', 'DISPOSE_ITEM']),
    /** The GMP batch whose record (processing or packaging) is reviewed. */
    batchId: Uuid,
    input: ReviewActInput,
  }),
  z.strictObject({
    kind: z.literal('CORRECTION_APPROVAL'),
    batchId: Uuid,
    /** The data point the correction replaces. */
    point: z.string().min(1).max(256),
  }),
  z.strictObject({
    kind: z.literal('CONTAINER_ACT'),
    /** VERIFY_CLOSE: the second person's VERIFIED check of a typed net (DI-30); RELEASE: QA's OUTPUT_CONTAINER_RELEASED. */
    act: z.enum(['VERIFY_CLOSE', 'RELEASE']),
    containerId: Uuid,
    /** The person's own reason; a RELEASE carries one (it changes the container's state, EBMR-AUDIT-002). */
    reason: z.strictObject({ code: z.string().trim().min(1).max(64), text: z.string().trim().min(1).max(2000) }).optional(),
  }),
  z.strictObject({
    kind: z.literal('RELEASE_ACT'),
    act: z.enum(RELEASE_ACTS),
    /** The finished lot (site.finished_lot) the act is about. */
    lotId: Uuid,
    input: ReleaseActInput,
  }),
  z.strictObject({
    kind: z.literal('BATCH_MARKET_ACT'),
    /** Phase 4 slice 4: add a market to an issued batch's set (MARKET_ADDED) or remove one (MARKET_REMOVED), 3.3.3. */
    act: z.enum(['MARKET_ADD', 'MARKET_REMOVE']),
    batchId: Uuid,
    input: BatchMarketActInput,
  }),
  z.strictObject({
    kind: z.literal('QP_PACKAGE_ACT'),
    /** Phase 4 slice 4b: QA verifies the assembled EU QP batch package as a true copy and issues it (DI-41). */
    act: z.literal('ISSUE'),
    packageId: Uuid,
  }),
  z.strictObject({
    kind: z.literal('RECORD_LOCK_ACT'),
    /** Phase 4 slice 5b: QA opens an amendment of a locked record (AMENDMENT_OPENED) or closes it, re-locking (AMENDMENT_CLOSED). */
    act: z.enum(['AMENDMENT_OPEN', 'AMENDMENT_CLOSE']),
    batchId: Uuid,
    input: RecordLockActInput,
  }),
  z.strictObject({
    kind: z.literal('PQR_SIGN_OFF'),
    /** Phase 4 slice 6c: the authorised person signs off a reproducing, reconciled PQR extract (IN-01 (b), PR-58). */
    extractId: Uuid,
  }),
  z.strictObject({
    kind: z.literal('ARCHIVE_ACT'),
    /** Phase 4 slice 6b: QA certifies an evidence export (IN-11) or signs the reconciliation of a batch's paper forms (DI-43). */
    act: z.enum(['CERTIFY_EXPORT', 'SIGN_FORMS']),
    /** The export (CERTIFY_EXPORT) or the batch (SIGN_FORMS). */
    subjectId: Uuid,
  }),
  z.strictObject({
    /** Phase 4 slice 6a (ns/india.ts): QA's approval of a recorded licence or export permission. */
    kind: z.literal('INDIA_ACT'),
    /** Slice 6 quick review (recipe-core 0912): a second QA person approves a hazard classification or an area dedication. */
    act: z.enum(['LICENCE_APPROVE', 'EXPORT_PERMISSION_APPROVE', 'HAZARD_APPROVE', 'DEDICATION_APPROVE']),
    /** The licence, the export permission, or the hazard or dedication record. */
    subjectId: Uuid,
  }),
  z.strictObject({
    /** Phase 6 slice 6a (ns/capa.ts): QA closes a CAPA (CAPA_CLOSED, never its initiator; refused while not effective, PR-51). */
    kind: z.literal('CAPA_ACT'),
    act: z.literal('CLOSE'),
    capaId: Uuid,
  }),
]);
export type SignableAction = z.infer<typeof SignableAction>;
export type SignableKind = SignableAction['kind'];
