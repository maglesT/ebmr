# ADR 0023: One rule definition, two generated enforcers

- **Status:** Accepted by the lead (14 November 2026), with the four additions in decisions 9 to 12; the owner may
  veto. Proposed by session 19.
- **Context documents:** `docs/reviews/2026-11-build-speed.md`; decision 0008 section 2 (database enforcement of the
  regulation-required core); ADR 0006 (server-authoritative execution); ADR 0005 (the expression language).

## Context

Every GMP rule on an entry is written twice by hand: once in TypeScript (the engine and the validator in recipe-core),
once in PL/pgSQL (the database guard that refuses what the application must never store). The build-speed review
measured the cost:
- 247 of 700 migrations (43 % of all SQL lines) say they reproduce a TypeScript rule;
- 89 of 250 merges change SQL and TypeScript together;
- 451 database functions were redefined 696 times, each time as a full copy.

Each copy is designed, tested and reviewed on its own, and then reviewed again for agreement. Recipe-core 1862 is the
pattern: 420 lines so that the database judges a library block's values "as the generic handler does"
(`library/block-version.ts`), covering limit tiers, statistics, timer durations and loop exits. Reviews found five gaps
in the earlier copy (R3-SQL-1 to 5).

While preparing this record, two differences of the same kind turned up. Neither is verified as a defect; both are
reported to the lead and not fixed here:
- **Visibility.** The engine decides whether a field is shown (`showWhen`) from the raw submission (`shown(f, entry)`).
  The guard decides it from the stored data (`e -> 'data'`).
- **Expected answers.** The engine raises `LIB_UNEXPECTED_ANSWER` for a yes/no field answered against its expected
  answer. No migration on main requires that exception (#261 adds it). The guard uses the expected answer only to decide
  a loop's pass.

The database must keep enforcing the regulation-required core. Decision 0008 section 2 requires it, and it is what
makes a bypass of the application harmless. So the fix is not to drop one copy. It is to stop writing the two copies
by hand.

## Decision

1. **A rule is written once, as data.** A new package, `packages/rules`, imports only `@ebmr/expr` (for its exact
   decimals; a boundary rule checks it). It holds each rule as a declarative definition, a typed tree in a small vocabulary:
   - **Inputs:** paths into the block definition, the formulation's configuration and the entry (fields, sections,
     slots, limits, points).
   - **Operations:** exact decimal comparison at a stated scale; the duration between two recorded times (a timer's
     start and stop, in the field's unit); boolean logic; membership; iteration over fields,
     sections, statistics and points; the statistics of ADR 0005 that both sides can compute exactly (readings,
     minimum, maximum, mean, range).
   - **Outputs:** the set of exceptions the entry requires, each with its facts (type, tier, severity, category,
     consequences), or a refusal code.

   Nothing in it reads a clock, a sequence or a session; those stay outside it.
2. **Two backends, one semantics.**
   - **TypeScript:** an interpreter in `packages/rules` evaluates a definition. The engine and the validator call it in
     place of their hand-written loops.
   - **SQL:** a generator emits plain SQL and PL/pgSQL functions, one per rule (`recipe.rule_<name>`), with a comment
     naming the source definition and its hash. The existing guard functions call them, so the triggers and every
     refusal code stay as they are.
   - **Primitives:** each primitive of the vocabulary is implemented twice, once per backend, and proven equal by a
     shared conformance suite. The suite runs the same cases through the interpreter and through PostgreSQL 16 (the
     `postgres-oracle` skill). So the duplication shrinks from every rule to about twenty primitives, and those are
     tested against each other mechanically.
3. **The generated SQL is ordinary, committed SQL.**
   - `pnpm rules:generate` writes a new migration whenever a definition's output changes, under the package's normal
     numbering. It never edits an existing migration.
   - CI's `rules:check` (a static check) regenerates every rule and fails if the latest committed definition of any
     generated function differs from the generator's output.
   - The database therefore keeps plain, auditable SQL, written to a template that a reviewer reads like any other
     migration.
4. **Engine-only judgements stay explicit.** A judgement PostgreSQL cannot make exactly stays the engine's, and the
   definition says so; it is never silently left out. Today the only one is RSD, which needs a square root at the
   engine's precision. The guard keeps today's treatment: the engine's exception is admitted when its facts are those
   of a tier.
5. **No family is switched over until it is proven no weaker.** For each rule family, before the generated function
   replaces a hand-written guard in a new migration:
   - **(a) Same results.** Old and new give the same result, row for row, on the full seeded corpus (the golden
     batches, the demo and end-to-end seeds, every database test's entries) and on the bypass tests: zero differences.
     A differential harness runs both functions on every entry.
   - **(b) Same tests.** Every control-ID test of the family passes unchanged.
   - **(c) Mutation score.** The SQL mutation score of the generated functions meets or beats the old guard's, with no
     new survivor (decision 0032's rule).

   A difference found in (a) is a finding. It is decided on its merits (which copy was right) and recorded. It is never
   resolved by weakening either side. Database enforcement of the regulation-required core stays: the guard and its
   trigger are kept, and only their body is generated.
6. **Order of migration: most drift first.**
   - **6.1 Field visibility (`showWhen`).** Smallest, and already differs as noted above.
   - **6.2 Expected answers and choices that are not allowed.** This closes the expected-answer gap above, as its own
     finding.
   - **6.3 Limits.** Tiers for numbers, weighings and calculated figures; test-result statistics, per-point limits and
     timer durations.
   - **6.4 Loops.** Until-pass, repeats and exhaustion.

   Each family is one small PR. Other families (equipment status, IPC rounds, release gates) follow only if the first
   four show the gain.
7. **What stays hand-written.** The kernel's audit trail, e-signatures, access, sealing and time. They are not
   implemented twice; they change rarely; and their SQL is the design itself, not a copy of an engine rule.
8. **Library blocks become versioned, never edited in place.**
   - Today all 164 seed blocks are version 1, and the seed changed in place in 30 merges. Each change reached every
     master, golden batch and E2E flow built on the block.
   - From the first family PR on, the content hash of each block version that has been released is recorded in
     `packages/recipe-core/src/library/seed/versions.lock.json`. A CI check fails when a recorded version's definition
     changes.
   - A change is a new version (v2) beside the old one. Masters keep the version they were approved with (they already
     pin code, version and content hash). Moving a product to v2 is a master revision through change control, as for
     any other change.
   - The first lock records today's v1 hashes as they are.

9. **The generator and the interpreter are qualified tools.** They produce GMP enforcement, so:
   - every generated function's header names the `packages/rules` version and the definition's hash;
   - Stryker runs on `packages/rules` with decision 0032's rule (no new surviving mutant), beside the SQL mutation
     harness on the generated functions;
   - a "generator qualification" item (GAMP 5: the tool's intended use, its risk and its verification) is recorded as
     deployment work, at the timing decision 0008 sets for validation-grade evidence.
10. **Generation is deterministic.** The same definitions give the same bytes: keys and clauses in a fixed, sorted
    order, and no timestamps, absolute paths, machine names or random identifiers in the output. `rules:check` proves it
    by regenerating in CI and comparing byte for byte.
11. **Family 6.1 waits for the hand-written hidden-field guard.** The visibility family moves only after session 18's
    hand-written hidden-field PR (recipe-core 1928) has merged. Its differential harness then compares the generated
    function with that guard as well.
12. **The first library lock is not a release baseline.** Today's v1 hashes include the in-place edits of the I-6
    work. The lock file's header says so: it records the state at the point the lock was introduced, not versions
    released as validated.

## Consequences

- **Gains.**
  - A rule change is made once.
  - The agreement between engine and database is proven by construction plus the conformance suite, not by review.
  - The 696-redefinition pattern shrinks to a regenerated function body.
  - Drift of the kind above cannot recur within a migrated family.
- **Costs.**
  - A new package: the vocabulary, the interpreter, the generator and the conformance suite. That is roughly 2,000 to
    3,000 lines plus tests, built before the first family moves.
  - A differential harness for criterion 5 (a).
  - One PR per family.
  - Reviewers learn the vocabulary.
- **Generated SQL must stay readable.** It is set out one statement per rule clause, with the definition's names. A
  generator change that would rewrite every function is a change of its own, gated like a family switch-over.
- **Library versions.** Block fixes stop rippling through every flow. A product that wants a fix takes it through a
  revision. Demo seeds and E2E flows pin versions explicitly.
- **Unchanged.** Refusal codes, triggers, control-ID tests, the trace and validation evidence. Generated SQL is
  migrations like any other, so the database's history stays the record.

## Alternatives considered

- **The database only.** The engine would ask the database for every judgement. Rejected: the validator and the
  simulator run without a database, and the designer checks a master before any entry exists.
- **The application only.** Rejected: the database would trust the application, against decision 0008 section 2.
- **JavaScript inside PostgreSQL (plv8).** One implementation in both places. Rejected for three reasons:
  - customers' managed PostgreSQL 16 often lacks the extension;
  - the guard would no longer be plain, auditable SQL;
  - decimal semantics would depend on a JavaScript library inside the server.
- **Generating TypeScript from hand-written SQL.** Rejected: SQL is the harder language in which to state the rules,
  and the engine needs them before an entry is stored.
- **Keeping two copies, with a differential harness only.** This is the cheaper step, and part of it is criterion 5
  (a). Rejected as the end state: the cost of writing each rule twice remains.
