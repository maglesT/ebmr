# tools: register, boundaries, mutation, demo, browser suite, handbook

**Draft.** This page is still being written; facts on it were checked against the code on 14 October 2026.

This page explains the folders under `tools/`: programs that are not part of the product but keep it honest and
runnable. The control register tooling ties every regulatory control to the tests that prove it; the boundary tests
keep the architecture's rules; the SQL mutation harness checks that the database guards are really tested; the demo
tooling starts the whole stack; the browser suite drives the real screens; the regulatory scripts built the register;
the dev-env script sets up a development pod; the handbook tool writes and checks this handbook. Read the section of
the tool you touch. Testing in general is in [Testing and debugging](../06-testing-and-debugging.md).

## Where the code is

| Tool | Folder | Commands |
|---|---|---|
| Control register | [tools/register/src/](../../../tools/register/src/) | `pnpm register:validate`, `pnpm trace`, `pnpm trace:e2e`, `pnpm register:sync-tests`, `pnpm pins:check`, `pnpm register:import` |
| Boundary and clock-ban tests | [tools/boundaries/test/](../../../tools/boundaries/test/) | `pnpm deps:check` (the real code), the tests in the `db` project |
| SQL mutation harness | [tools/sql-mutation/src/](../../../tools/sql-mutation/src/) | `pnpm mutation:sql` |
| Demo stack | [tools/demo/src/](../../../tools/demo/src/) | `pnpm demo:setup`, `pnpm demo`, `pnpm dev` |
| Browser suite (Playwright) | [tools/e2e/](../../../tools/e2e/) | `pnpm e2e`, `pnpm --filter @ebmr/e2e test` |
| Regulatory register scripts | [tools/regulatory/](../../../tools/regulatory/) | Python, run by hand (history) |
| Development pod set-up | [tools/dev-env/runpod-setup.sh](../../../tools/dev-env/runpod-setup.sh) | `bash tools/dev-env/runpod-setup.sh` |
| Handbook generator and link checker | [tools/handbook/src/](../../../tools/handbook/src/) | `pnpm handbook`, `pnpm handbook:check` |

All of them are wired into `pnpm run ci` ([package.json](../../../package.json)):
typecheck, lint, `deps:check`, `pins:check`, `register:validate`, `build:web`, `test:json`, `trace`.

## tools-register: the control register

### Pharma context

A regulated computer system must be validated: for each requirement of the regulations, the company must show how the
system meets it and the test that proves it (21 CFR 11.10(a), EU GMP Annex 11 section 4). This project keeps that link
as data from the first day ([ADR 0009](../../adr/0009-control-register-as-data.md)), so CI fails when a due control has
no passing test. The validation pack of Phase 7 is generated from the same data.

### The data

| File | What it holds |
|---|---|
| [compliance/controls/&lt;ID&gt;.yaml](../../../compliance/controls/) | one file per control (246: DI 53, PR 61, ST 79, IN 53; IN-53 is the draft added by slice 6e, DI-51 to DI-53 and PR-61 the analytics drafts of slice 6A-0): title, editions, type, `target_phase`, the requirement rows it covers, `behaviour`, `catalog_test`, `implemented_by`, `tests`, `clauses`, `expert_decision`, `build_status` |
| [compliance/requirements/requirements.jsonl](../../../compliance/requirements/) | 680 clause-level requirement rows (n-numbers; n679 is IN-53's unverified NDPS row, n680 the analytics drafts' unverified FDA AI-guidance row) |
| [compliance/schema/control.schema.json](../../../compliance/schema/) | the schema of a control file |
| [compliance/phase.yaml](../../../compliance/phase.yaml) | the current phase (4) and the editions the gate covers (tablets) |

Example: [DI-24.yaml](../../../compliance/controls/DI-24.yaml) (corrections and voids keep the original) lists its
tests and maps each clause of its catalog test to the tests that prove it.

**Never change `expert_decision` or weaken a control to make code or tests easier** (hard rule of
[CLAUDE.md](../../../CLAUDE.md)). If a control seems wrong, write it up for the owner.

### The commands

[cli.ts](../../../tools/register/src/cli.ts) has five subcommands:

- **import** ([importCatalogs](../../../tools/register/src/import.ts#sym=importCatalogs)): reads the control catalogs in
  [docs/regulatory/control-catalogs/](../../regulatory/control-catalogs/) ([parseCatalog](../../../tools/register/src/catalog-parser.ts#sym=parseCatalog))
  and writes the YAML files. Re-running keeps every field a person has since edited (tests, clauses, decisions, build
  status). The target phase comes from the exit criteria of outline section 11 ([assignPhase](../../../tools/register/src/phases.ts#sym=assignPhase));
  a control the outline does not name gets a default by part and edition (`target_phase_source: default`).
- **validate** ([validateRegister](../../../tools/register/src/validate.ts#sym=validateRegister)): the schema, unique
  IDs, the expected counts ([EXPECTED_COUNTS](../../../tools/register/src/validate.ts#sym=EXPECTED_COUNTS)), every cited
  requirement row exists, every listed test exists in the file it names (read from the syntax tree, nothing run:
  [missingListedTests](../../../tools/register/src/test-index.ts#sym=missingListedTests)), and the clauses are the
  catalog test word for word ([clauseErrors](../../../tools/register/src/validate.ts#sym=clauseErrors)).
- **pins** ([checkPins](../../../tools/register/src/pins.ts#sym=checkPins)): every internal dependency uses
  `workspace:<exact version>`; ranges (`workspace:*`, `^`, `~`) are refused, so a shared-package change reaches an
  edition only when its pin changes ([ADR 0015](../../adr/0015-exactly-pinned-shared-packages.md)).
- **trace** ([buildTrace](../../../tools/register/src/trace.ts#sym=buildTrace)): reads the Vitest JSON report, the golden
  report and the Playwright report, and fails when a test cites an unknown control; a due control has no passing
  listed test; a clause has neither a passing test nor a deferral; a deferral names a phase that has started (phase 5,
  the Injectables edition, has not started while `phase.yaml` leaves that edition out of the gate:
  [deferralStarted](../../../tools/register/src/trace.ts#sym=deferralStarted), Phase 6 plan question 7); a listed
  test did not run (unless its source lets it skip, such as the DI-47 test on 29 February); a passing tagged test is
  missing from its control's list. It writes `.reports/trace-matrix.md` ([writeMatrix](../../../tools/register/src/trace.ts#sym=writeMatrix)).
  `trace:e2e` also requires the Playwright and golden reports (the CI `traceability` job).
- **sync-tests** ([testsToAdd](../../../tools/register/src/sync.ts#sym=testsToAdd)): adds the passing tagged tests a
  control's list lacks. It never removes an entry.

How tests name controls (`[DI-22]`, `[INV-07]`, `[meta]`) and the order to run things in:
[Testing, register and trace](../06-testing-and-debugging.md#register-and-trace-control-ids-in-test-names).

### phase.yaml and the editions filter

A control is **due** when its `target_phase` is at or before `current_phase` and the expert has not rejected it
(DONT_FOLLOW). [gateEditions](../../../tools/register/src/register.ts#sym=gateEditions) reads `editions` from
phase.yaml: a control is due only if one of its editions is listed, so the 91 injectables-only controls stay out of the
gate while that edition is deferred (decision 0010). Absent means both; an empty list or an unknown edition is
refused. Details and tests: [injectables, the editions filter](injectables.md#the-editions-filter-of-the-trace-gate).

> **Why this exists** (the trace gate)
> - **Pharma reason:** a control claimed as met without a passing test is an unproven claim; an inspector or auditor
>   asks for the evidence. The gate makes "no evidence" a red build, not a finding at validation.
> - **Control:** all controls; the tooling's own tests are `[meta]`.
> - **Code:** [buildTrace](../../../tools/register/src/trace.ts#sym=buildTrace),
>   [validateRegister](../../../tools/register/src/validate.ts#sym=validateRegister).
> - **Tests:** [register.test.ts](../../../tools/register/test/register.test.ts),
>   [listed-tests-and-clauses.test.ts](../../../tools/register/test/listed-tests-and-clauses.test.ts).
> - **Lessons:** [Tests that proved too little](../08-defect-log.md#tests-that-proved-too-little-phase-2-exit-f13-to-f29-and-e2e-claims)
>   (reviews F14 and F15: one tagged test is not proof of every clause; a listed test must exist and run).

## tools-boundaries: dependency rules and the clock ban

The architecture's import rules live in [.dependency-cruiser.cjs](../../../.dependency-cruiser.cjs); `pnpm deps:check`
runs them on the real code ([Architecture, the dependency boundaries](../03-architecture.md#3-the-dependency-boundaries)).
The tests in [tools/boundaries/test/](../../../tools/boundaries/test/) prove the rules themselves work:

- [boundaries.test.ts](../../../tools/boundaries/test/boundaries.test.ts) runs every rule against deliberate violations
  in [fixtures/](../../../tools/boundaries/fixtures/) (`[meta] every boundary rule fires on a deliberate violation`):
  apps never import each other, packages never import apps, product code never imports `tools/` or the test kit, the
  gateway and simulators never reach a database, browser code never imports a database driver or the node-only
  recipe-core folders.
- [clock-ban.test.ts](../../../tools/boundaries/test/clock-ban.test.ts) proves the ESLint rule that bans reading the
  process clock (`Date.now()`, `new Date()` without arguments, `Date.now` passed by reference, `const { now } = Date`,
  Date through `globalThis`, ...) outside the named clock modules catches each form. GMP time comes from the database
  ([Architecture, time](../03-architecture.md#10-time)).
- [runtime-loader.test.ts](../../../tools/boundaries/test/runtime-loader.test.ts): every app that runs from TypeScript
  source (`node --import tsx`) declares `tsx` among its own runtime dependencies at the root's exact version.

A rule that never fires protects nothing; that is why each rule has a fixture that must trip it.

## tools-sql-mutation: the SQL mutation harness

Most rules of this system are guards inside PostgreSQL functions. Mutation testing changes one place in a function
(removes a `raise exception`, flips `<` to `<=`, `and` to `or`, drops a `not`, swaps `true` and `false`) and runs the
tests that should notice. If they all still pass, the guard is not really tested.

| File | Role |
|---|---|
| [targets.ts](../../../tools/sql-mutation/src/targets.ts#sym=TARGETS) | the groups: functions, the test files that must kill their mutants, a threshold (90 %) |
| [mutators.ts](../../../tools/sql-mutation/src/mutators.ts#sym=mutantsOf) | the operators; literals and comments are never touched |
| [sql-scan.ts](../../../tools/sql-mutation/src/sql-scan.ts) | finds function definitions and splits bodies into code and non-code |
| [run.ts](../../../tools/sql-mutation/src/run.ts#sym=loadDefinitions) | builds the templates, applies each mutant as the function's owner with `create or replace`, runs the group's tests, writes the report |
| [check-run.ts](../../../tools/sql-mutation/src/check-run.ts#sym=checkRunPayload) | the weekly workflow's GitHub check run per group (never red) |
| [equivalent.json](../../../tools/sql-mutation/equivalent.json) | mutants no input can tell apart, each with its reasoning |

It mutates **the version in force** of each function (the last definition across all migrations). The full
description is in [Database reference, the SQL mutation harness](../05-database.md#the-sql-mutation-harness); commands
and results in [Testing, mutation testing](../06-testing-and-debugging.md#mutation-testing); the procedure for a change
in the skill [mutation-check](../../../.claude/skills/mutation-check/SKILL.md). Decision 0008 runs it on changed guard
code during the build and at full depth at deployment.

Tests: [mutators.test.ts](../../../tools/sql-mutation/test/mutators.test.ts) (an operator inside `->>` is never mutated;
a function is identified as PostgreSQL identifies it), [harness.test.ts](../../../tools/sql-mutation/test/harness.test.ts)
(every target resolves to a live definition in one group only; re-applying keeps owner, grants, SECURITY DEFINER and
`search_path`; a copy keeps the template's database privileges). Lessons: [D-series, guards that could not
fire](../08-defect-log.md#d-series-sql-mutation-guards-that-could-not-fire).

## tools-demo: the demo stack

[tools/demo](../../../tools/demo/src/) starts the whole system on one machine for the owner's demos and for development;
the browser suite reuses it.

- `pnpm demo:setup` ([cli.ts](../../../tools/demo/src/cli.ts)): creates the databases `ebmr_tablets_demo` and
  `ebmr_sandbox_tablets_demo` ([DEMO_DATABASES](../../../tools/demo/src/paths.ts#sym=DEMO_DATABASES)) through the
  server's set-up CLI ([apps/tablets-server/src/cli/setup.ts](../../../apps/tablets-server/src/cli/setup.ts)), with
  DEMO-ONLY keys (the gateway's Ed25519 key, seal keys, terminal keys, service secrets) and the personas, and builds
  the web app.
- `pnpm demo`: starts the GMP server (3001), the sandbox server (3011, gateway listener 3012), the site gateway (3021)
  and the scale simulator (TCP 4001, console 4002) ([DEMO_PORTS](../../../tools/demo/src/paths.ts#sym=DEMO_PORTS)),
  plus the demo process equipment and printer simulators ([DEMO_DEVICES](../../../tools/demo/src/paths.ts#sym=DEMO_DEVICES):
  press, coater, printer, bottle line, cartoner); it prints the URLs and the credential card.
- `pnpm dev`: the same servers without the built web app, plus Vite dev servers on 5173 (GMP) and 5174 (sandbox) with
  hot reload ([tablets-web](tablets-web.md#how-to-test-this-app)).

[stack.ts](../../../tools/demo/src/stack.ts) does the work ([writeGatewayConfig](../../../tools/demo/src/stack.ts#sym=writeGatewayConfig)
writes the gateway's configuration); [processes.ts](../../../tools/demo/src/processes.ts) starts each child as
`node --import tsx <entry>` with prefixed logs and health checks. Files go to `var/demo/` (keys) and `var/exchange/`
(the GMP-to-sandbox test-package exchange) ([paths.ts](../../../tools/demo/src/paths.ts)).

**DEMO-ONLY.** Every key and credential the demo makes exists only in the demo databases. The demo seeds refuse to run
on a non-demo database ([defect log, demo seeds](../08-defect-log.md#p4-slice-2-high-demo-seeds-could-run-on-a-non-demo-database)).
Never drop the demo databases on a shared cluster without asking.

Test: [demo-devices.test.ts](../../../tools/demo/test/demo-devices.test.ts) (the demo gateway configuration names the
press, coater, printer and packaging devices, and the gateway accepts it; the E2E stack keeps the scale alone).

## tools-install: the one-command installer (Phase 7 slice 7g-4)

[tools/install](../../../tools/install/src/cli.ts) puts a Batchwright Tablets server on a machine
([decision 0025](../../decisions/0025-every-act-has-a-screen.md) point 2: the one command that stays a script).
[install.sh](../../../tools/install/install.sh) checks node and pnpm and runs it; `pnpm install:server` is the same.
- [answers.ts](../../../tools/install/src/answers.ts): the questions, the defaults and the checks (a sandbox under
  `ebmr_sandbox_`, a demo name ending in `_demo`, TLS for a production GMP server).
- [render.ts](../../../tools/install/src/render.ts): the environment file, the Caddyfile, the systemd units and the
  docker compose file (pure).
- [plan.ts](../../../tools/install/src/plan.ts): the ordered, idempotent actions (pure); [run.ts](../../../tools/install/src/run.ts)
  performs them through an `InstallEnv`, or says what it would do in a dry run; [env.ts](../../../tools/install/src/env.ts)
  is the machine.

The tests run a fake `InstallEnv` and never touch the machine
([install.test.ts](../../../tools/install/test/install.test.ts)): the checks, a dry run that changes nothing, the files,
and a second run that keeps what the first made. How to use it: [runbooks](../10-runbooks.md#install-a-server-set-it-up-load-demo-data-reset-phase-7-slice-7g-4).

## tools-e2e: the browser suite

[tools/e2e](../../../tools/e2e/) runs the real stack (both servers, the web app, the gateway and the scale simulator,
a GMP and a sandbox database) in Chromium with Playwright, and drives the real screens.

- [global-setup.ts](../../../tools/e2e/global-setup.ts): unique databases `ebmr_tablets_e2e_<hex>` and
  `ebmr_sandbox_tablets_e2e_<hex>`, seeded with one persona set per worker plus one, the web app built once, the stack
  started on free ports; the teardown stops the processes and drops the databases. State reaches the workers through
  `EBMR_E2E_STATE`.
- [playwright.config.ts](../../../tools/e2e/playwright.config.ts): 2 workers; project `office` (tag `@office`,
  1440x900, one worker) and project `kiosk` (tag `@kiosk`, 1280x800). Reporters: list, JSON
  (`.reports/playwright.json`, read by the trace) and the evidence reporter.
- [fixtures/index.ts](../../../tools/e2e/fixtures/index.ts): `e2e` (stack and seeds), `persona(installation, key)`,
  `officePage` and `kioskPage` (a browser context that picked a demo terminal), `signIn`, `badge.tap` (keyboard-wedge
  input), `pin.enter`, `api(installation)` (the typed contract client), `axe.check` (WCAG 2.2 AA, no serious or
  critical finding), `evidence.step`, `dcMiniPackage`, `withSimulator` (one spec at a time on the shared scale), and
  [cspViolations](../../../tools/e2e/fixtures/index.ts#sym=cspViolations) collected from every page.
- [reporters/evidence-reporter.ts](../../../tools/e2e/reporters/evidence-reporter.ts): `.reports/e2e-evidence.json`
  for the validation pack: per test, its controls, its steps with expected result, what was actually checked (the
  assertions the step made, with source line and outcome, and the facts it measured), time and screenshots. A step that
  made no assertion is recorded as "not checked", never as "as expected" (review F28).

**Specs** ([specs/](../../../tools/e2e/specs/)), one folder per area; titles carry control IDs like any test:

| Folder | What it drives |
|---|---|
| `smoke` | demo picker, office and kiosk sign-in, TEST, NOT GMP on the sandbox (`[DI-05]`) |
| `security` | strict CSP with no violation, cookies per installation, cross-origin POST refused, planted cookies (`[DI-13]`, `[DI-38]`) |
| `access`, `esig` | kiosk lock, unlock, switch; a kiosk signature with tap and PIN (`[DI-36][DI-38][INV-40]`) |
| `audit` | who, when, why and what changed, and the chain verifies (`[DI-22][DI-23]`) |
| `designer`, `journey` | author an MBR, validate, simulate, send a test package; the first clickable version end to end |
| `floor`, `floor-tablets` | cockpit, step screens, run overview; action-limit block (`[PR-08]`); void, never delete (`[DI-24]`) |
| `devices` | the room's scale, another room refused, offline means the manual two-person path (`[DI-32]`, `[DI-20]`) |
| `master-data`, `planning`, `plant`, `quality` | formulas, order to issue, packaging orders and bulk issue, cleaning, deviations |
| `review`, `release` | record review, containers, release cockpit, market tabs, QP package, after release, archive |
| `india`, `pqr` | licences, allocation register, label particulars; the PQR extract |

The screens each spec drives are listed per feature on the [tablets-web](tablets-web.md#the-feature-folders) page.

Two tests check the suite itself: [spec-claims.test.ts](../../../tools/e2e/test/spec-claims.test.ts) reads two specs'
syntax trees and holds them to what they claim (a step that says the server "records nothing" must compare the
database before and after; a `[DI-20]` room test must ask the server itself), and
[evidence-record.test.ts](../../../tools/e2e/test/evidence-record.test.ts) runs the real reporter on a fixture spec.

How to run (with the lock, the pre-installed browser, never `playwright install`):
[Testing, browser suite](../06-testing-and-debugging.md#browser-suite-playwright). `EBMR_E2E_VIDEO=1` records videos
(the owner's demo recordings).

## tools-regulatory: the register's origin

[tools/regulatory](../../../tools/regulatory/) holds the Python and Node scripts that built the regulatory register
before the code existed (September 2026): [merge_register.py](../../../tools/regulatory/merge_register.py) merged the
research and verification outputs into the requirements register,
[split_register.py](../../../tools/regulatory/split_register.py) split it into topic buckets,
[check_coverage.py](../../../tools/regulatory/check_coverage.py) checked that every requirement row is referenced by a
digest, and [pdf/](../../../tools/regulatory/pdf/) rendered the outline and the review pack to PDF with headless
Chromium. The results are in [docs/regulatory/](../../regulatory/) and `compliance/requirements/`. They are kept as
history and are not part of CI; the register is maintained through `tools/register` now.

## tools-dev-env: the development pod

[runpod-setup.sh](../../../tools/dev-env/runpod-setup.sh) sets up a fresh development container (Ubuntu 22.04, root, no
systemd): Node 22 and pnpm, PostgreSQL 16 with four clusters (`main` 5432, spares `ci` 5433 and `ci2` 5434, `golden`
5435 under libfaketime), the `ebmr_dev` superuser role, and Playwright's Chromium in `/opt/pw-browsers`. It is safe to
run again (each step checks what is there); `SKIP_BROWSER=1` skips the browser. **The pod's disk is erased when it
stops**: run the script after every start, and commit and push often. The clusters and when to use each:
[Database reference, the clusters](../05-database.md#the-clusters); skill [local-ci](../../../.claude/skills/local-ci/SKILL.md).

## tools-handbook: the generator and link checker

[tools/handbook](../../../tools/handbook/) writes the generated pages of this handbook and checks every handbook link
(decisions [0013](../../decisions/0013-developer-handbook-alongside.md) and
[0014](../../decisions/0014-codebase-map-linked-to-handbook.md)); its [README](../../../tools/handbook/README.md) is the
short version.

- `pnpm handbook` ([cli.ts](../../../tools/handbook/src/cli.ts)) writes [code-map.md](../code-map.md) and
  `reference/` ([db-catalogue](../reference/db-catalogue.md), [control-map](../reference/control-map.md),
  [error-codes](../reference/error-codes.md)) from the migrations, the contract's namespace files, the control register
  and [modules.yaml](../modules.yaml). The output is deterministic (sorted, no dates, git's file list).
- `pnpm handbook:check` ([check.ts](../../../tools/handbook/src/check.ts)) fails when a generated page is out of date
  or when:
  - a migration, server feature folder, contract file or screens folder belongs to no module of `modules.yaml` (the
    first module whose pattern matches claims a file; [model.ts](../../../tools/handbook/src/model.ts));
  - a folder under `packages/`, `apps/` or `tools/` is no module's package;
  - a module page is missing (and not `pending:`) or not linked from the handbook README;
  - a relative link in `docs/handbook/**/*.md` or a README's `Handbook:` line reaches no file; a `#sym=<name>` link
    names something the file does not define (SQL `create function|procedure|trigger|view|table`, TypeScript
    `function|const|class|interface|type|enum` or `export`; comments do not count, [sql.ts](../../../tools/handbook/src/sql.ts));
    a `#anchor` names no heading of the page (GitHub slugs, [slug](../../../tools/handbook/src/links.ts#sym=slug));
  - a migration numbered above `migration_header_from` has no `-- Handbook: <page>` line in its first 10 lines.

When you add a migration, a feature folder, a contract file or a screens folder: add it to a module in `modules.yaml`
(or let a pattern claim it), run `pnpm handbook` and commit the regenerated pages. When you write a page, keep
`pnpm handbook:check` clean for it, then take it off `pending:`. Writing rules: [STYLE.md](../STYLE.md).

Test: [handbook.test.ts](../../../tools/handbook/test/handbook.test.ts) runs the same checks in the suite and proves
each one on a fixture (an unclaimed migration, a missing symbol, a symbol named only in a comment, a wrong anchor,
links inside code ignored, a pending page, GitHub slugs).

## Adding a control to the register (slice 6e, IN-53)

A new control is added only as a plan describes it (never by weakening another). The steps slice 6e took for the draft
IN-53: write `compliance/controls/<ID>.yaml` with `expert_decision: {status: PENDING, pack_version: draft}` and nothing
else in it (the build never sets a decision); add its requirement row to `compliance/requirements/requirements.jsonl`
with the next `n` and `verified: unverified` when the source is not in the inputs; raise `EXPECTED_COUNTS` in
[validate.ts](../../../tools/register/src/validate.ts) and the `[meta]` counts in
[register.test.ts](../../../tools/register/test/register.test.ts) in the same commit; put the id into the names a test
run may cite (`recipe.engine_name`, a new recipe-core migration; `engine-names-sql.test.ts` counts the register); and map
its catalog test to `clauses` once its tests exist. `pnpm register:import` keeps a control that no catalog lists.

## How to test the tools

The tools' own tests are `[meta]` tests in the Vitest `db` project:
`pnpm vitest run --project db tools/register tools/boundaries tools/sql-mutation tools/demo tools/handbook`. The e2e
tool tests run with the e2e package (`tools/e2e/test/`).

## Pitfalls

- **Never edit generated pages by hand** (`code-map.md`, `reference/`); run `pnpm handbook`.
- **A renamed test breaks the trace** until the control's `tests` and `clauses` entries are corrected; run
  `pnpm register:validate` before pushing.
- **`[meta]` tests carry no control ID**; a control ID in a tooling test would count it as proof of the control.
- **Never `playwright install` on the pod**; the browser is in `/opt/pw-browsers`. Take the lock (`flock
  /tmp/ebmr-e2e.lock`) so two runs do not start two stacks.
- **Run the SQL mutation harness on a spare cluster** (`--own-cluster`, `EBMR_PG_ADMIN_URL` on 5433 or 5434) when
  another run uses `main`.
- **Leftover E2E databases** (`ebmr_tablets_e2e_*`) after a killed run may be dropped only on your own cluster.

## Differences between the code and the docs (14 October 2026)

- The Python scripts in [tools/regulatory](../../../tools/regulatory/) hard-code a scratchpad path of the session that
  wrote them (`SP = '/tmp/claude-0/...'`); they do not run as they are. They are history, not part of CI.
- [stack.ts](../../../tools/demo/src/stack.ts) still says "missing gateway and simulator entry files are tolerated until
  module C5 lands"; C5 has landed and the entries exist.
- The register README role is played by the file headers; `tools/register`, `tools/boundaries`, `tools/sql-mutation`,
  `tools/demo` and `tools/e2e` have no README with a `Handbook:` line (only `tools/handbook` does).

## Related pages

- [Testing and debugging](../06-testing-and-debugging.md): the layers, the CI jobs, mutation testing, CI failures.
- [Database reference](../05-database.md): test databases, clusters, the SQL mutation harness.
- [tablets-web](tablets-web.md), [integrations](integrations.md), [shared-kits](shared-kits.md) (test-kit),
  [injectables](injectables.md) (the editions filter).
- Generated: [code map](../code-map.md#tools-register), [control map](../reference/control-map.md).
