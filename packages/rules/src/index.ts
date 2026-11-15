/** GMP entry rules written once (ADR 0023): the vocabulary, the TypeScript interpreter and the library's rules. */
export const PACKAGE = { name: '@ebmr/rules', version: '0.1.0' } as const;
export * from './vocabulary.ts';
export { ABSENT, evaluate, fieldRuleRaise, holds, type Inputs, type Json, type Value } from './interpret.ts';
export { FIELD_SHOWN, UNEXPECTED_ANSWER } from './library.ts';
