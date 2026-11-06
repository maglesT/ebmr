# Injectables: resume notes (I-1 under way, 5 November 2026)

Read these instead of the session history. The rules in force are:
- `plan.md` (approved v2);
- `platform-fit.md`;
- section 9 of the plan (the owner's and the lead's answers);
- the hard rules of `CLAUDE.md`.

## Resumed 6 November 2026 (capsules complete)

Paused by the owner on 5 November while capsules and declutter ran; resumed on 6 November. The order now (lead):
the `inj/i1a-audit` PR with these notes; #131 with the lead's S1–S3 conditions; the `showWhen` checker fix;
`inj/unit-account-v2`; I-1c; the I-2 blocks. The API edition runs in parallel; shared-code changes go through the lead.
The table below is the state at the pause.

### Branches and PRs at the pause

| Branch | Based on | What | State |
|---|---|---|---|
| `inj/i1a-audit` | #114 head | The lead's audit of #114, items 1, 2, 4, 5 and 6: pressure difference not critical and its ST-17 tag dropped; room temperature and humidity removed; `accountedPct`, `takenAt` and `loadNumber` removed | Pushed; PR to open once #114 merges, **first thing**, ping the lead for the audit |
| `inj/i1c-shared` | main | S1–S3 (below) | **Draft PR #131**; apply the lead's conditions before merge |
| `inj/unit-account-v2` | #114 head | INJ-UNIT-ACCOUNT reads filled and line rejects (INJ-FILL `end.*`) and accepted and inspection rejects (INJ-VISUAL-INSPECT `counts.*`) via STEP_VALUE; only `sampled` and `losses` typed; v1 edited (lead: fine) | Pushed (8398a59), branch only; **merge `inj/i1a-audit` in first** (both touch the block; the audit drops `accountedPct`) |
| `inj/i2-blocks` | #114 head | I-2: 8 blocks in `seed/injectables-aseptic.ts` (INJ-SUPPLIER-STERILE ← INJ-03, SIP ← 07, ASEPTIC-ASSEMBLY ← 08, VHP ← 09, GLOVE-TEST ← 10, SUS ← 11, STERILE-FILTER ← 13, EM ← 32), tests tagged by ST/IN/PR | Pushed (f293202), branch only; the full recipe-core suite not yet run; not yet reviewed |
| `inj/i1c-e2e` | #114 + `inj/i1c-shared` | Base for the vial and ampoule E2E; no E2E code written yet | Pushed |

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

### Next, in order

1. `inj/i1a-audit` PR once #114 merges, after the lead's audit.
2. The `showWhen` checker fix (small LIB- PR).
3. #131: apply S1 and S3 as above, then CI, the lead's audit and merge.
4. `inj/unit-account-v2`: merge the audit branch in, then the PR.
5. `inj/i2-blocks`: apply the Annex 1 EU-market tagging, run the full suite, one review, then the PR.
6. I-1c1: the vial and ampoule E2E in the sandbox (I-1c section below). Facts found for it:
   - `library-support.ts` lacks STEP_VALUE in `fillValues`, and DATE_TIME and repeat sections in `runLibraryStep`.
   - `skeleton-floor.ts` needs a dispensing-only path: the library steps after `p-disp-recon`, then `H-PACK`.
   - The qualification and area-authorisation screens exist (administration `QualificationsPage`, plant-status
     `AreaAuthorisationsPage`), but no E2E drives them yet.
7. I-1c2: the GMP chain to release. Send the lead the size of a non-blister (vial) packaging master first.

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
  - `packages/recipe-core/src/library/seed/injectables.ts` holds 17 blocks of the `injectables` edition:
    - INJ-ROOM-READY, INJ-COMPONENT-ACCEPT, INJ-WASH, INJ-DEPYRO (tunnel), INJ-PARTS-AUTOCLAVE, INJ-COMPOUND;
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
