/**
 * What the runner needs to run a method (ADR 0020 point 1): the method of @ebmr/analytics, the catalogued inputs it
 * reads and how the rows of those inputs become the method's input. Each method slice (6A-2 to 6A-6) adds its
 * implementations to IMPLEMENTATIONS in its own file under this folder; slice 6A-1 has none, so the runner runs nothing
 * until a slice adds a method and QA makes a version of it EFFECTIVE under a change record (D-6A-1-10).
 */
import type { Method, MethodId, Parameters } from '@ebmr/analytics';
import { GOLDEN_PROFILE } from './profile.ts';

/** One row of an input view: the view's columns, as text, booleans, integers, arrays or JSON (never a Date). */
export type InputRow = Readonly<Record<string, unknown>>;

/** A catalogued input a method reads (analytics.input_catalog_v1), optionally filtered on equal column values. */
export interface InputSpec {
  /** report.<name>_v<n>, as catalogued; a row function (with `call`) by its catalogued signature. */
  readonly view: string;
  readonly version: number;
  /** Column = value conditions (null: every row). */
  readonly filter: Readonly<Record<string, string | number | boolean>> | null;
  /**
   * A parameterised row function (a FUNCTION input, D-6A-0-2; slice 6A-6): called once per row of the view input
   * `from`, read in the same snapshot before it, with that row's `args` columns as its arguments; each row it returns
   * carries those columns too, under their own names.
   */
  readonly call?: { readonly from: string; readonly args: readonly string[] };
}

/** A reference set in force, as the method's reference view gives it (slice 6A-6). */
export interface ReferenceRow {
  readonly id: string;
  readonly method: string;
  readonly scope: Readonly<Record<string, unknown>>;
  readonly batchIds: readonly string[];
  readonly model: Readonly<Record<string, unknown>>;
  readonly modelSha256: string;
}

export interface MethodImplementation<I = unknown, P extends Parameters = Parameters> {
  readonly id: MethodId;
  /** The method versions this code implements (a method_version row of another version is not run). */
  readonly versions: readonly number[];
  readonly inputs: readonly InputSpec[];
  /** The method's input from the rows of each input (keyed by view name), in their canonical order. */
  assemble(rows: Readonly<Record<string, readonly InputRow[]>>, params: P): I;
  readonly method: Method<I, P>;
  /**
   * The catalogued view of this method's reference sets in force (slice 6A-6). With it the runner runs a version once
   * without a reference set (model candidates) and once per reference set the view gives, after checking the set's
   * model against its SHA-256 and `referenceProblems`.
   */
  readonly references?: InputSpec;
  /** The inputs of a run with reference set `ref` (default: `inputs`), for example narrowed to the set's scope. */
  inputsFor?(ref: ReferenceRow): readonly InputSpec[];
  /** Why reference set `ref` cannot be scored by this code (empty: it can); a non-empty list fails that run. */
  referenceProblems?(ref: ReferenceRow): readonly string[];
}

/** An implementation as the runner holds it (each is typed by its own input and parameters where it is written). */
export function implementation<I, P extends Parameters>(impl: MethodImplementation<I, P>): MethodImplementation {
  return impl;
}

/** The implementations of the running code. Slice 6A-1 has none (D-6A-1-10); each method slice adds its own line. */
export const IMPLEMENTATIONS: readonly MethodImplementation[] = [
  GOLDEN_PROFILE, // 6A-6
];
