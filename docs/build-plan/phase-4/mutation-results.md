# Phase 4 focused mutation results, builder A (decision 0012)

Scope A: the release gate G-REL and its items, the manufacturer release and rejection, the market dispositions and market
changes. SQL harness groups in `tools/sql-mutation/src/targets.ts`; extra tests in
`packages/recipe-core/test/mutation/release-gate.test.ts` (listed for the first three groups), with additions to
`release/dispositions.test.ts` and `apps/tablets-server/test/release/grel-tablets-items.test.ts`. One run per group on a
loaded spare cluster (3 workers, `EBMR_MUTATION_TEST_TIMEOUT=120000`), then survivors triaged once (owner's limit).

## Group scores (first run, before the new tests)

| Group | Detected / mutants | Score | Survivors | Targeted by new tests | Equivalent | Residual |
|---|---|---|---|---|---|---|
| release-gate | 109 / 231 | 47.2 % | 122 | 105 | 4 | 13 |
| release-gate-market-items | 38 / 51 | 74.5 % | 13 | 11 | 0 | 2 |
| manufacturer-release | 105 / 165 | 63.6 % | 60 | 53 | 2 | 5 |
| tablets-release-items | 150 / 253 | 59.3 % | 103 | 63 | 0 | 40 |
| us-disposition | run finishing (score pending) | | not triaged | | | |
| qp-certification | not run | | | | | |
| market-changes | not run | | | | | |

**Kill confirmation deferred.** The 232 survivors targeted by the new tests were not re-run (`--only`); by the owner's
rule the confirmation pass (about 10 to 15 hours on this machine) belongs to deployment validation. The new tests pass on
the unmutated schema. Note that `recipe.grel_core_items` now has a later definition (recipe-core 0932, below), so its
mutants are numbered from that definition in the next run.

## Real defect fixed

**F-A1, G6.VALIDATION_BASIS (recipe-core 0932; PR-06, PR-09, INV-05).** The item read only the change record of the
batch's own master version. A revision approved as not process-impacting needs no validation link (PR-06), so every lot
made on it stayed RED and could not be released. With the owner's default the item now walks back through the versions the
master was derived from to the last process-impacting version (the change owner's classification or
`recipe.process_impact`, as the approval guard reads them) and uses that version's validation references. Test
`[PR-06][INV-05]` in `release-gate.test.ts`: a title-only revision is GREEN through its parent's basis; the same revision
marked process-impacting without its own link is RED.

## Equivalent mutants (recorded in `tools/sql-mutation/equivalent.json`)

- `recipe.grel_core_items#13`, `#125`, `#134`, `recipe.investigation_justification_of#8`: the `coalesce(..., false)`
  default on `esig.signature_state(...) ->> 'valid'` is never taken (the key is always a boolean).
- `recipe.grel_core_items#145`: the G6.LICENCE placeholder is replaced in `recipe.grel_evaluate` before anything reads it.
- `recipe.post_change_record#17`: the row comparison `<` to `<=` cannot differ when the ids already differ.

## Residual survivors (reasons)

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

## Deferred to deployment validation

- Kill confirmation of the 232 targeted survivors (above).
- us-disposition survivors (not triaged), qp-certification and market-changes (not run).
- Stryker on `apps/tablets-server/src/features/release`: with the server template set-up it does not finish in under an
  hour with one worker.
