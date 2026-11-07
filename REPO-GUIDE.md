# Repository guide

How the eBMR code base is organised, how to run it, and how to change it safely. The build outline
(`docs/outline/build-outline.md`) is the plan; the ADRs (`docs/adr/`) record why things are the way they are.

## Layout

| Path | What lives there |
|---|---|
| `compliance/controls/` | One YAML file per regulatory control (246: the 241 of the review pack and the drafts IN-53, DI-51, DI-52, DI-53 and PR-61). The source of truth for what the system must do, which phase proves it, and the expert's decision. |
| `compliance/requirements/` | The 680 clause-level requirements (n-numbers) the controls are built from. |
| `compliance/schema/` | JSON schema every control file must satisfy. |
| `compliance/phase.yaml` | The phase the repository is in. CI requires a passing test for every control due by this phase. |
| `packages/kernel` | Compliance kernel shared by both editions: identity, access, e-signatures, audit trail, time, sealing, control register, market-profile engine, retention, true copies. Imports nothing else in the repo. |
| `packages/site-services` | Data shared by both editions at one site: persons, qualifications, lots, batch numbers, devices. |
| `packages/expr` | Expression language for calculations (exact decimals, units, explicit rounding). Imports nothing else. |
| `packages/recipe-core` | Recipe engine: flows, validator, execution, simulator, limits, MBR life cycle. May import only `kernel` and `expr`. |
| `packages/analytics` | Advisory analytics (ADR 0020): pure statistics, the method registry, canonical hashing. Imports nothing in the repo; only the tablets server's analytics runner and tests import it. |
| `packages/integration-sdk` | Contracts for adapters to ERP, LIMS, QMS, LMS, EMS, scales, printers, OPC UA. |
| `packages/ui-kit`, `validation-kit`, `test-kit` | Shared UI, validation-pack generators, test harness. |
| `apps/tablets-*`, `apps/injectables-*` | The two editions. They never import each other. |
| `apps/site-gateway`, `apps/simulators` | Equipment gateway and simulators for demos and tests. |
| `tools/register` | Imports the catalogs into the register, validates it, checks pins, builds the traceability matrix. |
| `tools/boundaries` | Proves each architecture boundary rule actually fires. |
| `docs/` | Regulatory research, control catalogs, design specs, outline, decisions, ADRs. |

## Run it

```bash
pnpm install          # Node 22+, pnpm 10
pnpm run ci           # everything CI runs (plain `pnpm ci` is a reserved pnpm command): typecheck, lint, boundaries, pins, register, tests, traceability
pnpm test             # tests only
```

`pnpm lint` runs ESLint with an 8 GB heap (raised from 4 GB in commit d158c601): typed linting keeps the root, ui-kit, web and E2E TypeScript programs in memory
together (about 2.2 GB live in Phase 2), more than node's default heap on a CI runner. Raise it there if lint runs out of
memory again; to see what CI sees locally, run with `NODE_OPTIONS=--max-old-space-size=2048`.

## Rules that CI enforces

CI runs the static checks in one job and the tests in eight shards (`vitest run --shard=i/8` with blob reports; four until Phase 6, six until slice 7p), each with its own PostgreSQL; a report job merges the shards into `.reports/vitest.json` and runs the trace on it. The suite had grown to 55 minutes on one 2-core runner. Locally, `pnpm run ci` still runs everything in one go.

**Where CI runs.** The repository variable `CI_RUNNER` (or, on a run by hand, the input `runner`) chooses: `ubicloud` puts only the long jobs on Ubicloud's managed runners (owner): the end-to-end groups on `ubicloud-standard-4-ubuntu-2204` and the golden batches on `ubicloud-standard-8-ubuntu-2204` (and the two short jobs the end-to-end groups wait on, the code-or-docs check and the end-to-end plan, on `ubicloud-standard-2-ubuntu-2204`, so they never wait in GitHub's queue), each named in its own `runs-on` (`runs-on` cannot read the job's id; `tools/register/test/ci-runners.test.ts` checks every label), while the static checks, the test shards and the light jobs run on GitHub-hosted `ubuntu-latest`; `github` puts everything on GitHub-hosted `ubuntu-latest`; anything else puts only the end-to-end groups and the golden batches on the owner's pod, with every other job on GitHub-hosted `ubuntu-latest` (owner: heavy jobs on the good machine, light ones elsewhere). A run on Ubicloud by hand: Actions > CI > Run workflow with `runner` = `ubicloud`. Ubicloud's VMs serve one job each with GitHub's image, so `tools/ci` treats them as GitHub-hosted (`EBMR_CI_HOST`); `start-postgres.sh` installs PostgreSQL 16 from PGDG on that image (its own is 14). The mutation workflow (`mutation.yml`) follows the same switch. A pull request that changes only Markdown outside test folders skips the end-to-end groups (`tools/ci/changes.sh`; owner, cost); the static checks, all test shards, the golden batches and the Vitest trace still run, and a push to main runs everything. The end-to-end groups and the golden batches run on the owner's self-hosted RunPod pod (label `ebmr-pod`: eight runners, `pod-1` to `pod-8`, on one 32-vCPU machine) unless the repository variable `CI_RUNNER` is `github`, which puts them back on GitHub-hosted `ubuntu-latest`; set it while the pod is stopped (jobs queued for a stopped pod wait) and delete it when the pod is back. On the pod each job starts its own PostgreSQL 16 cluster with `initdb` in its temporary directory on a free port (`tools/ci/start-postgres.sh`, which on a GitHub-hosted runner starts the runner's own cluster as before and in both cases writes `EBMR_PG_ADMIN_URL`), each runner has its own `HOME` and Playwright browsers (`tools/ci/runner-env.sh`), and Playwright's apt step is serialised across the runners (`tools/ci/playwright-install.sh`). So nothing may assume port 5432 or the Debian cluster layout. A run by hand (`gh workflow run ci.yml --ref <branch> -f e2e_groups=route-w,rest`) runs only those end-to-end groups; with the input empty it is the full run.

- **Boundaries** (`.dependency-cruiser.cjs`): apps never import each other; packages never import apps; `kernel` and `expr` import nothing internal; `recipe-core` imports only `kernel` and `expr`; product code never imports `tools/`; `analytics` imports no repository package, driver or node core module, only the analytics runner imports it, and the runner reaches no GMP path (ADR 0020).
- **Exact pins** (ADR 0015): internal dependencies are written `"@ebmr/kernel": "workspace:0.1.0"` and must equal the package's version. A shared-package change reaches an edition only when that edition bumps its pin.
- **Traceability** (ADR 0009): tests name the controls they prove in square brackets, for example `it('[DI-22] every modification needs a reason', ...)`. A control due by the current phase without a passing test fails CI, as does a test citing an unknown control. A control's `tests` list names tests as `<file> > <describe> > ... > <title>` (a describe may be left out); `pnpm register:validate` refuses an entry its file does not declare, and the trace one the run did not report or that did not run (a test whose source lets the run skip it, with skipIf/runIf or the test context's skip, may be reported skipped; it then proves nothing). The list is sorted and names each test once (validate refuses an unsorted list or a repeat). The list names every test tagged with the control that passed: the trace refuses one it does not name, and `pnpm register:sync-tests` adds them from `.reports/vitest.json` (after `pnpm test:json`) and `.reports/playwright.json` (after the E2E run). Each list is kept sorted (code-unit order): `sync-tests` writes it sorted, `pnpm register:sort-tests` sorts a list edited by hand, and `register:validate` refuses an unsorted one, so parallel branches rarely conflict on a list. The handbook's generated pages (code map, database catalogue, control map, error codes) are not committed: `pnpm handbook` writes them locally and CI uploads them as the `handbook-generated` artifact. CI's traceability job runs the trace on both reports (`pnpm trace:e2e`, which requires the Playwright report). A due control also maps its catalog test, word for word, to `clauses`: each names the listed tests that prove it or is `deferred` to a later phase with the reason (`deferred_scope` does the same for behaviour beyond the catalog test). The trace fails a clause with no passing listed test and no deferral, and a deferral whose phase has started (a deferral to phase 5, the Injectables edition, has not started while `compliance/phase.yaml` leaves injectables out of the gate: Phase 6 plan question 7); a control with anything deferred stays `SPECIFIED`. Write `[meta]`, not a control's bracketed ID, in the title of a test about the tooling.
- **Clock**: domain code never reads the process clock through `Date`; time comes from the kernel's trusted clock. Banned: `Date.now`, called or passed as a function (`= Date.now`); `new Date()` without arguments (or with spread ones); and `Date` anywhere it can read the clock: allowed are only `new Date(value)`, `Date.parse`, `Date.UTC`, `Date.prototype`, `instanceof Date` and types, so `Date()` without `new`, `Date.call`, a copy of `Date`, `const { now } = Date` and `globalThis.Date` are caught. Exempt: the kernel's time module, each app's named clock module (`platform/clock.ts` in the tablets server, which reads both the monotonic and the wall clock for the lifetimes of in-memory tickets, decision X44), the simulators, tools and tests (`tools/boundaries/test/clock-ban.test.ts` proves each form is caught once).
- **Decimals**: GMP values (weights, limits, yields) never use JavaScript `number`; they use the expression language's decimal type. Analytics is the one exception (ADR 0020): a value becomes a statistic only through `statOf` in `@ebmr/analytics`, and lint bans `Number()`, `parseFloat`, `parseInt` and unary `+` in the runner (`apps/tablets-server/src/analytics/`).

## How to...

- **Record the expert's decision on a control:** edit `expert_decision` in `compliance/controls/<ID>.yaml` (`FOLLOW`, `DONT_FOLLOW` or `MODIFY` with a comment, plus reviewer and date). A `DONT_FOLLOW` on a control backed by binding regulation needs the owner's confirmation first.
- **Start a new phase:** raise `current_phase` in `compliance/phase.yaml` in the same pull request that delivers the phase's controls; every control the new phase owns needs its `clauses`, and every deferral to that phase must be tested by then.
- **Add a building block:** copy the block template (arrives in Phase 2), implement every part of the block contract, list the controls it implements in their YAML files, and register a new block-type version.
- **Change a regulatory value:** add a new row to the rule table with its source and effective date (rule tables arrive in Phase 1); never edit a row in place.
- **Re-import the catalogs:** `pnpm register:import` (keeps decisions, tests and build status already recorded in the YAML).

## Definition of done

A change is done when `pnpm run ci` passes, every behaviour it adds has a test tagged with its control IDs, the ADRs still describe the design (or a new ADR records the change), and `PROGRESS.md` says where the project stands.

## Commits and branches

Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`). Work happens on a branch per phase or feature and reaches `main` through a pull request with green CI.
