# eBMR: current state

Keep this page short (under 150 lines): the current state, the rules in force and the next steps. Append history to
`docs/progress/history.md` (search it; do not read it whole). Last updated: 16 October 2026 (Phase 6 slices 6f, 6b, 6c, 6d, 6e, 6g and 6i).

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
  quick reviews; Haiku for mechanical jobs. Up to 5 agents at a time and overlapping independent slices (decision 0017), short reports, short command output.
- Defaults: take the default for any open question (decision 0004) and record it.
- Merge a PR yourself when CI is green, then start the next slice at once: keep going slice after slice without waiting
  for the owner (owner, 15 October); take every decision yourself (owner, 15 October: "dont ask any decisions take it"),
  record each with its reason; only the hard rules stay the owner's (never weaken a control or change `expert_decision`). Push each checked commit. No deletion without the owner's OK.
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
training mode, (6h languages dropped: English only, decision 0018), 6i inter-site transfer, 6j exit; owner questions listed there (defaults stand).
Slice 6a (merged): adapter framework (`@ebmr/integration-sdk/adapter`, kernel 1180 to 1182: inbound messages whole or
not at all, de-duplicated, gaps alarmed; integration identities never sign; mirrors fail closed, EBMR-INT-010), one
worker framework started with the server in MIRROR mode; ERP/WMS, QMS with CAPA, LIMS, LMS, CMMS; simulators and soak
tests. Defaults D-P6a-*; residuals and defect P6a-I1 in the plan and history.
Slice 6f (merged to main, PR #33, 16 October): configuration change control with versions and a diff
as of any date (kernel 1195, 1196; roles, permission sets, retention rules included), RBE rules under change records and
RBE on a step only with a validation reference, support grants (two customer signatures, time-boxed), the contract
giver's read-only reviewer, excursion notifications, designer PPE and containment, MBR edition review, typed CPP values in
the PQR, the India DSC with a test CA (kernel 1203, 1205) and, from the review, enrolment of the signer's own certificate
(kernel 1206; a high fixed). The eleven 6f clauses now name their tests. Defaults D-P6f-A-*, D-P6f-B-*; residuals in the plan.
Slice 6b (merged to main, PR #34, 16 October): OPC UA driver, simulator, gateway feed and the server's
adapter worker; endpoint identity (DI-20), native series and original records (DI-32), the plant alarm log in batch
context and in review (DI-49), the EMS feed; plant rules PR-15, PR-22, PR-25, PR-27, PR-29, PR-35; screens including the
trend viewer and the area authorisations. Quick review: Q-6b-1 (alarm acknowledgment scope, recipe-core 0976) fixed.
Defaults and residuals in the plan's slice 6b section.
Slice 6e (branch `phase-6/slice-6e`, 16 October, ready for PR): controlled-substance mode, the draft control IN-53 (status
U, NDPS not verified; register 242 controls, 679 rows): product flag under change control with a second QA signature,
dual custody of dispensing, transfers, returns and destruction (database guards), the controlled account closed at every
stage sign-off and at batch completion, the reproducible register export; screens with the draft banner. Quick review: one
core medium fixed (recipe-core 1035). Defaults D-P6e-1 to 10 and residuals in the plan; tablets 1290 added after 6f's and 6d's ranges.
Slice 6d (branch `phase-6/slice-6d`, 16 October, ready for PR): `recipe.genealogy` both ways at any depth as of an
instant over the insert-only event rows (no genealogy table), chemical recovery of returned goods (site services 0960,
route `samples.recoverReturn`), distribution records from the ERP adapter (0961), mock recall stored with its hash and
signed off by the AP, deviation impact query, recurrence warning on the release screen (PR-49), explorer, complaint
lookup and mock-recall screens (recipe-core 1010 to 1013, tablets 1280). IN-07, IN-29, PR-57 x2, PR-49, PR-50 clauses
name their tests. Defaults D-P6d-0-*, D-P6d-4 to 10; review fixes and residuals in the plan.
Slice 6i (branch `phase-6/slice-6i`, 16 October, ready for PR): installation keys and seals verified in the database
(kernel 1220), sealed lot-transfer packages built by the database, import refused with an alarm when tampered,
misaddressed, untrusted or repeated, a QUARANTINE lot usable only after local QA's signed acceptance and before the
carried hold limit, rule resolutions re-resolved with the stricter winning (site services 0980, 0981), the TRANSFER node
and the federated genealogy with as-of, the mock recall across sites marked incomplete when a site does not answer
(recipe-core 1090 to 1092, tablets 1300, 1301), `transfers` and `federation` routes and screens. Two installations in one
test run (two databases; two servers over HTTP). Defaults D-P6i-0-1 to 12; review P6i-R1 to R3 fixed; residuals in the plan.
Slice 6g (branch `phase-6/slice-6g`, 16 October, ready for its PR): read-only reporting path (role `ebmr_report`,
Slice 6c (branch `phase-6/slice-6c`, 16 October, ready for PR): label templates approved by a second person (an India
template needs every India particular), the master's 211.122(g) cut-label option gating its approval, the label store
(recipe-core 0990, site services 0950); start, middle and end coding specimens equal to the record's coding, label
specimens, the post-use inspection gating EXECUTION_COMPLETE, vision line stops, the reconciliation waiver (tablets
1230); the L3 adapter, serial query, decommissioning tasks and the L3 mirror failing closed at release (tablets 1231);
stateful L3/L4 simulator, screens. The ten 6c clauses name their tests. Defaults D-P6c-1 to 22; residuals R-6c-1 to 5.
Slice 6g (merged to main, PR #39, 16 October): read-only reporting path (role `ebmr_report`,
SELECT on the versioned `report` views only, data age on every row; kernel 1210, 1211; recipe-core 1070, 1071), eight
dashboards (never for GMP decisions; PR-05 overdue reviews, DI-49 alarm trend), the change-impact explorer with export,
and training mode on the sandbox (watermark, TEST- personas, scripted exercises, attempts kept in the sandbox only;
DI-05). PR-05's dashboard clause names its tests. Quick review: no critical or high; residuals R-6g-1 to 4 in the plan.
Defaults D-P6g-0-1 to 10.
Slice 6j-a (branch `phase-6/slice-6j-a`, 16 October): the exit trace. DI-31, DI-32, DI-49 map their clauses; no
clause stays deferred to Phase 6 (none moved to 7); IN-53 stays PENDING; a deferral to phase 5 waits while Injectables
is outside the gate (question 7, `[meta]` test), so PR-26 and PR-28 are unchanged; `phase.yaml` stays 4 for the
integrator (after 6j-b, 6j-c). Handbook mermaid labels fixed. Details in `docs/build-plan/phase-4/trace-deferrals.md`.
Slice 6j-c (branch `phase-6/slice-6j-c`, 16 October): the one review pass over Phase 6. One high fixed: 6jc-R1, the
ERP_WMS adapter's MATERIAL.HANDLE reached a person's material acts (reservation cancel, destruction, recovery, returns,
finished lot, transfer packages); site services 0990 refuses those rows for a non-HUMAN account (DI-14, DI-20).
Residuals 6jc-R2 to R7 (one medium: controlled-substance reads open to any role) in the plan's "6j-c review".
Second part (rest of the Phase 6 TypeScript, the gateway, the SDK, the web screens and the regulated core's SQL logic,
probed on a migrated database): one high, 6jc-R8 (raised by the lead): a small-order installation or peer key made
every seal verify. Fixed in kernel 1230 (EBMR-XFR-042; DI-31). Residuals 6jc-R9 to R15, two of them medium for the owner:
the adapter feeds and the gateway's OPC UA feed are not authenticated (R9), and one person sets the penicillin facility
and beta-lactam rules (R10). Backlog: docs/build-plan/phase-6/review-backlog.md.
Mutation campaign preparation (branch `phase-6/slice-6j-mutation`, 16 October; decision 0019): 14 SQL groups for
every Phase 6 function (3,981 mutants; 202 more in re-created functions of earlier groups), `--resume`, `--functions`,
`--audit-equivalents` and `EBMR_MUTATION_VITEST_WORKERS` in the harness, a stale `equivalent.json` entry fixed (56
older ones run as ordinary mutants until part 2 re-checks them), 20 Stryker features in `stryker.phase6.config.mjs`.
Run plan, estimates (part 1 about 4 to 5 hours; the whole SQL re-run about 128 worker hours, beyond part 2's box) and
smoke runs in `docs/build-plan/phase-6/mutation-results.md`; D-P6j-M-1 to 7 in the plan.
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
