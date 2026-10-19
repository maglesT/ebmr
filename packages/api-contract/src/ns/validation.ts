/**
 * Namespace `validation` (Phase 7 slice 7g-3, work package WP1; decision 0025: every act has a screen): the validation
 * and records acts a person did from a command line or that had no route.
 *
 *  - The approved system description (kernel 1300; DI-06, DI-09): every interface in force, the active adapters it does
 *    not describe, and a new version of an interface under an approved change record (CONFIG.SYSTEM_DESCRIPTION).
 *  - The validation summary (kernel 1300; DI-03): the running release, whether it has an approved summary
 *    (platform.validation_summary_problem), the summary document of the shipped evidence bundle; QA approves it with the
 *    signable action VALIDATION_SUMMARY_APPROVE.
 *  - The evidence bundle and the validation pack (slice 7c): the release's bundle as shipped (EBMR_VALIDATION_BUNDLE) and
 *    the pack generated from it, read and downloaded.
 *  - The IQ (slice 7c; decision D-P7R-5; kernel 1381): the installation qualification run against the shipped bundle, its
 *    record stored with its SHA-256 (VALIDATION.MANAGE).
 *  - The full export (kernel 1335; DI-08): started as a background job (RECORD.EXPORT), each past export with its SHA-256.
 *  - The periodic evaluation pack (kernel 1336; DI-11, DI-44): generated for an ended period through the reporting path
 *    (VALIDATION.MANAGE and RECORD.EXPORT) and signed off by QA (EVALUATION_PACK_APPROVE).
 *  - The records register (kernel 0400 to 0440; DI-01, DI-47, DI-50): record types defined (RECORD.TYPE_DEFINE) and
 *    approved (RECORDS_ACT), a record's retention with its legal holds placed and released (RECORD.LEGAL_HOLD) and its
 *    disposal approved (RECORDS_ACT), data-integrity investigations opened, linked and refreshed (VALIDATION.MANAGE)
 *    and closed (RECORDS_ACT).
 * Every right is checked by the database function the route calls.
 */
import { z } from 'zod';
import { Instant, Uuid } from '../common.ts';
import { defineRoute } from '../route.ts';

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'a SHA-256 in lowercase hex');
const ReasonText = z.string().trim().min(1).max(1000);
const ChangeRecordNumber = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/, 'a change-record number (letters, digits, . _ / -)');
const AdapterCode = z.string().regex(/^[A-Z][A-Z0-9_-]{1,63}$/);
const RecordTypeCode = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/);
const AggregateType = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/);
const AggregateId = z.string().min(1).max(200);

// ------------------------------------------------------------------------------------------- system description

export const SystemInterfaceView = z.strictObject({
  adapterCode: AdapterCode,
  sourceSystem: z.enum(['ERP_WMS', 'QMS', 'LIMS', 'LMS', 'CMMS', 'EMS', 'OPCUA', 'L3']),
  endpointHost: z.string(),
  transport: z.enum(['LOOPBACK', 'MTLS']),
  signedFeed: z.boolean(),
  status: z.enum(['DESCRIBED', 'WITHDRAWN']),
  validFrom: Instant,
});
export type SystemInterfaceView = z.infer<typeof SystemInterfaceView>;

export const SystemDescriptionView = z.strictObject({
  interfaces: z.array(SystemInterfaceView),
  /** Active integration adapters the description does not describe (the IQ fails on each, IQ-10). */
  undescribed: z.array(z.string()),
});
export type SystemDescriptionView = z.infer<typeof SystemDescriptionView>;

// ------------------------------------------------------------------------------------- validation summary, evidence

export const PackDocumentView = z.strictObject({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  files: z.array(z.strictObject({ path: z.string(), sha256: Sha256, bytes: z.string() })),
});
export type PackDocumentView = z.infer<typeof PackDocumentView>;

export const EvidenceView = z.strictObject({
  /** The server holds the release's evidence bundle (EBMR_VALIDATION_BUNDLE) and it reads as a bundle. */
  configured: z.boolean(),
  problem: z.string().nullable(),
  fileName: z.string().nullable(),
  bundleSha256: Sha256.nullable(),
  release: z.strictObject({ product: z.string(), version: z.string(), commit: z.string(), schemaRelease: Sha256, edition: z.string() }).nullable(),
  /** The schema release this database runs (platform.schema_release()). */
  runningRelease: Sha256,
  /** The documents of the validation pack generated from the bundle (Markdown and HTML each). */
  documents: z.array(PackDocumentView),
});
export type EvidenceView = z.infer<typeof EvidenceView>;

export const EvidenceFileView = z.strictObject({
  path: z.string(),
  mediaType: z.enum(['application/json', 'text/markdown', 'text/html']),
  sha256: Sha256,
  content: z.string(),
});
export type EvidenceFileView = z.infer<typeof EvidenceFileView>;

export const ValidationSummaryView = z.strictObject({
  runningRelease: Sha256,
  /** platform.validation_summary_problem(): why GMP batches are not issued on this release, or null. */
  problem: z.string().nullable(),
  /** The validation summary document of the shipped bundle's pack, when the bundle is this release's. */
  document: z
    .strictObject({ title: z.string(), path: z.string(), sha256: Sha256, schemaRelease: Sha256, markdown: z.string(), forRunningRelease: z.boolean() })
    .nullable(),
  documentProblem: z.string().nullable(),
  approvals: z.array(
    z.strictObject({ schemaRelease: Sha256, summarySha256: Sha256, title: z.string(), approvedBy: z.string(), approvedAt: Instant, signatureId: Uuid }),
  ),
});
export type ValidationSummaryView = z.infer<typeof ValidationSummaryView>;

// ------------------------------------------------------------------------------------------------------------- IQ

export const IqCheckView = z.strictObject({ id: z.string(), name: z.string(), expected: z.string(), actual: z.string(), passed: z.boolean(), problems: z.array(z.string()) });
export type IqCheckView = z.infer<typeof IqCheckView>;

export const IqRecordView = z.strictObject({
  iqId: Uuid,
  passed: z.boolean(),
  summary: z.string(),
  schemaRelease: Sha256,
  bundleSha256: Sha256,
  recordSha256: Sha256,
  checks: z.array(IqCheckView),
  by: z.string(),
  at: Instant,
});
export type IqRecordView = z.infer<typeof IqRecordView>;

// ---------------------------------------------------------------------------------------------- full export, packs

export const ExportJobView = z.strictObject({
  state: z.enum(['IDLE', 'RUNNING', 'DONE', 'FAILED']),
  step: z.string().nullable(),
  error: z.string().nullable(),
  elapsedSeconds: z.string().nullable(),
});
export type ExportJobView = z.infer<typeof ExportJobView>;

export const FullExportView = z.strictObject({
  exportId: Uuid,
  manifestSha256: Sha256,
  recordCount: z.string(),
  fileCount: z.string(),
  by: z.string(),
  at: Instant,
});
export type FullExportView = z.infer<typeof FullExportView>;

export const FullExportsView = z.strictObject({
  exports: z.array(FullExportView),
  job: ExportJobView,
  /** Where the server writes each export (a folder per export, named by its time). */
  folder: z.string(),
});
export type FullExportsView = z.infer<typeof FullExportsView>;

export const EvaluationPackView = z.strictObject({
  packId: Uuid,
  packSha256: Sha256,
  periodFrom: Instant,
  periodTo: Instant,
  entryCount: z.string(),
  sampleCount: z.string(),
  unreadableCount: z.string(),
  readabilitySeed: z.string(),
  sampleSize: z.string(),
  generatedBy: z.string(),
  at: Instant,
  approval: z.strictObject({ approvedBy: z.string(), at: Instant, signatureId: Uuid }).nullable(),
});
export type EvaluationPackView = z.infer<typeof EvaluationPackView>;

// ---------------------------------------------------------------------------------------------- records register

export const RecordTypeDefinition = z.strictObject({
  code: RecordTypeCode,
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(2000),
  officialRecord: z.boolean(),
  dataClass: z.enum(['RAW', 'DERIVED', 'INFORMATIONAL']),
  gmpCriticality: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  officialMedium: z.enum(['ELECTRONIC', 'PAPER', 'HYBRID']),
  originalAndCopies: z.string().trim().min(1).max(1000),
  hybridLinkage: z.string().trim().min(1).max(1000).optional(),
  storageLocation: z.string().trim().min(1).max(500),
  owningModule: z.string().trim().min(1).max(100),
  ownerRole: z.string().trim().min(1).max(100),
  retentionKey: z.enum(['BATCH_RECORD', 'SUPPORTING_RECORD', 'DSCSA_RECORD', 'VALIDATION_RAW_DATA', 'PERMANENT']),
  reviewRule: z.string().trim().min(1).max(1000),
  retainedMetadata: z.array(z.string().min(1).max(100)).max(50).optional(),
  feedsAcceptanceLimit: z.boolean(),
});
export type RecordTypeDefinition = z.infer<typeof RecordTypeDefinition>;

export const RecordTypeView = z.strictObject({
  code: z.string(),
  version: z.string(),
  title: z.string(),
  description: z.string(),
  dataClass: z.string(),
  gmpCriticality: z.string(),
  officialMedium: z.string(),
  retentionKey: z.string(),
  feedsAcceptanceLimit: z.boolean(),
  state: z.enum(['DEFINED', 'APPROVED']),
  definedBy: z.string(),
  definedAt: Instant,
  approvedBy: z.string().nullable(),
});
export type RecordTypeView = z.infer<typeof RecordTypeView>;

export const LegalHoldView = z.strictObject({
  holdId: Uuid,
  recordKey: z.string(),
  kind: z.string(),
  reason: z.string(),
  reference: z.string().nullable(),
  placedBy: z.string(),
  at: Instant,
});
export type LegalHoldView = z.infer<typeof LegalHoldView>;

export const RetentionLookupView = z.strictObject({
  recordKey: z.string(),
  aggregateType: z.string(),
  aggregateId: z.string(),
  /** Whether the database holds a retention schedule for the record. */
  scheduled: z.boolean(),
  retainUntil: z.string().nullable(),
  status: z.string().nullable(),
  onHold: z.boolean(),
  purged: z.boolean(),
  /** Why the record may not be disposed of now ([] when it may). */
  refusals: z.array(z.strictObject({ code: z.string(), detail: z.string() })),
  blockers: z.array(z.strictObject({ kind: z.string(), id: z.string(), reference: z.string(), status: z.string(), detail: z.string(), blocksDisposal: z.boolean() })),
});
export type RetentionLookupView = z.infer<typeof RetentionLookupView>;

export const DiInvestigationView = z.strictObject({
  investigationId: Uuid,
  reference: z.string(),
  status: z.enum(['OPEN', 'CLOSED']),
  subject: z.string(),
  investigator: z.string(),
  openedBy: z.string(),
  windowFrom: Instant,
  windowTo: Instant,
  concern: z.string(),
  qmsReference: z.string().nullable(),
  conclusion: z.string().nullable(),
  remediation: z.string().nullable(),
  approvedBy: z.string().nullable(),
  links: z.array(z.strictObject({ recordKey: z.string(), source: z.enum(['SCOPE', 'MANUAL']), note: z.string().nullable() })),
});
export type DiInvestigationView = z.infer<typeof DiInvestigationView>;

const IsoInstant = z.iso.datetime({ offset: true });

export const validation = {
  systemDescription: defineRoute({
    id: 'validation.systemDescription',
    method: 'GET',
    path: '/api/validation/system-description',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The approved system description: every interface in force, and the active adapters it does not describe (DI-06)',
    response: SystemDescriptionView,
  }),
  describeInterface: defineRoute({
    id: 'validation.describeInterface',
    method: 'POST',
    path: '/api/validation/system-description',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'A new version of an interface of the system description, under an approved change record covering SYSTEM_DESCRIPTION (CONFIG.SYSTEM_DESCRIPTION)',
    body: z.strictObject({
      adapterCode: AdapterCode,
      sourceSystem: SystemInterfaceView.shape.sourceSystem,
      endpointHost: z.string().regex(/^[A-Za-z0-9.:[\]-]{1,253}$/),
      transport: SystemInterfaceView.shape.transport,
      signedFeed: z.boolean(),
      status: SystemInterfaceView.shape.status,
      changeRecord: ChangeRecordNumber,
      reason: ReasonText,
    }),
    response: SystemDescriptionView,
  }),
  summary: defineRoute({
    id: 'validation.summary',
    method: 'GET',
    path: '/api/validation/summary',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The running release, whether it has an approved validation summary, the summary document of the shipped bundle and the approvals (DI-03)',
    response: ValidationSummaryView,
  }),
  evidence: defineRoute({
    id: 'validation.evidence',
    method: 'GET',
    path: '/api/validation/evidence',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The release\'s evidence bundle as shipped and the documents of the validation pack generated from it',
    response: EvidenceView,
  }),
  evidenceFile: defineRoute({
    id: 'validation.evidenceFile',
    method: 'GET',
    path: '/api/validation/evidence/file',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'One file to download: the evidence bundle (bundle.json) or a document of the validation pack, with its SHA-256',
    query: z.strictObject({ path: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,80}$/) }),
    response: EvidenceFileView,
  }),
  iqRecords: defineRoute({
    id: 'validation.iqRecords',
    method: 'GET',
    path: '/api/validation/iq',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The IQ records of this installation, newest first, each with its checks and SHA-256',
    response: z.strictObject({ records: z.array(IqRecordView), configured: z.boolean(), problem: z.string().nullable() }),
  }),
  runIq: defineRoute({
    id: 'validation.runIq',
    method: 'POST',
    path: '/api/validation/iq',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'Run the IQ checks of this installation against the shipped evidence bundle and store the record (VALIDATION.MANAGE)',
    body: z.strictObject({ reason: ReasonText }),
    response: IqRecordView,
  }),
  iqRecordFile: defineRoute({
    id: 'validation.iqRecordFile',
    method: 'GET',
    path: '/api/validation/iq/:iqId/file',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'One IQ record as stored (the JSON the checks wrote), to download',
    params: z.strictObject({ iqId: Uuid }),
    response: z.strictObject({ iqId: Uuid, recordSha256: Sha256, content: z.string() }),
  }),
  fullExports: defineRoute({
    id: 'validation.fullExports',
    method: 'GET',
    path: '/api/validation/full-exports',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The full exports of the installation with their SHA-256, and the export job (DI-08)',
    response: FullExportsView,
  }),
  startFullExport: defineRoute({
    id: 'validation.startFullExport',
    method: 'POST',
    path: '/api/validation/full-exports',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'Start the full export of every closed record with its audit trail and signatures, as a background job (RECORD.EXPORT)',
    body: z.strictObject({ reason: ReasonText }),
    response: z.strictObject({ job: ExportJobView }),
  }),
  fullExportManifest: defineRoute({
    id: 'validation.fullExportManifest',
    method: 'GET',
    path: '/api/validation/full-exports/:exportId/manifest',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The manifest of one full export (the file the viewer checks the export against), to download',
    params: z.strictObject({ exportId: Uuid }),
    response: z.strictObject({ exportId: Uuid, manifestSha256: Sha256, manifest: z.string() }),
  }),
  evaluationPacks: defineRoute({
    id: 'validation.evaluationPacks',
    method: 'GET',
    path: '/api/validation/evaluation-packs',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The periodic evaluation packs, newest first, with their SHA-256 and QA\'s sign-off (DI-11)',
    response: z.strictObject({ packs: z.array(EvaluationPackView) }),
  }),
  runEvaluationPack: defineRoute({
    id: 'validation.runEvaluationPack',
    method: 'POST',
    path: '/api/validation/evaluation-packs',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'Generate and store the periodic evaluation pack of an ended period with its readability report (VALIDATION.MANAGE and RECORD.EXPORT)',
    body: z.strictObject({
      from: IsoInstant,
      to: IsoInstant,
      seed: z.string().trim().min(1).max(100),
      sampleSize: z.string().regex(/^[1-9][0-9]{0,3}$/).optional(),
    }),
    response: EvaluationPackView,
  }),
  evaluationPackFile: defineRoute({
    id: 'validation.evaluationPackFile',
    method: 'GET',
    path: '/api/validation/evaluation-packs/:packId/file',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'One evaluation pack as stored (its JSON text), to download',
    params: z.strictObject({ packId: Uuid }),
    response: z.strictObject({ packId: Uuid, packSha256: Sha256, content: z.string() }),
  }),
  recordTypes: defineRoute({
    id: 'validation.recordTypes',
    method: 'GET',
    path: '/api/validation/record-types',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The record-type register: every version of every record type, with its approval (DI-01)',
    response: z.strictObject({ recordTypes: z.array(RecordTypeView) }),
  }),
  defineRecordType: defineRoute({
    id: 'validation.defineRecordType',
    method: 'POST',
    path: '/api/validation/record-types',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'Define a new version of a record type (RECORD.TYPE_DEFINE); another person approves it (RECORDS_ACT)',
    body: z.strictObject({ definition: RecordTypeDefinition, reason: ReasonText }),
    response: RecordTypeView,
  }),
  retention: defineRoute({
    id: 'validation.retention',
    method: 'GET',
    path: '/api/validation/retention',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'One record\'s retention as the database computes it, why it may not be disposed of, and its open blockers',
    query: z.strictObject({ aggregateType: AggregateType, aggregateId: AggregateId }),
    response: RetentionLookupView,
  }),
  legalHolds: defineRoute({
    id: 'validation.legalHolds',
    method: 'GET',
    path: '/api/validation/legal-holds',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The legal holds in force on records',
    response: z.strictObject({ holds: z.array(LegalHoldView) }),
  }),
  placeLegalHold: defineRoute({
    id: 'validation.placeLegalHold',
    method: 'POST',
    path: '/api/validation/legal-holds',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'Place a legal hold on a record, with the reason (RECORD.LEGAL_HOLD); the record cannot be disposed of while it holds',
    body: z.strictObject({ aggregateType: AggregateType, aggregateId: AggregateId, reason: ReasonText, reference: z.string().trim().min(1).max(200).optional() }),
    response: LegalHoldView,
  }),
  releaseLegalHold: defineRoute({
    id: 'validation.releaseLegalHold',
    method: 'POST',
    path: '/api/validation/legal-holds/:holdId/release',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'Release a legal hold, with the reason (RECORD.LEGAL_HOLD)',
    params: z.strictObject({ holdId: Uuid }),
    body: z.strictObject({ reason: ReasonText }),
    response: z.strictObject({ holds: z.array(LegalHoldView) }),
  }),
  diInvestigations: defineRoute({
    id: 'validation.diInvestigations',
    method: 'GET',
    path: '/api/validation/di-investigations',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The data-integrity investigations, newest first, with the records linked to each (DI-50)',
    response: z.strictObject({ investigations: z.array(DiInvestigationView) }),
  }),
  openDiInvestigation: defineRoute({
    id: 'validation.openDiInvestigation',
    method: 'POST',
    path: '/api/validation/di-investigations',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'Open a data-integrity investigation of a person\'s records in a time window (VALIDATION.MANAGE); the records in scope are linked and held',
    body: z.strictObject({
      subjectPersonId: Uuid,
      windowFrom: IsoInstant,
      windowTo: IsoInstant,
      concern: z.string().trim().min(10).max(4000),
      investigatorPersonId: Uuid.optional(),
      qmsReference: z.string().trim().min(1).max(200).optional(),
    }),
    response: DiInvestigationView,
  }),
  linkDiInvestigation: defineRoute({
    id: 'validation.linkDiInvestigation',
    method: 'POST',
    path: '/api/validation/di-investigations/:investigationId/links',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'Link a record to an open data-integrity investigation, with a note saying why (VALIDATION.MANAGE)',
    params: z.strictObject({ investigationId: Uuid }),
    body: z.strictObject({ aggregateType: AggregateType, aggregateId: AggregateId, note: z.string().trim().min(1).max(2000) }),
    response: DiInvestigationView,
  }),
  refreshDiInvestigationScope: defineRoute({
    id: 'validation.refreshDiInvestigationScope',
    method: 'POST',
    path: '/api/validation/di-investigations/:investigationId/refresh',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    summary: 'Read an open investigation\'s scope again and link the records that entered it (VALIDATION.MANAGE)',
    params: z.strictObject({ investigationId: Uuid }),
    response: z.strictObject({ linked: z.string(), investigation: DiInvestigationView }),
  }),
} as const;
