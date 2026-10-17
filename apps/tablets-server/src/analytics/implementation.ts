/**
 * What the runner needs to run a method (ADR 0020 point 1): the method of @ebmr/analytics, the catalogued inputs it
 * reads and how the rows of those inputs become the method's input. Each method slice (6A-2 to 6A-6) adds its
 * implementations to IMPLEMENTATIONS in its own file under this folder; slice 6A-1 has none, so the runner runs nothing
 * until a slice adds a method and QA makes a version of it EFFECTIVE under a change record (D-6A-1-10).
 */
import type { AuditBaselineParameters, AuditInput, AuditRulesParameters, Method, MethodId, Parameters, ReviewInput, ReviewPriorityParameters } from '@ebmr/analytics';
import { ATA_BASELINE_IMPLEMENTATION, ATA_RULES_IMPLEMENTATION } from './audit.ts';
import { REVIEW_PRIORITY_IMPLEMENTATION } from './review.ts';
import { SPC_IMPLEMENTATIONS } from './spc.ts';

/** One row of an input view: the view's columns, as text, booleans, integers, arrays or JSON (never a Date). */
export type InputRow = Readonly<Record<string, unknown>>;

/** A catalogued input a method reads (analytics.input_catalog_v1), optionally filtered on equal column values. */
export interface InputSpec {
  /** report.<name>_v<n>, as catalogued. */
  readonly view: string;
  readonly version: number;
  /** Column = value conditions (null: every row). */
  readonly filter: Readonly<Record<string, string | number | boolean>> | null;
}

export interface MethodImplementation<I = unknown, P extends Parameters = Parameters> {
  readonly id: MethodId;
  /** The method versions this code implements (a method_version row of another version is not run). */
  readonly versions: readonly number[];
  readonly inputs: readonly InputSpec[];
  /** The method's input from the rows of each input (keyed by view name), in their canonical order. */
  assemble(rows: Readonly<Record<string, readonly InputRow[]>>, params: P): I;
  readonly method: Method<I, P>;
}

/** An implementation as the runner holds it (each is typed by its own input and parameters where it is written). */
export function implementation<I, P extends Parameters>(impl: MethodImplementation<I, P>): MethodImplementation {
  return impl;
}

/** The implementations of the running code. Slice 6A-1 has none (D-6A-1-10); each method slice adds its own line. */
export const IMPLEMENTATIONS: readonly MethodImplementation[] = [
  // Slice 6A-4: the audit-trail methods (audit.ts).
  implementation<AuditInput, AuditRulesParameters>(ATA_RULES_IMPLEMENTATION),
  implementation<AuditInput, AuditBaselineParameters>(ATA_BASELINE_IMPLEMENTATION),
  ...SPC_IMPLEMENTATIONS, // 6A-2 (spc.ts)
  // Slice 6A-5: the review priority (review.ts).
  implementation<ReviewInput, ReviewPriorityParameters>(REVIEW_PRIORITY_IMPLEMENTATION),
];
