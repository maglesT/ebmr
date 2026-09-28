/**
 * Limit model (PR-08): tiers, nesting validation, evaluation against tiers, ALL_APPLY schemes.
 * See README.md in this folder.
 */
export * from './model.ts';
export { checkLimitSpec, checkNestingAfterRounding, tierName, type LimitProblem } from './nesting.ts';
export { evaluateLimits, LimitEvaluationError, TIER_REQUIREMENTS, type LimitEvaluation, type TierResult } from './evaluate.ts';
export { evaluateAllApply, samplingShortfalls, samplingUnion, type CriterionResult, type SamplingShortfall, type SchemeResult } from './all-apply.ts';
