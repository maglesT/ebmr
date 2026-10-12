/**
 * Namespace `archive` (Phase 4 slice 6b, GMP): batch records as kept, copied and inspected (kernel 1170 to 1172;
 * D-6-4 to D-6-6, D-P4-7; DI-40, DI-41, DI-43, DI-46, DI-47, IN-08, IN-11, PR-16, PR-59).
 *
 *  - Retention: the batch's facts (markets, issue date, expiry of its lots, EU certification or final rejection, abort)
 *    become the kernel retention engine's inputs; the database computes the earliest date the record may go and which
 *    rule governs it; a processing record follows the packaging records made from it. Nothing is deleted: a deletion
 *    request is answered and logged (refused before the date).
 *  - Contingency packs: numbered paper forms issued at batch issue or at a stage start; each is returned, transcribed
 *    and verified by a second person, or voided (a missing one only with its deviation reference); QA signs the
 *    reconciliation (FORMS_RECONCILED). records.form_reconciliation_problem says whether the batch may complete.
 *  - Evidence export: the batch record's true-copy bundles and its PDF/A-3 rendering (same content, same bytes) in one
 *    file whose SHA-256 the database checks; QA certifies it (EVIDENCE_EXPORT_CERTIFIED). The verifier checks a file
 *    offline: one altered byte fails it.
 *  - Inspection workspace: certified exports, read-only, every read logged (ARCHIVE.INSPECT).
 *
 * Signed acts (signable action ARCHIVE_ACT, signable.ts):
 *    CERTIFY_EXPORT  evidence_export <export id>      EVIDENCE_EXPORT_CERTIFIED (QA), state ASSEMBLED
 *    SIGN_FORMS      form_reconciliation <batch id>   FORMS_RECONCILED (QA), state RECONCILED
 */
import { z } from 'zod';
import { Instant, PersonRef, Uuid, withAttribution } from '../common.ts';
import { defineRoute } from '../route.ts';

const CalendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a calendar date YYYY-MM-DD');
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'a SHA-256 in hex');

export const RetentionView = z.strictObject({
  batchId: Uuid,
  /** The inputs as the engine reads them (from the batch's record). */
  inputs: z.strictObject({
    markets: z.array(z.enum(['IN', 'US', 'EU'])),
    licenceForm: z.enum(['FORM_25', 'FORM_28']).nullable(),
    manufactureDate: CalendarDate,
    expiryDate: CalendarDate.nullable(),
    outcome: z.enum(['IN_PROGRESS', 'COMPLETED', 'ABORTED', 'CANCELLED']),
    abortCancelDate: CalendarDate.nullable(),
    eu: z.enum(['NOT_IN_SET', 'PENDING', 'CERTIFIED', 'FINALLY_REJECTED']),
    euDate: CalendarDate.nullable(),
  }),
  /** DATED: kept until retainUntil; OPEN: no date yet (why in openBecause). */
  status: z.enum(['DATED', 'OPEN']),
  retainUntil: CalendarDate.nullable(),
  /** The rules that give the batch's own date (e.g. IN_FORM25_MANUFACTURE, EU_QP_CERTIFICATION). */
  governingRules: z.array(z.string()),
  /** The records whose date governs (another record that depends on this one may hold it longer). */
  governedBy: z.array(z.string()),
  openBecause: z.array(z.string()),
  /** Whether the database holds a schedule for the record (the date above is then the stored one). */
  scheduled: z.boolean(),
  /** Why the inputs stored differ from the record now ([] when they agree, or no schedule yet). */
  drift: z.array(z.string()),
  disposalRequests: z.array(z.strictObject({ outcome: z.enum(['REFUSED', 'ELIGIBLE']), reason: z.string(), by: PersonRef, at: Instant })),
});
export type RetentionView = z.infer<typeof RetentionView>;

export const DisposalAnswerView = z.strictObject({
  outcome: z.enum(['REFUSED', 'ELIGIBLE']),
  retainUntil: CalendarDate.nullable(),
  refusals: z.array(z.strictObject({ code: z.string(), detail: z.string() })),
});
export type DisposalAnswerView = z.infer<typeof DisposalAnswerView>;

export const ContingencyFormState = z.enum(['ISSUED', 'RETURNED', 'TRANSCRIBED', 'VERIFIED', 'VOIDED', 'MISSING']);
export type ContingencyFormState = z.infer<typeof ContingencyFormState>;

export const ContingencyFormView = z.strictObject({
  formId: Uuid,
  serial: z.string(),
  moment: z.enum(['ISSUE', 'STAGE_START']),
  stageRef: z.string().nullable(),
  templateRef: z.string(),
  destination: z.string(),
  page: z.string(),
  state: ContingencyFormState,
  issuedBy: PersonRef,
  issuedAt: Instant,
  events: z.array(z.strictObject({ event: z.string(), reason: z.string().nullable(), reference: z.string().nullable(), by: PersonRef, at: Instant })),
});
export type ContingencyFormView = z.infer<typeof ContingencyFormView>;

export const FormsView = z.strictObject({
  batchId: Uuid,
  /** NONE (no form issued: nothing to reconcile), OPEN, RECONCILED (not yet signed), SIGNED. */
  state: z.enum(['NONE', 'OPEN', 'RECONCILED', 'SIGNED']),
  /** Why the batch may not complete as far as its paper forms go, or null. */
  completionProblem: z.string().nullable(),
  forms: z.array(ContingencyFormView),
  signedBy: PersonRef.nullable(),
  signedAt: Instant.nullable(),
});
export type FormsView = z.infer<typeof FormsView>;

export const ExportSectionView = z.strictObject({
  name: z.string(),
  kind: z.enum(['TRUE_COPY', 'PDF_TRUE_COPY', 'DOCUMENT']),
  title: z.string(),
  chainKey: z.string().nullable(),
  sha256: Sha256,
  bytes: z.number().int().nonnegative(),
});

export const ExportView = z.strictObject({
  exportId: Uuid,
  batchId: Uuid,
  label: z.string(),
  state: z.enum(['ASSEMBLED', 'CERTIFIED']),
  exportSha256: Sha256,
  pdfContentSha256: Sha256,
  contentBytes: z.number().int().nonnegative(),
  sections: z.array(ExportSectionView),
  assembledBy: PersonRef,
  assembledAt: Instant,
  certifiedBy: PersonRef.nullable(),
  certifiedAt: Instant.nullable(),
  reads: z.number().int().nonnegative(),
});
export type ExportView = z.infer<typeof ExportView>;

export const ArchiveBatchSummary = z.strictObject({
  batchId: Uuid,
  batchNumber: z.string(),
  status: z.string(),
  formsState: FormsView.shape.state,
  exports: z.number().int().nonnegative(),
  certifiedExports: z.number().int().nonnegative(),
});
export type ArchiveBatchSummary = z.infer<typeof ArchiveBatchSummary>;

export const ArchiveBatchView = z.strictObject({
  batchId: Uuid,
  batchNumber: z.string(),
  status: z.string(),
  retention: RetentionView,
  forms: FormsView,
  exports: z.array(ExportView),
});
export type ArchiveBatchView = z.infer<typeof ArchiveBatchView>;

export const TrueCopyPdfView = z.strictObject({
  fileName: z.string(),
  pdfBase64: z.string(),
  pdfSha256: Sha256,
  contentSha256: Sha256,
  recordDate: z.string(),
});
export type TrueCopyPdfView = z.infer<typeof TrueCopyPdfView>;

export const ExportFileView = z.strictObject({ exportId: Uuid, fileName: z.string(), exportSha256: Sha256, text: z.string() });
export type ExportFileView = z.infer<typeof ExportFileView>;

export const VerificationView = z.strictObject({
  ok: z.boolean(),
  exportSha256: z.string().nullable(),
  reference: z.enum(['MATCHED', 'MISMATCHED', 'NONE']),
  /** The registered export with that SHA-256, if any, and whether it is certified. */
  registered: z.strictObject({ exportId: Uuid, label: z.string(), certified: z.boolean() }).nullable(),
  sections: z.number().int().nonnegative(),
  problems: z.array(z.string()),
});
export type VerificationView = z.infer<typeof VerificationView>;

const batchParams = z.strictObject({ batchId: Uuid });
const reason = z.string().trim().min(10).max(2000);

export const archive = {
  batches: defineRoute({
    id: 'archive.batches',
    method: 'GET',
    path: '/api/archive/batches',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'GMP batches with their paper-form state and evidence exports, newest first',
    response: z.strictObject({ batches: z.array(ArchiveBatchSummary) }),
  }),
  batch: defineRoute({
    id: 'archive.batch',
    method: 'GET',
    path: '/api/archive/batches/:batchId',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'One batch: its retention (computed by the database), its contingency forms and its evidence exports',
    params: batchParams,
    response: ArchiveBatchView,
  }),
  syncRetention: defineRoute({
    id: 'archive.syncRetention',
    method: 'POST',
    path: '/api/archive/batches/:batchId/retention',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'Store the batch\'s retention inputs from its record (schedule created or inputs changed with the reason) and link it to the records it depends on',
    params: batchParams,
    body: z.strictObject({ reason }),
    response: RetentionView,
  }),
  requestDisposal: defineRoute({
    id: 'archive.requestDisposal',
    method: 'POST',
    path: '/api/archive/batches/:batchId/disposal-requests',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'Ask to delete the batch record: answered and logged by the database, never carried out here (refused before its date)',
    params: batchParams,
    body: z.strictObject({ reason }),
    response: DisposalAnswerView,
  }),
  issuePack: defineRoute({
    id: 'archive.issuePack',
    method: 'POST',
    path: '/api/archive/batches/:batchId/contingency-packs',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Issue a numbered contingency pack for the batch at its issue or at a stage start (DI-43)',
    params: batchParams,
    body: withAttribution({
      moment: z.enum(['ISSUE', 'STAGE_START']),
      stageRef: z.string().trim().min(1).max(120).optional(),
      templateRef: z.string().trim().min(1).max(200),
      destination: z.string().trim().min(1).max(200),
      pages: z.number().int().min(1).max(50),
      reason,
    }),
    response: FormsView,
  }),
  formEvent: defineRoute({
    id: 'archive.formEvent',
    method: 'POST',
    path: '/api/archive/forms/:formId/events',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Record what happened to one contingency form (returned, transcribed, verified by a second person, voided, missing)',
    params: z.strictObject({ formId: Uuid }),
    body: withAttribution({
      event: z.enum(['RETURNED', 'TRANSCRIBED', 'VERIFIED', 'VOIDED', 'REPORTED_MISSING']),
      reason: z.string().trim().min(1).max(2000).optional(),
      reference: z.string().trim().min(1).max(200).optional(),
    }),
    response: FormsView,
  }),
  pdf: defineRoute({
    id: 'archive.pdf',
    method: 'GET',
    path: '/api/archive/batches/:batchId/pdf',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The PDF/A-3 true copy of the batch record (the same record content always gives the same bytes)',
    params: batchParams,
    response: TrueCopyPdfView,
  }),
  assembleExport: defineRoute({
    id: 'archive.assembleExport',
    method: 'POST',
    path: '/api/archive/batches/:batchId/exports',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'Assemble and register the evidence export of the batch (true copies and the PDF/A-3 rendering); the database checks every section',
    params: batchParams,
    response: ExportView,
  }),
  inspection: defineRoute({
    id: 'archive.inspection',
    method: 'GET',
    path: '/api/archive/inspection',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The inspection workspace: certified evidence exports, read-only (ARCHIVE.INSPECT)',
    response: z.strictObject({ exports: z.array(ExportView) }),
  }),
  exportFile: defineRoute({
    id: 'archive.exportFile',
    method: 'GET',
    path: '/api/archive/exports/:exportId/file',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Download one certified evidence export from the inspection workspace (each read is logged)',
    params: z.strictObject({ exportId: Uuid }),
    response: ExportFileView,
  }),
  verify: defineRoute({
    id: 'archive.verify',
    method: 'POST',
    path: '/api/archive/verify',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Verify an evidence export file with the kernel verifier (offline checks, then the register; files up to the request limit of 2 MB): one altered byte fails it',
    body: z.strictObject({ text: z.string().min(1).max(2_000_000) }),
    response: VerificationView,
  }),
} as const;
