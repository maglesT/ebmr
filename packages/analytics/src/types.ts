/**
 * What a method returns (interfaces slice-6A-0-interfaces.md section 1). The runner records each draft through the
 * kernel's analytics functions: an output with analytics.record_output, a flag with analytics.record_flag.
 */

/** What an output or a flag is about (analytics.output.subject_kind). PERSON and ACCOUNT are restricted (DI-53). */
export type SubjectKind = 'BATCH' | 'PRODUCT_ITEM' | 'GROUP' | 'EQUIPMENT_STEP_TAG' | 'PERSON' | 'ACCOUNT' | 'METHOD';
export const SUBJECT_KINDS: readonly SubjectKind[] = ['BATCH', 'PRODUCT_ITEM', 'GROUP', 'EQUIPMENT_STEP_TAG', 'PERSON', 'ACCOUNT', 'METHOD'];

/** The kinds of output (analytics.output.kind; interfaces section 4). */
export type OutputKind =
  | 'CONTROL_CHART'
  | 'CAPABILITY'
  | 'DRIFT'
  | 'RATE_COMPARISON'
  | 'MODEL_CANDIDATE'
  | 'MSPC_SCORE'
  | 'AUDIT_RULE_HIT'
  | 'AUDIT_BASELINE'
  | 'REVIEW_PRIORITY'
  | 'PROFILE_DISTANCE';
export const OUTPUT_KINDS: readonly OutputKind[] = [
  'CONTROL_CHART', 'CAPABILITY', 'DRIFT', 'RATE_COMPARISON', 'MODEL_CANDIDATE', 'MSPC_SCORE', 'AUDIT_RULE_HIT', 'AUDIT_BASELINE', 'REVIEW_PRIORITY',
  'PROFILE_DISTANCE',
];

export type Severity = 'INFO' | 'ATTENTION' | 'HIGH';

/** Something a reason points at: an audit entry, a batch, a record (kind and reference). */
export interface Evidence {
  readonly kind: string;
  readonly ref: string;
}

/** Why an output says what it says, or why a flag was raised. */
export interface Reason {
  readonly code: string;
  readonly text: string;
  readonly weight?: number;
  readonly evidence?: readonly Evidence[];
}

/** An advisory output: statistics are numbers (StatNumber in the contract); a GMP value echoed stays decimal text. */
export interface OutputDraft {
  readonly subjectKind: SubjectKind;
  readonly subjectRef: string;
  readonly kind: OutputKind;
  readonly values: Readonly<Record<string, number | readonly number[] | string>>;
  readonly reasons: readonly Reason[];
}

/** A flag: at least one reason (EBMR-ANA-004). */
export interface FlagDraft {
  readonly subjectKind: SubjectKind;
  readonly subjectRef: string;
  readonly rule: string;
  readonly severity: Severity;
  readonly reasons: readonly [Reason, ...Reason[]];
}
