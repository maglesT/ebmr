/**
 * The definitions the SQL generator writes (ADR 0023, decision 2): each with the file it is written in, so a generated
 * function's header names its source. A definition joins this list when its SQL function is wanted in the database;
 * it replaces a hand-written guard only in a family switch-over (ADR 0023, decision 5), never by being listed here.
 */
import { FIELD_SHOWN, UNEXPECTED_ANSWER } from './library.ts';
import type { FieldRule, Predicate } from './vocabulary.ts';

export type Definition = { kind: 'predicate'; def: Predicate } | { kind: 'field-rule'; def: FieldRule };

export interface CatalogEntry {
  /** The file the definition is written in, relative to the repository root. */
  readonly source: string;
  /** The exported name of the definition in that file. */
  readonly exportName: string;
  readonly definition: Definition;
}

export const CATALOG: readonly CatalogEntry[] = [
  { source: 'packages/rules/src/library.ts', exportName: 'FIELD_SHOWN', definition: { kind: 'predicate', def: FIELD_SHOWN } },
  { source: 'packages/rules/src/library.ts', exportName: 'UNEXPECTED_ANSWER', definition: { kind: 'field-rule', def: UNEXPECTED_ANSWER } },
];

/** The inputs of every field rule, in the order of its SQL function's parameters. */
export const FIELD_RULE_INPUTS = ['field', 'values', 'config'] as const;
