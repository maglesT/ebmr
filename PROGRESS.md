# eBMR: current state

Keep this page short (under 150 lines): the current state, the rules in force and the next steps. Append history to
`docs/progress/history.md` (search it; do not read it whole). Last updated: 11 October 2026.

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
  - Moved to GB-T-02 (slice 7): the green release path, the released demo lot and the suspension browser flow, the demo
    H-PACK shortcut, the e2e QP package and market release.
  - Open for the owner (defaults stand): D-2a-9 (CONFIRMED impact keeps release blocked after closure), D-P4-6 (India
    PPQ release waits for the validation outcome), D-3a-10 (CONFIRMED impact never justifiable), D-5b-2 (a product with
    no bright-stock maximum is not checked), the drying-loop correction and India subdivision questions (Phase 3 backlog).
- CI runs the tests in four shards; see REPO-GUIDE.md. The chained `pnpm run ci` can hit the lint heap limit locally;
  run lint with `node --max-old-space-size=4096` and the rest of the chain separately.

## Next

Phase 4 slices 6 (India specifics, records, PDF/A-3, retention, PQR extract) and 7 (trace to phase 4, golden batches
GB-T-01 continued and GB-T-02, residual kill tests), then the Phase 4 exit (decision 0008: one review pass, full suite,
golden batches, browser suite). Each slice: a plan, builders on branches, one quick review, PR merged on green CI.

## How to work here

- Commands, layout and CI rules: `REPO-GUIDE.md`. Skills in `.claude/skills/` (fix-finding, local-ci, mutation-check,
  postgres-oracle, graphify).
- Local PostgreSQL 16 clusters: main 5432, ci 5433, ci2 5434 (`sudo pg_ctlcluster 16 <name> start` after a container
  restart; ci2 recovers slowly). Test databases are created per run and dropped after.
- Run `pnpm run ci` (or the changed packages' tests) before pushing.
