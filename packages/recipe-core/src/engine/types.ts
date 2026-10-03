/**
 * Execution engine: public types (ADR 0004 decision 5 `step(state, command, clock) -> (state, events)`;
 * outline 5.2.2, 5.2.3, 5.2.4, 5.6, 5.7).
 *
 * The engine is pure: it never reads the system clock, never touches a database and never calls the
 * network. Time arrives as a `Clock` value (the transaction's trusted server time), identity and
 * roles arrive with the command (evaluated by the kernel on fresh data), e-signatures arrive as
 * references the kernel created in the same transaction. The engine answers with the next state and
 * the events that persistence (Phase 3) writes: state changes, exceptions with type and tier, derived
 * values with their evaluation records, and involvement facts for segregation of duties.
 *
 * GMP values are decimal strings (never a JavaScript `number`); instants and durations are bigint
 * microseconds since the epoch, like the kernel's `Instant`. Counts and indices are numbers.
 */
import type { EvaluationRecord } from '@ebmr/expr';
import type { Frame, Marking } from '../flow/tokens.ts';
import type { BreachRequirement, LimitTier } from '../limits/model.ts';

/**
 * The version of the engine's output (ADR 0010): a batch pins it at issue and is run and replayed only by this
 * version (EBMR-EXE-061), because replay compares every stored row's events and state with the engine's. Any change
 * of what `issue`, `step`, `sweep` or `prepareForSignature` answer for the same input needs a new version, recorded
 * with its output fingerprint in test/engine/engine-version.test.ts. Semantic changes:
 *  - 1.2.0: a computed weight keeps the resolution of the weighings it comes from (lead TODO T2 of the Phase 2 exit):
 *    the net of a container is gross minus tare written with the decimals of the finer of the two ("50.000 kg", not
 *    "50 kg"), in the entry, its label and the container register, and a total of nets with the decimals of the finest
 *    net; nothing is rounded. The database checks the net the same way (recipe-core 0321).
 *  - 1.1.0: a time fact (a breach, a warning, a void) and a clock regression noticed inside a person's command or
 *    signing preparation are raised by SYSTEM, not by that person (P35, P28); the check a verifier signs is
 *    exactly the one the step requires (RE_VERIFIED_AFTER_CORRECTION, the MBR's WITNESSED, the block's own check,
 *    else VERIFIED; P37), and a PERFORMED signature carries the block's own perform meaning where it has one;
 *    a reason, justification, description or reference with no visible character (only white space, controls
 *    and invisible format characters such as the zero-width space) is refused (ENG-REASON; P29), exactly as the
 *    database's blank test (kernel.is_blank) refuses it.
 *  - 1.0.0: Phase 2 first release.
 */
export const ENGINE_VERSION = '1.2.0';
export const STATE_SCHEMA = 'ebmr.batch-execution-state';

/** Trusted server time of the command's transaction (kernel clock; `recorded_at`), UTC epoch microseconds. */
export interface Clock {
  readonly nowUs: bigint;
}

export type ActorKind = 'PERSON' | 'SYSTEM';

/** Who issues a command. Segregation rules are evaluated on the person, never the account (outline 5.2, 7.1). */
export interface Actor {
  /** Person id (PERSON) or integration id (SYSTEM: automation, device gateway). */
  readonly id: string;
  readonly kind: ActorKind;
  /** Roles the person holds for this batch now, evaluated by the kernel with the qualifications (INV-26). */
  readonly roles: readonly string[];
}

/** Claimed or source time of an event with its trust level (outline 5.6; kernel time model). */
export type TimeTrust = 'DEVICE_SYNCED' | 'DEVICE_UNSYNCED' | 'USER_CLAIMED' | 'PAPER';
export interface OccurredAt {
  readonly us: bigint;
  readonly trust: TimeTrust;
}

/** An e-signature the kernel (esig) created in the same transaction; the engine checks signer and meaning. */
export interface SignatureRef {
  readonly id: string;
  /** Kernel meaning code (PERFORMED, VERIFIED, WITNESSED, CORRECTED, ...). */
  readonly meaning: string;
  /** Person id of the signer. */
  readonly signer: string;
}

/** A second person's approval given in the same transaction (skip, void, correction, invalidation, abort). */
export interface Approval {
  readonly approver: Actor;
  readonly signature: SignatureRef;
}

// ---------------------------------------------------------------------------------------------
// Values

/** A value as entered or captured. Decimals are decimal-literal strings, never numbers. */
export type DataValue =
  | { readonly kind: 'DECIMAL'; readonly value: string; readonly unit: string }
  | { readonly kind: 'COUNT'; readonly value: string }
  | { readonly kind: 'BOOLEAN'; readonly value: boolean }
  | { readonly kind: 'CATEGORY'; readonly value: string }
  | { readonly kind: 'TEXT'; readonly value: string }
  | { readonly kind: 'INSTANT'; readonly us: bigint }
  /** Readings of one capture (e.g. 20 tablet weights), all in one unit. */
  | { readonly kind: 'SERIES'; readonly values: readonly string[]; readonly unit: string };

/** Where a value came from (outline 5.1 data points: channel, device, entry mode). */
export type DataSource =
  | { readonly mode: 'MANUAL'; readonly evidence?: { readonly kind: 'PHOTO' | 'PRINTOUT'; readonly sha256: string } }
  | { readonly mode: 'DEVICE'; readonly device: string; readonly raw?: string }
  | { readonly mode: 'SCAN'; readonly code: string }
  | { readonly mode: 'AUTOMATION'; readonly system: string; readonly tag?: string }
  | { readonly mode: 'LIMS'; readonly resultRef: string }
  /** Computed by the block from its entries (e.g. net = gross - tare, container totals). */
  | { readonly mode: 'BLOCK'; readonly entries: readonly string[] };

// ---------------------------------------------------------------------------------------------
// Commands

interface CommandBase {
  /** Idempotency key: a command applied once is never applied twice (outline 5.7). */
  readonly commandId: string;
  readonly actor: Actor;
  /** Optimistic locking: refused as stale when the state has moved on. */
  readonly expectedVersion?: number;
}

interface StepTarget {
  /** Phase or hold point id (expanded id for library content, e.g. "c-lod/lod-test"). */
  readonly step: string;
  /** Loop iteration and replicate instance frames of the step instance (empty at the top level). */
  readonly context?: readonly Frame[];
}

export interface StartStepCommand extends CommandBase, StepTarget {
  readonly type: 'START_STEP';
  readonly occurredAt?: OccurredAt;
  /** Block-specific start data (e.g. the QCU authorisation of a G-24 reprocessing step). */
  readonly blockData?: Readonly<Record<string, unknown>>;
}

export interface RecordDataCommand extends CommandBase, StepTarget {
  readonly type: 'RECORD_DATA';
  /** Parameter id the phase records. */
  readonly item: string;
  readonly value: DataValue;
  readonly source: DataSource;
  readonly occurredAt?: OccurredAt;
  /** Mandatory for late entries (outline 5.6). */
  readonly reason?: string;
}

export interface RecordEntryCommand extends CommandBase, StepTarget {
  readonly type: 'RECORD_ENTRY';
  /** Block-specific entry validated by the block version's data schema (e.g. a container weighing). */
  readonly entry: Readonly<Record<string, unknown>> & { readonly kind: string };
  readonly occurredAt?: OccurredAt;
}

export interface SignPerformedCommand extends CommandBase, StepTarget {
  readonly type: 'SIGN_PERFORMED';
  /** Absent only for a SYSTEM actor ending an automated phase in one-verifier mode (S5a). */
  readonly signature?: SignatureRef;
  readonly occurredAt?: OccurredAt;
}

export interface VerifyCommand extends CommandBase, StepTarget {
  readonly type: 'VERIFY';
  readonly signature: SignatureRef;
}

export interface ChooseAlternativeCommand extends CommandBase {
  readonly type: 'CHOOSE_ALTERNATIVE';
  readonly construct: string;
  readonly context?: readonly Frame[];
  readonly branch: string;
  readonly reason: string;
}

export interface ChooseReplicateCountCommand extends CommandBase {
  readonly type: 'CHOOSE_REPLICATE_COUNT';
  readonly construct: string;
  readonly context?: readonly Frame[];
  readonly count: number;
  readonly reason: string;
}

export interface CompleteLoopIterationCommand extends CommandBase {
  readonly type: 'COMPLETE_LOOP_ITERATION';
  readonly construct: string;
  /** Frames of the iteration being completed (its last frame is the loop's). */
  readonly context: readonly Frame[];
}

export interface RequestSkipCommand extends CommandBase, StepTarget {
  readonly type: 'REQUEST_SKIP';
  readonly reason: string;
  readonly approval: Approval;
}

export interface DispositionHoldPointCommand extends CommandBase, StepTarget {
  readonly type: 'DISPOSITION_HOLD_POINT';
  readonly disposition: string;
  readonly signature: SignatureRef;
  readonly comment?: string;
}

export interface SignOffStageCommand extends CommandBase {
  readonly type: 'SIGN_OFF_STAGE';
  readonly stage: string;
  readonly context?: readonly Frame[];
  readonly signature: SignatureRef;
}

export interface RaiseExceptionCommand extends CommandBase {
  readonly type: 'RAISE_EXCEPTION';
  readonly step?: string;
  readonly context?: readonly Frame[];
  readonly description: string;
  /** ALERT (register item) or ACTION (dependent steps stop until a deviation is attached). */
  readonly severity: 'ALERT' | 'ACTION';
}

export interface AttachDeviationCommand extends CommandBase {
  readonly type: 'ATTACH_DEVIATION';
  readonly exception: string;
  /** Deviation or investigation reference in the QMS (built-in stand-in or external). */
  readonly deviationRef: string;
}

export interface DispositionExceptionCommand extends CommandBase {
  readonly type: 'DISPOSITION_EXCEPTION';
  readonly exception: string;
  readonly outcome: 'NO_IMPACT' | 'DEVIATION_RAISED';
  readonly justification: string;
  readonly signature: SignatureRef;
}

export interface HoldBatchCommand extends CommandBase {
  readonly type: 'HOLD_BATCH';
  readonly holdType: 'SUPERVISOR' | 'QA';
  readonly reason: string;
}

export interface ReleaseHoldCommand extends CommandBase {
  readonly type: 'RELEASE_HOLD';
  readonly hold: string;
  readonly reason: string;
}

/** Path (a): entry-error correction of a manually entered value (outline 5.2.3). */
export interface CorrectEntryCommand extends CommandBase {
  readonly type: 'CORRECT_ENTRY';
  readonly point: string;
  readonly value: DataValue;
  readonly reason: string;
  readonly signature: SignatureRef;
  /** Objective evidence of the true value (device raw string, printout, photo): SHA-256 of the attachment. */
  readonly evidence?: { readonly kind: 'DEVICE_RAW' | 'PRINTOUT' | 'PHOTO'; readonly sha256: string };
  /** S25 approval for critical data; QA approval when a failing value would become passing. */
  readonly approval?: Approval;
}

/** Path (b): void of an attempt that has no result yet (outline 5.2.3). */
export interface VoidAttemptCommand extends CommandBase, StepTarget {
  readonly type: 'VOID_ATTEMPT';
  readonly item: string;
  readonly reason: string;
  /** Names an existing data point: refused when it holds a result (use a correction or an invalidation). */
  readonly point?: string;
  /** QA approval when S28 is on (default). */
  readonly approval?: Approval;
}

/** Path (c): invalidation of a result, only with an investigation that concluded an assignable cause. */
export interface InvalidateResultCommand extends CommandBase {
  readonly type: 'INVALIDATE_RESULT';
  readonly point: string;
  readonly investigationRef: string;
  readonly reason: string;
  readonly approval: Approval;
}

export interface AbortBatchCommand extends CommandBase {
  readonly type: 'ABORT_BATCH';
  readonly reason: string;
  /** Head of production and QA: two different persons (outline 5.2.2). */
  readonly approvals: readonly Approval[];
}

export interface CancelBatchCommand extends CommandBase {
  readonly type: 'CANCEL_BATCH';
  readonly reason: string;
  readonly signature: SignatureRef;
}

export type Command =
  | StartStepCommand
  | RecordDataCommand
  | RecordEntryCommand
  | SignPerformedCommand
  | VerifyCommand
  | ChooseAlternativeCommand
  | ChooseReplicateCountCommand
  | CompleteLoopIterationCommand
  | RequestSkipCommand
  | DispositionHoldPointCommand
  | SignOffStageCommand
  | RaiseExceptionCommand
  | AttachDeviationCommand
  | DispositionExceptionCommand
  | HoldBatchCommand
  | ReleaseHoldCommand
  | CorrectEntryCommand
  | VoidAttemptCommand
  | InvalidateResultCommand
  | AbortBatchCommand
  | CancelBatchCommand;

export type CommandType = Command['type'];

/**
 * What a signature is about to be applied to: the command type and the step instance (for SIGN_PERFORMED,
 * whose PERFORMED attempt finalises the step first). Other signed commands only need the sweep. Defined here,
 * not in engine.ts, so signing-content.ts (which engine.ts imports) never imports engine.ts.
 */
export interface SignatureTarget {
  readonly type: CommandType;
  readonly step?: string;
  readonly context?: readonly Frame[];
}

// ---------------------------------------------------------------------------------------------
// State

export type BatchStatus = 'ISSUED' | 'IN_PROGRESS' | 'ON_HOLD' | 'EXECUTION_COMPLETE' | 'ABORTED' | 'CANCELLED';

export type StepStatus = 'PENDING' | 'ENABLED' | 'IN_PROGRESS' | 'AWAITING_VERIFICATION' | 'COMPLETED' | 'NOT_APPLICABLE' | 'SKIPPED';

export const TERMINAL_STEP_STATUSES: readonly StepStatus[] = ['COMPLETED', 'NOT_APPLICABLE', 'SKIPPED'];

export interface SignatureUse {
  id: string;
  meaning: string;
  signer: string;
  at: bigint;
  role: 'PERFORMED' | 'CHECKED' | 'HOLD_POINT' | 'SKIP_APPROVAL';
  valid: boolean;
}

export interface StepInstance {
  key: string;
  /** Phase or hold point id. */
  step: string;
  kind: 'PHASE' | 'HOLD';
  frames: Frame[];
  status: StepStatus;
  enabledAt?: bigint;
  startedAt?: bigint;
  /** End of the operation (PERFORMED transition, hold point disposition). */
  endedAt?: bigint;
  completedAt?: bigint;
  enabledSeq?: number;
  startedSeq?: number;
  /** First time the step reached a terminal state (never reset by re-verification). */
  firstCompletedSeq?: number;
  /** Persons who started or signed PERFORMED. */
  performers: string[];
  /** Persons who entered data or block entries (including voided attempts). */
  dataEnterers: string[];
  /** Persons who corrected data of this step. */
  correctors: string[];
  /** Persons who signed PERFORMED for their own entries. */
  performedSigners: string[];
  signatures: SignatureUse[];
  /** Two-person mode forced (manual fallback, critical manual entry, S5a off). */
  verificationRequired: boolean;
  /** The step was changed after verification: an uninvolved person must re-verify. */
  reverification: boolean;
  /** Snapshot of the values the phase reads (targets shown to the operator), with provenance. */
  targets: Record<string, { value: DataValue; points: string[]; derived: string[] }>;
  skip?: { reason: string; requestedBy: string; approvedBy: string; signature: string; at: bigint };
  notApplicable?: { reason: 'BRANCH_NOT_TAKEN'; construct: string };
  disposition?: { value: string; positive: boolean; by: string; signature: string; at: bigint; comment?: string };
  /** Block-computed items materialised at the PERFORMED transition, by item: the entry-set fingerprint used. */
  blockComputed: Record<string, string>;
}

export interface StoredEvaluation {
  /** The most severe tier breached, if any. */
  breached?: LimitTier;
  requirement: BreachRequirement | 'UNEXPECTED_ANSWER' | 'ENDPOINT_IN_PROGRESS';
  /** Rounded values compared, per tier and bound (plain text for the record). */
  detail: string[];
  /** Expression-language version that rounded. */
  languageVersion: string;
}

export interface DataPoint {
  id: string;
  item: string;
  stepKey: string;
  step: string;
  frames: Frame[];
  /** Attempt number of this item in this step instance (1, 2, ...); a correction keeps the attempt. */
  attempt: number;
  /** Correction version within the attempt (1 = original). */
  version: number;
  /** ABORTED: a voided attempt without a result (path b). */
  kind: 'VALUE' | 'ABORTED';
  value?: DataValue;
  source: DataSource;
  enteredBy: string;
  recordedAt: bigint;
  recordedSeq: number;
  occurredAt?: OccurredAt;
  /** The time that drives time rules: occurred_at only when DEVICE_SYNCED (outline 5.6). */
  timeBasis: 'OCCURRED_AT' | 'RECORDED_AT';
  status: 'VALID' | 'SUPERSEDED' | 'INVALIDATED';
  supersedes?: string;
  supersededBy?: string;
  correction?: { reason: string; signature: string; evidence?: string; approvedBy?: string };
  invalidation?: { investigationRef: string; reason: string; approvedBy: string; signature: string; at: bigint };
  voidReason?: string;
  evaluation?: StoredEvaluation;
  /** The value failed its limits (or an expected answer); a later passing attempt never replaces it (INV-41). */
  failed: boolean;
  flags: ('REPEAT' | 'REPEAT_AFTER_FAIL' | 'MANUAL_FALLBACK' | 'LATE_ENTRY' | 'CORRECTED' | 'ABORTED')[];
  exceptions: string[];
}

export interface DerivedValue {
  id: string;
  calculation: string;
  stepKey: string;
  frames: Frame[];
  version: number;
  status: 'CURRENT' | 'SUPERSEDED';
  value: DataValue;
  record: EvaluationRecord;
  /** Provenance: which data points and derived values fed each input (for dependents of a correction). */
  inputs: { item: string; points: string[]; derived: string[] }[];
  computedAt: bigint;
  computedSeq: number;
  supersedes?: string;
  reason?: string;
  evaluation?: StoredEvaluation;
  failed: boolean;
  exceptions: string[];
}

export interface EntryRecord {
  id: string;
  stepKey: string;
  kind: string;
  /** The normalised entry (block-derived fields included, e.g. net weight). */
  data: Record<string, unknown>;
  enteredBy: string;
  recordedAt: bigint;
  recordedSeq: number;
}

export interface ContainerRecord {
  id: string;
  /** Intermediate or BOM line the container holds. */
  holds: string;
  holdsKind: 'INTERMEDIATE' | 'BOM_LINE';
  producedBy: string;
  /** Loop iteration and sub-lot frames of the producing step (a container of one sub-lot is never charged into another). */
  producedIn: Frame[];
  net?: { value: string; unit: string };
  status: 'QUARANTINE' | 'CONSUMED';
  consumedBy?: string;
}

export type DecisionKind = 'BRANCH' | 'LOOP' | 'COUNT';

export interface DecisionRecord {
  key: string;
  kind: DecisionKind;
  construct: string;
  frames: Frame[];
  outcome: string;
  /** 'SYSTEM' or the deciding person's id. */
  decidedBy: string;
  reason?: string;
  at: bigint;
  seq: number;
  /** Data points and derived values the decision read (for decision-affecting corrections). */
  inputs: { points: string[]; derived: string[] };
  /** Iteration completed (LOOP decisions). */
  iteration?: number;
}

export type ExceptionSeverity = 'ALERT' | 'ACTION' | 'CRITICAL';

/** Review-by-exception category (DI-26 mandatory set, plus time and flow). */
export type ReviewCategory =
  | 'OUT_OF_LIMIT'
  | 'DEVIATION_OR_OVERRIDE'
  | 'FORCED_SKIPPED_NA'
  | 'POST_ENTRY_CHANGE'
  | 'REPEAT_OR_ABORTED'
  | 'LATE_ENTRY'
  | 'MANUAL_ENTRY'
  | 'INTERFACE_FALLBACK'
  | 'TIME_LIMIT'
  | 'FLOW'
  | 'TIME_SYNC';

export interface ExceptionBlock {
  /** Step instances that may not complete. */
  steps: string[];
  /** Steps after this graph node (in compatible contexts) may not start or complete. */
  downstream?: { node: string; frames: Frame[] };
  /** What lifts the block: a linked deviation, or the disposition. */
  until: 'DEVIATION' | 'DISPOSITION';
}

export interface ExceptionRecord {
  id: string;
  type: string;
  category: ReviewCategory;
  title: string;
  controls: string[];
  severity: ExceptionSeverity;
  tier?: LimitTier;
  requirement?: string;
  source: { stepKey?: string; step?: string; frames: Frame[]; item?: string; point?: string; derived?: string; constraint?: string; construct?: string };
  raisedAt: bigint;
  raisedSeq: number;
  raisedBy: string;
  block?: ExceptionBlock;
  deviationRequired: boolean;
  registrationRelevant: boolean;
  qaOnly: boolean;
  stageSignOffBlocked: boolean;
  /** Blocks release until explained (yield, reconciliation, open investigations; Phase 4 release gate reads it). */
  releaseBlocking: boolean;
  deviation?: { ref: string; linkedBy: string; at: bigint };
  status: 'OPEN' | 'DISPOSITIONED';
  disposition?: { by: string; outcome: 'NO_IMPACT' | 'DEVIATION_RAISED'; justification: string; signature: string; at: bigint };
}

export interface HoldRecord {
  id: string;
  type: 'SUPERVISOR' | 'QA';
  reason: string;
  placedBy: string;
  at: bigint;
  automatic: boolean;
  released?: { by: string; reason: string; at: bigint };
}

export interface StageFrameState {
  key: string;
  stage: string;
  frames: Frame[];
  startedAt: bigint;
  /** Set when the stage's closer is reached and waits for sign-off. */
  awaitingSignOff: boolean;
  endedAt?: bigint;
  signOff?: { by: string; signature: string; at: bigint; valid: boolean; summary: StageSummary };
  invalidations: { at: bigint; reason: string }[];
}

export interface StageSummary {
  stage: string;
  startedAt: bigint;
  endedAt: bigint;
  steps: { completed: number; notApplicable: number; skipped: number };
  exceptions: string[];
  deviations: string[];
  /** Derived, never typed (G-02): COMPLETED_PER_MBR only with no exception dispositioned as a deviation or still open. */
  statement: 'COMPLETED_PER_MBR' | 'COMPLETED_WITH_DEVIATIONS';
  yields: { calculation: string; value: string; unit: string }[];
}

export interface SubLot {
  key: string;
  id: string;
  construct: string;
  frames: Frame[];
  index: number;
  createdAt: bigint;
}

export interface NodeEventRecord {
  node: string;
  event: 'START' | 'END';
  frames: Frame[];
  at: bigint;
}

export interface TimeInstanceState {
  key: string;
  constraint: string;
  frames: Frame[];
  warned: boolean;
  maxBreachException?: string;
  minBreachException?: string;
  voided: boolean;
}

export interface BatchHeaderState {
  batchId: string;
  batchNumber: string;
  batchSize: string;
  marketSet: string[];
  purpose: 'COMMERCIAL' | 'PPQ' | 'EXHIBIT' | 'VALIDATION';
  variants: Record<string, string>;
  /** Header and master-data input values with their sources (typed at issue, never later). */
  inputs: Record<string, { value: DataValue; source: string }>;
  issuedBy: string;
  issuedAt: bigint;
  issueSignature?: string;
}

export interface BatchState {
  schema: typeof STATE_SCHEMA;
  engineVersion: string;
  mbrHash: string;
  header: BatchHeaderState;
  status: BatchStatus;
  /** Accepted commands so far (optimistic locking). */
  version: number;
  /** Last event sequence number. */
  seq: number;
  /** Latest trusted time seen (a regressing clock is flagged, never trusted to hide a breach). */
  lastRecordedUs: bigint;
  marking: Marking;
  steps: Record<string, StepInstance>;
  decisions: Record<string, DecisionRecord>;
  points: Record<string, DataPoint>;
  derived: Record<string, DerivedValue>;
  entries: Record<string, EntryRecord>;
  containers: Record<string, ContainerRecord>;
  exceptions: Record<string, ExceptionRecord>;
  holds: Record<string, HoldRecord>;
  stages: Record<string, StageFrameState>;
  subLots: Record<string, SubLot>;
  /** Node events (step and construct starts and ends) by `${node}|${event}|${context}`, with their time basis instant. */
  nodeEvents: Record<string, NodeEventRecord>;
  timeInstances: Record<string, TimeInstanceState>;
  /** Decisions that could not be evaluated yet (exception raised once per decision point). */
  pendingDecisionProblems: Record<string, string>;
  appliedCommands: string[];
  /** Signature ids already used in this batch (one signature, one purpose). */
  usedSignatures: Record<string, string>;
  /** Status to return to when the last hold is released. */
  statusBeforeHold?: 'ISSUED' | 'IN_PROGRESS';
  counters: Record<string, number>;
  abort?: { reason: string; approvals: string[]; at: bigint };
}

// ---------------------------------------------------------------------------------------------
// Events

interface EventBase {
  seq: number;
  at: bigint;
}

export type EngineEvent = EventBase &
  (
    | { type: 'BATCH_ISSUED'; batchId: string; batchNumber: string; mbrHash: string; marketSet: string[] }
    | { type: 'BATCH_STATUS_CHANGED'; from: BatchStatus; to: BatchStatus; reason: string }
    | { type: 'HOLD_PLACED'; hold: string; holdType: 'SUPERVISOR' | 'QA'; automatic: boolean; reason: string }
    | { type: 'HOLD_RELEASED'; hold: string; by: string; reason: string }
    | { type: 'STEP_STATUS_CHANGED'; stepKey: string; step: string; from: StepStatus; to: StepStatus; by: string; reason?: string }
    | { type: 'NODE_FIRED'; node: string; kind: string; context: string }
    | { type: 'DECISION_MADE'; decision: string; kind: DecisionKind; construct: string; outcome: string; by: string; reason?: string }
    | { type: 'SUBLOT_CREATED'; subLot: string; construct: string; index: number; context: string }
    | { type: 'DATA_RECORDED'; point: string; stepKey: string; item: string; attempt: number; version: number; by: string; failed: boolean; flags: string[] }
    | { type: 'DATA_CORRECTED'; point: string; supersedes: string; by: string; reason: string }
    | { type: 'ATTEMPT_VOIDED'; point: string; stepKey: string; item: string; by: string; reason: string }
    | { type: 'RESULT_INVALIDATED'; point: string; by: string; investigationRef: string }
    | { type: 'ENTRY_RECORDED'; entry: string; stepKey: string; kind: string; by: string }
    | { type: 'CONTAINER_REGISTERED'; container: string; holds: string; stepKey: string }
    | { type: 'CONTAINER_CONSUMED'; container: string; stepKey: string }
    | { type: 'DERIVED_VALUE_COMPUTED'; derived: string; calculation: string; stepKey: string; value: DataValue; contentHash: string; supersedes?: string; reason?: string }
    | { type: 'EXCEPTION_RAISED'; exception: string; exceptionType: string; severity: ExceptionSeverity; tier?: LimitTier; title: string; controls: string[] }
    | { type: 'DEVIATION_LINKED'; exception: string; deviationRef: string; by: string }
    | { type: 'EXCEPTION_DISPOSITIONED'; exception: string; outcome: string; by: string }
    | { type: 'INVOLVEMENT'; stepKey: string; person: string; involvement: 'STARTED' | 'ENTERED_DATA' | 'PERFORMED' | 'CORRECTED' | 'VOIDED' | 'VERIFIED' | 'WITNESSED' | 'APPROVED_SKIP' | 'SIGNED_HOLD_POINT' | 'DISPOSITIONED_EXCEPTION' }
    | { type: 'SIGNATURE_APPLIED'; signature: string; meaning: string; signer: string; stepKey?: string; subject: string }
    | { type: 'SIGNATURES_INVALIDATED'; signatures: string[]; stepKey: string; reason: string }
    | { type: 'STAGE_SIGNED_OFF'; stageKey: string; by: string; statement: StageSummary['statement'] }
    | { type: 'STAGE_SIGN_OFF_INVALIDATED'; stageKey: string; reason: string }
    | { type: 'TIME_WARNING'; constraint: string; instance: string; remainingUs: bigint }
    | { type: 'TIME_CONSTRAINT_VOIDED'; constraint: string; instance: string }
    | { type: 'NOTIFICATION'; roles: string[]; subject: string; message: string }
    | { type: 'CLOCK_REGRESSION'; previousUs: bigint; nowUs: bigint }
    | { type: 'COMMAND_REFUSED'; commandId: string; commandType: string; code: string; by: string }
  );

export type EngineEventType = EngineEvent['type'];

/** Why a command was refused: plain language first, then the rule and controls (outline 6.3 message style). */
export interface Refusal {
  code: string;
  message: string;
  controls: string[];
}

export interface StepResult {
  /** The next state. After a refusal it holds only system facts the command triggered (sweep, finalisation). */
  state: BatchState;
  events: EngineEvent[];
  accepted: boolean;
  refusal?: Refusal;
  /** The command id was applied before: nothing happened (idempotency). */
  duplicate?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Policy (switches of outline 3.5 / 7.2 with their defaults)

export interface EnginePolicy {
  /** S5a: one human verifier for validated automated operations. Default false: two persons on every batch. */
  oneVerifierMode: boolean;
  /** S28: QA approval of each void. Default true. */
  voidNeedsQaApproval: boolean;
  /** S25: approval of a correction of critical data by a supervisor or QA. Default true. */
  criticalCorrectionNeedsApproval: boolean;
  qaRoles: readonly string[];
  supervisorRoles: readonly string[];
  /** Head of production for the two-signature abort. */
  productionHeadRoles: readonly string[];
  /** Roles that may choose a run-time replicate count (the MBR model names none). */
  replicateCountRoles: readonly string[];
  /** Roles that may verify when two-person mode is forced on a phase without a checker. */
  fallbackVerifierRoles: readonly string[];
  /** Window for a WITNESSED signature after the act (default 5 min); later raises an exception. */
  witnessWindowUs: bigint;
}

export const DEFAULT_POLICY: EnginePolicy = {
  oneVerifierMode: false,
  voidNeedsQaApproval: true,
  criticalCorrectionNeedsApproval: true,
  qaRoles: ['QA'],
  supervisorRoles: ['PRODUCTION_SUPERVISOR', 'HEAD_OF_PRODUCTION'],
  productionHeadRoles: ['HEAD_OF_PRODUCTION'],
  replicateCountRoles: ['PRODUCTION_SUPERVISOR', 'HEAD_OF_PRODUCTION'],
  fallbackVerifierRoles: ['PRODUCTION_VERIFIER', 'PRODUCTION_SUPERVISOR', 'QA'],
  witnessWindowUs: 5n * 60n * 1_000_000n,
};

/** Header facts supplied at issue (G-01). The issue signature itself is Phase 4 (PR-10). */
export interface IssueRequest {
  batchId: string;
  batchNumber: string;
  /** Id of one of the MBR's approved batch sizes (PR-01: no free scaling). */
  batchSize: string;
  marketSet: readonly string[];
  purpose?: BatchHeaderState['purpose'];
  variants?: Readonly<Record<string, string>>;
  /** Values for every BATCH_HEADER and MASTER_DATA input, each with its source. */
  inputs: Readonly<Record<string, { value: DataValue; source: string }>>;
  issuedBy: Actor;
  issueSignature?: SignatureRef;
}
