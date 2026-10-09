/**
 * Contract of a library function. The library is closed (ADR 0005 decision 6): functions are
 * TypeScript modules registered in library/index.ts and arrive only in platform releases; an
 * expression can only call them.
 */
import type { Rational } from '../decimal/exact.ts';
import type { Span } from '../diagnostics.ts';
import type { Expr } from '../lang/ast.ts';
import type { ExprType } from '../lang/types.ts';
import type { QuantityValue, RuntimeValue } from '../lang/values.ts';
import type { Tag } from '../units/tags.ts';
import type { Unit } from '../units/unit.ts';
import type { AcceptanceTableCatalog } from './acceptance-tables.ts';

export interface ArgInfo {
  readonly type: ExprType;
  readonly node: Expr;
  /** True when the argument reads no input (a constant). */
  readonly constant: boolean;
}

/** Thrown by check(): becomes a design-time diagnostic at the argument (or the call). */
export class CheckFailure extends Error {
  readonly code: string;
  readonly argIndex: number | undefined;
  constructor(code: string, message: string, argIndex?: number) {
    super(message);
    this.code = code;
    this.argIndex = argIndex;
  }
}

export interface CheckContext {
  readonly callee: string;
  readonly tables: AcceptanceTableCatalog;
}

export interface EvalContext {
  readonly callee: string;
  readonly span: Span;
  /** Input paths read by each argument (for error messages). */
  readonly argPaths: readonly (readonly string[])[];
  /** The exact value of a quantity expressed in `target` (a rational; the conversion is recorded). */
  exact(q: QuantityValue, target: Unit): Rational;
  /** Rounds an exact result once to 34 significant digits. */
  result(r: Rational, unit: Unit, tag: Tag | null): QuantityValue;
  /** Converts a quantity to `target` (absolute temperatures included; the conversion is recorded). */
  convert(q: QuantityValue, target: Unit): QuantityValue;
  domain(message: string, argIndex?: number): never;
  divisionByZero(message: string, argIndex?: number): never;
  emptySeries(argIndex: number): never;
  /** Acceptance-table lookup (recorded with table id, version and row). */
  lookup(tableId: string, key: QuantityValue): QuantityValue;
}

export interface LibraryFunction {
  readonly name: string;
  /** e.g. "assay_as_is_dried(assay: % w/w, lod: % LOD) -> % w/w". */
  readonly signature: string;
  /** Plain-language description. */
  readonly summary: string;
  /** Where the formula comes from (design spec section, worked example). */
  readonly reference: string;
  check(args: readonly ArgInfo[], ctx: CheckContext): ExprType;
  /** Static upper bound of the evaluation cost (series lengths at their declared maximum). */
  cost(args: readonly ArgInfo[]): number;
  evaluate(args: readonly RuntimeValue[], ctx: EvalContext): RuntimeValue;
}
