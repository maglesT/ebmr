/**
 * Runtime values. Quantities hold a Dec (never a JavaScript number) with its unit and tag.
 */
import type { Dec } from '../decimal/dec.ts';
import type { Tag } from '../units/tags.ts';
import type { Unit } from '../units/unit.ts';

export interface QuantityValue {
  readonly kind: 'quantity';
  readonly value: Dec;
  readonly unit: Unit;
  readonly tag: Tag | null;
}

export interface SeriesValue {
  readonly kind: 'series';
  readonly values: readonly Dec[];
  readonly unit: Unit;
  readonly tag: Tag | null;
}

export interface InstantValue {
  readonly kind: 'instant';
  /** Microseconds since 1970-01-01T00:00:00Z (PostgreSQL timestamptz precision). */
  readonly epochMicros: bigint;
  readonly text: string;
}

export type RuntimeValue =
  | QuantityValue
  | SeriesValue
  | InstantValue
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'category'; readonly value: string }
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'unit'; readonly unit: Unit };

export function quantity(value: Dec, unit: Unit, tag: Tag | null): QuantityValue {
  return { kind: 'quantity', value, unit, tag };
}
