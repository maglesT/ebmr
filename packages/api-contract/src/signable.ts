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
 *  - QUALITY_ACT: DEVIATION_CONCLUDE (DEVIATION_CONCLUDED), DEVIATION_CLOSE (DEVIATION_CLOSED), LOT_RESULT_APPROVE
 *    (QC_RESULT_APPROVED), QC_EXTRA_TESTING_DECISION (QC_EXTRA_TESTING_DECIDED), LOT_RETEST (QC_RESULT_APPROVED on the
 *    retest's results' lot: the retest itself is recorded by QC from approved RETEST results);
 *  - LOT_DECISION: RELEASE (MATERIAL_LOT_RELEASED) or REJECT (MATERIAL_LOT_REJECTED from quarantine, otherwise
 *    MATERIAL_LOT_STATUS_DECIDED) of a material lot, as the lot's state machine names them;
 *  - REPROCESSING_ACT: RESERVE_RESIDUE (RESIDUE_RESERVED), AUTHORISE_ADDITION and AUTHORISE_REQUEST
 *    (REPROCESSING_AUTHORISED);
 *  - MASTER_DATA_APPROVE: a formula version (FORMULA_APPROVED, by a person other than its author);
 *  - ACT_APPROVAL: the approval of an act proposed on a GMP batch (recipe.propose_act), with the act's own meaning
 *    (VOID_AUTHORISED for a void), by another person than the requester;
 *  - PLANT_VERIFY: CLEANING and REPAIR (LOGBOOK_DOUBLE_CHECKED), CLEARANCE (the clearance verification meaning of
 *    recipe-core 0404).
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
    act: z.enum(['DEVIATION_CONCLUDE', 'DEVIATION_CLOSE', 'LOT_RESULT_APPROVE', 'QC_EXTRA_TESTING_DECISION', 'LOT_RETEST']),
    /** The deviation (conclude, close), the lot test result (approve), the GMP batch (extra testing) or the lot (retest). */
    subjectId: Uuid,
    input: QualityActInput,
  }),
  z.strictObject({
    kind: z.literal('LOT_DECISION'),
    lotId: Uuid,
    decision: z.enum(['RELEASE', 'REJECT']),
    /** A RELEASE names its route, and only a RELEASE does (IN-24 (c)). */
    route: z.enum(['IDENTITY_TESTED', 'VENDOR_HISTORY']).optional(),
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
    masterKind: z.literal('FORMULA'),
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
]);
export type SignableAction = z.infer<typeof SignableAction>;
export type SignableKind = SignableAction['kind'];
