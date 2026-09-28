/**
 * Versions stored with every evaluation result (ADR 0005 decision 8, DI-33).
 *
 * EXPR_LANGUAGE_VERSION covers the syntax, the type/unit/tag rules, the closed function library and
 * the rounding rule sets. Any change to what an expression means, or to what a library function
 * returns for the same inputs, needs a new version (ADR 0010: results stay reproducible under the
 * version that produced them). New functions arrive only in platform releases.
 */
export const EXPR_LANGUAGE_VERSION = '1.0.0';

/** Identifier of the evaluation-record layout (evidence/record.ts). */
export const EVALUATION_RECORD_SCHEMA = 'ebmr.expr.evaluation/1';
