# Phase 7 mutation results (D-P7-1 item 4, decision 0019's rules)

The focused mutation campaign of the Phase 7 exit (slice 7f), on the pod (16 vCPU), from commit ef8718f4 (the 7f branch
after final run 1): the SQL harness on every database function Phase 6A and Phase 7 added (25 groups) or re-created in
an earlier group (41 functions in 14 groups, run with `--functions`), and Stryker on the six features of
`stryker.phase7.config.mjs` (the analytics package and runner, the gateway feed signature, the adapters' TLS, the IQ
checks, the build-status tool). Priorities, the run limit (one first run, at most one confirmation run per group) and
the time boxes (6 pod hours SQL, 4 Stryker) are those of D-P7-1 item 4. Scores are detected over valid mutants (an
invalid mutant and a recorded equivalent leave the denominator); targets are reported, never a gate (D-P7-1 item 2:
the targets belong to the validated build at deployment). Only an unfixed Priority 1 survivor blocks the release
candidate: there is none.

## Campaign record

- SQL: four streams from 08:09 to 10:27 UTC on 19 October (s1 5432, s2 5433, s3 5434, s4 5436; 3 or 4 workers each),
  2,210 mutants. Triage T1 to T4 (six agents, each in its own worktree and cluster) from 08:55 to 11:25; confirmation runs
  in `.reports/sql-mutation-p7/confirm/` (not committed). Within the 6-hour box.
- Stryker: 08:50 to 11:30, four worktrees (parallel runs in one worktree copy each other's sandboxes, D-P6j-L-5);
  triage T5 on the Priority 1 files with one `--mutate` confirmation run per file group. Within the 4-hour box.
- Harness defect found and fixed (M7-T3b-1, high, test tooling): the first-run set-up tests built their own templates
  from the migrations, so no mutant reached them (0/47 at first run). The harness now hands the mutant to such tests
  (`EBMR_SQL_MUTANT`, `applyPreparedMutant`), with a harness test. Other features' tests that build fresh templates the
  same way may have been under-measured in earlier campaigns: a residual for the deployment re-run.
- Stryker tooling fixed: a feature whose tests import the mutated files through a workspace package name (the IQ tests,
  `@ebmr/validation-kit`) aliases the package to the sandbox's sources (`vitest.stryker-phase6.config.ts`); the first IQ
  run had no coverage at all for that reason.
- No product defect was found by the campaign. No new migration.
- `--audit-equivalents`: 58 of 338 entries no longer fit their mutant (all from earlier phases; the definitions they cite
  were re-created since). A run tests them as ordinary mutants; correcting them is a residual for the deployment re-run.

## Summary

| Part | First run | After triage | Priority 1 open |
|---|---|---|---|
| SQL, 25 Phase 6A and 7 groups | 930 of 1,443 mutants detected | every group at or near 100 % of valid (tables below); 1 Priority 1 boundary mutant not testable (`iam.first_run_setup#11`, the token expiry `>` to `>=` at one microsecond: residual for the owner) | none fixable |
| SQL, 41 re-created functions in 14 groups (13 with mutants) | 654 of 767 mutants detected | 743 / 748 valid after triage; 5 Priority 3 clock-boundary mutants left | none |
| Stryker, Priority 1 files | feed signature 32/43, adapter TLS 74/88, audit methods 605/856, runner pool and audit (first run in the feature) | 41/43, 84/88, 95.1 % then hand-checked, 98.96 %; the rest equivalent or unreachable, each with its reason | none |
| Stryker, other high-risk | analytics-methods 980/1,364, runner 272/737 (worker-thread code unreachable by Stryker), IQ 189/401, build-status 229/328 | Priority 2 partly handled (T5: registry guards and input lists); IQ and build-status not triaged (box): residuals with their scores | not Priority 1 |

The Stryker first-run scores per zone (`node stryker.phase7.config.mjs --summary`):

| Feature | Zone | Detected / valid | Score | Target |
|---|---|---|---|---|
| analytics-methods | high-risk | 980 / 1364 | 71.8 % | 90 % |
| analytics-methods | other | 2336 / 3550 | 65.8 % | 80 % |
| analytics-runner | high-risk | 272 / 737 | 36.9 % | 90 % |
| analytics-runner | other | 433 / 1135 | 38.1 % | 80 % |
| feed-signature | high-risk | 32 / 43 | 74.4 % | 90 % |
| adapter-tls | high-risk | 74 / 88 | 84.1 % | 90 % |
| iq | high-risk | 189 / 401 | 47.1 % | 90 % |
| iq | other | 4 / 113 | 3.5 % | 80 % |
| build-status | high-risk | 229 / 328 | 69.8 % | 90 % |

## Triage sections

## Stream 1 triage (T2): analytics-foundation, analytics-audit, release-identity, batch-scope-remaining

Confirmation runs: `.reports/sql-mutation-p7/t2-confirm-found`, `t2-confirm-audit`, `t2-confirm-rel`, `t2-confirm-scope`.
No defects were found, so there is no new migration. kernel 1398 and recipe-core 1290 and 1291 are unused.

### analytics-foundation (kernel 1242, 1280; DI-51, DI-52, DI-53)

- First run: 193 detected of 266 valid (72.6 %).
- After triage: 265 of 265 valid (100 %). The confirmation run detected 72 of the 73 survivors. The one left is equivalent.
- Survivors by priority:
  - Priority 1 (analytics segregation, restricted person flags), 46 survivors:
    - `register_input` (31): the input allow-list. No test called it, because the template registers the inputs during migration. A new test registers inputs in a rolled-back transaction. It covers a table, a view outside the report schema, a missing view, a wrong version, a view that reads a volatile function, a volatile or non-report or missing function, and a bad kind. It also checks that exactly the right SELECT and EXECUTE grants are made.
    - `role_problems` (5): the exemption for functions a catalogued view reads. A new test checks that EXECUTE on a function a catalogued view reads is accepted, and that it is reported on a function only an uncatalogued view reads.
    - `person_flags` (10): the period guard (a null bound, the first bound after the second, equal bounds). Also the half-open window at the exact instants, and that only restricted flags of DONE runs are returned, with no duplicates.
  - Priority 2 (guards and state), 27 survivors, all killed:
    - `begin_run`: a missing filter, the version as a string, a filter that is a number, and the package, commit or node missing or blank.
    - `effective_reference_sets`: the id of an EFFECTIVE method version is refused as a reference set (EBMR-ANA-002).
    - `record_output` and `record_flag`: a blank reference, a null kind, and a bad subject kind, rule or severity.
    - `reasons_ok`: null reasons, a code that is missing or not a string, a text that is blank or not a string, and elements that are not objects.
    - `record_disposition`: a flag of an open or failed run, a cause of exactly 10 characters, and a deviation reference that is blank or given.
    - The run locks: two racing ends of the same run (the second waits on the run row and is refused with EBMR-ANA-006, not a key violation). An open flag writer does not hold back another output or flag of the same run.
  - Priority 3: none.
- Defects: none.
- Equivalent, 1 (`tools/sql-mutation/equivalent.json`):
  - `analytics.begin_run#28` (1242:152, `and` to `or` before the registry look-up): a non-object element, or a view that is not a string, finds no registry row either way, because the registry names are `report.<name>_v<n>`. So the next test refuses the input with EBMR-ANA-003 in both forms.

### analytics-audit (kernel 1260, 1261; recipe-core 1150, 1151)

- First run (stream 1): 84 detected of 131 valid (64.1 %); 47 survivors.
- After triage (confirmation run `.reports/sql-mutation-p7/t2-confirm-audit`, the 47 survivors): 46 killed, 1 equivalent
  (recorded in `tools/sql-mutation/equivalent.json`), so 130 detected of 130 valid (100 %).
- Survivors by priority: all 47 are Priority 1 (the restricted audit-trail flags: kernel 1260/1261, recipe-core
  1150/1151, DI-53 drafts). None left open.
  - report.auth_fact_rows_v1 (8): the 26-week boundary of logins, failures and lockouts, and the filters on outcome,
    purpose, event and human account (another purpose, a success, an unlock, the service account's failure and lockout,
    rows older than 26 weeks).
  - report.execution_command_events (9), report.execution_points (4), report.audit_facts (7),
    report.manual_digit_rows_v1 (4): the window's first instant (one-statement fixture at statement time less 182 days),
    the one-hour look-back of command rows, an earlier audit event of another table in the issue correlation, the
    point named by a void, a device entry, a branch point's failure flag, a person's configuration insert, a batch with no
    deviation link, a sandbox batch, a point whose recorded sequence is not a number, and the facts given by event id.
  - analytics.audit_flags (10): the period's guard (null bounds, reversed bounds, an empty period allowed) and its
    first and last instants, flags of a failed run and unrestricted flags left out, and the superseding verdict as the
    key's verdict.
  - analytics.audit_flag_entries (5): EBMR-ANA-007 without ANALYTICS.DI_REVIEW, a flag's own events only (not another
    flag's, not another evidence kind's), none for an unrestricted flag or a failed run's flag.
- Tests: `packages/recipe-core/test/analytics/audit-inputs.test.ts`, five new tests named [DI-53] / [DI-51].
- Defects: none.
- Equivalent mutants:
  - report.execution_command_events#2 (1150:49, `and` -> `or` in the corr CTE): with ids given, corr becomes every
    correlation; the pairing numbers each correlation whole and the caller joins only the events it named, so no
    returned row changes.

### release-identity (kernel 1300; DI-03)

- First run: 27 detected of 32 valid (84.4 %).
- After triage: 32 of 32 (the 5 survivors killed in the confirmation run `.reports/sql-mutation-p7/t2-confirm-rel`: 5 of 5 detected, 100 %).
- Survivors, all Priority 1 (release identity and the validation-summary approval, DI-03):
  - `platform.validation_summary_content` line 122 (3: `=` to `<>` twice, `and` to `or`): the signed content's state was only ever read for a never-approved summary. Killed by the new test `[DI-03] the signed content is APPROVED only for the approved release and summary pair...` (APPROVED for the approved pair, PROPOSED for another summary of the same release and for the approved hash under another release).
  - `platform.approve_validation_summary` line 141 (`>` to `>=` on the 200-character title) and line 150 (`and` to `or` in the already-approved check): killed by the same test (a 201-character title refused, a 200-character title accepted, and a second summary of the same release approved on its own).
- Defects: none. Equivalent mutants: none.

### batch-scope-remaining (recipe-core 1218; IN-04)

- First run: 1 detected of 3 valid (33.3 %).
- After triage: 3 of 3 (confirmation run `.reports/sql-mutation-p7/t2-confirm-scope`: 2 of 2 detected, 100 %).
- Survivors, both Priority 1 (batch scope, IN-04):
  - `recipe.require_issue_permission` line 41 (guard removed: no ISSUE row in the command catalogue) and line 45 (`=` to `<>`: the first catalogued permission the issuer holds). The seeded catalogue lists BATCH.ISSUE alone and is insert-only, so neither branch was reachable through the normal set-up. Killed by the new test `[IN-04][DI-21] the issue command's check asks for the first of its catalogued permissions the issuer holds...`, which changes the catalogue past its triggers as the superuser in a transaction that is always rolled back.
- Defects: none. Equivalent mutants: none.

### Stream 2, triage T1 (gateway feed signature, full export, evaluation pack, analytics method change, interface drift, validation-summary gate)

Tests added in commit d8f0d787 (branch phase-7/slice-7f-mut-t1), in the group test files named by targets.ts.
Confirmation runs: `.reports/sql-mutation-p7/t1-confirm/<group>/report.json` (one per group, survivors only).
Scores are detected/valid, where valid leaves out invalid mutants and the equivalents recorded in
`tools/sql-mutation/equivalent.json`.

| Group | First run | After triage (confirmed) | Survivors by priority | Defects | Equivalent |
|---|---|---|---|---|---|
| gateway-feed-signature | 50/93 (53.8 %) | 91/91 (100 %) | P1 43 (41 killed, 2 equivalent); bind_gateway_feed#25/#26 (refusal message text) would be P3 but are killed too | none | 2 |
| full-export | 102/150 (68.0 %) | 145/146 (99.3 %); 146/146 with the kill added after the confirmation run (not confirmed by a run) | P1 6 (register_export_restricted_table, all killed); P2 42 (37 killed, 4 equivalent, begin_full_export#1 killed by a later test, not confirmed) | none | 4 |
| evaluation-pack | 48/87 (55.2 %) | 83/86 (96.5 %); 86/86 with the 3 tests made stricter after the confirmation run (not confirmed by a run) | P2 39 (35 killed, 1 equivalent, 3 killed by stricter assertions after the run) | none | 1 |
| analytics-method-change | 61/72 (84.7 %) | 72/72 (100 %) | P1 1 (person_flag_dispositions#5, restricted audit-trail flags: killed); P2 10 (all killed) | none | 0 |
| interface-drift | 9/11 (81.8 %) | 11/11 (100 %) | P1 2 (both killed) | none | 0 |
| validation-summary-gate | 2/2 (100 %) | 2/2 (100 %) | none | none | 0 |

Killed after the confirmation run (the one run per group was used up; these are not confirmed by a run):
- records.begin_full_export#1 (1335:329): a seal key row written around the audit trail (no chain head) must not be listed; new test in full-export.test.ts.
- records.store_evaluation_pack#48 and #50 (1336:382): the confirmation run showed the readability sample reader raising REC-141 too; the assertions now require the pack's own message.
- report.evaluation_period_rows_v1#18 (1336:138): the run showed the same source row also listed under its IN_PERIOD topic; the assertion now names the topic.

Equivalent mutants (reasons in equivalent.json):
- tab.feed_signature_message#1 (1405:124): a null or non-object envelope is still caught by the field loop, which returns null.
- tab.accept_gateway_envelope#69 (1432:85): v_ok is never null, so `coalesce(v_ok, false)` and `coalesce(v_ok, true)` agree.
- records.register_full_export#7 and #9 (1335:424): a null or non-object manifest also fails the format term, with the same refusal.
- report.closed_batch_records#15 (1240:54): the constraint batch_execution_origin admits GMP only with GMP_BATCH.
- report.closed_batch_records#29 (1240:68): the only extra prefilter value, `<id>~`, is rejected by the conjunct that follows.
- records.store_evaluation_pack#27 (1336:343): a period end equal to the clock reading taken during the call cannot be named.

No Priority 1 survivor left unfixed. No defect found, so no migration (kernel 1396 and 1397 unused).
Side note: `pnpm mutation:sql --audit-equivalents` reports 58 older entries as stale (not in these groups); not touched here.

### Stream 3, part T3a (analytics inputs, plant-rule approval, controlled reads, specimen approval)

First run: `.reports/sql-mutation-p7/s3/`. Confirmation runs (one per group, survivors only):
`.reports/sql-mutation-p7/t3a-confirm-<group>/`. Detected/valid = killed / (mutants − invalid − equivalent).
Commits on `phase-7/slice-7f-mut-t3`: 2d7c4f35, f4ad1e4e. No real defects found (no migration needed).

| Group | First run | After triage (confirmation) | Notes |
|---|---|---|---|
| analytics-inputs | 30/57 (52.6 %) | 55/55 (100 %) | 25 killed, 2 equivalent |
| analytics-rate-inputs | 28/32 (87.5 %) | 32/32 (100 %) | 4 killed |
| analytics-review-inputs | 51/72 (70.8 %) | 72/72 (100 %) | 21 killed |
| analytics-profile-inputs | 28/44 (63.6 %) | 40/41 (97.6 %) | 12 killed, 3 equivalent, 1 left at confirmation (since killed, see below) |
| plant-rule-approval | 51/70 (72.9 %) | 68/68 (100 %) | 17 killed, 2 equivalent |
| controlled-reads | 49/67 (73.1 %) | 64/67 (95.5 %) | 15 killed, 3 left at confirmation (2 since killed) |
| specimen-approval | 13/21 (61.9 %) | 19/20 (95.0 %) | 6 killed, 1 equivalent, 1 left at confirmation (since killed) |

Killed after the confirmation run (tests added and green; no second run, per the one-run-per-group rule; each kill
follows from the assertion):
- `tab.labelling_specimen_state#2` (retirement subquery `r.document_id <> d.id`): master-records.test.ts now retires an
  SOP and asserts another specimen stays RECORDED (the mutant shows the SOP's RETIRED state). Priority 1 (DI-35).
- `tab.controlled_custody#16` (`b.id <> c.batch_id`) and `#21` (`c.batch_id <> p_batch`): controlled-read.test.ts
  asserts unique custody ids, each record's own batch number, and the custody of a named batch. Priority 2.
- `report.series_samples_v1#23` (sample `sourceTime <= w_to`): series-inputs.test.ts sends a chunk inside the window
  whose last sample is exactly at the window's end and asserts that sample is left out. Priority 2.

Expected after these: specimen-approval 20/20, controlled-reads 66/67, analytics-profile-inputs 41/41.

Survivors by priority (first run, 113):
- Priority 1 (all fixed by tests): plant-rule-approval 19 (QA approval refusals, signed content and scope, PR-27),
  specimen-approval 8 (DI-35 act guards, state, content provider), controlled-reads 17 (CONTROLLED.READ reader problem
  for an accountless or missing account, the reader's session site, the batch-scope refusal of custody and checkpoint
  reads, IN-53), the GMP-only and own-record joins of the analytics input views (DI-51/DI-52/PR-61).
- Priority 2 (fixed by tests): the rest of the analytics views: completion and end times from the batch's own status
  event, release on the batch's own lot, room occupancy windows, unit and consumption per step, deviation attribution,
  review counts (exceptions, deviations, findings, reopenings), the 7-day maintenance and CMMS windows, the 30-day
  review coverage edge (tested inside one statement so statement_timestamp() is shared), series window edges, alarm and
  deviation counts.
- Priority 3 (recorded only): `tab.controlled_checkpoint_rows#1` (1413:155, `deviation_ref` scalar subquery
  `d.id <> k.deviation_id`): the display reference text of a checkpoint's deviation; the read's access check is not
  affected. Left open.

Defects: none (M7-T3a: no entries).

Equivalent mutants (recorded in `tools/sql-mutation/equivalent.json`):
- `tab.approve_labelling_specimen#17` (1479:93, EBMR-TAB-473 dropped): reached only with the specimen RECORDED; a
  signature's record_state is the provider state at signing and APPROVED/retired are terminal, so the problem is
  always null there.
- `plant.assert_plant_rule_approval#7` (1210:244, EBMR-PLANT-176 for a state problem dropped): same reasoning; both
  callers refuse any non-PROPOSED version first and APPROVED/SUPERSEDED are terminal.
- `plant.penicillin_facility#8` (1210:111, `>` to `>=`): the only extra row is the approved version itself, which
  cannot satisfy `not f.penicillin_facility` when the first operand is true.
- `report.batch_fact_rows_v1#19`, `report.cpp_value_rows_v1#3`, `report.step_windows_v1#9` (`installation = 'GMP'
  and purpose = 'GMP_BATCH'` to `or`): the CHECK constraint batch_execution_origin (0500) makes the two equalities
  always both true or both false.
- `report.series_ref_rows_v1#11` (1170:85): negating a non-null boolean partition key leaves the partitions unchanged.
- `report.series_samples_v1#17` (1170:109, chunk `from_us <= w_to`): a chunk starting at w_to has only samples at or
  after w_to (first sample is from_us, samples rise strictly), all removed by the sample condition.

### Stream 3, part b (T3b): first-run set-up, operations, IQ record, records reads, drills

Branch `phase-7/slice-7f-mut-t3b`. Confirmation reports: `.reports/sql-mutation-p7/t3b-confirm-<group>/`; the
first-run set-up's re-run after the harness fix: `.reports/sql-mutation-p7/t3b-rerun-first-run-setup/`.
Commits: 7bf60181 (harness reaches the set-up's own databases), 88254b42 (tests), e1c10095 (one equivalent).

| Group | First run detected/valid | After triage detected/valid | Score |
|---|---|---|---|
| first-run-setup | 0/47 (harness defect, see M7-T3b-1); 24/47 on the re-run after the fix | 45/46 (1 equivalent excluded) | 97.8 % |
| operations-acts | 6/17 | 17/17 | 100 % |
| operations-demo-backups | 7/8 | 8/8 | 100 % |
| iq-record | 11/19 | 19/19 | 100 % |
| validation-records-reads | 25/41 | 41/41 | 100 % |
| operations-drills-restore | 40/75 (5 invalid) | 74/75 | 98.7 % |

**Defects**

- **M7-T3b-1 (high, test tooling; fixed in 7bf60181).** The first-run set-up's tests build their not-set-up
  templates from the migrations (`operations/support.ts` freshTemplate) instead of copying the harness's mutated
  templates, so none of the 47 mutants of `iam.issue_setup_token`, `iam.first_run_setup` and `iam.is_bootstrapped`
  ever reached a test. The group's 0 % was not a measure of its tests. Fix: the harness writes the mutant (function,
  owner, statement) to a private 0600 file named by `EBMR_SQL_MUTANT`, and freshTemplate applies it as the function's
  owner (`applyPreparedMutant`). Without the variable nothing changes. A harness test covers it.
- No product defect was found. Every survivor was a guard that the tests did not reach on its own (the server's
  request schemas refuse the same input first) or an output that was not asserted exactly.

**Survivors by priority**

- Priority 1, killed by database-direct tests:
  - first-run set-up: the token's hash form, validity window (5 and 10080 minutes kept, 4 and 10081 refused), token
    length (32 and 256 kept, 31 and 257 refused), the set-up's parts, the site name (200 kept, 201 refused) and the
    seal key; the attribution of its audit entries ('Installation pipeline', with a TEST- prefix on a sandbox);
  - operations acts: worker act and reason, invalid record, backup tier and reason, and a copy of a backup that is
    not catalogued;
  - demo acts refused when not a known act or without their parts;
  - IQ record (DI-03): every part on its own (no text; a hash of the text or the bundle that is wrong, upper case or
    too short; text that is not JSON; each shape condition);
  - records reads: the read gate (the CSV lead, a governance reader with none of the hold, retention or disposal
    permissions, reads; the steward is refused on all three reads); the DI-50 withholding of an investigation about
    the reader, its hold and the refusals that name it; the disposal id of this record's own schedule only;
  - upgrade drill records only from a SYSTEM source.
- Priority 2, killed: drill requests, the matching of an upgrade drill to its request, invalid drill and hardening
  records, the result of a hardening check against its checks, the failed-drill and failed-check alarms (with the
  failed checks named), the unscheduled-record view, and the exact restore approver candidates.
- Priority 3, recorded: `tab.restore_overview#8` (1525:51, `and` to `or` in the approval time shown for each named
  approver). It differs only for an event that names several approvers when only some of them have approved. It is
  display only: the event's status comes from `continuity.restore_event_is_approved`. It is not equivalent.
- Priority 1 left as a residual: `iam.first_run_setup#11` (1375:120, `expires_at > clock_timestamp()` becomes `>=`).
  The two differ only when the token's expiry equals the statement's clock reading to the microsecond, and no test
  can set that up. A token at that one microsecond has no security effect. Not recorded as equivalent, because a
  timing input could in principle tell them apart. For the owner.

**Equivalent mutants**

- `iam.first_run_setup#17` (1375:126, first `or` becomes `and`). When p_def is SQL NULL, an array, a scalar or JSON
  null, `p_def -> 'site'` is SQL NULL (checked on PostgreSQL 16), so the third condition raises the same
  EBMR-SETUP-003. For an object, both forms are false. Recorded in `tools/sql-mutation/equivalent.json`.

### Stream 4: functions Phase 6A and Phase 7 re-created in earlier groups (triage T4)

Run: `pnpm mutation:sql --group <g> --functions <the group's re-created functions>` (report `.reports/sql-mutation-p7/s4`).
Triage on branch `phase-7/slice-7f-mut-t4`; one confirmation run per group (`.reports/sql-mutation-p7/t4-confirm-<group>`),
with `--only` on the group's stream-4 survivors. Scores are detected / valid (valid = mutants minus invalid minus
equivalent). "After triage" is the first run's kills plus the confirmation's kills, over the valid count after the
equivalents recorded in `tools/sql-mutation/equivalent.json`.

Six kills came from tests written after their group's confirmation run (marked *late*): they are argued from the test,
not yet confirmed by the harness; the next full or focused run of those groups confirms them.

No defect was found (no M7-T4 number used; no migration written). No Priority 1 survivor is left.

| Group | First run | After triage | Left (priority) |
|---|---|---|---|
| read-authorisation | 93/98 (94.9 %) | 98/98 (100 %) | none |
| tablets-sessions | 20/22 (90.9 %) | 20/22 (90.9 %), no change | 2 (P3) |
| connection-roles | 116/117 (99.1 %) | 116/116 (100 %) | none |
| change-paths-and-hand-over | 53/75 (70.7 %) | 69/71 confirmed, 71/71 (100 %) with 2 late | none |
| gmp-batch-issue | 90/122 (73.8 %) | 114/120 confirmed, 116/116 (100 %) with 2 late and 4 equivalents recorded after the run | none |
| lots-and-lims | 35/42 (83.3 %) | 41/42 (97.6 %) | 1 (P3) |
| inbound-adapters-and-mirrors | 71/74 (95.9 %) | 73/73 (100 %) | none |
| equipment-data-and-alarms | 53/76 (69.7 %) | 70/74 confirmed, 72/74 (97.3 %) with 2 late | 2 (P3) |
| plant-rules | 9/10 (90.0 %) | 9/9 (100 %) | none |
| genealogy-and-recall | 1/4 (25.0 %) | 4/4 (100 %) | none |
| controlled-substance-mode | 3/4 (75.0 %) | 4/4 (100 %) | none |
| india-dsc | 40/52 (76.9 %) | 49/49 (100 %) | none |
| exceptions-and-dispositions | 70/70 (100 %) | unchanged | none |

transfer-and-federation is not in the report because its two re-created functions gave no mutants:
`tab.kernel_signing_meanings` (tablets 1525) and `tab.aggregate_read_class` (tablets 1479) are `language sql` CASE / IN
look-ups with no relational operator, no and/or/not/true/false and no RAISE, which are the only sites the mutators
change (the harness's `mutantsOf` gives 0 for both).

#### Per group

**read-authorisation** (5 survivors, all P1 read gates). Killed by
`apps/tablets-server/test/mutation/read-authorisation.test.ts`: an account holding the contract giver's reviewer role
reads no record in another role and counts as the contract giver (`tab.record_read_problem#2`,
`tab.reader_is_contract_giver#2`; IN-30); a compendial rule set and a QP registration are read by a signer or a
governance role and by no other (`#12`, `#13`, `#14`; DI-17, DI-37).

**tablets-sessions** (2, P3). `tab.resolve_session#14`, `#17` (tablets 1460:45): the `roles` list's grant window
`valid_from <= clock_timestamp()` and `valid_to > clock_timestamp()` moved to `<` / `>=`. They differ only when a grant
starts or ends at the very microsecond `clock_timestamp()` is read in the statement, which no test can arrange (the
clock is read again on every call). Residual, not equivalent.

**connection-roles** (1). Equivalent: `sandbox.apply_connect_policy#24`, `coalesce(r.rolsuper, true)`. NULL only for
an unknown grantee, which the EBMR-SBX-038 check just before already refuses.

**change-paths-and-hand-over** (22: P1 batch scope and P2 guards). Killed by `db-guards-change-paths.test.ts` (each
clause of the act-shape check of `recipe.propose_act` on its own, the 16384-character limit at and above, a batch that
does not exist: `#1`, `#3`, `#6`, `#7`, `#10`, `#11`, `#12`, `#13`, `#18`), `db-guards-exception-register.test.ts` (an
answer without an open query, by the asker, by the head of production holding only the second answering permission,
the raiser escalating, another run's disposition of the same exception id, a blank note stored as none: `#7`, `#15`,
`#52`, `#56`, `#86`, `#96`), `review/batch-scope.test.ts` (a GMP query before the production approval: `#39`) and,
late, `packages/recipe-core/test/mutation/change-paths-and-hand-over.test.ts` (the same query on the only GMP batch
of a database: `#35`; a performer of the raising step concluding, read from the batch's own state: `#85`).
Equivalent (recorded): `recipe.review_exception#76`, `#78`, `#81`, `#82`, the GMP escalation branch at 1217:337 to 340.
It is reached only for ACCEPTED_BY_QA or ESCALATED, which 1217:291 has already refused on a GMP batch (EBMR-REV-059),
and a sandbox database has no GMP batch row.

**gmp-batch-issue** (32, including recipe-core 1260; P1: the DI-03 gate, the DI-15 function, the issuer signature,
batch scope, engine roles). Killed by `lifecycle/gmp-issue.test.ts`: the link, pin or control recipe gone before
`begin_gmp_issue` or between it and `issue_gmp_execution` (`begin#7`, `#8`, `#9`, `issue#10`, `#11`, `#13`), the link's
number changed mid-issue (`issue#17`), a batch no longer PLANNED (`gmp_issue_problem#3`), a replanned id
(`prepare#19`), a request naming another batch (`issue#33`, `#35`), another person's ISSUED signature refused by the
function itself (`#59`), a session at another site (`#46`, `#49`), engine roles through the map in the declared role
and an evaluation of this command (`#65`, `#67`, `#70`, `#73`, `#75`, `#76`, `#77`; positive and negative cases); and
by `lifecycle/packaging-issue.test.ts` (a packaging order without its parent, a packaging number of another batch:
`prepare#37`, `#73`, `#76`). Late: a number voided in the register between the two steps, refused with the issue's
own reason (`issue#22`, the re-check that carries the DI-03 and DI-15 gates; the DI-03 problem alone is also refused
by the row trigger of 1250 with the same message, so a voided number is what tells them apart); planning holds its
family's row against an activation (`prepare#24`, a `FOR UPDATE NOWAIT` probe).
Equivalent (recorded): `gmp_issue_problem#7` (every return of `select_version_for_issue` carries a boolean `ok`);
`prepare_gmp_issue#80` (a link has allocation v_alloc exactly when it has its number: unique register numbers and
unique link columns); `issue_gmp_execution#20` (begin_gmp_issue holds the same FOR SHARE lock in the same
transaction); `#66`, `#69`, `#72` (relaxed joins; the extra rows are removed by `role_evaluation_problem`, which
refuses another permission, command, person or a not-allowed evaluation).
Note (no change): the US e-signature gate's own mutants were all killed in the first run.

**lots-and-lims** (7; P1 batch scope, P2 limits). Killed by `lots/lots.test.ts`: a reservation naming the batch's id
with another batch's number (`site.consume_reservation#12`), a zero quantity (`#42`), a lot made unusable behind the
triggers' back (`#29`, `#30`), a lot whose status version moved since the reservation (`#34`), a lot holding less than
its reservation (`#52`). Residual P3: `#21`, the expiry `clock_timestamp() >= r.expires_at` to `>`, equal only at an
unpredictable microsecond.

**inbound-adapters-and-mirrors** (3). Killed: the EBMR-INT-030 refusal names its source's verifier
(`accept_inbound_detail#21`, `inbound/source-verification.test.ts`; P3 message text, killed anyway); an unknown alarm
needs neither owner nor QA (`gap_needs_owner_or_qa#7`, kernel mutation file). Equivalent (recorded):
`accept_inbound_detail#61`, `v_seq >= v_max` for GAP (a taken sequence number is refused by EBMR-INT-006 just before).

**equipment-data-and-alarms** (23; P2 guards, the source-time bound). Killed by
`packages/recipe-core/test/mutation/equipment-data-and-alarms.test.ts`: a 17-digit source time (0960 `#1`); the
three- and four-argument bounds before a session at the bound, one past it, inside it and without a session (1233,
1234: `#1` to `#4`); every malformed series-gap field on its own, another message type, an unknown field, an empty
interval, a wrong unit, a tag of another subject kind, a unit without its session (`receive_series_gap#2`, `#13`,
`#17`, `#19`, `#22`, `#25`, `#32`, `#34`, `#41`, `#43`, `#52`). Late: the session a unit's data stand on is its own
endpoint's, not another endpoint's later session on the adapter (`opcua_session_start_us#3`, `#5`; the first test was
inside five minutes, but recipe-core 1235 bounds series by the offline buffer, so the confirmation run left them).
Equivalent (recorded): `acknowledge_alarm#11` (a non-UI/API source is a service account, which iam.require_permission
already refuses an ACKNOWLEDGE permission: NON_INTERACTIVE_ACCOUNT_CANNOT_SIGN, shown by a test);
`opcua_session_start_us#6` (a data message never shares adapter and sequence with a session message).
Residual P3: 0960 `source_time_or_raise#4` (`> clock + 5 min` to `>=`) and `opcua_session_start_guard#1`
(`< clock - buffer` to `<=`): both compare with `clock_timestamp()`, equal only at an unpredictable microsecond.

**plant-rules** (1). Equivalent (recorded): `classified_beta_lactam#8`, `c.version >= approved version`: the extra row
is the approved row itself (primary key kind, code, version), already counted by the first disjunct or excluded by
`c.beta_lactam`.

**genealogy-and-recall** (3). Killed by `genealogy/recall.test.ts` (site services): no destinations for an unknown or
a signed-off mock recall, and another unsigned one still answers (`mock_recall_destinations#2`, `#5`, `#6`; IN-29).

**controlled-substance-mode** (1, P1 IN-53). Killed by `controlled/controlled-read.test.ts`: a meaning asked on another
record type is refused with EBMR-TAB-019 before any content or scope is read (`controlled_preview#2`).

**india-dsc** (12, P1 DSC binding). Killed by `packages/kernel/test/mutation/india-dsc.test.ts`: a chain of the signer
certificate and the anchor alone is accepted, for an enrolment and a signing DSC (`enrol#24`, `record#17`); a chain
that is not base64 (`enrol#21`, `record#14`); the option off (`enrol#15`); no live anchor (`enrol#18`, `record#11`); a
meaning that needs no DSC, from an enrolled signer (`record#8`); an end without a reason (`end#7`). Equivalent
(recorded): `enrol_dsc_certificate#8`, `#9`, `#10`, the account check's OR joined to AND between disjuncts the actor
context (0190) and the administrator refusal (1321) already make false for every account that reaches line 40.

## T5: feed signature, adapter TLS, analytics runner, analytics methods (triage of the first run)

Branch `phase-7/slice-7f-mut-t5`. First-run reports: `.reports/stryker-phase7/{feed-signature,adapter-tls,analytics-runner,analytics-methods}.json`.
Confirmation runs: Stryker `--mutate` once per Priority 1 file group, from the worktree, with the new tests
(`EBMR_STRYKER_CONCURRENCY=2`, incremental off). Where a confirmation run was not made, the kill was checked by hand
mutation (the mutant applied to the source, the test file run, the source restored).

### First-run scores (decision 0019 zones)

| Feature | Zone | First run | Survived | No coverage | After triage |
|---|---|---|---|---|---|
| feed-signature | high-risk (90 %) | 32/43 (74.4 %) | 6 | 5 | 41/43 confirmed (95.3 %); the 2 left are equivalent / not reachable |
| adapter-tls | high-risk (90 %) | 74/88 (84.1 %) | 6 | 8 | 84/88 confirmed (95.5 %); the 4 left are equivalent / not reachable |
| analytics-runner | high-risk (90 %) | 272/737 (36.9 %) | 166 | 299 | pool.ts 61/61 and audit.ts 129/131 confirmed (98.96 % on the two); threaded.ts gates checked by hand mutation; worker-entry.ts not reachable by the harness |
| analytics-runner | other (80 %) | 433/1135 | 341 | 361 | Priority 3: counts only |
| analytics-methods | high-risk (90 %) | 980/1364 (71.8 %) | 362 | 22 | methods/audit 806+8 of 856 confirmed (95.1 %); registry by hand |
| analytics-methods | other (80 %) | 2336/3550 | 1068 | 146 | Priority 3: counts only |

Harness notes. (1) The server's analytics runner runs its methods in a worker thread (`threaded.ts` starts
`worker-entry.ts`). Stryker activates a mutant only in the test process, and its per-test coverage does not see the
worker: all 63 mutants of `worker-entry.ts` are "no coverage", and the analytics routes' tests (which run on the
threaded runner) cover none of the in-worker code (`runner.ts`, `inputs.ts`, `audit.ts`, `spc.ts`, `mspc.ts`,
`review.ts`, `profile.ts`). These are not reachable by the harness, not untested: the worker-side code is the same code
the in-process runner tests run, and the role check in the worker is now proven by behaviour (below). (2) Coverage
attributed to a `beforeAll` (the test server's own runner) is not tied to a test, so a mutant reached only there runs
no test and is reported as surviving (for example `pool.ts:20` the application name, which the first test checks
through `pg_stat_activity`). (3) `registry.ts:47`, `:162` and `:251` (the METHODS table or one entry replaced by `{}`)
are reported surviving although `registry.test.ts`'s first test fails on them (`Object.keys(METHODS)` is checked
against `METHOD_IDS`): a static-mutant artefact of the first run, killed in fact.

### Priority 1: every survivor and no-coverage mutant

**feed-signature.ts** (`packages/integration-sdk/test/adapter/feed-signature.test.ts`)

| Mutant | Outcome |
|---|---|
| 41 message template, 42 `name` | killed: `[DI-31] a refused feed signature field is a FeedSignatureError naming the field and the rule it broke` |
| 49 `??` to `&&` | killed: same test (the rule's own message is the detail) |
| 49 `?.` to `.` | equivalent: a failed `safeParse` always carries at least one issue, so `issues[0]` is never undefined |
| 49 `'not valid'` (no coverage) | not reachable, same reason |
| 55 `typeof seq === 'string'` to true, 56 message | killed: same test (a JavaScript number is refused as such, not as text out of its rule) |
| 89-91 `signFeedEnvelope` (5, no coverage) | killed: `[DI-31] the gateway signs a feed envelope as Ed25519 over the v1 message with its key` |

**adapters/transport.ts** (`apps/tablets-server/test/security/tls.test.ts`)

| Mutant | Outcome |
|---|---|
| 29-34 `adapterTlsOf` (6 survived, 4 no coverage) | killed: `[DI-31] EBMR_ADAPTER_TLS_DIR holds all three TLS files of an adapter or none; some but not all is refused (EBMR-INT-034)` |
| 88 `req.write(body)` (no coverage) | killed: `[DI-31] an adapter over mutual TLS sends its method and request body to the system and reads its answer` |
| 63 `'GET'` to `''` | equivalent: node:https sends GET for an empty method (`ClientRequest` treats a falsy method as GET) |
| 71-73 peer without certificate (3, no coverage) | not reachable: with `rejectUnauthorized: true` and the pinned CA a handshake completes only on a verified peer certificate (Node enables no anonymous or PSK suite without a PSK callback); defensive code, kept |

**Analytics segregation and the worker's role check** (`apps/tablets-server/src/analytics/{pool,threaded,worker-entry,runner}.ts`;
`apps/tablets-server/test/analytics/runner.test.ts`)

| Mutants | Outcome |
|---|---|
| pool.ts 76 session user, 80-82 problem texts and joins, 93 `'; '` join, 20 application name | killed: `[DI-51] each problem of the runner's role is named, and all are reported together` |
| pool.ts 30-36 `connectRetrying` (11, no coverage) | killed: `[DI-51] the runner waits while the role's connection limit is reached, up to its attempts, and fails at once on any other error` |
| threaded.ts 129-145 `start()` role gate (8 survived, 14 no coverage), 99 error reply, 149-150 `isRunning`, 154-157 `pause`, 161 `resume` | killed: `[DI-51] the worker thread's runner starts only on ebmr_analytics: on another login, or when the role cannot be read, it does not start (P6A7-8)` (wrong login, wrong password, own login, second start, pause and resume, start after stop) |
| threaded.ts 101-112 worker end (`end`, pending refused, error logged) | killed: same test, the worker terminated under a pending request |
| threaded.ts 150 `this.ended === null` in `isRunning` | equivalent: `end()` always clears the timer, so `timer !== null` already implies not ended |
| worker-entry.ts 57-59 `roleProblem` (no coverage) | not reachable by the harness (worker thread); proven by the same test: the parent's `start()` asks the worker, and the wrong login and the unreadable role both come back from the worker's own `analyticsRoleProblem` |
| runner.ts 101-117 in-process `start()` | the gate itself (`problem !== null`) was killed in the first run (`[DI-51] the runner starts only on ebmr_analytics ...`); 108 (role unreadable) is the in-process twin of the threaded case; the timer survivors are Priority 2 |
| "writes no GMP data" | database guard: ebmr_analytics has no insert, update or delete outside `analytics` and no command; the segregation check reports any extra grant. Tests: `packages/kernel/test/analytics/analytics.test.ts` `[DI-51] the analytics role cannot write: ...` and `[DI-51] the segregation check reports the analytics role missing, each elevated attribute alone and a membership either way ...`. No mutant of the runner can widen that. |

**Restricted audit-trail flags** (`packages/analytics/src/methods/audit/*`; `packages/analytics/test/audit.test.ts`; the runner's
`apps/tablets-server/src/analytics/audit.ts` with `apps/tablets-server/test/analytics/audit.test.ts`)

First run 605/856 with 234 survived and 17 no coverage. New tests:
- `[DI-53] each rule raises exactly its hits on the crafted input, with their texts, weights and evidence`: every rule on one
  crafted input given newest first, with its boundaries (15 minutes not late, 2 minutes not back-dated, the minimum number
  of person-weeks exactly, 20 digits exactly, 06:00 and 22:00), the rows each rule must leave alone (no batch, step, field,
  attempt or failure state; a correction; a deviation on one entry; a failed login; a login without terminal; an
  in-progress week), evidence limits (21 failed attempts, 22 digits) and the order of steps, items, persons and accounts;
  the whole result is compared.
- `[DI-53] the week in progress is the latest of entries and logins; too few person-weeks are named only when there are
  some; equal working-hour bounds leave no working hour` (also hours across midnight, the person order of outputs, at most
  20 corrections named, only occurring digits named).
- `[DI-53] the baseline assesses each metric of each person in both directions, from rows in any order, and flags only above
  the threshold` (all four metrics, a drop to zero, the threshold itself, a history started by a login, tie orders, the
  latest week's z only when assessable).
- the instants test extended (offset without colon, text around an instant or wall-clock time, id and text orders).
- server side, `[DI-53] each audit, authentication and manual-digit row becomes the methods' input field by field`,
  `[DI-53] a row outside its column types, an unknown authentication kind or a terminal digit outside 0 to 9 fails the run's
  input`, `[DI-53] ATA.RULES reads the audit, authentication and manual-digit views; ATA.BASELINE the first two; both only
  nightly` (the runner's `audit.ts`, which runs in the worker in production).

Confirmation run on `methods/audit/*.ts`: 806 killed, 8 timeouts, 34 survived, 8 no coverage (95.1 %). Of these 42,
14 were killed afterwards by the tests above (each checked by hand mutation: rules 104, 108, 135, 139 (3), 162, 166, 213,
216, 225 filter, 251, 278 end bound, 308; baseline 95, 121). The rest are equivalent or not reachable:

| Mutant | Reason |
|---|---|
| rules 120 (3), 265 (2), 284 (no coverage) | not reachable: the text's `?? ''` / `?? 'An entry'` defaults follow a filter that already excludes a null field, step or configuration area |
| rules 188, 214 `?? []` (no coverage) | not reachable: the key comes from the same map's keys |
| rules 73, baseline 39 empty-list check | equivalent: without it the result is NaN all the same |
| rules 109 sort of a step's entries | equivalent: the only caller passes entries already in recording order |
| rules 135, 139 `>` to `>=`; baseline 66 `<` to `<=`, 67 `>` to `>=` | equivalent: on equality the same week is stored |
| rules 139 `latest === null` to false | equivalent: after the entry loop `latest` is null only when there are no entries, and then it is unused |
| rules 149, baseline 98, 101 `latest !== null` to true | equivalent: `latest` is null only when there are no rows at all |
| rules 165 `n === 0` to false | equivalent: the limit is a percentile of counts of at least 0, so a count of 0 is never above it |
| rules 224 `chi2 > critical` to `>=` | not killable in practice: needs a chi-square of whole-number counts exactly equal to the floating chi-square quantile |
| rules 225 `a.digit - b.digit` to `+` | equivalent: the digits arrive in ascending order and V8's sort is stable, so a positive tie result keeps the same order |
| rules 291 default `skipped` array | equivalent: the default array is never returned |
| input 92 `zone !== 'Z'` (2), 95 `digits.length > 2` (2) | equivalent: for `Z` and for a two-digit offset the minutes part reads as 0 |

Runner `audit.ts` (in the worker): first run 49/131 (38 survived, 44 no coverage, all "not reachable" through the threaded
runner); the three server tests above cover it directly. Confirmation run on `pool.ts` and `audit.ts`: 183 killed,
7 timeouts, 2 survived. 41 (`v === undefined` in `intOrNull`) was then killed by giving the bare row no `attempt` column
at all; 42 (`typeof v !== 'number'` to false) is equivalent, as `Number.isInteger` of a non-number is false.

Hand mutation (the mutant applied, the role-check test run, the source restored): threaded.ts `problem !== null` to
false, pending requests not refused in `end()`, `pause()` not stopping the timer, and runner.ts's unreadable-role
problem set to null are all killed.

### Priority 2 (about an hour)

- registry.ts (128 survived, 5 no coverage): the parameter schema's rules (278-290, 30 mutants) killed by
  `[DI-52] a parameter outside its kind, range, choices or terms is named, each rule on its own` (kind, finiteness,
  integrality, both ends of the range, choices, weights; checked by hand mutation); the methods' input lists (10 array
  mutants) killed by `[DI-51][DI-52] each method names the inputs it reads`. 281 `typeof v !== 'string'` is equivalent (a
  non-string is never in the choices). Left: 89 string mutants of titles, intended uses and notes (descriptive text,
  shown on the catalogue screen; not a guard) and the 3 static-artefact object mutants above.
- runtime.ts and method.ts: 9/9 and 11/11 in the first run.
- runner.ts lifecycle (timer, tick, pause and stop, 62 survived, 126 no coverage): the in-worker paths are not reachable by
  the harness; the threaded parent is covered by the new tests. The operations screen's pause, resume and stop are
  tested in `apps/tablets-server/test/operations/workers-and-backups.test.ts`, which is outside this feature's test list
  (so its kills are not counted). Left as counted.
- threaded.ts: the log forwarding from the worker (91-92) and the tsx loader errors (61-66, 51-58 bootstrap) remain
  (logging and start-up messages; no GMP effect).

### Priority 3 (counts only)

- analytics-runner other zone (catalog, inputs, mspc, profile, review, spc, implementation, method-types):
  433/1135 killed, 341 survived, 361 no coverage (mostly in-worker code, see harness note 1).
- analytics-methods other zone (spc, capability, drift, mspc, profile, rates, review, numeric): 2336/3550 killed,
  1068 survived, 146 no coverage.

### Defects

None. No survivor showed wrong behaviour; every Priority 1 survivor was a missing test, an equivalent mutant or code the
harness cannot reach.

