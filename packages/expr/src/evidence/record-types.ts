/**
 * The evaluation record: evidence stored with every calculation result (DI-33: inputs, formula
 * version, units and conversion factors, and the result; ADR 0005 decision 8). Plain JSON; decimals
 * are canonical decimal strings. The content hash is SHA-256 over the canonical JSON of the record
 * without the hash itself (kernel canonical-JSON rules).
 */
import type { Tag } from '../units/tags.ts';

export interface RecordedInput {
  readonly path: string;
  readonly kind: 'quantity' | 'series' | 'instant' | 'boolean' | 'category' | 'text';
  /** Where the value came from (entry, device reading, LIMS result, master data). */
  readonly source: string;
  /** Canonical decimal, instant text, "true"/"false", category or text. */
  readonly value?: string;
  /** Series values (canonical decimals). */
  readonly values?: readonly string[];
  /** Unit the value was provided in. */
  readonly unit?: string;
  readonly tag?: Tag;
  /** DERIVED inputs: content hash of the evaluation record that computed the value (INV-25). */
  readonly derivedFrom?: string;
}

export interface RecordedConversion {
  /** Where it happened: "input <path>", "<operator> at <start>-<end>", "<function>()", "output". */
  readonly at: string;
  readonly from: string;
  readonly to: string;
  /** Exact factor (terminating decimal or "num/den"). */
  readonly factor: string;
  readonly fromOffset?: string;
  readonly toOffset?: string;
  /** False when the converted value was rounded to 34 significant digits. */
  readonly exact: boolean;
}

export interface RecordedTableLookup {
  readonly table: string;
  readonly version: string;
  /** Row number, starting at 1. */
  readonly row: number;
  readonly key: string;
  readonly keyUnit: string;
  readonly result: string;
  readonly resultUnit: string;
}

export interface RecordedOutput {
  readonly kind: 'quantity' | 'boolean';
  /** Full precision (never rounded for storage). */
  readonly value: string;
  readonly unit?: string;
  readonly tag?: Tag;
}

export interface RecordedCorrection {
  readonly path: string;
  readonly previous: RecordedInput | null;
  readonly corrected: RecordedInput;
}

export interface Supersedes {
  /** Content hash of the earlier result, which stays in the record unchanged. */
  readonly contentHash: string;
  readonly reason: string;
  readonly corrections: readonly RecordedCorrection[];
}

export interface EvaluationRecord {
  readonly schema: string;
  readonly languageVersion: string;
  readonly unitTable: { readonly version: string; readonly ucumLhc: string };
  /** Name of the calculation in the MBR, when given. */
  readonly calculation?: string;
  /** Expression text as authored. */
  readonly expression: string;
  /** Canonical printed form. */
  readonly canonical: string;
  /** Hash of the compiled program (language version, canonical text, declarations, output, tables). */
  readonly programHash: string;
  /** Every input the evaluation read, sorted by path. */
  readonly inputs: readonly RecordedInput[];
  readonly conversions: readonly RecordedConversion[];
  readonly tableLookups: readonly RecordedTableLookup[];
  readonly output: RecordedOutput;
  readonly supersedes?: Supersedes;
  readonly contentHash: string;
}
