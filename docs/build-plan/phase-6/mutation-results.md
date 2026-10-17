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
| sdk-adapter | unit | envelope, errors, mirror, reconciliation, systems/* | contract | 23.3 % overall (smoke run) | |
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
| server-serialisation | server | serialisation/index | - | 80.2 % / - (smoke run) | |
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

### inbound-adapters-and-mirrors (triage T3)

- First run (stream p6-5): 198 detected / 299 valid, **66.2 %** (101 survivors, 11 invalid).
- Kill tests: `packages/kernel/test/mutation/inbound-adapters-and-mirrors.test.ts` (19 tests, DI-20, DI-31, INV-26).
- Confirmation run (`--only` on the 97 survivors the tests aim at): **96 / 97 killed**. The one left,
  `iam.lms_qualification_payload_problem#19`, is killed by one more assertion (a numeric `validTo`), checked against
  the mutant on the real server (original and mutant side by side in a scratch schema: the original refuses, the
  mutant returns NULL); no third run.
- After triage: 295 killed, 3 equivalent, 1 residual: **99.7 %** of the non-equivalent mutants (98.7 % counting the
  equivalents as survivors).
- Defects (P1): none. Every survivor showed a rule that holds but that no test took to its deciding input.

Survivors, one line each:
- P2 killed: `iam.integration_adapter_guard#3, #25` (registered ACTIVE; decommissioned is final), `#7, #13, #15, #17,
  #19` (each identifying column alone; `registered_at` is a database time kernel 0500 keeps on update, so its own
  clause cannot fire, and its neighbours' mutants are killed through the other columns).
- P2 killed: `iam.set_integration_adapter_status#2, #9` (reason; unknown adapter); `iam.current_integration_adapter#2`
  (an integration account acting with source SYSTEM is not an adapter).
- P2 killed: `platform.inbound_envelope_problem#10, #12` (the year-9999 timestamp and the 1 MiB payload at their
  limits); `platform.record_inbound_refusal#7, #18, #20` (refusal text; source time at and past the limit);
  `platform.acknowledge_integration_alarm#3` (unknown alarm).
- P2 killed: `platform.record_reconciliation#2, #3, #5, #7, #9, #11, #13, #15, #17, #18` (each malformed report alone,
  the period ending at the limit), `#25, #27, #28, #30, #32, #34, #36, #38` (the [from, to) period and what counts as
  received), `#39 to #50` (accepted and refused counts), `#53` (same count, other checksum).
- P2 killed (stale mirrors): `platform.record_mirror_sync#3` (unknown class), `#26, #27, #29` (the check starts after
  the same adapter's proof at head 0), `#28, #30` (another adapter's head does not shorten it), `#31` (D-P6j-T3-2),
  `#33 to #37` (the first held number is the adapter's own, refusals included, resends not), `#38` (the head alone),
  `#42, #44` (another adapter's refusals fill no hole), `#49, #51, #54` (only the adapter's own gap alarm over the
  whole hole covers it).
- P2 killed: `iam.qualification_source_fresh#4, #6, #10, #12` (the STAND_IN heartbeat and the MIRROR bound, each fresh
  up to and including its bound).
- P2 killed: `iam.lms_qualification_payload_problem#1 to #27` (11 survivors, each rule alone at its limits);
  `iam.receive_lms_qualification#2` (message type), `#49` (a state as old as the applied one), `#56, #61 to #69`
  (supersession by a new end date), `#75 to #81, #91 to #96` (withdrawal touches one person's row only).
- Equivalent (`tools/sql-mutation/equivalent.json`): `platform.accept_inbound_detail#47` (v_seq = v_max is refused as
  a taken number before), `platform.record_mirror_sync#19, #25` (every held sequence number is at least 1).
- Residual: `platform.mirror_freshness#10`, the one microsecond of the database clock where the age equals the bound
  (D-P6j-T3-3).
- Finding for the lead (not P1): `platform.epoch_us_to_timestamptz` goes through double precision (D-P6j-T3-4).

### packaging-labels-and-line-completion (triage T3)

- First run (stream p6-5): 274 detected / 352 valid, **77.8 %** (78 survivors).
- Kill tests: `packages/site-services/test/mutation/packaging-labels-and-line-completion.test.ts` (label store, PR-32),
  `packages/recipe-core/test/mutation/packaging-labels-and-line-completion.test.ts` (templates and declarations, IN-31,
  PR-36), `apps/tablets-server/test/mutation/packaging-labels-and-line-completion.test.ts` (specimens, waiver, line
  stops, post-use inspection; PR-16, PR-34, PR-36, PR-39, IN-16).
- Confirmation run (`--only` on the 74 survivors the tests aim at): **74 / 74 killed** (no survivor).
- After triage: 348 killed, 0 equivalent, 4 left (one of them with a kill test added after the run, below): **98.9 %**
  (99.1 % counting that test's kill, which follows from the code: the mutant lets the G-23 step through to EBMR-LBL-036).
- Defects (P1): none. The post-use inspection gate and the waiver rules hold; the survivors were untested inputs.

Survivors, one line each:
- P2 killed: `site.open_label_store_transaction#2, #4, #5, #7, #14` (each malformed transaction alone), `#52, #63` (an
  issue of exactly the balance, a return of exactly what the order holds).
- P2 killed: `recipe.label_layout_fields#1 to #32, #34` (13 survivors: each malformed layout or element alone, a text
  or default is a value, 40 elements and an 80-character caption at the limit); `recipe.create_label_template#1 to
  #17` (9: each malformed template alone); `recipe.label_template_status#1` (another template's retirement,
  D-P6j-T3-1).
- P2 killed: `recipe.declare_packaging_labelling#3, #14, #16, #17, #20, #32, #33` (unknown version, form, option and
  template refused by name); `recipe.packaging_labelling_problem#2` (a declared item the draft no longer prints);
  `recipe.master_labelling#1, #3` (the view's state is the version's own).
- P2 killed: `tab.g21_coding_applies#1, #3` (printer or coded item, never vision alone); `tab.record_coding_specimen#5,
  #7, #12` (each malformed specimen alone); `tab.record_label_specimen#7, #10, #11, #12, #16` (note limits; one item's
  specimen does not stand for another's); `tab.void_packaging_specimen#2, #8, #12, #13` (unknown, reason limit, twice,
  another's withdrawal); `tab.g21_specimen_problem#9` (an item judged on its own label specimen).
- P2 killed (release gating, PR-34): `tab.record_post_use_inspection#2` (no G-21 step), `#11, #13, #14` (extra or
  non-boolean answer), `#15 to #19` (note limits, 1000 characters accepted); `tab.verify_post_use_inspection#2` (unknown),
  `#14, #17` (an earlier inspection is not verified over a later one of the order; another order's does not block).
- P2 killed: `tab.vision_line_stop#7, #9` (a rejection opens a stop while another order's is open, and after its own
  was resolved); `tab.resolve_line_stop#2, #8` (unknown stop; reason limit); `tab.enable_reconciliation_waiver#35, #41`
  (an item on its own declaration; CUT_LABEL with ELECTRONIC_100 qualifies); `tab.print_job_rules#6` (a step declared
  without a template releases a job on its layout).
- Killed by a test added after the confirmation run (not confirmed by a run; decision 0019 allows no third):
  `tab.g21_specimen_step#3`, a G-23 step in progress takes no specimen (EBMR-LBL-030); under the mutant the call goes on
  to EBMR-LBL-036, which the test does not accept.
- Residual (P2, time box): `tab.enable_reconciliation_waiver#16, #18`, the challenge must come through the gateway the
  device is bound to now; killing it needs a device re-bound to another gateway after a passing challenge.
- Residual (P2): `tab.refuse_incomplete_packaging#3` (`tg_op = 'INSERT'` to `<>`): the mutant only adds the
  completion check to an update that leaves EXECUTION_COMPLETE unchanged, a stricter refusal; reaching it needs a
  completed order whose completion problem changes afterwards.

## Equivalent mutants

pending (`tools/sql-mutation/equivalent.json`; Stryker equivalents listed here with the reason)

## Real defects fixed

pending

## Residuals for the owner

pending

## Run plan

### Constraints found while preparing

- **One cluster, one harness process with `--own-cluster`.** Between groups that process drops every `ebmr_%`
  database created since it started and not in use, which includes another run's templates on the same cluster. A
  second process on a cluster runs without `--own-cluster` (its own databases are still dropped at its end), and on
  5432, which other work shares, no process uses it.
- **About four test files per cluster at once.** The roles' connection limits are per cluster (kernel 0970:
  `ebmr_listener` and `ebmr_sandbox_listener` 40, `ebmr_app` and `ebmr_sandbox` 57, `ebmr_report` 4). Unlimited, Vitest
  runs a file per core, and the device-readings group's baseline fails with "too many connections for role
  ebmr_sandbox_listener" even alone on a cluster. `EBMR_MUTATION_VITEST_WORKERS` caps it: keep `--workers` times the
  cap at about 4 per cluster (`--workers 2` with a cap of 2), and Stryker's server features at concurrency 2 on a
  cluster no harness uses.
- **Separate report directories.** Each process writes its own `--out` directory (`report.json` after every mutant,
  `summary.md` at its end). Parallel runs never share one.
- **Resume.** A stopped process is started again with the same command plus `--resume`: the results its `report.json`
  holds for the same mutations are kept, the rest run (a fully kept group skips its baseline). A confirmation run
  (`--only`) uses a new `--out` directory and no `--resume` against the first run's report, which would keep the very
  results it is meant to replace. Stryker resumes by itself from the feature's incremental file (same command).

### Estimates

Worker time per mutant is taken as 0.9 times the group's baseline (db plus server, measured alone on 5433) and at least
6 s: the smoke run gave 8.8 s for a 10 s baseline, with 72 % killed (a killed mutant stops at its first failing file).
Running ten or more workers on 16 cores slows each one; the wall times below add a third for that.

| Group | Mutants | Baseline (s) | Worker hours |
|---|---|---|---|
| equipment-data-and-alarms | 469 | 46 | 5.4 |
| genealogy-and-recall | 440 | 49 | 5.4 |
| erp-wms-receipt-and-stock | 351 | 43 | 3.8 |
| transfer-and-federation | 393 | 37 | 3.6 |
| qms-capa-lims-cmms | 401 | 17 | 1.7 |
| packaging-labels-and-line-completion | 352 | 17 | 1.5 |
| inbound-adapters-and-mirrors | 310 | 17 | 1.3 |
| plant-rules | 221 | 21 | 1.2 |
| governance-support-and-contract-giver | 228 | 16 | 0.9 |
| controlled-substance-mode | 311 | 8 | 0.6 |
| governance-change-control | 117 | 10 | 0.3 (done in the smoke run) |
| reporting-and-training, india-dsc, serialisation-l3 | 388 | 5 to 6 | 0.7 |
| re-created functions in earlier groups (`--functions`) | 202 | 10 to 66 | about 0.8 |
| **Part 1 SQL** | **4,183** | | **about 27** |

Stryker, part 1: about 1.3 mutants per source line, three quarters of them tested (the rest static or not covered),
about 7 s of worker time per tested server mutant (`server-serialisation`: 97 tested in 330 s at concurrency 2,
including a 30 s dry run) and a few seconds per unit mutant whose tests start an OPC UA server (gateway, simulators;
the SDK's tests take a fraction of a second). The server features hold about 6,800 lines (about 13 worker hours),
the gateway and the simulators about 4,200 (about 4), the kernel's config and DSC modules 450 (about 1): **about 18
worker hours**.

With 12 workers, part 1 takes about **4 to 5 hours of wall time**, inside its 12-hour box; the triage and new tests
come on top, and one confirmation run per group (`--only` on the survivors that new tests aim at) is a fraction of the
first run.

Part 2 (baselines of all 80 earlier groups measured alone on 5433, all green with the cap of 4 test files):

| Item | Mutants | Worker hours |
|---|---|---|
| Scope A groups (release-gate, release-gate-market-items, manufacturer-release, tablets-release-items), run whole | 710 | 4.3 |
| Scope B groups (the six after-release, shipping, locking, bulk and form groups), run whole | 695 | 5.6 |
| us-disposition, qp-certification, market-changes, first runs | 481 | 4.3 |
| Stryker: server release feature (high-risk files first) and the triage of the Phase 4 survivors | | about 3 |
| **Whole SQL re-run of the 80 earlier groups** (scope A and B included) | **17,553** | **about 128** |

The scope A and B confirmations are best run as whole-group runs: the Phase 4 survivor lists are not in the repository
(the reports were lost with the container), several of their functions have been re-created since (their mutants are
renumbered), and a whole run of those ten groups costs about 10 worker hours. Those ten runs are also the first part of
the whole re-run.

**The whole re-run does not fit part 2's 8-hour box**: about 128 worker hours is 11 hours of wall time with 12 workers
before the slowdown, 14 with it. The largest groups are market-authorisation-and-issue (14 worker hours),
lots-and-lims (9), mbr-lifecycle (8), manual-weighing-gate (7) and tablets-ipc (6). Inside the box: the scope A and B
groups and the three Phase 4 groups first (about 2 hours of wall time), then the earlier groups in the order of decision
0019's Priority 1 subjects (signing, signature invalidation, audit trail, segregation and grants, release and serial
gating, limits), the rest a residual for the owner.

### Commands

From the worktree, after `pnpm install --frozen-lockfile`, in a shell that outlives the session (`tmux`, or each
stream under `nohup bash -c`). SQL, five processes of 2 workers each (cap 2 test files per
mutant), one per cluster:

```bash
export EBMR_MUTATION_VITEST_WORKERS=2 EBMR_MUTATION_TEST_TIMEOUT=120000
sql() { # <port> <out name> <groups> [extra flags]; runs in the foreground
  EBMR_PG_ADMIN_URL=postgres://ebmr_dev:ebmr_dev@localhost:$1/postgres \
    pnpm -s mutation:sql --group "$3" --workers 2 --out .reports/sql-mutation/$2 "${@:4}" > .reports/sql-mutation/$2.log 2>&1
}
mkdir -p .reports/sql-mutation
(sql 5434 p6-1 equipment-data-and-alarms --own-cluster) &
(sql 5436 p6-2 genealogy-and-recall --own-cluster) &
(sql 5437 p6-3 erp-wms-receipt-and-stock,plant-rules,india-dsc --own-cluster) &
(sql 5438 p6-4 transfer-and-federation,qms-capa-lims-cmms --own-cluster) &
# 5432 is shared: no --own-cluster; the functions Phase 6 re-created in earlier groups follow on the same stream.
(sql 5432 p6-5 inbound-adapters-and-mirrors,packaging-labels-and-line-completion,governance-support-and-contract-giver,controlled-substance-mode,reporting-and-training,serialisation-l3,governance-change-control
 sql 5432 p6-6 plant-equipment-and-areas,release-gate,tablets-release-items,read-authorisation,connection-roles,mbr-lifecycle,after-release-suspension,pqr-extract,lots-and-lims \
   --functions plant.fitness_problems,plant.record_calibration,recipe.grel_evaluate,tab.grel_recon_serial,tab.record_read_problem,sandbox.apply_connect_policy,sandbox.segregation_problems,recipe.guard_critical_elements_risk_assessed,recipe.genealogy_downstream_lots,recipe.pqr_run_query,site.lot_available) &
```

After a restart: the same stream with `--resume` added to each `sql` line. Progress: `grep -c . .reports/sql-mutation/<out>.log`
or the `n/N` lines; scores: `.reports/sql-mutation/<out>/summary.md`. governance-change-control runs again (7
minutes): the smoke run was on the preparation branch, before 6j-a and 6j-b were merged.

Stryker, two features at a time on 5433 (server and db features, concurrency 2), unit features alongside (no database):

```bash
st() { # <feature> [port]
  EBMR_STRYKER_FEATURE=$1 EBMR_STRYKER_CONCURRENCY=2 EBMR_PG_ADMIN_URL=postgres://ebmr_dev:ebmr_dev@localhost:${2:-5433}/postgres \
    nohup pnpm exec stryker run stryker.phase6.config.mjs > .reports/stryker-phase6/$1.log 2>&1
}
mkdir -p .reports/stryker-phase6
(for f in server-integrations server-transfers server-governance server-genealogy server-controlled server-labels \
          server-quality-receipt server-dashboards-and-training server-serialisation; do st $f 5433; done) &
(for f in kernel-config-and-dsc server-plant-rules server-config-change server-capa server-alarms server-equipment-data \
          server-designer-hazard; do st $f 5433; done) &
(for f in sdk-adapter sdk-equipment-data gateway-opcua simulators; do st $f; done) &
node stryker.phase6.config.mjs --summary      # per feature and zone, from the JSON reports
```

`server-serialisation` and `sdk-adapter` run again too (their smoke runs were on the preparation branch). A feature not done within an
hour is stopped and run again with `EBMR_STRYKER_HIGH_RISK_ONLY=1` (decision 0019); its incremental file keeps the
mutants already tested. When the SQL streams end, their clusters take the remaining server features (`st <feature>
5434`, and so on), one Stryker run per free cluster.

