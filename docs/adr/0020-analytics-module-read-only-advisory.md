# ADR-0020: The analytics module: a pure package, a read-only runner role and an advisory output schema

- **Status:** Accepted (2026-10-17)
- **Deciders:** the lead, in the Phase 6A plan (decision 0023). The owner's rule: take the decision and record it.
- **Supersedes:** none

## Context

- Decision 0015 sets the rules for analytics. Analytics is advisory only and lives in a separate, read-only module.
  Its outputs are versioned and validated, statistics come first, and QA's feedback is stored. Decision 0016 picks
  the features, and decision 0023 builds items 1, 2, 3, 8, 9 and 10 now, as Phase 6A.
- Phase 6 left the inputs ready. Slice 6g added the `report` views and the role `ebmr_report`, which can only SELECT;
  a database test proves it cannot write. Slice 6b added the native series `plant.series`.
- Statistics need floating point. CLAUDE.md forbids a JavaScript `number` for GMP values in domain code. Every GMP value
  in the repository is exact decimal text, or the expression language's decimal type (ADR 0005).
- Analytics has to write its own outputs: runs, scores, flags and QA's dispositions. `ebmr_report` can write nothing,
  and loosening it would weaken a property that is already proven.

## Decision

1. **Where it lives.**
   - `packages/analytics` (`@ebmr/analytics`, pinned `workspace:0.1.0` by the tablets server; ADR 0015) holds pure
     computation only: statistics, methods, the method registry and canonical output hashing. It imports nothing in
     the repository, no database driver and no node core module.
   - The tablets server has two parts. The **runner** `apps/tablets-server/src/analytics/` reads inputs through its own
     pool as `ebmr_analytics`, calls the package and records the outputs. The **feature**
     `apps/tablets-server/src/features/analytics/` serves the `analytics*` routes to the screens through the app role.
2. **Dependency-cruiser rules** (each proven on a fixture in `tools/boundaries`, as today):
   - `analytics-is-self-contained`: the package reaches no `packages/`, `apps/` or `tools/` path, no database driver
     and no node core module. Of the external packages it may import only `ml-matrix` and `@stdlib/`.
   - `analytics-only-from-runner`: only the runner and tests import `@ebmr/analytics`.
   - `analytics-runner-no-gmp-path`: the runner never imports `features/`, `platform/db/commands.ts`, the kernel,
     site-services, recipe-core or integration-sdk.
   - `no-gmp-feature-imports-analytics`: no other server feature imports the runner or the feature. The review queue
     reads the priority through a database view (point 4), not through code.
3. **How it reads: a dedicated role `ebmr_analytics`, never a writer of GMP data.**
   - The role is LOGIN, NOINHERIT and a member of nothing.
   - It may CONNECT to GMP databases only; it has USAGE on `report` and `analytics`.
   - It may SELECT the `report` views on the allow-list `analytics.input_catalog_v1`, and EXECUTE the analytics record
     functions and the parameterised input functions (`report.series_samples_v1`).
   - It holds no other privilege: no table in any GMP schema, no command function, no default privilege.
   - `sandbox.segregation_problems()` is extended to report any extra grant, as it does for `ebmr_report`. A bypass test
     on the model of 6g's proves that the role cannot insert, update or delete in any other schema, cannot run a
     command and cannot reach a volatile GMP function.
   - In v1 the runner reads the primary in a REPEATABLE READ READ ONLY transaction, so one run sees one snapshot. It
     records that snapshot's `data_as_of`. The read connection may point at a replica; writes always go to the primary.
   - We chose a new role over `ebmr_report` because that role must stay unable to write anything.
4. **Where outputs go: the schema `analytics` (kernel), non-GMP, insert-only and audited.**
   - Method versions and reference sets are configuration under change control (point 6).
   - Runs record the method version, the reference set and every input: view, version, filter, `data_as_of`, row count
     and the SHA-256 of the canonical input rows. They also record the runtime: package version, commit, Node and
     library versions.
   - Outputs and flags carry their reasons. QA's dispositions sit beside them.
   - Every table is registered with the kernel's hash-chained audit trail (ADR 0007) and refuses UPDATE and DELETE.
   - The app role SELECTs only the `analytics.*_v1` read views. Flags about a person are readable only through a
     definer function that checks `ANALYTICS.DI_REVIEW`.
   - Database tests prove that no GMP table has a foreign key into `analytics`, and that no function, view or trigger
     outside `analytics` and the read views depends on it (pg_depend plus a scan of function bodies). The review,
     release and signature functions therefore cannot read a score.
5. **Numbers.**
   - The rule: inside `packages/analytics` and the runner, a JavaScript `number` (IEEE 754 double) is allowed for
     statistics. Everywhere else the CLAUDE.md rule stands.
   - GMP values (recorded values, limits, series samples) reach analytics as exact decimal text from the input views.
     One function, `statOf` in `packages/analytics/src/numeric/from-decimal.ts`, converts them. It checks the decimal
     grammar first, and a lint rule bans `Number(`, `parseFloat` and unary `+` on strings elsewhere in the runner.
   - Statistics are stored as `double precision` in `analytics` only. A database test proves that no column of a
     floating type exists outside `analytics` (none exists today).
   - The contract types statistics as `StatNumber` in the `analytics*` namespaces only. Any GMP value a response
     repeats (a recorded value, a limit) is the source's decimal text, unchanged, and a contract test checks this.
   - Screens label every statistic "Advisory, not a GMP value". No statistic ever fills a GMP entry field.
   - No output is ever written back as a GMP value. The runner has no command path (point 2), and its role has no GMP
     privilege (point 3).
   - Re-running a method reproduces it when the flags are identical and the values agree within a relative 1e-9. The
     output hash covers canonical text at 12 significant digits.
6. **Validation hooks.**
   - Every output carries its method id and version, through its run. A method version records what it was approved
     for:
     - intended use and acceptance criteria;
     - parameters and their SHA-256;
     - code identity and a validation reference.
   - Method versions (`ANALYTICS_METHOD`) and QA-approved reference sets with their fitted models
     (`ANALYTICS_REFERENCE`) are configuration areas of slice 6f's change control (DI-09): a row is refused without an
     APPROVED change record. Methods never update themselves. Refitting or retuning produces a new version.
   - QA marks a flag true signal, false alarm or not assessable, with the cause and an optional deviation reference,
     through `analytics.record_disposition`. That call checks the validated actor context (ADR 0016) and the
     permission; the row is insert-only and audited. A real problem goes into the GMP deviation path as usual.
   - A monitoring view gives flag rates and false-alarm rates per method version and month.
7. **Libraries: TypeScript only.**
   - We use `ml-matrix` (MIT) for SVD and eigendecomposition, and the `@stdlib` distribution packages (Apache-2.0) for
     the F, chi-square, beta, t and normal quantiles.
   - Control charts, capability, rate intervals, robust baselines, rules and DTW are written in the package. They are
     tested against published worked examples and against reference values computed offline, stored with the script
     that made them.
   - Versions are pinned exactly in 6A-1 and must be at least two weeks old. Licences go in the SBOM.

## Consequences

- One stack to validate: no second runtime, image, SBOM or patch stream. Validation-pack evidence is the tagged tests.
- The GMP database gains a non-GMP schema and a role. The segregation check and the dependency scan keep them apart,
  and the golden batches run with the runner on and must keep their exact outputs.
- Floating-point results depend on the Node and library versions. Runs record them, and reproduction allows a
  tolerance.
- The machine-learning stage of item 8, and any later model of decision 0015, is a new method under the same hooks.

## Alternatives considered

- **Python sidecar** (NumPy, SciPy, scikit-learn). Rejected for 6A: a second language and runtime to validate, patch and
  ship, against ADR 0003, while 6A needs only linear algebra and distribution quantiles. Revisit with a new ADR if the
  machine-learning stage or decision 0015's Bayesian risk model needs a library TypeScript lacks.
- **`ebmr_report` for analytics** with an extra write grant. Rejected (point 3).
- **A separate analytics database.** Rejected for v1: the audit trail, the change control and the actor context live in
  the edition database, and QA's feedback must sit in that audit trail.
- **In-house distribution quantiles.** Rejected: the numerical risk is high for little code saved. **jStat**: rejected,
  unmaintained since 2022.

## Related controls and invariants

- Controls: draft DI-51 (outputs never change a GMP record), DI-52 (method versions, change control, feedback), DI-53
  (audit-trail flags), PR-61 (review priority never skips); DI-09 (change control), DI-22 and DI-23 (audit of the
  analytics tables), DI-25 and DI-26 (review aids that order but never exclude), PR-60 (AI inventory), PR-09 and PR-58
  (CPV and PQR inputs).
- Invariants: none new.

## References

- Decision records 0015, 0016, 0023; build plan `docs/build-plan/phase-6a/` (plan and slice 6A-0 interfaces).
- ADRs 0003, 0005, 0007, 0012, 0015, 0016; Phase 6 slice 6g interfaces (reporting path).
- EU GMP Annex 22 draft (July 2025) and FDA's draft guidance on AI to support regulatory decisions (January 2025), both
  paraphrased in the draft controls (status U).
