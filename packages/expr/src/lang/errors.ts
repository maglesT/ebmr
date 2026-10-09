/**
 * Typed evaluation errors (ADR 0005 decision 5; brief A1 item 4). A missing input, a division by
 * zero or an out-of-domain value raises one of these, naming the input path(s) involved; the
 * evaluator never returns a silent zero, NaN or an infinity.
 */
import type { Span } from '../diagnostics.ts';

export type EvaluationErrorCode =
  /** A declared input the evaluation needs has no value. */
  | 'MISSING_INPUT'
  /** An input value is malformed (not a decimal string, wrong unit, unknown category, ...). */
  | 'INVALID_INPUT'
  | 'DIVISION_BY_ZERO'
  /** A value outside a function's domain (sd of fewer than 2 values, a negative LOD, ...). */
  | 'DOMAIN_ERROR'
  /** A recorded series has no values where at least one is needed. */
  | 'EMPTY_SERIES'
  /** A recorded series is longer than its declared maximum. */
  | 'SERIES_TOO_LONG'
  /** An acceptance-table lookup found no table or no row. */
  | 'TABLE_LOOKUP_FAILED'
  /** A DERIVED input was given as a typed value instead of a computed result (INV-25). */
  | 'DERIVED_VALUE_TYPED'
  /** A computed result offered as a DERIVED input does not verify (hash or type). */
  | 'DERIVED_RECORD_INVALID'
  /** A result is outside the representable decimal range. */
  | 'NUMERIC_RANGE';

export class ExprEvaluationError extends Error {
  readonly code: EvaluationErrorCode;
  /** The first input path involved, when one is known. */
  readonly path: string | undefined;
  /** Every input path read by the failing part of the expression. */
  readonly paths: readonly string[];
  readonly span: Span | undefined;
  /** Library function that raised it, when one did. */
  readonly fn: string | undefined;

  constructor(code: EvaluationErrorCode, message: string, detail: { paths?: readonly string[]; span?: Span; fn?: string } = {}) {
    const paths = detail.paths ?? [];
    const where = paths.length > 0 ? ` [input: ${paths.join(', ')}]` : '';
    super(`${message}${where} (${code}, DI-33)`);
    this.name = 'ExprEvaluationError';
    this.code = code;
    this.paths = paths;
    this.path = paths[0];
    this.span = detail.span;
    this.fn = detail.fn;
  }
}
