# Injectables: resume notes (I-1c2 under way, 9 November 2026)

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

### Residuals (lead, 9 November 2026)

- **EU-market ampoule:** INJ-CCI-100, the 100 % integrity test of fusion-sealed ampoules of 100 mL or less (EU GMP Annex 1
  8.22), with the leakers counted as rejects in INJ-UNIT-ACCOUNT. Build it only when an EU-market ampoule product is in
  scope. The IN ampoule (#193) uses INJ-CCI as a sample.

### I-1c2 (lead rulings, 9 November 2026)

- I-1c1 is complete: the vial (#155) and the ampoule (#193).
- Plan P1 -> P2 -> P3 -> P4, one PR at a time.
- **P1 + P2 (one PR):**
  - INJ-PACK-EXAM (INJ-27): the finished-pack examination at completion, 211.134(c). Its only refusal is a critical
    limit of 0 units with a wrong or missing label.
  - It closes a packaging record of the edition: editions/injectables/sql 3000 adds the completion row
    LIB-INJ-PACK-EXAM and the G-REL hook (E.PACK_EXAMINATION plus the tablets items that apply to any packaging order).
  - editionMigrationSources reads `EDITION_NAMESPACES` (substance, then injectables) and fails loudly.
  - The DB proof is `apps/tablets-server/test/injectables/vial-chain.test.ts`: the sterilised loads, as output
    containers in units, are the bulk the packaging order takes after H-PACK, and G-REL is green for India.
  - 3001 is unused (kept for the edition).
- **Labelling:** G-21 with LABEL, LEAFLET and CARTON items covers the label lot, the first print, the on-line checks and
  the reconciliation (211.125). No INJ-LABEL, and no PACK-LABEL-RECON in a vial master; the lead was told, and their
  answer is awaited.
- **P3 (ruling (a)):** the designer starts an injectables PACKAGING master from the skeleton. The skeleton holds only
  what is binding: line clearance (211.130(e)), equipment status, printed items (G-21) and the counts. A yield or a
  reconciliation goes in only where 211.103 or 211.125 applies. PACKAGING_COPY is not changed and no master is seeded.
- **P4:** the GMP half of `injectables-acceptance.ts`:
  - printed LABEL, LEAFLET and CARTON;
  - the packaging master from P3;
  - the packaging runs through `runLibraryStep` on a packaging kiosk (not the RTW `packagingRun`);
  - QC with TEST-INJ-RELEASE, the review and the release.
- **Output containers:** a library CONTAINER field is a reference only. The physical bulk is an output container that
  the operator opens and closes (routes.containers, stage and unit).

### Next, in order

1. Merge the P1+P2 PR, then P3, then P4.
2. Pod-down CI regime (lead): push only when needed, then dispatch
   `gh workflow run ci.yml --repo maglest/ebmr --ref <branch> -f runner=github` and merge on its green.

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
