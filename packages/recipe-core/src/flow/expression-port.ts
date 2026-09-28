/**
 * The narrow interface recipe-core needs from the expression language (@ebmr/expr; ADR 0005).
 *
 * The validator, limit model and simulator depend on this port, never on expr internals; the adapter
 * (`expr-adapter.ts`) implements it with @ebmr/expr. Everything that parses, type- and unit-checks,
 * evaluates or ROUNDS goes through here, so the designer and the server use exactly one
 * implementation and GMP values never pass through a JavaScript `number`.
 */
import type { LimitBound, RoundingRule } from '../limits/model.ts';

/** Static type of a value or expression. `unit` is a UCUM code ('1' when dimensionless). */
export type ExprType =
  | { kind: 'DECIMAL'; unit: string; tag?: string }
  | { kind: 'COUNT' }
  | { kind: 'BOOLEAN' }
  | { kind: 'CATEGORY'; values: readonly string[] }
  | { kind: 'TEXT' }
  | { kind: 'INSTANT' }
  | { kind: 'SERIES'; of: ExprType };

export interface ExpressionProblem {
  /** Stable code from the expression language (e.g. unit mismatch, unknown identifier). */
  code: string;
  message: string;
  /** Source span (character offsets) where known. */
  start?: number;
  end?: number;
  /** A warning (e.g. the legacy "kg/cm2 (as kgf)" alias) needs a recorded justification; errors block. */
  severity: 'ERROR' | 'WARNING';
}

export interface ExpressionCheck {
  /** No ERROR problems. */
  ok: boolean;
  problems: ExpressionProblem[];
  /** Declared inputs the expression reads, sorted, without duplicates. */
  reads: string[];
  /** Result type, when the expression checks. */
  type?: ExprType;
}

/** A runtime value. Decimals and counts are decimal strings (full precision, never rounded). */
export type ExprValue =
  | { kind: 'DECIMAL'; value: string; unit: string }
  | { kind: 'COUNT'; value: string }
  | { kind: 'BOOLEAN'; value: boolean }
  | { kind: 'CATEGORY'; value: string }
  | { kind: 'TEXT'; value: string };

export type EvaluationOutcome =
  | { ok: true; value: ExprValue }
  /** Explicit errors: missing input, division by zero, out of domain; never a silent zero or NaN. */
  | { ok: false; code: string; message: string; input?: string };

/** Result of comparing a full-precision value with one limit bound under a rounding rule. */
export interface BoundComparison {
  pass: boolean;
  /** The rounded value actually compared (for the record and the reviewer). */
  rounded: string;
}

/** A boundary test vector for one limit bound, as data with a plain-language description. */
export interface BoundaryVector {
  value: string;
  expected: 'PASS' | 'FAIL';
  label: 'ON_LIMIT' | 'JUST_INSIDE' | 'JUST_OUTSIDE';
  description: string;
}

/**
 * A branch guard reduced to the decidable fragment (single-variable comparisons with constants,
 * category/boolean tests, and/or/not). Anything else is OPAQUE and cannot be proven exhaustive.
 */
export type GuardFormula =
  | { op: 'const'; value: boolean }
  | { op: 'not'; arg: GuardFormula }
  | { op: 'and'; args: GuardFormula[] }
  | { op: 'or'; args: GuardFormula[] }
  /** variable <cmp> constant, the constant expressed in the variable's declared unit. */
  | { op: 'cmp'; variable: string; cmp: '<' | '<=' | '>' | '>=' | '==' | '!='; constant: string }
  /** variable == value for categories and booleans. */
  | { op: 'is'; variable: string; value: string | boolean }
  | { op: 'opaque'; reason: string };

export interface ExpressionService {
  /** Expression-language version stored with every result (ADR 0005). */
  readonly languageVersion: string;
  /** Parses, type- and unit-checks an expression against the declared inputs. */
  check(source: string, inputs: ReadonlyMap<string, ExprType>): ExpressionCheck;
  /** Evaluates a checked expression; values missing from `values` are missing inputs (an error). */
  evaluate(source: string, inputs: ReadonlyMap<string, ExprType>, values: ReadonlyMap<string, ExprValue>): EvaluationOutcome;
  /** Normalises a boolean guard for the exhaustiveness/overlap decision procedure. */
  guard(source: string, inputs: ReadonlyMap<string, ExprType>): GuardFormula;
  /** Compares a full-precision value with one bound, rounding per the rule (the only place rounding happens). */
  compareToBound(value: string, bound: LimitBound, side: 'LOW' | 'HIGH', rounding: RoundingRule): BoundComparison;
  /** On-limit, just-inside and just-outside vectors at the rounding boundary of one bound. */
  boundaryVectors(bound: LimitBound, side: 'LOW' | 'HIGH', rounding: RoundingRule): BoundaryVector[];
  /** Validates a UCUM unit code; returns its dimension signature when valid. */
  unit(code: string): { ok: true; dimension: string } | { ok: false; message: string };
  /** Exact conversion between commensurable units; undefined when not commensurable. */
  convert(value: string, from: string, to: string): string | undefined;
  /** Exact decimal comparison (-1, 0, 1). */
  compare(a: string, b: string): -1 | 0 | 1;
}
