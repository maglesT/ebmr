# Repository guide

How the eBMR code base is organised, how to run it, and how to change it safely. The build outline
(`docs/outline/build-outline.md`) is the plan; the ADRs (`docs/adr/`) record why things are the way they are.

## Layout

| Path | What lives there |
|---|---|
| `compliance/controls/` | One YAML file per regulatory control (241). The source of truth for what the system must do, which phase proves it, and the expert's decision. |
| `compliance/requirements/` | The 678 clause-level requirements (n-numbers) the controls are built from. |
| `compliance/schema/` | JSON schema every control file must satisfy. |
| `compliance/phase.yaml` | The phase the repository is in. CI requires a passing test for every control due by this phase. |
| `packages/kernel` | Compliance kernel shared by both editions: identity, access, e-signatures, audit trail, time, sealing, control register, market-profile engine, retention, true copies. Imports nothing else in the repo. |
| `packages/site-services` | Data shared by both editions at one site: persons, qualifications, lots, batch numbers, devices. |
| `packages/expr` | Expression language for calculations (exact decimals, units, explicit rounding). Imports nothing else. |
| `packages/recipe-core` | Recipe engine: flows, validator, execution, simulator, limits, MBR life cycle. May import only `kernel` and `expr`. |
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

## Rules that CI enforces

- **Boundaries** (`.dependency-cruiser.cjs`): apps never import each other; packages never import apps; `kernel` and `expr` import nothing internal; `recipe-core` imports only `kernel` and `expr`; product code never imports `tools/`.
- **Exact pins** (ADR 0015): internal dependencies are written `"@ebmr/kernel": "workspace:0.1.0"` and must equal the package's version. A shared-package change reaches an edition only when that edition bumps its pin.
- **Traceability** (ADR 0009): tests name the controls they prove in square brackets, for example `it('[DI-22] every modification needs a reason', ...)`. A control due by the current phase without a passing test fails CI, as does a test citing an unknown control.
- **Clock**: domain code never reads the process clock through `Date`; time comes from the kernel's trusted clock. Banned: `Date.now`, called or passed as a function (`= Date.now`); `new Date()` without arguments (or with spread ones); and `Date` anywhere it can read the clock: allowed are only `new Date(value)`, `Date.parse`, `Date.UTC`, `Date.prototype`, `instanceof Date` and types, so `Date()` without `new`, `Date.call`, a copy of `Date`, `const { now } = Date` and `globalThis.Date` are caught. Exempt: the kernel's time module, each app's named clock module (`platform/clock.ts` in the tablets server, which reads both the monotonic and the wall clock for the lifetimes of in-memory tickets, decision X44), the simulators, tools and tests (`tools/boundaries/test/clock-ban.test.ts` proves each form is caught once).
- **Decimals**: GMP values (weights, limits, yields) never use JavaScript `number`; they use the expression language's decimal type.

## How to...

- **Record the expert's decision on a control:** edit `expert_decision` in `compliance/controls/<ID>.yaml` (`FOLLOW`, `DONT_FOLLOW` or `MODIFY` with a comment, plus reviewer and date). A `DONT_FOLLOW` on a control backed by binding regulation needs the owner's confirmation first.
- **Start a new phase:** raise `current_phase` in `compliance/phase.yaml` in the same pull request that delivers the phase's controls.
- **Add a building block:** copy the block template (arrives in Phase 2), implement every part of the block contract, list the controls it implements in their YAML files, and register a new block-type version.
- **Change a regulatory value:** add a new row to the rule table with its source and effective date (rule tables arrive in Phase 1); never edit a row in place.
- **Re-import the catalogs:** `pnpm register:import` (keeps decisions, tests and build status already recorded in the YAML).

## Definition of done

A change is done when `pnpm run ci` passes, every behaviour it adds has a test tagged with its control IDs, the ADRs still describe the design (or a new ADR records the change), and `PROGRESS.md` says where the project stands.

## Commits and branches

Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`). Work happens on a branch per phase or feature and reaches `main` through a pull request with green CI.
