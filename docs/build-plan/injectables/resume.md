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

### Residuals (lead, 9 November 2026)

- **EU-market ampoule:** INJ-CCI-100, the 100 % integrity test of fusion-sealed ampoules of 100 mL or less (EU GMP Annex 1
  8.22), with the leakers counted as rejects in INJ-UNIT-ACCOUNT. Build it only when an EU-market ampoule product is in
  scope. The IN ampoule (#193) uses INJ-CCI as a sample.

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
  - **E2E status:** the first CI dispatch (`e2e_groups=library-inj-gmp`) was pending at this handover.
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
  - **Residual:** "edit a packaging master's printed items after create". There is no G-21 items editor in the designer now (ConfigForm shows `items[]` read-only).
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
