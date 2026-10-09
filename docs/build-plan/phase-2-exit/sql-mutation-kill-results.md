# Phase 2 exit: SQL mutation kill results

The SQL mutation harness (`tools/sql-mutation`, branch phase-2/sql-mutation) mutated the database functions behind the
Phase 2 guards in two batches. For every group below its target, a kill agent wrote tests that detect the surviving
mutants, or argued that a survivor is equivalent (no input can tell it from the original). A second agent, the
skeptic, then tried to break each equivalence claim and each reported defect; a claim it broke went back for a test
(round 2). This page records the outcome of the 24 groups merged on branch phase-2/kill-integration. Four groups
were still being worked on and are not part of it: device-readings, evidence-source-and-entries,
entry-references-and-schema and signed-content.

How to read the table:

- **Before**: the group's batch score, detected over valid mutants (invalid and equivalent ones left out). Batch 1
  ran locally (its summary); batch 2 ran on GitHub, one "SQL mutation report (group)" check run per group on the
  harness commit e236af3.
- **Killed**: survivors the group's new kill tests detect, as the kill agent's final harness run on its own branch
  reported them. Where a function had been redefined between the batch run and the kill branch's base, the agent
  counted the mutants of the current definition, so this number can differ from the batch's survivors (noted per
  group).
- **Equivalent**: claims the skeptic upheld. They are now in `tools/sql-mutation/equivalent.json` under their current
  ids, each with a short reason, and count as neither detected nor survived.
- **Left**: survivors neither killed nor accepted as equivalent.
- **Tests**: the kill tests in the group's files (`packages/kernel/test/mutation`, `packages/recipe-core/test/mutation`,
  `apps/tablets-server/test/mutation`), all passing on the integrated tree: 445 in 33 files (271 in the db project,
  174 in the server project). Each control a kill test is tagged with lists it.

## Results per group

### Batch 1

| Group | Before | Survived | Killed | Equivalent | Left | Tests (db + server) |
|---|---|---|---|---|---|---|
| mbr-lifecycle | 264/381, 69.3 % | 117 | 115 | 2 | 0 | 45 |
| market-authorisation-and-issue | 345/485, 71.1 % | 140 | 137 | 2 | 1 (a) | 32 |
| execution-state-binding | 219/333, 65.8 % | 114 | 119 (b) | 2 | 0 | 11 + 9 |
| system-facts-and-time | 226/333, 67.9 % | 107 | 99 | 8 | 0 | 21 + 11 |
| execution-steps-and-order | 374/461, 81.1 % | 87 | 74 (c) | 12 | 1 (c) | 20 + 7 |
| manual-weighing-gate | 163/242, 67.4 % | 79 | 74 | 5 | 0 | 32 (server) |
| batch-number-register | 92/145, 63.4 % | 53 | 52 | 1 | 0 | 37 |
| limit-exceptions | 181/223, 81.2 % | 42 | 41 | 1 | 0 | 17 |
| sandbox-and-import | 64/103, 62.1 % | 39 | 42 (d) | 2 | 0 | 5 + 14 |
| connection-roles | 55/91, 60.4 % | 36 | 53 (e) | 0 | 0 | 19 |
| designer-guards | 60/94, 63.8 % | 34 | 30 | 4 | 0 | 13 (server) |
| tablets-sessions | 78/109, 71.6 % | 31 | 35 (f) | 10 | 0 | 13 (server) |
| evidence-listener | 70/83, 84.3 % | 13 | 6 | 7 | 0 | 12 (server) |
| signing-failure-and-reasons | 34/43, 79.1 % | 9 | 8 | 1 | 0 | 6 |
| site-zone | 25/33, 75.8 % | 8 | 8 | 0 | 0 | 7 |

### Batch 2

| Group | Before | Survived | Killed | Equivalent | Left | Tests (db + server) |
|---|---|---|---|---|---|---|
| exceptions-and-dispositions | 172/238, 72.3 % | 66 | 64 (g) | 3 | 0 | 13 + 13 |
| execution-row-shape | 135/171, 78.9 % | 36 | 29 | 7 | 0 | 13 |
| execution-commands | 121/209, 57.9 % | 88 | 80 | 8 | 0 | 20 (server) |
| weighing | 122/156, 78.2 % | 34 | 20 | 14 | 0 | 7 + 5 |
| involvement-and-independence | 95/130, 73.1 % | 35 | 35 | 0 | 0 | 6 + 7 |
| read-authorisation | 135/154, 87.7 % | 19 | 18 | 1 | 0 | 10 (server) |
| exception-source | 65/83, 78.3 % | 18 | 17 | 1 | 0 | 6 + 3 |
| late-witness-and-step-times | 80/97, 82.5 % | 17 | 15 | 2 | 0 | 6 + 2 |
| stale-commands-and-readings | 51/59, 86.4 % | 8 | 7 | 1 | 0 | 3 (server) |

Notes:

- (a) `recipe.activate_market_authorisation#56` (a version-number comparison, `>` becoming `>=`). Round 2 claims it
  equivalent once the record's family is checked (fix recipe-core 0371): versions of one family never share a number.
  The claim came after the skeptic's review, so it is not recorded; it also holds only for records written after
  0371 (an installation upgraded with an earlier cross-family record could still tell the two apart). The lead
  decides whether to record it.
- (b) The batch counted the two overloads of `recipe.row_step_key` under shared ids; the agent ran every current id
  of both, 121 in all.
- (c) `recipe.minimum_duration_problem#15` and `recipe.own_node_event_problem#39` were left, each tied to a defect
  below (D6, D7): a test for either would have fixed in place behaviour the lead had not decided yet. Both are killed
  since: `#15` by the D6 test in `packages/recipe-core/test/mutation/execution-steps-and-order.test.ts` (decision D6.1;
  not counted in the Tests column, which counts the kill agents' tests; not equivalent, because the database does not
  run the validator), and `#39` by D7's test (D7, fixed).
- (d) Counted on the kill branch's base, which had 44 survivors (functions redefined after batch 1).
- (e) The fix migration (kernel 1100) replaced the function, so the agent killed every mutant of the new definition.
- (f) `tab.resolve_session` was redefined (tablets 0550) after batch 1; the agent counted 45 survivors on its base.
- (g) Includes the mutants of the fix migration's new condition (recipe-core 0370).

Every refuted equivalence claim was killed in round 2: `recipe.guard_in_flight_dispositioned#3`,
`recipe.registered_changes#33`, `recipe.execution_state_binding_check#8`, `tab.manual_weighing_check#44` and `#50`,
and `site.define_batch_number_rule#44`.

Equivalents recorded per group (94 in all): market-authorisation-and-issue 2, mbr-lifecycle 2, execution-state-binding
2, system-facts-and-time 8, execution-steps-and-order 12, manual-weighing-gate 5, batch-number-register 1,
limit-exceptions 1, sandbox-and-import 2, designer-guards 4, tablets-sessions 10, evidence-listener 7,
signing-failure-and-reasons 1, exceptions-and-dispositions 3, execution-row-shape 7, execution-commands 8, weighing
14, read-authorisation 1, exception-source 1, late-witness-and-step-times 2, stale-commands-and-readings 1. Most are
clock boundaries (a comparison against a clock reading taken inside it, which no input can hit to the microsecond)
or tests that an earlier trigger or check already decides. Two carry a condition: `recipe.command_member_problem#49`
holds only while no block version's entry or start schema declares a top-level member called kind, and
`recipe.role_evaluation_problem#13` is equivalent for every input value but not for every clock schedule.

## Fix migrations

The kill agents fixed four defects with new migrations. Their numbers had been taken on the PR branch since, so
each moved into a range kept for the kill work (recipe-core 0370-0379, tablets 0700-0709, kernel 1100-1109), in the
kill branches' order. No PR-branch migration redefines any of these functions after the definition each fix was
built on, so every body stands as the kill agent wrote it.

| Written as | Now | Function |
|---|---|---|
| recipe-core 0344_loop_exit_limit_verdicts | recipe-core 0370_loop_exit_limit_verdicts | `recipe.check_exception_changes` (on 0305) |
| recipe-core 0345_market_authorisation_family | recipe-core 0371_market_authorisation_family | `recipe.market_authorisation_guard` (on 0160) |
| tablets 0640_api_answer_at_report_instant (first 0600) | tablets 0700_api_answer_at_report_instant | `tab.manual_path_verdict` (on 0350) |
| tablets 0650_sandbox_lot_identity_test (first 0610) | tablets 0701_sandbox_lot_identity_test | `tab.register_sandbox_lot` (on 0200) |
| kernel 1030_segregation_problems_missing_roles | kernel 1100_segregation_problems_missing_roles | `sandbox.segregation_problems` (on 0980) |

## Defects the kill agents reported

Fixed:

- **D1. Exceptions and dispositions: a loop exit escaped the limit verdict.** The exception guard judged limit
  verdicts only on a row that changed a value or added a limit exception, so a row that only decided a loop's exit
  could leave the endpoint waiting and drop the limit breach its verdict raises, and was stored through the
  application role. Fixed in recipe-core 0370: a row that changes a decision is judged too.
- **D2. Market authorisation: a record filed under another family.** The table guard only stamped the proposer, so
  owner-level code could file another family's version under a family, or name another family's successor; once
  activated, that version became current for the wrong family's batches and no invariant noticed. Fixed in
  recipe-core 0371 (EBMR-RCP-094). The migration does not scan records written before it; the agent suggests the
  INV-17 invariant report such a record.
- **D3. Manual-weighing gate: an API answer at the report's own instant.** An answer recorded in the same
  microsecond as the monitor's "unreachable" report did not count as answering it, so after 10 s a hand-keyed weight
  was accepted beside a gateway that had answered. Fixed in tablets 0700 (`>` becomes `>=`). The wording followed in
  tablets 0710: the ANSWERED refusal of `tab.manual_weighing_check` says the API answered at or after the moment of
  the report (it said "after"), and 0710's header corrects 0350's description of ANSWERED and 0700's name for itself
  ("tablets 0640"). Test: "[DI-30][PR-20] beside a scale whose heartbeat is ONLINE ... at the very instant the report
  was made ..." (apps/tablets-server/test/mutation/manual-weighing-gate.test.ts), failing before 0710; the device
  tests that quote the message follow it.
- **D4. Sandbox and import: a test lot without its identity-test flag.** The register's check gave NULL for a missing
  flag, so the lot was refused by the table's NOT NULL constraint with a bare database error instead of EBMR-EXE-070.
  Fixed in tablets 0701. The wording followed in tablets 0711: the message names only what the function checks (a lot
  code and a yes or no for the identity test); a lot without a material or a status is refused by the table's NOT NULL
  constraints, as a new test shows. Tests: "[PR-18][DI-05] a test lot without a lot code, or without a yes-or-no
  identity test ..." (failing before 0711) and "[PR-18][DI-05] D4: the register's own refusal names what it checks
  ..." (apps/tablets-server/test/mutation/sandbox-and-import.test.ts). Harness on `tab.register_sandbox_lot` (0711): 11
  mutants, all killed.
- **D5. Connection roles: the sandbox segregation query failed on a missing role.** In a sandbox, a GMP login role
  the cluster lacks made `sandbox.segregation_problems()` fail with "role does not exist" instead of reporting the
  problem, because PostgreSQL evaluated the privilege test before the existence test; rows also came out in join
  order. Fixed in kernel 1100: roles are read from the catalogue and asked about by oid, in role order.
- **D6. Execution steps: a minimum duration that ends where a token arrives.** The validator accepted a minimum that
  ends at the start of an operation, section, stage, loop or hold point; the engine records such a start without
  refusing or flagging it, its own INV-20 checker then reported a violation, and the database skips it. Fixed in the
  validator, no migration (decision D6.1): rule TIME-MIN-AT-ARRIVAL refuses such a minimum and names where a person
  acts instead (the first act inside, or a hold point's release); the engine and the database stay as they are. Tests:
  `packages/recipe-core/test/validator/time.test.ts`, `apps/tablets-server/test/designer/arrival-minimum-and-nested-loops.test.ts`,
  and the kill test of `recipe.minimum_duration_problem#15` in `packages/recipe-core/test/mutation/execution-steps-and-order.test.ts`
  (note (c)).
- **D12. Limit exceptions: nested loops on the same endpoint.** The validator and the engine accepted two nested loops
  that exit on the same endpoint; at the outer exit the engine judged the point again and, on a breach, raised a
  second limit breach, and the database refused that outer exit row. Fixed in the validator, no migration (decision
  D12.1): FLOW-LOOPS refuses such loops in plain words at the inner loop; the database's fail-closed refusal of the
  outer exit stays and is pinned. Tests: `packages/recipe-core/test/validator/structure.test.ts`,
  `apps/tablets-server/test/designer/arrival-minimum-and-nested-loops.test.ts`,
  `packages/recipe-core/test/mutation/limit-exceptions.test.ts` (D12).
- **D7. Execution steps: a loop exit recorded without its loop context.** The rule that a loop's exit needs the loop's
  END (recipe-core 0312, 0314, 0316) applies only when the iteration's context is not empty, so through the
  application role a loop could be left before its minimum duration with no END recorded. Closed by recipe-core 0338
  (on this tree), as the kill agent read: an accepted COMPLETE_LOOP_ITERATION names a decision of the state in its
  loop's own frame, or it is refused (EBMR-EXE-126); a command without its context is refused by its shape (0335,
  EBMR-EXE-126). No migration was needed. The test "[INV-20][PR-30][DI-27][DI-30] an iteration that ends the loop
  before its minimum is refused ..." (apps/tablets-server/test/mutation/execution-steps-and-order.test.ts) shows it
  on dc-mini with a mixing loop and a 1 h minimum: the engine refuses the honest iteration (ENG-MIN-DURATION), the
  iteration with its own frame stored past it is refused for the minimum (EBMR-EXE-130), and the same iteration with
  an empty context, its decision refiled without frames and no END, is refused as a context that is not the loop's
  (EBMR-EXE-126); nothing is written. It is the kill test for `recipe.own_node_event_problem#39` (KILLED: under the
  mutant the own-node-event check, which runs first, refuses that row with another message).
- **D8. Execution state binding: a signature's validity failed open when missing.** `recipe.signature_change_problem`
  compared a stored signature with the recorded one; when the stored one had lost its `valid` member (or the recorded one
  had none) the comparison was NULL and nothing was refused, so through the application role an exception whose state
  dropped the validity of another step's recorded signature was stored. Fixed in recipe-core 0381: a validity that is
  not exactly true before and false after is no permitted invalidation (coalesce, as the stage sign-off rule of 0307
  does), so the row is refused (EBMR-EXE-128). Tests: "[DI-35][INV-10][PR-14] D8: a recorded signature stored without
  its validity ..." (packages/recipe-core/test/mutation/execution-state-binding.test.ts) and "[DI-35][INV-10][PR-14] an
  exception whose state drops the validity ..." (apps/tablets-server/test/mutation/execution-state-binding.test.ts),
  both failing before 0381. Harness on `recipe.signature_change_problem`: 14 mutants, all killed. The other tests of a
  stored validity already fail closed (0307's stage sign-off rule, 0320's sign-off shape, 0382); the kernel's read
  `esig.signature_state`, which computes the validity and is never written by a writer.
- **D9. Execution state binding: any row could invalidate another step's signature.** The binding check let any row turn
  any recorded signature of another step from valid to not valid, with no data changed, and left its signer among the
  performers; the engine invalidates only on a change of signed content or through a correction or result
  invalidation. Fixed in recipe-core 0382 (decision D9.1, EBMR-EXE-128): a row, whatever its kind, makes a recorded
  signature of any step instance invalid only as the engine does: a PERFORMED signature of a step it leaves
  IN_PROGRESS whose data (values, computed values, entries, exceptions that are data of the step) it changes, the
  signer then no longer a PERFORMED signer; in a CORRECT_ENTRY or INVALIDATE_RESULT, the PERFORMED and CHECKED
  signatures of a step COMPLETED or AWAITING_VERIFICATION before the row that it sends back for re-verification or
  reopens. Tests: "[DI-35][INV-10][PR-14][INV-03] the engine's three paths are accepted ..." and "... the data a
  step's signature covers changes ..." (packages/recipe-core/test/mutation/execution-state-binding.test.ts), and "...
  an exception whose state makes another step's PERFORMED signature ... invalid is refused ...", "... on the clearance
  two operators fill ..." and "... a correction of a verified value sends its step back for re-verification ..."
  (apps/tablets-server/test/mutation/execution-state-binding.test.ts), the first two store-level tests failing before
  0382 (the third shows the engine's own correction recorded). The golden replays and the execution SQL and store tests
  pass with it. Harness on the three new functions: 76 mutants, 75 killed (two more server tests, a refused value and a
  refused correction on a step already marked for re-verification, and two unit cases were added for the first run's
  survivors); `recipe.signature_invalidation_problem#43` is equivalent: it makes the default of
  `coalesce(role = 'PERFORMED' and status = 'IN_PROGRESS', false)` true, and that line is reached only after the check
  above it accepted the invalidation, which needs a role of PERFORMED or CHECKED and a status, so the expression is
  never NULL.
- **D10. Market authorisation: activation and cells written around the command.** The activation table had only a
  stamp trigger and the cell guard did not check the version's state, so owner-level code could write an activation
  and a CURRENT cell for a version only CHECKED, skipping every check of the activation command, and the issue command
  then pinned batches to it. Fixed in recipe-core 0383 (decision D10.1): the table guards re-check the command's
  conditions (no marker: owner-level code could write a marker as easily as the row); a cell needs the version's state
  row APPROVED, an active record, a predecessor that is the CURRENT cell of an earlier version ending where it begins,
  and is superseded only by a cell written after it. Tests: "[INV-17][PR-02][DI-04][DI-37][PR-04] an activation row is
  refused unless the command would have written it ..." and "[INV-17][PR-05][PR-04] a cell is refused for a version
  that is not APPROVED ..." (packages/recipe-core/test/mutation/market-authorisation-and-issue.test.ts), both failing
  before 0383. The kill test of `recipe.guard_in_flight_dispositioned#3` used this arrangement: adapted, it shows each
  step of it refused (it fails before 0383), and keeps the guard's rule (`<`, earlier versions only) on the state the
  superuser plants with every trigger off, so the mutant stays killed. For writers with the triggers on that mutant is
  equivalent since 0383: a pin needs a valid cell, a cell needs the version's state row APPROVED when it is written, and
  the version machine has no way from APPROVED back to CHECKED, so when the approval's guard runs no batch is pinned to
  the version itself. Harness on the three guards: 70 mutants, 68 killed, after two more tests for the first run's
  survivors, both failing before 0383: "[INV-17][PR-02] an activation takes effect no earlier than the instant its
  transaction began ..." (a row from that very instant accepted, one a microsecond before refused) and
  "[INV-17][PR-05][PR-04] a cell supersedes only the CURRENT cell of an earlier version of its own family, market, site,
  line and batch size ..." (a predecessor of another family, market, line or batch size, one of the cell's own version,
  and a BRIDGING written as the successor, each refused). The two left are equivalent (reported, not recorded in
  equivalent.json): `recipe.market_authorisation_activation_guard#27` makes the default of
  `coalesce((v_ev ->> 'complete')::boolean, false)` true, and `recipe.evidence_status` (0120, never redefined) always
  gives `complete` as a boolean (whether its list of missing items is empty), so the default is never read; `#36` makes
  `effective_from > clock_timestamp()` `>=`, which differs only when the row's date equals, to the microsecond, the clock
  the guard reads after its permission and signature checks, a clock boundary no writer can aim at. In the cell guard,
  the test of the predecessor's kind can never be true (a cell with a successor is SUPERSEDED, which the table allows
  only for a CURRENT cell); it is kept as written. `recipe.guard_in_flight_dispositioned`: 13 mutants, all killed with
  the adapted test. Not closed here: a cell's end and a withdrawal row written around their commands (they only take
  an authorisation away), and D11 (the state row moved under the engine flag).
- **D14. Sandbox and import: a misleading family-code reason.** When a test package's family code was not text, the
  refusal (EBMR-EXE-134, correct) named the same value on both sides, and when only the stored family code or product
  differed it named the package's value, which is the content's own. Fixed in recipe-core 0384 (wording only, what is
  refused is unchanged): a family code that is not text is named as such with both values and their JSON type; a
  value that differs is named on the side that differs, the package's or the stored one. Tests: "[DI-04][DI-37] a
  family code or product that is not the content's is named on the side that differs ..."
  (packages/kernel/test/mutation/sandbox-and-import.test.ts) and the two family-code tests of
  apps/tablets-server/test/mutation/sandbox-and-import.test.ts, failing before 0384. Harness on
  `recipe.package_header_problem` and `recipe.json_value_described`: 6 mutants, all killed.

Open (the lead takes these next):

- **D11. Kernel state engine: a history row forged with the session flag.** For an insert into
  `platform.state_history` the guard checks only a session setting any role can set, so owner-level code can write
  an arbitrary transition (for example a version approved at version 100); `platform.state_violations()` finds it only
  afterwards. The kernel's own tests treat a forged flag as an attack the guards must withstand.
- **D13. Evidence listener: the hold ends before the time it was announced.** The tick prune deletes by tick time, but
  the hold by another key's run is measured from the time the tick was closed, so a late-closed tick is pruned early,
  the hold ends early, and the `heldUntilUs` the database already returned is too late. A one-condition fix (prune
  only rows whose tick and close are both over an hour old) is proposed; decision X43 words the rule both ways, so
  the owner or lead picks it.
- **D15. Connection roles: an unknown grantee breaks the connect policy's statement.** When a backend-signal function's
  privileges name a role oid the cluster does not know (a direct catalogue write by a superuser), the policy fails
  with a syntax error instead of a coded refusal. It fails closed; only the message is wrong.

Notes from the reviews that are not defects:

- The batch-number-register kill test for `site.define_batch_number_rule#44` replaces `pg_catalog.clock_timestamp()`
  with a test double as superuser, inside a rolled-back transaction in the test's own database, to reach the exact
  clock boundary. The lead decides whether that stub is acceptable in a kill test.
- mbr-lifecycle: an element marked REGISTERED without an id on the new side is reported as a removed registered range.
  This is harmless only while content validation forbids such elements.
- Two kill tests were adapted on the integrated tree (no assertion loosened): the execution-state-binding start-data
  test (recipe-core 0345 on the PR branch now refuses every accepted start that carries start data, so the test asserts
  that refusal and reaches the entry rule by the two paths left), and the execution-commands role-map test (its
  exception description named a review item in a form the sandbox identifier rule reads as a lot number; it is now
  prose).
