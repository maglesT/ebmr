/**
 * Types of the MBR life cycle (outline 5.2.1; ADR 0014). Instants are ISO-8601 UTC strings with
 * microseconds as the database renders them (recipe.utc_text), so they compare correctly as text;
 * GMP quantities stay decimal strings; version numbers and counts are integers.
 */
import type { Edition, RecordKind } from '../flow/model.ts';

export type { MbrVersionEvent, MbrVersionState } from './machine.ts';

/** Two-letter market code: IN (always), US, EU, ... */
export type MarketCode = string;

export interface BatchSize {
  id: string;
  quantity: { value: string; unit: string };
}

/** product x strength x batch-size set x dosage form x edition (x record kind). */
export interface FamilyDefinition {
  code: string;
  title: string;
  edition: Edition;
  recordKind: RecordKind;
  product: { code: string; name: string; strength: string; dosageForm: string };
  batchSizes: BatchSize[];
  /** A packaging family's pack type (D-P4-13; recipe-core 0760): with the product and the pack size its identity. */
  packType?: string;
}

export interface VersionRef {
  versionId: string;
  versionNumber: number;
  contentHash: string;
  state: string;
  /** Optimistic-lock version of the state row: pass it as expectedVersion to the next transition. */
  stateVersion: number;
}

export interface DraftAttributes {
  changeRecordId?: string | null;
  /** ISO-8601 instant from which the version may be used (PR-02). */
  effectiveFrom?: string | null;
  /** YYYY-MM-DD periodic-review due date (PR-05). */
  reviewDue?: string | null;
}

export interface ChangeRecordDefinition {
  number: string;
  title: string;
  changeClass: 'MINOR' | 'MAJOR' | 'CRITICAL';
  /** The change owner's own classification; the database also computes the process impact (PR-06). */
  processImpacting: boolean;
  qmsReference?: string;
  validationRef?: string;
  validationDescription?: string;
}

export interface RiskAssessmentDefinition {
  code: string;
  version: string;
  title: string;
  riskClass: string;
  rationaleRef: string;
}

export type EvidenceKind = 'VALIDATOR' | 'VERIFICATION' | 'TEST_VECTORS' | 'SANDBOX_RUN';

export interface EvidenceResult {
  evidenceId: string;
  kind: EvidenceKind;
  mode: 'FULL' | 'DELTA' | null;
  result: 'PASS' | 'FAIL';
  contentHash: string;
  reportHash: string;
  problems: string[];
}

export interface EvidenceStatus {
  versionId: string;
  contentHash: string;
  complete: boolean;
  missing: string[];
  delta: boolean;
  items: Partial<Record<EvidenceKind, { id: string; result: 'PASS' | 'FAIL'; mode: 'FULL' | 'DELTA' | null; problems: string[] }>>;
}

export interface ScopeCell {
  site: string;
  line: string;
  batch_size: string;
}

export interface MarketAuthorisationDefinition {
  versionId: string;
  market: MarketCode;
  kind: 'CURRENT' | 'BRIDGING';
  cells: ScopeCell[];
  effectiveFrom?: string;
  /** BRIDGING only: end of the time-limited validity. */
  effectiveTo?: string;
  /** BRIDGING only: the approved successor that superseded this version. */
  successorVersionId?: string;
  /** The market's approvals or notifications (registration, variation, supplement), or why none is needed. */
  regulatoryBasis: string;
}

export interface ActivationResult {
  authorisationId: string;
  versionId: string;
  market: MarketCode;
  kind: 'CURRENT' | 'BRIDGING';
  effectiveFrom: string;
  cells: { cell_id: string; site: string; line: string; batch_size: string; superseded_cell_id: string | null }[];
}

export interface IssueScope {
  site: string;
  line: string;
  batch_size: string;
}

export interface SelectionBasis {
  market: MarketCode;
  validity: 'CURRENT' | 'BRIDGING';
  cell_id: string;
  authorisation_id: string;
}

export type SelectionResult =
  | {
      ok: true;
      rule: 'CURRENT_FOR_EVERY_MARKET' | 'CURRENT_OR_BRIDGING';
      family: string;
      markets: MarketCode[];
      scope: IssueScope;
      at: string;
      version_id: string;
      version_number: number;
      content_hash: string;
      basis: SelectionBasis[];
    }
  | {
      ok: false;
      family?: string;
      markets: MarketCode[];
      scope: IssueScope;
      at: string;
      explanation: string;
      markets_detail?: { market: MarketCode; current: number[]; bridging: number[]; linked: boolean }[];
    };

export interface StubBatchDefinition {
  batchNumber: string;
  familyId: string;
  markets: MarketCode[];
  site: string;
  line: string;
  batchSize: string;
}

export interface IssueResult {
  batchId: string;
  pinId: string;
  versionId: string;
  versionNumber: number;
  contentHash: string;
  rule: string;
  basis: SelectionBasis[];
  controlRecipeId: string;
  snapshotHash: string;
}

export interface ControlRecipeCheck {
  batchId: string;
  ok: boolean;
  storedHash?: string;
  computedHash?: string;
  pinnedContentHash?: string;
  problems: string[];
  /** The same check recomputed in TypeScript over the stored snapshot (canonical JSON, SHA-256). */
  tsComputedHash?: string;
}

export type InFlightDisposition = 'CONTINUE' | 'HOLD_FOR_ASSESSMENT' | 'CANCEL_UNSTARTED';

export type ReviewOutcome = 'NO_CHANGE' | 'REVISION_REQUIRED' | 'RETIREMENT_PROPOSED';

export interface OverdueReview {
  versionId: string;
  familyCode: string;
  versionNumber: number;
  documentId: string;
  reviewDue: string;
  daysOverdue: number;
  lastReviewAt: string | null;
  inUse: boolean;
}

export interface InventoryRow {
  documentId: string;
  familyCode: string;
  title: string;
  edition: string;
  recordKind: string;
  productCode: string;
  productName: string;
  strength: string;
  dosageForm: string;
  versionId: string;
  versionNumber: number;
  state: string;
  contentHash: string;
  contentRevision: number;
  effectiveFrom: string | null;
  reviewDue: string | null;
  lastReviewAt: string | null;
  approvedAt: string | null;
  endedAt: string | null;
  changeRecordNumber: string | null;
  marketAuthorisations: { market: string; status: string; site: string; line: string; batch_size: string; effective_from: string; valid_until: string | null }[];
}

export interface InvariantViolation {
  invariant: string;
  subject: string;
  detail: string;
}
