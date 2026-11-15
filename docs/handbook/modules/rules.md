# GMP entry rules written once (`packages/rules`)

**Draft** (14 November 2026). ADR 0023.

`@ebmr/rules` holds the GMP rules on a batch-record entry written once, as data, instead of twice by hand (once in the
recipe-core engine, once in a PostgreSQL guard). A rule is a small typed tree (the vocabulary) whose every node has one
meaning, stated in SQL terms. The TypeScript interpreter evaluates it; the generator writes it as plain, committed SQL
(`recipe.rule_<name>`), and a conformance suite runs the same cases through PostgreSQL 16. Until a rule family is
switched over (ADR 0023 decision 5) the hand-written copies stay in force: no guard calls a generated function yet.
Read this page before you add or change a rule there.

## Where the code is

| What | Where |
|---|---|
| The vocabulary (nodes, predicates, field rules) | [src/vocabulary.ts](../../../packages/rules/src/vocabulary.ts) |
| The TypeScript interpreter | [src/interpret.ts](../../../packages/rules/src/interpret.ts) |
| The library rules (visibility, expected answers) | [src/library.ts](../../../packages/rules/src/library.ts) |
| The definitions the generator writes, with their source files | [src/catalog.ts](../../../packages/rules/src/catalog.ts) |
| The SQL backend: a tree as one expression | [src/generate/compile.ts](../../../packages/rules/src/generate/compile.ts) |
| The SQL primitives (key, membership, decimal) | [src/generate/primitives.ts](../../../packages/rules/src/generate/primitives.ts) |
| The generated blocks and migration text | [src/generate/emit.ts](../../../packages/rules/src/generate/emit.ts) |
| `rules:check` and the next migration | [src/generate/migrations.ts](../../../packages/rules/src/generate/migrations.ts) |
| The conformance suite (interpreter against PostgreSQL 16) | [test/conformance.test.ts](../../../packages/rules/test/conformance.test.ts) |
| Tests | [test/](../../../packages/rules/test) |

## Rules of the package

- It imports only `@ebmr/expr` (its exact decimals); a boundary rule checks it.
- A value is a JSON value or ABSENT (a key that is not there: SQL NULL); decimals are compared exactly, never as
  JavaScript numbers; nothing reads a clock, a sequence or a session.

## The generator

- `pnpm rules:generate [--number N] [--slug S]` writes the blocks whose output differs from the latest committed one as
  a new recipe-core migration, `NNNN_rules_<slug>.sql` (one above the highest number unless `--number` is given; take a
  number no open branch uses). It never edits an existing migration; nothing to write is not an error.
- Each block sits between `-- @ebmr/rules begin <function>` and `-- @ebmr/rules end <function>`. Its header names the
  generator's version, the source file and export, the definition's name and version, and the sha256 of the definition
  as canonical JSON (a primitive: of its body). The output is deterministic: blocks in a fixed order (the primitives,
  then the definitions by function name), object keys sorted, nothing from the clock or the machine.
- `pnpm rules:check` (in the static checks and `pnpm run ci`) fails when the latest committed block of a generated
  function differs from the generator's output, when one is missing, when a migration defines a generated function (or
  any `recipe.rules_` primitive) outside its markers, when a marker is broken, and when a committed block has no
  definition any more. The header lines outside the blocks may be edited before a migration is first applied.
- A predicate becomes `recipe.rule_<name>(<inputs> jsonb...) returns boolean`; a field rule becomes
  `recipe.rule_<name>("field" jsonb, "values" jsonb, "config" jsonb) returns jsonb`, the required exception's facts or
  NULL. Both are `language sql immutable`, owned by `ebmr_owner`, with no grant to the application role.

## The conformance suite

`test/conformance.test.ts` runs on a copy of the test template, so it tests the committed SQL. It holds named cases
with the answer PostgreSQL gave pinned beside them, a fixed-seed random corpus of 2,500 trees over awkward values, and
the two library rules through their generated functions on corpora of fields and entries. Any difference fails it.
The domain is the application's: an input is a JavaScript value and the database receives its `JSON.stringify` (so a
JSON number is the shortest form of a double; jsonb refuses a NUL or a lone surrogate, and the generator refuses them in
a literal). Points it settles, each with its case:

- a key reaches into an object only; arrays are not indexed, and a computed key that is not a string is no key;
- membership is element equality, not `@>` containment;
- a decimal is a JSON number or a string `Dec.parse` accepts (at most 400 characters, 34 significant digits, a leading
  digit at 10^-1000 to 10^1000); anything else is no decimal, so an order comparison is false, never an error. A rule
  that must refuse a value that is not a decimal says so itself.

## Mutation testing

`pnpm mutation:rules` runs Stryker on `packages/rules/src` (the command-line wrapper aside) with the package's tests,
the conformance suite included. Decision 0032's rule holds: no surviving mutant (break threshold 100); an equivalent
mutant is disabled at its line with a comment saying why.
