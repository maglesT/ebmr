# Phase 4 focused mutation results (decision 0012)

Three builders ran in parallel: A (release gate, release, dispositions), B (after release, locking, shipping, the form
gate) and C (India gate, expiry, records, signature binding). Scope A comes first; scopes B and C and the overall
deferrals follow. Scores were taken from the harness reports of the runs (`report.json`, `summary.md`); a score that no
report holds is marked so and not estimated.

## Summary (scopes A, B and C)

| Scope | SQL groups run | First-run survivors | Outcome after the new tests | Real defects fixed |
|---|---|---|---|---|
| A, release gate and release | 4 of 7 (us-disposition stopped, 2 not run) | 298 | 232 aimed at by new tests (kill not confirmed), 6 equivalent, 60 residual with reasons | F-A1, G6.VALIDATION_BASIS (recipe-core 0932) |
| B, after release, locking, shipping, form gate | 6 of 6 (691 mutants) | 152 | 26 equivalent, 8 killed in the confirmation run, 118 aimed at by new tests and unconfirmed | none |
| C, India gate, expiry, records, signature binding | 7 of 7 | 214 | every non-equivalent survivor killed in the re-run (each group 100 %) | export permission reason text (site services 0903) |

Stryker (TypeScript) ran once per feature in scopes B and C (scores in their sections); scope A's server release feature
did not finish within an hour and is deferred. All new tests pass on the unmutated code in the final run of this branch
(PROGRESS.md). What is left (kill confirmation, groups not run, Stryker survivor triage) is listed under "Deferred to
deployment validation" at the end, as decision 0008 places validation-grade mutation work at deployment.

## Scope A, builder A

Scope A: the release gate G-REL and its items, the manufacturer release and rejection, the market dispositions and market
changes. SQL harness groups in `tools/sql-mutation/src/targets.ts`; extra tests in
`packages/recipe-core/test/mutation/release-gate.test.ts` (listed for the first three groups), with additions to
`release/dispositions.test.ts` and `apps/tablets-server/test/release/grel-tablets-items.test.ts`. One run per group on a
loaded spare cluster (3 workers, `EBMR_MUTATION_TEST_TIMEOUT=120000`), then survivors triaged once (owner's limit).

### Group scores (first run, before the new tests)

| Group | Detected / mutants | Score | Survivors | Targeted by new tests | Equivalent | Residual |
|---|---|---|---|---|---|---|
| release-gate | 109 / 231 | 47.2 % | 122 | 105 | 4 | 13 |
| release-gate-market-items | 38 / 51 | 74.5 % | 13 | 11 | 0 | 2 |
| manufacturer-release | 105 / 165 | 63.6 % | 60 | 53 | 2 | 5 |
| tablets-release-items | 150 / 253 | 59.3 % | 103 | 63 | 0 | 40 |
| us-disposition | no score: run stopped by a container restart after about 100 of 146 mutants (51 survivors logged); no report written | | not triaged | | | |
| qp-certification | not run | | | | | |
| market-changes | not run | | | | | |

**Kill confirmation deferred.** The 232 survivors targeted by the new tests were not re-run (`--only`); by the owner's
rule the confirmation pass (about 10 to 15 hours on this machine) belongs to deployment validation. The new tests pass on
the unmutated schema. Note that `recipe.grel_core_items` now has a later definition (recipe-core 0932, below), so its
mutants are numbered from that definition in the next run.

### Real defect fixed

**F-A1, G6.VALIDATION_BASIS (recipe-core 0932; PR-06, PR-09, INV-05).** The item read only the change record of the
batch's own master version. A revision approved as not process-impacting needs no validation link (PR-06), so every lot
made on it stayed RED and could not be released. With the owner's default the item now walks back through the versions the
master was derived from to the last process-impacting version (the change owner's classification or
`recipe.process_impact`, as the approval guard reads them) and uses that version's validation references. Test
`[PR-06][INV-05]` in `release-gate.test.ts`: a title-only revision is GREEN through its parent's basis; the same revision
marked process-impacting without its own link is RED.

### Equivalent mutants (recorded in `tools/sql-mutation/equivalent.json`)

- `recipe.grel_core_items#13`, `#125`, `#134`, `recipe.investigation_justification_of#8`: the `coalesce(..., false)`
  default on `esig.signature_state(...) ->> 'valid'` is never taken (the key is always a boolean).
- `recipe.grel_core_items#145`: the G6.LICENCE placeholder is replaced in `recipe.grel_evaluate` before anything reads it.
- `recipe.post_change_record#17`: the row comparison `<` to `<=` cannot differ when the ids already differ.

### Residual survivors (reasons)

- Time boundaries against the QA review time (`>` to `>=`): `grel_core_items` #41, #78, #83, #97, #107, #114, #151;
  `grel_market_items#32`. Equality needs the evidence written in the same instant as the review act.
- QA review signature selection, `grel_core_items` #7, #8, #9: a batch's own QA signature becomes invalid only together
  with a review state that the item already reports.
- `release_deviations#6`, `investigation_unjustifiable_for#9`: differ only for CONTAINER links (no containers in the
  recipe-core fixtures).
- `release_deviations#7`: differs only if a lot or container id equals a batch id.
- `grel_market_items#20`: needs a batch of the evidence set with no stub batch or master version.
- `record_manufacturer_release#40` (REL-016 at recording) and `#53` (REL-018 content): defence in depth behind the
  kernel's refusal at signing and the signature validity check under the epoch locks.
- `investigation_justification_of` #2, #4, #6: need a second signed justification on another lot, market or deviation.
- `tablets-release-items`, 40 survivors in `tab.grel_held_containers`, `tab.grel_whole_batch_parents`,
  `tab.grel_recon_printed`, `tab.grel_next_hold`, `tab.grel_rule_sets`, `tab.grel_unresolved`,
  `tab.grel_posted_quantity`, `tab.grel_printed_tablets`, `tab.grel_recon_packs`, `tab.grel_container_release`,
  `tab.grel_item_of`: they need held, merged and charged container scenarios in the server fixture, not built within the
  limit.

### Deferred to deployment validation

- Kill confirmation of the 232 targeted survivors (above).
- us-disposition survivors (not triaged), qp-certification and market-changes (not run).
- Stryker on `apps/tablets-server/src/features/release`: with the server template set-up it does not finish in under an
  hour with one worker.

## Scope B, builder B (after release, locking, shipping, the form gate)

Builder B was stopped by a container restart; its last commit is saved work in progress. One full run of the six groups
(`m3`, 14 October, 691 mutants), then the confirmation re-run of the 127 non-equivalent survivors with B's new tests
(`--only`), which the restart stopped after 8 mutants (all 8 killed, in after-release-suspension).

| Group | First run detected / valid | Score | Survivors | Equivalent | Killed in confirmation | Unconfirmed | After |
|---|---|---|---|---|---|---|---|
| after-release-suspension | 62 / 83 | 74.7 % | 21 | 2 | 8 | 11 | 70 / 81 (86.4 %) |
| after-release-decisions | 151 / 197 (1 invalid) | 76.6 % | 46 | 5 | 0 | 41 | 151 / 192 (78.6 %) |
| shipping-interlock | 65 / 89 | 73.0 % | 24 | 13 | 0 | 11 | 65 / 76 (85.5 %) |
| record-lock-and-amendment | 139 / 166 | 83.7 % | 27 | 3 | 0 | 24 | 139 / 163 (85.3 %) |
| bulk-and-bright-stock | 116 / 149 | 77.9 % | 33 | 2 | 0 | 31 | 116 / 147 (78.9 %) |
| execution-complete-forms | 5 / 6 | 83.3 % | 1 | 1 | 0 | 0 | 5 / 5 (100 %) |

"After" counts only kills a run has shown; the 118 unconfirmed survivors are aimed at by B's new tests, but whether
each is killed is not known.

- Tests added: `recipe-core/test/release/after-release.test.ts` (suspension causes, which markets a suspension covers,
  re-confirmation, revised results), `recipe-core/test/lifecycle/record-lock.test.ts`,
  `recipe-core/test/lifecycle/execution-complete-forms.test.ts`, `recipe-core/test/shipping/erp-shipping.test.ts`,
  `tablets-server` `release/after-release-acts.test.ts`, `release/after-release-routes.test.ts`,
  `records/records-routes.test.ts`, `blocks/packaging/bulk-gate-gmp.test.ts`.
- Equivalents (26, `tools/sql-mutation/equivalent.json`): raises behind an earlier `recipe.assert_release_signature`
  or content-hash check (ARL-017, ARL-037, ARL-044, LCK-035, LCK-044); the release-model presence checks in site services
  that every built database satisfies; `>=` to `>` boundaries that differ only for events in the same instant as the
  release; null-or-not-object input checks.
- Stryker (TypeScript, `tablets-server`): the release feature (`after-release.ts`, `index.ts`, `signables.ts`) 90.3 %
  (215 killed, 12 survived, 11 without coverage); the records feature (`index.ts`, `reads.ts`, `signables.ts`) 71.7 %
  (235 killed, 26 survived, 67 without coverage). One run each; survivors not triaged.

## Scope C, builder C (India gate, expiry, records, signature binding)

Builder C committed its tests before the restart. One run per group, then one re-run of the survivors with the new tests.

| Group | First run detected / valid | Score | Survivors | Equivalent | After the re-run |
|---|---|---|---|---|---|
| india-licences | 151 / 223 (3 invalid) | 67.7 % | 72 | 8 | 216 / 216 (100 %) |
| india-issue-gate | 65 / 83 (2 invalid) | 78.3 % | 18 | 4 | 79 / 79 (100 %) |
| india-expiry | 17 / 31 | 54.8 % | 14 | 2 | 29 / 29 (100 %) |
| india-h2-and-allocation | 29 / 41 | 70.7 % | 12 | 0 | 41 / 41 (100 %) |
| records-evidence-export | 61 / 114 | 53.5 % | 53 | 4 | 110 / 110 (100 %) |
| records-contingency-forms | 73 / 89 | 82.0 % | 16 | 2 | 87 / 87 (100 %) |
| pqr-extract | 107 / 136 | 78.7 % | 29 | 0 | 136 / 136 (100 %) |

- Real defect fixed (site services 0903): `site.export_permission_problem` gave "it lapsed at <valid until>" for an
  instant inside the permission's validity but before its approval; it now says "it is not current", as
  `site.licence_problem` does. Only the reason text was wrong; the gate's answer was right.
- Tests added: `site-services/test/mutation/india-licences.test.ts`; `recipe-core/test/mutation/` `india-issue-gate`,
  `india-expiry`, `india-h2-and-allocation`, `pqr-extract`, `records-contingency-forms`; `kernel/test/mutation/`
  `records-evidence-export`, `records-contingency-forms`; `kernel/test/records/evidence-export-offline.test.ts`; route
  edges of the `tablets-server` India feature.
- Equivalents (26, `tools/sql-mutation/equivalent.json`): raises behind an earlier signature-validity refusal
  (IND-011, IND-018, IND-063, REC-105, REC-126); null-argument `or` to `and` where a null in one argument already makes
  the result null; row comparisons whose equal case is filtered out before them; the India record immutability trigger's raise
  on tables the kernel already registers as insert-only.
- Stryker (TypeScript): kernel `src/records` (contingency, evidence export, PDF true copy, PDF/A) 88.6 % first run,
  96.3 % after the offline tests (364 killed, 10 survived, 4 without coverage); `tablets-server` India feature 51.2 %,
  then 64.6 % (193 killed, 37 survived, 69 without coverage), a third run stopped by the restart at 292 of 299 (no score);
  `tablets-server` archive and PQR features 47.9 % (282 killed, 164 survived, 143 without coverage), one run, not triaged.

## Deferred to deployment validation (all scopes, decision 0008 and the owner's limit of 14 October)

- Scope A: kill confirmation of the 232 targeted survivors; us-disposition (no score), qp-certification and
  market-changes (not run); Stryker on the server release feature.
- Scope B: confirmation of the 118 unconfirmed survivors; triage of the Stryker survivors.
- Scope C: the Stryker survivors and uncovered code in the server India, archive and PQR features.
- The SQL groups of scopes A and B with the new tests as a whole re-run, under the decision 0009 organisation (one SQL
  stream, one Stryker stream).
