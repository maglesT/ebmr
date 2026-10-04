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
| execution-steps-and-order | 374/461, 81.1 % | 87 | 73 | 12 | 2 (c) | 20 + 7 |
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
- (c) `recipe.minimum_duration_problem#15` and `recipe.own_node_event_problem#39`, each tied to an open defect below
  (D6, D7). A test for either would have to fix in place behaviour the lead has not decided yet.
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
  was accepted beside a gateway that had answered. Fixed in tablets 0700 (`>` becomes `>=`). Still open, wording
  only: the ANSWERED refusal still says the API answered "after" the report.
- **D4. Sandbox and import: a test lot without its identity-test flag.** The register's check gave NULL for a missing
  flag, so the lot was refused by the table's NOT NULL constraint with a bare database error instead of EBMR-EXE-070.
  Fixed in tablets 0701. Still open, wording only: the message names a material and a status the function itself
  does not check (the table's constraints refuse such a lot).
- **D5. Connection roles: the sandbox segregation query failed on a missing role.** In a sandbox, a GMP login role
  the cluster lacks made `sandbox.segregation_problems()` fail with "role does not exist" instead of reporting the
  problem, because PostgreSQL evaluated the privilege test before the existence test; rows also came out in join
  order. Fixed in kernel 1100: roles are read from the catalogue and asked about by oid, in role order.
- **D11. Kernel state engine: a history row forged with the session flag.** For an insert into
  `platform.state_history` the guard checked only the engine flag, a session setting any role can set, so owner-level
  code could write an arbitrary transition (for example a version approved at version 100) and
  `platform.state_violations()` found it only afterwards. Only the table owner and superusers can write the state
  tables (the application role holds SELECT, the sandbox role mirrors it, and the engine functions they may call write
  every value themselves). Fixed in kernel 1110 (decision D11.1): whatever the flag says, a history row must be a
  published transition of the pinned machine version, record that transition's permission and signature meaning (and
  a signature id exactly when one is needed), continue the latest history row and be what the state row records
  (EBMR-PLAT-077); a creation row starts a published version; a state row starts only for the aggregate type its
  machine governs (EBMR-PLAT-072), and commits only with its history row (EBMR-PLAT-078, deferred to the commit). Left:
  owner-level code that forges the flag can still make a published transition, both rows agreeing, without the
  engine's permission, signature and guard checks. Tests: `packages/kernel/test/platform/state-machine.test.ts` (three
  [DI-34][DI-17] tests: the forged rows refused, the honest transitions unchanged) and the new mutation group
  state-engine-rows (`packages/kernel/test/mutation/state-engine-rows.test.ts`). The kill test for
  `recipe.guard_in_flight_dispositioned#3` now shows the owner-level forged row refused and arranges it as the
  superuser with triggers off, taking it away before the approval; it still kills the mutant.
- **D13. Evidence listener: the hold ended before the time it was announced.** The tick prune deleted by tick time,
  but the hold by another key's run is measured from the time the tick was closed, so a late-closed tick was pruned
  early, the hold ended early, and the `heldUntilUs` the database had already returned was too late. Fixed in tablets
  0715 (decision D13.1, the proposed default): a tick prunes only rows whose tick and close are both over an hour old
  (an open row by its tick, as before); X43, X40 and X37 now say the hour runs from the close. Test:
  `apps/tablets-server/test/mutation/evidence-listener.test.ts` ([DI-30][PR-20][DI-17], a run of another key that
  ticked 61 minutes ago and closed 59 minutes ago holds until its close plus one hour, then is pruned).
- **D15. Connection roles: an unknown grantee broke the connect policy's statement.** When a backend-signal function's
  privileges named a role oid the cluster does not know (a direct catalogue write by a superuser), the policy built a
  revoke with an empty grantee and failed with a syntax error instead of a coded refusal (fail closed, wrong message).
  Fixed in kernel 1111: `sandbox.apply_connect_policy()` first looks for such entries and refuses with EBMR-SBX-038,
  naming each function and unknown oid, before it applies anything; the sandbox README lists the code. Tests:
  `packages/kernel/test/security/backend-signals.test.ts` ([DI-17][DI-30], the refusal, nothing applied, the
  installation still reported as not holding the policy); the connection-roles kill test now asserts the coded message.

Open (the lead takes these next):

- **D6. Execution steps: a minimum duration that ends where a token arrives.** The validator accepts a minimum that
  ends at the start of an operation, section, stage, loop or hold point; the engine records such a start without
  flagging it, the engine's own INV-20 checker then reports a violation, and the database skips it. An honest run of
  a validated MBR thus fails INV-20 in the engine while the database accepts it. Needs a decision: the validator
  refuses such a minimum, or the engine and database flag the early start. Leaves
  `recipe.minimum_duration_problem#15`.
- **D7. Execution steps: a loop exit recorded without its loop context.** The rule that a loop's exit needs the loop's
  END (recipe-core 0312, 0314, 0316) applies only when the iteration's context is not empty, so through the
  application role a loop could be left before its minimum duration with no END recorded. The kill agent read that
  recipe-core 0338 (on this tree) refuses an iteration whose context does not end with the loop's own frame
  (EBMR-EXE-126), which would close it, but did not run it there. Open until a test on the integrated tree shows it
  (the kill test for `recipe.own_node_event_problem#39`).
- **D8. Execution state binding: a signature's validity fails open when missing.** `recipe.signature_change_problem`
  compares a stored signature with the recorded one; when the stored one has lost its `valid` member the comparison
  is NULL and nothing is refused, so a forged row that strips the validity is accepted. A one-line fix (treat the
  missing value as a change) is suggested; the sibling sign-off rule already does so. Impact is limited: the engine
  reads a missing validity as not valid.
- **D9. Execution state binding: any row may invalidate another step's signature.** The binding check lets any row
  turn any recorded signature of another step from valid to not valid, with no data changed, and leaves its signer
  among the performers; the engine invalidates only on a change of signed content or through a correction or result
  invalidation. Needs a design decision on which rows may invalidate which signatures.
- **D10. Market authorisation: activation and cells written around the command.** The activation table has only a
  stamp trigger and the cell guard does not check the version's state, so owner-level code can write an activation
  and a CURRENT cell for a version that is only CHECKED, skipping every check of the activation command, and the
  issue command then pins batches to it. Fix options (accept rows only from the command, or re-check its conditions
  in the table guards) change semantics the lead should choose. The kill test for
  `recipe.guard_in_flight_dispositioned#3` uses this arrangement; once D10 and D11 are closed that mutant becomes
  equivalent and the test needs revisiting.
- **D12. Limit exceptions: nested loops on the same endpoint.** The validator and the engine accept two nested loops
  that exit on the same endpoint; at the outer exit the engine judges the point again and, on a breach, raises a
  second limit breach. The database refuses that outer exit row (fail-closed: the batch is stuck, nothing wrong is
  stored). Needs a decision; the skeptic favours the engine or validator side (two critical breaches for one reading
  look wrong on their own).
- **D14. Sandbox and import: a misleading family-code reason.** When a test package's family code is not text, the
  refusal (EBMR-EXE-134, correct) names the same value on both sides; reachable through the application role. Message
  wording only.

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
