# eBMR: current state

Keep this page short (under 150 lines): the current state, the rules in force and the next steps. Append history to
`docs/progress/history.md` (search it; do not read it whole). Last updated: 19 October 2026 (Phase 7 exit, slice 7f: v1.0.0-rc.1).

## What this is

An electronic Batch Manufacturing Record system for Indian pharma manufacturers who export. India Revised Schedule M
always applies; US FDA and EU GMP apply per market; the stricter rule wins. Tablets edition first, through Phases 6 and 7 to
v1.0; Injectables (Phase 5) comes after that (decisions 0002, 0010). The approved plan is `docs/outline/build-outline.md` (v0.2; section 11 is the phase
plan), as changed by the owner decisions in `docs/decisions/` (0001 to 0010).

## Rules in force (owner)

- Owner, 19 October: the focus is functionality; open questions take the less strict option, the minimum compliance
  that keeps the product usable (within the CLAUDE.md hard rules). Load test and soak move to deployment (D-P7R-7).

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
- Phase 4 (review, release and India specifics; PRs #19 to #28): seven slices, the exit review (no critical or high),
  the trace at phase 4 and the focused mutation work (decision 0012; `docs/build-plan/phase-4/mutation-results.md`).
  The owner's defaults of 13 October stand (D-7b-1, PR-30, IN-18 as D-6a-7, D-2a-9, D-P4-6, D-3a-10, D-5b-2, the
  drying-loop correction and India subdivision). Details: history, "Phase 4" and "PROGRESS.md condensed".
- Phase 6 (integrations and extras; PRs #30 to #42): slices 6a to 6g, 6i and the exit 6j (6h dropped, decision 0018).
  Final run 2 (17 October): 6,695 tests passed, golden GB-T-01 to GB-T-03 41/41, browser suite 50/50, `pnpm trace` at
  phase 6 ok (146/242 controls), `handbook:check` ok; mutation campaign results in
  `docs/build-plan/phase-6/mutation-results.md`. `phase.yaml` is at 6. Owner decisions 0020 (product name Batchwright),
  0021 (no demo at phase exits from Phase 7 on), 0022 (the Phase 6 owner items; R9, R10, R2 and the rest of R16 are
  fixed early in Phase 7; IN-53 stays a draft).
- Developer handbook and code map for Phases 1 to 4 (decisions 0013, 0014) on `docs/handbook-phase-1-4`:
  `docs/handbook/` (primer, glossary, architecture, life of a batch, database, testing, adding a feature, defect log,
  removed and replaced, runbooks, eleven module guides; Draft) and the generated code map and reference pages
  (`pnpm handbook`; `pnpm handbook:check` and a [meta] test keep them current and the links valid). Default D-HB-1:
  existing migrations stay byte-identical; only new ones carry a `-- Handbook:` line. Code/doc disagreements found
  while writing are in history (14 October) for the owner.
- CI runs the tests in six shards; see REPO-GUIDE.md. The chained `pnpm run ci` can hit the lint heap limit locally;
  lint now runs with an 8 GB heap.

## Next

**Phase 6A (analytics; decision 0023, owner, 17 October).** Plan `docs/build-plan/phase-6a/phase-6a-plan.md`; ADR
0020 (the pure package `@ebmr/analytics`, a runner reading as `ebmr_analytics` with no GMP privilege, the non-GMP,
insert-only, audited `analytics` schema); interfaces in `slice-6A-0-interfaces.md`. Draft controls DI-51, DI-52, DI-53
and PR-61 (status U, PENDING, target phase 7; 246 controls, 680 rows). Defaults D-6A-1 to 23 and each slice's
D-6A-n-* in the plan. On main at ddf3dfe (PRs #43 to #49):
- 6A-0 interfaces (kernel 1240 to 1244, recipe-core 1110, tablets 1330); 6A-1 foundation (runner, input views
  recipe-core 1115, method change control kernel 1245, screens; golden batches unchanged with the runner on);
- 6A-2 SPC, capability, drift and deviation rates (recipe-core 1130); 6A-3 multivariate monitoring (kernel 1270, 1271:
  a set carries its candidate's model, a repeated flag listed once); 6A-4 audit-trail flags (kernel 1260, 1261,
  recipe-core 1150, 1151); 6A-5 review priority (recipe-core 1160; one high fixed in its review, P6A5-1); 6A-6 golden
  batch profile (recipe-core 1170; one high fixed, D-6A-6-12). Per-slice details: the plan's "as built" sections and
  history ("PROGRESS.md condensed").

**Phase 6A exit (slice 6A-7, 17 October; branch `phase-6a/slice-7`, trace half and review half merged).** Phase 6A is
built and merged (PRs #43 to #49): the six analytics features, all advisory.
- **Exit review:** 0 critical. 3 high, fixed: P6A7-1 (flag grouping made one design, kernel 1280), P6A7-2 (the
  audit-trail term of the review score restricted in the database, kernel 1281), P6A7-3 (bounded runs). P6A5-2 fixed
  too (kernel 1282: a QA false alarm no longer counts in the review score). Residuals P6A7-4 to 9 are in
  `docs/build-plan/phase-6a/review-backlog.md`; defaults D-6A-7-R1 to R5 and D-6A-7-b-1 to 7 are in the plan.
- **Trace:** the 4 drafts DI-51, DI-52, DI-53 and PR-61 have all 23 clauses proven at a phase-7 dry run, still PENDING
  the owner (target phase 7 kept, `phase.yaml` at 6). `pnpm trace` at 6 is ok (151/246).
- **Local runs:** 6,882 tests, golden 44/44 with the runner on, E2E 4 new flows (`tools/e2e/specs/phase6a/`). The
  handbook module `modules/analytics.md` is complete.
- **Open:** the 6A exit closes on GitHub CI; its heavy final run is combined with the Phase 7 exit run on the pod
  (D-6A-15).

**Phase 7 done (19 October 2026): Batchwright Tablets v1.0.0-rc.1.** PRs #52 to #60 and the 7f exit PR; tag
`batchwright-tablets-v1.0.0-rc.1` on the 7f merge commit. Details: `docs/build-plan/phase-7/phase-7-plan.md`, the
checklist `docs/build-plan/phase-7/v1.0-rc-checklist.md`, release notes `docs/build-plan/phase-7/release-notes.md`,
history (19 October).
- Final run 2 (pod, 16 vCPU): 7,471 tests passed, 0 failed; golden 51/51; browser suite 75/75; `pnpm trace:e2e` at
  phase 7 ok (156/246). `phase.yaml` is at 7; no clause is deferred to 7.
- Exit review: no critical or high (P7X-1 medium, P7X-2 low: known issues). No open critical or high in any backlog.
- Drills on the pod: upgrade from the 6A exit and migration dry run PASS, restore PASS; security scans clean; IQ 10/11
  (IQ-09 fails on a demo database by design); load smoke every SLO met. Reference load test and soak: deployment
  (D-P7R-7).
- Mutation campaign (`docs/build-plan/phase-7/mutation-results.md`): no product defect; no Priority 1 survivor open
  except `iam.first_run_setup#11` (one-microsecond expiry boundary, for the owner); a harness defect fixed (M7-T3b-1).
- Build statuses (register:status): 111 VERIFIED, 13 IMPLEMENTED; the gap to D-P7-1's 147 is listings (release notes).

Next: the v1.0 demo on a server the owner provides (server, SSH, domain; decisions 0021, 0025), then Tablets v1.0.
Injectables (Phase 5) after that.

## How to work here

- Commands, layout and CI rules: `REPO-GUIDE.md`. Skills in `.claude/skills/` (fix-finding, local-ci, mutation-check,
  postgres-oracle, graphify).
- Machine: a RunPod container whose disk is erased when the pod stops. Run `bash tools/dev-env/runpod-setup.sh` after
  each pod start; commit and push to the working branch (never main) after every step and at least every 30 minutes.
- Local PostgreSQL 16 clusters: main 5432, ci 5433, ci2 5434, golden 5435 (golden clock library; the CI golden job uses 5433 on
  its own runner). On Ubuntu 22.04 the kernel site-zone-policy "[DI-27] over every zone name" test needs about 65 s
  (posix/ zone copies) and times out locally; it passes on CI. Test databases are created per run and dropped after.
- Run `pnpm run ci` (or the changed packages' tests) before pushing.
