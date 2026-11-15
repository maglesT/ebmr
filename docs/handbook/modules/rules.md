# GMP entry rules written once (`packages/rules`)

**Draft** (14 November 2026). ADR 0023.

`@ebmr/rules` holds the GMP rules on a batch-record entry written once, as data, instead of twice by hand (once in the
recipe-core engine, once in a PostgreSQL guard). A rule is a small typed tree (the vocabulary) whose every node has one
meaning, stated in SQL terms. The TypeScript interpreter evaluates it; a later PR adds the generator that writes it as
plain, committed SQL, and a conformance suite that runs the same cases through PostgreSQL 16. Until a rule family is
switched over (ADR 0023 decision 5) the hand-written copies stay in force. Read this page before you add or change a
rule there.

## Where the code is

| What | Where |
|---|---|
| The vocabulary (nodes, predicates, field rules) | [src/vocabulary.ts](../../../packages/rules/src/vocabulary.ts) |
| The TypeScript interpreter | [src/interpret.ts](../../../packages/rules/src/interpret.ts) |
| The library rules (visibility, expected answers) | [src/library.ts](../../../packages/rules/src/library.ts) |
| Tests | [test/](../../../packages/rules/test) |

## Rules of the package

- It imports only `@ebmr/expr` (its exact decimals); a boundary rule checks it.
- A value is a JSON value or ABSENT (a key that is not there: SQL NULL); decimals are compared exactly, never as
  JavaScript numbers; nothing reads a clock, a sequence or a session.
