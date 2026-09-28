/**
 * Limit model (PR-08; outline 5.2.4, 6.3, 6.4; ADR 0005).
 *
 * A parameter, IPC result, calculation or yield carries nested limit ranges, one per tier:
 *   ALERT inside INTERNAL_ACTION inside REGISTERED and VALIDATED.
 * REGISTERED is the limit filed in the marketing authorisation (or a CQA/CPP specification);
 * VALIDATED is the proven acceptable range from validation. Both are outer tiers: an internal action
 * range must lie inside each of them, and an alert range inside the internal action range.
 *
 * Every bound is a decimal literal STRING exactly as the author wrote it ("95.0" is not "95": the
 * number of decimals drives USP rounding). No JavaScript `number` ever holds a GMP value.
 * This file imports nothing so that the flow model, validator and simulator can all build on it.
 */

/** Outer to inner. REGISTERED and VALIDATED are peers; INTERNAL_ACTION sits inside both. */
export const LIMIT_TIERS = ['REGISTERED', 'VALIDATED', 'INTERNAL_ACTION', 'ALERT'] as const;
export type LimitTier = (typeof LIMIT_TIERS)[number];

/**
 * Rounding at comparison (outline 6.4): USP rounds the observed value to the decimals of the limit,
 * half up; Ph. Eur. rounds to the significant figures of the limit. Full precision is always stored.
 */
export const ROUNDING_RULES = ['USP_HALF_UP_AT_LIMIT_DECIMALS', 'PH_EUR_SIG_FIGS'] as const;
export type RoundingRule = (typeof ROUNDING_RULES)[number];

/** Where a limit comes from (PR-08: validation report or registration; IN-33: pharmacopoeia edition). */
export const LIMIT_SOURCE_KINDS = ['REGISTRATION', 'VALIDATION_REPORT', 'PHARMACOPOEIA', 'PROCESS_DATA', 'HOLD_STUDY', 'RULE_TABLE', 'COMPANY_STANDARD'] as const;
export type LimitSourceKind = (typeof LIMIT_SOURCE_KINDS)[number];

export interface LimitSource {
  kind: LimitSourceKind;
  /** Id of an entry in the MBR's `references` list (pinned by version and hash). */
  ref: string;
}

/** Pharmacopoeia and edition a compendial limit was taken from (IN-33), e.g. {code: 'IP', edition: '2026'}. */
export interface PharmacopoeiaEdition {
  code: string;
  edition: string;
}

export interface LimitBound {
  /** Decimal literal as written, e.g. "95.0". */
  value: string;
  /** true: the bound value itself passes (95.0 <= x); false: strict (95.0 < x). */
  inclusive: boolean;
}

export interface LimitRange {
  tier: LimitTier;
  low?: LimitBound;
  high?: LimitBound;
  rounding: RoundingRule;
  source: LimitSource;
  pharmacopoeia?: PharmacopoeiaEdition;
}

/**
 * What an internal-action breach does to the step that measured the value (PR-08 type_detail):
 * the default stops the dependent step until a deviation is opened; the MBR may let the current step
 * continue with the deviation raised. Registered/validated breaches always stop.
 */
export type ActionBreachMode = 'STOP_DEPENDENT_STEP' | 'CONTINUE_CURRENT_STEP_WITH_DEVIATION';

export interface LimitSpec {
  /** UCUM unit every bound is expressed in (the value is compared in this unit). */
  unit: string;
  ranges: LimitRange[];
  actionBreach?: ActionBreachMode;
}

/** What a breach of a tier requires (outline 5.2.4). */
export type BreachRequirement =
  | 'NONE'
  /** Alert: notification plus an exception-register item. */
  | 'REGISTER_ITEM'
  /** Internal action: the dependent step stops until a deviation is opened (or continues with one, if the MBR allows). */
  | 'STOP_UNTIL_DEVIATION'
  /** Registered / validated (CPP, CQA): a registration-relevant deviation is mandatory; only QA dispositions it. */
  | 'REGISTRATION_RELEVANT_DEVIATION'
  /** The value is missing: an exception, never a pass (outline 6.4 explicit errors). */
  | 'MISSING_VALUE_EXCEPTION';

/** An ALL_APPLY acceptance scheme (outline 3.3.1): every criterion is evaluated on its own. */
export interface SamplingNeed {
  /** Where or when units are taken, e.g. "start", "middle", "end", "every-30-min". */
  point: string;
  /** What the units are used for (test id); units for different purposes add up unless shared. */
  purpose: string;
  /** Number of units (a count, not a GMP value). */
  units: number;
  /** Destructive tests consume their units; non-destructive units can serve several criteria of the same purpose. */
  destructive: boolean;
}

export interface AcceptanceCriterion {
  id: string;
  title: string;
  /** Markets whose rule requires this criterion (stored with each result). */
  governingMarkets: string[];
  pharmacopoeia: PharmacopoeiaEdition;
  /** Id of the calculation (or parameter) whose value is compared with the range. */
  statistic: string;
  range: LimitRange;
  sampling: SamplingNeed[];
}

export interface AcceptanceScheme {
  id: string;
  title: string;
  method: 'ALL_APPLY';
  unit: string;
  criteria: AcceptanceCriterion[];
}
