# Phase 6 mutation results (decision 0019)

Decision 0019 runs a full mutation campaign at the Phase 6 exit, on the pod, after the first final run is green and
before the Phase 6 PR. Part 1 is all Phase 6 code (main 8331e94 plus slice 6j); part 2 is the Phase 4 leftovers that
decision 0012 left to deployment. Targets are those of build outline 9.1: at least 90 % on guards, signature
invalidation, limits, rounding, flow validation and release gating, 80 % elsewhere. Priorities, the per-group run limit
(one first run, at most one confirmation run) and the time box (part 1 at most 12 pod hours, part 2 at most 8) are those
of decision 0019. Scores come from the harness and Stryker reports of the runs (`report.json`, `summary.md`,
`.reports/stryker-phase6/<feature>.json`); a score no report holds is marked so and not estimated.

This page was prepared before the campaign (branch `phase-6/slice-6j-mutation`, 16 October): the groups, the features,
the run plan and the time estimates are in place; every result is **pending**.

## Summary

| Part | Scope | First-run survivors | Outcome after the new tests | Real defects fixed |
|---|---|---|---|---|
| 1, SQL | 14 Phase 6 groups (3,981 mutants) and the 11 re-created functions of earlier groups (202 mutants) | pending | pending | pending |
| 1, Stryker | 20 Phase 6 features | pending | pending | pending |
| 2 | Phase 4 leftovers (below) | pending | pending | pending |

## Part 1, SQL: the Phase 6 groups

The groups are in `tools/sql-mutation/src/targets.ts` (header: inclusion rule, what is left out, why every group
targets 90 %; decisions D-P6j-M-1 to 3 in the Phase 6 plan). Mutant counts from `pnpm mutation:sql --count`; baselines
(one run of the group's tests on unmutated templates, all green) from `--baseline` on the 5433 cluster.

| Group | Decision 0019 area | Functions | Mutants | Baseline db / server (s) | Target | First run detected / valid | Score | Survivors | Equivalent | After |
|---|---|---|---|---|---|---|---|---|---|---|
| inbound-adapters-and-mirrors | adapters and mirrors | 21 | 310 | 17 / - | 90 % | pending | | | | |
| erp-wms-receipt-and-stock | adapters and mirrors | 41 | 351 | 37 / 6 | 90 % | pending | | | | |
| qms-capa-lims-cmms | adapters and mirrors | 38 | 401 | 12 / 5 | 90 % | pending | | | | |
| equipment-data-and-alarms | equipment, alarms, plant rules | 28 | 469 | 41 / 5 | 90 % | pending | | | | |
| plant-rules | equipment, alarms, plant rules | 26 | 221 | 16 / 5 | 90 % | pending | | | | |
| packaging-labels-and-line-completion | packaging and serialisation | 34 | 352 | 3 / 14 | 90 % | pending | | | | |
| serialisation-l3 | packaging and serialisation | 7 | 112 | - / 5 | 90 % | pending | | | | |
| genealogy-and-recall | genealogy and recall | 23 | 440 | 45 / 4 | 90 % | pending | | | | |
| controlled-substance-mode | controlled-substance mode | 34 | 311 | 5 / 3 | 90 % | pending | | | | |
| governance-change-control | governance, change control, DSC | 19 | 117 | 7 / 3 | 90 % | 84 / 117 (smoke run) | 71.8 % | 33 | not triaged | |
| governance-support-and-contract-giver | governance, change control, DSC | 21 | 228 | 12 / 4 | 90 % | pending | | | | |
| india-dsc | governance, change control, DSC | 19 | 127 | 2 / 4 | 90 % | pending | | | | |
| reporting-and-training | reporting and training mode | 14 | 149 | 3 / 3 | 90 % | pending | | | | |
| transfer-and-federation | inter-site transfer and federation | 49 | 393 | 30 / 7 | 90 % | pending | | | | |

Functions Phase 6 re-created in earlier groups (run alone with `--functions`, 202 mutants; the group keeps its
earlier score for its other functions):

| Group | Re-created functions | Mutants | Result |
|---|---|---|---|
| plant-equipment-and-areas | plant.fitness_problems, plant.record_calibration (recipe-core 0950) | 13 | pending |
| release-gate | recipe.grel_evaluate (recipe-core 0951) | 14 | pending |
| tablets-release-items | tab.grel_recon_serial (tablets 1231) | 2 | pending |
| read-authorisation | tab.record_read_problem (tablets 1276, 1290) | 11 | pending |
| connection-roles | sandbox.apply_connect_policy, sandbox.segregation_problems (kernel 1210) | 115 | pending |
| mbr-lifecycle | recipe.guard_critical_elements_risk_assessed (recipe-core 1050) | 6 | pending |
| after-release-suspension | recipe.genealogy_downstream_lots (recipe-core 1011) | 33 | pending |
| pqr-extract | recipe.pqr_run_query (recipe-core 1062) | 5 | pending |
| lots-and-lims | site.lot_available (site services 0980) | 3 | pending |

### Smoke run (preparation)

governance-change-control, the whole group, `--workers 3 --own-cluster` on 5433 with nothing else on the cluster:
117 mutants in 411 s wall (templates, the definition check and the baseline included), 8.8 s of worker time per
mutant on average (median 5.9 s, longest 21 s; a killed mutant stops at its first failing file, a survivor runs every
file of both projects). Score 71.8 % (84 / 117), 33 survivors in 11 functions, among them removed raises in
`platform.approve_change_record` (4), `platform.register_config_area` (11) and `platform.is_release_actor` (6). The
report (`report.json`) is the group's first run; the campaign triages it rather than running the group again. A
`--resume` of the same report with 7 results removed ran only those 7 and gave the same summary (60 s).

## Part 1, Stryker: the Phase 6 TypeScript

`stryker.phase6.config.mjs` holds the features (`node stryker.phase6.config.mjs --list`): the files each mutates, its
90 % zone (guards, signatures, seals, stale-mirror refusal, flow validation, release and serial gating) and its 80 %
zone (reads for a screen, guidance text, simulators, worker wiring and retry timing), and its test files.
`vitest.stryker-phase6.config.ts` runs only those tests with their set-up (none, the kernel template, or the server
templates). `node stryker.phase6.config.mjs --summary` scores each zone from the feature's JSON report.

A feature's tests must be in the package of its files: Stryker's sandbox links each package's `node_modules`, so a
workspace import (`@ebmr/kernel`, `@ebmr/integration-sdk`) from another package loads the unmutated original. The
kernel's Phase 6 modules are therefore their own feature with the kernel's tests, and the SDK's adapter code is scored
by the SDK's own tests only (its behaviour through the server is covered by the SQL groups and the server features).

| Feature | Kind | 90 % zone | 80 % zone | First run (90 % / 80 %) | After |
|---|---|---|---|---|---|
| sdk-adapter | unit | envelope, errors, mirror, reconciliation, systems/* | contract | smoke run, see below | |
| sdk-equipment-data | unit | adapter/equipment-data, serialisation/wire | process/wire | pending | |
| gateway-opcua | unit | drivers/opcua, opcua-feed | drivers/opcua-node, process-uplink, config, gateway | pending | |
| server-integrations | server | adapters/framework, adapters/erp-wms/*, adapters/qms | the other adapters, start, reads, guidance | pending | |
| kernel-config-and-dsc | db | config/change-control, esig/dsc | esig/dsc-test-ca | pending | |
| server-alarms | server | alarms/index | reads, guidance | pending | |
| server-plant-rules | server | plant-rules/index | reads, guidance | pending | |
| server-equipment-data | server | - | equipment-data/index, reads | pending | |
| server-capa | server | capa/index, signables | reads, guidance | pending | |
| server-config-change | server | config-change/index, signables | reads, guidance | pending | |
| server-controlled | server | controlled/index | reads | pending | |
| server-dashboards-and-training | server | training/index | training/exercises, dashboards/* | pending | |
| server-designer-hazard | server | designer/hazard | - | pending | |
| server-genealogy | server | genealogy/index, signables | reads, guidance | pending | |
| server-governance | server | governance/index, esig/dsc | - | pending | |
| server-labels | server | labels/index | - | pending | |
| server-quality-receipt | server | quality/receipt | quality/lims | pending | |
| server-serialisation | server | serialisation/index | - | pending | |
| server-transfers | server | transfers/federation, index, keys, signables | reads, guidance | pending | |
| simulators | unit | - | opcua, erp, system-feed, serialisation servers and models | pending | |

Left out (Phase 6 touched a few lines of a file of an earlier phase; the file's own mutation is deployment's): the
server's `cli/*`, `config.ts`, `platform/http/*`, `devices/listener.ts`, `execution/seed-gmp.ts`,
`release/signables.ts`, `pqr/reads.ts`, `notifications/index.ts`, `designer/index.ts`, `esig/{index,content,guidance}.ts`;
kernel `db/command.ts`; recipe-core `flow/*`, `validator/rules-content.ts`; the simulators' `*/main.ts` entry points.

### Smoke run (preparation)

- `sdk-adapter` (unit, concurrency 4): 626 mutants in 21 s. Score 23.3 % (146 killed, 415 survived, 65 without
  coverage). With the base setting `ignoreStatic: true` 485 of them were skipped: the system contracts and the mirror
  classes are module-level zod schemas. The SDK's own tests (9) check little of the schemas; their behaviour is tested
  through the database (`platform.accept_inbound` validates the same envelope) and the server's adapter tests, which
  Stryker cannot connect to the SDK's mutants (above). Priority 2 work for the campaign: SDK-level tests of the
  envelope, mirror and system payload schemas.
- `server-serialisation` (server, concurrency 2): 159 mutants (38 static, skipped) in 330 s, of which about 30 s for
  the dry run with the server templates. Score 80.2 % (97 killed, 24 without coverage) against 90 %.

## Part 2: the Phase 4 leftovers

| Item | What runs | Result |
|---|---|---|
| Scope A kill confirmation (232) | release-gate, release-gate-market-items, manufacturer-release, tablets-release-items with `--only` on the survivors of the Phase 4 run (ids from that run's report; see the note on renumbering below) | pending |
| Scope B kill confirmation (118) | the six scope B groups with `--only` on the unconfirmed survivors | pending |
| us-disposition | first full run (146 mutants) | pending |
| qp-certification | first full run | pending |
| market-changes | first full run | pending |
| Stryker survivor triage | server release, records, India, archive and PQR features | pending |
| Whole SQL re-run | every group of `targets.ts`, under the decision 0009 organisation | pending |

Note on renumbering: a mutant id is `<function>#<n>`, numbered in the function's current definition. Phase 4's
`recipe.grel_core_items` survivors were numbered in recipe-core 0783 and the function is now 0932's; Phase 6 re-created
`recipe.grel_evaluate`. Before an `--only` confirmation, each survivor id is matched to the current mutant by its
line text, operator, original and replacement, not by number.

Equivalents to re-check before the whole re-run: `pnpm mutation:sql --audit-equivalents` lists 56 of the 248 entries
of `equivalent.json` that no longer fit their mutant (the place they cite is not the mutant's migration and line, or the
mutant number no longer exists), all from Phase 2 to 4 re-creations (recipe-core 0471, 0501, 0502, 0844, 0932; tablets
0702, 0715). A run applies only fitting entries and runs the others as ordinary mutants (D-P6j-M-4); each is moved to
its current number with its place updated, or dropped, by the part 2 triage.

## Survivors

pending

## Equivalent mutants

pending (`tools/sql-mutation/equivalent.json`; Stryker equivalents listed here with the reason)

## Real defects fixed

pending

## Residuals for the owner

pending

## Run plan

PLAN.
