/**
 * DI-01 record-type register: definitions, approval and the raw-data floor check.
 *
 * The database is the enforcement point (records.define_record_type, records.approve_record_type,
 * records.assert_classification_valid and a table constraint); these wrappers only call it inside a
 * command (withCommand) so the actor is known.
 */
import type pg from 'pg';
import type { RetentionKey } from './retention-rules.ts';

type Db = pg.Pool | pg.PoolClient;

export type DataClass = 'RAW' | 'DERIVED' | 'INFORMATIONAL';
export type OfficialMedium = 'ELECTRONIC' | 'PAPER' | 'HYBRID';
export type GmpCriticality = 'HIGH' | 'MEDIUM' | 'LOW';

export interface RecordTypeDefinition {
  code: string;
  title: string;
  description: string;
  officialRecord: boolean;
  dataClass: DataClass;
  gmpCriticality: GmpCriticality;
  officialMedium: OfficialMedium;
  /** Which item is the original and which are copies (e.g. "the database record; PDFs are copies"). */
  originalAndCopies: string;
  /** Required for HYBRID: how paper and electronic parts are linked (DI-41, DI-43). */
  hybridLinkage?: string;
  storageLocation: string;
  owningModule: string;
  ownerRole: string;
  retentionKey: RetentionKey;
  reviewRule: string;
  retainedMetadata?: string[];
  /** Feeds an acceptance limit or another quality decision (release, IPC, yield, deviations). */
  feedsAcceptanceLimit: boolean;
}

export interface ClassificationItem {
  itemRef: string;
  dataClass: DataClass;
  feedsAcceptanceLimit: boolean;
  recordTypeCode?: string;
}

/** Creates the next version of a record type (DRAFT until approved). Returns the version number. */
export async function defineRecordType(db: Db, def: RecordTypeDefinition): Promise<number> {
  const { rows } = await db.query<{ v: number }>('select records.define_record_type($1::jsonb) as v', [JSON.stringify(def)]);
  return rows[0]?.v ?? 0;
}

/** Approves a version; the approver must be a person other than its author. */
export async function approveRecordType(db: Db, code: string, version: number, approvalSignatureId: string): Promise<void> {
  await db.query('select records.approve_record_type($1, $2, $3)', [code, version, approvalSignatureId]);
}

/** Raises EBMR-REC-010/011/013/014 when the classification breaks the raw-data floor or the register. */
export async function assertClassificationValid(db: Db, item: ClassificationItem): Promise<void> {
  await db.query('select records.assert_classification_valid($1, $2, $3, $4)', [
    item.itemRef,
    item.dataClass,
    item.feedsAcceptanceLimit,
    item.recordTypeCode ?? null,
  ]);
}

/** Every classification problem in a list of items (empty when all are valid). */
export async function classificationProblems(db: Db, items: ClassificationItem[]): Promise<{ itemRef: string; problem: string }[]> {
  const { rows } = await db.query<{ item_ref: string; problem: string }>('select item_ref, problem from records.classification_problems($1::jsonb)', [
    JSON.stringify(items),
  ]);
  return rows.map((r) => ({ itemRef: r.item_ref, problem: r.problem }));
}

const EBMR_DB = 'eBMR edition database, site data centre; after closure also the write-once archive (true-copy bundle)';

/**
 * Baseline register proposed for a new tenant. Customer QA reviews, adapts and approves it through
 * defineRecordType/approveRecordType; nothing here is in force until approved.
 */
export const BASELINE_RECORD_TYPES: readonly RecordTypeDefinition[] = [
  {
    code: 'BATCH_PROCESSING_RECORD',
    title: 'Batch processing record',
    description: 'Executed manufacturing steps, entries, calculations, exceptions and signatures of one batch.',
    officialRecord: true,
    dataClass: 'RAW',
    gmpCriticality: 'HIGH',
    officialMedium: 'ELECTRONIC',
    originalAndCopies: 'The electronic record in the eBMR is the original; PDFs and printouts are marked copies (DI-40).',
    storageLocation: EBMR_DB,
    owningModule: 'recipe-core execution',
    ownerRole: 'QA',
    retentionKey: 'BATCH_RECORD',
    reviewRule: 'Production review then QA review with audit-trail review before disposition (DI-25).',
    retainedMetadata: ['audit trail', 'signatures', 'MBR version', 'rule-table version', 'device and authentication references'],
    feedsAcceptanceLimit: true,
  },
  {
    code: 'BATCH_PACKAGING_RECORD',
    title: 'Batch packaging record',
    description: 'Executed packaging order of a lot: line clearance, printed materials, reconciliation, signatures.',
    officialRecord: true,
    dataClass: 'RAW',
    gmpCriticality: 'HIGH',
    officialMedium: 'ELECTRONIC',
    originalAndCopies: 'The electronic record in the eBMR is the original; PDFs and printouts are marked copies (DI-40).',
    storageLocation: EBMR_DB,
    owningModule: 'recipe-core execution',
    ownerRole: 'QA',
    retentionKey: 'BATCH_RECORD',
    reviewRule: 'Production review then QA review with audit-trail review before disposition (DI-25).',
    retainedMetadata: ['audit trail', 'signatures', 'artwork versions'],
    feedsAcceptanceLimit: true,
  },
  {
    code: 'IPC_RESULT',
    title: 'In-process control result',
    description: 'A measured in-process value evaluated against an MBR acceptance limit.',
    officialRecord: true,
    dataClass: 'RAW',
    gmpCriticality: 'HIGH',
    officialMedium: 'ELECTRONIC',
    originalAndCopies: 'The captured value (device or entry) in the eBMR is the original.',
    storageLocation: EBMR_DB,
    owningModule: 'recipe-core execution',
    ownerRole: 'QA',
    retentionKey: 'BATCH_RECORD',
    reviewRule: 'Checked at the step; every post-entry change is shown in the step view and the batch review (DI-25).',
    retainedMetadata: ['limit version', 'instrument', 'occurred_at and trust level', 'authentication event'],
    feedsAcceptanceLimit: true,
  },
  {
    code: 'DEVICE_PRINTOUT',
    title: 'Instrument printout',
    description: 'Balance, pH or checkweigher slip, or chart output that records a value used in the batch.',
    officialRecord: true,
    dataClass: 'RAW',
    gmpCriticality: 'HIGH',
    officialMedium: 'HYBRID',
    originalAndCopies: 'The paper slip is the original until a verified true copy replaces it under an approved SOP (DI-41).',
    hybridLinkage: 'Scanned promptly; the true copy carries a checksum, the verifier signature and a link to its step.',
    storageLocation: 'Paper in the batch dossier until destruction is approved; scan in the eBMR edition database',
    owningModule: 'recipe-core execution',
    ownerRole: 'QA',
    retentionKey: 'BATCH_RECORD',
    reviewRule: 'Verified against the captured value at the step.',
    retainedMetadata: ['checksum', 'capture time', 'verifier'],
    feedsAcceptanceLimit: true,
  },
  {
    code: 'CONTINGENCY_FORM',
    title: 'Paper contingency form',
    description: 'Pre-generated numbered paper form used while the system is unavailable, then back-entered.',
    officialRecord: true,
    dataClass: 'RAW',
    gmpCriticality: 'HIGH',
    officialMedium: 'HYBRID',
    originalAndCopies: 'The signed paper form is the original for the steps it covers (DI-43).',
    hybridLinkage: 'Form number reconciled in the register; back-entry records performer, transcriber and verifier (DI-30).',
    storageLocation: 'Paper in the batch dossier; back-entered data in the eBMR edition database',
    owningModule: 'continuity',
    ownerRole: 'QA',
    retentionKey: 'BATCH_RECORD',
    reviewRule: 'Back-entry verified by a second person; all forms reconciled before batch closure.',
    retainedMetadata: ['form number', 'pack hash', 'transcriber', 'verifier'],
    feedsAcceptanceLimit: true,
  },
  {
    code: 'OPERATOR_NOTE',
    title: 'Operator note',
    description: 'Free-text remark that no limit, gate or review rule evaluates.',
    officialRecord: true,
    dataClass: 'INFORMATIONAL',
    gmpCriticality: 'LOW',
    officialMedium: 'ELECTRONIC',
    originalAndCopies: 'The electronic entry is the original.',
    storageLocation: EBMR_DB,
    owningModule: 'recipe-core execution',
    ownerRole: 'PRODUCTION',
    retentionKey: 'BATCH_RECORD',
    reviewRule: 'Shown in production and QA review.',
    feedsAcceptanceLimit: false,
  },
  {
    code: 'COMPONENT_LOT_RECORD',
    title: 'Component, container, closure or label lot record',
    description: 'Receipt, testing, release and use of a material lot; supports every batch that used it.',
    officialRecord: true,
    dataClass: 'RAW',
    gmpCriticality: 'HIGH',
    officialMedium: 'ELECTRONIC',
    originalAndCopies: 'The site-services lot record is the original.',
    storageLocation: 'Site-services database',
    owningModule: 'site-services',
    ownerRole: 'QA',
    retentionKey: 'SUPPORTING_RECORD',
    reviewRule: 'Usability evaluated at every consumption; changes after use appear in the batch audit-trail review.',
    retainedMetadata: ['release route', 'retest date', 'genealogy links'],
    feedsAcceptanceLimit: true,
  },
  {
    code: 'EQUIPMENT_LOGBOOK',
    title: 'Equipment logbook',
    description: 'Chronological use, cleaning, maintenance and calibration entries of one piece of equipment.',
    officialRecord: true,
    dataClass: 'RAW',
    gmpCriticality: 'HIGH',
    officialMedium: 'ELECTRONIC',
    originalAndCopies: 'The electronic logbook is the original.',
    storageLocation: EBMR_DB,
    owningModule: 'equipment',
    ownerRole: 'PRODUCTION',
    retentionKey: 'SUPPORTING_RECORD',
    reviewRule: 'Status evaluated before use; entries double-checked where the MBR requires.',
    feedsAcceptanceLimit: true,
  },
  {
    code: 'AREA_LOGBOOK',
    title: 'Area logbook',
    description: 'Chronological record of the areas where product was processed (always on, room-scoped).',
    officialRecord: true,
    dataClass: 'RAW',
    gmpCriticality: 'HIGH',
    officialMedium: 'ELECTRONIC',
    originalAndCopies: 'The electronic logbook is the original.',
    storageLocation: EBMR_DB,
    owningModule: 'equipment',
    ownerRole: 'PRODUCTION',
    retentionKey: 'SUPPORTING_RECORD',
    reviewRule: 'Clearance and cleaning status evaluated before each occupancy.',
    feedsAcceptanceLimit: true,
  },
  {
    code: 'AUDIT_TRAIL',
    title: 'Audit trail',
    description: 'Hash-chained audit events of every GMP record; kept as long as the record it belongs to.',
    officialRecord: true,
    dataClass: 'RAW',
    gmpCriticality: 'HIGH',
    officialMedium: 'ELECTRONIC',
    originalAndCopies: 'The audit events in the database are the original; true-copy bundles carry verified copies.',
    storageLocation: EBMR_DB,
    owningModule: 'kernel audit',
    ownerRole: 'QA',
    retentionKey: 'BATCH_RECORD',
    reviewRule: 'Batch audit-trail review before disposition; nightly chain verification.',
    feedsAcceptanceLimit: true,
  },
  {
    code: 'INCIDENT',
    title: 'Incident',
    description: 'System or user incident linked to affected records (DI-12); blocks disposition until assessed.',
    officialRecord: true,
    dataClass: 'RAW',
    gmpCriticality: 'HIGH',
    officialMedium: 'ELECTRONIC',
    originalAndCopies: 'The electronic incident record is the original.',
    storageLocation: EBMR_DB,
    owningModule: 'kernel records',
    ownerRole: 'QA',
    retentionKey: 'SUPPORTING_RECORD',
    reviewRule: 'Assessed per linked record; MAJOR and CRITICAL closed with root cause and CAPA.',
    feedsAcceptanceLimit: true,
  },
  {
    code: 'DI_INVESTIGATION',
    title: 'Data-integrity investigation',
    description: 'Investigation of a person over a time window with its scope, holds and closure (DI-50).',
    officialRecord: true,
    dataClass: 'RAW',
    gmpCriticality: 'HIGH',
    officialMedium: 'ELECTRONIC',
    originalAndCopies: 'The electronic investigation record is the original; the QMS holds the investigation report.',
    storageLocation: EBMR_DB,
    owningModule: 'kernel records',
    ownerRole: 'QA',
    retentionKey: 'SUPPORTING_RECORD',
    reviewRule: 'Closure approved by a person other than the investigator.',
    feedsAcceptanceLimit: true,
  },
  {
    code: 'RETENTION_TOMBSTONE',
    title: 'Purge tombstone',
    description: 'What was purged after retention, with hashes, checkpoint and approvals (INV-22).',
    officialRecord: true,
    dataClass: 'RAW',
    gmpCriticality: 'MEDIUM',
    officialMedium: 'ELECTRONIC',
    originalAndCopies: 'The tombstone row is the original.',
    storageLocation: EBMR_DB,
    owningModule: 'kernel records',
    ownerRole: 'QA',
    retentionKey: 'PERMANENT',
    reviewRule: 'Checked by the INV-22 invariant query.',
    feedsAcceptanceLimit: false,
  },
];
