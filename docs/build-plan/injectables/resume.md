# Injectables: resume notes (I-1c2 P4a merged; P3c next, then P4b, 9 November 2026)

Read these instead of the session history. The rules in force are:
- `plan.md` (approved v2; the block-version rule is in it);
- `platform-fit.md`;
- section 9 of the plan (the owner's and the lead's answers);
- the hard rules of `CLAUDE.md`.

## State on 7 November 2026

Merged: #146 (I-1a audit), #148 (`showWhen` checker fix), #147 (S1–S3 shared work), #149 (unit-account v2),
#151 (unit accountability reads the capping or sealing rejects), #152 (I-2 blocks: 6 base and 6 EU-market), #156 (CI, lead) and #155 (I-1c1: a vial from the
library to sandbox run, approval and IN authorisation, E2E). No injectables PR is open.

### Rules added since 6 November

- **Owner, 7 November (via the lead): flexibility within compliance.** Add no refusal (validator rule, SQL check, unique
  index, error code) unless it has a quoted binding clause or a real engine or record-integrity need, and say which in
  the code comment next to it.
- **Annex 1 items are EU-market blocks.** The base blocks follow 211 and Schedule M; Annex 1 items sit in their own
  EU-market blocks, which a non-EU master leaves out.
- **Block versions** (lead, 6 November): see `plan.md`. Until the first customer install a catalogue block is edited in
  its version 1; after it, a change is a new version.
- **Component lots (lead, 6 November):** component lots are recorded in INJ-WASH, INJ-PARTS-AUTOCLAVE and INJ-CAPPING
  with second-person verification; acceptance comes from the lot's release status (211.84). ST-39's `expert_decision`
  is the owner's to record; this text is the lead's proposal.
- **Yield checkpoints (GMP-YIELDS, #155 narrowing D-1 of #159):** a library yield or reconciliation step with a critical
  calculated limit is its own yield checkpoint (211.103), except CTRL-PRINTED-RECON and PACK-LABEL-RECON: a labeling
  reconciliation answers 211.125 and is no yield of the product.

### Lead decisions to apply (5 November 2026)

- **S3: one dosage form → edition map** (tablets / capsules / injectables / substance) in recipe-core flow, used by the
  header and by S2. Replace `flow.isInjectableForm`, which sits next to capsules' `isCapsuleForm`: no second if-chain.
- **S1:** before an injectables-only branch, check how capsules C2 starts a non-tablets family from a formula. Reuse a
  shared non-tablets path if there is one. Otherwise key the condition on the edition's data, not on a string spread
  across files. Tablets output stays unchanged (golden test).
- **S2:** approved. The edition comes from the product master's dosage form (single source, no new field, no web change).
- **#114 audit item 3 (settled, lead 5 November 2026):** the 0–100000 limit slots on the count fields stay, the same as
  the capsules ruling. `nominalEntries` takes a count's nominal value from its limit slot's target, and a shared change
  to the nominal values is not worth it now.
- **Library checker, `showWhen`:** do this first on resume. The checker accepts a `showWhen` that names a field outside
  its own entry, but the runtime never reads it, so the field is never asked. Fix: a LIB- refusal with a test (lead
  approved).
- **Annex 1:** binding for EU-market products, "should" wording included (owner Q0, #120). Guidance documents and
  recommended or example values are not. Tag each Annex 1 item as EU-market so a non-EU master can leave it out. 211 and
  Schedule M stay the base. Apply this to the I-2 blocks and re-check the I-1 blocks.
- **PUPSIT and the integrity-test method** are answered per section by the operator; no new slot kind.
- **EM is signed by production roles** for now: QC roles are not engine roles yet (decision 0026 gap). CFU limits are
  formulation values; the sterile rule table has no CFU keys.
- **UI (owner):** each step is one simple form page (label → input → unit → limits, signature at the bottom), built once
  by declutter D3. No edition-specific screens or panels.
- **Merging:** no merge queue. Merge each PR yourself on green, after a lead audit (ping the lead). Merge main in only
  on a conflict. Report each merge in 2 lines.

### Session 15 (13 November 2026): I-6 exit, continued (session_01PybpFuMPRb1RHpjkTuiuVZ)

- **CI:** `ubuntu-latest` moved to Ubuntu 26.04. Playwright 1.56 installs no Chromium there, and the image adds PostgreSQL 18,
  which broke the F55 restore test. The GitHub-hosted jobs are pinned to `ubuntu-24.04`, and `start-postgres.sh` puts PG16's
  bin dir first on the PATH (#242).
- **Market-required blocks (lead ruling, B2):**
  - A block's `markets` tag stays metadata (owner Q0).
  - The master validator reads one table, `MARKET_REQUIRED_BLOCKS` in recipe-core `validator/rules-content.ts`, through the
    rule MKT-REQUIRED-BLOCKS (validator 1.3.0).
  - Each entry is {market, trigger block, required block, AFTER or BEFORE, control, clause}. On a master for that market,
    each trigger step has the required step after it (or before it) on every path.
  - First entry, ST-06: on an EU master, INJ-FILL is followed by INJ-ALARM-ASSESSMENT (A1 5.2). At run time, an alarm entry
    without its assessment is refused. INJ-FILL itself asks no assessment on any market.
- **B5 (after B4; lead ruling):**
  - A binding EU clause with no enforcement is a defect. Add one table entry for each EU-tagged block that a binding clause
    makes mandatory (INJ-PUPSIT, INJ-GLOVE-TEST, INJ-VHP, INJ-SUS-INTEGRITY, INJ-ASEPTIC-TRANSFER,
    INJ-STERILE-PACK-INDICATOR, INJ-RADIATION-EU, the EU inspection and route blocks).
  - Give each entry its trigger, its clause and a test by control ID. A block with no binding "must" stays optional, with
    a one-line note.
  - Check that the E2E masters still validate; today they are all India.
- **B3 (lead OK):**
  - ST-29: a change record's optional, firm-set "APS required" list of lines. Approval records QUALIFICATION_WITHDRAWN on
    each line, and fitness then refuses the line until QA requalifies it. Database-enforced.
  - ST-33: check A1 9.46 and Schedule M's sterile part first. If either binds, a failed media fill withdraws the line for
    those markets.
  - ST-52: INJ-PUPSIT gets a waiver path (risk-assessment reference), as a v1 edit with safety evidence. The table gets an
    EU entry for INJ-PUPSIT before INJ-STERILE-FILTER. The redundant train is not_required.

### Session 15 handover (13 November 2026, about 07:40): the next session continues here

- **PRs:**
  - #242 (0030 branch + CI pin to ubuntu-24.04): a full run was in progress. Everything was green except E2E own-p3 and
    own-demotab, still running after more than 65 min. It merges on a full green run whose head contains main (lead).
    Then send "#242 ready for audit".
  - #243 (I-6.2): its CI was in progress. Send "ready for audit" when it is green. Merge main in after #242 lands.
- **Branches waiting (each is merged with the one before it, all pushed):**
  - inj/i6-3-clauses-st41-in
  - inj/i6-b1-minimum
  - inj/i6-b2-eu-em: ST-06 ruling (b), the EU block INJ-ALARM-ASSESSMENT, MKT-REQUIRED-BLOCKS, validator 1.3.0
  - inj/i6-b3-aps-pupsit: ST-29 (1910), ST-52 (INJ-PUPSIT waiver plus a BEFORE table entry), ST-33 (1911)
- **Open PRs one at a time, at most 2 open:** 6.3, then B1, B2, B3. Each one: merge main in, get a full green run, send
  "#N ready for audit", squash-merge after the lead's OK.
- **Squash-merge messages:** the B3 commits 9132828, 80ea269 and 6919381 carry a model name in their Co-Authored-By
  trailer, and force-push is refused here. Write the squash message with the plain trailers
  `Co-Authored-By: Claude <noreply@anthropic.com>` and `Claude-Session: ...`.
- **B3 points for the lead's audit:**
  - ST-29: the "APS required" list is firm-set. QA's signed change content includes it (1910 replaces
    platform.change_record_content). Approval withdraws the lines in a DB trigger. In the tests, the master-data steward
    requalifies, because QA personas lack MASTERDATA.CHANGE.
  - ST-33 (EU only; Schedule M 5.6(i) asks an investigation only): a trigger on recipe.execution_state reacts to
    contaminated > 0 in INJ-APS-READ.
    - It keys on the catalogue code only; a site copy under another code would escape.
    - "3 repeat runs" is mapped although the repeats are not counted (QA requalification stands in).
    - Quarantine and the impact list are not_required. A1 9.46(iv) asks a review of batches since the last good APS:
      the lead to confirm.
  - ST-52: the waiver is a YES_NO with no expected answer (default no), plus a required riskAssessmentRef. The v1-edit
    evidence: the nominal run is unchanged, and seeding keeps existing copies.
- **Then:** B4 (IN-48), B5 (one MKT-REQUIRED-BLOCKS entry per EU block a binding clause makes mandatory), GB-I-01,
  PR-15/26/28, the phase.yaml exit PR (PROGRESS: INV residuals, the demo fresh install, the room EM logbook deferred by
  the owner), the review pass.

### Session 14 handover (12 November 2026): I-6, the injectables edition exit

Lead: session_01PybpFvEFaQZ3LEfnNdjBCE until 19:27, then session_01PybpFrP72XuwyG8S3H3NJS (has all I-6 rulings). Owner's exit list: injectables in phase.yaml, the trace gate green for the
injectables controls, a golden batch, the browser suite, one review pass.

- **Measured:** main's reports with `editions: [tablets, injectables]` gave 129 new trace errors. 90 controls (IN-40..51,
  ST-01..79 except ST-69) had no clauses; PR-15's scope and PR-26/PR-28's clauses were deferred to phase 5.
- **#241 (I-6.1, branch inj/i6-1-not-required):** a clause kind `not_required: {decision, reason}`.
  - Allowed only on a MODIFY control. The decision is docs/decisions/*.md or docs/build-plan/**/control-decisions.md.
  - The reason is at least 2 whole words quoted from the control's own row or paragraph (`rowsOf` in
    tools/register/src/not-required.ts).
  - It shows as NOT_REQUIRED in the trace, the matrix and the bundle. A due control still needs a passing test.
  - Lead audit fixes are in, with no re-audit needed. It merges on a full green run.
- **State at handover (13 November 2026, 05:40):**
  - #241 is merged (998eb7b).
  - Next PR: this branch (0030 and these notes), docs only; merge main in first.
  - Then I-6.2, I-6.3, B1 and B2 in that order, at most 2 open at once. Each branch is built on the previous one, so merge
    main in (merge commit) as each one lands.
  - Send "#N ready for audit" to the lead.
  - B2 (inj/i6-b2-eu-em @6da5b348):
    - ST-18, ST-19 and ST-34 stay on every market (accepted; SM Part II 4.8 and the sterile part).
    - ST-06, lead ruling (b): the alarmAssessment refusal applies only on EU markets (a separate EU block, or the simplest
      equivalent). Outside the EU, no refusal: a refusal with no binding clause is a defect.
    - If (b) costs more than half a day: keep the field optional everywhere, cite A1 5.2 for the EU, and list "EU hard
      refusal for an unassessed alarm" as a residual for the owner.
- **Owner, 13 November 2026 (via the lead):** "not now" to a room-level EM logbook between batches. It is deferred by the
  owner and not built; note it in PROGRESS.md with the exit PR.
- **Decision 0030 (this branch, inj/i6-0030-unbuilt-minimum):** lead rulings under the owner's minimum-compliance rule.
  - Left out: ST-02, ST-06 (release-block part), ST-11, ST-17 (restoration record), ST-20 (viable alert), ST-22
    (per-operator), ST-67, ST-71 (listing both), ST-72 (naming), ST-75, ST-76, IN-45 (listing).
  - One due date per unit (plan 4.1): the site sets it to the earliest of calibration, requalification and leak test.
- **Mapping and tests (pushed, PRs after #241 and 0030):**
  - inj/i6-2-clauses-st01-40 @2d30260e: open only for build PRs.
  - inj/i6-3-clauses-st41-in @49915f91: open ST-52 and IN-48.
  - Test code and control YAML only.
- **Build PRs (lead order B1 to B4, at most 2 open at once):**
  - B1, branch inj/i6-b1-minimum (local in the agent's worktree, built on I-6.2):
    - ST-01/20: Grade B viable HARD rows in sterile.v1.yaml, EU and India (v1 edit approved). Existing demo databases need
      a fresh install (EBMR-MKT-035); say so in the PR body and PROGRESS.
    - ST-12: people present in INJ-FILL against a formulation maximum (A1 7.2).
    - ST-23: INJ-EM media lot as a MATERIAL_LOT (A1 10.9, SM I 14.39).
    - ST-28: post-use integrity of the gas filter (SM II 6.11.2.7, A1 8.88), every market, its limit only where an overlay
      exists.
  - B2: ST-06 alarm assessment (A1 5.2); ST-18 (A1 9.22); ST-19 (A1 9.16/9.24); ST-34 (A1 9.25). All EU-only, EU-block
    pattern.
  - B3: ST-29 (A1 9.38, SM II 5.5: a change marked "APS required" lapses APS.<line> until QA extends it); ST-33 (A1 9.46(iii),
    EU); ST-52 (A1 8.87 PUPSIT, EU, with a waiver field).
  - B5 also (lead ruling on #245, 13 November): ST-28's remaining gap. An overlay is chosen at run time, so no master
    table entry can require INJ-GAS-FILTER. Build a database guard on all markets: a batch that recorded a gas overlay as
    applied and has no passing INJ-GAS-FILTER post-use result is refused certification and release, tested [ST-28]. B1
    proves only the case where the block is present (the lot stays NOT_READY until the post-use result is in).
  - B4: IN-48 (lead's option 1).
    - `firstUseToday` on every market (SM II 6.11.2.8, A1 8.94). On "No", a validation reference (TXT); without one, a
      critical exception.
    - `newFilter` EU-only.
    - Both under the existing verifier; v1-edit safety evidence in the PR body.
    - Built (inj/i6-b4-in48): INJ-STERILE-FILTER v1 in place, `firstUseToday`; on no, `extendedUseValidated` (no is
      critical: the new YES_NO mark `unexpectedCritical`) and `validationRef`. `newFilter` is the EU block
      INJ-FILTER-SINGLE-BATCH (OPERATOR + VERIFIER) before each filtration step on an EU master (MKT-REQUIRED-BLOCKS):
      no field-level market tag exists. The database does not re-judge yes/no answers (as for every LIB_UNEXPECTED_ANSWER).
- **Then:**
  - GB-I-01: the aseptic vial to a released lot, with sterility by RMM. A method field on the results screen goes to the
    lead first.
  - PR-15: test the area refusal on an injectables filling room and remove its deferred_scope.
  - PR-26 clause 2 (hose scan) and PR-28 clause 2 (EM excursion on the QP screen): owner write-up, not a deferral.
    PR-28 clause 1 (failed autoclave cycle): a test.
  - The exit PR: injectables in phase.yaml once #232/#239 merge, a full run with trace:e2e.
  - One review pass. Items added by the lead (13 November):
    - Kernel platform.change_record_content now reads plant.aps_required_line (tablets 1910). Check whether
      register_content_provider could let the plant module add aps_lines without replacing the kernel function.
    - The database does not re-judge expected yes/no answers (only limits, recipe-core 1862), so a raw write that omits
      the exception is not caught. Assess a general database re-check of expected answers, like 1862's, for all library
      blocks.
- **PROGRESS notes due:**
  - INV-23, INV-36, INV-44: residuals for the owner. The exit list supersedes outline 11's INV list. INV-37 is proven by
    the ST-68 gate test; INV-45 by ST-64.
  - ST-02's "CCS reference TXT where a block needs it": none needs one (lead ruling ii).
  - The demo fresh install (lead ruling on #245): the hosted demo needs a fresh install after the I-6 merges.
  - Owner residual: the upgrade path for existing installs needs a sterile v2 rule table and a library v2 publish. B1
    edits sterile.v1, INJ-EM, INJ-FILL and INJ-COMPOUND in place. An existing database keeps the old library v1
    (draftSeedCatalogue skips codes already held), and publishRuleTables refuses the new sterile v1 (EBMR-MKT-035).
  - ST-12 "peak shown on the timeline": not_required under decision 0030 (lead ruling, owner may veto).
- **Step 8 also (lead):** two intermittent failures, root cause not loosening:
  - a GMP 1 `endorseOnLicence` fill timeout at tools/e2e own-product-gmp-flow.ts:119-120 (library-wg-fc, library-inj-aseptic);
  - the [DI-20] opcua-endpoint-identity.test.ts enrolment, which expected EBMR-EQD-032 but got a duplicate-key violation (shard 7).
  - A small fix PR first if they block full runs.
- **Local:**
  - Run the trace with editions extended against CI reports: download the trace-matrix, e2e-reports and vitest-golden
    artifacts, then `sed -i 's#/home/runner/work/ebmr/ebmr#/home/user/ebmr#g'` on the JSON.
  - Agents use the spare clusters ci2 (5434) and ci3 (5436).

### Residuals (lead, 9 November 2026)

- **EU-market ampoule:** INJ-CCI-100, the 100 % integrity test of fusion-sealed ampoules of 100 mL or less (EU GMP Annex 1
  8.22), with the leakers counted as rejects in INJ-UNIT-ACCOUNT. Build it only when an EU-market ampoule product is in
  scope. The IN ampoule (#193) uses INJ-CCI as a sample.

### Session 10c, the dual-chamber cartridge (12 November 2026, branch `inj/i4-dual-chamber`)

- Sandbox half in its own group library-inj-cartridge (lead: keeps the full run's wall time down), data only (`DUAL_CHAMBER` in injectables-routes-acceptance.ts): drug fill,
  INJ-LYO (the middle stopper seated in the chamber), a second INJ-STERILE-FILTER and INJ-FILL for the diluent (step ids
  `p-inj-sterile-filter-2`, `p-inj-fill-2`), INJ-PLUNGER as the closing; 2 tests passed locally (32 min).
- The diluent is water for injection from the point of use, with no step of its own beyond its filtration (DEMO data).
- **Lead audit of #239: PASS on scope and data; before merge:**
  1. after #232 lands (it edits the routes data) and #238 lands (it adds the optional `expect` on ProductBlock: entries
     and verified values), merge main in (union of the routes data, the playwright group list and ci.yml's ALL list);
  2. assert, for the cartridge: the diluent INJ-FILL's (`p-inj-fill-2`) and INJ-PLUNGER's computed rejected/accepted,
     and INJ-UNIT-ACCOUNT's outcome (nothing unaccounted for: 10,000 = 20 + 40 + 9,720 + 80 + 120 + 20);
  3. run the cartridge spec locally (32 min), then a full run (runner=github) on a head containing current main; merge
     on green (no re-audit if only these change).
### Session 11b (11-12 November 2026): I-4 routes merged; powder, lyo, emulsion and syringe E2E

- **Merged:** #228 (ac5e975): the FFS bag, BFS ampoule and radiation-sterilised vial in `library-inj-routes`; the
  INJ-FFS/INJ-BFS v1 seal counts (typed `sealRejects` per round, typed `rejects` at filling, CALC `totalRejects`).
- **Merged:** #231 (a7e4e69): the sterile powder vial (I-4, `library-inj-powder`, sandbox) and the lyophilised vial to
  release (I-3, `library-inj-lyo`, sandbox + GMP; the lyophilised loads are the output, stage `LYOPHILISATION`); the
  INJ-FILL closures label in the approved neutral wording. Its library-bilayer job failed once (closeStage, "Signed." not
  shown) and passed on its one re-run; main's bilayer was green.
- **#232** (branch `inj/i4-emulsion-syringe-e2e`, audited PASS): an emulsion in vials (I-1 vial route + INJ-HOMOGENISE,
  a 5 micrometre filter) and a prefilled syringe from ready-to-use tubs (I-2b RABS set-up, INJ-SUPPLIER-STERILE,
  INJ-ASEPTIC-TRANSFER, INJ-PLUNGER as the closing rejects, no capping), both in `library-inj-routes` (now 5 products,
  about 50 min). It needs:
  - INJ-FILL v1, additive: the format also offers Syringe, Cartridge and Bottle (the plan's INJ-15 row);
  - `alsoIn` on an acceptance component (one physical lot named in several steps: the plunger stoppers in the autoclave
    load and at placement).
  Both pass locally 4/4. The lead accepted both in principle; the PR body must show the in-place INJ-FILL edit is safe
  (as #231's does: nothing pins INJ-FILL by hash; library, demo-catalogue, demo-seed and entry-data tests pass; the
  golden batches are tablets-only). Merged on a green full run whose head contained current main.
- **Merged:** #237 (621671d): main's tsc failed after #234 (InjectableGmp.outputUnits optional) and #231 (which copied
  it into a required field) merged in that order; the lyo product now requires the aseptic vial's value. Lesson (lead):
  merge only when the green run's head contains the current main (`git merge-base --is-ancestor origin/main <head>`).
- **Next (lead, 12 November 2026):** dual-chamber (INJ-FILL twice, INJ-LYO, INJ-PLUNGER; no new block), then I-5
  (automated inspection, deterministic CCIT, RMM in INJ-26).
- **Learnt:**
  - Two PRs that each add an E2E group and control titles always conflict in `playwright.config.ts`, `ci.yml` and the
    controls. Keep both sides. Then dedupe the control lists (the conflict's context line comes twice), run
    `register:sort-tests`, and check each control equals the union of both sides. Watch for a group key defined twice in
    the config (TypeScript does not flag it).
  - Local E2E in a fresh container: create the role `ebmr_dev` (as `tools/ci/start-postgres.sh` does). The pre-installed
    Chromium is newer than the pinned Playwright's (1194 against 1243): point `PLAYWRIGHT_BROWSERS_PATH` at a directory
    with `chromium_headless_shell-1194/chrome-linux/headless_shell` linked to the installed one. A killed run leaves the
    stack's node processes holding connections ("too many connections for role ebmr_sandbox_listener"): kill
    `apps/*/src/main.ts` before the next run.
  - `manual-weighing-gate.test.ts` failed twice on one GitHub shard during the Actions outage, then passed on the next
    run and locally 9/9 (heartbeat-window timing under load). Logged to the lead; not changed.
- **Residuals (lead, 12 November 2026; root cause assigned by the lead):**
  - The GMP 1 licence step `endorseOnLicence` (tools/e2e/specs/phase7/own-product-gmp-flow.ts:119-120) timed out on a fill
    (30 s) twice: `library-wg-fc` in run 43227171720 (head 864ff23), and `library-inj-aseptic` in run 43266879234 (head
    9ab0790). Both groups passed in the other run on the same head. It's intermittent and in shared tablets and injectables
    code.
  - `packages/recipe-core/test/equipment-data/opcua-endpoint-identity.test.ts` [DI-20] enrolment: expected EBMR-EQD-032,
    got a duplicate-key violation (shard 7 of run 43266879234). Intermittent.

### Session 13 → Handover (12 November 2026, 17:10; I-6 is a fresh session)

- **I-5 done:** #236 (blocks, f7f47be) and #238 (E2E, group `library-inj-inspection`, dab3f29) are merged. No I-5 branch is
  open.
- **For I-6 (injectables edition exit; the owner's list: injectables in phase.yaml, the trace gate green for the
  injectables controls, an injectables golden batch, the browser suite, one review pass):**
  - The **RMM residual** belongs in the golden batch if it fits. Record the lot's STERILITY result as made by the validated
    rapid method, and check first whether the lot's results screen (`recordResults`, D-S11-R1) can carry the method. If it
    cannot, raise that with the lead before adding a field. TEST-INJ-RELEASE (with `rmmReportAttached`) is used by no E2E.
  - INJ-AVI-CHALLENGE-EU and the other EU-market blocks are covered by seed tests only, because the sandbox authorises IN
    only.
- **E2E helper (`library-support.ts`):** `ProductBlock.expect` is optional; nothing is asserted by default.
  - `verified`: the step must reach "waiting for verification", and the signed result must name the verifier, who is
    another person.
  - `entries`: each pattern must appear in the step's entry list. Calculated values show as `label value unit (calculated)`;
    `injectables-inspection-acceptance.ts` has a `calc()` helper for them.
  - Use it so that a broken calculation or step-value wiring fails the run.
- **Lead merge rule:** squash-merge only when the green full run's head contains the current main. The exception: when
  the commits added since that run touch files disjoint from the PR's, the merge is conflict-free, and tsc and register
  pass on the merged head, the earlier green run counts.
- **Local:** a full `pnpm run ci` takes more than 30 minutes here, so run `pnpm test:json` and `pnpm trace` as separate
  background steps. Locally the kernel DI-13 TLS test fails (it depends on how the local PostgreSQL is set up), and trace
  lists DI-51, IN-16 and PR-22, which need the E2E and golden-batch reports; neither is a defect.

### Session 13 (12 November 2026): I-5, automated inspection, deterministic CCIT and RMM

- **Lead design approval (12 November):**
  - INJ-AVI: automated visual inspection, every market. The counts are typed from the machine report and CHECKED (SM Part I 5.4.6, 211.68(b)). The machine's due date meets SM 10.8's check at intervals. There is no AQL section.
  - INJ-AVI-CHALLENGE-EU: Annex 1 8.32; the operator signs alone.
  - INJ-CCIT-100: a 100 % deterministic in-line test. A leaker is a counted reject, not a batch failure. Its `totalRejects` (the closing rejects plus the leakers) is read by INJ-UNIT-ACCOUNT as its closing rejects, in either step order.
  - v1 edits: INJ-CCI gains "Laser headspace analysis"; INJ-UNIT-ACCOUNT's closing-rejects label is reworded; TEST-INJ-RELEASE gains `rmmReportAttached`, shown when the sterility method is a validated rapid method.
  - Seed file `seed/injectables-inspection.ts`, blocks PR #236.
- **E2E (group `library-inj-inspection`, sandbox half):** the I-1 vial with INJ-CCIT-100 after capping and INJ-AVI in place of the booth. Data in `injectables-inspection-acceptance.ts`. Green on run 43180982902.
  - Lead ruling: the EU challenge block is left out of the IN master; the seed tests cover it.
- **Residual (lead, 12 November):** RMM is covered at seed and unit level only. No E2E uses TEST-INJ-RELEASE, because release results are QC results on the lot (D-S11-R1). RMM runs end to end when the I-6 golden batch or a GMP half records a sterility result by the rapid method; check then whether the lot's results screen needs a method field.
- **Learnt:** merge main in before the full run that decides a merge. The lead's rule is that the green run's head must contain the current main (main went red on tsc when #231 merged on a stale run).

### Session 10c handover (12 November 2026): I-2d and the EM tiers

- **#234 (I-2d):** the media fill's GMP run to QA's record review (E2E). The sandbox half ticks the process-simulation
  mark on screen and deletes the release for packing; the GMP half records no licence, printed items or product
  specification, issues the batch (the allocation register: "Process simulation (no licence)"), runs the kiosks with no
  output containers, and GMP 5 is QA's record review plus a refused finished-lot post (TAB-850, the general rule; the 1896
  refusals are its database tests). Lead rulings: the master-version market authorisation stays (PR-04; GMP 3's issue,
  listed under PR-04, proves it); H-PACK is deleted on screen; the API-level refusal is enough.
- **#235:** the values helper types each limit tier into its own boxes ("More limits"); GMP 8b checks that the blocked
  exception says "is outside its internal action limit" (the tier the engine breached). Early full run green on every group.
- **Routine EM (item 3), lead ruling:** not a batch record and no ROUTINE_MONITORING kind. An on-screen try (a one-line
  "product" of agar plates with INJ-ROOM-READY, INJ-EM, INJ-EM-COUNTS) ran its sandbox half, but a GMP batch would need a
  made-up product and licence entry (false records). Release reads the EM taken during the fill; routine EM belongs to the
  site's EM programme. Dropped from the injectables scope.
- **Residuals:**
  - H-PACK on a PROCESS_SIMULATION master: from-formula or the validator could drop it, or warn (lead).
  - A counted formula line (units, not kg): the skeleton weighs every line; plates or other counted consumables would
    need it.
  - **Owner question:** a room-level EM logbook (an area or plant record with the EM blocks) as a future feature, if wanted.
- Local notes: the E2E of the media fill spec alone takes 35 min; a scratch spec in the main tree must be excluded in
  `.git/info/exclude`, never committed.
### Session 10c (12 November 2026): the media fill's GMP run, the EM tiers, routine EM

- **I-2d (branch `inj/i2-d-media-fill-gmp`):** the media fill's GMP run to QA's record review, group `library-inj-aseptic`
  (7 tests, 35 min locally). The sandbox half ticks the process-simulation mark on screen and removes the release for
  packing; the GMP half records no licence, printed items or product specification, issues the batch (the allocation
  register shows "Process simulation (no licence)"), runs the kiosks with no output containers, and GMP 5 ends with QA's
  review and a refused finished-lot post (the service the form calls; the DB refusals are #230's tests).
  - Lead rulings (12 November): the master-version market authorisation stays (PR-04 market validity applies to a media-fill master; GMP 3's issue, listed under PR-04, proves it;
    this supersedes the I-2c ruling about skipping it); the author deletes H-PACK on screen; the API-level refusal is enough.
  - **Residual (lead):** from-formula or the validator could drop H-PACK, or warn, on a PROCESS_SIMULATION master.
- **Item 2 (branch `inj/i2-e-em-alert-tier`):** the values helper types each limit tier into its own boxes ("More limits");
  GMP 8b's EM breach is then an action-tier breach (asserted on the blocked exception), not registration-relevant. It
  touches every library group's values, so its full run is the test.
- **Item 3, routine EM:** see the handover above (dropped; an owner question).

### Session 10b (11 November 2026): lean merged, I-2b merged, I-2c and B open

- **Merged:** #218 (lean review; no volume CALC, the lead's ruling), #227 (I-2b, the aseptic vial E2E; GMP 8b also tries the
  release on screen and finds it refused, decision 0029; a human-error deviation is concluded with the PR-50 system factors).
- **I-2c (this branch, `inj/i2-c-media-fill`):** the media fill's sandbox half, group `library-inj-aseptic`, green on
  209ce54. It is medium-only (lead: a new formulation never needs software). The fix was in the E2E helpers only; the
  product skeleton already omits the "other components" step for a one-line formula (from-formula.ts). Blocks go after
  `p-disp-act`, the floor weighs and lists only the groups the lots have (`hasExc`), and `potencyAdjusted: false` on a
  material. Still to do for the media fill's GMP run: `phase7/own-product-floor.ts:518` assumes `p-disp-exc` too.
  - Lead ruling: the sandbox half keeps the IN market authorisation for now. Once B lands, a PROCESS_SIMULATION master skips
    it, and the E2E must assert the skip.
- **B, `inj/i2-sim-mark` (recipe-core 1888; local CI green, 734 files / 5475 tests):** the mark is in the header, the
  validator, the designer and the content hash.
  - 1888 skips the licence and export permission at issue, records "no licence: process simulation" in
    batch_licence_basis (licence columns nullable plus a check), and refuses the label (IND-050), a packaging order
    (EXE-198), a finished lot (IND-045) and a shipment (IND-046).
  - Lead rulings: the US 11.100(c) gate uses the site's licence holder (latest current licence); the allocation register
    shows "Process simulation (no licence)"; the packaging refusal has a full-path test. No later migration redefines a
    function 1888 replaces (checked at 1893).
  - Next: open its PR, run the full CI, get the audit.
- **Then:** the media fill's GMP run to QA's record review (needs B); the EM alert tier on the aseptic vial (item 5: the
  E2E values helper types only the first tier into the registered boxes; type each tier into its own boxes with "More
  limits", and check how GMP 8b's breach is then classed); routine EM (item 6).
- **Local environment:** PostgreSQL stops when the container restarts. Run `sudo pg_ctlcluster 16 main start` and
  re-create the role ebmr_dev/ebmr_dev, then run vitest from the repo root (the template database comes from the root
  global setup). GitHub E2E needs `runner=github`; the pod queue was stuck on 11 November.

### Session 10 (10 November 2026): I-2, aseptic fill, EM and media fill

- **PRs:** #205 (GMP half's output = the run's unconsumed containers: `outputStage`, `outputUnits`, keys `output-N`;
  test only) and #206 (I-2a data) passed the lead's audit; each merges on a full green run (decision 0027 V5: every
  code PR, all E2E groups). I-2b (aseptic vial E2E, branch `inj/i2-b-aseptic-e2e`, group `library-inj-aseptic`) opens
  as a PR after both merge.
- **Lead rulings (10 November 2026):**
  - Interventions are an optional event section in INJ-FILL (R-flow item 3; no new repeat kind). It is recorded when the
    event is over: the entry's trusted time is its end, the operator types how long it lasted (ALCOA accurate). No typed
    date and time (the sandbox guard refuses an ISO date-time as a lot-number word; the lead gave that defect to
    another session).
  - INJ-EM records sampling and particles during the operation; INJ-EM-COUNTS (before the accountability) takes the
    counts after incubation, so incubation does not hold the batch.
  - The filter, single-use assembly and supplier-sterilised component lots are named where used, as the I-1 components:
    no formula line, released lot (G07 checks), VERIFIED second person.
  - Media fill: in the sandbox now (I-2c); its GMP run needs B below. Putting it on the licence register (option A) is out.
- **Designer gap (logged with the lead):** the values form takes one range per limit and stores it as REGISTERED, so
  an EM alert level or action tier cannot be set on screen; a count above the limit is a registration-relevant
  deviation (stricter; it still blocks the step and the release).
- **B, the process-simulation mark (approved; engine, general; its own PR after I-2b; migration recipe-core 1888
  cleared; worktree `../ebmr-sim`, branch `inj/i2-sim-mark`):**
  - `MbrHeader.nonProduct?: 'PROCESS_SIMULATION'` (parse.ts header keys, model.ts, validator rules-content.ts, designer
    header ops.ts and DocumentView.tsx). It is in the approved content and its hash, so it changes only by a new master
    version: a test must show that. ROUTINE_MONITORING only if routine EM really needs it (no unused values).
  - 1888: `recipe.india_issue_problem` (0891) skips the licence (site.licence_problem) and every market's export
    permission for such a batch (one rule, every market); the hazard-area check stays. `recipe.record_batch_licence_basis`
    must then record "no licence: process simulation" instead of a licence row (licence_number is not null today).
    Comment cites 211.113(b), SM Part II 5.3-5.7, A1 9.32 (EU).
  - Refused for record integrity (the units are destroyed): posting a finished lot, planning a packaging order (0582),
    shipping. QA's review of the record is its end. Tests [IN-30][ST-29][IN-45].
- **Handover (session 10 ends at about 380k context; the next session continues in this order):**
  1. #206: merge on its full green run (run 42885506188 on 6434e6d; main was merged in for conflicts in the PR-03 and
     PR-05 lists). Squash with the full SHA, then cancel the main push run.
  2. The lean PR from branch `inj/i2-lean` (19ac2c1; the list of changes and kept items was sent to the lead). Open it
     after #206 merges: merge main in, run the library tests and register:validate, PR, full run, audit.
  3. I-2b (`inj/i2-b-aseptic-e2e`): merge main in after the lean PR. Conflicts are expected in INJ-FILL's event section
     (I-2b: eventMinutes in place of eventStart/eventEnd; lean: eventUnits dropped) and in the event tests. Drop
     `eventUnits` from `INTERVENTION` in injectables-aseptic-acceptance.ts, and drop INJ-FILL's `balanceClass` from the
     products (harmless, but now unused).
     - Last iteration run 42893281643 (group library-inj-aseptic only). Before it, the sandbox half, GMP 1-8 and GMP 8b's
       red checklist passed. GMP 8b now opens the deviation under the processing batch (the checklist link names the
       wrong batch, a shared defect logged). Read that run first: the blob artifact's `report.jsonl`; for 4xx bodies,
       the output artifact's trace `*.network` plus `resources/`.
     - Then: list the new E2E titles in their controls (trace:e2e names them), open the PR (the body says the deviation
       is raised on an office page because the kiosk dialog cannot raise one, the lead's condition), full run, audit.
  4. I-2c: a spec for MEDIA_FILL's sandbox half (defineInjectablesAcceptance only), in group library-inj-aseptic.
     The data is in injectables-aseptic-acceptance.ts, never run yet.
  5. B (the process-simulation mark), as below; then the media fill's GMP run to QA's record review.
  6. Routine EM: try a formula with no product on screen; anything that needs code goes to the lead first.
  - Shared defects logged with the lead (for session 9): the sandbox guard refuses ISO date-times; the values form
    stores only REGISTERED tiers (add the EM alert tier to the aseptic vial once that is fixed); the kiosk's "raise a
    deviation" carries no badge attribution; the G2.DEVIATIONS checklist link names the wrong batch.
  - The lead is now session_01PybpFvEFaQZ3LEfnNdjBCE.
- **E2E helpers added (generic test code):** `runLibraryStep(..., beforePerform)`; `linkNewDeviation` (the supervisor
  raises and links a batch deviation from the blocked exception, badge-confirmed); `investigateAndClose`;
  `gmp.breach` (a step value above its limit in GMP 4; GMP 8b shows G2.DEVIATIONS red, closes it, then green).
  `ASEPTIC_VIAL` and `MEDIA_FILL` are exported from `injectables-aseptic-acceptance.ts` (session 11 builds its lyo vial on
  ASEPTIC_VIAL).

### Session 9 (10 November 2026): the post-use inspection without a second person (branch `inj/i1c2-postuse-verifier`)

- **Lead ruling (10 November 2026):** no binding clause asks for a second person on the packaging line's post-use
  inspection in any edition. 211.188(b)(6) asks for the after-use inspection in the record; 211.130(e), EU Ch.5 5.50 and
  Schedule M Part I 17.3.9 / 18.5.2-18.5.3 are pre-use; Part VIII 7.1's independent check is pre-use (oral solids);
  Annex 1 and Schedule M Part XIII say nothing here. **D-P6c-6 is superseded** for its second-person part.
- tablets 1908: `tab.packaging_completion_problem` (create or replace) still needs a passing latest post-use inspection
  (EBMR-LBL-061) but no longer its verification. `tab.verify_post_use_inspection` stays, optional, never the inspector.
- Removed refusal: "the post-use inspection is not verified by a second person (PR-34)". Tests [PR-34] in
  `line-completion.test.ts` (tablets and injectables).
- Also merged in session 9: #208, kernel 1406 (a typed ISO date-time is no identifier word in a sandbox; DI-05, INV-18).
- fix/values-form-tiers (PR open at handover): the designer's values form takes the validated range, the action limit and
  the alert limit beside the registered range (withTier keeps the other tiers; nesting problems come from
  checkBlockUse/checkLimitSpec); the floor names every tier, innermost first. Tests [PR-08].
- Residuals: per-point limits (a TEST_RESULT with perPoint) still take the registered range only; the stale comment in
  tools/e2e/specs/library/injectables-acceptance.ts:590 still says a second person verifies the post-use inspection
  (only a comment; the test still verifies, which stays allowed).

### Session 11 (10 November 2026): I-3 lyophilisation blocks, I-4 blocks, lean review

- **Lead:** session_01PybpFvEFaQZ3LEfnNdjBCE (from 10 November, 20:15); earlier rulings stand.
- **Merged:**
  - #204: INJ-LYO (INJ-17; 211.113(b), 211.188(b), 211.68(b)) and INJ-LYO-EU (Annex 1 8.122-8.126, 10.6(iii)), in
    `seed/injectables-lyo.ts`;
  - #207: the I-4 blocks in `seed/injectables-routes.ts` (INJ-HOMOGENISE, INJ-POWDER-FILL, INJ-PLUNGER, INJ-FFS and
    INJ-FFS-EU, INJ-BFS and INJ-BFS-EU, INJ-RADIATION and INJ-RADIATION-EU from EU GMP Annex 12), and the unit `Gy`/`kGy`
    (expr 0.2.0, exact pins raised). RTU tubs need no block (INJ-SUPPLIER-STERILE, INJ-ASEPTIC-TRANSFER); dual-chamber
    needs none (INJ-FILL twice, INJ-LYO, INJ-PLUNGER).
- **#217 (lean review, lead's over-compliance list):** no critical flag on the homogeniser's settings; the EU radiation
  records signed by the operator alone; the fill weight recorded once (IPC-INJ-FILL-WEIGHT); the RTU wording after #206;
  and a general engine capability: a library block with the role PACK_EXAMINATION completes a packaging record
  (recipe-core 1892 `recipe.packaging_completion_types`; injectables 3020 `E.PACK_EXAMINATION` by type, judged by the
  step's unresolved exceptions).
- **Kept, with reason (lead):** INJ-LYO-EU types its load number and sterilisation cycle; a step value cannot read a
  value inside a repeat or a TEXT value.
- **Official texts read this session:** EU GMP Annex 1 (2022) 8.71, 8.96-8.126, 10.6; Annex 12; Schedule M Part II
  6.11.1.8-6.11.1.14 and Part XIII (FFS/BFS) in `docs/regulatory/sources-extracted/`.
- **Next (I-3b):** the lyophilised vial E2E = session 10's aseptic vial (`ASEPTIC_VIAL`,
  `tools/e2e/specs/library/injectables-aseptic-acceptance.ts`) with INJ-LYO between filling and capping, in its own
  `injectables-lyo-acceptance.ts` and group `library-inj-lyo` (ci.yml, ci-runners.test.ts, playwright config), after
  I-2's E2E merges. The INJ-FILL "closures" label: a neutral v1 wording is approved (part-stoppered vials). The GMP half
  takes the run's unconsumed containers (#205), so the lyophilised loads become the bulk.
- **Learnt:**
  - Two random ports of the E2E stack can collide (the scale simulator's MT-SICS port and a server port; route-s,
    EADDRINUSE in global setup): logged by the lead as a test-infra defect; one re-run is allowed.
  - A local PostgreSQL cluster can stop between turns: `pg_ctlcluster 16 <name> start` for each down cluster is enough
    (no full setup).
  - A new SQL function needs a group in `tools/sql-mutation/src/targets.ts` and the group in `.github/workflows/mutation.yml`.

### Session 11 → Handover (11 November 2026, 20:00; session 11b continues)

- **Merged by session 11:** #204 (INJ-LYO, INJ-LYO-EU), #207 (I-4 blocks; Gy/kGy, expr 0.2.0), #217 (lean review; the
  role PACK_EXAMINATION, recipe-core 1892, injectables 3020).
- **Open branch `inj/i4-e2e` (no PR yet):**
  - three I-4 sandbox products as data in `tools/e2e/specs/library/injectables-routes-acceptance.ts`: an FFS bag, a BFS
    ampoule, and the I-1 vial terminally sterilised by radiation; spec files `inj-ffs-bag`, `inj-bfs-ampoule`,
    `inj-radiation-vial`; E2E group `library-inj-routes` (playwright config, ci.yml);
  - `defineInjectablesAcceptance(product: string | Injectable)` and the exports (`Injectable`, `InjectableGmp`, `unit`,
    `VIAL_COUNTS`): the same hunks as session 10's I-2b branch, so the two merge without conflict;
  - INJ-FFS and INJ-BFS, a v1 data edit (safe: nothing but their own tests and this E2E references them; library,
    block-version and demo-catalogue tests pass): the rounds record `sealRejects` (typed), the end `rejects` (typed, at
    filling) and `totalRejects` (CALC, the sum at sealing), which INJ-UNIT-ACCOUNT reads as the closing rejects;
  - the sandbox E2E titles listed in DI-04, DI-05, DI-17, IN-13, PR-01, PR-03, PR-05;
  - the handbook prose the lead asked for after #217 (recipe-core.md: packaging completion by role; injectables.md: the
    edition's migrations 3000 and 3020).
- **CI:** the narrowed runs 43040612521 (two attempts) and 43059672827 died in the Playwright install (Ubuntu mirror DNS)
  before any test; #222 fixed that. Main (with #222) is merged in at 058c752, and a narrowed run of
  `library-inj-routes` (runner=github) was dispatched at 19:55: its result is the first real test of the three products.
- **Left to do:**
  1. Finish the I-4 E2E: read that run; fix; then open the PR (state the v1-edit safety and that the seal counts are
     typed), full run, lead audit, merge.
  2. Powder fill (INJ-POWDER-FILL) E2E: after I-2b merges (its sterility rests on the aseptic Grade A/B set-up).
  3. The lyophilised vial E2E (I-3b): session 10's aseptic vial + INJ-LYO between filling and capping, own file and group
     `library-inj-lyo`, after I-2b merges; the INJ-FILL "closures" label in neutral wording (lead-approved).
- **Free numbers:** injectables 3040-3049; recipe-core 1896 (ask the lead first).

### Session 8 (10 November 2026): P4b, GMP 6 to 9 run

- **Lead change:** the lead is now session_01PybpFvcfiLdV8mgoVVWXTk (owner confirmed); earlier rulings stand.
- **Approved shared change (lead, session 8):** the injectables packaging skeleton runs G-21 in a parallel `par-pack`
  beside the packing branch: `p-pk-clear`, `p-pk-status`, parallel { Printed materials: [`p-pk-printed`] | Packing:
  [`p-pk-count`] }, `p-pk-yield`.
  - Why: G-21 is issue and reconciliation in one step, and the reconciliation reads counts that exist only after packing
    (211.125(c), (f)). In a plain sequence cartoning could not start (ENG-NOT-ENABLED).
  - The author adds PACK-CARTON after the count and moves it up (MOVE_STEP), then INJ-PACK-EXAM after the count.
  - Server test: the branches' shape and the validator clean with the author's blocks (from-formula.test.ts).
- **Test-only fixes:**
  - Sandbox printed lots are `TEST-L26-<tag>-<ITEM>`. The longer `...-PK-LEAFLET` was split at 32 characters, and a part
    read as a real lot number (EBMR-EXE-147).
  - PACK-CARTON names the carton and leaflet lots but does not consume their lines (`addLibraryBlocks(..., {
    consumeLines: false })`). G-21 alone consumes printed items. A second claim breaks DATA-PARALLEL (DI-34).
  - The post-use line inspection is recorded and verified on the labels page once G-21 is done (EBMR-LBL-061, PR-34).
  - `reviewRecord` ends its register loop on "The record has no exception."
  - The finished lot's reserve sample is 64 packs, twice the full test plan (G3.SAMPLES, PR-44, IN-32; 211.170(b)).
    `pullReserveSample` takes a quantity (default 4).
  - `releaseFinishedLot` opens a lot that stays not ready and names its red checklist items.
- **Result:** library-inj-gmp passes GMP 1-9 (run 42800512663 on 8c5a1d1).
- **Handover (session 8 ends; owner asked for a fresh session):**
  - #201 merged (squash, 2c57e09) after full CI run 42826140563 was green. The squash message's Co-Authored-By trailer
    came out HTML-escaped (`&lt;...&gt;`); main is not rewritten for it.
  - The PR's last fixes were bookkeeping only:
    - the clearance tests are listed in PR-34, IN-21 and the execution README;
    - the GMP 5-9 E2E titles are listed in their 18 controls (`trace:e2e`). Add only the entries the trace names: the
      repository's `register sync-tests` with one Playwright report adds about 690 unrelated E2E entries.
  - Next (session 9, session_01PybpFw8bnp3yCoWs2nZs4p): the post-use inspection's second-person verification on
    injectables (tablets 1230, EBMR-LBL-061). It is logged by the lead as a possible defect: no binding clause is cited
    (211.130(e) and EU 5.50 ask for no second person; ruling A5's logic). P4b complies with it unchanged.
  - Open residuals:
    - the skeleton binds no line or equipment;
    - PACK-SHIPPER is left out (no shipper BOM line);
    - a packaging master's printed items cannot be edited after create;
    - areas made before 1887 stay on area_status v1.
- **Learnt:**
  - A refusal's text is in the output artifact's trace: `*.network` lists the 4xx responses, and
    `resources/<sha1>.json` holds the body.
  - The kiosk's own reason for a disabled action is in the last `frame-snapshot` of the `*.trace` files.
  - A dispatch can hang in the Playwright install step: cancel it after about 40 minutes and dispatch again.

### Session 7 (10 November 2026): P4b, GMP 6 to 9 (handover at 387k context; session 8 continues on the branch)

- **State (branch `inj/i1c2-p4b-gmp-packaging`, head e555929, no PR):**
  - library-inj-gmp passes GMP 1-5.
  - GMP 6 passes the clearance and the line start, and failed last at the equipment-status step (p-pk-status).
  - GMP 7-9 are written and have never run in CI.
  - **Run 42761655971 on e555929 was still running at the handover: read it first** (the blob artifact's
    `report.jsonl`: `onTestEnd`, `errors`).
- **Written in session 7:**
  - GMP 7: the packaging order from H-PACK; every sterilised load (`load-N`) issued as bulk; `injPackagingRun` on PL-2
    with CTN-03.
  - GMP 8: the finished cartons posted; ASSAY, BACTERIAL_ENDOTOXINS, STERILITY and PARTICULATE_MATTER (DEMO-ONLY
    values); the reserve sample; the head of QC.
  - GMP 9: both records reviewed; the lot released for IN.
  - Counts: `packCounts` (20 vials kept back per load; 10 vials per carton; each printed item reconciles).
- **GMP 6 fixes (test-only):**
  - The clearance's artwork set is at most 64 characters (api-contract), so the artwork codes are joined without item
    names.
  - In GMP 5 the author names line PL-2 for S-PACK ("Rooms of Labelling and packing").
  - Also in GMP 5: the author binds CARTONER (EQC-CARTONER) to S-PACK and ticks "checks its status" on p-pk-status.
    G-09@2 needs at least one unit use (G09-INCOMPLETE). The kiosk books the cartoner (`statusStep`) and ends its use
    (`releasePlant`).
- **Next failure, best guesses:**
  - If p-pk-status still fails: the EQC-CARTONER option may be missing from the stage's equipment class list. That
    list holds only EFFECTIVE EQUIPMENT_CLASS documents; the GMP demo plant should have one. Fall back to the step's
    own plant panel.
  - Untried after that:
    - the labels page's "Attach the X specimen" buttons;
    - PACK-CARTON's cartoner field (TEST-CTN-03 or CTN-03);
    - the G-21 reconciliation limits (allowance 2 %, unexplained 0);
    - the witnessed counts;
    - INJ-PACK-EXAM;
    - Y-PACK, 98-100 %: the sandbox run gives 99 % and GMP 7 about 99.8 %.
  - GMP 7 assumes CTN-03 exists on the GMP site (the demo routes seed it on PL-2) and that the printed lots need no
    reservation.
  - GMP 8 posts `cartons` packs.
- **Approved shared changes (lead):**
  - From-formula G-10 perform-only, `significant: false` (session 6, ruling A5; [PR-34]).
  - `plant.lineClearancesForBatch` (recipe-core, used by `step-plant.ts`) mirrors 1886 in full: an unverified PASSED
    clearance is listed only for a stage whose G-10 names no checker, on an area of version 2.
    - Tests: [PR-34][IN-21] in status-blocks.test.ts and step-plant-clearance.test.ts.
    - The TypeScript `stageClearanceChecked` is pinned to `recipe.clearance_checked` on dc-mini (818d1ef). The lead
      decided against a grant migration.
  - No new shared-code changes before the handover (lead).
- **Residuals:**
  - The skeleton binds no line or equipment; the author binds them (lead ruling, session 8: GMP 5 names line PL-2
    and binds the cartoner on screen; no equipment is added to the skeleton).
  - PACK-SHIPPER is left out: the skeleton has no shipper BOM line (lead accepts; say so in the PR body).
  - Earlier residuals: editing a packaging master's printed items after create; areas on area_status v1.
- **Then:**
  - When GMP 5-9 pass, open the PR.
  - Dispatch the full CI (runner=github) and cancel the duplicate pull_request run.
  - Tell the lead "#N ready for audit".
- **Learnt:**
  - A form whose body fails the zod contract leaves its button disabled with no message: check the route's limits
    (`artworkSet` is at most 64).
  - Local DB tests: `pg_ctlcluster 16 main start` (stopped after a container restart).
    - Run from the repo root with `EBMR_PG_ADMIN_URL=postgres://ebmr_dev:ebmr_dev@localhost:5432/postgres`, using
      `node node_modules/vitest/vitest.mjs run <path>`.
    - Server tests get a database from `startServer` (harness).
    - A v1 area set up by an UPDATE cannot transition afterwards (EBMR-PLAT-077).

### Session 6 (10 November 2026): P3c merged; P4b in progress

- **#200, P3c (merged):** the packaging skeleton's G-21 consumes the three printed BOM lines and `p-pk-count` is
  WITNESSED.
  - The PACKAGING request takes per printed item `allowancePercent`, `maxUnexplained` / `maxUnexplainedPercent` and
    `specimen` (a SPECIMEN document code). They are written only as typed, with no defaults.
  - A missing value is asked for by ENG-DEF-CONFIG, G21-NO-LIMITS or GMP-SPECIMENS.
  - The SPECIMEN document in force is pinned (`documentsInForce`). An unknown code is refused with
    DESIGNER_PRINTED_ITEMS, for record integrity.
  - The new-master screen has the four fields per item.
- **P4b branch** (`inj/i1c2-p4b-gmp-packaging`, no PR):
  - main is merged in (P3c);
  - the G-10 comment says the firm may designate the clearance significant;
  - STERILITY and PARTICULATE_MATTER are in the product specification (DEMO-ONLY);
  - **GMP 5 is written:**
    - the steward records the SPECIMEN documents and a VALIDATION_REPORT on `/mbr` (the reference documents form);
    - QA approves the specimens on `/mbr/specimens` and the blocks PACK-CARTON and INJ-PACK-EXAM;
    - the author creates the master from the formula with the values, adds PACK-CARTON after `p-pk-printed` and
      INJ-PACK-EXAM after `p-pk-yield`, and adds the Y-PACK range (VALIDATED, source the report);
    - then change control and the sandbox package.
  - **E2E status (dispatch run 42739004205):** GMP 1-4 pass. GMP 5 passes up to its checks: the specimens, the
    approvals, the master, both library blocks and the Y-PACK range (scoped to `#mbr-item-Y-PACK`; the calculation of
    the same name has its own editor). The last finding was the warning GMP-STAGE-YIELD: INJ-PACK-EXAM ran after the
    yield. INJ-PACK-EXAM now goes after `p-pk-count`, before the yield, which closes the stage, both in the master and in
    `injPackagingRun`. Re-dispatched at the handover.
  - **GMP 6 is written** (`injPackagingRun` in injectables-acceptance.ts plus the test) and has not run yet. Its first
    risks: whether G-09@2 with no bound units completes, whether PACK-CARTON's cartoner (TEST-CTN-03) needs booking, and
    the labels page's specimen buttons for LABEL and LEAFLET.
  - **PACK-SHIPPER is left out:** the skeleton has no shipper BOM line.
- **Next:**
  - GMP 6: the sandbox packaging run on TEST-KIOSK-PACK-2 (cartoner TEST-CTN-03, class EQC-CARTONER; GMP CTN-03).
    Model it on `packagingRun` (phase7/own-product-floor.ts), with these differences:
    - the G-10 clearance is recorded with no verifier;
    - G-21 issues and reconciles LABEL, LEAFLET and CARTON;
    - PACK-CARTON and INJ-PACK-EXAM run through `runLibraryStep`;
    - the counts are witnessed.
  - Then GMP 7-9 as in the P4a handover below.
- **Learnt:**
  - A long evidence-step title makes a screenshot file name too long (ENAMETOOLONG): keep step titles short.
  - Container restarts kill local E2E runs: dispatch `ci.yml` with `e2e_groups=<group>` and `runner=github` instead.

### I-1c2 handover after P4a (9 November 2026; the next session starts at P4b)

Merged on 9 November:
- **#196, P3:** the designer's from-formula start `PACKAGING`, injectables only. Tablets and substance refuse it (DESIGNER_EDITION_START, an engine need).
  - It writes one stage S-PACK:
    - G-10@2 clearance;
    - G-09@2 status;
    - G-21 with LABEL, LEAFLET and CARTON, artwork per market;
    - the G-04 counts unitsReceived and unitsPacked, with a second person (211.103);
    - G-20 Y-PACK.
  - The batch sizes are the formula's, in `{unit}`. The bill of materials is the printed items only, and no formula is pinned.
  - The skeleton leaves to the author, so that the validator asks:
    - the G-21 reconciliation limits (G21-NO-LIMITS);
    - the Y-PACK limits.
  - The G-21 issue allowance is `0` and the need is the batch size, both draft values (the block needs them to parse).
  - The new-master screen has the option "From the formula, an injectables packaging master".
- **#197, P3b (lead ruling A5):**
  - G10-NO-CHECKER refuses a missing checker only in a tablets PACKAGING master (Schedule M Part VIII 7.1), or where the master is unknown (fails closed).
  - recipe-core 1886:
    - `recipe.clearance_checked`, step-keyed from the batch's master;
    - `start_area_occupancy` and `plant_status_entry_problem` accept an unverified passed clearance only for a stage without a checker;
    - the occupancy foreign key now names the clearance, with the row guard EBMR-PLANT-131;
    - the guard `plant.clearance_recorded_passed`.
  - recipe-core 1887 (generated): area_status v2 = v1 + CLEAR_UNCHECKED (step.execute). CLEAR keeps step.verify.
  - The upgrade drill's ADDED_ONLY_ALLOWED now holds machine_version, machine_transition and state_guard.
  - **Residual:** areas created before 1887 stay on v1 (the verified rule) until the owner decides. No aggregate is migrated.
- **#198, P4a:** the vial's GMP half, GMP 1-4, in E2E group `library-inj-gmp` (`inj-vial-gmp.spec.ts`, `defineInjectablesGmp`):
  - the materials, components and printed items, their specifications (DEMO-ONLY), the first lots, the ERP order, the issue and the reservation;
  - the GMP processing batch, with the sterilised load as a 'units' output container (stage STERILISATION, 9,720 accepted units, typed net verified), then H-PACK;
  - the vial, stopper and seal lots asserted on the entries (211.184(a), 211.188(b)(3));
  - the ERP simulator's tablets-only filter removed (`erp-orders.ts`), with a test [PR-04][IN-18];
  - the ampoule's GMP half: enabled by data when wanted (the `gmp` switch on `INJECTABLES`).

Lead rulings of 9 November 2026, evening (binding; session 6 starts at P3c):
- **(A) G-10 in the packaging skeleton:** perform-only with `significant: false` is confirmed.
  - Lead A5: a line clearance is not a significant step by its block alone.
  - The firm may still designate it significant (211.188(b)(11)) and add a checker on screen. Say so in the code comment.
- **P3c, one small PR before P4b (the create-time option):**
  - Fix 3: the skeleton's G-21 consumes the three printed BOM lines.
  - Fix 4: `p-pk-count`'s check is WITNESSED (the existing validator rule, GMP-WITNESS).
  - Fixes 1 and 2: the PACKAGING request takes the firm's own values per printed item at create time: maxUnexplained (or percent), the allowance, and the specimen reference.
    - The basis is 211.188(b)(8), specimens or copies of the labelling, and 211.125(c), the firm's reconciliation limits.
    - The new-master screen gets those fields.
    - No defaults, no invented values. Missing values are refused by the existing validator codes (G21-NO-LIMITS, GMP-SPECIMENS).
  - Tests by control ID: PR-32, PR-39, PR-31 and the GMP-* validator codes.
  - **Residual:** "edit a packaging master's printed items after create". Done (session 12b, 11 November): on a draft, ConfigForm adds (empty, nothing filled in), removes and edits each G-21 printed item, including its artwork version per market.
- **P4b, GMP 8:** add STERILITY (211.167(a): each batch purporting to be sterile is tested) and PARTICULATE MATTER (the compendial test for injections; 211.160(b)) to the product specification, marked DEMO-ONLY. Results stay QC results (D-S11-R1).
- **Order:** P3c, then P4b. Rebase nothing: merge main into `inj/i1c2-p4b-gmp-packaging` after P3c merges.

Then P4b (GMP 5-9, lead-approved; one PR, after P3c):
- The packaging master from the P3 skeleton on screen, plus PACK-CARTON, INJ-PACK-EXAM and PACK-SHIPPER. The author sets the G-21 limits, allowance and Y-PACK range (DEMO-ONLY).
- Its sandbox run via `runLibraryStep` on a packaging kiosk (not `packagingRun`), then evidence, four signatures and IN authorisation.
- The GMP packaging order from H-PACK, with the 9,720-unit container as its bulk.
- QC release results (TEST-INJ-RELEASE if the lot flow offers it), the reserve sample, the head of QC's approval.
- Both records reviewed; G-REL green for IN; release.
- With it: the skeleton's G-10 goes perform-only for injectables (211.130(e), A5), with a unit test [PR-34].
P4b state (branch `inj/i1c2-p4b-gmp-packaging`, pushed, no PR):
- Main is merged in (it needs #197).
- The skeleton's G-10 is perform-only and `significant: false`, with a test [PR-34] (the lead confirmed this: see the rulings below).
- library-inj-gmp passes 6 of 6 on it. GMP 5-9 are not written.
- It stopped at GMP 5. The P3 skeleton fails the validator in ways an author cannot fix on screen; sent to the lead:
  1. G21-NO-LIMITS: the designer shows G-21 `items[]` read-only (ConfigForm.tsx:116-128), so maxUnexplained and the allowance cannot be typed.
  2. GMP-SPECIMENS: each printed BOM line needs a SPECIMEN reference (rules-content.ts:569-582), and the designer cannot name one.
  3. GMP-BOM-CONSUMED: the skeleton's G-21 consumes no printed line (a P3 defect).
  4. GMP-WITNESS: p-pk-count's typed counts need WITNESSED, but the skeleton sets VERIFIED (a P3 defect).
  5. GMP-YIELDS: Y-PACK has no limits (expected; fixable on screen).
- GMP 8: TEST-INJ-RELEASE is not offered in the lot flow; release tests are QC results (D-S11-R1).
- The kiosk helpers for a non-tablets packaging run (G-10@2, G-09, G-21, G-04, G-20) are still to be written.

Learnt in P3 to P4a:
- A new state machine version is published by adding a descriptor in `plant/machine.ts` and running `npx tsx packages/recipe-core/src/plant/write-seeds.ts`.
  - A guard must be registered in an earlier migration than the machine that names it.
  - A seed past the handbook mark carries `handbook:` (the "-- Handbook:" line).
- The upgrade drill refuses growth of a records table not in ADDED_ONLY_ALLOWED (`tools/drills/src/upgrade.ts`).
- An occupancy referenced `plant.clearance_verification` by its foreign key, a schema-level rule to check before relaxing verification anywhere.
- `bool_or` over NULLs is NULL: coalesce each term before aggregating.
- Edition filters in shared code: grep for `edition = 'tablets'` before an injectables E2E needs a screen.

### I-1c2 handover (9 November 2026; superseded by the handover above)

Merged:
- **I-1c1** is complete: the vial (#155) and the ampoule (#193, E2E group `library-inj-amp`).
- **I-1c2 P2 (#194):**
  - **INJ-PACK-EXAM (INJ-27):** the finished-pack examination at the completion of finishing, 211.134(b) and (c).
    - The sample is the master's (`examUnits` count slot).
    - Any count of wrong or missing labels is recorded as found; nothing is refused at entry.
    - Above 0 is a critical breach (LIB_LIMIT_BREACH). It needs a deviation (PR-49).
    - E.PACK_EXAMINATION stays RED until that deviation is CLOSED.
    - Signatures are OPERATOR and VERIFIED.
  - **editions/injectables/sql 3000:** the schema `injectables`, the completion row (injectables, LIB-INJ-PACK-EXAM) and
    the G-REL hook `injectables.grel_edition_items`. The hook gives E.PACK_EXAMINATION plus the tablets items that apply
    to any packaging order. It has no posted-quantity item, because D-3b-6 is a default.
  - **Migration 3001** is free for the edition.
  - **Namespace order:** test-kit `EDITION_NAMESPACES` (substance, then injectables) is the one fixed order. It fails
    loudly. editions/README.md holds the ranges: injectables 3000-3999.
  - **The DB proof** is `apps/tablets-server/test/injectables/vial-chain.test.ts`:
    - the bulk link: the sterilised loads, as output containers in units, are the only bulk offered after H-PACK;
    - the first INJECTABLES lot is released, with G-REL green for India;
    - the wrong-label path and the fail-closed cases.

Lead rulings of 9 November 2026 (binding):
- **No P1 (INJ-LABEL dropped):** G-21 with LABEL, LEAFLET and CARTON items covers labelling:
  - the label lot and its artwork;
  - the first-print approval;
  - the on-line checks (211.134(a));
  - the reconciliation (211.125).
  Neither PACK-LABEL-RECON nor PACK-CODING goes in a vial master.
- **P3, option (a):** the designer's from-formula start writes an injectables PACKAGING master from a packaging skeleton.
  - Keep only what is binding:
    - G-10 line clearance (211.130(e); no second person for injectables);
    - G-09 equipment status;
    - G-21 printed items;
    - the counts.
  - A yield or a reconciliation goes in only where 211.103 or 211.125 applies.
  - The author adds the library steps: PACK-CARTON, then INJ-PACK-EXAM, which closes the record, then PACK-SHIPPER
    (optional).
  - Do not change PACKAGING_COPY and do not seed a master.
  - Code to read first:
    - `EDITION_START` in `apps/tablets-server/src/features/designer/from-formula.ts`, around line 319;
    - designer/index.ts, around line 572 (PACKAGING_COPY);
    - `recordKind`, set at from-formula.ts:88.
  - API's packaging BLANK was removed (handover-a0 113-116). The removal does not apply here: API packs inside its own
    record.
- **P4:** the GMP half of `tools/e2e/specs/library/injectables-acceptance.ts`:
  - printed LABEL, LEAFLET and CARTON materials with specifications, lots and artwork;
  - the GMP processing batch;
  - the packaging master from P3 on screen;
  - the sandbox and GMP packaging runs through the generic `runLibraryStep` on a packaging kiosk (not the RTW-hard-coded
    `packagingRun` in phase7/own-product-floor.ts);
  - QC with TEST-INJ-RELEASE, the review, then G-REL.
  The sterilised loads must be opened and closed as output containers on screen. Check that the kiosk offers it for a
  library master, and send the lead a fix first if it doesn't.
- **P4a** (GMP 1 to GMP 4, to H-PACK): `defineInjectablesGmp` in injectables-acceptance.ts, its own E2E group
  `library-inj-gmp` (`inj-vial-gmp.spec.ts`, which runs the sandbox half first). It runs for a product whose
  `INJECTABLES` entry has `gmp` data (the GMP plant's units, the units of each sterilised load).
  - the ampoule's GMP half: enabled by data when wanted

Learnt in P2:
- A library CONTAINER field is a reference only. The physical bulk is an output container (routes.containers.open with
  a stage and unit 'units'), closed and verified.
- A library entry is stored with kind = the section id, and its data values are strings (read with
  `tab.grel_entries(order, step, '<section>')`).
- A critical library breach cannot be dispositioned NO_IMPACT (EBMR-EXE-084). It takes DEVIATION_RAISED, with the
  deviation raised, linked and attached first.
- Once a parent batch's lot is released, the parent is LOCKED (EBMR-LCK-001): plan any further packaging order before.
- Namespace lists appear in tests: harness.test.ts, grel-interfaces.test.ts and medhanta/platform-wiring.test.ts.
- The local PostgreSQL clusters stop with an idle container: `pg_ctlcluster 16 main start` (and ci, ci2, ci3, golden).

### Next, in order

1. P3 (skeleton start of an injectables packaging master), a fresh session, plan to the lead first.
2. P4 (the GMP E2E to release).
3. Pod-down CI regime (lead): dispatch ci.yml with runner=github, cancel the duplicate pull_request run after each push
   and the main push run after each merge.

### Local environment notes

- A new container has no database role: run `bash tools/dev-env/runpod-setup.sh setup` once (about 5 minutes). It
  creates the clusters on 5432 to 5436.
- Run vitest from the repo root (`pnpm exec vitest run <files>`), never from inside a package (no jsdom).
- Run eslint with `node --max-old-space-size=8192`, or it runs out of memory and the shell still reports success.
- Exclude agent worktrees locally: `echo .claude/worktrees/ >> .git/info/exclude`.

## Where it stands

- **I-0** is merged (#107): the edition is data, in recipe-core 1871.
  - The edition list now has one source, from the API edition's A0 (#111):
    - SQL: `kernel.editions()` and `recipe.library_editions()`;
    - TypeScript: `EDITIONS` in `@ebmr/kernel` and `flow.EDITIONS`.
  - Take every edition name from these.
- **Control decisions** are merged (#120). The owner, via the lead, approved `control-decisions.md`:
  - 89 MODIFY, ST-68 FOLLOW, ST-69 DONT_FOLLOW;
  - recorded as each control's `expert_decision`;
  - the trace gate stays Tablets-only until I-6.
- **Checker fix** is merged (#115). The library checker refuses a calculation that reads a DATE_TIME (LIB-CALC-DATE-TIME) or a TIMER (LIB-CALC-TIMER), because the runtime evaluates neither.
- **I-1a, #114** (still open at the pause; the earlier session finishes it with #122):
  - `packages/recipe-core/src/library/seed/injectables.ts` holds 16 blocks of the `injectables` edition (INJ-COMPONENT-ACCEPT dropped in I-1c: component lots are named at washing, the stopper load and capping):
    - INJ-ROOM-READY, INJ-WASH, INJ-DEPYRO (tunnel), INJ-PARTS-AUTOCLAVE, INJ-COMPOUND;
    - INJ-BULK-FILTER, INJ-FILL, IPC-INJ-FILL-WEIGHT, INJ-AMPOULE-SEAL, INJ-CAPPING, INJ-TERMINAL-STERILISE;
    - INJ-VISUAL-INSPECT, INJ-CCI, INJ-UNIT-ACCOUNT, INJ-STERILITY-SAMPLE, and TEST-INJ-RELEASE (QC's).
  - They load with the existing catalogue load.
  - The installation publishes the `sterile` rule table (`INSTALLATION_RULE_TABLES`).
  - Tests: `seed-injectables.test.ts`, tagged by ST control ID.
- **#117** (merged), a shared fix the lead cleared: a library block's STEP_VALUE input is read at runtime.
  - The value comes from the one COMPLETED instance of the named step (`HandlerView.stepValue`, library `readValue`).
  - It is converted exactly to the input's unit.
  - It is recorded with its origin in `computed.<field>.stepValues`.
  - `defineBatch` refuses (ENG-DEF-STEP-VALUE) a step value naming:
    - no step;
    - a step that is not earlier;
    - a step inside a loop, a replicate or an alternative branch;
    - a field not recorded once;
    - a unit that does not convert.
  - Before this fix, PROC-DISP-POTENCY (tablets) and INJ-FILL (fill volume from the bulk density) failed on the floor.

## Design choices made in I-1 (lead-approved)

- **Time limits between steps** (compounding to filtration, filling to capping, fill duration, sterilisation to use) are the master's time constraints (HOLD, PROCESS_WINDOW, USE_BY) on trusted time. They are not typed times in a block. Plan 4.3 is updated.
- **Printout values** (washer, tunnel, autoclave, terminal sterilisation) carry a CHECKED signature by a second person, per 211.68(b). There is no device gateway.
- **Terminal sterilisation:**
  - every filled tray (registered by INJ-FILL) is consumed into its numbered load;
  - each load records its cycle once, takes its own sterility samples and registers the sterilised load.
- **Visual inspection:** rejects and accepted units are calculated, and the inspection time is a timer. The inspector's eyesight and inspection qualifications are checked at signature; set them up in I-1c.
- **The disinfectant** (INJ-01) is a typed agent and lot, not a formula line.
- **Not done yet:** INJ-UNIT-ACCOUNT still types its counts. Reading them from INJ-FILL and INJ-VISUAL-INSPECT through STEP_VALUE is now possible (#117) and would remove the retyping. Consider it in I-1c (a version-2 block, or before I-1a's first approval).

## Next: I-1c, the vial and ampoule batches to release (E2E), in a fresh session

The owner's rule: the full chain works end to end — formulation from library blocks, master approval, batch, execution, packaging and labels, review, release.

**Model:** the tablets acceptance in `tools/e2e/specs/library/acceptance.ts` (S11a sandbox, S11b GMP) with `library-support.ts` (`loadCatalogue`, `approveBlocks`, `registerPlantUnits`, `addLibraryBlocks`, `runLibraryStep`). Write `tools/e2e/specs/library/injectables-acceptance.ts` and one spec file per product (vial, ampoule).

**Plant data, entered on screen as the tablets acceptance does:**
- room classes per grade (`ROOM-GRADE-C` and so on, the classes the seed examples name);
- the vial washer, tunnel, autoclave, vessel, WFI point of use, filling line, ampoule sealer, capper, inspection booth and balance as equipment, each qualified in the logbook;
- qualification types GOWNING.<grade>, APS.<line> and EYESIGHT, with valid-to dates;
- requalification as a room due date.

**Expect tablets-only wording or checks on these screens.** Each one becomes a small shared fix, tested by rule ID, sent through the lead first:
- the formula screen: "Batch size (tablets)" and "Target tablet weight";
- `createFamily`: an injectables family starts BLANK, with a dispensing stage only;
- the packaging master is a copy of a cold-form master;
- the kiosk skeleton stages.

**Release tests:** TEST-INJ-RELEASE is QC's, recorded on the lot. Release waits for it through the existing gate (D-S11-R1).

**Header:** "Batchwright Injectables" when an injectables record is on screen. Use capsules C2's mechanism (#109: `RunHeaderView.dosageForm`, `brand.Edition`). The sign-in page and the page title say just "Batchwright": declutter D3 drops the edition prop from `SignInBrand()`.

**Declutter:** the lead's rule is no new tiles, menus or screens beyond what I-1 needs.
- The namespaces in `packages/api-contract/src/disconnected.ts` answer 410 and are not called.
- Alarms and equipmentData are among them, so device and EM values stay typed into blocks.

**Done when:** a vial batch and an ampoule batch are built on screen and run to release in the sandbox.

## Rules learnt (they cost CI rounds)

- A new SQL function goes into a group in `tools/sql-mutation/src/targets.ts`, or is left out with its reason (decision 0019).
- A test tagged with a control ID is listed in that control's `tests:`. Change only the tests list, then run `pnpm -s handbook`.
- A new required field in an API view needs the fixtures to follow (`packages/api-contract/fixtures/*.json`, and the web test fixtures).
- Merging main:
  - use a merge commit, never a rebase;
  - in control YAML conflicts, keep both sides;
  - take the handbook pages from main, then regenerate them.
- The "Verify the net of OC-… (second person)" E2E race is fixed by capsules #109 (merged). A remaining UI-click flake is
  re-run once; a second failure is real.
- Calculations:
  - The library checker accepts only what the runtime evaluates. A DATE_TIME or TIMER inside a CALC is refused (#115).
  - A calculation that reads another step's value needs STEP_VALUE (#117).
- Migration numbers:
  - shared directories take the next free number, cleared with the lead;
  - `inj.*` uses 3000-3999.
