# eBMR: current state

Keep this page short (under 150 lines): the current state, the rules in force and the next steps. Append history to
`docs/progress/history.md` (search it; do not read it whole). Last updated: 9 November 2026 (MEDHANTA slice 2, deviations link).

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

**Post-use inspection without a second person (lead ruling, 10 November 2026; tablets 1908).** No binding clause asks
for a second person on the packaging line's after-use inspection (211.188(b)(6) asks only that it is recorded), so a
passing latest inspection completes the order unverified in every edition; the optional verification is never the
inspector's. D-P6c-6's second-person part is superseded.

**MEDHANTA slice 2: deviations through the Deviations product (owner ruling, 9 November 2026; replaces D4-R5).** With a
Deviations link (`DEVIATIONS_DATABASE_URL`, optional; second small pool `platform/deviations.ts`) a batch's deviation is
stored only as its Deviations number (`dv.batch_number_link`, tablets 1907, `quality.linkDeviationNumber`); the release
checklist, G-REL (item `G2.DEVIATIONS_LINKED`) and the review read each status from `report.deviation_v1`; the database
refuses a lot or container release until every linked number is closed or rejected (guard fact `dv.status_fact`, as master
data); an unreadable view refuses with `DEVIATIONS_OFF`. Lead ruling (subject-scoped): with the link, only a batch
deviation (kind DEVIATION linked to a batch or container) is refused on the local routes and signed acts
(`BATCH_DEVIATION_ROUTES_WHEN_LINKED`, 410 "Batch deviations are managed in Deviations; link its number"); a lot's OOS
(IN-20), lab-error invalidation and reprocessing stay local and fully working. Standalone unchanged. The platform manifest
reads `deviation_v1` (databsee #64).

**Declutter (owner, 5 November 2026; plan `docs/build-plan/declutter/plan.md`, PR #113).** Only the working batch-record
path stays on screen. Owner decisions: records and amendments KEEP, the formulary is Batchwright's, the penicillin and
beta-lactam rules (all of plantRules, owner with risk acceptance in plan.md: recorded classifications and the check
at issue stay; no new classification until reconnected) and QP batch packages LATER (disconnected). **D1 (branch `declutter/d1`):** one list,
`DISCONNECTED` in `packages/api-contract/src/disconnected.ts` (27 namespaces, each with the product it belongs to);
`bind.ts` answers `410 DISCONNECTED` at onRequest on the platform build, and on a standalone server with
`EBMR_DISCONNECT=1` (D-D1-1: the standalone tests of the disconnected functions stay as they are; the hosted demo sets
the switch). Plugins, tables and records unchanged. Proof: a generated 410 test per namespace and the platform-build case
([DI-17]); the web check that kept screens call no disconnected route, naming the files D2 unhooks and every part a kept
screen embeds from another feature; the release page's QP package section and decision notifications render nothing on
DISCONNECTED (review finding, fixed); E2E `library-dc` (catalogue → formulation → master → approval → GMP batch → floor →
packaging and labels → review → release) runs with the switch on. Kept connected because kept screens read them (D-D1-2): `alarms` (the batch alarm log on the step and review
screens, DI-49), `integrations` and `transfers` (the operator's set-up page), `erpShipping` (the lot's shipments),
`archive`, `india` and `marketConfig` (off the home only); deviations are D4. **D2 (branch `declutter/d2`, on D1):** `meta.disconnected` tells the SPA when the server refuses the
list; then the home (even "Show all screens") and the links on kept pages skip the screens in
`apps/tablets-web/src/app/disconnected.tsx`, and a deep link shows "Not part of Batchwright". On the platform build the
people and grant screens are off too (core keeps them). D-D2-1: the India licences screen stays (a GMP batch needs the
product endorsed on the licence; the library-dc flow records and approves it); shelf-life bases go. **D3 (branch `declutter/d3`, on D2):** decision 0020 amended: sign-in, title and manifest say "Batchwright", the header
names the edition. The home opens with four work cards (My batches, To sign, To review, To release), each a count from an
existing read (work queue, review queue, release queue: READY lots only) and a list at `/work/*` whose rows open the
record; a card shows only where the role may make its read (`readOffered`). The Functions links keep their titles
without descriptions. The header's edition of the record on screen follows when capsules C2's mechanism is shared.
**D4 (branch `declutter/d4`):** `DISCONNECTED_ROUTES` (route id → owner) refuses the eight full deviation-record routes
inside `quality` (Deviations); raise, link, the batch's list and the release checklist stay (kept screens and the
database's reference checks need them). `/quality/deviations` is off on the web; kept pages show the reference as text.
Residuals D4-R1 to R5 (MMS, Logbook, Qual, QMS, Deviations) in plan.md section 7.
**D4b (branch `declutter/d4b`):** a lot opens only its own OOS record (`/quality/lots/$lotId/oos/$deviationId`, from the
result row and the lot's release checklist): investigation, finding, impact, closure basis, QA's signed impact assessment and
conclusion, which a laboratory-error invalidation needs. Detail, impact and closure basis reconnected; reclassify, cancel,
the lite record and the list stay off.
Later CI slice: gate the E2E set-up's seeds per group (`gmpReviewBatch`, `gmpPackaging`, in `tools/e2e/global-setup.ts`;
about 13.5 min in every group). Not small: `--gmp-packaging` also makes the sandbox plant and carries the SR-profile and
P3-demo seeds, so a per-group map needs a full E2E proof run.

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

## API edition (Batchwright API, edition `substance`)

Plan `docs/build-plan/api/plan.md` (approved 4 November), platform fit `platform-fit.md` (confirmed). A0 merged
(#111, 5 November): one edition list `kernel.editions()` (kernel 1403, site-services 1731, recipe-core 1872), the
`substance` edition value, `editions/substance/sql` (migrations 5000-5999). A1a (5 November): the shared enablement
(recipe-core 1873 lets a library block complete a packaging record; kernel 1404 market guard fails closed for an API
scope; substance 5000 the API-PACK completion row and the API G-REL hook; H-PACK in the blank API master; lot reservations take the batch's edition; SUBSTANCE in the edition enums) and a route-level test of
one API batch from library blocks to a released lot. Next: A1b (catalogue v1 and the E2E acceptance); resume from
`docs/build-plan/api/handover-a0.md` (section "A1a done").

## Demo gaps (designer restrictions, 7 November 2026)

Plan `docs/build-plan/demo-gaps/plan.md`; the D-0 sweep and the lead's audit in `d0/README.md`; resume notes in
`resume.md`. D-0 (#157) classified every refusal an author can hit. D-1 (#159): a stage added in the designer passes the
validator and takes its own yield step. D-2 (#160, recipe-core 1877): the same material on two formula lines, the
compensation and capsule-coating fixes, a formula draft withdrawn with a reason. D-3 (#161, recipe-core 1878): a
master draft discarded with a reason, and the family started again. R-flow (`r-flow.md`): a phase directly in a stage
(ADR 0004 amended), generic seed blocks, optional event sections, a stage with no yield and its reason, fieldless
instruction and sign-off blocks, a target without limits, and the citation fixes. R-rest Part A (`r-rest.md`): the
validator rows; dead branch, critical text, path-bound BOM line and SOP or process-data hold-time sources are warnings; a
clearance needs one person unless marked significant (a tablets packaging one keeps its second, Schedule M Part VIII 7.1); a stage may continue an
earlier clearance (`clearanceFrom`) and an earlier status check in the same room counts; reprocessing needs only its
maximum percentage; a master-level criticality assessment (`header.criticalityAssessment`) covers non-critical items; a
one-branch parallel stays refused (engine). D-4 (`d4-catalogue.md`): the demo set-up approves the seed catalogue as the
demo QA persona, each approval recorded as the set-up's; the retired tablet blocks' badge names its library replacement.
Next: R-rest Part B (recipe-core 1880), then D-5 to D-8.

## Next

**Demo gaps (bilayer MGL-SR-BL, 7 November 2026).** Plan `docs/build-plan/demo-gaps/` (D-0 restriction sweep, lead-audited:
`d0/README.md`; D-1 to D-8). D-1 (a new stage passes the validator, its own yield step) and D-2 (recipe-core 1877: the
same material on several formula lines, FRM-011 relaxed, a capsule's coat per batch, a duplicate formula EBMR-FRM-021,
withdraw a formula draft) in review. Next by the lead's order: R-flow (FLOW-LEVELS, LIB-024, optional event sections,
stage yield with a reason), D-3, R-rest, D-4 to D-8.

**Declutter (owner, 5 November 2026). Plan approved:** `docs/build-plan/declutter/plan.md` (#113).
- Only the working batch-record path stays on screen: library → formula → master and approval → batch → dispensing →
  floor and IPC → exceptions → review → packaging and labels → release, plus the audit trail, batch numbers, records and
  amendments, beta-lactam rules, devices, site values and operations.
- Everything else is disconnected: off the home and menus, and its routes refused with 410. Tables and records are kept.
- QP packages are disconnected for now.

**Resume here: D1**, in a fresh session (lead, 5 November):
1. Check on the demo that a new formulation can be built from library blocks and taken through master, approval and
   batch.
2. Add the shared `DISCONNECTED` list to `packages/api-contract`.
3. `bind.ts` answers 410 DISCONNECTED (as `PLATFORM_MANAGED_ROUTES`).
4. A generated 410 test per namespace.
5. A request-logged run of gmp-batches, library-dc and route-w. Every read a kept screen calls must stay connected.
6. The golden batches stay green.
7. Then D2 (web lists), D3 (the new home), D4 (data references).

**Injectables edition (owner decision, 4 November 2026).** Plan approved (v2): `docs/build-plan/injectables/plan.md`
and `platform-fit.md` (one `ebmr` database, edition as data; ADR 0001 amended). **I-0 merged** (#107). **5 November:**
the owner's control decisions recorded (#120: 89 MODIFY, ST-68 FOLLOW, ST-69 DONT_FOLLOW); the library checker refuses a
calculation over a typed date/time or a timer (#115). **#117 merged** (shared fix: a library block reads an earlier
step's value at runtime; ENG-DEF-STEP-VALUE at master check) and **#114 I-1a** (17 INJ blocks as data, the `sterile` rule
table published). **Resumed 6 November** after capsules: the #114 audit clean-up, then #131 (S1–S3), the `showWhen`
checker fix, unit-account v2, I-1c (vial and ampoule batches to release, E2E) and the I-2 blocks. **7 November:** merged
#146, #148, #147 (S1–S3), #149, #151, #152 (I-2 blocks, Annex 1 items as EU-market blocks) and #155 (I-1c1 vial E2E; it
narrows D-1 so the printed-packaging and label reconciliations, 211.125, are no yield checkpoint). Owner rule (7 November):
no new refusal without a quoted binding clause or a real engine or record-integrity need, named in the code comment.
I-1c1 complete (vial #155, ampoule #193). I-1c2 P2 merged (#194): the finished-pack examination and the
edition's release items (editions/injectables/sql 3000). P3 (#196): the packaging skeleton start. P3b (#197): a
clearance needs a second person only where its step names a checker (recipe-core 1886, 1887; residual: areas made
before 1887 stay on area_status v1). P4a (#198): the vial's GMP half to H-PACK (E2E group library-inj-gmp). P3c (#200):
the skeleton takes the firm's printed-item limits and specimens at create. P4b (#201, GMP 5-9, branch
inj/i1c2-p4b-gmp-packaging): the packaging master, its sandbox run, the GMP packaging order, QC and the IN release; the
skeleton runs G-21 in parallel with packing (lead, session 8). Notes:
`docs/build-plan/injectables/resume.md`. Migrations: `injectables` 3000-3999 (editions/README.md).

**Capsules edition (owner, 4 November 2026):** hard capsules and soft gels as library data inside the oral-solid build;
plan `docs/build-plan/capsules/plan.md` approved by the lead (v3, PR #102). The owner's binding rule: every numbered
requirement of 21 CFR 211, EU GMP Part I and Schedule M counts. **C1 merged (#105, 51f06cb, 5 November):** the catalogue
load takes the capsule blocks (R3-CAT-4 lifted); PROC-CAPS-FILL records the filling principle and size 5; a master from a
formula accepts a dosage form that says "capsule" (worded per capsule); any other non-tablet form, a bare "Softgel"
included, is refused with a hint (one rule everywhere, lead). The E2E approval helper waits for the button or APPROVED.
**C2 merged (#109, 5bdcab3, 5 November):** one rule for the unit form (`flow.readDosageForm`); the platform master reader takes
`dosage_form` from core's report.product_v1 (fake master has the column; a product core does not hold is refused as no
product master); the header reads "Batchwright Capsules" on a capsule master or batch (decision 0020 amended; ui-kit
`brand.Edition` gains `CAPSULES`, display only; `RunHeaderView.dosageForm`, lead OK); per-unit wording (formula screens,
"Batch size in capsules", the issue count). Shells (lead OK, 5 November, with a condition): the formula's COATING line
per unit on a capsule is the empty shells, a BOM line of role OTHER, not dispensed into the blend, lot-named and consumed
at PROC-CAPS-FILL; every screen names it "Empty capsule shells", never a coating (`flow.formulaRoleLabel`,
`bomShellsLabel`); a second per-unit COATING line on a capsule is refused (a coat on capsules is per batch, C3). New E2E
group `library-caps` (green to a released lot). Also on main: the E2E race fix (three container helpers wait for the stored
typed net before the verifier opens the containers page; it ended the "Verify the net" timeouts).
**Capsules edition complete (6 November):** C3 (#124, 9424f8f) and C4 to C8 in one squash (#141, 2d5d9af; it carries
#127, #129, #130, #132, #137, #138, #139). C4 multiparticulates, C5 liquid and plate filling, C6 soft gels I, C6b the
soft-gel E2E to a released packed lot (recipe-core 1875), C7 soft gels II (seamless, chewable and enteric as data,
disintegration or rupture), C8 exit: one review pass, a binding clause on every capsule field, `critical` only where a
clause names the parameter, `register:validate` refuses a repeated tests-list entry. Decisions D-C3-1 to D-C8-2 and the
accepted residuals are in `docs/build-plan/capsules/plan.md`, section 8. No capsule slice is open.
Rules learnt on the stack (for any later slice):
- Stacked squash merges conflict on the next PR; when the merge-resolved tree equals the CI-tested tree, merge on that
  green (lead, 6 November). A tests-list conflict is a union without repeats (validate now refuses repeats).
- A server read before a command must not change who is refused: the reviewed route matrix (DI-17) catches it.
Lead's rules (still in force):
- Declutter: no new home tiles, menus or screens; build only on the kept core path (packaging, label issuance and
  reconciliation are kept). Never call the namespaces in `packages/api-contract/src/disconnected.ts` (D1, #116; 410 on
  the platform build). C3 checked the acceptance helpers (change control, equipment logbook): none is disconnected;
  check any new helper C4 adds against
  that list.
- Full chain to a released, packed lot in every E2E (EBMR-REL-010); `library-caps` already does it; extend it rather
  than add a group where the plan allows.
- A coat on capsules (enteric, C3/C7) is a per-batch COATING line; never a second per-unit one (refused).
- A library STEP_VALUE input is resolved at runtime (#117 is on main); no capsule block needs one (D-C6-6).
- Declutter D3 drops SignInBrand's edition prop (sign-in says just "Batchwright"); the header keeps naming the edition of
  the record on screen through C2's `useScreenDosageForm`. Never pass an edition to SignInBrand.
- Container restarts leave the local PostgreSQL clusters stopped: `sudo pg_ctlcluster 16 main start` (and ci, ci2, ci3).

**Phase B (MEDHANTA platform move), started 3 November 2026.** Plan approved by the lead (decisions 1-6):
`docs/build-plan/phase-b/platform-move-plan.md`, with `permission-list.md` and the owner note `owner-note-access.md`.
The product is `ebmr` at `https://ebmr.<domain>`. Slice 1 (platform wiring) is in progress: the one-shot migrator
(`src/cli/platform-migrate.ts`), the platform env with verified TLS to the platform database (decision 3 revised:
TLS, not a socket), and `ops/Dockerfile`. The databsee side is on branch `b-ebmr-1`. Frozen baseline: branch
`standalone` at 0bb289c. Slice 1 merged (#88).
Slice 2 (sign-on, permissions and e-signature through core; `slice-2-design.md`): kernel 1400 (platform build flag set by
the migrator, `iam.platform_identity`, auth method PLATFORM, `iam.platform_sync_grants` mirroring the token's
`permissions` into per-person Work/Administration roles, `iam.platform_auth_event`), `/signin`, `/sign`, `/cb` (core's
`/auth`, `/token`, `/me`, client `ebmr`), login method PLATFORM, signing with a one-use proof bound to the challenge,
410 MANAGED_IN_PLATFORM on the people and grant routes, the web sign-in and signing window. Decision 0028 (owner-approved):
the mirror roles' DI-09 path; admin + GMP codes refused (INV-11). Open for later slices: platform first-run set-up,
idle-lock unlock through core (a locked platform session signs in again).
Slice 3 (master data, PL-07/PL-08): tablets 1900 (`md.item_map`, insert-only `md.master_fact`, `md.record_fact`
for ebmr_app, `md.require_active` with database triggers on product, room, equipment, instrument, ERP material,
received lot, equipment and instrument use, entries naming a received lot, and the batch issue). The kernel's
`withCommand` answers the database's EBM01 ("fact needed") by reading the item through `report.<kind>_v1` on the
master link (`MASTER_DATA_DATABASE_URL`, verified TLS) and running the command again with the fact recorded first; a
cut link answers 503 MASTER_DATA_OFF. On the platform build the define routes take core's name. Tests:
`test/medhanta/platform-master-data.test.ts` (stand-in master DB, `test/support/fake-master.ts`).
Slice 6 (the move, PL-13): `tools/platform` (move.ts and its CLI, after MMS) and kernel 1401
(`iam.platform_map_existing`). The platform migrator now revokes the verifier functions from ebmr_authn. The drill's
`allowNoRecords` option covers an empty site. The run on a copy of today's demo passed: 28 people, 110 master items
(`move-record.md`).

Issue #95 (INV-09; DI-22, DI-24): two content providers changed the content their own signature stood over.
site-services 1730 shows an ERP master's values in effect as they were before the confirmation, and recipe-core 1870
leaves the verifier out of an output container's content. On today's demo, the 50 ERP master signatures verify again.
The 12 container VERIFIED signatures made before the fix stay reported: they signed the two members as null. They are for
the owner, and the move carries them over and reports them.

Platform rehearsal finding (lead decision): the platform build had no way to enrol the first browser terminal. Kernel 1402
adds `iam.platform_register_terminal` and `ebmr first-terminal --code --fingerprint --by --reason` (cli/first-terminal.ts)
for the platform's operator. It works only while no browser terminal is registered, and is recorded as an installation
act with who ran it and why (DI-20). The "not an enrolled terminal" screen creates the browser's key and shows its
fingerprint. The runbook step is in cutover-runbook.md, step 8.

**3 November 2026: the Tablets v1.0 plan is approved** (decision 0027, `docs/build-plan/release-1.0/plan.md`; branch
`dyn/v1-plan` on top of `dyn/s11-findings`). R1 waits on PR #84's CI (GitHub-hosted runners, `CI_RUNNER=github`; the pod
is stopped). R2 static part done: PR-08 and PR-29 list their boundary tests; PR-60 lists its database test (kernel's
analytics role cannot write, now named `[DI-51][PR-60]`); DI-48's drill test title says it changes a database row; IN-12
and DI-48 name their implementation. Left for R2: the short-form listings and anything else `register:status` finds on a
full run's bundle. DI-48 needs R3 to review `tools/drills/src` (no review covered it; 7d checked only for secrets), and
R3 also takes `packages/validation-kit/src/pack`. PR-28 stays SPECIFIED (Injectables part).
V3 done (owner confirmed; `docs/build-plan/release-1.0/mutation-results.md`): SQL group `library-blocks` 48.5 % → 100 %
(new `apps/tablets-server/test/mutation/library-blocks.test.ts`); Stryker on the library's guard ranges 71 % → 91.8 % on
logic mutants (new `packages/recipe-core/test/library/limits-kill.test.ts`); the 89 left are low (listed). No guard
defect. Owner's triage rule from 3 November: fix critical, high and medium; list low. PR #84 merged (fccdffc); PR #85
(O-6 and the S11a findings) open, CI running. PR #85 merged (b12c6dd). R3 done on `dyn/v1-plan` (`docs/build-plan/release-1.0/r3-review.md`): 1 critical, 10 high,
12 medium found; all fixed with tests (branches r3/validation, r3/limits, r3/bom, r3/catalogue merged); 6 low listed;
R3-APP-2 and R3-ENG-6 (found during the fixes) after Phase B. Hard capsules left out of the Tablets catalogue load
(owner, 3 November). PR #86 merged (0bb289c; CI run 378 green, every E2E group). Branch `standalone` at 0bb289c; the
tag `batchwright-tablets-v1.0.0-rc.2` is the owner's to push there (the session's proxy refused tag pushes). **Next:
Phase B (the MEDHANTA platform move) on a fresh session, from `docs/handover.md`.**

**3 November 2026: O-6 done on branch `dyn/o6`** (from `dyn/s11`): the designer no longer offers TB-01 to TB-24 for a new
step (`insertable` false in the palette, badged "existing masters only (library replaces it)"; the Insert dialog lists only
insertable blocks); they stay described, so existing masters and copies keep their steps' forms and run as before. Nothing
deleted. S11b is PR #84 (`dyn/s11`). The two S11a findings are fixed on `dyn/s11-findings` (from `dyn/o6`): a timer's
exception shows its duration to three decimals (recorded and judged exactly as before); release-test blocks (QC_ANALYST,
QC_REVIEWER: no floor session carries them) are not offered in the designer's library picker, release tests staying QC's
record on the lot (D-S11-R1; the validator still refuses an unknown role). Next: O-7 (b) on `dyn/o7` (owner's OK to merge,
decision 0008 cadence), then the owner's choice of the next direction.

**Resume here (3 November 2026): S11 passes, CI green on the RunPod pod.** Full CI run 370 on `dyn/s11` at 5c81fc0 is green
(https://github.com/maglesT/ebmr/actions/runs/41533692154): static checks, supply chain, golden batches, all eight test
shards (one rerun: a random 3-byte room code clash in `packages/recipe-core/test/plant/support.ts` `tag()`, a pre-existing
flake) and all twelve E2E groups, the three library tablets among them. Run 369 found two of this branch's own defects,
fixed in 5c81fc0: a circular import in the e2e helpers, and the sandbox count check applied beyond masters from a formula.
The pod (32 vCPU, 14 runners `pod-1`..`pod-14`, label `ebmr-pod`) is up and `CI_RUNNER` is deleted (owner, 2 November).
Next: a PR when the owner asks. S11b passes locally on branch `dyn/s11` as well: each tablet
11 of 11, from the catalogue to its released lot, screens only (`library-wg-fc` 46 min, `library-dc` 45 min,
`library-rabe-ec` 46 min). The acceptance is `tools/e2e/specs/library/acceptance.ts`, one spec file and E2E group per tablet
(replaces `library-acceptance`): the catalogue, S11a, then GMP 1 to 9 (Demotab 4 to 12's screens; the GMP batch at the
authorised reference size, 1,00,000, D-S11b-3). The floor of a skeleton master is `library/skeleton-floor.ts` (sandbox and
GMP alike). Defects found and fixed in shared code, each with its test (no tablet code): the formula skeleton used the
sandbox-only G-10@1/G-09@1, so no GMP batch could be issued (D-S11b-1: now G-10@2/G-09@2); it had no H-PACK, so no batch
could be packed (D-S11b-2: H-PACK after the blend yield); its weighings were an operator's, and the GMP database lets only a
DISPENSER consume (D-S11b-4). The agreed follow-up is done: a master from a formula records `header.unitMassMg`, so R3.1
pre-fills each size's exact tablet count and refuses a mismatch; the sandbox issue refuses it too (EBMR-EXE-700). Test-side
findings (the controls were right): the product must be in the plant's product list before a clearance (EBMR-PLANT-012);
typed weighings when the GMP balance is offline; a sandbox TEST- code may not contain a word shaped like a real batch
number (DI-05). Commits 87c01b17, b334a88f and 0a252802 of `dyn/s11a` cherry-picked. The controls list the new tests;
the handbook is regenerated. The 7j `own-product.spec.ts` passes locally too. Local E2E: start PostgreSQL;
`/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell` must point at the installed -1243
`chrome-headless-shell` (local only); one group: `EBMR_E2E_GROUP=library-wg-fc PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers flock
/tmp/ebmr-e2e.lock -c 'CI=true pnpm --filter @ebmr/e2e test'` (about 20 minutes of set-up first).

**Start here (1 November 2026): the dynamic library (decision 0026).** Slices S0 to S11 in
`docs/build-plan/dynamic-library/plan.html` section 5. S0 (decision record, this page) and S1 (block-definition
model and sanity checks, `packages/recipe-core/src/library/`) are on branch `dyn/s0-s1`. S1 includes the plan
review's additions (inputs from outside the step, conditional fields, the content hash). S2 (branch `dyn/s2`): the generic
handler `library/block-version.ts` runs any library definition in the engine (O-9 b: calculated figures stored with
their evaluation record). S3 (branch `dyn/s3`): library storage
(recipe-core 1800, tablets 1802), routes `ns/library.ts` with LIBRARY_ACT approval, the `/mbr/library` screen. S4 (branch `dyn/s4`): masters
carry library snapshots (`MbrContent.blockDefinitions`, `library/integration.ts`), batches run them, the API takes
`LIBRARY_ENTRY`, and recipe-core 1810 checks entries, limits (`LIB_LIMIT_BREACH`) and snapshots. S5 (branch `dyn/s5`): the generic
library renderer (`floor/renderers/Library.tsx`) and the entry sentences. **Owner, 2 November 2026: do not ask before each
slice; go through S6 to S11 one after another** (only genuine owner decisions wait; O-7 still does). S6 (branch `dyn/s6`): smart
fields (lots, equipment, hand-keyed weighings; tablets 1803). S7 and S8 (branch `dyn/s7-s8`): the
ready-made catalogue (79 blocks, `library/seed/`, loaded as drafts; recipe-core 1820). S9 (branch `dyn/s9`): the formulation
builder in the designer (`LibraryBlocks.tsx`, ADD_LIBRARY_BLOCK), market rules on library limits (O-5) and the
sandbox run optional as evidence (O-2, recipe-core 1830). S10 (branch `dyn/s10`): batch generation with scaling, a library
formula line is the master's BOM line scaled exactly from the reference size (first listed) to the issued size, and the batch
size input is that size (`library/scaling.ts`; shown on the step screen; IN-13 refusal of unlisted sizes unchanged). S11a (branch
`dyn/s11`, **passing**, 4 of 4 in 34 minutes, 2 November): `tools/e2e/specs/library/three-tablets.spec.ts` (group
`library-acceptance`) sets up three tablets from the catalogue on screen (QA approves the blocks; the designer adds them with
the product's values; change control; four signatures; the IN authorisation) and runs each sandbox batch at the further size
through every library step on the kiosks. Defects it found and fixed (generic, no tablet code): identical limit labels in the
values form; catalogue signature roles no session carries (IPC_OPERATOR, QA_SHOP_FLOOR); the database's entry schema lacked the
server-filled lot and equipment facts (recipe-core 1840); a sample field's shown planned units not recorded; the field id
`balance` (now reserved) taken by the database's weighing rules for a scale weighing. Hard capsules: catalogue blocks added,
the capsule product deferred by the owner (2 November). Open findings: the issue screen's typed tablet count is not tied to
the chosen size for masters from a formula (fix next: pre-fill and check, R3.1's mechanism); a timer exception prints an
unrounded duration; release-test blocks name QC roles no floor session carries. S11b (GMP batch to released lot) follows. The Phase 7 notes below are history for the frozen work.

**Start here (24 October 2026):** `docs/build-plan/phase-7/HANDOVER-2026-10-24.md`: open PRs and branches (7p, 7q, 7o),
the next work in order, the RunPod CI runner plan and the token rules.

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

**Hosted demo (19 October)** on the owner's VPS: `docs/operations/hosted-demo.md`. Its review of rc.1 found person acts
with no screen (`docs/build-plan/phase-7/demo-gap-report.md`).

**Slice 7h (20 October, PR #63): every act has a screen again.** Floor plant acts on the step screen (A1-A9), the new
master record through screens only (B1-B4, the sandbox test-run result package), configuration forms (C1-C5), the
decision-0025 meta test no longer counts the demo load as a route (D1), browser tests for a full GMP batch on the kiosks
(`phase7/gmp-kiosk-batch.spec.ts`) and a new master record to approval with nothing arranged in the database (D2, D3),
demo set-up with GMP samples and the missing personas (E1, E2, E5), home tiles by role and kiosk reads checked for the
right first (F1, F2). Decisions D-P7R-16 to 21 (RESUME.md); review residuals P7H-2 to 5. No migrations.

**Slice 7i (20 October): the hosted demo's follow-up** (`docs/build-plan/phase-7/demo-followup-7h.md`). G1: on a demo
installation every kiosk's demo badge reader offers every badge holder ("Works here", then "Other people"); G2 (P7H-4):
a processing batch is planned against the ERP order clicked; P7H-5: a database refusal of a step entry is shown in its
own words (the EBMR-TAB family no longer reads as a failed sign-in). No migrations.

**Slice 7k (22 October, branch `phase-7/slice-7k`): hosted-demo trial requirements R2, R3.1-R3.13 (not R3.14), R5**
(`docs/build-plan/phase-7/demo-trial-requirements.md`; decisions D-7k-1 to -6 in `RESUME.md`). Servers survive a
PostgreSQL restart and `pnpm demo` exits non-zero when a child dies; navigation-reachability and demo-completeness
`[meta]` tests; the plant act and its step record as one act (batches.plantEntry); tablet count checked at issue;
saved forms close; lots on blur; still to weigh; stage sign-off ends uses; cleaning list per batch; kiosk session-end
notice (tablets 1570); credential card on Operations; Send a production order (tablets 1571); GB-T-02 second lots and
orders. Browser flow `specs/phase7/presenter-floor.spec.ts`.

**Slice 7j (22 October): R4, a company's own tablet product without a template** (`demo-trial-requirements.md` R4;
decisions D-7j-1 to D-7j-10 in RESUME.md; site-services 1530, recipe-core 1535). Products and materials entered on
screen and confirmed by QA; the formula's target tablet weight and batch sizes; a new master from an approved formula
(skeleton, blank or copy); the Tablets palette (TB-01 to TB-24) and stage editing in the designer; sandbox test lots on
screen; browser flow `phase7/own-product.spec.ts`; user guide page 9. The GMP batch of the new product needs R1's plant.

**Slice 7l (22-23 October): demo routes for R1** (`docs/build-plan/phase-7/slice-7l-routes.md`). Route W (wet,
enteric film, alu-alu cold form) with its plant, masters, lots and orders in the GMP demo set-up, and its browser test
from the ERP order to the released lot; step-screen fixes 7L-1 to 7L-9 (TB-01 potency, alternatives, loop iterations,
named preparations and containers, empty lists, automation fallback, forms cleared at save). Decisions D-7l-1 to 5. No
migrations. Routes D and S remain.

**Slice 7p (23 October):** a dissolution profile as one release requirement (R4 third check, R8 C4/C7; site-services
1720, recipe-core 1725; `slice-7p-routes.md`); demo SR product GLV-SR-500; browser `phase7/sr-profile.spec.ts`.

**Slice 7r (24 October, branch `phase-7/slice-7r`, not merged):** the R4 GMP batches on the screens only
(`slice-7r-routes.md`): Demotab (own-demotab, 12 of 12 on the pod) and P3 rabeprazole with its three coats and its
two-stage dissolution as one release line (own-p3, 12 of 12); recipe-core 1750, tablets 1701; decisions D-7r-1 to 10.

**Owner, 25 October: R8 is P3 rabeprazole only for now** (P1, P2, P4-P12 deferred). **Slice 7s (branch
`phase-7/slice-7s`, from 7r, not merged):** `pnpm demo:setup --with-gmp-samples` (set-up option `--gmp-p3-demo`,
`cli/demo-p3.ts`) loads P3 ready for the presenter (approved, IN-authorised masters with the three coats, specifications
with the two-stage dissolution, released lots, numbering, tooling); E2E group `p3-demo`; `slice-7s-routes.md`.

**Slice 7u (29 October, branch `phase-7/slice-7u-r10-p2p3`): R10 #6 to #20** (P2/P3 from the rabeprazole demo): a
released lot shows its release; reads refreshed after each act; QA's disposition offered only to roles that may give it;
a copied master names its own active; no test-run wording on GMP; computed values at their limits' precision (display
only); the finished lot given back by its code; container links; plain words and unit words; lot forms by material kind;
the anti-tampering check explained; packaging {SEQ} per parent batch (recipe-core 1790; IN-18 kept: after a counter skip
a parent's next serial may jump, D-7u-1); every entry kind summarised as a sentence in its block definition (R11 needs
it). Demo databases seeded before keep the old master names; a fresh seed takes the fixes.

**Slice 7t (28 October, branch `phase-7/slice-7t-potency`): R10 #1 to #5 and R13** from the owner's rabeprazole demo
(`docs/build-plan/phase-7/demo-requirements-R10-R13.txt`). TB-01 shows its calculation and weighs against its targets;
a lot's potency with its history, a potency preview at reservation and planning, QC's guided "Update the potency" page,
POTENCY_RECALCULATED for QA; after TB-21's Run end a missing entry follows a LATE_REASON (RUN_ENTRY_LATE for QA), with a
warning before Run end; bulk issue offers only the final stage's non-reject containers; the processing record closes at
the first lot disposition when no bulk is left. Tablets 1760, 1770, 1771. Defaults: D-7t-1 the potency change is an
attributed QC act with a reason (no e-signature; the results it takes are signed); D-7t-2 every recalculation is an
exception; D-7t-3 TB-21@1 changed in place (additive) so the stuck order RAB26001/P01 can finish; D-7t-4 the automatic
lock is attributed to the releasing AP, and RAB26001/2 are closed by production on /records. Next: slices B (R10 #6-#20),
C (R11), D (R12).

**Slice 7n (23 October): R7, a beta-lactam product in a dedicated suite** (`docs/build-plan/phase-7/slice-7n-routes.md`).
Recipe-core 1655 dedicates rooms and lines to beta-lactam products (IN-27 dedications, class `BETA_LACTAM`) and refuses
a beta-lactam batch outside them and any other batch inside them (PR-27). Demo route B (CXC-325, invented: direct
compression, film coat, alu-alu with desiccant) in the suite BL-DISP to BL-PL with its kiosks; browser tests
`route-b.spec.ts` and `route-b-refusals.spec.ts`; user guide page 10. Decisions D-7n-1 to 11; review P7N-1 to 3 fixed.

**Slice 7m (23 October): demo routes D and S for R1** (`docs/build-plan/phase-7/slice-7m-routes.md`). Route D (roller
compaction, bilayer, ink printing, aluminium strip) and route S (sugar coating in five applications, PVC/aluminium
thermoform) with their plant, kiosks, masters, lots and orders in the GMP demo set-up, and their browser tests from the
ERP order to the released lot; TB-08 on a second route W batch (`route-w2.spec.ts`). Fixes 7M-1 to 7M-4 (TB-16 layer
charges, TB-17 challenge entry, TB-08 authorisation request and sources picked on screen) and review finding P7L-1
(recipe-core 1650). Decisions D-7m-1 to 5. Every tablet block and every coating and pack type is now on a route.

**Slice S16 (31 October, branch `s16-reference-views`, not merged): report views for the external Deviations and CAPA
system** (ADR 0022, D-S16-1 to D-S16-6). Tablets 1800 adds `report.reference_document_v1` and `report.batch_reference_v1`
(the documents a GMP batch's pinned master cites in its `references`); tablets 1801 adds `equipment_use_v1`,
`ipc_result_v1`, `process_actual_v1` and `exception_detail_v1`, each with a `_v1_for(batch_numbers)` function for one
batch (tested on a GMP batch with a failing physical check in `report-views-investigation.test.ts`). GMP records only;
persons by pseudonymous id only. SELECT to `ebmr_app` and `ebmr_report` only; the segregation check is unchanged and
stays clean. The eleven views the reader uses are pinned by
`apps/tablets-server/test/contract/report-views-deviations.test.ts`; a column change is a new `_v2`. Ops note
`docs/operations/report-reader.md` and an `ebmr_report` line in the `pg_hba.conf` template. The shared demo scenario is on
the hosted demo (RAB-GR-20, RAB26002 and RAB26004), built there by the owner's server session; no demo tooling here.

Next: update the hosted demo to 7i and rehearse the demo guide's full-batch act on it (D2), then Tablets v1.0.
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
