/**
 * A method and its versions (interfaces slice-6A-0-interfaces.md section 1; ADR 0020 point 6). A method is a pure
 * function of its input, its parameters and its reference model: it reads no clock, uses no randomness and does no
 * I/O, so a re-run on the same inputs reproduces it (D-6A-22).
 */
import type { FlagDraft, OutputDraft } from './types.ts';

/** The method ids of v1 (interfaces section 4). */
export type MethodId =
  | 'SPC.IMR'
  | 'SPC.XBAR_S'
  | 'CAP.INDEX'
  | 'DRIFT.TREND'
  | 'RATE.DEVIATION'
  | 'MSPC.PCA'
  | 'ATA.RULES'
  | 'ATA.BASELINE'
  | 'REVIEW.PRIORITY'
  | 'GBP.DTW_BAND';

export const METHOD_IDS: readonly MethodId[] = [
  'SPC.IMR', 'SPC.XBAR_S', 'CAP.INDEX', 'DRIFT.TREND', 'RATE.DEVIATION', 'MSPC.PCA', 'ATA.RULES', 'ATA.BASELINE', 'REVIEW.PRIORITY', 'GBP.DTW_BAND',
];

/** A parameter value of a method version (a row of analytics.method_version holds them as JSON). */
export type ParameterValue = number | boolean | string | readonly number[] | readonly string[] | Readonly<Record<string, number>>;
export type Parameters = Readonly<Record<string, ParameterValue>>;

/** One version of a method, as analytics.method_version records it. */
export interface MethodVersion<P extends Parameters = Parameters> {
  readonly id: MethodId;
  readonly version: number;
  readonly parameters: P;
  /** SHA-256 (hex) of the canonical text of the parameters (canonicalText). */
  readonly parametersSha256: string;
}

/** A QA-approved reference model (analytics.reference_set), or null when the method runs without one. */
export interface ReferenceModel {
  readonly id: string;
  readonly method: MethodId;
  readonly model: Readonly<Record<string, unknown>>;
  /** SHA-256 (hex) of the canonical text of the model; equal to its candidate's (EBMR-ANA-010). */
  readonly modelSha256: string;
}

/** A subject a method could not assess, with the reason (shown, never silently dropped). */
export interface Skipped {
  readonly subject: string;
  readonly reason: string;
}

export interface MethodResult {
  readonly outputs: readonly OutputDraft[];
  readonly flags: readonly FlagDraft[];
  readonly skipped: readonly Skipped[];
}

export interface Method<I, P extends Parameters> {
  readonly id: MethodId;
  /** The versions this code implements. */
  readonly versions: readonly number[];
  run(input: I, params: P, ref: ReferenceModel | null): MethodResult;
}
