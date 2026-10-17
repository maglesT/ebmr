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
| equipment-data-and-alarms | equipment, alarms, plant rules | 28 | 469 | 41 / 5 | 90 % | 307 / 469 | 65.5 % | 162 | 2 | 447 / 467, 95.7 % (confirmation 140 / 140) |
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

### equipment-data-and-alarms (triage T1)

- **First run** (stream p6-1): 307 / 469 detected, **65.5 %**, 162 survivors (27 GUARD_REMOVED, 70 LOGICAL, 34
  RELATIONAL, 6 NOT_REMOVED, 1 BOOLEAN at the first read; the rest in the tablets 1218 bridges at the end of the run).
- **New tests:** `packages/recipe-core/test/mutation/equipment-data-and-alarms.test.ts` (18 cases) and
  `apps/tablets-server/test/mutation/equipment-data-and-alarms.test.ts` (4): each payload form (alarm, equipment event,
  series chunk and sample, endpoint session, device original, OPC UA native record) refused one malformed
  field at a time, with the boundary length taken; the binding windows of `plant.batch_context_at` read at the exact
  microseconds they open and close; the enrolment, retirement and step-binding refusals; the bridged ALARM_CLEARED;
  the OPC UA data guard on owner-level writes; tablets 1210's DEV-121/170/172 refusals, which the listener's wire
  validator otherwise shields. 140 survivors are aimed at (the `--only` list of the confirmation run).
- **Equivalent:** `plant.acknowledge_alarm#8` (EBMR-ALM-010 is unreachable: a SERVICE or INTEGRATION account is refused
  the ACKNOWLEDGE permission first), `plant.alarm_problem#10` (`having count(*) >= 0` returns NULL as the original does).
- **Real defects (P1):** none. The 27 removed guards were reachable refusals the suite did not exercise at database
  level, or refusals a later layer repeats with the same code (D-P6j-T1-1); none let a wrong GMP write through.
- **Residuals:**
  - `plant.source_time_or_raise#4` (0960:442, `>` to `>=`): P3, a tolerance against `clock_timestamp()` at microsecond
    resolution; the exact instant cannot be hit deterministically.
  - `plant.acknowledge_alarm#5` (0976:28): P2, the per-batch scope loop runs after an unscoped ALARM.ACKNOWLEDGE check
    that a product-scoped person already fails (owner item O-T1-1), so no test person reaches the loop with a scope it
    would refuse.
  - `plant.acknowledge_alarm#28` (0976:47): P2, needs a GMP (non-test-run) batch with a linked deviation-lite record
    (`site.deviation_ref_problem` refuses test runs); not done in the time box.
  - `plant.bind_step_equipment#14` (0960:496): P2, needs the same step bound to the same unit in an earlier use by
    another batch; time box.
  - `tab.bridge_process_alarm_ack#2, #6`, `tab.bridge_device_alarm#1-#5`, `tab.bridge_step_device#3, #5-#12` (tablets
    1218): P2, the last mutants of the run, reached after the time box; they need the gateway alarm and G-06
    acknowledgment world of `alarms/alarm-bridge.test.ts`.
- **Confirmation run** (`--only` on the 140 aimed at, 2034 s): **140 / 140 detected**. The group stands at 447 / 467
  valid (469 less 2 equivalent), **95.7 %**, with the 20 residuals below.
- **Owner item O-T1-1:** `plant.acknowledge_alarm` (recipe-core 0976) checks ALARM.ACKNOWLEDGE unscoped before the
  per-batch loop, so a person whose OPERATOR grant is scoped to one product is refused (EBMR-IAM-040 "in scope {}") even
  for an alarm bound only to a batch of that product. The Q-6b-1 test in `plant-rules/room-rules.test.ts` passes on that
  first check, not on the per-batch one. Stricter, never weaker; whether product-scoped people should acknowledge their
  own product's alarms is the owner's call.

### plant-rules (triage T1)

- **First run** (stream p6-3): still running at triage (65 / 221 mutants; 23 survivors, of which 16 in
  `iam.person_area_authorised`, `site.record_reagent_lot`, `site.withdraw_reagent_lot` and `site.reagent_lot_problem`
  were triaged; the later ones in `plant.set_area_rule`, `plant.record_spill`, `plant.room_start_problem` and after are
  not). Score: pending the end of the run.
- **New tests:** `packages/kernel/test/mutation/plant-rules.test.ts` (an area authorisation read at the microseconds it
  is recorded, valid from, valid to and withdrawn: `iam.person_area_authorised#5, #7, #10, #13`) and
  `packages/site-services/test/mutation/plant-rules.test.ts` (a reagent lot refused one malformed field at a time, an
  expiry equal to the preparation, withdrawal of an unknown lot or without a reason, the lot read at the microseconds it
  is recorded, expires and is withdrawn: `site.record_reagent_lot#1, #5, #14, #17, #20, #23, #30`,
  `site.withdraw_reagent_lot#2, #6`, `site.reagent_lot_problem#2, #3, #5, #6`).
- **Equivalent:** none. **Real defects (P1):** none.
- **Residuals:** `site.record_reagent_lot#34` (0940:77, `preparedAt > clock_timestamp()` to `>=`): P3, a clock instant
  that cannot be hit deterministically. The survivors after the first 65 mutants are not triaged (time box).
- **Confirmation run:** not run (D-P6j-T1-3): once the first run ends, one `--only` run on the ids above and on the
  later survivors' tests.

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

### erp-wms-receipt-and-stock (triage T2)

- **First run:** 207 / 350 detected (1 invalid), 59.1 %; 143 survivors (80 logical, 31 relational, 26 guard removals,
  4 not-removed, 2 boolean).
- **Killed by new tests (confirmation run, `--only` on 125 survivors): 118.** Tests in
  `packages/site-services/test/mutation/erp-wms-receipt-and-stock.test.ts`: every field of every ERP/WMS message type on
  its own (site.erp_payload_problem, 34), erp_source_value_ok and calendar_date_ok (4), receive_delivery and
  receive_supplier_batches' refusals and inclusive limits (2 + 28), record_lot_receipt (8), record_receipt_examination (3),
  receipt_problem (2), propose/approve/withdraw manufacturer (3 + 3 + 2), correct_lot_receipt_value and
  lot_receipt_effective per lot and field (10 + 5), the equal-timestamp WMS status (apply_wms_lot_status#12), the unit of
  a WMS move (apply_wms_stock_move#11), the lot named in the issue problem (erp_lot_status_problem#3), the WMS
  location question (3), resolve_lot_location_exception (3), the outbound queue (pending#2, delivered#3/#6,
  failed#3/#7, from_fact#2/#6).
- **Equivalent (7, in `equivalent.json`):** propose_approved_manufacturer#1, receive_supplier_batches#1,
  receive_delivery#1, record_lot_receipt#9, record_receipt_examination#15 (the first `or` of `p is null or not an object
  or <field check>` made `and`: for a non-object every field read is NULL, so the field check raises anyway);
  receive_supplier_batches#50 (mirror_freshness never returns a NULL 'stale'); erp_outbound_delivered#11 (only a stock
  block payload names a request, and a repeated delivery meets the conflict).
- **Defects (P1):** none from the survivors.
- **Defect M6-D1 (medium, fails safe; fixed in site services 1002):** found while writing the tests, not a survivor.
  site.receive_supplier_batches numbered generated lot codes from `count(*)` of the day's GR codes but advanced the
  counter for a batch whose lot code stores typed, so after a delivery with a typed code on a batch other than the last,
  the next generated code of the day already existed and every later receipt that day failed on
  `material_lot_site_code_lot_code_key`. No wrong record was written; receiving stopped until the next day. The fix takes
  the next number from the highest generated code of the day, advances it only for a batch without a typed code and skips
  a code already held (codes unique, never reused, gaps allowed; no cut to four digits past 9999). Test: `[PR-17] a lot
  code typed by stores on any batch never makes a later receipt of the day reuse a generated code` (failed before with
  the duplicate key, passes after); the kill test now types the code on the first batch again. Defect log entry in
  `docs/handbook/08-defect-log.md`. The equivalents receive_supplier_batches#1 and #50 now cite 1002:37 and 1002:67
  (the mutants keep their numbers; `--audit-equivalents` reports them fitting).
  - **D-P6j-T2-1 (lead):** M6-D1 is fixed now under decision 0008 although it is not Priority 1: it stops all receiving
    for the rest of the day. The function stays in erp-wms-receipt-and-stock; targets.ts is unchanged.
- **Residuals (18):**
  - approve_manufacturer#6-#10 (0910:301) and erp_outbound_delivered#13 (0916:57): the WHERE of a `for update` lock;
    only concurrent approvals or deliveries tell them apart (a two-session test was not reached in the time box).
  - approve_manufacturer#16 (0910:309, the signature-state refusal): the proposal's content and state do not change
    between signing and approving, so assert_signature or the already-approved check refuse first; not proven
    equivalent (approval and withdrawal rows vs the content provider not checked in the time box).
  - receive_supplier_batches#22, #24, #27, #29, #30, #31, #32 (0910:388-391, EBMR-SITE-105, a material known at the site
    as another kind or with a vendor route): needs a lot of the material under another kind; not reached (P2).
  - receive_supplier_batches#94 (0910:433, `<=` to `<` on expiry against clock_timestamp()): equal to the microsecond
    cannot be set up deterministically.
  - receive_supplier_batches#52 (0910:409, the daily code counter counting the site's other lots): codes stay unique but
    skip numbers (P3, numbering).
  - erp_outbound_from_fact#7 (0912:178, the yield message's lot): needs a finished lot; not reached (P2).
  - location_move_problem#18 (0916:212): the ' but <dates problem>' part of a message (P3).
- **Confirmation score:** 325 / 343 valid non-equivalent = 94.8 %.

### qms-capa-lims-cmms (triage T2)

- **First run:** 239 / 399 detected (2 invalid), 59.9 %; 160 survivors (51 guard removals, 48 logical, 42 relational,
  10 boolean, 9 not-removed).
- **Killed by new tests (confirmation run, `--only` on 149 survivors): 147.** Tests in
  `packages/site-services/test/mutation/qms-capa-lims-cmms.test.ts` (CAPA commands, resolver, QMS and LIMS receiving
  commands, the QMS fetch at release) and `packages/recipe-core/test/mutation/qms-capa-lims-cmms.test.ts` (CMMS
  commands and the maintenance rule, the QMS guard on QP certification and after-release reconfirmation, G-REL's QMS
  item). Killed by function: site.raise_capa (20), plant.receive_cmms_maintenance (14), plant.receive_cmms_calibration (9),
  site.receive_lims_sample_result (10), recipe.qms_release_guard (9), register_capa_master_resolver (7),
  schedule_capa_effectiveness_check (7), record_qms_release_fetch (7), capa_content (6), link_capa_deviation (6),
  cancel_capa (6), receive_qms_capa (6), record_capa_effectiveness (5), site.capa_master_version_facts (4),
  receive_qms_deviation_status (4), receive_qms_change_control (4), link_capa_master_version (3), lock_capa (2),
  record_capa_implemented (2), qms_payload_problem (2), close_capa (2), capa_view (2), plant.cmms_accept (2),
  recipe.grel_qms_item (2), recipe.capa_master_version_facts (2), capa_state, capa_close_problem, qms_accept,
  qms_assert_newest, plant.cmms_maintenance_problems (1 each).
- **Equivalent (4, in `equivalent.json`):** site.receive_lims_sample_result#11, plant.receive_cmms_calibration#2,
  plant.receive_cmms_maintenance#2 (the not-an-object guard: the stored payload is an object by constraint and the
  envelope check refuses any other first, kernel 1180); site.close_capa#6 (the signature-state refusal: a CAPA's state is
  in its signed content, so esig.assert_signature refuses a changed state first).
- **Defects (P1):** none. Every survivor was a correct rule without a test, or equivalent.
- **Killed after the confirmation run (not re-run, decision 0019 allows no third run):** site.receive_lims_sample_result#70
  (0926:106, `and` to `or` refuses every newer state of a sample and test); one assertion added: a newer state of the
  same sample and test is applied.
- **Residuals (8):**
  - site.qms_release_problem#10 (0927:100, `>` to `>=` on the fetch age against a running clock): equal to the
    microsecond cannot be set up deterministically.
  - plant.receive_cmms_calibration#55 (0950:156, `<=` to `<` on due start against clock_timestamp()): the same.
  - recipe.capa_master_version_facts#9 (0952:31, `>` to `>=` on effective_from against clock_timestamp()): the same.
  - site.close_capa#16 (0925:759, initiator guard): reached only with a CAPA_CLOSED signature by the initiator, which the
    meaning's entered-by exclusion refuses first (EBMR-ESIG-044, existing test); kept as defence in depth, not equivalent
    because the exclusion is policy data.
  - site.capa_view#7-#9 (0925:340, the batches of each linked deviation in the view and the CAPA_CLOSED content):
    needs a deviation linked to batches; not reached in the time box (P2).
  - site.raise_capa#88 (0925:545, the reference serial scoped by site and year): needs a CAPA of another site or year
    in the same database; not reached in the time box (P2, numbering only).
- **Confirmation score:** 386 / 395 valid non-equivalent = 97.7 % (98.0 % with #70).

### genealogy-and-recall (triage T4)

- First run (stream p6-2): 291 detected / 440 valid, **66.1 %** (149 survivors).
- Scope (owner, 17 October): only survivors that could let the genealogy or a mock recall silently drop a lot,
  consignee or depth level, or that touch the recall's sign-off (signature binding, the AP-only permission), were
  chased; the rest is recorded below in one line per kind.
- Kill tests: `packages/site-services/test/mutation/genealogy-and-recall.test.ts` (the instant world of D-P6j-T4-1:
  every edge kind as of the exact instant it happened, both directions, with decoys; node existence per kind; the
  recall's per-lot reconciliation and outbound transfer; the impact query; the sign-off; PR-57, IN-29, PR-50, DI-37).
- Confirmation run (`--only` on the 80 survivors the tests aim at): **79 / 80 killed** (98.8 %);
  `recipe.deviation_impact_batches#32` survived (below).
- After triage: 370 killed, 11 equivalent, 59 left: **86.2 %** (370 / 429; below the 90 % target, the rest recorded or
  residual within the owner's scope).
- Defects (P1): none. Every survivor that could drop a lot, consignee or depth level was an untested input
  (an as-of point exactly on an event, an edge kind no test built); the code was right.

Survivors, one line each:
- P2 killed (a recall could drop a node): `recipe.genealogy_step#5 to #130` (46: the inclusive as-of comparison of
  every edge kind both ways; the CHARGED edge's container, batch and purpose joins; the backward SHIPPED, TRANSFERRED,
  addition and MERGED joins; the forward TRANSFERRED edge's own seal); `recipe.genealogy_node_exists#3 to #24` (16: a
  node of each kind exists from its own instant, a batch by its issue or by its register link alone, no other node's
  row stands for it, an unsealed package is no node).
- P2 killed (recall content): `recipe.mock_recall_result_v1#9, #11, #12` (each lot's own deliveries and returns, a
  return at the as-of instant); `recipe.mock_recall_starts#6`, `recipe.run_mock_recall#13, #16` (a lot or deviation
  and its links at the as-of instant); `recipe.deviation_impact_batches#4, #9, #14, #20, #24, #31, #34` (the as-of
  instant for the deviation, links, lot posting and consumption; a future as-of refused).
- P2 killed (sign-off, IN-29, DI-37): `recipe.sign_off_mock_recall#2` (unknown run), `#11` (a run that no longer
  reproduces is refused even with a valid signature), `#16` (a signer holding the permission through another role is
  refused, D-P6j-T4-2); `recipe.mock_recall_content#3` (another run's sign-off does not change this run's state).
- Equivalent (11, `tools/sql-mutation/equivalent.json`): clock-microsecond boundaries `recipe.genealogy#11`,
  `recipe.run_mock_recall#6`, `recipe.deviation_impact_batches#8`, `recipe.deviation_recurrence#11`,
  `site.record_chemical_recovery#59`, `site.erp_apply_shipment#49`; `recipe.sign_off_mock_recall#20` (EBMR-RCL-014
  repeats the content check the VALID signature already passed, under the run's row lock); unreachable branches
  `recipe.genealogy_step#131`, `recipe.genealogy_node_exists#25`, `recipe.mock_recall_run_query#3`;
  `site.record_chemical_recovery#19` (a non-object payload also fails the next disjunct).
- Recorded (message only): `recipe.genealogy#1, #3, #6, #8` (an unknown kind or direction is still refused by the node
  check, EBMR-GEN-002, or the step, EBMR-GEN-001; only which refusal comes first differs); `recipe.run_mock_recall#15`
  (a deviation not raised by the as-of point is still refused, EBMR-RCL-004 instead of -003).
- Recorded (lock only): `recipe.sign_off_mock_recall#5` (the row lock; a second sign-off is still refused by the unique
  sign-off row).
- Residual (P2, not chased per the owner): `recipe.genealogy#30, #31` (the 200,000-edge cap: at the cap or with the
  guard removed the trace is answered in full, never cut short; a test needs 200,000 rows).
- Residual (P2, not chased): `site.record_chemical_recovery#5, #12` (recovery at another site, or of returned goods no
  longer in quarantine or rejected) and `#21 to #63` (16: each malformed field alone, the 200-character limits, a
  retest on the expiry); `site.erp_apply_shipment#2 to #29` (13: each malformed shipment field alone, the 200 and 500
  character limits, an explicit market).
- Residual (P2, not chased): `site.erp_shipment_distribution_fields#2`, `recipe.lot_dosage_form#2` (the strength and
  dosage form on a distribution record are another lot's when lots differ; every test lot is 500 mg tablets).
- Residual (P2, not chased): `recipe.deviation_of_product#3, #4, #6` (the recurrence count of deviations linked by
  batch rather than by lot, PR-49).
- Residual (P2, survived the confirmation run; no second run per decision 0019): `recipe.deviation_impact_batches#32`
  (`c.lot_id = any (v_lots)` to `<>`, 1012:351): the mutant adds every batch that consumed any other lot as SHARED_LOT,
  an over-inclusion that never drops a batch; killing it needs a batch consuming a lot no linked batch consumed.
- Recorded (display): `recipe.genealogy_node_views#12 to #28` (14: sub-kind, state and label of a node in the explorer
  and the federated excerpt).

### controlled-substance-mode (triage T6)

- First run (stream p6-5): 207 detected / 311 valid, **66.6 %** (104 survivors).
- Scope (owner, 17 October): possible P1 defects of draft control IN-53 (dual custody, the account closing at a stage
  sign-off and at batch completion) and untested high-risk rules (signatures, limits, the gate); the rest is recorded
  below, grouped, not chased.
- Kill tests: `packages/site-services/test/mutation/controlled-substance-mode.test.ts` (7 tests: custody, checkpoint
  and flag signatures recorded only by their signer and only in the state they were given in; the kernel's refusal of
  the first custodian as the second; a pending flag over an approved one; custody quantities against the lot and the
  batch's holding; a stage sign-off reads its own stage, batch and controlled API; IN-53, DI-35, INV-03).
- Confirmation run (`--only` on the 27 survivors the tests aim at): **27 / 27 killed**.
- After triage: 234 killed, 2 equivalent, 75 left: **75.7 %** (234 / 309; below the 90 % target, the rest recorded or
  residual within the owner's scope).
- Defects (P1): none. Checked: a second custodian who is the first or the proposer is refused by the kernel at signing
  (D-P6j-T6-1), with the command's EBMR-CSM-022 behind it; a dispensing, transfer, return or destruction without the
  countersignature is not counted or covered (the CONFIRMED checks of the consumption guard, the transfer cover and the
  balance were all killed); the checkpoint table itself keeps the account identity, non-negative figures and "a
  difference only with an explanation and the batch's deviation", so no checkpoint closes with an unexplained balance
  even with the command's checks removed. The stage-selection survivors (below) were untested, not wrong.
- Observation (not a defect): a countersignature given while the record is still PROPOSED is refused when recorded
  (EBMR-CSM-023), and the kernel then refuses that witness a second COUNTERSIGNED signature on the record (EBMR-ESIG-042);
  that record cannot be completed and a new one is proposed. The custody screen asks the second signature only in
  AWAITING_COUNTERSIGN, so this needs a direct call.

Survivors, one line each:
- P2 killed (signature binding, IN-53, DI-35): `recipe.sign_controlled_custody#24` (a countersignature given in
  PROPOSED), `#29` (a third custodian records the witness's signature); `recipe.sign_controlled_checkpoint#21`,
  `plant.approve_controlled_product#20` (another person records the signature).
- P2 killed (limits): `recipe.propose_controlled_custody#19, #21, #22, #25` (zero, seven decimals, another unit),
  `#47, #48, #72, #73` (a transfer or dispensing above the lot's quantity, and exactly at it), `#67, #69` (a dispensing
  into a completed batch), `#77, #79, #81, #84, #85` (a return counts this batch's own consumption of this lot, less its
  own returns awaiting or confirmed, never a proposal; exactly what is left may be returned).
- P2 killed (the stage gate): `recipe.controlled_checkpoint_problem#2, #4` (another stage's or another batch's signed
  checkpoint closed the stage); `recipe.controlled_moved_materials#1 to #4` (an API consumed before the flag; a batch
  that consumed only an excipient); `recipe.controlled_balance#2` (the excipient counted as dispensed API);
  `plant.controlled_materials#7` (a pending flag adding an API over an approved flag counts at once).
- Equivalent (2, `tools/sql-mutation/equivalent.json`): `plant.controlled_materials#2` (a not-controlled record names
  no material), `#12` (a pending record is never the approved one).
- Recorded (later layer): `recipe.sign_controlled_custody#17, #20` and `plant.approve_controlled_product#11` (the
  kernel's meanings refuse the signature, D-P6j-T6-1); `recipe.sign_controlled_custody#2`,
  `recipe.sign_controlled_checkpoint#2`, `plant.approve_controlled_product#2` (an unknown record: the signature
  assertion refuses); `recipe.sign_controlled_custody#7` (a third signature: the (custody, position) key);
  `recipe.sign_controlled_checkpoint#8` (a second signature: the checkpoint key; a superseded checkpoint is never read,
  the gate takes the latest), `#12` (a checkpoint the account has moved past: the gate re-checks it, EBMR-CSM-042),
  `#16` and `plant.approve_controlled_product#15` (the state problem after EBMR-CSM-039 / -005, which already refuse
  every changed state); `recipe.propose_controlled_custody#2, #4, #9, #13, #15, #34, #52` (lot, kind, location and
  batch shape: the cast, the table checks and the foreign keys); `recipe.record_controlled_checkpoint#1, #3, #14, #25,
  #27, #33` (batch, stage, decimal and unit shape: the cast, the foreign key and the table checks, negatives included).
- Recorded (fail-closed): `recipe.controlled_sign_off_guard#1, #4`, `recipe.controlled_batch_end_guard#1` (the guard
  runs on more rows); `plant.controlled_record_state#2` (a newer record of another product supersedes: approval refused).
- Recorded (record hygiene, no rule reads it): `recipe.propose_controlled_custody#30, #89, #90` (a batch named on a
  transfer is dropped; locations named on a batch act are stored); `recipe.record_controlled_checkpoint#20` (a checkpoint
  of a non-controlled material), `#64, #66, #67, #68, #71` (an explanation or deviation named with no difference; a blank
  explanation is stored as none); `plant.record_controlled_product#2, #3, #4, #7, #9, #15, #17` (flag shape: a duplicate
  material collapses, a mismatch of `controlled` and the list restricts nothing beyond what QA recorded and a second QA
  approved); `recipe.controlled_checkpoint_state#2, #4, #6` (which old checkpoint is marked superseded; the gate reads
  the latest); `recipe.controlled_moved_materials#5, #6, #7` (a material moved by a custody record alone has a zero
  account).
- Recorded (message, display, signed-content fields): `recipe.record_controlled_checkpoint#37`,
  `recipe.controlled_custody_content#2`, `recipe.controlled_checkpoint_content#2, #4`, `plant.controlled_product_state#1,
  #2`, `tab.controlled_preview#2, #6`, `tab.controlled_signing_content#2` (the preview's pair check; the commands assert
  the meaning).
- Residual (P2, not chased per the owner): `recipe.controlled_register_v1#3, #5, #7, #10 to #13` (the register's
  joins and filters: another material's or an unconfirmed movement; each test has one material) and
  `recipe.run_controlled_register#1 to #7` (the period's validation); reproducibility itself is killed.
- Residual (not chased): `recipe.sign_controlled_custody#34` (the batch epoch is bumped for a transfer instead of a batch
  act: the screens re-read on the next bump), `recipe.controlled_checkpoint_current#13` (an account in two units:
  recording a checkpoint is refused then, EBMR-CSM-034).

### serialisation-l3 (triage T6)

- First run (stream p6-5): 68 detected / 112 valid, **60.7 %** (44 survivors).
- The release gate and the stale mirror: `tab.l3_release_problem` and `tab.l3_tasks_of` have no survivors.
- Kill tests: three more steps in `apps/tablets-server/test/integrations/l3-adapter.test.ts` (the malformed and stale
  messages test): staleness is per task, an older state of the same task is refused, a repeat at the same change time
  lands (PR-42, DI-31).
- Confirmation run (`--only` on the 3 survivors the tests aim at): **3 / 3 killed**.
- After triage: 71 killed, 41 left: **63.4 %** (71 / 112; below the 90 % target; the rest is fail-closed, a later
  layer or display, recorded below).
- Defects (P1): none.

Survivors, one line each:
- P2 killed (stale mirror): `tab.receive_l3_message#114` (another task's later change refused a new OPEN task, so the
  release would not see it), `#120` (an older state of the same task), `#119` (same change time).
- Recorded (later layer): `tab.receive_l3_message#2, #4` (another message type: the decommission-task shape or the
  table checks refuse it), `#17, #19, #26, #28, #30, #72 to #90, #92` (each malformed field is still refused by a table
  check, event id, action, SSCC, counts, task id, state, or by the pool, shipper and order lookups; only unknown keys and
  the reason's characters and length are not), `#37, #97` (an unknown pool: the shipper lookup or the order comparison
  refuses, EBMR-L3-103); `tab.assert_pool_rejection#2` (its caller refuses an unknown pool).
- Recorded (fail-closed, D-P6j-T6-1): `tab.record_pool_rejection#2, #5 to #8, #10, #14 to #26` (it only records an
  OPEN task, a release block).
- Recorded: `tab.receive_l3_message#42` (message only), `#53` (an aggregation at the same event time: clock boundary),
  `#117` and `tab.record_pool_rejection#34` (the same task id in another pool; the L3 issues task ids per system);
  `tab.serial_lookup#1, #3, #9, #10` (the serial query's answer validation: a display read, not a release gate).

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

