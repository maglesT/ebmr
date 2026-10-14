# eBMR: current state

Keep this page short (under 150 lines): the current state, the rules in force and the next steps. Append history to
`docs/progress/history.md` (search it; do not read it whole). Last updated: 14 October 2026 (handbook).

## What this is

An electronic Batch Manufacturing Record system for Indian pharma manufacturers who export. India Revised Schedule M
always applies; US FDA and EU GMP apply per market; the stricter rule wins. Tablets edition first, through Phases 6 and 7 to
v1.0; Injectables (Phase 5) comes after that (decisions 0002, 0010). The approved plan is `docs/outline/build-outline.md` (v0.2; section 11 is the phase
plan), as changed by the owner decisions in `docs/decisions/` (0001 to 0010).

## Rules in force (owner)

- Decision 0008: the goal is software that works properly with no major defects. Tests with every feature and green
  CI always; one quick review per feature or slice; a quick review at the Phase 3 exit; at the Phase 4 exit one review
  pass, the full suite, the golden batches and the browser suite. At most 2 fix rounds per finding. Validation-grade
  testing (mutation targets, multi-round adversarial review, IQ/OQ/PQ) belongs to deployment. Database enforcement for
  the regulation-required core only. The F12 sandbox identifier rule is frozen at kernel 1140 / recipe-core 0350.
- Decision 0009 (10 October, approved; amends 0008 for the Phase 3 exit): an Opus mutation run on all Phase 3 code and
  on Phase 1 and 2 code changed since their exit runs; one Opus review pass (design, serious defects); critical and high
  fixed, each with its own test; then one final run of the suite, E2E, trace and GB-T-01. The 0008 relief stands.
- Decision 0010 (10 October): Tablets to v1.0 (Phases 3, 4, 6, 7) first, Injectables after. Shared-code changes keep
  the injectables extension points open; the trace gate must leave injectables-only controls out before phase.yaml passes 4.
- Token economy (owner, 9 October): see CLAUDE.md. Top model for building, design and security fixes; Sonnet for
  quick reviews; Haiku for mechanical jobs. Few agents (2 to 3 at a time), short reports, short command output.
- Defaults: take the default for any open question (decision 0004) and record it.
- Merge a PR yourself when CI is green. Push each checked commit. No deletion without the owner's OK.
- Never edit an existing migration; add new ones. Never weaken a control or change `expert_decision`.
- Paraphrase regulations. No patent formulations. No model names in commits. Never commit the scratchpad `src/`
  folder (copyrighted pharmacopoeia texts). Do not use the repositories maglesT/ds or
  maglesT/deep-learning-for-earth-observation for this project.

## Where things stand

- Phases 0, 1 (compliance kernel), 2 (recipe engine and designer) and 3 (Tablets edition, PRs #7 to #18) are done;
  details in `docs/progress/history.md` and the phase plans. Phase 3 exit per decision 0009 (Opus review and mutation
  runs; residuals in `docs/build-plan/phase-3/review-backlog.md`).
- Decision 0010: Tablets reaches v1.0 first (Phases 3, 4, 6, 7), then Injectables.
- Phase 4 (review, release and India specifics), plan `docs/build-plan/phase-4/phase-4-plan.md`, seven slices:
  - Merged: slice 1 record review and evidence epochs (PR #20); slice 2 quality records, deviations, specifications,
    lots, packaging planning (PR #21); slice 3 G-REL, manufacturer release, cockpit, notifications (PR #22); GB-T-01
    date fix (PR #19); slice 4 market dispositions, two-row release, EU QP package, shipping interlock, market screens
    (PR #23).
  - Slice 5 (after release) on `phase-4/slice-5`: 5a suspension of released lots and their downstream lots on a cause
    linked after release, with the ERP stock block and the AP's recall-assessment task in the same transaction;
    RECONFIRM, RECALL, REJECT_AFTER_RELEASE, DISPOSAL (recipe-core 0840, 0841; site-services 0880, 0881; L-19, IN-29,
    PR-46). 5b record locking and appending amendment that suspends the record's released lots; bulk across orders and
    the bright-stock maximum hold (recipe-core 0870 to 0875, tablets 1190, 1199; INV-21, R-04, PR-38). 5c screens.
    Quick review: one high (amendment cause refused by the suspension) and one core medium (a cause linked again after
    a re-confirmation did not suspend again) fixed with tests. Defaults D-5-1 to D-5-8, D-5a-*, D-5b-* in the plan.
  - Slice 6 on `phase-4/slice-6`: 6a India fields (licences Form 25/28 and loan licences, export permissions, both
    checked at issue and in G-REL item 6; expiry computed in the database and used by the finished lot and the G-21
    print data; shelf-life changes need a stability basis; hazard classes and line dedications, changes signed by a
    second QA person; allocation register export; India label particulars and the H2 payload stub). 6b records
    (contingency paper forms reconciled before EXECUTION_COMPLETE; PDF/A-3 true copy, reproducible bytes; certified
    evidence export checked in the database; retention computed and shown only; read-only inspection workspace). 6c
    PQR extract (reproducible, reconciled to the registers, AP sign-off). Migrations: site-services 0885, 0886;
    recipe-core 0890 to 0895, 0910 to 0913; kernel 1170 to 1174; tablets 1200, 1201, 1209. Quick review: no high;
    core mediums (export certifiable without the database's own check, an unsigned hazard downgrade) fixed with tests.
  - Slice 7 (Phase 4 exit) on `phase-4/slice-7`: 7a clause mappings for every phase-4 control, the `editions`
    filter (decision 0010) and docs/build-plan/phase-4/trace-deferrals.md; 7b GB-T-01 continued to release (two blister
    orders from one bulk) and GB-T-02 (direct compression, bottles, US added after vendor history INELIGIBLE), exact
    outputs, the release path in the set-up through real signed acts (demo H-PACK shortcut gone), the browser flows for
    release, US disposition, EU QP package and certification intake, suspension then recall; 7c SQL kill tests for the
    "not twins" (recipe-core 0930 drops reprocessing_start_problem); 7d and 7e tests and mappings for the remaining
    clauses. Decision 0011 (owner): a control whose every clause is deferred with a reason shows DEFERRED; clauses that
    need missing features are deferred to Phase 6 or 7 (listed in trace-deferrals.md). Exit review (one pass): no
    critical or high. `phase.yaml` is at 4; the trace passes at phase 4 with the golden and browser results (143/241
    controls with passing tests). Final run: 5,916 + 31 golden + 42 browser tests passed.
  - Phase 4 focused mutation work (decision 0012) on `phase-4/mutation-final` (scopes A, B, C merged): results in
    `docs/build-plan/phase-4/mutation-results.md`. Two real defects fixed with tests: G6.VALIDATION_BASIS walks back to
    the last process-impacting version (recipe-core 0932, PR-06) and the export permission reason text (site services
    0903). Scope C groups all 100 % after the re-run; scope A 232 survivors and scope B 118 survivors aimed at by new
    tests but not re-confirmed. Final run: typecheck and lint clean; 6,070 tests passed and 2 [meta] failed (both from merging the
    scopes: a function in two SQL mutation groups, and 41 tagged tests not yet in the control lists; fixed, re-run passes);
    31 golden and 42 browser tests passed; trace ok at phase 4 (143/241).
    Deferred to deployment validation: kill confirmation of the A and B survivors, us-disposition, qp-certification and
    market-changes groups, Stryker survivor triage (server release, records, India, archive and PQR features), a whole
    SQL re-run under the decision 0009 organisation.
  - Owner (13 October): the defaults stand for all open questions: D-7b-1 (GB-T-01's two orders India-only), PR-30
    (a breach raises the exception that needs a deviation and blocks release; no deviation record by itself), IN-18
    read as the register export with each number's use (D-6a-7), D-2a-9, D-P4-6, D-3a-10, D-5b-2, the drying-loop
    correction and India subdivision questions. The web demo kit is deferred until the owner asks.
- Developer handbook and code map for Phases 1 to 4 (decisions 0013, 0014) on `docs/handbook-phase-1-4`:
  `docs/handbook/` (primer, glossary, architecture, life of a batch, database, testing, adding a feature, defect log,
  removed and replaced, runbooks, eleven module guides; Draft) and the generated code map and reference pages
  (`pnpm handbook`; `pnpm handbook:check` and a [meta] test keep them current and the links valid). Default D-HB-1:
  existing migrations stay byte-identical; only new ones carry a `-- Handbook:` line. Code/doc disagreements found
  while writing are in history (14 October) for the owner.
- CI runs the tests in four shards; see REPO-GUIDE.md. The chained `pnpm run ci` can hit the lint heap limit locally;
  lint now runs with an 8 GB heap.

## Next

Phase 4 is closed (PRs #26, #27, #28). Phase 6 (decision 0010): integrations and extras for Tablets and the 41 clauses
decision 0011 deferred to it; plan `docs/build-plan/phase-6/phase-6-plan.md` (branch `phase-6/plan`): slices 6a
adapters and stale mirrors, 6b equipment data and alarms, 6c packaging and serialisation, 6d genealogy and mock recall,
6e controlled-substance mode (adds draft IN-53), 6f governance and India DSC (test CA), 6g dashboards, change impact,
training mode, 6h Hindi and Gujarati, 6i inter-site transfer, 6j exit; owner questions listed there (defaults stand).
Then Phase 7 (validation pack and hardening) and Tablets v1.0; Injectables (Phase 5)
after that. Optional, when the owner asks: a web demo kit (trusted-proxy setting, HTTPS demo mode, install and reset
scripts) on a cloud server the owner provides.

## How to work here

- Commands, layout and CI rules: `REPO-GUIDE.md`. Skills in `.claude/skills/` (fix-finding, local-ci, mutation-check,
  postgres-oracle, graphify).
- Machine: a RunPod container whose disk is erased when the pod stops. Run `bash tools/dev-env/runpod-setup.sh` after
  each pod start; commit and push to the working branch (never main) after every step and at least every 30 minutes.
- Local PostgreSQL 16 clusters: main 5432, ci 5433, ci2 5434, golden 5435 (libfaketime; the CI golden job uses 5433 on
  its own runner). On Ubuntu 22.04 the kernel site-zone-policy "[DI-27] over every zone name" test needs about 65 s
  (posix/ zone copies) and times out locally; it passes on CI. Test databases are created per run and dropped after.
- Run `pnpm run ci` (or the changed packages' tests) before pushing.
