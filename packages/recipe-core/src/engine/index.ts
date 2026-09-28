/**
 * Execution engine (ADR 0004 decision 5): `step(state, command, clock) -> (state, events)`, the sweeper,
 * batch issue, and the invariant checks. See README.md in this folder.
 */
export * from './types.ts';
export { defineBatch, reachFrom, EngineDefinitionError, RELEASING_DISPOSITIONS, type BatchDefinition, type DefineOptions, type DefinitionProblem, type RuntimeConstraint, type StepDef } from './definition.ts';
export { createEngine, issue, step, sweep, IssueRefusedError, type Engine } from './engine.ts';
export { ENGINE_EXCEPTION_RULES, blockingExceptions, blockActive } from './exceptions.ts';
export { MEANINGS, VERIFICATION_MEANINGS } from './guards.ts';
export { effectivePoint, resolveAt, showValue } from './values.ts';
export { stepKey, ctxKey } from './tx.ts';
export { checkInvariants, type InvariantViolation } from './invariants.ts';
