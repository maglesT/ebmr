/** GMP entry rules written once (ADR 0023): the vocabulary, the TypeScript interpreter and the library's rules. */
export { PACKAGE } from './version.ts';
export * from './vocabulary.ts';
export { ABSENT, evaluate, fieldRuleRaise, holds, type Inputs, type Json, type Value } from './interpret.ts';
export { FIELD_SHOWN, UNEXPECTED_ANSWER } from './library.ts';
export { CATALOG, FIELD_RULE_INPUTS, type CatalogEntry, type Definition } from './catalog.ts';
