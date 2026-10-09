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
  /** Recorded readings or per-instance values; `maxLength` bounds the static cost. */
  | { kind: 'SERIES'; of: ExprType; maxLength?: number };

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
  | { kind: 'TEXT'; value: string }
  /** Recorded readings (all in one unit). */
  | { kind: 'SERIES'; values: string[]; unit: string };

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
  | { readonly op: 'const'; readonly value: boolean }
  | { readonly op: 'not'; readonly arg: GuardFormula }
  | { readonly op: 'and'; readonly args: readonly GuardFormula[] }
  | { readonly op: 'or'; readonly args: readonly GuardFormula[] }
  /** variable <cmp> constant, the constant expressed in the variable's declared unit. */
  | { readonly op: 'cmp'; readonly variable: string; readonly cmp: '<' | '<=' | '>' | '>=' | '==' | '!='; readonly constant: string }
  /** variable == value for categories and booleans. */
  | { readonly op: 'is'; readonly variable: string; readonly value: string | boolean }
  | { readonly op: 'opaque'; readonly reason: string };

/** What an expression is: a CALCULATION derives a value from inputs; a CONDITION gives true or false. */
export interface ExpressionOptions {
  role: 'CALCULATION' | 'CONDITION';
  /** Declared result of a calculation (converted to exactly, tag checked). */
  output?: ExprType;
}

export interface ExpressionService {
  /** Expression-language version stored with every result (ADR 0005). */
  readonly languageVersion: string;
  /** Parses, type- and unit-checks an expression against the declared inputs. */
  check(source: string, inputs: ReadonlyMap<string, ExprType>, options: ExpressionOptions): ExpressionCheck;
  /** Evaluates a checked expression; values missing from `values` are missing inputs (an error). */
  evaluate(source: string, inputs: ReadonlyMap<string, ExprType>, values: ReadonlyMap<string, ExprValue>, options: ExpressionOptions): EvaluationOutcome;
  /** Normalises a boolean guard for the exhaustiveness/overlap decision procedure. */
  guard(source: string, inputs: ReadonlyMap<string, ExprType>): GuardFormula;
  /**
   * Compares a full-precision value with one bound, rounding per the rule (the only place rounding
   * happens). `other` is the opposite bound of the same range: USP rounds to the decimals of the
   * limit as written, i.e. of the more precise of the two bounds.
   */
  compareToBound(value: string, bound: LimitBound, side: 'LOW' | 'HIGH', rounding: RoundingRule, other?: LimitBound): BoundComparison;
  /** On-limit, just-inside and just-outside vectors at the rounding boundary of one bound. */
  boundaryVectors(bound: LimitBound, side: 'LOW' | 'HIGH', rounding: RoundingRule, other?: LimitBound): BoundaryVector[];
  /** Validates a UCUM unit code; returns its dimension signature when valid. */
  unit(code: string): { ok: true; dimension: string } | { ok: false; message: string };
  /** Exact conversion between commensurable units; undefined when not commensurable. */
  convert(value: string, from: string, to: string): string | undefined;
  /** Exact decimal comparison (-1, 0, 1). */
  compare(a: string, b: string): -1 | 0 | 1;
}
