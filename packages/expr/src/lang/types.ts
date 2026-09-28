/**
 * Static types of the expression language, the input declarations a calculation makes, and the
 * declared output. Declarations are plain JSON-friendly data (they live in the MBR).
 */
import type { Tag } from '../units/tags.ts';
import type { Unit } from '../units/unit.ts';

export interface QuantityType {
  readonly kind: 'quantity';
  readonly unit: Unit;
  /** null = a tag-neutral literal constant (takes the tag of the other operand). */
  readonly tag: Tag | null;
}

export interface SeriesType {
  readonly kind: 'series';
  readonly element: QuantityType;
  /** Declared maximum number of values (bounds the static cost). */
  readonly maxLength: number;
}

export type ExprType =
  | QuantityType
  | SeriesType
  | { readonly kind: 'boolean' }
  | { readonly kind: 'string' }
  | { readonly kind: 'category'; readonly values: readonly string[] }
  | { readonly kind: 'text' }
  | { readonly kind: 'instant' }
  | { readonly kind: 'unit'; readonly unit: Unit };

/** Where a declared input comes from (INV-25: DERIVED inputs are computed, never typed). */
export type InputSource = 'CAPTURED' | 'DEVICE' | 'LIMS' | 'MASTER_DATA' | 'DERIVED';

/** Declaration of one input an expression may read (JSON-friendly). */
export interface InputDeclaration {
  /** Default 'quantity'. */
  readonly kind?: 'quantity' | 'series' | 'instant' | 'boolean' | 'category' | 'text';
  /** UCUM code; required for quantity and series. "1" for plain numbers and counts. */
  readonly unit?: string;
  /** Semantic tag; default 'none'. */
  readonly tag?: Tag;
  /** series: maximum number of recorded values (1..100000). */
  readonly maxLength?: number;
  /** category: the allowed values. */
  readonly values?: readonly string[];
  /** Default 'CAPTURED'. */
  readonly source?: InputSource;
  /** Plain-language description for reviewers and test vectors. */
  readonly description?: string;
}

export type InputDeclarations = Readonly<Record<string, InputDeclaration>>;

/** Declared result of a calculation. */
export interface OutputDeclaration {
  /** Default 'quantity'. */
  readonly kind?: 'quantity' | 'boolean';
  /** UCUM code the result is converted to (exactly) and stored in. */
  readonly unit?: string;
  readonly tag?: Tag;
}

export const MAX_SERIES_LENGTH = 100_000;
