# eBMR: current state

Keep this page short (under 150 lines): the current state, the rules in force and the next steps. Append history to
`docs/progress/history.md` (search it; do not read it whole). Last updated: 12 November 2026 (session 12b handover).

## What this is

An electronic Batch Manufacturing Record system for Indian pharma manufacturers who export. India Revised Schedule M
always applies; US FDA and EU GMP apply per market; the stricter rule wins. Tablets edition first, through Phases 6 and 7 to
v1.0; Injectables (Phase 5) comes after that (decisions 0002, 0010). The approved plan is `docs/outline/build-outline.md` (v0.2; section 11 is the phase
plan), as changed by the owner decisions in `docs/decisions/` (0001 to 0010).

## Rules in force (owner)

- **Decision 0026 (1 November 2026): dynamic library, freeze the extras.** Library blocks are data (forms built
  from fixed field types, QA-approved and versioned); formulations are assembled on screen and batches generated from
  them. Frozen (kept in the repo and in CI, no new work): injectables, site gateway, simulators, analytics/MSPC,
  integrations, QP package, contract giver, EU importer register, PQR, dashboards, CAPA, training, incidents,
  alarms, kiosk extras, the sandbox evidence package and the Phase 7 product backlog (R7, R8, R11, R12). Plan:
  `docs/build-plan/dynamic-library/plan.html`.
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

**Process-simulation mark (injectables I-2 feature B, recipe-core 1896, lead design 11 November 2026).** A master header may
carry `nonProduct: PROCESS_SIMULATION` (a media fill), on an injectables processing master only (EBMR-RCP-435). The mark is
approved content and in the hash. Such a batch is issued
without the licence or any market's export permission, and the hazard dedication still applies. Its licence basis
records `process_simulation` with no licence. The database refuses its label (IND-050), a packaging order of it
(EXE-198), a finished lot (IND-045) and a shipment (IND-046). A US-market media fill meets the 11.100(c) gate with the site's
licence holder (1260, lead ruling); the allocation register shows processSimulation.

**Injectables EM tiers (12 November 2026, session 10c).** The library E2E types each limit tier into its own boxes; the
aseptic vial's EM breach is an action-tier breach. Routine EM is not a batch record (lead): owner question, a room-level
EM logbook as a future feature, if wanted.

**Injectables I-2d (12 November 2026, session 10c).** The media fill's GMP run, E2E: the mark set on screen, the batch issued
with no licence (the register says so), run on the kiosks with no release for packing, ended by QA's record review; a
finished lot of it is refused. The master-version market authorisation stays (lead).

**Session 12 (10 and 11 November 2026; owner retest and lean review).**
- #210 N-1, N-2: the ERP production order names each material once (the master's lines summed, then scaled); a database
  refusal after an earlier commit in the same request (withScopedCommand) is answered 422 with its reason, not 500.
- #211 item 11 (recipe-core 1889): a market authorisation is activated by a QA person other than its proposer
  (EBMR-RCP-434, trigger a3_not_proposer, PR-04); second QA persona approver2.
- #212 N-3: a stage gets its own yield step in the designer; a library batch-size input may be read as the scaled sum of
  named formula lines (`inputLines`); LIB-USE-INPUT-LINES refuses a master whose batch size does not convert and names
  no lines (PR-31). No seeded or demo master uses a block with a batch-size input (CTRL-YIELD, PROC-REWORK, API-YIELD),
  so none is refused (checked 11 November).
- #213 kiosk: raising and linking a batch deviation carry the person's badge tap (INV-40); a raised deviation whose link
  failed is linked on the next press, never raised twice (server and UI tests in the follow-up PR).
- #214 E2E set-up: a stack's six ports are held until all are picked and drawn from 20000-31999 (EADDRINUSE).
- #215 lean part 1 (recipe-core 1893): 1 to 200 formula lines; no overage cap (reason still required); Schedule M quote
  paraphrased. GMP-RISK stays an error (IN-02).
- #216 decision record 0029: release stays strict while a linked deviation is open (EBMR-DV-001 unchanged).
  **D-0029-3:** tablets 1907's header grounds that refusal in 211.192 alone, which stretches the clause; its basis is
  decision 0029 (supported by 211.192, 211.100(b) and Schedule M 18.2.2, 18.5.12 as IN-05 cites them). 1907 is not
  edited; the next tablets migration (1909) says so in its header.
- #219 owner acceptance E2E (group `library-bilayer`): a bilayer tablet with four stages built on screen to its released
  lot; the weighing line choice names the line; designer MOVE_STEP_TO_STAGE fixed.
- #221 SITE-995 (session 12b; site-services 1736, substance 5009, tablets 1909): the person posting an API-edition
  intermediate lot chooses its dates, EXPIRY (shelf life, optional retest), RETEST or NONE; only an in-house
  intermediate may have no expiry (check plus deferred trigger, EBMR-SITE-999); no transfer package for an undated lot
  (EBMR-XFR-043); FEFO takes undated lots after dated ones. Tablets 1909's header carries the D-0029-3 note.
- Session 12b, after #221 (11-12 November):
  - #224: per-point limit tiers (validated, action, alert) behind "More limits" in the library values form. Editing a
    point keeps its other tiers.
  - #225: CI. On GitHub-hosted runners `playwright install --with-deps` gets 900 s; a hang takes the no-apt fallback.
  - #226: G-21 printed items on a draft. Items are added (empty), removed and edited, with their artwork per market.
    Site-services 1737 rewords EBMR-SITE-180 and -185 for a lot without dates.
  - #219 (session 12's acceptance E2E): two follow-up commits. The register now lists the 42 library-bilayer tests the
    trace found. Main is merged in, and the library-bilayer group sits beside the injectables groups.
  - Local container: apt mirrors may answer 503. `runpod-setup.sh` works with `apt-get` stubbed out; PostgreSQL stops
    when the container restarts (`pg_ctlcluster 16 main start`, plus ci, ci2, ci3 and golden).
- Hosted demo re-set-up for area_status v2: no code (owner chose the easy way; the state engine, kernel 1110, never
  changes an aggregate's machine version, so areas move to v2 by running the demo set-up again).

**Earlier state** (moved verbatim to `docs/progress/history.md` on 11 November 2026; search "PROGRESS.md condensed, 11
November"): the sandbox date-time fix (kernel 1406); the post-use inspection without a second person (tablets 1908);
MEDHANTA slice 2, deviations through the Deviations product (tablets 1907, decision 0029); declutter D1 to D4b (decision
record in `docs/build-plan/declutter/plan.md`); the API edition A0 to A2; the demo gaps D-0 to D-4, R-flow and R-rest;
the capsules edition; the injectables plan and I-1 to I-4; the dynamic library S0 to S16 (decision 0026); Phases 0 to 4,
6, 6A and 7 (Tablets v1.0.0-rc.1, 19 October) and the hosted-demo slices 7h to 7u.

## Next

- Residual of SITE-995 (lead, 11 November): an intermediate lot cannot be retested to a new date (its material code is
  the product code, which has no ERP material retest interval).
- Later CI slice: gate the E2E set-up's seeds per group (`gmpReviewBatch`, `gmpPackaging` in
  `tools/e2e/global-setup.ts`); needs a full E2E proof run.
- Tablets to v1.0, then Injectables (decision 0010).

## How to work here

- Commands, layout and CI rules: `REPO-GUIDE.md`. Skills in `.claude/skills/` (fix-finding, local-ci, mutation-check,
  postgres-oracle, graphify).
- Machine: a RunPod container whose disk is erased when the pod stops. Run `bash tools/dev-env/runpod-setup.sh` after
  each pod start; commit and push to the working branch (never main) after every step and at least every 30 minutes.
- Local PostgreSQL 16 clusters: main 5432, ci 5433, ci2 5434, golden 5435 (golden clock library; the CI golden job uses 5433 on
  its own runner). On Ubuntu 22.04 the kernel site-zone-policy "[DI-27] over every zone name" test needs about 65 s
  (posix/ zone copies) and times out locally; it passes on CI. Test databases are created per run and dropped after.
- Run `pnpm run ci` (or the changed packages' tests) before pushing.
