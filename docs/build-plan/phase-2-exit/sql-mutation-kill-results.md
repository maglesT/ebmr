# Phase 2 exit: SQL mutation kill results

The SQL mutation harness (`tools/sql-mutation`, branch phase-2/sql-mutation) mutated the database functions behind the
Phase 2 guards in two batches. For every group below its target, a kill agent wrote tests that detect the surviving
mutants, or argued that a survivor is equivalent (no input can tell it from the original). A second agent, the
skeptic, then tried to break each equivalence claim and each reported defect; a claim it broke went back for a test
(round 2). This page records the outcome of all 28 groups: 24 merged on branch phase-2/kill-integration, and the last
four (device-readings, evidence-source-and-entries, entry-references-and-schema and signed-content) merged on branch
phase-2/kill-integration-2b, which starts from phase-2/recipe-core with the first 24 already in it.

How to read the table:

- **Before**: the group's batch score, detected over valid mutants (invalid and equivalent ones left out). Batch 1
  ran locally (its summary); batch 2 ran on GitHub, one "SQL mutation report (group)" check run per group on the
  harness commit e236af3. The last four groups' survivors are those of the batch 2b report (the same commit); their
  totals come from the same check runs.
- **Killed**: survivors the group's new kill tests detect, as the kill agent's final harness run on its own branch
  reported them. Where a function had been redefined between the batch run and the kill branch's base, the agent
  counted the mutants of the current definition, so this number can differ from the batch's survivors (noted per
  group).
- **Equivalent**: claims the skeptic upheld. They are now in `tools/sql-mutation/equivalent.json` under their current
  ids, each with a short reason, and count as neither detected nor survived.
- **Left**: survivors neither killed nor accepted as equivalent.
- **Tests**: the kill tests in the group's files (`packages/kernel/test/mutation`, `packages/recipe-core/test/mutation`,
  `apps/tablets-server/test/mutation`), all passing on the integrated tree: 445 in 33 files (271 in the db project,
  174 in the server project) for the first 24 groups, and 118 in 7 files (26 db, 92 server) for the last four, on
  phase-2/kill-integration-2b. Each control a kill test is tagged with lists it.

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

### Batch 2, the last four groups (phase-2/kill-integration-2b)

| Group | Before | Survived | Killed | Equivalent | Left | Tests (db + server) |
|---|---|---|---|---|---|---|
| device-readings | 231/367, 62.9 % | 136 | 124 | 11 | 1 (h) | 69 (server) |
| evidence-source-and-entries | 155/213, 72.8 % | 58 | 46 | 12 | 0 | 5 + 12 |
| entry-references-and-schema | 284/342, 83.0 % | 58 | 44 (i) | 14 | 0 | 16 + 1 |
| signed-content | 189/230, 82.2 % | 41 | 40 (j) | 1 | 0 | 5 + 10 |

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
- (h) `tab.ed25519_verify#13` (tablets 0270:222: in the loop that finds the top bit, `v_kb[i] = 1` becomes `<>`). It
  is not equivalent, but no test can find an input that tells it apart: the outputs differ only when
  k = SHA-512(R||A||M) mod L lies in [2^252, L) while S < 2^252, about 2^-126 per try, and a caller chooses R, A and M
  but not k (for a key of small order, where k would not matter, bit 252 does not matter either, since 8 divides
  2^252). The skeptic agreed. `equivalent.json` maps an id to a reason and the harness counts every id it lists as
  equivalent, so the file cannot mark an entry as practically unkillable; the mutant is not recorded there and stays
  the group's one survivor (355 of 356 detected, 99.7 %, with the 11 equivalents left out).
- (i) Includes `recipe.lot_usability_problem#6`, removed by the fix (recipe-core 0372, D17), which rewrote its line.
  Replacing the function renumbered its mutants (the batch's #11, #26 and #30 are now #9, #24 and #28, all killed), and
  the kill agent's harness run killed all 20 mutants of the new definition. The group has 340 mutants on this tree
  (342 at e236af3).
- (j) Includes `recipe.check_signatures#121` and `#125`, claimed equivalent in round 1 and killed in round 2 by a
  two-connection test (a block's check meaning released while a VERIFY waits to read its step's meanings). The
  round-2 confirmation run over all 41 ids stopped when the 5433 cluster ran out of disk, before 12 ids
  (`recipe.check_signatures#37`, `#42`, `#48`, `#90`, `#111`, `recipe.step_instance_number#1`, `#4` to `#7`,
  `recipe.flow_numbering_visit#20` and `#22`) had a result. On phase-2/kill-integration-2b the harness (`--only`,
  `--workers 1`) gave all 12 KILLED by the group's kill tests: the first eight in a run that a pause for disk space then
  stopped, the last four (`step_instance_number#6`, `#7`, `flow_numbering_visit#20`, `#22`) in a second run.

Every refuted equivalence claim was killed in round 2: `recipe.guard_in_flight_dispositioned#3`,
`recipe.registered_changes#33`, `recipe.execution_state_binding_check#8`, `tab.manual_weighing_check#44` and `#50`,
and `site.define_batch_number_rule#44`; in the last four groups `tab.resolve_gateway_session#6` and `#9`,
`tab.claim_readings#90`, `tab.device_entry_readings_check#12` and `#41`, and `recipe.check_signatures#121` and `#125`.

Equivalents recorded per group (132 in all): market-authorisation-and-issue 2, mbr-lifecycle 2, execution-state-binding
2, system-facts-and-time 8, execution-steps-and-order 12, manual-weighing-gate 5, batch-number-register 1,
limit-exceptions 1, sandbox-and-import 2, designer-guards 4, tablets-sessions 10, evidence-listener 7,
signing-failure-and-reasons 1, exceptions-and-dispositions 3, execution-row-shape 7, execution-commands 8, weighing
14, read-authorisation 1, exception-source 1, late-witness-and-step-times 2, stale-commands-and-readings 1,
device-readings 11, evidence-source-and-entries 12, entry-references-and-schema 14, signed-content 1. Most are
clock boundaries (a comparison against a clock reading taken inside it, which no input can hit to the microsecond)
or tests that an earlier trigger or check already decides. Two carry a condition: `recipe.command_member_problem#49`
holds only while no block version's entry or start schema declares a top-level member called kind, and
`recipe.role_evaluation_problem#13` is equivalent for every input value but not for every clock schedule. In the
last four groups most are a skip test or a message word that matters only on rows an earlier trigger already refuses,
NULL arguments that the signature check turns into false anyway, or defaults of a value that is never NULL; one is a
clock boundary (`tab.bind_gateway_session#7`). `recipe.check_signatures#33` holds within the trust boundary only: a
superuser writing the signed-type list with triggers off could tell it apart (as for `esig.content_changed#10`).

## Fix migrations

The kill agents fixed six defects with new migrations. The numbers of the first five had been taken on the PR branch
since, so each moved into a range kept for the kill work (recipe-core 0370-0379, tablets 0700-0709, kernel
1100-1109), in the kill branches' order; the sixth (kill/entry-references-and-schema) was already written as 0372,
free on phase-2/kill-integration-2b, and keeps it. No PR-branch migration redefines any of these functions after the
definition each fix was built on (checked again at 51b3fc8, merged into phase-2/kill-integration-2b), so every body
stands as the kill agent wrote it.

| Written as | Now | Function |
|---|---|---|
| recipe-core 0344_loop_exit_limit_verdicts | recipe-core 0370_loop_exit_limit_verdicts | `recipe.check_exception_changes` (on 0305) |
| recipe-core 0345_market_authorisation_family | recipe-core 0371_market_authorisation_family | `recipe.market_authorisation_guard` (on 0160) |
| tablets 0640_api_answer_at_report_instant (first 0600) | tablets 0700_api_answer_at_report_instant | `tab.manual_path_verdict` (on 0350) |
| tablets 0650_sandbox_lot_identity_test (first 0610) | tablets 0701_sandbox_lot_identity_test | `tab.register_sandbox_lot` (on 0200) |
| kernel 1030_segregation_problems_missing_roles | kernel 1100_segregation_problems_missing_roles | `sandbox.segregation_problems` (on 0980) |
| recipe-core 0372_lot_material_null_line | recipe-core 0372_lot_material_null_line (kept) | `recipe.lot_usability_problem` (on 0330) |

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
- **D17. Entry references: a lot of any material at a BOM line that names null.** `recipe.lot_usability_problem`
  (recipe-core 0330) compared a lot's material with its BOM line's only when the line's material was neither absent
  nor JSON null; the engine (blocks/generic/material.ts) compares whenever the line has a material, so it refuses
  that lot (G07-WRONG-MATERIAL) and the database was the weaker of the two, against decision F12.3. The MBR parser
  never defines such a line, but a test package imported through the application role (`recipe.import_test_package`
  does not parse content) can hold one, and a lot of any material was then weighed or charged at that line (PR-18,
  IN-23, PR-21). Low severity. Fixed in recipe-core 0372: the line is compared whenever it has a material member, and
  the refusal names null as the engine does. The decisions document has no correction line for F12.3 yet; the kill
  agent left that to the lead.

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
- **D11. Kernel state engine: a history row forged with the session flag.** For an insert into
  `platform.state_history` the guard checks only a session setting any role can set, so owner-level code can write
  an arbitrary transition (for example a version approved at version 100); `platform.state_violations()` finds it only
  afterwards. The kernel's own tests treat a forged flag as an attack the guards must withstand.
- **D12. Limit exceptions: nested loops on the same endpoint.** The validator and the engine accept two nested loops
  that exit on the same endpoint; at the outer exit the engine judges the point again and, on a breach, raises a
  second limit breach. The database refuses that outer exit row (fail-closed: the batch is stuck, nothing wrong is
  stored). Needs a decision; the skeptic favours the engine or validator side (two critical breaches for one reading
  look wrong on their own).
- **D13. Evidence listener: the hold ends before the time it was announced.** The tick prune deletes by tick time, but
  the hold by another key's run is measured from the time the tick was closed, so a late-closed tick is pruned early,
  the hold ends early, and the `heldUntilUs` the database already returned is too late. A one-condition fix (prune
  only rows whose tick and close are both over an hour old) is proposed; decision X43 words the rule both ways, so
  the owner or lead picks it.
- **D14. Sandbox and import: a misleading family-code reason.** When a test package's family code is not text, the
  refusal (EBMR-EXE-134, correct) names the same value on both sides; reachable through the application role. Message
  wording only.
- **D15. Connection roles: an unknown grantee breaks the connect policy's statement.** When a backend-signal function's
  privileges name a role oid the cluster does not know (a direct catalogue write by a superuser), the policy fails
  with a syntax error instead of a coded refusal. It fails closed; only the message is wrong.
- **D16. Device readings: a gateway key of small order is enrolled.** `tab.enrol_gateway_key` (tablets 0250) checks
  only that the key is base64 and that its SHA-256 is the fingerprint registered for the SERVER device; it checks
  neither the Ed25519 SPKI header and length nor the decoded point. A key of small order (for example the neutral
  point) can therefore be enrolled, and under such a key the cofactorless check `tab.ed25519_verify` (as OpenSSL's)
  accepts a signature anyone can build for any content: EBMR-DEV-061 (the reading was signed by the holder of the
  enrolled key) then proves nothing for that chain, nor do EBMR-DEV-055 (the signed upload wait) and the listener's
  login proof. Enrolling needs IAM.DEVICE_MANAGE, whose holder can already enrol a key whose private half they hold;
  what a small-order key adds is that anyone who reaches ingestion can forge afterwards without a private key. The
  skeptic confirmed it on a scratch copy (`tab.ed25519_verify` with the neutral point as key returns true for R = B,
  S = 1 and for R = neutral, S = 0, as Node's verify does). No survivor shows it. Needs a decision; the agent proposes a
  new tablets migration in which enrolment refuses a key that is not the 44-byte Ed25519 SPKI, does not decode, or
  whose eightfold multiple is the neutral point.

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
- The last four groups' kill tests pass on phase-2/kill-integration-2b as written, before and after the branch merged
  the PR head 51b3fc8 (F12 rounds 7 and 8, whose identifier rule reads a test run's text as it shows and refuses a
  word with a digit that is not plain ASCII); none needed adapting.
- device-readings: `tab.alert_claim_refusal` (tablets 0250) is dead code (the application role lost EXECUTE in 0320
  and nothing calls it); its kill tests call it as superuser. A later migration could drop it.
- evidence-source-and-entries: several kills call owner-private pure functions as owner with inputs their triggers
  cannot pass (zb 0300 and zc 0303 refuse them first), the pattern the group's own tests already use. The round-2 tests
  for `tab.device_entry_readings_check#12` and `#41` reach a claim made in the very microsecond its command's
  transaction began by claiming through the product and then setting the two claims' recorded times as superuser with
  session_replication_role = replica (`tab.reading_use` is insert-only), the state such a race leaves; the lead decides
  whether that is acceptable, as for the clock stub above. The kill of `tab.state_entry_identifiers_check#8` records a
  container named without the batch-number prefix, which the server refuses (EBMR-EXE-077) and the database does not
  check; if PR-21 moves that prefix into the database, that test must change.
- signed-content: the kill file forges `recipe.test_package` with triggers off for a derivation test (a decision
  signed on a hold point). If that technique is accepted for guards, a forged signed-type list would tell
  `recipe.check_signatures#33` apart and the equivalence would need revisiting.
