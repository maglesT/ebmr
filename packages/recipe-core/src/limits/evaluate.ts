/**
 * Evaluation of a value against its limit tiers (PR-08; outline 5.2.4, 6.4).
 *
 * The value is kept exactly as acquired (full precision); each tier compares it with its own bounds
 * under its own rounding rule through the expression language, the only place rounding happens.
 * The result names every tier breached and what the most severe breach requires:
 *   ALERT            -> notification and an exception-register item;
 *   INTERNAL_ACTION  -> the dependent step stops until a deviation is opened (the MBR may let the
 *                       current step continue with the deviation raised);
 *   REGISTERED / VALIDATED (registered limit, CPP or CQA)
 *                    -> a deviation flagged registration-relevant is mandatory, only QA dispositions
 *                       it, it shows on every release screen, and the stage cannot be signed off
 *                       until QA has classified it.
 * A missing value is an exception, never a pass. Nobody can clear the requirement at the evaluation:
 * it is a fact of the record; only the deviation process dispositions it.
 */
import type { BoundComparison, ExpressionService } from '../flow/expression-port.ts';
import { LIMIT_TIERS, type BreachRequirement, type LimitRange, type LimitSpec, type LimitTier } from './model.ts';

export interface TierResult {
  tier: LimitTier;
  pass: boolean;
  low?: BoundComparison;
  high?: BoundComparison;
  rounding: LimitRange['rounding'];
  source: LimitRange['source'];
  pharmacopoeia?: LimitRange['pharmacopoeia'];
}

export interface LimitEvaluation {
  /** Exactly as acquired, in the limit's unit (converted exactly when captured in another unit). */
  value: string | undefined;
  capturedValue: string | undefined;
  capturedUnit: string | undefined;
  unit: string;
  /** Outer tiers first. */
  tiers: TierResult[];
  /** Every tier the value is outside of. */
  breachedTiers: LimitTier[];
  /** The most severe tier breached. */
  breached: LimitTier | undefined;
  requirement: BreachRequirement;
  /** A deviation must be opened. */
  deviationRequired: boolean;
  /** The deviation is flagged registration-relevant (registered limit, CPP or CQA). */
  registrationRelevant: boolean;
  /** Steps that depend on this value may not start until the deviation exists. */
  dependentStepsBlockedUntilDeviation: boolean;
  /** Only for internal action limits when the MBR allows it (PR-08 type_detail). */
  currentStepMayContinueWithDeviation: boolean;
  qaOnlyDisposition: boolean;
  onReleaseScreen: boolean;
  stageSignOffBlockedUntilQaClassification: boolean;
  /** Always false: an operator can never suppress or clear the flag (PR-08). */
  operatorMayClear: false;
  /** Expression-language version that did the rounding (stored with the result). */
  languageVersion: string;
}

export class LimitEvaluationError extends Error {
  constructor(
    readonly code: 'UNIT_NOT_CONVERTIBLE',
    message: string,
  ) {
    super(message);
    this.name = 'LimitEvaluationError';
  }
}

const SEVERITY: Record<LimitTier, number> = { REGISTERED: 3, VALIDATED: 3, INTERNAL_ACTION: 2, ALERT: 1 };

/** Evaluates one value (or its absence) against every tier of a limit specification. */
export function evaluateLimits(spec: LimitSpec, captured: { value: string; unit: string } | undefined, expr: ExpressionService): LimitEvaluation {
  const ordered = [...spec.ranges].sort((a, b) => LIMIT_TIERS.indexOf(a.tier) - LIMIT_TIERS.indexOf(b.tier));
  const base = {
    capturedValue: captured?.value,
    capturedUnit: captured?.unit,
    unit: spec.unit,
    operatorMayClear: false as const,
    languageVersion: expr.languageVersion,
  };
  if (!captured) {
    return {
      ...base,
      value: undefined,
      tiers: ordered.map((r) => {
        const t: TierResult = { tier: r.tier, pass: false, rounding: r.rounding, source: r.source };
        if (r.pharmacopoeia) t.pharmacopoeia = r.pharmacopoeia;
        return t;
      }),
      breachedTiers: [],
      breached: undefined,
      requirement: 'MISSING_VALUE_EXCEPTION',
      deviationRequired: false,
      registrationRelevant: false,
      dependentStepsBlockedUntilDeviation: true,
      currentStepMayContinueWithDeviation: false,
      qaOnlyDisposition: false,
      onReleaseScreen: false,
      stageSignOffBlockedUntilQaClassification: false,
    };
  }
  const value = captured.unit === spec.unit ? captured.value : expr.convert(captured.value, captured.unit, spec.unit);
  if (value === undefined) throw new LimitEvaluationError('UNIT_NOT_CONVERTIBLE', `A value in ${captured.unit} cannot be compared with limits in ${spec.unit}`);
  const tiers: TierResult[] = ordered.map((r) => {
    const t: TierResult = { tier: r.tier, pass: true, rounding: r.rounding, source: r.source };
    if (r.pharmacopoeia) t.pharmacopoeia = r.pharmacopoeia;
    if (r.low) {
      t.low = expr.compareToBound(value, r.low, 'LOW', r.rounding);
      t.pass &&= t.low.pass;
    }
    if (r.high) {
      t.high = expr.compareToBound(value, r.high, 'HIGH', r.rounding);
      t.pass &&= t.high.pass;
    }
    return t;
  });
  const breachedTiers = tiers.filter((t) => !t.pass).map((t) => t.tier);
  const breached = breachedTiers.reduce<LimitTier | undefined>((worst, t) => (worst === undefined || SEVERITY[t] > SEVERITY[worst] ? t : worst), undefined);
  const severity = breached === undefined ? 0 : SEVERITY[breached];
  const requirement: BreachRequirement = severity === 3 ? 'REGISTRATION_RELEVANT_DEVIATION' : severity === 2 ? 'STOP_UNTIL_DEVIATION' : severity === 1 ? 'REGISTER_ITEM' : 'NONE';
  const continueAllowed = severity === 2 && spec.actionBreach === 'CONTINUE_CURRENT_STEP_WITH_DEVIATION';
  return {
    ...base,
    value,
    tiers,
    breachedTiers,
    breached,
    requirement,
    deviationRequired: severity >= 2,
    registrationRelevant: severity === 3,
    dependentStepsBlockedUntilDeviation: severity >= 2,
    currentStepMayContinueWithDeviation: continueAllowed,
    qaOnlyDisposition: severity === 3,
    onReleaseScreen: severity === 3,
    stageSignOffBlockedUntilQaClassification: severity === 3,
  };
}

/** The limit tier table (outline 5.2.4) as data, for renderers and reviewers. */
export const TIER_REQUIREMENTS: Readonly<Record<LimitTier, { requirement: BreachRequirement; summary: string }>> = {
  ALERT: { requirement: 'REGISTER_ITEM', summary: 'Notification and an item in the exception register' },
  INTERNAL_ACTION: { requirement: 'STOP_UNTIL_DEVIATION', summary: 'Dependent step stops until a deviation is opened; the MBR may let the current step continue with the deviation raised' },
  VALIDATED: { requirement: 'REGISTRATION_RELEVANT_DEVIATION', summary: 'Registration-relevant deviation, QA-only disposition, on every release screen, stage sign-off blocked until QA classifies it' },
  REGISTERED: { requirement: 'REGISTRATION_RELEVANT_DEVIATION', summary: 'Registration-relevant deviation, QA-only disposition, on every release screen, stage sign-off blocked until QA classifies it' },
};
