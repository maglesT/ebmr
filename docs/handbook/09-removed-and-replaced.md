# Removed and replaced

**Draft.** This page records what the project took out, replaced or superseded in Phases 1 to 4, and why. It answers
the question "this code looks odd, was there something here before?". It is written for developers who read a
migration, a decision or an old test and find a name that no longer exists. Decision 0013 asks for this history, and
decision 0014 says every later removal adds a line here.

Terms such as e-signature, hold point, G-REL and sandbox are in the [glossary](02-glossary.md). For bugs and their
tests see the [defect log](08-defect-log.md); this page is about design and scope changes, and about code that was
deleted.

## Where the code is

- Database migrations: [kernel](../../packages/kernel/sql/), [recipe-core](../../packages/recipe-core/sql/),
  [site-services](../../packages/site-services/sql/), [tablets-server](../../apps/tablets-server/sql/).
- Owner decisions: [docs/decisions/](../decisions/). Architecture decisions: [docs/adr/](../adr/).
- Full history (search it): [history.md](../progress/history.md).
- Commit and pull request numbers below come from `git log`; the PRs #7 to #18 are Phase 3, #19 to #27 are Phase 4
  (#19 the golden date fix, #20 to #25 slices 1 to 6, #26 slice 7, #27 the mutation work).

## How migrations replace things

A migration that has run is never edited. A later migration either:

- uses `create or replace function` (the function keeps its name; the old body is gone, and the new migration's header
  says "replaces 0xxx"), or
- uses `drop function` / `drop table` to remove an object, or
- adds a new object and stops calling the old one.

To find the version in force, use the [database catalogue](reference/db-catalogue.md). To see what the previous version
did, open the migration the header names. Reviewers diffed every replaced function against its predecessor so that no
guard was lost silently (see the [defect log](08-defect-log.md), lesson 15).

## 1. Database objects dropped

| What it was | What replaced it | Why | When | Where the new thing lives |
|---|---|---|---|---|
| `recipe.reprocessing_start_problem(uuid, text, text, text)`, the start check of a reprocessing step | the checks `recipe.g24v2_check` and `recipe.reprocessing_start_take` | its only caller was replaced by recipe-core 0625 without calling it; the function was dead, and the SQL mutation run could only report it as unreachable | 13 Oct 2026, slice 7c (commit 90eae4c9, PR #26) | [0625_reprocessing_review_fixes.sql](../../packages/recipe-core/sql/0625_reprocessing_review_fixes.sql); drop in [0930](../../packages/recipe-core/sql/0930_drop_reprocessing_start_problem.sql) |
| `recipe.unbound_real_identifier`, `bound_word`, `engine_word`, `word_path`, `audit_bound_words`, `batch_bound_words` (a list of words a test run's record may hold besides `TEST-` identifiers, such as engine names `EX-7` or `G-09`) | one structural rule in the kernel: in a sandbox a word that holds a digit is written with ASCII letters, ASCII digits and `/ . -` only | the allow-list of engine words let `S24090017` or `E2409/0017` pass as real-format batch or lot numbers; each round of review found another look-alike, so the class was closed by structure | 4 Oct 2026 (recipe-core 0346, commit 43fb811c); kernel 1120 on 5 Oct | [0346](../../packages/recipe-core/sql/0346_sandbox_bound_names.sql), [kernel 1120](../../packages/kernel/sql/1120_sandbox_digit_words_ascii.sql) |
| `tab.ingest_reading(jsonb, bigint)` (a gateway uploads a scale reading and states how long it waited) | a challenge protocol: the database issues a challenge and the gateway signs it together with its own wait | the waiting time was "the application's word", so a holder of the application credentials could keep back a genuine unsynced reading and have it counted as fresh (finding P53) | 30 Sep 2026 | [tablets 0330](../../apps/tablets-server/sql/0330_reading_freshness_challenge.sql) |
| `tab.peek_readings(uuid[], text, bigint, text)` (checks the readings of a stale weighing one purpose at a time) | the paired check that mirrors the claims of the command (tare then gross, together) | checking apart let one reading count as both tare and gross in a refused row | 3 Oct 2026 (F58.1 follow-up) | [tablets 0510](../../apps/tablets-server/sql/0510_stale_weighing_reading_pair.sql) |
| `tab.chain_readable(text, boolean, boolean, uuid)` | `tab.chain_listed(...)` and a reader-refusal function | the old function worked out "what is withheld" once per chain and let an investigation's subject read hold chains; the new one gets the withheld list as an argument and the subject sees nothing | 3 Oct 2026 (F35 round 2, commit d94a31ac, PR #6) | [tablets 0440](../../apps/tablets-server/sql/0440_investigation_subject_reads.sql) |
| `recipe.execution_stage_summary_legacy_0319` (table of sign-offs made before the summary was part of the signed text) | an audited, insert-only record the application can read | the legacy table was owner-only and not audited | 2 Oct 2026 (F01 round 2, commit 874a3182) | [recipe-core 0320](../../packages/recipe-core/sql/0320_stage_sign_off_shape.sql) |
| `recipe.push_reason(text, text)`, `recipe.restore_actor(jsonb)`, `recipe.end_open_cells(...)` (recipe code wrote a "system" reason for an audited UPDATE) | the person's own reason (both code and text) is required from the command; recipe code writes no half of it | the audit trigger demands a reason for change; a system-made text defeated its purpose (DI-22, DI-24) | 30 Sep 2026 (commit 6154f467) | [recipe-core 0290](../../packages/recipe-core/sql/0290_market_activation_reason.sql) |
| `tab.formula_reader_refusal(tab.reader)` | `tab.formula_reader_may`, which decides FORMULA.READ by role and the grant's scope for the product | the old check was not product-scoped, so a confidential formula was readable through the e-signature content route | 11 Oct 2026 (slice 6 review, PR #17) | [tablets 1042](../../apps/tablets-server/sql/1042_slice6_review.sql) |
| `recipe.evidence_epoch` as a counter updated in place | insert-only rows (one per version of a subject) written by `recipe.bump_epoch` under a per-subject lock | an updatable, unaudited counter cannot be proven; and the QA review must read the epoch under the same lock as the writer | 12 Oct 2026 (slice 1a, PR #20) | [recipe-core 0718](../../packages/recipe-core/sql/0718_review_gates_and_epoch_rows.sql) |
| recipe-core's own copy of the platform authority function (`recipe-core 0522_plant_product_scope_and_feed_age.sql`) | the kernel SCOPE hook, which lets a transition be checked in the product's scope too | the copy drifted from the kernel's function (a high finding); one definition is easier to keep right | 10 Oct 2026 (slice 3a, commit 1e66d1b0, PR #10) | [kernel 1150](../../packages/kernel/sql/1150_platform_scope_hook.sql), [ADR 0018](../adr/0018-platform-scope-hook.md) |

## 2. Behaviour replaced (the function kept its name or the old path was closed)

| What it was | What replaced it | Why | When | Where the new thing lives |
|---|---|---|---|---|
| One actor-context marker per context installed in a transaction (ADR 0016 as first written) | `kernel.command_marker` holds one row per backend; only the last installed context is valid; a saved context is restored only through `kernel.set_actor_context` | a co-signer's context could be reinstalled for the rest of the transaction (critical finding P1-F1) | 28 Sep 2026, Phase 1 exit | [ADR 0016](../adr/0016-validated-actor-context-and-definer-hardening.md) (rewritten), [0010_audit_trail.sql](../../packages/kernel/sql/0010_audit_trail.sql) |
| A shape-only actor-context hook (kernel 0010) | a validated actor context (kernel 0190) | the shape check did not prove the context was issued to this session | 27 Sep 2026, Phase 1 | [0190](../../packages/kernel/sql/0190_iam_actor_context.sql) |
| A client-supplied site zone in audit entries | a zone taken from the site policy; a different zone is refused (EBMR-IAM-118) | a caller could write any zone | 28 Sep 2026, Phase 1 exit | [kernel audit and IAM files](../../packages/kernel/sql/) |
| Market-rule approvals as free UUIDs | approvals must be e-signatures of real people | one person could loosen a limit with invented approvers | 28 Sep 2026, Phase 1 exit | [kernel 0360](../../packages/kernel/sql/0360_market_signatures.sql) |
| `EXECUTION.SWEEP` held by every service account (`SERVICE_ACCOUNT`) | a role of its own, `EXECUTION_SWEEPER` for SERVICE accounts only; the old catalogue row is marked removed, never deleted | the site gateway account could record a time sweep; the sweeper held permissions it did not need | 28 Sep 2026, Phase 2 | [recipe-core 0260](../../packages/recipe-core/sql/0260_execution_sweeper_role.sql); the real GMP identity `svc.sweeper` arrived in Phase 4 slice 1b |
| A repair of a signalled equipment failure by one maintenance person (`record_equipment_event 'REPAIRED'`) | two acts: `plant.record_repair` and `plant.verify_repair` by a second person; `REPAIRED` is no longer accepted directly (EBMR-PLANT-030) | a unit went back into use on one person's word | 10 Oct 2026 (slice 2, PR #8) | [recipe-core 0460](../../packages/recipe-core/sql/0460_plant_repair_verification.sql) |
| Lot release signature that named only the lot, and that every consumption superseded | a signature that covers route and received quantity; consumption no longer supersedes it | releasing and using a lot undid each other; quantity and route were not signed | 10 Oct 2026 (slice 2, PR #8) | [site-services 0720, 0721](../../packages/site-services/sql/0721_lot_release_received_quantity.sql) |
| Lot retest recorded by an unsigned writer (site-services 0760) | `site.record_signed_lot_retest` under a LOT_RETEST_APPROVED signature that binds lot, new date and results, used once | the signature did not bind what it decided and could be reused; the unsigned writer was still granted | 11 Oct 2026 (slice 6, PR #17) | [site-services 0762](../../packages/site-services/sql/0762_lot_retest_signed_content.sql), [tablets 1042](../../apps/tablets-server/sql/1042_slice6_review.sql) |
| Lot decisions (HOLD, UNHOLD, RETURN, RECALL) signed directly | propose first, then sign: the signature binds the proposed event; a proposal supersedes earlier signatures | the signature did not bind the event (HIGH-2) | 11 Oct 2026 (Phase 3 exit, PR #18); HTTP route in Phase 4 slice 2 | [site-services 0800](../../packages/site-services/sql/0800_lot_decision_signed_event.sql) |
| ERP master data writable by any interface identity | `ERP.MASTER_WRITE` for the ERP interface only; safety-relevant changes take effect only after QA signs `ERP_MASTER_CONFIRMED` | HIGH-1: an untrusted write could change shelf life or the beta-lactam flag | 11 Oct 2026 (Phase 3 exit, PR #18) | [tablets 1101](../../apps/tablets-server/sql/1101_erp_master_signing.sql), [site-services 0803](../../packages/site-services/sql/0803_erp_beta_lactam_confirmed.sql) |
| Evidence documents with a self-typed hash and storage key | the database stores the bytes and computes the SHA-256 and size; the typed form is refused; a document is evidence only while its bytes match | the storer could claim any hash | 12 Oct 2026 (slice 2, PR #21) | [site-services 0823](../../packages/site-services/sql/0823_evidence_document_bytes.sql), [recipe-core 0770](../../packages/recipe-core/sql/0770_evidence_verified_bytes.sql) |
| LIMS limits typed by the recorder; a lot with no results passed release | limits from the approved specification (citing the pharmacopoeia); every required test needs a current RELEASE result | recorder-typed limits and an empty result list are not evidence | 12 Oct 2026 (slice 2) | [site-services 0840, 0841](../../packages/site-services/sql/0841_lims_from_specification.sql) |
| A PACKAGING order could start without the bulk being released for packing | a bulk issue of usable containers after H-PACK is required before TB-21, TB-23 or TB-24 entries | HIGH-3 | 11 Oct 2026 (Phase 3 exit) | [recipe-core 0701](../../packages/recipe-core/sql/0701_packaging_bulk_issue.sql), [tablets 1102](../../apps/tablets-server/sql/1102_packaging_run_needs_bulk.sql) |
| `recipe.consume_lot` that checked no batch state | consumption needs an ISSUED or IN_PROGRESS batch and an entry of the same command; reservations end with the batch | HIGH-4 (orphan consumption) | 11 Oct 2026 (Phase 3 exit) | [recipe-core 0700, 0801](../../packages/recipe-core/sql/0700_consumption_guards.sql) |
| Sweeper recorded missed checks only at the next manual entry; the GMP sweeper identity did not exist (TEST-only) | the GMP service identity `svc.sweeper` on `SRV-SWEEPER-01`, role `EXECUTION_SWEEPER` only (D-P4-9) | missed-check holds on GMP depended on the next entry | 12 Oct 2026 (slice 1b, PR #20) | tablets and server set-up; secret read from `gmp-service-keys.json` |
| The 4-0 stub `recipe.suspend_release` | manufacturer suspension with the cascade to markets, the ERP stock block and the recall-assessment task | the stub only existed to let slice 4 compile | 12 Oct 2026 (slice 5, PR #24) | [recipe-core 0840](../../packages/recipe-core/sql/0840_after_release.sql) |
| Edition copies of generic-block guards (G-06 exceptions, G-07 consumption, G-21 print and serial checks) in the tablets migrations | to be re-created in recipe-core before Phase 5; the tablets copies stay until then | an Injectables installation would run the generic blocks without those guards | decided 11 Oct 2026, not yet done (Phase 5 entry criterion) | [ADR 0019](../adr/0019-generic-block-guards-in-recipe-core.md) |
| QC test codes sorted in the database's default collation | `collate "C"` | the order of signed codes must not depend on the database | 12 Oct 2026 (slice 1b) | [site-services 0810](../../packages/site-services/sql/0810_qc_test_codes_collation.sql) |
| `G6.VALIDATION_BASIS` reading the batch's own master version only | the last process-impacting version in the master's lineage | a harmless revision blocked every later lot (F-A1) | 14 Oct 2026 (PR #27) | [recipe-core 0932](../../packages/recipe-core/sql/0932_grel_validation_basis_lineage.sql) |
| Session ticket lifetimes based on `Date.now()` | `platform/clock.ts` takes the larger of monotonic and wall-clock elapsed time | a clock set back lengthened a ticket (X44) | 1 Oct 2026 | `apps/tablets-server/src/platform/clock.ts` |
| Sign-out mark as a cookie any port could write | site storage plus a broadcast channel of the origin | cookies are shared across ports (F42) | 2 Oct 2026 | tablets-web sign-out |
| A kiosk "NOT SAVED" resend that departs from ADR 0006 item 4 | resend with the same idempotency key and a fresh badge tap by the same person (decision D1 in [phase-2-open-questions.md](../decisions/phase-2-open-questions.md)) | the answer to a request may be lost; the entry must not be duplicated or attributed to the wrong person | 28 Sep 2026, Phase 2 | tablets server session and execution features |
| Designer leftover draft keyed by version only, kept after sign-out | every designer draft is removed at sign-out; the author's own leftover draft can only be discarded | a shared terminal could show the next person a draft (F50) | 2 Oct 2026 | tablets-web designer |

## 3. Demo shortcuts and code removed

| What it was | What replaced it | Why | When | Where the new thing lives |
|---|---|---|---|---|
| The **demo H-PACK shortcut** and the packaging-order DEMO SHORTCUT in the e2e seed (`--gmp-packaging`): a superuser update with triggers off and a placeholder hold-point signature in the stored state | a release path that runs a GB-T-02 batch to QA's release for packing and two bottle orders to their end through real signed acts; one lot READY, one NOT_READY | no demo record may carry a placeholder signature; the golden batch GB-T-02 made a real parent possible. The shortcut had been kept in slice 3c as a labelled residual (lead's decision). `apps/tablets-server/src/cli/packaging-master.ts` was deleted | 13 Oct 2026, slice 7b (commit 476b06b8, PR #26) | `apps/tablets-server/src/cli/release-path.ts`, [GB-T-02 README](../../apps/tablets-server/test/golden/gb-t-02/README.md) |
| DEMO-ONLY seeds usable on any database | the seeds refuse a database whose name is not a demo name and check `tab.demo_installation` | a seed that skips controls must never run on a real database (high finding, slice 2 review) | 12 Oct 2026 (commit dee43262, PR #21) | `apps/tablets-server/src/cli/` |
| `tools/e2e/specs/release/market-flow.spec.ts` | the market flow now runs after the rejection inside the release spec | two specs acted on the same lot and raced | 12 Oct 2026 (commit 818036aa, PR #23) | `tools/e2e/specs/release/` |
| Work-in-progress snapshot files (`dump.test.ts`, `zz-debug.test.ts`, `simulate-worker-boot.mjs`, `raw.d.ts`) | nothing; they were scratch files swept into early snapshot commits | not part of the product | Sep to Oct 2026 | none |
| Date-dependent golden hashes | lot dates stay as seeded; the year is a placeholder; hashes re-recorded | a golden test must be repeatable on any day | 12 Oct 2026 (PR #19) | [GB-T-01 golden folder](../../apps/tablets-server/test/golden/) |

## 4. Owner decisions that changed or ended an earlier plan

| Earlier plan | What changed | Why | When | Where |
|---|---|---|---|---|
| Build order 0, 1, 2, 3, 4, **5 Injectables**, 6, 7 (outline 11) | Injectables deferred until the owner reopens it; Tablets goes through Phases 6 and 7 to v1.0 first, then Injectables | owner: "drop injectables plan for now, we will go with tablets"; later the extension to v1.0 | 28 Sep and 10 Oct 2026 | [decision 0002](../decisions/0002-tablets-first-injectables-deferred.md), [0010](../decisions/0010-tablets-to-v1-then-injectables.md). The `apps/injectables-*` skeletons and the controls stay |
| Build to the "core" of the binding regulations only | **Withdrawn** the same day; the full register and outline v0.2 remain the scope. The number 0005 is kept so numbers are never reused | owner: follow what you decided, take defaults for questions | 28 Sep 2026 | [decision 0005](../decisions/0005-core-compliance-scope.md) |
| Phase 6: an example generics pack (10 to 15 products from public sources) | **Dropped**; the Phase 3 company formulation library stays | owner: "the sample formulations plan can be dropped" | 2 Oct 2026 | [decision 0006](../decisions/0006-product-formulation-library.md) amendment |
| A designer usability test with three QA and production authors | Dropped | owner decision | 3 Oct 2026 | [decision 0007](../decisions/0007-no-designer-usability-test.md) |
| Heavy review rounds at every exit (F12 took eight rounds), full SQL mutation campaigns with skeptic agents for every group, many agents at once | Faster delivery: tests with every feature stay; one review pass per feature; at most two fix rounds per finding; validation-grade mutation belongs to deployment | the Phase 2 exit took most of the time in review rounds | 5 Oct 2026 | [decision 0008](../decisions/0008-faster-delivery-testing-cadence-and-depth.md) |
| Decision 0008's Phase 3 exit row | Replaced by an Opus mutation run on Phase 3 code, one review pass and a full test run | owner asked for a stronger Phase 3 exit | 10 Oct 2026 | [decision 0009](../decisions/0009-phase-3-exit-mutation-and-full-testing.md) |
| Mutation campaigns left to deployment (0008) | Reinstated for the Phase 4 core only (focused mutation, three scopes) | Phase 4 holds the release logic | 13 Oct 2026 | [decision 0012](../decisions/0012-phase-4-focused-mutation.md), [mutation results](../build-plan/phase-4/mutation-results.md) |
| A trace that counted every control | A control whose every clause is deferred with a reason shows DEFERRED; clauses needing missing features go to Phase 6 or 7 | the Phase 4 trace was mixing "not built" with "not tested" | 13 Oct 2026 | [decision 0011](../decisions/0011-phase-4-trace-deferrals.md), [trace deferrals](../build-plan/phase-4/trace-deferrals.md) |
| Seventeen analytics, ML and AI ideas (advisory features) | Narrowed to seven kept (control charts, multivariate monitoring, deviation-rate comparisons, audit-trail anomaly detection, review-by-exception scoring, golden batch profile and a production and cleaning scheduling optimiser), built after Phase 6; the others are parked and the owner may reopen any | owner chose from the list | 14 Oct 2026 | [decision 0015](../decisions/0015-process-analytics-and-deviation-prediction.md) narrowed by [0016](../decisions/0016-analytics-features-kept.md) |

## 5. Architecture decisions corrected or extended

No ADR carries the status "Superseded". The project corrects an accepted record in place and says so in the record.

| ADR | What changed | Why |
|---|---|---|
| [ADR 0016](../adr/0016-validated-actor-context-and-definer-hardening.md) validated actor context | decision items 1 to 3 corrected on 28 Sep 2026 (one marker row per backend) | Phase 1 exit finding F1 |
| [ADR 0012](../adr/0012-privilege-separation-security-definer-transitions.md) | item 9 (read authorisation) corrected during the Phase 2 exit fixes | findings F34, F35 |
| [ADR 0006](../adr/0006-server-authoritative-execution-no-device-signing.md) item 4 | the kiosk resend (decision D1) departs from its letter | a lost answer must not duplicate or misattribute |
| [ADR 0017](../adr/0017-web-runtime.md) | new, records the web rules decided in the Phase 2 exit | F41 to F43 |
| [ADR 0018](../adr/0018-platform-scope-hook.md) | new, "supersedes none": extends the hooks of kernel 0500 and 0710 | slice 3a finding 1 |
| [ADR 0019](../adr/0019-generic-block-guards-in-recipe-core.md) | new: guards of generic blocks belong to recipe-core; edition copies to be dropped before Phase 5 | Phase 3 exit HIGH-5 |

## 6. Renumbered migrations

Migration numbers must be unique across the branches that are open at the same time. When two branches took the same
number, one was renumbered before the merge. The "reserved kill range" is the block of numbers set aside for fixes
that come out of the SQL mutation runs. Renumberings: gateway-API answer fix tablets 0600 to 0640 to 0700
(commits 5685be5b, 0b4de0b7); sandbox lot identity-test fix tablets 0610 to 0650 to 0701 (f1bf9301, ec1db1fc);
loop-exit limit-verdict fix recipe-core 0344 to 0370 (27b1efe2); market-authorisation family fix recipe-core 0345 to
0371 (be53d5ec); segregation-query missing-roles fix kernel 1030 to 1100 (a75b58c6); and round 7's kernel 1100 and 1110
to 1101 and 1102 (3e9f7225). If you grep an old note for one of these numbers, read the new number. The rules are in
[REPO-GUIDE.md](../../REPO-GUIDE.md).

## 7. Things that look removed but are not

- **Injectables:** the edition is deferred, not deleted. Shared packages stay edition-neutral and no sterile item
  was removed from the register or research (decision 0002).
- **Controls:** no control was removed and no `expert_decision` changed by decisions 0008 or 0012; only when the heavy
  checks run changed.
- **Tablets copies of generic guards (ADR 0019):** still in place. Merged migrations are not edited; a later migration
  will drop them once the recipe-core copies exist.
