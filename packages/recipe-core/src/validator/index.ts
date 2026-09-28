/**
 * Static MBR validator (outline 6.3): structure, data, time and GMP content gates, the market-minima
 * hook and the edition rule registry. See README.md in this folder.
 */
export * from './types.ts';
export { Analysis, GLOBAL_SCOPE, CONDITION, calculationOptions, type CheckedExpression, type DataItem, type NodeInfo } from './analysis.ts';
export { checkGraph, type GraphProblem, type GraphProblemCode } from './graph-checks.ts';
export { analyseGuards, evaluateGuard, describePoint, type GuardAnalysis, type GuardBranch, type Point } from './guards.ts';
export { checkTemporalNetwork, type NetConstraint, type NetworkResult } from './time-network.ts';
export { defineRule, error, warning, label, type Rule } from './rule-kit.ts';
export { STRUCTURE_RULES, graphRuleFor } from './rules-structure.ts';
export { DATA_RULES } from './rules-data.ts';
export { TIME_RULES, networkConstraints } from './rules-time.ts';
export { CONTENT_RULES, GENERIC_COVERED_ITEMS } from './rules-content.ts';
export { marketRule, minimaRequest, boundRuleKeys } from './rules-market.ts';
export { validateMbr, gate, validateGraph, requiredLookups, createGenericRegistry, withEditionRules, RuleRegistry, VALIDATOR_VERSION } from './validate.ts';
